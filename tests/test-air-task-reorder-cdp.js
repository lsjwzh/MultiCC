'use strict';

// 最近任务按最后消息时间排序，点击只记录访问，不改变列表顺序。
// 真浏览器检查点击反馈会收尾、无位移时不产生换位动画，并保持滚动位置。
//
// 采样从 Node 侧拉（而不是页内 MutationObserver / rAF）：后台 target 的观察者回调会
// 被 Chromium 攒着不投递，实测只有前两拍记得下来、收尾那一笔丢了。逐次 Runtime.evaluate
// 读的是当前 DOM，不受投递节流影响。
//
// 几何那半边（该走多远、亚像素不动、收尾还样式）在 test-air-task-motion.js 里用假
// 元素量过了；这一组只驱动真页面，读 DOM 与计算样式。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');
const DIRECTORY = { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' };
// 足够多的一列：任务带自己吃掉侧栏剩下的高度并在内部滚动。条数少了就滚不动，
// 「滚动位置不许被顶回去」那一条也就无从谈起。
// 最多 12 条：「打开过」的记录本身就封顶 12 条（air.js 的 rememberTask）。
const TASKS = Array.from({ length: 12 }, (_, index) => ({
  id: `t${index + 1}`, session: `task-${index + 1}`, shell: `shell-${index + 1}`, title: `任务 ${index + 1}`,
}));

function buildRoutes() {
  const routes = {};
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html)$/.test(name))) {
    routes['/' + file] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' },
    };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/vendor/dompurify/purify.min.js'] = { headers: { 'content-type': 'text/javascript' }, body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')) };
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const entryFor = task => ({ ok: true,
    task: { id: task.id, title: task.title, recordType: 'planned', workflowStage: 'doing', description: `${task.title} 的描述，写长一点让每一行都有两三行文字。`, acceptanceCriteria: '能看到这一项。' },
    sessionId: task.session, ownerShellId: task.shell, readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: { residency: 'planned', lease: 'idle' },
    attribution: {}, configuration: { cli: 'codex', provider: null, providerName: null, model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' },
    roleBindings: { version: 0, bindings: [] }, messages: [] });

  // 顺序要可预期：没有浏览记录时「最近」= 当前目录按 updatedAt 倒序，t1 排第一。
  routes['/api/air'] = () => json({ ok: true, directories: [DIRECTORY], clis: ['codex'], migration: { errors: [] }, sessions: [],
    tasks: TASKS.map((task, index) => ({ ...entryFor(task).task, dirId: 'd1', status: 'active', runState: 'idle',
      updatedAt: 1_700_000_000_000 - index, resource: { residency: 'planned', lease: 'idle' } })) });
  for (const task of TASKS) {
    routes[`/api/air/tasks/${task.id}`] = () => json(entryFor(task));
    routes[`POST /api/task-board/tasks/${task.id}/chat-session`] = () => json({ ok: true, sessionId: task.session });
    routes[`POST /api/task-shells/${task.shell}/tasks/resolve`] = () => json({ sessionId: task.session });
    routes[`/api/task-shells/${task.shell}/chat`] = () => json({ activeSessionId: task.session, taskId: task.id });
    routes[`/api/task-shells/${task.shell}/history`] = () => json({ ok: true, messages: [] });
    routes[`/api/task-shell-tasks/${task.id}/artifacts`] = () => json({ taskId: task.id, title: task.title, items: [] });
    routes[`/api/task-shell-tasks/${task.id}/history`] = () => json({ ok: true, messages: [] });
    routes[`/api/sessions/${task.session}/merge-status`] = () => json({ branch: `multicc/${task.session}`, baseBranch: 'main', behind: 0 });
    routes[`/api/sessions/${task.session}/liveness`] = () => json({ state: 'idle' });
  }
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/providers'] = () => json({ ok: true, available: false, defaults: {}, providers: [] });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
  return routes;
}

