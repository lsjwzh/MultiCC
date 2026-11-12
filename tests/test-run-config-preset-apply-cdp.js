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

    // 热缓存里只有 Zen（opencode-go 确实没了）→ 只跳过这一条，其余线路照常套用。
    const warmGone = await applyPreset(page, CN_MODELS, [{ provider: 'opencode', model: 'deepseek-v4.1-flash' }]);
    assert.ok(warmGone.includes('跳过已失效的'), `热缓存里没有 opencode-go 应跳过它，实际：${JSON.stringify(warmGone)}`);
    assert.ok(warmGone.includes('opencode'), `跳过清单应点名 opencode 线路，实际：${JSON.stringify(warmGone)}`);
    assert.equal(warmGone.includes('未套用'), false, `其余有效线路应照常套用，实际：${JSON.stringify(warmGone)}`);
  });
});

// ── 悬空供应商：保存拒绝 / 列表标记 / 套用提示列全 ──────────────────────────
const DEAD_PRESET = {
  id: 'pdead0001', name: 'CC-Claudes · 4 条', protocol: 'anthropic', pick: 'order', tiering: 'manual',
  maxAttempts: 4, sticky: true, recent: false, savedAt: 1793768221159,
  candidates: [
    { providerId: 'deadbeef01', cli: 'claude-exp', model: 'claude-opus', priority: 1 },
    { providerId: 'p-claude-1', cli: 'claude-exp', model: 'claude-opus', priority: 2 },
    { providerId: 'cafebabe02', cli: 'claude-exp', model: 'claude-opus', priority: 3 },
  ],
};

async function openPanel(page, preset, configuration = {}) {
  await page.evaluate(`window.__saved=[]`);
  await page.evaluate(`localStorage.setItem('multicc.autoProvider.presets.v1', JSON.stringify(${JSON.stringify(preset ? [preset] : [])}))`);
  await page.evaluate(`window.MultiCCRunConfig.open({ configuration: ${JSON.stringify({
    cli: 'claude', provider: 'p-claude-1', model: 'claude-opus', ...configuration,
  })} }, ${JSON.stringify(CLIENT_CLIS)}, value => { window.__saved.push(value) })`);
  await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-preset'))})`);
}

test('预设列表：含已删除线路的预设带「N 条线路已删除」标记', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-preset-apply-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"');
    await openPanel(page, DEAD_PRESET);
    // 目录（claude-exp）取回之后才判得出失效线路：等标记自己出现。
    const marked = await page.waitFor(
      `[...document.querySelectorAll(${JSON.stringify(inDialog('.rc-preset option'))})]
        .some(o => o.textContent.includes('2 条线路已删除'))`, { timeoutMs: 8000 });
    assert.ok(marked, '预设下拉应标出 2 条已删除线路');
    const options = await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(inDialog('.rc-preset option'))})].map(o => o.textContent)`);
    assert.ok(options.some(text => text.includes('CC-Claudes · 4 条') && text.includes('2 条线路已删除')),
      `下拉选项文字应带标记，实际：${JSON.stringify(options)}`);
  });
});

test('套用含已删除线路的预设：跳过失效线路，有效线路照常套用', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-preset-apply-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"');
    const status = await applyPreset(page, DEAD_PRESET, null);
    assert.equal(status.includes('未套用'), false, `有一条有效线路就应套用，实际：${JSON.stringify(status)}`);
    assert.ok(status.includes('已套用 1 条有效线路'), `应只套用 1 条有效线路，实际：${JSON.stringify(status)}`);
    assert.ok(status.includes('deadbeef（claude-exp）'), `提示应列出跳过的 deadbeef，实际：${JSON.stringify(status)}`);
    assert.ok(status.includes('cafebabe（claude-exp）'), `提示应列出跳过的 cafebabe，实际：${JSON.stringify(status)}`);
    // 底部摘要反映的是套用后的池子：只剩那条有效线路。
    const foot = await page.evaluate(`(document.querySelector(${JSON.stringify(inDialog('.air-config-footer p'))})||{}).textContent||''`);
    assert.ok(foot.includes('1 条线路'), `池子应只剩 1 条线路，实际：${JSON.stringify(foot)}`);
  });
});

test('套用全部线路都已删除的预设：不套用并列出全部失效线路', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-preset-apply-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"');
    const allDead = { ...DEAD_PRESET, id: 'palldead01', name: '全失效',
      candidates: DEAD_PRESET.candidates.filter(item => item.providerId !== 'p-claude-1') };
    const status = await applyPreset(page, allDead, null);
    assert.ok(status.includes('未套用'), `一条有效线路都没有应不套用，实际：${JSON.stringify(status)}`);
    assert.ok(status.includes('deadbeef（claude-exp）') && status.includes('cafebabe（claude-exp）'),
      `提示应列出全部失效线路，实际：${JSON.stringify(status)}`);
  });
});

test('保存预设：池子里有已删除的供应商就拒绝，并列出所有失效线路', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-preset-apply-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"');
    // 会话池子里有一条供应商已经没了的线路（打开面板时就是这份草稿）。
    await openPanel(page, null, {
      providerSelection: {
        mode: 'auto', maxAttempts: 2, sticky: true, cliSwitch: 'failover',
        candidates: [
          { providerId: 'deadbeef01', cli: 'claude-exp', model: 'claude-opus', priority: 1 },
          { providerId: 'p-claude-1', cli: 'claude-exp', model: 'claude-opus', priority: 2 },
        ],
      },
    });
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-preset-open'))}).click()`);
    await sleep(100);
    await page.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(inDialog('.rc-preset-name'))});
      input.value = '悬空池子';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector(${JSON.stringify(inDialog('.rc-preset-save'))}).click();
    })()`);
    await sleep(800);
    const status = await page.evaluate(
      `(document.querySelector(${JSON.stringify(inDialog('.rc-preset-status'))})||{}).textContent||''`);
    assert.ok(status.includes('已被删除'), `应拒绝保存并说明被删，实际：${JSON.stringify(status)}`);
    assert.ok(status.includes('deadbeef（claude-exp）'), `提示应列出 deadbeef，实际：${JSON.stringify(status)}`);
    const stored = await page.evaluate(
      `localStorage.getItem('multicc.autoProvider.presets.v1') || ''`);
    assert.equal(stored.includes('悬空池子'), false, '被拒的池子不能落进预设');
  });
});
