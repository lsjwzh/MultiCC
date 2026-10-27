'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 「刷新模型」按钮：opencode 的模型 id 跟着上游走，页面却按 1 小时缓存画下拉。
// 上游改名后旧 id 会一直留在列表里，而这个按钮必须做到两件事 ——
// 跳过浏览器 localStorage（旧列表就在那儿），并要求服务端跳过它自己的缓存
// （`?refresh=1`），然后把新列表画回来、保留用户当前选中的模型。
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
routes['/run-config-host.html'] = {
  headers: { 'content-type': 'text/html' },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/run-config.css"><body>
${['auth-client.js', 'i18n-catalog.js', 'i18n.js', 'shared/dom-helpers.js', 'shared/format.js', 'api-client.js',
  'provider-catalog.js', 'auto-provider-editor.js', 'shared/models.js', 'chat-ai-config.js', 'run-config.js']
  .map(src => `<script src="/${src}"></script>`).join('')}</body>`,
};
routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
routes['/api/providers'] = () => json({ providers: [], defaults: {} });

const CACHE_KEY = 'multicc.opencode.models.v2';
// 上游改名前的旧列表：deepseek-v4-flash 已被 deepseek-v4.1-flash 取代。
const STALE = [
  { provider: 'opencode', model: 'deepseek-v4-flash', label: 'opencode/deepseek-v4-flash (OpenCode Zen)' },
  { provider: 'opencode', model: 'big-pickle', label: 'opencode/big-pickle (OpenCode Zen)' },
];
const LIVE = [
  { provider: 'opencode', model: 'deepseek-v4.1-flash', label: 'opencode/deepseek-v4.1-flash (OpenCode Zen)' },
  { provider: 'opencode', model: 'big-pickle', label: 'opencode/big-pickle (OpenCode Zen)' },
  { provider: 'opencode', model: 'flint-40b-free', label: 'opencode/flint-40b-free (OpenCode Zen)' },
];

const qaDir = () => process.env.MULTICC_OPENCODE_REFRESH_QA_DIR || path.join(os.tmpdir(), 'multicc-opencode-refresh-qa');
const D = '.air-config-dialog[open] ';
const optionValues = `[...document.querySelectorAll(${JSON.stringify(D + '.rc-model option')})].map(o => o.value)`;
const visible = selector => `(() => { const el = document.querySelector(${JSON.stringify(D + selector)}); return !!el && !el.hidden && !el.closest('[hidden]'); })()`;

test('opencode model picker: 刷新模型 bypasses both caches and repaints live ids', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const fixture = { ...routes, 'GET /api/opencode/models': () => json({ models: LIVE, source: 'cli' }) };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig'));

    // 预置一份「还没过期」的浏览器缓存：面板必须照它画旧 id，且不访问网络。
    await page.evaluate(`localStorage.setItem(${JSON.stringify(CACHE_KEY)}, ${JSON.stringify(JSON.stringify({ at: Date.now(), models: STALE }))})`);
    await page.evaluate(`window.MultiCCRunConfig.open({ configuration: { cli: 'opencode' } }, ['opencode'], () => {})`);
    assert.ok(await page.waitFor(`${optionValues}.includes('opencode/deepseek-v4-flash')`), 'stale cached ids paint first');
    assert.equal(await page.evaluate(visible('.rc-model-refresh')), true, 'opencode shows the refresh button');
    assert.equal(
      page.requests.filter(r => r.path === '/api/opencode/models').length, 0,
      'a warm browser cache must not hit the server before the button is pressed',
    );
    const before = await page.evaluate(`${optionValues}.filter(Boolean).length`);

    await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-refresh')}).click()`);
    assert.ok(await page.waitFor(`${optionValues}.includes('opencode/deepseek-v4.1-flash')`), 'live list replaces the cached one');
    assert.equal(await page.evaluate(`${optionValues}.includes('opencode/deepseek-v4-flash')`), false, 'the retired id is gone');
    assert.ok(await page.evaluate(`${optionValues}.filter(Boolean).length`) > before, 'the new model shows up');

    const calls = page.requests.filter(r => r.path === '/api/opencode/models');
    assert.equal(calls.length, 1, 'exactly one refetch');
    assert.match(calls[0].url, /refresh=1/, 'the server cache is bypassed too');
    assert.match(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-status')}).textContent`), /刷新|refreshed/i, 'the result is reported');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-refresh')}).disabled`), false, 'button is usable again');
    console.log('OpenCode refresh screenshot:', await page.screenshot('run-config-opencode-refresh'));
  });
});

test('opencode model picker: other CLIs keep the button hidden', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const fixture = { ...routes, 'GET /api/opencode/models': () => json({ models: LIVE, source: 'cli' }) };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig'));
    await page.evaluate(`window.MultiCCRunConfig.open({ configuration: { cli: 'grok' } }, ['grok'], () => {})`);
    assert.ok(await page.waitFor(`!!document.querySelector(${JSON.stringify(D + '.rc-model')})`));
    assert.equal(await page.evaluate(visible('.rc-model-refresh')), false, 'only opencode has a live model table');
  });
});
