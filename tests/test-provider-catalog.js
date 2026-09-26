'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const catalog = require('../public/provider-catalog');

const ROOT = path.join(__dirname, '..');

test('provider summaries are whitelisted and credential material is discarded', () => {
  const provider = catalog.normalizeProvider({
    id: 'claude-local',
    appType: 'claude',
    protocol: 'malicious-route-override',
    wireApi: 'malicious-wire-override',
    name: 'Local relay',
    source: 'ccswitch',
    baseUrl: 'https://user:password@relay.test/anthropic?token=leak#secret',
    model: 'model-a',
    modelOptions: ['model-b', 'model-a', '', 'model-b'],
    aliasMap: {
      opus: { model: 'wire-opus', name: 'Friendly' },
      unknown: { model: 'must-drop' },
    },
    tokenMask: 'raw-token-must-drop',
    hasToken: true,
    authToken: 'raw-token',
    apiKey: 'raw-api-key',
    settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: 'nested-secret' } },
    headers: { Authorization: 'Bearer secret' },
  });

  assert.deepEqual(provider.modelOptions, ['model-a', 'model-b']);
  assert.deepEqual(provider.aliasMap, { opus: { model: 'wire-opus', name: 'Friendly' } });
  assert.equal(provider.baseUrl, 'https://relay.test/anthropic');
  assert.equal(provider.tokenMask, '');
  assert.equal(provider.hasToken, true);
  assert.equal(provider.authToken, undefined);
  assert.equal(provider.apiKey, undefined);
  assert.equal(provider.protocol, 'anthropic');
  assert.equal(provider.apiFormat, 'anthropic');
  assert.deepEqual(provider.compatibleClis, ['claude', 'claude-exp', 'opencode', 'zcode']);
  assert.equal(provider.wireApi, '');
  assert.equal(provider.settingsConfig, undefined);
  assert.equal(provider.headers, undefined);
  const serialized = JSON.stringify(provider);
  for (const secret of ['raw-token', 'raw-api-key', 'nested-secret', 'password']) {
    assert.equal(serialized.includes(secret), false);
  }

  const oauthOnly = catalog.normalizeProvider({
    id: 'codex-official',
    appType: 'codex',
    name: 'Codex Official',
    apiFormat: 'openai_responses',
    baseUrl: '',
    hasToken: false,
    isOfficial: true,
  });
  assert.deepEqual(oauthOnly.compatibleClis, ['codex', 'codex-exp', 'opencode'],
    'ZCode cannot replay another CLI OAuth subscription');

  const hostileOAuthDto = catalog.normalizeProvider({
    id: 'codex-oauth-hostile',
    appType: 'codex',
    name: 'Codex OAuth',
    apiFormat: 'openai_responses',
    baseUrl: '',
    hasToken: false,
    compatibleClis: ['codex', 'codex-exp', 'opencode', 'zcode'],
  });
  assert.deepEqual(hostileOAuthDto.compatibleClis, ['codex', 'codex-exp', 'opencode'],
    'the client boundary also rejects an injected ZCode OAuth compatibility flag');
});

test('catalog grouping, lookup and model options are deterministic', () => {
  const normalized = catalog.normalizeCatalog({
    available: true,
    ccSwitchAvailable: true,
    ccSwitchStatus: {
      available: true,
      dbFound: true,
      dbPath: '/private/home/.cc-switch/cc-switch.db',
      message: '',
    },
    defaults: { claude: 'c1', codex: 'x1', secret: 'drop' },
    providers: [
      { id: 'x1', appType: 'codex', name: 'Codex', model: 'gpt-a', models: ['gpt-b'] },
      { id: 'c1', appType: 'claude', name: 'Claude', modelOptions: ['sonnet', 'opus'] },
      { id: 'bad', appType: 'other', name: 'Drop me' },
    ],
    stats: [{
      providerId: 'c1',
      inputTokens: 10,
      freshInputTokens: 2,
      cacheReadTokens: 6,
      unattributedInputTokens: 2,
      breakdownKnown: true,
      today: {
        inputTokens: 10,
        freshInputTokens: 2,
        cacheReadTokens: 8,
        breakdownKnown: true,
        outputTokens: 2,
        secret: 'drop',
      },
      totalTokens: 12,
      turnCount: 1,
      sessionCount: 1,
    }],
    authToken: 'drop',
  });

  const groups = catalog.groupByAppType(normalized);
  assert.deepEqual(groups.claude.map(item => item.id), ['c1']);
  assert.deepEqual(groups.codex.map(item => item.id), ['x1']);
  assert.equal(catalog.findProvider(normalized, 'claude', 'c1').name, 'Claude');
  assert.equal(catalog.findProvider(normalized, 'codex', 'c1'), null);
  assert.deepEqual(catalog.modelsFor(catalog.findProvider(normalized, 'codex', 'x1')), ['gpt-a', 'gpt-b']);
  assert.deepEqual(normalized.defaults, { claude: 'c1', codex: 'x1' });
  assert.equal(normalized.ccSwitchStatus.dbPath, undefined);
  assert.equal(normalized.authToken, undefined);
  assert.equal(normalized.stats[0].today.inputTokens, 10);
  assert.equal(normalized.stats[0].today.cacheReadTokens, 8);
  assert.equal(normalized.stats[0].cacheReadTokens, 6);
  assert.equal(catalog.formatUsageWindow(normalized.stats[0].today), '新:2/缓读:8/缓写:0/出:2');
  assert.equal(catalog.formatUsageCumulative(normalized.stats[0]), '新 2 / 缓读 6 / 缓写 0 / 未分 2');
  assert.equal(catalog.formatUsageWindow({ inputTokens: 1200, outputTokens: 4 }), '入(含缓存):1.2K/出:4');
});

