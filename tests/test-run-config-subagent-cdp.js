'use strict';
// 子 agent 在运行配置里的这一套：常显的区块、首次强提示、家族默认预填、
// 勾「同步」后的 dry run 预览与保存时的真同步。界面文案全部走 i18n 中文块，
// 所以把 navigator.language 钉在 zh-CN（headless 默认跟随宿主系统）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');
const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, timeoutMs = 6000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const claudeProviders = [
  { id: 'p-main', name: '主线路', appType: 'claude', apiFormat: 'anthropic',
    compatibleClis: ['claude', 'claude-exp'], model: 'claude-opus', modelOptions: ['claude-opus', 'claude-sonnet'] },
  { id: 'p-cheap', name: '便宜线路', appType: 'claude', apiFormat: 'anthropic',
    compatibleClis: ['claude', 'claude-exp'], model: 'claude-haiku', modelOptions: ['claude-haiku', 'claude-sonnet'] },
];
const codexProviders = [
  { id: 'x-main', name: 'Codex 主线路', appType: 'codex', apiFormat: 'openai_responses',
    compatibleClis: ['codex', 'codex-exp'], model: 'gpt-5.6', modelOptions: ['gpt-5.6', 'gpt-5.6-sol'] },
  { id: 'x-cheap', name: 'Codex 便宜线路', appType: 'codex', apiFormat: 'openai_responses',
    compatibleClis: ['codex', 'codex-exp'], model: 'gpt-5-mini', modelOptions: ['gpt-5-mini', 'gpt-5.6'] },
];
const defaults = {
  claude: 'p-main',
  codex: 'x-main',
  subagent: {
    claude: { providerId: 'p-cheap', model: 'claude-haiku' },
    codex: { providerId: 'x-cheap', model: 'gpt-5-mini' },
  },
};

