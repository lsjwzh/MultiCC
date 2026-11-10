'use strict';
// 运行配置「自动挑选」套用预设的两处可用性判定：
//   · 退休别名 claude-exp 折回 claude 后，固定 tab 选非 claude（如 codex-exp）也能套
//     纯 claude-exp 的旧预设（CC-Claudes）。
//   · 预设里带 OpenCode 原生线路（opencode-native:*）时，模型目录是 1 小时 TTL 的
//     本地缓存；冷缓存（还没加载 / opencode 暂时不可用）不等于这条线路没了，不能
//     拦下整套预设。只有缓存是热的、且确实查不到这条线路才判「不可用」。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');
const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 与 CLIENT_CHAT_CLIS 一致：claude-exp 是退休别名，不在「已安装」清单里。
const CLIENT_CLIS = ['claude', 'codex', 'codex-exp', 'opencode', 'zcode', 'qoder', 'kimi', 'codebuddy', 'dsh', 'gemini', 'grok', 'commandcode', 'pi'];

// 纯 claude-exp 的旧预设（对应真实的 CC-Claudes）。
const CC_CLAUDES = {
  id: 'pmw0j58tk3ch5', name: 'CC-Claudes', protocol: 'anthropic', pick: 'order', tiering: 'manual',
  maxAttempts: 5, sticky: true, recent: false, savedAt: 1793768221159,
  candidates: [
    { providerId: 'p-claude-1', cli: 'claude-exp', model: 'claude-opus', priority: 1 },
    { providerId: 'p-claude-2', cli: 'claude-exp', model: 'claude-opus', priority: 2 },
  ],
};
// 带一条 OpenCode 原生线路的预设（对应真实的 CN-Models）。
const CN_MODELS = {
  id: 'pmw0gqm1jhrhy', name: 'CN-Models', protocol: 'anthropic', pick: 'order', tiering: 'manual',
  maxAttempts: 7, sticky: true, recent: false, savedAt: 1793955426141,
  candidates: [
    { providerId: 'p-claude-1', cli: 'claude-exp', model: 'claude-opus', priority: 1 },
    { providerId: 'codebuddy-native:codebuddy', cli: 'codebuddy', model: 'deepseek-v4.1-flash', priority: 2 },
    { providerId: 'opencode-native:opencode-go', cli: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', priority: 3 },
  ],
};

const claudeProviders = [
  { id: 'p-claude-1', name: 'Claude A', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude', 'claude-exp'], model: 'claude-opus', modelOptions: ['claude-opus'] },
  { id: 'p-claude-2', name: 'Claude B', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude', 'claude-exp'], model: 'claude-opus', modelOptions: ['claude-opus'] },
];

function buildRoutes() {
  const routes = {};
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/run-config-host.html'] = {
    headers: { 'content-type': 'text/html' },
    body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/run-config.css"><body>` + ['i18n-catalog.js', 'i18n.js', 'shared/dom-helpers.js', 'shared/format.js', 'api-client.js', 'provider-catalog.js', 'auto-provider-editor.js', 'shared/models.js', 'chat-ai-config.js', 'run-config-controls.js', 'run-config.js', 'quota-bar-view.js'].map(s => `<script src="/${s}"></script>`).join('') + `</body>`,
  };
  routes['/api/providers'] = ({ url }) => {
    const cli = url.searchParams.get('cli') || '';
    if (cli === 'claude' || cli === 'claude-exp') return json({ available: true, providers: claudeProviders, defaults: {} });
    return json({ available: true, providers: [], defaults: {} });
  };
  routes['/api/run-config/presets/merge'] = ({ body }) => json({ ok: true, presets: JSON.parse(body || '{}').presets || [] });
  routes['/api/run-config/presets'] = () => json({ ok: true });
  return routes;
}

const inDialog = selector => `.air-config-dialog[open] ${selector}`;

async function seedOpenCodeModels(page, models) {
  await page.evaluate(`localStorage.removeItem('multicc.opencode.models.v2')`);
  if (models !== null) {
    await page.evaluate(`localStorage.setItem('multicc.opencode.models.v2', JSON.stringify({ at: Date.now(), models: ${JSON.stringify(models)} }))`);
  }
}

async function applyPreset(page, preset, opencodeModels) {
  await page.evaluate(`window.__saved=[]`);
  await seedOpenCodeModels(page, opencodeModels);
  await page.evaluate(`localStorage.setItem('multicc.autoProvider.presets.v1', JSON.stringify(${JSON.stringify([preset])}))`);
  // 固定 tab 是 codex-exp（非 claude）。
  await page.evaluate(`window.MultiCCRunConfig.open({ configuration: { cli: 'codex-exp', provider: 'x-main', model: 'gpt-5.6' } }, ${JSON.stringify(CLIENT_CLIS)}, value => { window.__saved.push(value) })`);
  await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-preset'))})`);
  await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-mode-auto'))}).click()`);
  await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-preset'))})`);
  await page.evaluate(`window.confirm = () => true`);
  await page.evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(inDialog('.rc-preset'))}); s.value=${JSON.stringify(preset.id)}; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await sleep(800);
  return page.evaluate(`(document.querySelector(${JSON.stringify(inDialog('.rc-preset-status'))})||{}).textContent||''`);
}

test('退休别名 claude-exp 的预设，固定 tab 非 claude 也能套用', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-preset-apply-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"');
    const status = await applyPreset(page, CC_CLAUDES, null);
    assert.equal(status.includes('已不可用'), false, `CC-Claudes 应套用成功，实际：${JSON.stringify(status)}`);
  });
});

test('预设带 OpenCode 原生线路：冷缓存不拦，热缓存里查不到才判不可用', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-preset-apply-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"');

    // 冷缓存（opencode 还没加载 / 暂时不可用）→ 不拦。
    const cold = await applyPreset(page, CN_MODELS, null);
    assert.equal(cold.includes('已不可用'), false, `冷缓存应套用成功，实际：${JSON.stringify(cold)}`);

    // 热缓存里确实有 opencode-go → 套用（含旧别名 opencodego 的比对）。
    const warmCanonical = await applyPreset(page, CN_MODELS, [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }]);
    assert.equal(warmCanonical.includes('已不可用'), false, `热缓存含 opencode-go 应套用成功，实际：${JSON.stringify(warmCanonical)}`);
    const warmAlias = await applyPreset(page, CN_MODELS, [{ provider: 'opencodego', model: 'deepseek-v4.1-flash' }]);
    assert.equal(warmAlias.includes('已不可用'), false, `旧别名 opencodego 应等同 opencode-go，实际：${JSON.stringify(warmAlias)}`);

    // 热缓存里只有 Zen（opencode-go 确实没了）→ 判不可用。
    const warmGone = await applyPreset(page, CN_MODELS, [{ provider: 'opencode', model: 'deepseek-v4.1-flash' }]);
    assert.equal(warmGone.includes('已不可用'), true, `热缓存里没有 opencode-go 应判不可用，实际：${JSON.stringify(warmGone)}`);
  });
});
