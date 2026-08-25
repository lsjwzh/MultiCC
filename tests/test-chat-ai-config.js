'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ai = require('../public/chat-ai-config');
const providerCatalog = require('../public/provider-catalog');

const ROOT = path.join(__dirname, '..');
const CLAUDE_MODELS = [
  { value: '', label: 'Default' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: '__custom__', label: 'Custom' },
];

function state(overrides = {}) {
  return {
    cli: 'claude',
    providers: [{
      id: 'relay',
      appType: 'claude',
      name: 'Relay',
      model: 'glm-5.2[1M]',
      modelOptions: ['glm-5.2[1M]', 'glm-4.7'],
      aliasMap: {
        opus: { model: 'glm-5.2', name: 'GLM 5.2' },
        sonnet: { model: 'glm-4.7', name: 'GLM 4.7' },
      },
    }],
    defaults: { claude: 'relay', codex: null },
    claudeModelOptions: CLAUDE_MODELS,
    translate: key => ({ default: 'Default', custom: 'Custom' }[key] || key),
    modelShortName: model => `short:${model}`,
    aliasTiersFromMap: map => ['opus', 'sonnet', 'haiku', 'fable']
      .filter(tier => map && map[tier] && map[tier].model)
      .map(tier => [tier, map[tier]]),
    formatAliasTierLabel: (tier, entry) => `${tier} · ${entry.name} · ${entry.model}`,
    ...overrides,
  };
}

