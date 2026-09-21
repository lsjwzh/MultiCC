'use strict';
// 详情侧的条件轮询：304 只说明「服务端那份没变」，它的前提是客户端手里还留着上次
// 解析出来的正文。navigate() / popstate / dismissChat() 都会把 entry 清掉，而缓存里
// 的 ETag 还在 —— 那一刻如果照旧带 If-None-Match 去问，服务端回 304，客户端既没有
// 正文可画、又不肯再要一次，页头就停在「正在读取任务…」：状态行空着，composer 上的
// AI 配置 / 角色胶囊（挂在 entry.sessionId 上）一起消失，直到这条任务下次真的变了
// 才恢复。用户看到的就是「胶囊晚出现，得先发一条消息」。
//
// 这里用真浏览器把这条路走一遍：先正常打开一条任务，再点一次同一条（第二次访问必然
// 命中 ETag 缓存），要求页头和胶囊都能自己回来 —— 而不是停在占位文案上。
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
const ROUTE = 'Lab Responses';

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
    resource: { residency: 'planned', lease: 'idle' }, attribution: {}, messages: [], roleBindings: { version: 0, bindings: [] },
    configuration: { cli: 'codex', provider: 'codex-lab', providerName: ROUTE, model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' } });
  const snapshotEtags = [], detailEtags = [];
  routes['/api/air'] = conditional(snapshot, snapshotEtags);
  routes[DETAIL] = conditional(detail, detailEtags);
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
    const band = `(() => { const doc = document.getElementById('conversation')?.contentDocument; const pill = doc?.getElementById('air-ai-pill');
      return pill ? (!pill.hidden && pill.getBoundingClientRect().height > 0) : false; })()`;
    const bandText = `document.getElementById('conversation')?.contentDocument?.getElementById('air-ai-pill')?.textContent || ''`;

    await page.navigate('/air?dir=d1&task=tsk_a');
    assert.ok(await page.waitFor(`${title} === ${JSON.stringify(TITLE)}`), '首屏页头读出任务：' + await page.evaluate(title));
    assert.ok(await page.waitFor(band), '首屏 composer 胶囊出现');
    assert.ok(String(await page.evaluate(bandText)).includes(ROUTE), '胶囊写着线路名：' + await page.evaluate(bandText));
    assert.equal(detailEtags.length, 1, '首屏只该问一次详情');
    assert.equal(detailEtags[0], null, '第一次没有校验符可用，必须是真身');

    // 再点一次同一条任务：navigate() 会清空 entry，此时只剩 ETag 缓存。第二问因此
    // 是这条路的关键 —— 服务端会回 304，客户端得自己发现「我手上什么都没有」。
    const before = detailEtags.length;
    assert.equal(await page.evaluate(`(() => { const row = document.querySelector('#tasks > button[data-task="tsk_a"]'); if (!row) return 'missing'; row.click(); return row.dataset.task; })()`), 'tsk_a');

    assert.ok(await page.waitFor(`${title} === ${JSON.stringify(TITLE)}`, { timeoutMs: 6000 }),
      '重新打开必须自己把详情拿回来，不能停在占位文案（现在：' + await page.evaluate(title) + '）');
    assert.ok(!String(await page.evaluate(state)).includes('正在读取'), '状态行也回来了：' + await page.evaluate(state));
    assert.ok(await page.waitFor(band), '胶囊跟着 entry 一起回来');
    assert.ok(String(await page.evaluate(bandText)).includes(ROUTE), '胶囊仍是这条任务的线路：' + await page.evaluate(bandText));
    const asked = detailEtags.slice(before);
    assert.ok(asked.length >= 1, '重新打开要重新问详情');
    assert.ok(asked.some(value => value === null), '手里没有 entry 时不能再带 If-None-Match（会把 304 当成「我有」）：' + JSON.stringify(asked));
    assert.deepEqual(await page.evaluate('window.__errors || []'), []);
    await page.screenshot('01-air-conditional-detail');
  });
});
