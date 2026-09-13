'use strict';

// iOS web 移动端「标题和消息列表不对应」的回归测试。
//
// 根因链：air 的对话帧先载入 /chat.html?task=<id>&air=1，帧内 bootChatEntry 把任务
// 解析成当时的执行会话后 location.replace 成 /chat.html?session=<会话>&air=1 ——
// task 参数就此丢掉，帧地址钉死在「打开那一刻的绑定」上。任务后来改路由时活着的
// 帧靠 WS 跟着走、地址不变；而 iOS 后台会收掉 iframe 的 document，回来时按帧的
// 「当前地址」重载，复活的是旧会话的对话 —— 顶层页头按任务渲染、帧按旧会话渲染，
// 两边从此对不上。
//
// 修复（air.js reconcileFrameTask）：帧每次加载后按任务重新解析当前绑定，不一致才
// 把帧导航过去。这里在真浏览器里复刻那一下「iOS 重载」：服务端改绑任务 → 帧原地
// reload —— 修复后帧必须落回新绑定；修复前它会停在旧会话上（waitFor 超时失败）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');
const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const TASK = { id: 'tsk_a', title: '任务 A' };
const DIRECTORY = { id: 'd1', name: 'MultiCC', path: '/projects/multicc' };

const frameOnSession = session => `(() => {
  const frame = document.getElementById('conversation');
  if (!frame || !frame.contentWindow || !frame.contentDocument) return false;
  if (frame.contentDocument.readyState !== 'complete') return false;
  if (!String(frame.contentWindow.location.search).includes('session=${session}')) return false;
  // __multiccChatSetActive 是 chat.js 顶层装的开关；它在了，说明 chat 页真的跑起来了。
  if (typeof frame.contentWindow.__multiccChatSetActive !== 'function') return false;
  return true;
})()`;

test('a reloaded conversation frame re-resolves the task binding instead of resurrecting the old session', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');

  // 可变绑定：测试中途把它从 task-a 改到 task-a2，等价于任务在帧之外被重新路由。
  const binding = { session: 'task-a' };
  const shells = new Map([['task-a', 'shell-a'], ['task-a2', 'shell-a2']]);

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

  const entry = () => ({ ok: true,
    task: { id: TASK.id, title: TASK.title, recordType: 'planned', workflowStage: 'doing', description: `${TASK.title} 的描述`, acceptanceCriteria: '能看到这一项。' },
    sessionId: binding.session, ownerShellId: shells.get(binding.session), readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: { residency: 'planned', lease: 'idle' },
    attribution: {}, configuration: { cli: 'codex', provider: null, providerName: null, model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' },
    roleBindings: { version: 0, bindings: [] }, messages: [] });

  routes['/api/air'] = () => json({ ok: true, directories: [DIRECTORY], clis: ['codex', 'claude'], migration: { errors: [] },
    sessions: [],
    tasks: [{ ...entry().task, dirId: 'd1', status: 'doing', updatedAt: 1_700_000_000_000, resource: { residency: 'planned', lease: 'idle' } }] });
  routes[`/api/air/tasks/${TASK.id}`] = () => json(entry());
  routes[`POST /api/task-board/tasks/${TASK.id}/chat-session`] = () => json({ ok: true, sessionId: binding.session });
  routes['POST /api/task-shells'] = ({ body }) => json({ id: shells.get(JSON.parse(body).sessionId) || 'shell-x' });
  for (const [session, shell] of shells) {
    routes[`POST /api/task-shells/${shell}/tasks/resolve`] = () => json({ sessionId: session });
    routes[`/api/task-shells/${shell}/chat`] = () => json({ activeSessionId: session, taskId: TASK.id });
    routes[`/api/task-shells/${shell}/history`] = () => json({ ok: true, messages: [] });
  }
  routes[`/api/task-shell-tasks/${TASK.id}/artifacts`] = () => json({ taskId: TASK.id, title: TASK.title, items: [] });
  routes[`/api/task-shell-tasks/${TASK.id}/history`] = () => json({ ok: true, messages: [] });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/providers'] = () => json({ ok: true, available: false, defaults: {}, providers: [] });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-frame-reload-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`/air.html?dir=d1&task=${TASK.id}`);
    assert.ok(await page.waitFor(frameOnSession('task-a')), '打开任务时对话帧要解析到当时的绑定 task-a');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), TASK.title, '页头要报出当前任务');

    // 任务在帧之外被重新路由（等价于 task_shell_routed / 重新派发后的服务端状态）。
    binding.session = 'task-a2';

    // iOS 回收后的重载：WebKit 按帧「当前地址」（已被钉成 ?session=task-a）重新载入。
    await page.evaluate(`document.getElementById('conversation').contentWindow.location.reload()`);

    // 修复后：帧的 load 触发对账，按任务重新解析并导航到当前绑定 task-a2。
    assert.ok(await page.waitFor(frameOnSession('task-a2')), '重载后帧必须落回任务的当前绑定，而不是复活旧会话');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), TASK.title, '页头任务不变');
    assert.match(await page.evaluate(`document.getElementById('conversation').dataset.task || ''`), new RegExp(TASK.id), '帧元素要带着任务标记，重载对账靠它');

    await page.screenshot('01-air-frame-reload-rebind');
  });
});