test('provider-in-use references become bounded display data', () => {
  const data = catalog.deleteReferenceDisplayData({
    details: {
      references: [
        { kind: 'main', sessionId: 's1', sessionName: 'Main chat', token: 'drop' },
        { kind: 'subagent', sessionId: 's2', sessionName: '' },
        { kind: 'default', cli: 'claude' },
        { kind: 'aux', protocol: 'openai' },
        { kind: 'unknown', value: 'drop' },
      ],
    },
  });

  assert.equal(data.count, 4);
  assert.deepEqual(data.kinds, ['main', 'subagent', 'default', 'aux']);
  assert.deepEqual(data.items[0], { kind: 'main', title: 'Main chat', detail: 's1' });
  assert.deepEqual(data.items[1], { kind: 'subagent', title: 's2', detail: 's2' });
  assert.deepEqual(data.items[2], { kind: 'default', title: 'claude', detail: '' });
  assert.deepEqual(data.items[3], { kind: 'aux', title: 'openai', detail: '' });
  assert.equal(data.forceable, false);
});

test('delete reference display keeps Auto candidates, detach failures and the force capability', () => {
  const data = catalog.deleteReferenceDisplayData({
    forceable: true,
    references: [
      { kind: 'auto_candidate', sessionId: 's3', sessionName: 'Auto chat' },
      { kind: 'session', sessionId: 's4', sessionName: 'Busy', error: 'invalid provider' },
    ],
  });
  assert.equal(data.count, 2);
  assert.equal(data.forceable, true);
  assert.deepEqual(data.items[0], { kind: 'auto_candidate', title: 'Auto chat', detail: 's3' });
  assert.deepEqual(data.items[1], { kind: 'session', title: 'Busy', detail: 's4', error: 'invalid provider' });
});

test('Air loads the classic auth/API/catalog scripts in order and provider calls use the shared client', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'air.html'), 'utf8');
  const air = fs.readFileSync(path.join(ROOT, 'public', 'air-provider.js'), 'utf8');
  const auth = html.indexOf('<script src="auth-client.js"></script>');
  const providers = html.indexOf('<script src="provider-catalog.js"></script>');
  const panel = html.indexOf('<script src="air-provider.js"></script>');

  assert.ok(auth > 0 && auth < providers && providers < panel);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+(?:api-client|provider-catalog)/i);
  assert.match(air, /root\.MultiCCProviderCatalog/);
  assert.match(air, /catalogApi\.normalizeCatalog\(await context\.api\('\/api\/providers'\)\)/);
  assert.match(air, /catalogApi\.deleteReferenceDisplayData/);
  assert.doesNotMatch(air, /fetch\([^)]*[`'"]\/api\/providers/);
  assert.doesNotMatch(air, /fetch\([^)]*[`'"]\/api\/provider-defaults/);
  assert.doesNotMatch(air, /\/api\/providers[^\n]+tokenQS/);
});

