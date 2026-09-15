'use strict';

// Air 的对话帧池，在真浏览器里跑。切任务原来就是给 #conversation 换一个 src ——
// 一整个聊天页冷启一遍（一百多 KB 的 HTML、五十多个脚本、重连一次 socket、重拉
// 一遍历史），前后两个任务来回对照时这份代价每切一次付一次。管理台的会话弹窗一直
// 用池子解决这件事（public/manage.js 的 _sessionIframePool），Air 现在照办：切走的
// 帧只藏不卸，切回来直接显示。
//
// 这里量的是三件靠读代码看不出来的事：① 点回去拿到的确实是原来那个 document（没
// 有重新加载），② 池子有上限、且淘汰的是最久没用的那个，③ 被收进池子的帧会被
// 通知「你已经不在台上了」——不然它照旧每几秒打一次接口，收尾时还从看不见的地方
// 叮一声。DOM shim 量不了 ①②（帧的 document 身份和 load 事件是浏览器的行为）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');
const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 每个任务一套绑定：task-board 把一个任务解析成一个会话，会话再解析成一个 shell。
// 帧最后落在 /chat.html?session=<会话>&air=1 上（task 参数在这一跳里被换掉了）。
const TASKS = [
  { id: 'tsk_a', session: 'task-a', shell: 'shell-a', title: '任务 A' },
  { id: 'tsk_b', session: 'task-b', shell: 'shell-b', title: '任务 B' },
  { id: 'tsk_c', session: 'task-c', shell: 'shell-c', title: '运行 TikTok 库存同步脚本（xlwms→TikTok 每小时同步）' },
  { id: 'tsk_d', session: 'task-d', shell: 'shell-d', title: '任务 D' },
];
const DIRECTORY = { id: 'd1', name: 'MultiCC', path: '/projects/multicc' };

const frameState = `(() => {
  const frames = [...document.querySelectorAll('iframe')];
  const active = document.getElementById('conversation');
  const mark = frame => { try { return frame.contentWindow.__poolMark || null; } catch (_) { return null; } };
  return {
    count: frames.length,
    activeHidden: active ? !!active.hidden : null,
    activeSearch: active && active.contentWindow ? String(active.contentWindow.location.search) : null,
    activeMark: active ? mark(active) : null,
    activeLog: active && active.contentWindow ? (active.contentWindow.__activeLog || null) : null,
    parked: frames.filter(f => f !== active).map(f => ({
      hidden: !!f.hidden, id: f.id, src: f.getAttribute('src') || '', mark: mark(f),
    })),
  };
})()`;

const clickTask = title => `(() => {
  const button = [...document.querySelectorAll('#tasks button')]
    .find(candidate => candidate.querySelector('strong')?.textContent === ${JSON.stringify(title)});
  if (!button) return false;
  button.click();
  return true;
})()`;

// 帧的 document 真的换过没有，`location.search` 说了不算（任务解析那一跳会改地址）。
// 这里等的是「解析完了、chat.js 跑到了、而且是我们认识的那一份」。
const frameReady = (session, mark) => `(() => {
  const frame = document.getElementById('conversation');
  if (!frame || !frame.contentWindow || !frame.contentDocument) return false;
  if (frame.contentDocument.readyState !== 'complete') return false;
  if (!String(frame.contentWindow.location.search).includes('session=${session}')) return false;
  // __multiccChatSetActive 是 chat.js 顶层装的开关；它在了，说明这次改动真的被加载了。
  if (typeof frame.contentWindow.__multiccChatSetActive !== 'function') return false;
  ${mark ? `if (frame.contentWindow.__poolMark !== ${JSON.stringify(mark)}) return false;` : ''}
  return true;
})()`;

// 一个目录、四个任务的 fixture：静态文件按真身发，接口按帧池要用的那几支回。
function buildAirRoutes() {
  const routes = {};
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' },
    };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/vendor/dompurify/purify.min.js'] = { headers: { 'content-type': 'text/javascript' }, body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')) };
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  const byTask = new Map(TASKS.map(task => [task.id, task]));
  const entryFor = task => ({ ok: true,
    task: { id: task.id, title: task.title, recordType: 'planned', workflowStage: 'doing', description: `${task.title} 的描述`, acceptanceCriteria: '能看到这一项。' },
    sessionId: task.session, ownerShellId: task.shell, readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: { residency: 'planned', lease: 'idle' },
    attribution: {}, configuration: { cli: 'codex', provider: null, providerName: null, model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' },
    roleBindings: { version: 0, bindings: [] }, messages: [] });

  routes['/api/air'] = () => json({ ok: true, directories: [DIRECTORY], clis: ['codex', 'claude'], migration: { errors: [] },
    sessions: [],
    tasks: TASKS.map((task, index) => ({ ...entryFor(task).task, dirId: 'd1', status: 'doing', updatedAt: 1_700_000_000_000 + index, resource: { residency: 'planned', lease: 'idle' } })) });
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
  routes['POST /api/task-shells'] = ({ body }) => {
    const task = byTask.get(TASKS.find(candidate => candidate.session === JSON.parse(body).sessionId).id);
    return json({ id: task.shell });
  };
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/providers'] = () => json({ ok: true, available: false, defaults: {}, providers: [] });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
  return routes;
}

