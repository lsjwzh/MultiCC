'use strict';
// Air 是纯轮询页面（没有 WebSocket），每 4 秒把任务板快照拉一次。这里用真浏览器
// 验证条件请求端到端成立：服务端算 ETag、内容没变回 304，客户端在 304 上既不重画
// DOM，也不会漏掉真正变化的下一轮。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const etagFor = body => `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;

test('Air 轮询：没变回 304 且不重画，变了立刻更新', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  const polls = { total: 0, conditional: 0, notModified: 0 };
  let titles = ['任务 A'];
  const snapshot = JSON.stringify({
    ok: true, directories: [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }], clis: ['codex'],
    migration: { errors: [] }, sessions: [],
    tasks: titles.map((title, index) => ({ id: `tsk_${index}`, title, status: 'active', dirId: 'd1', updatedAt: 1000 + index })),
  });
  let body = snapshot;
  routes['/api/air'] = ({ req }) => {
    polls.total++;
    const etag = etagFor(body);
    const sent = req.headers['if-none-match'];
    if (sent) polls.conditional++;
    if (sent === etag) { polls.notModified++; return { status: 304, headers: { etag }, body: '' }; }
    return { headers: { 'content-type': 'application/json', etag }, body };
  };
  routes['/api/settings/access-token'] = () => ({ headers: { 'content-type': 'application/json' }, body: '{"hasToken":true,"canEdit":false}' });
  routes['/api/cron'] = () => ({ headers: { 'content-type': 'application/json' }, body: '[]' });
  routes['/api/docs-registry'] = () => ({ headers: { 'content-type': 'application/json' }, body: '[]' });
  routes['/api/agent-presets'] = () => ({ headers: { 'content-type': 'application/json' }, body: '{"presets":[]}' });
  routes['/api/providers'] = () => ({ headers: { 'content-type': 'application/json' }, body: '{"ok":true,"available":false,"defaults":{},"providers":[]}' });

  await withCdpHarness({ routes, screenshotDir: process.env.MULTICC_AIR_POLL_QA_DIR || path.join(os.tmpdir(), 'multicc-air-poll-qa') }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>(window.__errors||=[]).push(e.message));addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason)))` });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    const rowText = `document.querySelector('#directory-task-list > *')?.textContent || ''`;
    assert.ok(await page.waitFor(`${rowText}.includes('任务 A')`), '首屏列出任务：' + await page.evaluate(rowText));
    // 给这一行盖个戳：只有真的重画了列表，这个标记才会跟着旧节点一起消失。
    assert.equal(await page.evaluate(`(() => { const row = document.querySelector('#directory-task-list > *'); row.dataset.airProbe = 'kept'; return row.dataset.airProbe; })()`), 'kept');

    // 至少跨过两轮 4 秒轮询。
    await sleep(9000);
    assert.ok(polls.total >= 3, '轮询应该继续发生，实际 ' + polls.total);
    assert.ok(polls.conditional >= 1, '第二轮起要带 If-None-Match，实际 ' + polls.conditional);
    assert.ok(polls.notModified >= 1, '内容没变必须 304，实际 ' + polls.notModified);
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-list > *')?.dataset.airProbe || ''`), 'kept', '304 之后不能重建列表 DOM');

    // 真变化必须照旧可见：304 不能被当成「永远不用更新」。
    titles = ['任务 A2'];
    body = JSON.stringify({
      ok: true, directories: [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }], clis: ['codex'],
      migration: { errors: [] }, sessions: [],
      tasks: [{ id: 'tsk_0', title: '任务 A2', status: 'active', dirId: 'd1', updatedAt: 2000 }],
    });
    assert.ok(await page.waitFor(`${rowText}.includes('任务 A2')`, { timeoutMs: 12000 }),
      '数据变了必须更新到界面上：' + await page.evaluate(rowText));
    assert.deepEqual(await page.evaluate('window.__errors || []'), []);
    await page.screenshot('01-air-conditional-poll');
  });
});