test('quotaKindForProvider routes providers to the matching quota route', () => {
  const kind = (baseUrl, extra) => catalog.quotaKindForProvider(Object.assign({ baseUrl, appType: 'claude' }, extra || {}));
  assert.equal(kind('https://ark.cn-beijing.volces.com/api/v3'), 'ark');
  assert.equal(kind('https://api.z.ai/api/paas/v4'), 'zhipu');
  assert.equal(kind('https://open.bigmodel.cn/api/paas/v4'), 'zhipu');
  assert.equal(kind('https://api.moonshot.cn/v1'), 'kimi');
  assert.equal(kind('https://api.kimi.com/v1'), 'kimi');
  assert.equal(kind('https://qoder.com.cn'), 'qoder');
  assert.equal(kind('https://opencode.ai'), 'opencode');
  assert.equal(kind('', { appType: 'codex', isOfficial: true }), 'codex');
  assert.equal(kind('https://api.chatgpt.com/v1', { appType: 'codex' }), 'codex');
  assert.equal(kind('https://api.deepseek.com/anthropic'), null);
  assert.equal(kind('not a url'), null);
  assert.equal(catalog.quotaKindForProvider(null), null);
  // Aliyun Bailian: official gateway host…
  assert.equal(kind('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic'), 'aliyun');
  // …explicit quotaKind override beats an unrecognizable proxy host…
  assert.equal(kind('https://my-relay.example.com/v1', { quotaKind: 'ark' }), 'ark');
  // …'none' disables the badge entirely…
  assert.equal(kind('https://ark.cn-beijing.volces.com/api/v3', { quotaKind: 'none' }), null);
  // …unknown/invalid kinds fall through to the normal rules…
  assert.equal(kind('https://ark.cn-beijing.volces.com/api/v3', { quotaKind: 'bogus' }), 'ark');
  // …and the vendor NAME is the last-resort classifier for relay-hosted providers.
  assert.equal(kind('https://relay.internal:8080', { name: '火山Codingplan' }), 'ark');
  assert.equal(kind('https://relay.internal:8080', { name: '阿里云token plan' }), 'aliyun');
  assert.equal(kind('https://relay.internal:8080', { name: '百炼 DashScope 中转' }), 'aliyun');
  assert.equal(kind('https://relay.internal:8080', { name: '随便一个中转' }), null);
});

test('formatProviderQuotaBadge renders the aliyun console scrape through the unified window template', () => {
  const now = Date.now();
  const view = catalog.formatProviderQuotaBadge('aliyun', {
    status: 'ok',
    source: 'console-page',
    summary: [
      { window: '1m', label: '总额度', usedPercent: 12.5, percent: 12.5, resetMs: now + 28 * 86400000 + 3660000 },
      { window: '1m', label: '本月用量', usedPercent: 80, percent: 80, resetMs: now + 28 * 86400000 + 3660000 },
    ],
    text: '…',
  });
  // Standard tokens + REMAINING percent + countdown — same template as the bar.
  assert.match(view.text, /1m 88% 28d 1h/);
  assert.match(view.text, /1m 20% 28d 1h/);
  assert.equal(view.color, '#d29922');
  const unparseable = catalog.formatProviderQuotaBadge('aliyun', { status: 'ok', summary: null, text: 'oops' });
  assert.match(unparseable.text, /已抓取页面/);
});

test('formatProviderQuotaBadge renders kimi subscription scrapes with tokens and tolerates the old cache shape', () => {
  const now = Date.now();
  const unified = catalog.formatProviderQuotaBadge('kimi', {
    status: 'ok',
    source: 'subscription-page',
    summary: [
      { window: '1m', label: '总使用量', usedPercent: 29.1, percent: 29.1, resetMs: now + 15 * 86400000 + 3660000 },
      { window: '5h', label: '5 小时用量', usedPercent: 1.31, percent: 1.31, resetMs: now + 5 * 3600000 + 120000 },
      { window: '1wk', label: '7 天用量', usedPercent: 4.59, percent: 4.59, resetMs: now + 6 * 86400000 + 3660000 },
    ],
    text: '…',
  });
  assert.match(unified.text, /1m 71% 15d 1h/);
  assert.match(unified.text, /5h 99% 5h/);
  assert.match(unified.text, /1wk 95% 6d 1h/);
  assert.doesNotMatch(unified.text, /总使用量/, 'raw scraped labels must not surface when a token exists');

  // Pre-upgrade localStorage caches carry { label, percent } only — must render, not crash.
  const legacy = catalog.formatProviderQuotaBadge('kimi', {
    status: 'ok',
    source: 'subscription-page',
    summary: [{ label: '总使用量', percent: 29.1, line: '29.1%' }],
    text: '…',
  });
  assert.match(legacy.text, /总使用量 71%/);
  assert.doesNotMatch(legacy.text, /NaN|undefined/);
});

test('formatProviderQuotaBadge renders zhipu 5h + weekly periods', () => {
  const view = catalog.formatProviderQuotaBadge('zhipu', {
    status: 'ok',
    sites: [{ host: 'api.z.ai', site: 'Z.ai', ok: true, period: '5h', usedPercent: 12.3456, weeklyPeriod: 'weekly', weeklyUsedPercent: 40 }],
  });
  assert.match(view.text, /Z\.ai 5h 12\.35%/);
  assert.match(view.text, /周 40%/);
  assert.equal(view.color, '#58a6ff');
});

