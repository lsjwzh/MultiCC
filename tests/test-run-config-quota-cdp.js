'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
const { providerLimitBar } = require('../src/quota/quota-bar-view');

// 运行配置里挑线路时要看得见余量：固定一条的线路下拉、子任务线路下拉、
// 自动挑选的「添加线路」列表和池子行，都把 /api/providers 带回的 provider.limit
// 挂出来；没有余量缓存的线路一字不差保持原样。
const publicDir = path.resolve(__dirname, '../public');
const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

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
routes['/auth-client.js'] = {
  headers: { 'content-type': 'text/javascript' },
  body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'`,
};
// 与 air.html 同一依赖顺序；quota-bar-view.js 是把服务端 bar 解析成文案的那一份。
routes['/run-config-host.html'] = {
  headers: { 'content-type': 'text/html' },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/run-config.css"><body>
${['auth-client.js', 'i18n-catalog.js', 'i18n.js', 'shared/dom-helpers.js', 'shared/format.js', 'api-client.js',
  'provider-catalog.js', 'auto-provider-editor.js', 'shared/models.js', 'chat-ai-config.js', 'run-config-controls.js', 'run-config.js', 'quota-bar-view.js']
  .map(src => `<script src="/${src}"></script>`).join('')}</body>`,
};
routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });

const now = Date.now();
const windowLimit = { kind: 'window', fetchedAt: now - 60_000, updatedAt: now - 60_000, stale: false,
  bar: providerLimitBar({ kind: 'window', fetchedAt: now - 60_000,
    summary: { windows: [{ window: '5h', usedPercent: 30, resetMs: now + 2 * 3600_000 }] } }) };
const balanceLimit = { kind: 'balance', fetchedAt: now - 120_000, updatedAt: now - 120_000, stale: false,
  bar: providerLimitBar({ kind: 'balance', fetchedAt: now - 120_000, summary: { total: 42.5, currency: 'CNY', available: true } }) };
const provider = (id, name, limit) => ({ id, name, appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude-exp'],
  model: 'glm-5', modelOptions: ['glm-5'], limit });
routes['/api/providers'] = () => json({ providers: [
  provider('glm', 'GLM 套餐', windowLimit),
  provider('ds', 'DeepSeek', balanceLimit),
  provider('plain', '无余量线路', null),
], defaults: {} });

const qaDir = () => process.env.MULTICC_RUN_CONFIG_QUOTA_QA_DIR || path.join(os.tmpdir(), 'multicc-run-config-quota-qa');
const inDialog = selector => `.air-config-dialog[open] ${selector}`;
const optionText = (select, value) => `document.querySelector(${JSON.stringify(inDialog(`${select} option[value="${value}"]`))})?.textContent || ''`;

test('picking a line shows its cached quota; lines without quota read as before', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig && window.QuotaBarView'));
    await page.evaluate(`window.MultiCCRunConfig.open({ configuration: { cli: 'claude-exp', provider: 'glm', model: 'glm-5' } }, ['claude-exp'], () => {})`);
    assert.ok(await page.waitFor(`!!document.querySelector(${JSON.stringify(inDialog('.rc-line option[value="glm"]'))})`));

    // 固定一条：线路下拉。
    const glm = await page.evaluate(optionText('.rc-line', 'glm'));
    assert.match(glm, /^GLM 套餐 · glm-5 · 5h 70%/, glm);
    assert.match(glm, /更新于/);
    const ds = await page.evaluate(optionText('.rc-line', 'ds'));
    assert.match(ds, /^DeepSeek · glm-5 · .*42\.5/, ds);
    assert.equal(await page.evaluate(optionText('.rc-line', 'plain')), '无余量线路 · glm-5');

    // 子任务线路下拉。
    assert.match(await page.evaluate(optionText('.rc-sub-provider', 'glm')), /5h 70%/);
    assert.doesNotMatch(await page.evaluate(optionText('.rc-sub-provider', 'plain')), /更新于|%/);
    console.log('Fixed line screenshot:', await page.screenshot('run-config-quota-fixed'));

    // 自动挑选：添加线路列表带彩色余量，加进池子后行上也带。
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-mode-auto'))}).click()`);
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-add'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll(${JSON.stringify(inDialog('.rc-picker-item'))}).length >= 3`));
    const pickerRows = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(inDialog('.rc-picker-item'))})]
      .map(n => [n.querySelector('.rc-picker-name').textContent, n.querySelector('.rc-limit')?.textContent || '', n.querySelector('.rc-limit')?.style.color || ''])`);
    const byName = Object.fromEntries(pickerRows.map(([name, limit, color]) => [name, { limit, color }]));
    assert.match(byName['GLM 套餐'].limit, /5h 70%/);
    assert.ok(byName['GLM 套餐'].color, 'quota badge carries the bar colour');
    assert.match(byName.DeepSeek.limit, /42\.5/);
    assert.equal(byName['无余量线路'].limit, '', 'no quota cache → no badge');
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-picker-list'))}).scrollIntoView({ block: 'center' })`);
    console.log('Auto picker screenshot:', await page.screenshot('run-config-quota-picker'));

    await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(inDialog('.rc-picker-item'))})]
      .find(n => n.querySelector('.rc-picker-name').textContent === 'GLM 套餐').click()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(inDialog('.rc-row[data-provider-id="glm"] .rc-limit'))})].some(n => /5h 70%/.test(n.textContent))`),
      'pool row shows the quota too');
    console.log('Auto pool screenshot:', await page.screenshot('run-config-quota-pool'));
  });
});