function buildRoutes() {
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
  // 与 air.html 同一依赖顺序。
  routes['/run-config-host.html'] = {
    headers: { 'content-type': 'text/html' },
    body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/run-config.css"><body>
${['auth-client.js', 'i18n-catalog.js', 'i18n.js', 'shared/dom-helpers.js', 'shared/format.js', 'api-client.js',
  'provider-catalog.js', 'auto-provider-editor.js', 'shared/models.js', 'chat-ai-config.js', 'run-config.js', 'quota-bar-view.js']
  .map(src => `<script src="/${src}"></script>`).join('')}</body>`,
  };
  routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
  routes['/api/providers'] = ({ url }) => {
    const cli = url.searchParams.get('cli') || '';
    if (cli === 'claude' || cli === 'claude-exp') return json({ available: true, providers: claudeProviders, defaults });
    if (cli === 'codex' || cli === 'codex-exp') return json({ available: true, providers: codexProviders, defaults });
    return json({ available: true, providers: [], defaults: {} });
  };
  return routes;
}

const inDialog = selector => `.air-config-dialog[open] ${selector}`;
const openDraft = (page, configuration = { cli: 'claude-exp', provider: 'p-main', model: 'claude-opus' }, extra = {}) =>
  page.evaluate(`window.__saved=[];window.MultiCCRunConfig.open(${JSON.stringify({ configuration, ...extra })}, ['claude-exp','codex-exp'], value => { window.__saved.push(value) })`);
const text = (page, selector) => page.evaluate(`(document.querySelector(${JSON.stringify(inDialog(selector))})||{}).textContent||''`);
const saveShot = (file, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target); return target; };

test('sub-agent section is a always-visible section with guide, and terminal drafts still hide it', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-subagent-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"'));
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}) && [...document.querySelectorAll(${JSON.stringify(inDialog('.rc-sub-provider option'))})].some(o => o.value === 'p-cheap')`));

    // 不是折叠的 <details>，是常显的一节。
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub'))}).tagName`), 'SECTION');
    assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(inDialog('details.rc-advanced, .rc-advanced'))}).length`), 0, '旧的折叠块已经不存在');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub'))}).hidden`), false);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(inDialog('.rc-sub'))})).display !== 'none'`), true);
    assert.equal((await text(page, '.rc-sub-title-row h3')).trim(), '子 agent');
    assert.match(await text(page, '.rc-sub-subtitle'), /子任务用哪条线路和模型/);
    assert.match(await text(page, '.rc-sub-why'), /更便宜或更快/);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).getAttribute('aria-label')`), '子 agent 线路');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-model'))}).getAttribute('aria-label')`), '子 agent 模型');
    // 同步行的家族名是产品名，不是内部 id。
    assert.match(await text(page, '.rc-sub-sync'), /同步到全部 Claude Code 任务，之后新建的也默认用这套/);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync input'))}).checked`), false, '每次打开都不勾同步');

    // 首次打开：NEW 徽章 + 强提示浮层（标题、正文、两颗按钮）都在。
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden === false`), '首次打开要出引导');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-new'))}).hidden`), false);
    assert.equal((await text(page, '.rc-sub-new')).trim(), 'NEW');
    assert.match(await text(page, '.rc-sub-guide h4'), /新功能：子 agent 可以单独选线路和模型/);
    assert.match(await text(page, '.rc-sub-guide p'), /默认跟主线路走/);
    assert.match(await text(page, '.rc-sub-guide p'), /能省额度/);
    assert.equal((await text(page, '.rc-sub-guide-apply')).trim(), '现在设置');
    assert.equal((await text(page, '.rc-sub-guide-dismiss')).trim(), '知道了');
    await sleep(500); // 平滑滚动落定再截图
    const guideShot = saveShot(await page.screenshot('subagent-guide-web'), '/tmp/subagent-guide-web.png');
    console.log('Guide screenshot:', guideShot);

    // 知道了 = 收掉 + 记 localStorage；再打开不再出现。
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide-dismiss'))}).click()`);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden`), true);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-new'))}).hidden`), true);
    assert.equal(await page.evaluate(`localStorage.getItem('multicc.runConfig.subagentGuide.v1')`), '1');
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.air-config-close'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.air-config-close'))}) === null`));
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}) !== null`));
    await sleep(300);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden`), true, '看过一次就不再强弹');
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.air-config-close'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.air-config-close'))}) === null`));

    // 终端草稿：任务轮次不收子 agent，整节不摆。
    await openDraft(page, { cli: 'claude-exp', provider: 'p-main', model: 'claude-opus' }, { purpose: 'terminal' });
    // 区块在 renderSub 之前是「没设过 hidden」的，等它被真正藏起来才算 boot 跑完。
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub'))}) && document.querySelector(${JSON.stringify(inDialog('.rc-sub'))}).hidden === true`), '终端这遍不摆子 agent');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden`), true, '终端也不出引导');
  });
});

test('guide buttons: 现在设置 focuses the line select; changing a select dismisses and persists', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-subagent-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"'));
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}) && document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden === false`));
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide-apply'))}).click()`);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden`), true);
    assert.equal(await page.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))})`), true, '现在设置要落到线路下拉上');
    assert.equal(await page.evaluate(`localStorage.getItem('multicc.runConfig.subagentGuide.v1')`), '1');
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.air-config-close'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.air-config-close'))}) === null`));

    // 没看过时，动下拉也算「看过了」。
    await page.evaluate(`localStorage.removeItem('multicc.runConfig.subagentGuide.v1')`);
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}) && document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden === false`));
    await page.evaluate(`(()=>{const p=${JSON.stringify(inDialog('.rc-sub-provider'))};const s=document.querySelector(p);s.value='p-main';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden`), true);
    assert.equal(await page.evaluate(`localStorage.getItem('multicc.runConfig.subagentGuide.v1')`), '1');
  });
});

test('draft defaults prefill the family route and follow CLI family switches; stored route wins', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-subagent-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"'));
    await openDraft(page);
    // 草稿没带 subagent：按家族默认（p-cheap / claude-haiku）预填。
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).value === 'p-cheap'`), '草稿要用家族默认预填');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-model'))}).value`), 'claude-haiku');
    assert.equal((await text(page, '.rc-sub-state')).trim(), '已单独设置');
    assert.match(await text(page, '.rc-sub-sync-status'), /新任务默认：便宜线路 · claude-haiku/);

    // 换到 codex 家族：默认跟着换成 codex 那一份。
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.air-cli-option[data-cli="codex-exp"]'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).value === 'x-cheap'`), '换家族要换成新家族的默认');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-model'))}).value`), 'gpt-5-mini');
    assert.match(await text(page, '.rc-sub-sync'), /同步到全部 Codex 任务/);
    // 切回 claude 家族也一样。
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.air-cli-option[data-cli="claude-exp"]'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).value === 'p-cheap'`));
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.air-config-close'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.air-config-close'))}) === null`));

    // 已经带着子 agent 的配置：默认不能盖掉它。
    await openDraft(page, { cli: 'claude-exp', provider: 'p-main', model: 'claude-opus', subagent: { providerId: 'p-main', model: 'claude-opus' } });
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).value === 'p-main'`), '已存值优先于家族默认');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-model'))}).value`), 'claude-opus');
  });
});