test('effort policy is deterministic for every supported CLI', () => {
  assert.equal(ai.defaultEffort('claude'), 'medium');
  assert.equal(ai.defaultEffort('codex'), 'xhigh');
  assert.equal(ai.defaultEffort('opencode'), '');
  assert.equal(ai.effortLabel('codex'), 'Reasoning Level');
  assert.equal(ai.effortLabel('opencode'), 'Variant');
  assert.deepEqual(ai.effortOptions('codex').map(item => item.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(ai.effortShortName('codex', 'xhigh'), 'Extra high');
  assert.equal(ai.effortShortName('opencode', 'high'), 'Variant high');
  assert.equal(ai.effortShortName('zcode', 'high'), '');
  assert.equal(ai.defaultEffort('qoder'), '');
  assert.equal(ai.effortLabel('qoder'), 'Reasoning Effort');
  assert.equal(ai.effortShortName('qoder', 'xhigh'), 'Extra high');
  assert.deepEqual(ai.effortOptions('qoder').map(item => item.value),
    ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(ai.effortOptions('claude').map(item => item.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
});

test('provider defaults, alias tiers and concrete model choices keep old picker semantics', () => {
  const s = state();
  assert.equal(ai.effectiveProviderId('', s), 'relay');
  assert.deepEqual(ai.providerAliasTiers('', s).map(([tier]) => tier), ['opus', 'sonnet']);
  assert.equal(ai.normalizeModel('', 'glm-5.2', s), 'opus');
  assert.deepEqual(ai.buildModelChoices('', s), ['opus', 'sonnet', '__custom__']);
  assert.equal(ai.defaultModelChoice('', s), 'opus');
  assert.equal(ai.modelChoiceLabel('opus', '', s), 'opus · GLM 5.2 · glm-5.2');
  assert.equal(ai.modelDisplayName('opus', '', s), 'GLM 5.2');
  assert.equal(ai.modelDisplayName('glm-4.7', '', s), 'GLM 4.7');
});

test('plain provider models and CLI fallback choices never retain a stale provider model', () => {
  const plain = state({
    providers: [{
      id: 'plain', appType: 'claude', name: 'Plain', model: 'p-main',
      modelOptions: ['p-main', 'p-fast'], aliasMap: {},
    }],
    defaults: { claude: 'plain', codex: null },
  });
  assert.deepEqual(ai.buildModelChoices('', plain), ['p-main', 'p-fast', '__custom__']);
  assert.equal(ai.defaultModelChoice('', plain), 'p-main');

  const noProvider = state({ providers: [], defaults: {}, cli: 'claude' });
  assert.deepEqual(ai.buildModelChoices('', noProvider), ['', 'claude-opus-4-8', '__custom__']);
  const codex = state({ providers: [], defaults: {}, cli: 'codex' });
  assert.deepEqual(ai.buildModelChoices('', codex), ['', '__custom__']);

  const qoder = state({ providers: [], defaults: {}, cli: 'qoder' });
  assert.deepEqual(ai.buildModelChoices('', qoder),
    ['', 'auto', 'ultimate', 'performance', 'efficient', 'lite', '__custom__']);
  assert.equal(ai.modelChoiceLabel('', '', qoder), '默认（跟随 Qoder CN 设置）');
  assert.equal(ai.modelChoiceLabel('performance', '', qoder), 'Performance（性能）');

  const zcode = state({ providers: [], defaults: {}, cli: 'zcode' });
  assert.deepEqual(ai.buildModelChoices('', zcode), ['', '__custom__']);
  assert.equal(ai.modelChoiceLabel('', '', zcode), '默认（跟随 ZCode 设置）');

  const zcodeProvider = state({
    cli: 'zcode',
    defaults: {},
    providers: [{
      id: 'zai', appType: 'claude', name: 'Z.ai', model: 'glm-5.2',
      modelOptions: ['glm-5.2', 'glm-5-turbo'],
      aliasMap: { sonnet: { model: 'glm-5.2', name: 'GLM' } },
    }],
  });
  assert.deepEqual(ai.buildModelChoices('zai', zcodeProvider),
    ['glm-5.2', 'glm-5-turbo', '__custom__']);
  assert.equal(ai.defaultModelChoice('zai', zcodeProvider), 'glm-5.2');
});

test('Qoder stays vendor-managed while ZCode exposes MultiCC providers', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'chat-ai-config.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  assert.match(source, /const supportsProvider = cli !== 'qoder'/);
  assert.match(source, /ZCode 原生 \/ Coding Plan/);
  assert.match(page, /if \(_sessionCli !== 'qoder'\)/);
  assert.doesNotMatch(page, /_sessionCli !== 'qoder' && _sessionCli !== 'zcode'/);
});

test('Auto Provider picker exposes protocol pools, ordered candidates and the persisted contract', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'chat-ai-config.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  assert.equal(ai.autoOptionValue('anthropic'), '__auto__:anthropic');
  assert.equal(ai.autoProtocolFromValue('__auto__:openai_responses'), 'openai_responses');
  assert.equal(ai.autoProtocolLabel('openai_chat'), 'OpenAI Chat Completions');
  assert.match(source, /id="ai-auto-section"/);
  assert.match(source, /className = 'auto-candidate-priority'/);
  assert.match(source, /mode: 'auto', protocol, candidates/);
  assert.match(source, /allowCrossTrust: false/);
  assert.match(page, /providerSelection: picked\.providerSelection/);
  assert.match(page, /Auto · \$\{window\.MultiCCChatAiConfig\.autoProtocolLabel/);
  assert.match(page, /actualProvider \|\| '待路由'/,
    'Auto must not claim its configured primary before a physical attempt begins');
  assert.match(page, /\? _activeProviderId : _sessionProvider/,
    'the quota bar must follow the physical Auto route after failover');
});

test('provider and session transport use MultiCCApi with token-free relative URLs', async () => {
  const calls = [];
  const api = {
    async json(url, options) {
      calls.push({ url, options });
      if (url.startsWith('/api/providers')) {
        return {
          defaults: { claude: 'safe', codex: null },
          providers: [{
            id: 'safe', appType: 'claude', name: 'Safe', model: 'm1',
            authToken: 'must-drop', modelOptions: ['m1'],
          }],
        };
      }
      if (options && options.method === 'PATCH') return { model: 'm2' };
      return { id: 's/1', model: 'm1' };
    },
  };

  const loaded = await ai.loadProviderList('claude', { api, providerCatalog });
  assert.deepEqual(loaded.providers.map(item => item.id), ['safe']);
  assert.equal(loaded.providers[0].authToken, undefined);
  assert.deepEqual(loaded.defaults, { claude: 'safe', codex: null });
  assert.equal(calls[0].url, '/api/providers?cli=claude');

  const session = await ai.loadSession('s/1', { api });
  assert.equal(session.model, 'm1');
  const saved = await ai.saveSession('s/1', { model: 'm2' }, { api });
  assert.equal(saved.model, 'm2');
  assert.deepEqual(calls.slice(1), [
    { url: '/api/sessions/s%2F1', options: undefined },
    { url: '/api/sessions/s%2F1', options: { method: 'PATCH', json: { model: 'm2' } } },
  ]);
  assert.equal(JSON.stringify(calls).includes('token='), false);
});

test('ZCode first-open setup check is native-only and once per session', async () => {
  const calls = [];
  const api = {
    async json(url) {
      calls.push(url);
      return { ok: true };
    },
  };
  const loadProviders = async () => {
    calls.push('providers');
    return [];
  };
  assert.equal(await ai.maybePromptZcodeSetup({
    cli: 'zcode', provider: 'managed', sessionId: 'z-managed', api, loadProviders,
  }), null);
  assert.equal(await ai.maybePromptZcodeSetup({
    cli: 'zcode', provider: '', sessionId: 'z-native', api, loadProviders,
  }), null);
  assert.equal(await ai.maybePromptZcodeSetup({
    cli: 'zcode', provider: '', sessionId: 'z-native', api, loadProviders,
  }), null);
  assert.deepEqual(calls, ['providers', '/api/zcode/auth/check']);
});

test('chat page loads the classic config boundary before chat.js and chat delegates the domain', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  const boundary = fs.readFileSync(path.join(ROOT, 'public', 'chat-ai-config.js'), 'utf8');
  const auth = html.indexOf('<script src="auth-client.js"></script>');
  const apiClient = html.indexOf('<script src="api-client.js"></script>');
  const catalog = html.indexOf('<script src="provider-catalog.js"></script>');
  const config = html.indexOf('<script src="chat-ai-config.js"></script>');
  const page = html.indexOf('<script src="chat.js"></script>');

  assert.ok(auth > 0 && auth < apiClient && apiClient < catalog && catalog < config && config < page);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+chat-ai-config/i);
  assert.match(chat, /MultiCCChatAiConfig\.showAIConfigPicker/);
  assert.match(chat, /MultiCCChatAiConfig\.loadProviderList/);
  assert.match(chat, /MultiCCChatAiConfig\.saveSession/);
  assert.doesNotMatch(chat, /fetch\([^\n]*\/api\/providers/);
  assert.doesNotMatch(boundary, /(?:token|access_token)=/);
  assert.doesNotMatch(chat, /id="ai-provider"/);
});



test("providerLimitLabel renders the cached limit summary and freshness states", () => {
  const now = 1_000_000;
  const tr = (key, params) => {
    if (key === "limitUpdatedAgo") return `更新于 ${params.ago}`;
    if (key === "limitFetchFailed") return "查询失败";
    if (key === "limitStale") return "过期";
    return key;
  };
  // no cache entry → clean absence, option reads exactly as before
  assert.equal(ai.providerLimitLabel(null, tr, now), "");
  assert.equal(ai.providerLimitLabel({}, tr, now), "");
  assert.equal(ai.providerLimitLabel({ limit: null }, tr, now), "");
  // summary only
  assert.equal(ai.providerLimitLabel({ limit: { summaryText: "5h 80%" } }, tr, now), " · 5h 80%");
  // stale entry without a summary is indistinguishable from no-data (nothing to age)
  assert.equal(ai.providerLimitLabel({ limit: { stale: true } }, tr, now), "");
  // fresh summary + fetchedAt → updated time (20s ago → "20s 前")
  assert.equal(
    ai.providerLimitLabel({ limit: { summaryText: "5h 80%", fetchedAt: now - 20_000, stale: false } }, tr, now),
    " · 5h 80% · 更新于 20s 前",
  );
  // last fetch failed → failure marker keeps the cached summary but drops the age
  assert.equal(
    ai.providerLimitLabel({ limit: { summaryText: "5h 80%", fetchedAt: now - 20_000, lastError: "boom" } }, tr, now),
    " · 5h 80% · 查询失败",
  );
  // stale marker rides on a summary and shows alongside the age
  assert.equal(
    ai.providerLimitLabel({ limit: { summaryText: "5h 80%", fetchedAt: now - 20_000, stale: true } }, tr, now),
    " · 5h 80% · 更新于 20s 前 · 过期",
  );
  // failure without any cached summary still says so
  assert.equal(ai.providerLimitLabel({ limit: { lastError: "boom" } }, tr, now), " · 查询失败");
  // translator params reach the resolved ago string
  const trEn = (key, params) => key === "limitUpdatedAgo" ? `updated ${params.ago}` : key;
  assert.equal(
    ai.providerLimitLabel({ limit: { summaryText: "5h 80%", fetchedAt: now - 20_000 } }, trEn, now),
    " · 5h 80% · updated 20s 前",
  );
});

test("provider catalog preserves the normalized limit projection", () => {
  const p = providerCatalog.normalizeProvider({
    id: "relay", appType: "claude", name: "Relay", baseUrl: "https://relay.example.com/v1",
    limit: {
      kind: "window", status: "ok", summaryText: "5h 80%", fetchedAt: 123_456,
      updatedAt: 123_457, lastError: null, lastErrorAt: null, stale: false,
      summary: { provider: "glm" }, barText: "5h 80% {cd:12345}",
    },
  });
  assert.deepEqual(p.limit, {
    kind: "window", status: "ok", summaryText: "5h 80%", fetchedAt: 123_456,
    updatedAt: 123_457, lastError: null, lastErrorAt: null, stale: false,
  });
  // no limit → null, never a frozen shell
  assert.equal(providerCatalog.normalizeProvider({ id: "r2", appType: "codex", name: "R2" }).limit, null);

  const cat = providerCatalog.normalizeCatalog({ providers: [], limitCacheStaleMs: 600_000 });
  assert.equal(cat.limitCacheStaleMs, 600_000);
  assert.equal(providerCatalog.normalizeCatalog({ providers: [] }).limitCacheStaleMs, null);
});
