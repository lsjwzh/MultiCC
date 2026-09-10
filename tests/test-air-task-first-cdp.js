'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('Air task-only navigation, roles, configuration, artifact sidebar, legacy links and mobile', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public'), screenshots = [];
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const entry = { ok: true, task: { id: 'tsk_a', title: '完善任务协作体验' }, sessionId: 'task-a', ownerShellId: 'shell-a', readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: { residency: 'planned', lease: 'idle' }, attribution: {},
    configuration: { cli: 'codex', model: 'gpt-5.5' }, roleBindings: { version: 0, bindings: [] },
    messages: [{ role: 'user', content: '请整理本次任务的设计与实现结果。' }, { role: 'assistant', content: '本任务的交付已整理，可从右侧产物栏打开设计预览与测试结果。' }] };
  const directory = { id: 'd1', name: 'MultiCC', path: '/projects/multicc' };
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  routes['/air'] = routes['/air.html']; routes['/chat.html'] = routes['/task-entry.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = '';
  routes['/api/air'] = () => json({ ok: true, directories: [directory], clis: ['codex', 'claude'], migration: { errors: [] },
    tasks: [{ ...entry.task, dirId: 'd1', status: 'doing', resource: entry.resource }],
    sessions: [{ id: 'old-role', dirId: 'd1', kind: 'chat', label: 'FIXED_ROLE_MUST_NOT_SHOW' }, { id: 'term', dirId: 'd1', kind: 'terminal', label: '终端' }] });
  routes['/api/air/tasks/tsk_a'] = routes['/api/task-shell-tasks/tsk_a'] = () => json(entry);
  routes['/api/air/tasks/tsk_a/roles'] = ({ body }) => { const value = JSON.parse(body); entry.roleBindings = { version: entry.roleBindings.version + 1, bindings: value.bindings }; return json({ ok: true, roleBindings: entry.roleBindings }); };
  routes['/api/agent-presets'] = () => json({ presets: [{ id: 'designer', name: '设计师' }] });
  routes['/api/agent-presets/designer'] = () => json({ name: '设计师', prompt: '关注清晰、轻盈的交互' });
  routes['/api/air/resolve'] = () => json({ ok: true, url: '/air?task=tsk_a&dir=d1' });
  routes['/api/sessions/task-a'] = ({ body }) => { Object.assign(entry.configuration, JSON.parse(body)); return json({ ok: true }); };
  routes['/api/task-shell-tasks/tsk_a/artifacts'] = () => json({ taskId: 'tsk_a', title: entry.task.title, items: [
    { url: '/artifacts/design/index.html', title: 'MultiCC Air · 任务设计', kind: 'page', available: true },
    { url: '/artifacts/qa/results.json', title: '任务验收结果', kind: 'file', available: true },
  ] });
  const screenshotDir = process.env.MULTICC_TASK_FIRST_QA_DIR || path.join(os.tmpdir(), 'multicc-task-first-qa');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>(window.__errors||=[]).push(e.message));addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason)))` });
    await page.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/chat.html?session=old-role');
    assert.ok(await page.waitFor(`location.pathname==='/air' && document.getElementById('task-title')?.textContent==='完善任务协作体验'`));
    assert.equal(await page.evaluate(`document.body.innerText.includes('FIXED_ROLE_MUST_NOT_SHOW')`), false);
    assert.equal(await page.evaluate(`document.querySelectorAll('a[href*="chat.html"]').length`), 0);
    await page.evaluate(`document.getElementById('roles-toggle').click()`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open] select option[value=designer]')`));
    await page.evaluate(`const p=document.querySelector('dialog[open] select');p.value='designer';p.dispatchEvent(new Event('change'))`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open] textarea')?.value==='关注清晰、轻盈的交互'`));
    await page.evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`!document.querySelector('dialog[open]')`));
    assert.equal(entry.roleBindings.bindings[0].name, '设计师');
    assert.equal(page.requests.some(r => /role-workers|\/sessions$/.test(r.path) && r.method !== 'GET'), false);
    await page.evaluate(`document.getElementById('ai-capsule').click()`);
    await page.evaluate(`document.querySelector('dialog[open] input').value='gpt-5.5-updated';document.querySelector('dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`document.getElementById('ai-capsule').textContent.includes('updated')`));
    const frame = `document.getElementById('conversation').contentDocument`;
    assert.ok(await page.waitFor(`${frame}?.getElementById('task-artifacts-toggle')?.textContent==='产物 2'`));
    await page.evaluate(`${frame}.getElementById('message').value='未发送的草稿';${frame}.getElementById('task-artifacts-toggle').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('task-artifacts-panel').hidden===false`));
    screenshots.push(await page.screenshot('task-only-desktop'));
    await page.evaluate(`${frame}.getElementById('task-artifacts-close').click()`);
    assert.equal(await page.evaluate(`${frame}.getElementById('message').value`), '未发送的草稿');
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
      assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('ai-capsule')).display!=='none'`), true);
      assert.equal(await page.evaluate(`document.getElementById('roles-toggle').getBoundingClientRect().right<=innerWidth`), true);
      screenshots.push(await page.screenshot('task-only-mobile-' + width));
    }
    assert.deepEqual(await page.evaluate('window.__errors||[]'), []);
    assert.deepEqual(await page.evaluate(`document.getElementById('conversation').contentWindow.__errors||[]`), []);
  });
  fs.mkdirSync(screenshotDir, { recursive: true }); fs.writeFileSync(path.join(screenshotDir, 'screenshots.json'), JSON.stringify(screenshots, null, 2));
});