test('formatProviderQuotaBadge renders kimi money and codex weekly', () => {
  const kimi = catalog.formatProviderQuotaBadge('kimi', { status: 'ok', sites: [{ site: 'Kimi', ok: true, available: 49.589 }] });
  assert.match(kimi.text, /Kimi ¥49\.59/);
  const codex = catalog.formatProviderQuotaBadge('codex', { status: 'ok', weekly: { usedPercent: 91 }, planType: 'prolite' });
  assert.match(codex.text, /周 91% 已用/);
  assert.equal(codex.color, '#f85149');
});

test('formatProviderQuotaBadge renders ark worst period, qoder credits, opencode windows', () => {
  const ark = catalog.formatProviderQuotaBadge('ark', {
    status: 'ok',
    items: [{ product: 'Coding', subscribed: true, periods: [{ label: '5h', used: 10, total: 100, percent: 10 }, { label: '周', used: 95, total: 100, percent: 95 }] }],
  });
  assert.match(ark.text, /Coding 周 95\/100 \(95%\)/);
  assert.equal(ark.color, '#f85149');

  const qoder = catalog.formatProviderQuotaBadge('qoder', {
    status: 'ok',
    quota: { total_quota: { quota_summary: { used_value: 30, limit_value: 100, remaining_value: 70, usage_percentage: 30 } } },
  });
  assert.match(qoder.text, /70\/100 credits \(30%\)/);

  const opencode = catalog.formatProviderQuotaBadge('opencode', {
    status: 'ok',
    usage: { rolling: { usagePercent: 5 }, weekly: { usagePercent: 72 }, monthly: { usagePercent: 20 } },
  });
  assert.match(opencode.text, /5h 5%/);
  assert.match(opencode.text, /周 72%/);
  assert.match(opencode.text, /月 20%/);
  assert.equal(opencode.color, '#d29922');
});

test('formatProviderQuotaBadge renders ark percent-only periods without null/null', () => {
  // coding-plan periods (session/周/月) have no used/total — only a percent.
  const monthlyWorst = catalog.formatProviderQuotaBadge('ark', {
    status: 'ok',
    items: [{
      product: 'coding-plan',
      subscribed: true,
      periods: [
        { label: 'session', used: null, total: null, percent: 0 },
        { label: '周', used: null, total: null, percent: 26.85 },
        { label: '月', used: null, total: null, percent: 98.42 },
      ],
    }],
  });
  assert.ok(!monthlyWorst.text.includes('null'), `text must not contain null: ${monthlyWorst.text}`);
  assert.match(monthlyWorst.text, /coding-plan 月 98\.42%/);
  assert.equal(monthlyWorst.color, '#f85149');

  // An active coding session drives the session window to 100% — still no used/total.
  const sessionWorst = catalog.formatProviderQuotaBadge('ark', {
    status: 'ok',
    items: [{
      product: 'coding-plan',
      subscribed: true,
      periods: [{ label: 'session', used: null, total: null, percent: 100 }],
    }],
  });
  assert.ok(!sessionWorst.text.includes('null'), `text must not contain null: ${sessionWorst.text}`);
  assert.match(sessionWorst.text, /coding-plan 5h 100%/);
  assert.equal(sessionWorst.color, '#f85149');

  // percent 0 renders as 0%, not blank or 100%.
  const zero = catalog.formatProviderQuotaBadge('ark', {
    status: 'ok',
    items: [{ product: 'coding-plan', subscribed: true, periods: [{ label: 'session', used: null, total: null, percent: 0 }] }],
  });
  assert.match(zero.text, /5h 0%/);
  assert.equal(zero.color, '#58a6ff');
});

test('formatProviderQuotaBadge surfaces auth/config/unavailable fallbacks', () => {
  assert.match(catalog.formatProviderQuotaBadge('zhipu', { status: 'not_configured' }).text, /未配置/);
  assert.match(catalog.formatProviderQuotaBadge('ark', { status: 'needs_auth' }).text, /需登录/);
  assert.match(catalog.formatProviderQuotaBadge('ark', { status: 'needs_install' }).text, /未安装/);
  // The badge must not name a port: multicc manages its own headless Chrome
  // and discovers whatever port it picked, so no number belongs here.
  const noChrome = catalog.formatProviderQuotaBadge('qoder', { status: 'chrome_unavailable' });
  assert.match(noChrome.text, /浏览器不可用/);
  assert.match(noChrome.text, /点击重试/);
  assert.doesNotMatch(`${noChrome.text}\n${noChrome.title}`, /9222/);
  assert.match(catalog.formatProviderQuotaBadge('kimi', { status: 'unavailable' }).text, /暂不可用/);
  assert.equal(catalog.formatProviderQuotaBadge('kimi', null), null);
});

