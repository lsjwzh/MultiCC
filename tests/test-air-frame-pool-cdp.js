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
  { id: 'tsk_c', session: 'task-c', shell: 'shell-c', title: '任务 C' },
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

test('Air keeps the recently opened conversations warm instead of reloading them', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
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

  const byShell = new Map(TASKS.map(task => [task.shell, task]));
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
  routes['/api/air/tasks/tsk_a'] = routes['/api/air/tasks/tsk_b'] = routes['/api/air/tasks/tsk_c'] = routes['/api/air/tasks/tsk_d'] =
    ({ url }) => json(entryFor(byTask.get(url.pathname.split('/').pop())));
  routes['POST /api/task-board/tasks/tsk_a/chat-session'] = routes['POST /api/task-board/tasks/tsk_b/chat-session'] =
    routes['POST /api/task-board/tasks/tsk_c/chat-session'] = routes['POST /api/task-board/tasks/tsk_d/chat-session'] =
    ({ url }) => { const task = byTask.get(url.pathname.split('/')[4]); return json({ ok: true, sessionId: task.session }); };
  routes['POST /api/task-shells'] = ({ body }) => {
    const task = TASKS.find(candidate => candidate.session === JSON.parse(body).sessionId);
    return json({ id: task.shell });
  };
  for (const task of TASKS) {
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
    assert.equal(await page.evaluate(clickTask('任务 C')), true);
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