// 采样的两个来源都不是定时碰运气，而是「事情发生的那一刻」：
//   · 点击后*同步*读一次 DOM —— 抬起是同步加上的，这一拍有没有、顺序有没有动，
//     当场就见分晓；
//   · MultiCCTaskMotion.play 在它自己被调用的那一刻记一笔（call-through，不改行为）——
//     起点顺序、每行的类、以及它此刻被摆在哪，都不依赖这一刻有没有出帧、也不依赖
//     后台 target 的观察者回调（那玩意儿会被 Chromium 攒着，实测会丢收尾那一笔）。
//     并行跑一整套 CDP 时每次 evaluate 可能要上百毫秒，靠轮询去抓 170ms 的窗口是碰运气。
const SNAPSHOT = `(() => {
  const list = document.getElementById('tasks');
  const band = list.getBoundingClientRect();
  const rows = [...list.children].filter(el => el.dataset && el.dataset.task);
  return {
    scrollTop: Math.round(list.scrollTop),
    bandTop: Math.round(band.top),
    order: rows.map(el => el.dataset.task),
    rows: rows.map(el => { const box = el.getBoundingClientRect();
      return { id: el.dataset.task, cls: String(el.className), top: Math.round(box.top) }; }),
  };
})()`;

const INSTALL_SPY = `(() => {
  if (!window.__spied) {
    const motion = window.MultiCCTaskMotion;
    const list = document.getElementById('tasks');
    const rowsOf = () => [...list.children].filter(el => el.dataset && el.dataset.task);
    window.__plays = [];
    const original = motion.play;
    motion.play = (container, before, options = {}) => {
      const result = original(container, before, options);
      window.__plays.push({
        t: performance.now(),
        liftId: options.liftId || null,
        flight: options.flight !== false,
        beforeOrder: [...before.keys()],
        afterOrder: rowsOf().map(el => el.dataset.task),
        scrollTop: Math.round(list.scrollTop),
        rows: rowsOf().map(el => { const box = el.getBoundingClientRect(); return {
          id: el.dataset.task, cls: String(el.className), top: Math.round(box.top),
          inlineTransform: el.style.transform, inlineOpacity: el.style.opacity, inlineTransition: el.style.transition }; }),
      });
      return result;
    };
    window.__spied = true;
  }
  return true;
})()`;

const classes = row => String(row.cls).split(/\s+/);
const rowOf = (list, id) => (list.find(row => row.id === id) || null);
// 点一下，并且当场读「抬起那一拍」的样子 —— 点击处理和这两行读数在同一个同步块里：
// setTimeout 的回调挤不进这个块，所以紧接着读到的必定还是点下去那一刻的 DOM。
// 分成两次 evaluate 就会被负载牵着走：并行跑一整套 CDP 时，一次往返能有好几百毫秒，
// 等读回来时第二拍都已经演完了（实测就是这么挂的）。
const clickAndRead = id => `(() => {
  const list = document.getElementById('tasks');
  const id = ${JSON.stringify(id)};
  const button = list.querySelector('button[data-task=' + JSON.stringify(id) + ']');
  if (!button) return null;
  window.__clickAt = performance.now();
  button.click();
  const row = list.querySelector('button[data-task=' + JSON.stringify(id) + ']');
  return { clickAt: window.__clickAt, cls: String(row.className),
    top: Math.round(row.getBoundingClientRect().top),
    scrollTop: Math.round(list.scrollTop),
    first: list.querySelector(':scope > button[data-task]').dataset.task };
})()`;

