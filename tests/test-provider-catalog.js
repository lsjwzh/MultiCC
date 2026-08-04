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
  assert.deepEqual(provider.compatibleClis, ['claude', 'opencode', 'zcode']);
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
  assert.deepEqual(oauthOnly.compatibleClis, ['codex', 'opencode'],
    'ZCode cannot replay another CLI OAuth subscription');

  const hostileOAuthDto = catalog.normalizeProvider({
    id: 'codex-oauth-hostile',
    appType: 'codex',
    name: 'Codex OAuth',
    apiFormat: 'openai_responses',
    baseUrl: '',
    hasToken: false,
    compatibleClis: ['codex', 'opencode', 'zcode'],
  });
  assert.deepEqual(hostileOAuthDto.compatibleClis, ['codex', 'opencode'],
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
});

test('manage loads classic auth/API/catalog scripts in order and provider calls use the shared client', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'manage.html'), 'utf8');
  const manage = fs.readFileSync(path.join(ROOT, 'public', 'manage.js'), 'utf8');
  const headEnd = html.indexOf('</head>');
  const auth = html.indexOf('<script src="auth-client.js"></script>');
  const api = html.indexOf('<script src="api-client.js"></script>');
  const providers = html.indexOf('<script src="provider-catalog.js"></script>');
  const page = html.indexOf('<script src="manage.js"></script>');

  assert.ok(auth > 0 && auth < api && api < providers && providers < headEnd);
  assert.ok(providers < page);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+(?:api-client|provider-catalog)/i);
  assert.match(manage, /providerApi\.json\('\/api\/providers'/);
  assert.match(manage, /providerCatalog\.normalizeCatalog/);
  assert.match(manage, /providerCatalog\.groupByAppType/);
  assert.match(manage, /providerCatalog\.deleteReferenceDisplayData/);
  assert.doesNotMatch(manage, /fetch\([^)]*[`'"]\/api\/providers/);
  assert.doesNotMatch(manage, /fetch\([^)]*[`'"]\/api\/provider-defaults/);
  assert.doesNotMatch(manage, /\/api\/providers[^\n]+tokenQS/);
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

test('formatProviderQuotaBadge renders the aliyun console scrape as percent windows', () => {
  const view = catalog.formatProviderQuotaBadge('aliyun', {
    status: 'ok',
    source: 'console-page',
    summary: [{ label: '总额度', percent: 12.5 }, { label: '本月', percent: 80 }],
    text: '…',
  });
  assert.match(view.text, /总额度 12\.5%/);
  assert.match(view.text, /本月 80%/);
  assert.equal(view.color, '#d29922');
  const unparseable = catalog.formatProviderQuotaBadge('aliyun', { status: 'ok', summary: null, text: 'oops' });
  assert.match(unparseable.text, /已抓取页面/);
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
  assert.match(sessionWorst.text, /coding-plan session 100%/);
  assert.equal(sessionWorst.color, '#f85149');

  // percent 0 renders as 0%, not blank or 100%.
  const zero = catalog.formatProviderQuotaBadge('ark', {
    status: 'ok',
    items: [{ product: 'coding-plan', subscribed: true, periods: [{ label: 'session', used: null, total: null, percent: 0 }] }],
  });
  assert.match(zero.text, /session 0%/);
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
