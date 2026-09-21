'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('Air directory memo, cross-directory completion and AutoCommit controls', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, root = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const folder of ['', 'shared', 'vendor/dompurify']) {
    for (const file of fs.readdirSync(path.join(root, folder)).filter(f => /\.(js|css|html)$/.test(f))) {
      routes['/' + (folder ? folder + '/' : '') + file] = { body: fs.readFileSync(path.join(root, folder, file)),
        headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
    }
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  const stock = { id: 'stock', dirId: 'd2', title: '库存同步', status: 'active', runState: 'running', updatedAt: 1000 };
  const tasks = [stock, ...Array.from({ length: 32 }, (_, i) => ({ id: 't' + i, dirId: 'd1', title: 'Task ' + i,
    status: 'active', runState: 'idle', updatedAt: 900 - i }))];
  routes['/api/air'] = () => json({ ok: true, directories: [
    { id: 'd1', name: 'MultiCC', path: '/projects/multicc' }, { id: 'd2', name: '库存', path: '/projects/stock' },
  ], tasks, clis: ['codex'], migration: { errors: [] }, sessions: [] });
  let autoCommit = true, mergeCount = 0;
  const history = { messages: [{ id: 'u1', role: 'user', content: '修复问题', clientMsgId: 'client1' }], hasMore: false };
  const entry = () => ({ ok: true, task: tasks[1], sessionId: 'task-a', ownerShellId: 'shell-a', readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: { residency: 'planned', lease: 'idle' }, attribution: {},
    configuration: { cli: 'codex', model: 'gpt-5.5', autoCommit }, roleBindings: { version: 0, bindings: [] }, messages: history.messages });
  routes['/api/air/tasks/t0'] = routes['/api/task-shell-tasks/t0'] = () => json(entry());
  routes['POST /api/task-board/tasks/t0/chat-session'] = () => json({ sessionId: 'task-a' });
  routes['POST /api/task-shells'] = () => json({ id: 'shell-a' });
  routes['POST /api/task-shells/shell-a/tasks/resolve'] = () => json({ sessionId: 'task-a' });
  routes['/api/task-shells/shell-a/chat'] = () => json({ activeSessionId: 'task-a', taskId: 't0' });
  routes['/api/task-shell-tasks/t0/history'] = routes['/api/task-shells/shell-a/history'] = () => json(history);
  routes['/api/task-shell-tasks/t0/artifacts'] = () => json({ items: [] });
  routes['/api/sessions/task-a'] = () => json({ id: 'task-a', cli: 'codex', autoCommit });
  routes['PATCH /api/sessions/task-a'] = ({ body }) => { autoCommit = JSON.parse(body).autoCommit; return json({ autoCommit }); };
  routes['/api/sessions/task-a/merge-status'] = () => json({ branch: 'multicc/task-a', baseBranch: 'main', mergeReady: true });
  routes['POST /api/sessions/task-a/merge'] = () => { mergeCount++; return json({ merged: true, commits: 1 }); };
  routes['/api/sessions/task-a/liveness'] = () => json({ state: 'idle' });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/providers'] = () => json({ available: false, providers: [], defaults: {} });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/aux/config'] = () => json({ providerId: 'configured' });
  routes['/api/cron'] = routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-workspace-fixes-qa') }, async page => {
    await page.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks > button').length === 30`));
    assert.equal(await page.evaluate(`document.querySelector('#tasks [data-task="stock"]') !== null`), false);
    assert.equal(await page.evaluate(`document.getElementById('directory-memo').hidden`), false);
    assert.equal(await page.evaluate(`document.getElementById('directory-memo').getBoundingClientRect().width > 0`), true, 'memo stays visible on mobile');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#directory-grid .directory-memo')].map(a=>a.getAttribute('href'))`),
      ['/memo.html?dirId=d1', '/memo.html?dirId=d2']);
    assert.equal(await page.evaluate(`(()=>{window.open=url=>window.memoOpened=url;document.getElementById('directory-memo').click();return window.memoOpened})()`), '/memo.html?dirId=d1');
    stock.runState = 'succeeded'; stock.updatedAt = 1100;
    await page.evaluate(`document.getElementById('refresh').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#tasks > button')?.dataset.task === 'stock'`));
    assert.equal(await page.evaluate(`document.querySelector('#tasks > button').classList.contains('unseen')`), true);
    assert.equal(await page.evaluate(`document.querySelector('#tasks > button').textContent.includes('执行成功')`), true);
    assert.equal(await page.evaluate(`document.querySelectorAll('#tasks > button').length`), 30);
    await page.screenshot('directory-memo-and-unread-completion.png');

    await page.navigate('/air?dir=d1&task=t0');
    const frame = `document.getElementById('conversation').contentWindow`;
    const cb = `${frame}.document.querySelector('.msg-auto-commit input')`;
    const button = `${frame}.document.getElementById('auto-commit-btn')`;
    assert.ok(await page.waitFor(`${button}?.dataset.state === 'on'`));
    await page.evaluate(`${frame}.eval('refreshShellHistory()')`);
    assert.ok(await page.waitFor(`${cb} && ${button}?.dataset.state === 'on'`), JSON.stringify({ requests: page.requests.map(r => r.path).filter(p => p.startsWith('/api/')),
      frame: await page.evaluate(`({url:${frame}.location.href,text:${frame}.document.body.innerText.slice(-1500),state:${button}?.dataset.state})`) }));
    assert.equal(await page.evaluate(`${cb}.checked`), true);
    await page.evaluate(`${button}.click()`);
    assert.ok(await page.waitFor(`${button}.dataset.state === 'off'`));
    assert.equal(await page.evaluate(`${cb}.checked`), false, 'session toggle updates the current turn');
    await page.evaluate(`${frame}.eval('autoCommitIfNeeded(_lastUserBubble)')`);
    assert.equal(mergeCount, 0, 'disabled session must not merge');
    await page.evaluate(`${button}.click()`);
    assert.ok(await page.waitFor(`${button}.dataset.state === 'on'`));
    await page.evaluate(`${cb}.click()`);
    await page.evaluate(`${frame}.eval('refreshShellHistory()')`);
    assert.equal(await page.evaluate(`${cb}.checked`), false, 'history rebuild preserves a manual opt-out');
    await page.evaluate(`${frame}.eval('loadSessionModel()')`);
    assert.equal(await page.evaluate(`${cb}.checked`), false, 'profile refresh preserves a manual opt-out');
    await page.navigate('/air?dir=d1&task=t0');
    assert.ok(await page.waitFor(`${button}?.dataset.state === 'on'`));
    await page.evaluate(`${frame}.eval('refreshShellHistory()')`);
    assert.ok(await page.waitFor(`${cb} && ${button}?.dataset.state === 'on'`));
    assert.equal(await page.evaluate(`${cb}.checked`), false, 'page reload preserves the same turn choice');
    await page.evaluate(`${frame}.eval('autoCommitIfNeeded(_lastUserBubble)')`);
    assert.equal(mergeCount, 0, 'manual opt-out wins over the enabled default');
    await page.evaluate(`${cb}.click()`);
    await page.evaluate(`${frame}.eval('applyMergeStatus({mergeReady:true}); autoCommitIfNeeded(_lastUserBubble)')`);
    assert.equal(mergeCount, 1, 'enabled current turn merges once');
    await page.evaluate(`${frame}.eval('refreshShellHistory()')`);
    await page.evaluate(`${frame}.eval('applyMergeStatus({mergeReady:true}); autoCommitIfNeeded(_lastUserBubble)')`);
    assert.equal(mergeCount, 1, 'completed marker survives a rebuild, preventing duplicate merges');
  });
});
