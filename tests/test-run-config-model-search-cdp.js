'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
const { parseCommandcodeList } = require('../src/routes/commandcode-models');

// 运行配置里的模型下拉在真 Chrome 里走一遍：Command Code 的 94 个模型按厂商
// 自己的分组画 <optgroup>、目录长就出现搜索框、过滤不丢当前选中值；目录短的车道
// （Grok 两个）没有搜索框也没有分组。
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
  'provider-catalog.js', 'auto-provider-editor.js', 'shared/models.js', 'chat-ai-config.js', 'run-config-controls.js', 'run-config.js']
  .map(src => `<script src="/${src}"></script>`).join('')}</body>`,
};
routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
routes['/api/providers'] = () => json({ providers: [], defaults: {} });

const CC_MODELS = parseCommandcodeList(fs.readFileSync(path.join(__dirname, 'fixtures', 'commandcode-list-models.txt'), 'utf8'));
const qaDir = () => process.env.MULTICC_RUN_CONFIG_MODEL_SEARCH_QA_DIR || path.join(os.tmpdir(), 'multicc-run-config-model-search-qa');
const D = '.air-config-dialog[open] ';
const visible = selector => `(() => { const el = document.querySelector(${JSON.stringify(D + selector)}); return !!el && !el.hidden && !el.closest('[hidden]') && el.getBoundingClientRect().height > 0; })()`;
const optionValues = `[...document.querySelectorAll(${JSON.stringify(D + '.rc-model option')})].map(o => o.value)`;

test('Command Code model picker: vendor groups, search box, filter keeps the current pick', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  assert.equal(CC_MODELS.length, 94);
  const fixture = { ...routes,
    'GET /api/commandcode/models': () => json({ models: CC_MODELS, source: 'cli' }),
    'GET /api/grok/models': () => json({ models: [{ model: 'grok-4.6' }, { model: 'grok-4.5' }], source: 'cli' }),
    'GET /api/cli-accounts/commandcode': () => json({ ok: true, cli: 'commandcode', accounts: [] }),
    'GET /api/sessions/ms': () => json({ id: 'ms', cli: 'commandcode', cliAccounts: null }),
  };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig'));
    await page.evaluate(`window.MultiCCRunConfig.open({ sessionId: 'ms', configuration: { cli: 'commandcode', model: 'claude-sonnet-5-5' } }, ['commandcode', 'grok'], () => {})`);

    // Cold cache first draws the static fallback; the live catalog repaints it.
    assert.ok(await page.waitFor(`${optionValues}.length > 90`), 'live catalog replaces the fallback list');
    const groups = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(D + '.rc-model optgroup')})].map(g => g.label)`);
    assert.deepEqual(groups, ['Open Source', 'Stealth', 'Anthropic', 'OpenAI', 'Google', 'Sakana', 'Meta', 'xAI', 'DeepSeek Flash (byok)']);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model')}).value`), 'claude-sonnet-5-5', 'the session\'s model stays selected');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model option[value="claude-sonnet-5-5"]')}).parentElement.label`), 'Anthropic');
    assert.equal(await page.evaluate(visible('.rc-model-search')), true, 'a 94-model catalog gets a search box');
    console.log('Model picker screenshot:', await page.screenshot('run-config-model-groups'));

    // Typing filters by id; the current pick, the default row and 自定义… survive.
    await page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(D + '.rc-model-search')}); s.value = 'kimi'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const filtered = await page.evaluate(optionValues);
    assert.ok(filtered.includes('moonshotai/kimi-k3') && filtered.includes('moonshotai/kimi-k2.6'));
    assert.ok(!filtered.includes('deepseek/deepseek-v4-pro'), 'non-matching rows are hidden');
    assert.ok(filtered.includes('') && filtered.includes('__custom__') && filtered.includes('claude-sonnet-5-5'));
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model')}).value`), 'claude-sonnet-5-5', 'filtering never changes the pick');

    // Clearing the box restores the whole catalog.
    await page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(D + '.rc-model-search')}); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok((await page.evaluate(optionValues)).length > 90);

    // A short catalog (Grok) has neither a search box nor groups.
    await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-cli-card[data-cli="grok"]')}).click()`);
    assert.ok(await page.waitFor(`${optionValues}.includes('grok-4.6')`));
    assert.equal(await page.evaluate(visible('.rc-model-search')), false);
    assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(D + '.rc-model optgroup')}).length`), 0);
  });
});