test('点击侧栏任务保持消息时间顺序和滚动位置，并清理点击反馈', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = buildRoutes();
  const screenshotDir = process.env.MULTICC_AIR_REORDER_QA_DIR || path.join(os.tmpdir(), 'multicc-air-reorder-qa');

  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // 预置访问记录，验证点击更新访问记录不会改变按消息时间排列的侧栏。
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.getItem('air:recent-tasks')||localStorage.setItem('air:recent-tasks',${JSON.stringify(JSON.stringify(TASKS.map(task => task.id)))})` });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks > button[data-task]').length === ${TASKS.length}`), '侧栏列出近期任务');
    const start = await page.evaluate(SNAPSHOT);
    assert.ok(start.order.length === TASKS.length && start.order[0] === 't1', `起点顺序要可预期：${JSON.stringify(start.order)}`);
    assert.ok(start.rows[0].top >= start.bandTop, '起点没滚动，第一条在带子里');
    const scrolled = await page.evaluate(`(() => { const list = document.getElementById('tasks');
      return list.scrollHeight > list.clientHeight + 100; })()`);
    assert.ok(scrolled, '列表要真的能滚，否则「滚动位置不许被顶回去」无从量起');

    // ── 第一拍：在顶端点开第 4 条 ───────────────────────────────────────
    const target = start.order[3];
    const targetTop = (start.rows.find(row => row.id === target) || {}).top;
    await page.evaluate(INSTALL_SPY);
    const beat = await page.evaluate(clickAndRead(target));
    assert.ok(beat, '侧栏里找得到这一条');
    const clickAt = beat.clickAt;
    // 点下去的那一瞬间就量：抬起是同步加上去的，卡片还站在原来那一格，顺序也没动。
    // 真要是「瞬间跳到顶上」，这一拍里就看得出来。
    assert.ok(classes(beat).includes('is-lifting'), `点下去这一拍卡片要先抬起来（is-lifting），当前类：${beat.cls}`);
    assert.equal(beat.first, start.order[0], '抬起那一拍里顺序必须还没变 —— 一变就是又回到「瞬间跳到顶上」');
    assert.ok(Math.abs(beat.top - targetTop) <= 1, `抬起只是抬起来，卡片还得站在原来那一格：${beat.top} vs ${targetTop}`);

    assert.ok(await page.waitFor('window.__plays.length === 1'), '第二拍要真的发生');
    const plays = await page.evaluate('window.__plays');
    const play = plays[0];
    await page.screenshot('01-reorder-top');

    const liftMs = play.t - clickAt;
    assert.ok(liftMs >= 120 && liftMs <= 900, `两拍之间要真的隔一下，不是点下去就换位（实测 ${Math.round(liftMs)}ms）`);
    assert.equal(play.liftId, target, '反馈收尾时认出被点击的任务');
    assert.equal(play.flight, true, '列表顶端槽位可见');
    assert.equal(play.beforeOrder[0], start.order[0], '反馈收尾前的顺序不变');
    assert.deepEqual(play.afterOrder, start.order, '点击本身不改变按消息时间排列的顺序');
    assert.ok(play.rows.every(row => !classes(row).includes('is-flying') && !classes(row).includes('is-reordering')),
      '没有位移时不应出现换位动画');

    assert.ok(await page.waitFor(`!document.querySelector('#tasks .is-lifting, #tasks .is-reordering, #tasks .is-flying, #tasks .is-collapsing')`),
      '两拍跑完要把类的痕迹收干净');
    const settledTop = await page.evaluate(SNAPSHOT);
    assert.deepEqual(settledTop.order, start.order, '收尾后仍保持消息时间顺序');
    assert.equal(settledTop.rows.length, TASKS.length, '换位不该弄丢行');
    assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem('air:recent-tasks') || '[]')[0]`), target,
      '打开记录仍需落盘，以便其他入口使用');

    // ── 第二拍：滚到中下部再点一条 ─────────────────────────────────────────
    const mid = await page.evaluate(`(() => { const list = document.getElementById('tasks');
      list.scrollTop = Math.round(list.clientHeight * 0.8);
      const band = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll('#tasks > button[data-task]')];
      const inside = rows.map((row, index) => ({ row, index }))
        .filter(entry => { const box = entry.row.getBoundingClientRect(); return box.top >= band.top + 1 && box.bottom <= band.bottom - 1; });
      const target = inside[Math.min(2, inside.length - 1)];
      return { scrollTop: Math.round(list.scrollTop), bandTop: Math.round(band.top), id: target.row.dataset.task,
        index: target.index, top: Math.round(target.row.getBoundingClientRect().top), first: rows[0].dataset.task,
        firstTop: Math.round(rows[0].getBoundingClientRect().top), visible: inside.length }; })()`);
    assert.ok(mid.id && mid.index >= 4, `滚下去之后要有一条能点的、上面还剩好几条：${JSON.stringify(mid)}`);
    assert.ok(mid.scrollTop > 100 && mid.top >= mid.bandTop, `这一屏要真的滚下去了，而且点的那条看得见：${JSON.stringify(mid)}`);
    assert.ok(mid.firstTop < mid.bandTop, `顶端槽位此刻在带子上沿以外：${JSON.stringify(mid)}`);

    const midBeat = await page.evaluate(clickAndRead(mid.id));
    assert.ok(midBeat, '中下部这一条也要点得到');
    assert.ok(classes(midBeat).includes('is-lifting'), `中下部这条也要先抬起来：${midBeat.cls}`);
    assert.equal(midBeat.first, mid.first, '抬起那一拍里顺序还没动');
    assert.ok(Math.abs(midBeat.top - mid.top) <= 1, `它还得站在原来那一格：${midBeat.top} vs ${mid.top}`);
    assert.ok(await page.waitFor('window.__plays.length === 2'), '中下部点一条也要走同一条路');
    const midPlay = (await page.evaluate('window.__plays'))[1];
    await page.screenshot('02-reorder-scrolled');

    assert.equal(midPlay.liftId, mid.id);
    assert.equal(midPlay.flight, false, '顶端槽位在屏幕外');
    assert.deepEqual(midPlay.afterOrder, start.order, '中下部点击也不改变消息时间顺序');
    assert.ok(midPlay.rows.every(row => !classes(row).includes('is-collapsing')), '没有位移时不应淡出任务');
    assert.ok(Math.abs(midPlay.scrollTop - mid.scrollTop) <= 2,
      `换位当口的滚动位置也不许动：${midPlay.scrollTop} vs ${mid.scrollTop}`);

    assert.ok(await page.waitFor(`!document.querySelector('#tasks .is-lifting, #tasks .is-reordering, #tasks .is-flying, #tasks .is-collapsing')`),
      '第二组两拍也要收干净');
    const after = await page.evaluate(SNAPSHOT);
    assert.deepEqual(after.order, start.order, '点击完成后保持原有顺序');
    assert.ok(Math.abs(after.scrollTop - mid.scrollTop) <= 2,
      `滚动位置要停在原地，不能被顶回顶部：前 ${mid.scrollTop} → 后 ${after.scrollTop}`);
    assert.ok(Math.abs(rowOf(after.rows, mid.id).top - mid.top) <= 2, '点击的任务保持在原来位置');

    // ── 还有个反例：这一列不只给点击用 ─────────────────────────────────────
    // 轮询、开控制台、切目录这些入口都会重画这份列表。「保持在当前位置」是这次要的
    // 行为，所以重画同样不许把用户正在看的那一段顶回去；顺序也不该被这次重画改掉。
    // 特意换一个入口来量：开控制台走的是纯 render()，不经过侧栏的换位逻辑。
    const beforeRedraw = await page.evaluate(SNAPSHOT);
    assert.ok(beforeRedraw.scrollTop > 100, `要先停在中下部才量得到：${beforeRedraw.scrollTop}`);
    await page.evaluate(`document.getElementById('overview').click()`);
    const afterRedraw = await page.evaluate(SNAPSHOT);
    assert.equal(afterRedraw.order.join('|'), beforeRedraw.order.join('|'), '重画只换 DOM，不改顺序');
    assert.equal(afterRedraw.rows.length, beforeRedraw.rows.length, '重画不该丢掉行');
    assert.ok(Math.abs(afterRedraw.scrollTop - beforeRedraw.scrollTop) <= 2,
      `别的入口重画也不能把列表顶回顶部：前 ${beforeRedraw.scrollTop} → 后 ${afterRedraw.scrollTop}`);
  });
});