// 内置官方供应商的名字是服务端写进记录里的数据（'Codex 官方'），英文界面里的那两个字
// 不是前端字面量能解决的：老记录还带着 'Codex 官方 · <label>'，所以要在渲染时按身份翻。
// 这里锁住三件事：zh 原样、en 翻成英文、历史记录的后缀不动。
test('providerDisplayName keeps the official identity translatable', () => {
  const codexBuiltin = { id: 'codex-official', appType: 'codex', builtinOfficial: true, name: 'Codex 官方' };
  const claudeBuiltin = { id: 'claude-official', appType: 'claude', name: 'Claude 官方' };

  // zh 是回落路径（没有 window.t），必须与改动前逐字一致，否则中文界面会被改坏。
  assert.equal(catalog.providerDisplayName(codexBuiltin), 'Codex 官方');
  assert.equal(catalog.providerDisplayName(claudeBuiltin), 'Claude 官方');

  // 认身份的四个信号：id、builtinOfficial、裸名字串、老记录的前缀 + 后缀。
  assert.equal(catalog.officialProviderKind(codexBuiltin), 'codex');
  assert.equal(catalog.officialProviderKind({ id: 'x', appType: 'claude', builtinOfficial: true, name: '随便' }), 'claude');
  assert.equal(catalog.officialProviderKind('Claude 官方'), 'claude');
  assert.equal(catalog.officialProviderKind('Codex 官方 · ab12cd'), 'codex');

  // 老记录（src/routes/*-accounts.js 建的）只换前缀，账号别名/后缀原样留着。
  assert.equal(catalog.providerDisplayName({ id: 'p1', appType: 'codex', name: 'Codex 官方 · ab12cd' }),
    'Codex 官方 · ab12cd');
  assert.equal(catalog.providerDisplayName('Claude 官方 · 工作号'), 'Claude 官方 · 工作号');

  // 普通供应商一个字符都不动。
  assert.equal(catalog.providerDisplayName({ id: 'p2', appType: 'codex', name: 'Lab Responses' }), 'Lab Responses');
  assert.equal(catalog.providerDisplayName('Codex 官方山寨'), 'Codex 官方山寨');
  assert.equal(catalog.providerDisplayName(''), '');
  assert.equal(catalog.providerDisplayName(null), '');
  assert.equal(catalog.officialProviderKind({ id: 'gpt', appType: 'codex', name: 'Responses' }), '');

  // normalizeProvider 会丢掉 builtinOfficial、isOfficial 对内置记录也是 false，
  // 所以 id 才是归一化后唯一还在的身份信号——这条断了英文界面就会漏中文。
  const normalized = catalog.normalizeProvider({ ...codexBuiltin, source: 'builtin' });
  assert.equal(normalized.builtinOfficial, undefined);
  assert.equal(catalog.providerDisplayName(normalized), 'Codex 官方');
  assert.equal(catalog.officialProviderKind(normalized), 'codex');
});

test('providerDisplayName translates the builtin identity in English', () => {
  // t() 就是 i18n.js 那个：这里用最小替身把 en 词典装到 window 上，模拟英文界面。
  const previous = global.window;
  global.window = {
    t(key) {
      const en = {
        providerOfficialCodex: 'Codex Official',
        providerOfficialClaude: 'Claude Official',
      };
      return en[key] || key;
    },
  };
  try {
    assert.equal(catalog.providerDisplayName({ id: 'codex-official', appType: 'codex', name: 'Codex 官方' }),
      'Codex Official');
    assert.equal(catalog.providerDisplayName({ id: 'claude-official', appType: 'claude', name: 'Claude 官方' }),
      'Claude Official');
    // 历史记录：前缀翻，后缀（用户别名）留着。
    assert.equal(catalog.providerDisplayName({ id: 'p1', appType: 'codex', name: 'Codex 官方 · ab12cd' }),
      'Codex Official · ab12cd');
    assert.equal(catalog.providerDisplayName('Codex 官方'), 'Codex Official');
    // 普通供应商不受影响，也不该被翻译。
    assert.equal(catalog.providerDisplayName({ id: 'p2', appType: 'codex', name: 'Lab Responses' }), 'Lab Responses');
  } finally {
    if (previous === undefined) delete global.window; else global.window = previous;
  }
});