test('Air keeps the recently opened conversations warm instead of reloading them', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = buildAirRoutes();

  const screenshotDir = process.env.MULTICC_AIR_FRAME_POOL_QA_DIR || path.join(os.tmpdir(), 'multicc-air-frame-pool-qa');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air.html?dir=d1&task=tsk_a');
    assert.ok(await page.waitFor(frameReady('task-a')), '打开 A 时对话帧要立起来');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === '任务 A'`), '页头要报出当前任务');

    // 给 A 这一份 document 盖上记号，并把它收到开关调用的记录装好 —— 后面判断
    // 「点回来还是不是同一份 document」「后台帧有没有被通知」都靠这两样。
    assert.equal(await page.evaluate(`(() => {
      const frame = document.getElementById('conversation');
      const win = frame.contentWindow;
      win.__poolMark = 'A';
      win.__activeLog = [];
      win.__multiccChatSetActive = active => { win.__activeLog.push(active); return true; };
      return true;
    })()`), true);

    // ── 切到 B：A 应该被藏起来，不是被换掉 ────────────────────────────────
    assert.equal(await page.evaluate(clickTask('任务 B')), true, '侧栏里点得到任务 B');
    assert.ok(await page.waitFor(frameReady('task-b')), 'B 的对话帧要立起来');
    assert.ok(await page.waitFor(`(${frameState}).parked.length === 1 && (${frameState}).parked[0].mark === 'A'`),
      'A 那一帧应该还留在 DOM 里，而且带着我们盖的记号');
    const parkedBand = await page.evaluate(frameState);
    assert.equal(parkedBand.count, 2, `同一时刻最多两个帧（当前一个 + 池子里一个）：${JSON.stringify(parkedBand)}`);
    assert.equal(parkedBand.parked[0].hidden, true, '池子里的帧要藏起来');
    assert.equal(parkedBand.parked[0].id, '', '「当前这个」永远是 #conversation，旧的要把 id 摘掉');
    assert.match(parkedBand.parked[0].src, /task=tsk_a/, '池子里的帧保留原地址，才能在切回来时接着用');

    // ── 藏在后台的帧要被告知「你不在台上了」 ──────────────────────────────
    assert.ok(await page.waitFor(`(() => {
      const frame = [...document.querySelectorAll('iframe')].find(f => f.contentWindow?.__poolMark === 'A');
      return frame?.contentWindow.__activeLog.length === 1;
    })()`), '切走的帧要收到一次「不活跃」');
    assert.deepEqual(await page.evaluate(`(() => {
      const frame = [...document.querySelectorAll('iframe')].find(f => f.contentWindow?.__poolMark === 'A');
      return frame.contentWindow.__activeLog;
    })()`), [false], '后台帧收到的应该是 false，而且只收到一次');

    // ── 切回 A：拿到的必须是原来那一份 document ───────────────────────────
    assert.equal(await page.evaluate(clickTask('任务 A')), true);
    assert.ok(await page.waitFor(frameReady('task-a', 'A')), '切回 A 时那个热帧要直接上台，不能再冷启一份');
    const resumed = await page.evaluate(frameState);
    assert.equal(resumed.count, 2, `来回切一次不该多出帧来：${JSON.stringify(resumed)}`);
    assert.equal(resumed.activeHidden, false, '上台的帧要显示出来');
    assert.deepEqual(resumed.activeLog, [false, true], '切回来的帧要被告知「你又上台了」');

    // ── 上限：连开四个任务，最久没用的那个要被收走 ────────────────────────
    assert.equal(await page.evaluate(clickTask(TASKS[2].title)), true);
    assert.ok(await page.waitFor(frameReady('task-c')), 'C 的对话帧要立起来');
    assert.equal((await page.evaluate(frameState)).count, 3, '两个热帧 + 当前一个，正好到顶');

    assert.equal(await page.evaluate(clickTask('任务 D')), true);
    assert.ok(await page.waitFor(frameReady('task-d')), 'D 的对话帧要立起来');
    // 用完 A、B、C、D 之后：当前是 D，池子里应该是最新的两个，B（最久没用）被收走。
    assert.ok(await page.waitFor(`(${frameState}).count === 3`), '再多开一个也不该超过三个帧');
    const capped = await page.evaluate(frameState);
    assert.deepEqual(capped.parked.map(frame => frame.src).sort(),
      ['/chat.html?task=tsk_a&air=1', '/chat.html?task=tsk_c&air=1'].sort(),
      `留在池子里的该是最新的两个，最久没用的 B 被收走：${JSON.stringify(capped)}`);
    assert.match(capped.activeSearch, /session=task-d/);

    await page.screenshot('01-air-frame-pool');
  });
});

// 「新打开任务就错位」的回归。手机上的路是：先看过某个任务 → 点工作目录卡（或 ⌘K 选目录、
// 进目录库/定时任务）回到无任务 —— 当前帧被交回池子、`#conversation` 这个 id 从 DOM 里
// 消失；→ 再开一个这次会话里没开过的任务，池子里没有它，代码只能新建一个冷帧。这一跳
// 原来落到 document.body.append(frame) 上，而 body 是横向 flex：iframe 的固有宽度
// 300px 是它作为 flex 项的 min-width:auto，压不下去 —— 那一行于是被分成 main 93px +
// 帧 300px，页头（flex-wrap，面包屑也 wrap）就竖着摞成一条窄列、标题只剩一个字，对话
// 跑到右边整屏高。帧的父母永远是 #task-content，这一条就是给它上的锁。
test('Air mounts a brand new conversation frame inside #task-content, never on <body>', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = buildAirRoutes();
  const screenshotDir = process.env.MULTICC_AIR_FRAME_POOL_QA_DIR || path.join(os.tmpdir(), 'multicc-air-frame-pool-qa');
  const layout = `(() => {
    const frame = document.getElementById('conversation');
    const main = document.querySelector('main');
    const header = document.getElementById('task-header');
    const title = document.getElementById('task-title');
    return {
      frameParent: frame && frame.parentElement ? (frame.parentElement.id || frame.parentElement.tagName) : null,
      bodyFrames: [...document.querySelectorAll('iframe')].filter(f => f.parentElement === document.body).length,
      viewport: window.innerWidth,
      mainWidth: Math.round(main.getBoundingClientRect().width),
      headerWidth: Math.round(header.getBoundingClientRect().width),
      frameRect: (() => { const b = frame.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; })(),
      titleWidth: Math.round(title.getBoundingClientRect().width),
    };
  })()`;

  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    await page.navigate('/air.html?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks button').length === ${TASKS.length}`), '侧栏列出任务');

    // ① 先开 A：这一帧住在 #task-content 里
    assert.equal(await page.evaluate(clickTask('任务 A')), true);
    assert.ok(await page.waitFor(frameReady('task-a')), 'A 的对话帧要立起来');
    assert.equal((await page.evaluate(layout)).frameParent, 'task-content', '第一帧就该住在 #task-content 里');

    // ② 点侧栏那张工作目录卡回目录：当前帧被交回池子（id 摘掉、藏起来）
    await page.evaluate(`document.getElementById('library').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('conversation') && document.getElementById('task-title').textContent === 'MultiCC'`),
      '回目录后当前帧应该已经交回池子：id 摘掉，#conversation 暂时不在页面上');

    // ③ 再开一个没开过的任务 C：池子里没有它的热帧，只能新建
    assert.equal(await page.evaluate(clickTask(TASKS[2].title)), true);
    assert.ok(await page.waitFor(frameReady('task-c')), 'C 的对话帧要立起来');

    const after = await page.evaluate(layout);
    assert.equal(after.frameParent, 'task-content', `新帧必须住在 #task-content 里，不能挂到 body 上：${JSON.stringify(after)}`);
    assert.equal(after.bodyFrames, 0, `body 上不该有帧：${JSON.stringify(after)}`);
    assert.equal(after.mainWidth, after.viewport, `main 要占满整屏，不能被一个 300px 的帧挤窄：${JSON.stringify(after)}`);
    assert.equal(after.headerWidth, after.viewport, `页头要整宽，不能被挤成一条竖排窄列：${JSON.stringify(after)}`);
    // 长标题在手机上截成一行是设计如此（ellipsis）；错位时它只剩一个字宽（≈33px）。
    assert.ok(after.titleWidth >= 150, `标题要有整行的宽度，不该只剩一个字：${JSON.stringify(after)}`);
    assert.equal(after.frameRect.x, 0, `对话帧要从最左边开始铺满：${JSON.stringify(after)}`);

    // ④ 切回池子里的 A：帧还是各归各位（不会把刚修好的重新推出去）
    assert.equal(await page.evaluate(clickTask('任务 A')), true);
    assert.ok(await page.waitFor(frameReady('task-a')), '切回 A 要用池子里那份热帧');
    const resumed = await page.evaluate(layout);
    assert.equal(resumed.frameParent, 'task-content', `来回切一次，帧还是住在 #task-content 里：${JSON.stringify(resumed)}`);
    assert.equal(resumed.bodyFrames, 0, `来回切一次，body 上仍然不该有帧：${JSON.stringify(resumed)}`);
    assert.equal(resumed.mainWidth, resumed.viewport, `来回切一次，main 还是整宽：${JSON.stringify(resumed)}`);

    await page.screenshot('02-air-new-frame-homing');
  });
});