test('sync checkbox previews via debounced dry run, reruns on selection change, then saves and syncs', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = buildRoutes();
  const syncCalls = [];
  routes['/api/subagent-defaults/sync'] = ({ body }) => {
    const payload = JSON.parse(body || '{}');
    syncCalls.push(payload);
    const counts = payload.subagent && payload.subagent.providerId === 'p-cheap'
      ? { applied: 2, deferred: 0, unchanged: 0, skipped: 1 }
      : { applied: 1, deferred: 0, unchanged: 0, skipped: 0 };
    return json({ ok: true, dryRun: !!payload.dryRun, family: 'claude', subagent: payload.subagent,
      defaults: { claude: payload.subagent, codex: { providerId: 'x-cheap', model: 'gpt-5-mini' } },
      counts, sessions: [], truncated: false });
  };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-subagent-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"'));
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).value === 'p-cheap'`));
    assert.equal(syncCalls.length, 0, '不勾就不请求');

    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync input'))}).click()`);
    await until(() => syncCalls.length >= 1, 6000, 'first dry run');
    assert.deepEqual(syncCalls[0], { cli: 'claude-exp', subagent: { providerId: 'p-cheap', model: 'claude-haiku' }, dryRun: true });
    assert.ok(await page.waitFor(`/将更新 2 个任务/.test(document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync-status'))}).textContent)`));
    assert.match(await text(page, '.rc-sub-sync-status'), /1 个跳过/);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync-status'))}).classList.contains('is-ready')`), true);

    // 换子 agent 线路 + 模型：防抖后按新组合重问（旧响应作废）。
    await page.evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))});p.value='p-main';p.dispatchEvent(new Event('change',{bubbles:true}));const m=document.querySelector(${JSON.stringify(inDialog('.rc-sub-model'))});m.value='claude-opus';m.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => syncCalls.length >= 2, 6000, 'second dry run');
    assert.deepEqual(syncCalls[1], { cli: 'claude-exp', subagent: { providerId: 'p-main', model: 'claude-opus' }, dryRun: true });
    assert.ok(await page.waitFor(`/将更新 1 个任务/.test(document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync-status'))}).textContent)`));
    await sleep(400);
    const syncShot = saveShot(await page.screenshot('subagent-sync-web'), '/tmp/subagent-sync-web.png');
    console.log('Sync screenshot:', syncShot);
    assert.equal(syncCalls.length, 2, '稳定后不再重复请求（同一个组合只问一次）');

    // 保存：先落任务（onSaved），再发真的同步（不带 dryRun），成功后关框。
    await page.evaluate(`document.querySelector('.air-config-dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open]') === null`), '同步成功后关闭对话框');
    assert.equal((await page.evaluate('window.__saved')).length, 1);
    assert.deepEqual((await page.evaluate('window.__saved'))[0].subagent, { providerId: 'p-main', model: 'claude-opus' });
    const real = syncCalls.filter(call => !call.dryRun);
    assert.equal(real.length, 1);
    assert.deepEqual(real[0], { cli: 'claude-exp', subagent: { providerId: 'p-main', model: 'claude-opus' } });

    // 再打开：同步框回到不勾。
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync input'))}) !== null`));
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync input'))}).checked`), false);
  });
});

test('503 from the sync route disables the checkbox and explains the restart', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = buildRoutes();
  const syncCalls = [];
  routes['/api/subagent-defaults/sync'] = ({ body }) => {
    syncCalls.push(JSON.parse(body || '{}'));
    return json({ ok: false, code: 'rust_backend_unavailable', message: 'rust backend unavailable' }, 503);
  };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-subagent-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"'));
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).value === 'p-cheap'`));
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync input'))}).click()`);
    await until(() => syncCalls.length >= 1, 6000, 'dry run against the old server');
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync input'))}).disabled === true`), '503 后锁上同步框');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync input'))}).checked`), false);
    assert.match(await text(page, '.rc-sub-sync-status'), /需要重启 MultiCC 服务/);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync-status'))}).classList.contains('is-error')`), true);
  });
});

