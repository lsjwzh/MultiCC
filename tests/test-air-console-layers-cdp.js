'use strict';
// 控制台（任务 / 目录两种看法）与「控制台 → 目录 → 任务」三层浮层，在真浏览器里走一遍：
//   ① 任务看法 = 「等我处理」（限条）+ 一份不截条数的清单：筛选格带数，一页 50 条，
//      滚到底自动接下一页；原来的「正在运行 / 最近使用 / 更多」与手机小卡都不在了；
//   ② 目录看法只铺目录卡，在跑的目录带圈、在等人的目录卡上写「等我处理 N」；选择记在
//      本机，刷新还是那一种；
//   ③ 点目录卡在当前窗口打开目录页，它是盖在控制台上的一层（is-console-layer + 关闭）；
//      目录里再开任务是对话浮层，关掉回到目录；关掉目录回到控制台；
//   ④ 手机：底部导航三项「控制台 / 定时任务 / 项目」，「项目」就是目录看法，页内 tab
//      藏起来；旧的 ?view=recent 落到控制台。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('console switches between task and directory views; console, directory and task stack as three layers', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  const directories = [
    { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' },
    { id: 'd2', name: 'North · 商城', path: '/projects/storefront' },
    { id: 'd3', name: 'Gapasea', path: '/projects/gapasea' },
  ];
  const configuration = { cli: 'codex', provider: 'codex-lab', providerName: 'Lab Responses', providerSelection: null,
    model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' };
  const task = (id, dirId, title, runState, updatedAt, resource = { residency: 'planned', lease: 'idle' }) => ({ id, dirId, title,
    recordType: 'planned', workflowStage: 'doing', status: 'active', runState, updatedAt, resource, configuration });
  const airTasks = [
    task('tsk_here', 'd1', '收口 Air 的控制台', 'idle', 5000),
    task('tsk_wait', 'd2', '结算页金额四舍五入错误', 'waiting', 9000),
    task('tsk_run', 'd3', '登录页空状态文案', 'running', 7000, { residency: 'materialized', lease: 'running' }),
  ];
  // 再垫 70 条闲着的：清单总数 73，一页 50 条放不下 —— 原来控制台最多摆 8 条。
  const filler = Array.from({ length: 70 }, (_, i) => task(`tsk_fill_${i}`, 'd1', `批量任务 ${String(i).padStart(2, '0')}`, 'idle', 100 + i));
  const everyTask = [...airTasks, ...filler];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex', 'claude'], migration: { errors: [] },
    tasks: everyTask, sessions: [], taskTodos: [], taskTodoIgnored: [] });
  // /api/air/sync 与 /api/air/page 由 harness 的 air-sync-fixture 用真实的读索引
  // （src/workspace/air-read-index.js）从上面这份 /api/air 生成：分页口径就是服务端那份。
  for (const [index, item] of airTasks.entries()) {
    routes[`/api/air/tasks/${item.id}`] = routes[`/api/task-shell-tasks/${item.id}`] = () => json({ ok: true,
      task: item, sessionId: `task-${index}`, ownerShellId: `shell-${index}`, readOnly: false,
      execution: { busy: false, status: 'idle' }, resource: item.resource, attribution: {}, roleBindings: { version: 0, bindings: [] }, messages: [] });
    routes[`POST /api/task-board/tasks/${item.id}/chat-session`] = () => json({ ok: true, sessionId: `task-${index}` });
  }
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/ui-layout'] = () => json({ ok: true, layout: { dirOrder: [], sessionOrder: {} } });

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-console-layers-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air');
    await page.evaluate(`localStorage.removeItem('air:console-view')`);
    await page.navigate('/air');
    assert.ok(await page.waitFor(`!!document.getElementById('console-view-switch')`), '控制台顶上有看法切换');

    // ── ① 任务看法：等我处理 + 一份不截条数的清单 ─────────────────────────
    const view = () => page.evaluate(`(() => {
      const home = document.getElementById('console-home');
      const shown = sel => { const el = home.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none'; };
      return { view: home.dataset.view,
        selected: [...document.querySelectorAll('#console-view-switch [role=tab]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.consoleView),
        flow: shown('.console-flow'), dirs: shown('.console-directories') };
    })()`);
    assert.deepEqual(await view(), { view: 'tasks', selected: ['tasks'], flow: true, dirs: false }, '默认是任务看法，目录卡不在这里铺');
    for (const gone of ['.console-running', '.console-recent', '#console-more', '.mobile-console-recent']) {
      assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(gone)})`), null, `${gone} 已并进清单`);
    }
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-priority-grid .console-priority-card, .console-priority-grid .console-priority-card').length === 1`), '等我处理那一段还在');
    const chips = await page.evaluate(`[...document.querySelectorAll('#console-task-filters button')].map(b => b.textContent)`);
    assert.deepEqual(chips, ['最近任务', '等我处理1', '待办0', '今日完成0', '进行中1', '异常0', '全部记录73'], '筛选格带数');
    const listCount = () => page.evaluate(`document.querySelectorAll('#console-task-list .admin-recent-row, #console-task-list > button, #console-task-list > *:not(.admin-empty)').length`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list > *').length === 50`, { timeoutMs: 10000 }), '第一页 50 条（不是原来的 8 条）');
    assert.equal(await page.evaluate(`document.getElementById('console-task-note').textContent`), '73 条');
    assert.equal(await page.evaluate(`document.getElementById('console-task-more').hidden`), false, '还有下一页');
    await page.screenshot('00-console-tasks-view');
    // 滚到底自动接下一页（IntersectionObserver 盯着「加载更多」）。
    await page.evaluate(`document.getElementById('console-task-more').scrollIntoView()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list > *').length === 73`, { timeoutMs: 10000 }), '滚到底接上第二页，73 条全在');
    assert.equal(await page.evaluate(`document.getElementById('console-task-more').hidden`), true, '没有下一页了');
    assert.equal(await listCount(), 73);
    // 换筛选格：清单按新口径重来，攒下的后续页作废。
    await page.evaluate(`document.querySelector('#console-task-filters [data-filter="running"]').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list > *').length === 1`, { timeoutMs: 10000 }), '进行中只剩一条');
    assert.equal(await page.evaluate(`document.querySelector('#console-task-filters [aria-pressed="true"]').dataset.filter`), 'running');
    await page.evaluate(`document.querySelector('#console-task-filters [data-filter="recent"]').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list > *').length === 50`, { timeoutMs: 10000 }), '切回最近：又从第一页开始');

    // ── ② 目录看法 ───────────────────────────────────────────────────────
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#console-view-switch [role=tab]')].map(b => b.textContent)`), ['按任务', '按目录']);
    await page.evaluate(`document.getElementById('console-view-dirs').click()`);
    assert.deepEqual(await view(), { view: 'dirs', selected: ['dirs'], flow: false, dirs: true }, '目录看法只留目录网格');
    assert.equal(await page.evaluate(`document.getElementById('console-home-search').placeholder`), '搜索名称或路径', '搜索框改搜目录');
    assert.equal(await page.evaluate(`localStorage.getItem('air:console-view')`), 'dirs', '选择记在本机');
    // 在跑的目录带圈，在等人的目录卡上写出来。圈在整张卡上（data-dir-id 就是那张
    // article.directory-card），不在卡里的按钮上。
    assert.ok(await page.waitFor(`document.querySelector('.console-directory-grid [data-dir-id="d3"]')?.classList.contains('ring-running')`), '在跑的目录卡带圈');
    assert.equal(await page.evaluate(`document.querySelector('.console-directory-grid [data-dir-id="d3"] > button').classList.contains('ring-running')`), false);
    assert.equal(await page.evaluate(`document.querySelector('.console-directory-grid [data-dir-id="d1"]').classList.contains('ring-running')`), false);
    assert.equal(await page.evaluate(`document.querySelector('[data-dir-id="d2"] .directory-card-needs')?.textContent`), '等我处理 1', '在等人的目录卡写出等我处理数');
    assert.equal(await page.evaluate(`document.querySelector('[data-dir-id="d1"] .directory-card-needs')`), null);
    await page.screenshot('01-console-dirs-view');
    // 刷新还是目录看法（轮询重画整页也不会把它冲回去）。
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`document.getElementById('console-home')?.dataset.view === 'dirs'`), '刷新后仍是目录看法');

    // ── ② 点目录卡：当前窗口打开目录这一层 ─────────────────────────────
    await page.evaluate(`document.getElementById('console-center').scrollTop = 0`);
    const tabsBefore = await page.evaluate(`history.length`);
    await page.evaluate(`document.querySelector('.console-directory-grid [data-dir-id="d2"] > button').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden && !document.getElementById('task-layout').hidden`), '目录页在当前窗口打开');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('dir')`), 'd2');
    assert.equal(await page.evaluate(`history.length`), tabsBefore + 1, '是同一个窗口里的新一步，不是新标签页');
    const layer = () => page.evaluate(`({ layer: document.getElementById('task-layout').classList.contains('is-console-layer'),
      close: !document.getElementById('directory-layer-close').hidden })`);
    assert.deepEqual(await layer(), { layer: true, close: true }, '从控制台打开的目录页是一层浮层，带关闭');
    assert.equal(await page.evaluate(`document.getElementById('directory-layer-close').getAttribute('aria-label')`), '返回控制台');
    await page.evaluate(`new Promise(done => setTimeout(done, 300))`);
    await page.screenshot('02-directory-layer');

    // ── ③ 目录里开任务：对话浮层，关掉回到目录这一层 ─────────────────────
    assert.ok(await page.waitFor(`!!document.querySelector('#directory-task-list .directory-task-row .task-row-open')`), '目录页列出本目录的任务');
    await page.evaluate(`document.querySelector('#directory-task-list .directory-task-row .task-row-open').click()`);
    assert.ok(await page.waitFor(`new URLSearchParams(location.search).get('task') === 'tsk_wait' && document.getElementById('chat-layer').classList.contains('is-open')`), '任务在当前窗口以对话浮层打开');
    assert.equal(await page.evaluate(`document.getElementById('task-layout').classList.contains('is-console-layer')`), true, '开着任务时目录那一层还在下面');
    await page.evaluate(`new Promise(done => setTimeout(done, 400))`);
    await page.screenshot('03-task-over-directory');
    await page.evaluate(`document.getElementById('chat-close').click()`);
    assert.ok(await page.waitFor(`!new URLSearchParams(location.search).get('task') && !document.getElementById('chat-layer').classList.contains('is-open')`), '关掉任务');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('dir')`), 'd2', '关掉任务回到目录');
    assert.deepEqual(await layer(), { layer: true, close: true }, '回到的还是控制台上的那一层目录，关闭钮还在');

    // ── ④ 关掉目录：回到控制台，看法原样 ─────────────────────────────────
    await page.evaluate(`document.getElementById('directory-layer-close').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('console-center').hidden`), '关掉目录回到控制台');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview');
    assert.equal(await page.evaluate(`document.getElementById('console-home').dataset.view`), 'dirs', '回来还是目录看法');
    assert.deepEqual(await layer(), { layer: false, close: false }, '目录那一层收掉了');

    // 不是从控制台来的目录页（直接开 ?dir=）不算一层：没有关闭钮。
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`!document.getElementById('task-layout').hidden`));
    assert.deepEqual(await layer(), { layer: false, close: false }, '直接打开的目录页不是浮层');

    // 切回任务看法，下次打开就是它。
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`!!document.getElementById('console-view-tasks')`));
    await page.evaluate(`document.getElementById('console-view-tasks').click()`);
    assert.equal((await view()).view, 'tasks');
    assert.equal(await page.evaluate(`localStorage.getItem('air:console-view')`), 'tasks');

    // ── 手机：底部三项，「项目」= 目录看法，页内 tab 藏起来 ───────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    // 旧的「最近任务」页地址落到控制台。
    await page.navigate('/air?view=recent');
    assert.ok(await page.waitFor(`!document.getElementById('console-center').hidden`), '旧 view=recent 落到控制台');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview');
    const nav = () => page.evaluate(`[...document.querySelectorAll('[data-mobile-view]')].map(b => b.textContent + (b.classList.contains('active') ? '*' : ''))`);
    assert.deepEqual(await nav(), ['▦控制台*', '◷定时任务', '▤项目'], '底部三项，控制台亮着');
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('console-view-switch')).display`), 'none', '手机上页内 tab 藏起来');
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list > *').length === 50`, { timeoutMs: 10000 }), '手机控制台同一份不截条数的清单');
    await page.screenshot('04-mobile-console');
    await page.evaluate(`document.querySelector('[data-mobile-view="dirs"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-home')?.dataset.view === 'dirs'`), '「项目」= 控制台的目录看法');
    assert.deepEqual(await nav(), ['▦控制台', '◷定时任务', '▤项目*']);
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), '项目', '页头跟着叫项目');
    await page.screenshot('05-mobile-projects');
    await page.evaluate(`document.querySelector('.console-directory-grid [data-dir-id="d3"] > button').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('task-layout').hidden`));
    assert.deepEqual(await layer(), { layer: true, close: true }, '手机上同样是一层，带关闭');
    assert.deepEqual(await nav(), ['▦控制台', '◷定时任务', '▤项目*'], '目录页归「项目」高亮');
    await page.evaluate(`new Promise(done => setTimeout(done, 300))`);
    await page.screenshot('06-mobile-directory-layer');
    await page.evaluate(`document.getElementById('directory-layer-close').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('console-center').hidden && document.getElementById('console-home').dataset.view === 'dirs'`), '手机上关掉回到「项目」');
    await page.evaluate(`document.querySelector('[data-mobile-view="tasks"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-home')?.dataset.view === 'tasks'`), '「控制台」切回任务看法');
  });
});
