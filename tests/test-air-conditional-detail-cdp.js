'use strict';
// 打开对话不该下载完整任务详情：历史可能有数十 MB。页头直接使用 Air 快照，只有
// 用户展开详情时才请求审计详情；再次打开也不允许回到旧的预取路径。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const etagFor = body => `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
const DETAIL = '/api/air/tasks/tsk_a';
const TITLE = '完善任务协作体验';

test('Air 条件详情：重新打开同一条任务不能停在「正在读取任务…」', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public');
  const routes = {};
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html)$/.test(name))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  routes['/air'] = routes['/air.html'];

  // 两个读接口都按服务端那样算 ETag（正文的 sha1），好让「没变」真的走 304 那条路。
  const conditional = (bodyRef, log) => ({ req }) => {
    const body = bodyRef();
    const etag = etagFor(body);
    const sent = req.headers['if-none-match'] || null;
    log.push(sent);
    if (sent === etag) return { status: 304, headers: { etag }, body: '' };
    return { headers: { 'content-type': 'application/json', etag }, body };
  };
  const snapshot = () => JSON.stringify({ ok: true, directories: [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }],
    clis: ['codex'], migration: { errors: [] }, sessions: [],
    tasks: [{ id: 'tsk_a', title: TITLE, status: 'active', dirId: 'd1', updatedAt: 1000 }] });
  const detail = () => JSON.stringify({ ok: true, task: { id: 'tsk_a', title: TITLE, recordType: 'planned', workflowStage: 'doing' },
    sessionId: 'task-a', ownerShellId: 'shell-a', readOnly: false, execution: { busy: false, status: 'idle' },
    resource: { residency: 'planned', lease: 'idle' }, attribution: {}, messages: [], roleBindings: { version: 0, bindings: [] }, configuration: {} });
  const snapshotEtags = [], detailEtags = [];
  routes['/api/air'] = conditional(snapshot, snapshotEtags);
  routes[DETAIL] = conditional(detail, detailEtags);
  routes['/api/air/tasks/tsk_a/open'] = () => json({ ok: true, taskId: 'tsk_a', sessionId: 'task-a', readOnly: false,
    session: { id: 'task-a', kind: 'chat', cli: 'codex' } });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/providers'] = () => json({ ok: true, available: false, defaults: {}, providers: [] });

  await withCdpHarness({ routes, screenshotDir: process.env.MULTICC_AIR_DETAIL_QA_DIR || path.join(os.tmpdir(), 'multicc-air-detail-qa') }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>(window.__errors||=[]).push(e.message));addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason)))` });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    const title = `document.getElementById('task-title').textContent`;
    const state = `document.getElementById('task-state').textContent`;
    await page.navigate('/air?dir=d1&task=tsk_a');
    assert.ok(await page.waitFor(`${title} === ${JSON.stringify(TITLE)}`), '首屏页头读出任务：' + await page.evaluate(title));
    assert.equal(detailEtags.length, 0, '首屏不能预取完整详情');

    await page.evaluate(`document.getElementById('task-state').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-detail-groups').textContent.includes('tsk_a')`));
    assert.equal(detailEtags.length, 1, '展开详情时才读取审计数据');

    // 再点一次同一条任务仍不得回退到预取详情。
    assert.equal(await page.evaluate(`(() => { const row = document.querySelector('#tasks > button[data-task="tsk_a"]'); if (!row) return 'missing'; row.click(); return row.dataset.task; })()`), 'tsk_a');

    assert.ok(await page.waitFor(`${title} === ${JSON.stringify(TITLE)}`, { timeoutMs: 6000 }),
      '重新打开仍用快照渲染页头（现在：' + await page.evaluate(title) + '）');
    assert.ok(!String(await page.evaluate(state)).includes('正在读取'), '状态行也回来了：' + await page.evaluate(state));
    assert.equal(detailEtags.length, 1, '重复打开也不得下载完整历史');
    assert.deepEqual(await page.evaluate('window.__errors || []'), []);
    await page.screenshot('01-air-conditional-detail');
  });
});