test('sync failure after saving keeps the dialog open and the retry only re-sends the sync', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = buildRoutes();
  const syncCalls = [];
  routes['/api/subagent-defaults/sync'] = ({ body }) => {
    const payload = JSON.parse(body || '{}');
    syncCalls.push(payload);
    if (payload.dryRun) return json({ ok: true, dryRun: true, family: 'claude', subagent: payload.subagent,
      defaults: { claude: payload.subagent, codex: null }, counts: { applied: 1, deferred: 0, unchanged: 0, skipped: 0 }, sessions: [], truncated: false });
    const reals = syncCalls.filter(call => !call.dryRun).length;
    if (reals === 1) return json({ ok: false, message: 'boom' }, 500);
    return json({ ok: true, dryRun: false, family: 'claude', subagent: payload.subagent,
      defaults: { claude: payload.subagent, codex: null }, counts: { applied: 1, deferred: 0, unchanged: 0, skipped: 0 }, sessions: [], truncated: false });
  };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-subagent-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"'));
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).value === 'p-cheap'`));
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-sync input'))}).click()`);
    await until(() => syncCalls.some(call => call.dryRun), 6000, 'dry run before save');

    await page.evaluate(`document.querySelector('.air-config-dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] .air-config-error').textContent.includes('本任务已保存，但同步失败')`), '同步失败要说明任务已保存');
    assert.match(await text(page, '.air-config-error'), /boom/);
    assert.equal(await page.evaluate('window.__saved.length'), 1, '任务只保存一次');
    assert.equal((await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.air-config-footer .primary'))}).textContent`)).trim(), '重试同步');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.air-config-footer .primary'))}).disabled`), false);

    // 再点一次提交：只重发同步，不再走保存（`window.__saved` 仍是 1 条）。
    await page.evaluate(`document.querySelector('.air-config-dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open]') === null`), '重试成功后关闭');
    assert.equal(await page.evaluate('window.__saved.length'), 1);
    assert.equal(syncCalls.filter(call => !call.dryRun).length, 2);
  });
});

test('auto mode keeps the same section, and presets still carry the sub-agent route', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-subagent-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"'));
    await openDraft(page, {
      cli: 'claude-exp',
      provider: 'p-main',
      providerSelection: { mode: 'auto', cliSwitch: 'failover', protocol: 'anthropic', candidates: [
        { cli: 'claude-exp', providerId: 'p-main', model: 'claude-opus' },
        { cli: 'claude-exp', providerId: 'p-cheap', model: 'claude-haiku' },
      ] },
    });
    assert.ok(await page.waitFor(`document.querySelectorAll(${JSON.stringify(inDialog('.rc-row'))}).length === 2`));
    // 自动挑选和固定一条共用同一节，位置一样常显。
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub'))}).hidden`), false);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(inDialog('.rc-sub'))})).display !== 'none'`), true);

    // 挂一套子 agent，存成预设。
    await page.evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))});p.value='p-cheap';p.dispatchEvent(new Event('change',{bubbles:true}));const m=document.querySelector(${JSON.stringify(inDialog('.rc-sub-model'))});m.value='claude-haiku';m.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-preset-open'))}).click();document.querySelector(${JSON.stringify(inDialog('.rc-preset-name'))}).value='带子 agent';document.querySelector(${JSON.stringify(inDialog('.rc-preset-save'))}).click()`);
    assert.ok(await page.waitFor(`JSON.parse(localStorage.getItem('multicc.autoProvider.presets.v1')||'[]').some(p=>p.name==='带子 agent')`));
    assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem('multicc.autoProvider.presets.v1')).find(p=>p.name==='带子 agent').subagent`),
      { providerId: 'p-cheap', model: 'claude-haiku' });

    // 清空子 agent 再套用预设：设置要跟着预设回来。套用预设要走一次原生
    // confirm()，headless 里它会卡住渲染线程，先替用户点「确定」。
    await page.evaluate(`window.confirm = () => true`);
    await page.evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))});p.value='';p.dispatchEvent(new Event('change',{bubbles:true}));const s=document.querySelector(${JSON.stringify(inDialog('.rc-preset'))});s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));s.value=JSON.parse(localStorage.getItem('multicc.autoProvider.presets.v1')).find(p=>p.name==='带子 agent').id;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-provider'))}).value === 'p-cheap'`), '套用预设后子 agent 线路回到面板');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-model'))}).value`), 'claude-haiku');

    await page.evaluate(`document.querySelector('.air-config-dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open]') === null`));
    const saved = await page.evaluate('window.__saved');
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].subagent, { providerId: 'p-cheap', model: 'claude-haiku' });
    assert.equal(saved[0].providerSelection.mode, 'auto');
  });
});

test('mobile width keeps the guide and section inside the viewport', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-subagent-cdp'), locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && document.readyState==="complete"'));
    await openDraft(page);
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}) && document.querySelector(${JSON.stringify(inDialog('.rc-sub-guide'))}).hidden === false`));
    await sleep(500);
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, '不能把页面撑出横向滚动');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(inDialog('.rc-sub'))}).getBoundingClientRect().right <= innerWidth`), true);
    const shot = saveShot(await page.screenshot('subagent-guide-web-mobile'), '/tmp/subagent-guide-web-mobile.png');
    console.log('Mobile screenshot:', shot);
  });
});
