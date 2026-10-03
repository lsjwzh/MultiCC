'use strict';

// Shared browser/CommonJS boundary for the Auto Provider candidate policy and
// editor. Chat embeds it inside the AI-config modal; other surfaces can mount
// the same editor without importing Chat's model/effort/session concerns.
(function initAutoProviderEditor(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCAutoProviderEditor = api;
})(typeof window !== 'undefined' ? window : null, function createAutoProviderEditorApi() {
  const PROTOCOLS = Object.freeze(['anthropic', 'openai_responses']);
  const PROTOCOL_SET = new Set(PROTOCOLS);
  const MAX_CANDIDATES = 12;
  const MAX_ATTEMPTS = 4;
  const MAX_TIERS = 6;
  const AUTO_PREFIX = '__auto__:';
  const STYLE_ID = 'multicc-auto-provider-editor-style';
  // A candidate may name the CLI lane that serves it; the pool is then
  // cross-CLI, and the session switches lanes when the pool picks a line on
  // another one. Mirrors AUTO_CLIS in src/providers/auto-provider-config.js, so
  // the editor offers exactly the lanes the server accepts.
  const AUTO_CLIS = Object.freeze(['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'zcode', 'kimi']);
  const AUTO_CLI_SET = new Set(AUTO_CLIS);
  // When a cross-CLI pool leaves the session's current lane:
  //   failover — only when no line on the current CLI is usable (the default),
  //   routing  — whenever the per-turn pick lives on another CLI.
  // Mirrors CLI_SWITCH_POLICIES.
  const CLI_SWITCH_POLICIES = Object.freeze(['failover', 'routing']);
  const DEFAULT_CLI_SWITCH = 'failover';
  // How a routed pool's tiers are decided: hand-tagged candidates (`manual`) or
  // the shared price table, recomputed per turn (`price`). Mirrors
  // ROUTING_TIERINGS — an `autoModel` line is allowed under either one, because
  // what it needs is a router to pick the model, not specifically a price list.
  const DEFAULT_ROUTING_TIERING = 'manual';
  const PRICE_TIERING = 'price';
  // 候选池预设：每次新建 Auto Provider 都要重新勾一遍候选、调一遍优先级太费事，
  // 所以可以把配好的池子存成具名预设，也会自动记住最近真正用过的几份。存在浏览器
  // localStorage 里 —— 同源的 chat 弹窗、manage 任务板、Air 任务配置共用一份。
  const PRESET_KEY = 'multicc.autoProvider.presets.v1';
  const MAX_NAMED_PRESETS = 20;
  const MAX_RECENT_PRESETS = 5;
  // Difficulty routing talks to Jev through a gateway; the key lives in the
  // local vault under that gateway's own entry name and never reaches the
  // browser.
  const ROUTING_PROVIDER = 'jev';
  // Which gateway the evaluation goes to. Mirrors JEV_GATEWAYS in
  // src/providers/jev-client.js (endpoints, default models) and the per-gateway
  // key defaults in auto-provider-config.js — the editor only needs the entry
  // name and the copy, because the endpoint is the server's business.
  const ROUTING_GATEWAYS = Object.freeze(['vercel', 'openrouter', 'typesafe', 'custom']);
  const DEFAULT_ROUTING_GATEWAY = 'vercel';
  const CUSTOM_ROUTING_GATEWAY = 'custom';
  // What a custom endpoint's model defaults to, and the longest address the
  // server accepts — both mirrored from auto-provider-config.js.
  const CUSTOM_ROUTING_MODEL = 'jev-latest';
  const MAX_ROUTING_ENDPOINT_CHARS = 300;
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const ROUTING_GATEWAY_INFO = Object.freeze({
    vercel: Object.freeze({
      keyName: 'vercel-api-key',
      labelKey: 'autoEditorJevGatewayVercel', label: 'Vercel',
      stepKey: 'autoEditorJevStepCreateVercel',
      step: '打开 Vercel 控制台 → AI Gateway → API Keys，新建一个 key',
      placeholderKey: 'autoEditorJevKeyPlaceholderVercel',
      placeholder: '粘贴 key（vck_ 开头）',
    }),
    openrouter: Object.freeze({
      keyName: 'openrouter-api-key',
      labelKey: 'autoEditorJevGatewayOpenRouter', label: 'OpenRouter',
      stepKey: 'autoEditorJevStepCreateOpenRouter',
      step: '打开 openrouter.ai/keys，新建一个 key',
      placeholderKey: 'autoEditorJevKeyPlaceholderOpenRouter',
      placeholder: '粘贴 key（sk-or- 开头）',
    }),
    typesafe: Object.freeze({
      keyName: 'typesafe-api-key',
      labelKey: 'autoEditorJevGatewayTypeSafe', label: 'TypeSafe',
      stepKey: 'autoEditorJevStepCreateTypeSafe',
      step: '打开 TypeSafe 控制台，新建一个 API key',
      placeholderKey: 'autoEditorJevKeyPlaceholderTypeSafe',
      placeholder: '粘贴 key',
    }),
    custom: Object.freeze({
      keyName: 'jev-custom-api-key',
      labelKey: 'autoEditorJevGatewayCustom', label: '自定义',
      stepKey: 'autoEditorJevStepCreateCustom',
      step: '填好接口地址和模型名，再粘贴它的 key',
      placeholderKey: 'autoEditorJevKeyPlaceholderCustom',
      placeholder: '粘贴 key',
    }),
  });
  // The vault entry a routed pool used before it could pick a gateway — still the
  // Vercel default, and the contract the server calls DEFAULT_ROUTING_API_KEY.
  const ROUTING_API_KEY_NAME = ROUTING_GATEWAY_INFO.vercel.keyName;
  // The vault description is stored data (the Secrets panel shows it), not UI
  // copy, so it is one neutral sentence per gateway rather than a translated one.
  const ROUTING_GATEWAY_DESCRIPTIONS = Object.freeze({
    vercel: 'Vercel AI Gateway（Jev 难度路由）',
    openrouter: 'OpenRouter（Jev 难度路由）',
    typesafe: 'TypeSafe（Jev 难度路由）',
    custom: '自定义网关（Jev 难度路由）',
  });

  // 文案走页面上的全局 t()（i18n.js）：这个编辑器同时挂在 chat 的 AI 配置弹窗、
  // manage 任务板和 Air 的任务配置里，语言得跟着页面走。没有 t()（Node 单测、
  // CommonJS 复用）就回落到中文默认值 —— 那些断言正是按中文写的。
  function tt(key, fallback, params) {
    const scope = typeof window !== 'undefined' ? window : null;
    const out = scope && typeof scope.t === 'function' ? scope.t(key, params) : '';
    if (out && out !== key) return out;
    return Object.keys(params || {}).reduce((text, name) => (
      text.split(`{${name}}`).join(String(params[name]))
    ), fallback);
  }

  function routingGatewayOf(value) {
    const gateway = String(value == null ? '' : value).trim();
    return ROUTING_GATEWAYS.includes(gateway) ? gateway : DEFAULT_ROUTING_GATEWAY;
  }

  function routingGatewayInfo(gateway) {
    return ROUTING_GATEWAY_INFO[routingGatewayOf(gateway)];
  }

  // Display copy for a gateway name — the brand in its own script, 自定义 in the
  // page's language.
  function routingGatewayLabel(gateway) {
    const info = routingGatewayInfo(gateway);
    return tt(info.labelKey, info.label);
  }

  // The vault description the host writes when it stores this gateway's key.
  function routingGatewayDescription(gateway) {
    return ROUTING_GATEWAY_DESCRIPTIONS[routingGatewayOf(gateway)] || ROUTING_GATEWAY_DESCRIPTIONS.vercel;
  }

  // Custom endpoint rule, mirrored from auto-provider-config.js so the reason is
  // visible while the address is typed. The server re-checks it on every save,
  // and this copy must never be the weaker one: https, or http only to a
  // loopback host, no credentials in the URL, and a bounded length.
  function customEndpointError(raw) {
    const endpoint = String(raw == null ? '' : raw).trim();
    if (!endpoint) return tt('autoEditorJevEndpointRequired', '填上自定义网关的接口地址。');
    if (endpoint.length > MAX_ROUTING_ENDPOINT_CHARS) {
      return tt('autoEditorJevEndpointTooLong', '接口地址太长（最多 {max} 个字符）。',
        { max: MAX_ROUTING_ENDPOINT_CHARS });
    }
    let url = null;
    try {
      url = new URL(endpoint);
    } catch (_) {
      return tt('autoEditorJevEndpointInvalid', '接口地址要是一个完整的 URL，比如 https://…/v1/evaluate。');
    }
    if (url.username || url.password) {
      return tt('autoEditorJevEndpointCredentials', '接口地址里不要带用户名或密码。');
    }
    if (url.protocol === 'https:') return '';
    if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return '';
    return tt('autoEditorJevEndpointHttps', '接口地址必须是 https（只有本机地址可以用 http）。');
  }

  function protocolOf(provider) {
    // 'openai_chat' is a retired format value; providers still carrying it
    // belong to the openai_responses pool.
    const raw = provider && (provider.protocol || provider.apiFormat);
    const value = raw === 'openai_chat' ? 'openai_responses' : raw;
    return PROTOCOL_SET.has(value) ? value : null;
  }

  function protocolLabel(protocol) {
    return ({
      anthropic: 'Anthropic Messages',
      openai_responses: 'OpenAI Responses',
      openai_chat: 'OpenAI Responses',
    })[protocol] || String(protocol || '');
  }

  function optionValue(protocol) {
    return PROTOCOL_SET.has(protocol) ? `${AUTO_PREFIX}${protocol}` : '';
  }

  function protocolFromValue(value) {
    const text = String(value || '');
    if (!text.startsWith(AUTO_PREFIX)) return null;
    const protocol = text.slice(AUTO_PREFIX.length);
    return PROTOCOL_SET.has(protocol) ? protocol : null;
  }

  function providersForProtocol(providers, protocol) {
    if (!PROTOCOL_SET.has(protocol)) return [];
    return (Array.isArray(providers) ? providers : [])
      .filter(provider => provider && provider.id && protocolOf(provider) === protocol);
  }

  function availableProtocols(providers) {
    return PROTOCOLS.map(protocol => {
      const pool = providersForProtocol(providers, protocol);
      return Object.freeze({
        protocol,
        label: protocolLabel(protocol),
        count: pool.length,
        managedCount: pool.filter(provider => provider.isOfficial !== true).length,
      });
    }).filter(entry => entry.count >= 2);
  }

  // The pool's own lane, or '' when the host did not say which CLI the session
  // runs. An unknown lane is not a guess: every row then reads as "current CLI"
  // and no candidate carries a cli field, which is exactly what a stored
  // single-lane pool looks like.
  function normalizeCli(value) {
    const cli = String(value == null ? '' : value).trim();
    return AUTO_CLI_SET.has(cli) ? cli : '';
  }

  // Display name of a lane — the provider catalog owns the table (it carries
  // the per-CLI marks and translations), so the editor asks it rather than
  // restating seven names.
  function cliName(cli) {
    const scope = typeof window !== 'undefined' ? window : null;
    const catalog = scope && scope.MultiCCProviderCatalog;
    if (cli && catalog && typeof catalog.cliDisplayName === 'function') {
      const name = catalog.cliDisplayName(cli);
      if (name) return String(name);
    }
    return String(cli || '');
  }

  // What a row's CLI select shows for one lane; the empty value is the option
  // every pool starts on, which is why it is a sentence rather than a name.
  function cliOptionLabel(cli) {
    return cli ? cliName(cli) : tt('autoEditorCliCurrent', '当前 CLI');
  }

  function selectionCrossesTrust(candidates, providers) {
    const byId = new Map((Array.isArray(providers) ? providers : [])
      .filter(provider => provider && provider.id)
      .map(provider => [String(provider.id), provider]));
    const trustDomains = new Set((Array.isArray(candidates) ? candidates : [])
      .filter(candidate => candidate && candidate.enabled !== false)
      .map(candidate => byId.get(String(candidate.providerId || '')))
      .filter(Boolean)
      .map(provider => provider.isOfficial === true ? 'official' : 'user-managed'));
    return trustDomains.size > 1;
  }

  function candidateModel(provider, configured) {
    if (configured && Object.prototype.hasOwnProperty.call(configured, 'model')) {
      return configured.model ? String(configured.model) : null;
    }
    if (provider && provider.isOfficial === true) return null;
    return provider && provider.model ? String(provider.model) : null;
  }

  function candidateModelChoices(provider, configured, fallback = []) {
    const declared = [provider.model, ...(provider.modelOptions || []),
      ...Object.values(provider.aliasMap || {}).map(entry => entry && entry.model)]
      .filter(value => typeof value === 'string' && value.trim());
    return [...new Set(['', ...declared,
      ...(declared.length ? [] : fallback), candidateModel(provider, configured)])]
      .filter(value => typeof value === 'string' && value !== '__custom__');
  }

  // Empty catalogs (including older imported Claude relays) need the same
  // suggestions as the manual picker. These are local CLI suggestions, not a
  // claim about a remote account's entitlements. Never change the selected id.
  let claudeCatalog = [];
  let claudeCatalogAt = 0;
  let claudeCatalogRequest = null;
  async function loadCandidateModels(protocol) {
    if (protocol !== 'anthropic' || typeof window === 'undefined') return [];
    if (claudeCatalog.length && Date.now() - claudeCatalogAt < 3600000) return claudeCatalog;
    if (claudeCatalogRequest) return claudeCatalogRequest;
    claudeCatalogRequest = (async () => {
      try {
        const rows = typeof window.loadClaudeModels === 'function'
          ? await window.loadClaudeModels()
          : (await window.MultiCCApi?.json('/api/claude/models'))?.models;
        const ids = (Array.isArray(rows) ? rows : []).map(row => row.model).filter(Boolean);
        if (ids.length) { claudeCatalog = ids; claudeCatalogAt = Date.now(); }
      } catch (_) { /* Custom input remains available offline. */ }
      return claudeCatalog;
    })();
    try { return await claudeCatalogRequest; } finally { claudeCatalogRequest = null; }
  }

  // Another lane's provider catalog, over the same endpoint the host page uses
  // for the current CLI (/api/providers?cli=…). The page normalizes the payload
  // through the shared provider catalog when it is loaded, so a row built from
  // a lane here carries the same fields as a row built from the host's list;
  // without either the raw `providers` array is still usable, because the editor
  // only reads id/model/modelOptions/apiFormat off a provider.
  async function defaultCliProviderLoader(cli) {
    const scope = typeof window !== 'undefined' ? window : null;
    const api = scope && scope.MultiCCApi;
    if (!cli || !api || typeof api.json !== 'function') return [];
    const raw = await api.json(`/api/providers?cli=${encodeURIComponent(cli)}`);
    const catalog = scope.MultiCCProviderCatalog;
    if (catalog && typeof catalog.normalizeCatalog === 'function'
        && typeof catalog.providersForCli === 'function') {
      return catalog.providersForCli(catalog.normalizeCatalog(raw), cli);
    }
    return raw && Array.isArray(raw.providers) ? raw.providers : [];
  }

  function candidateForProvider(provider, priority, configured) {
    return {
      providerId: String(provider.id),
      model: candidateModel(provider, configured),
      priority,
      enabled: true,
    };
  }

  function defaultCandidates(providers, protocol) {
    return providersForProtocol(providers, protocol)
      .filter(provider => provider.isOfficial !== true)
      .slice(0, 2)
      .map((provider, index) => candidateForProvider(provider, index + 1, null));
  }

  // A new Auto pool is deliberately conservative: only the first two
  // user-managed providers are enabled. Official subscription routes are shown
  // by the editor, but entering a mixed trust-domain pool is always an explicit
  // user action followed by confirmation.
  function defaultSelection(providers, protocol) {
    const candidates = defaultCandidates(providers, protocol);
    if (candidates.length < 2) return null;
    return {
      version: 1,
      mode: 'auto',
      protocol,
      candidates,
      maxAttempts: 2,
      sticky: true,
      allowCrossTrust: false,
    };
  }

  function fail(error, code) {
    return Object.freeze({ ok: false, value: null, error, code });
  }

  // 两档/三档用「简单/中等/复杂」就说得清；更多档只能经 API 配出来，退回编号。
  function tierLabel(rung, ceiling) {
    if (ceiling <= 3) {
      if (rung <= 1) return tt('autoEditorTierSimple', '简单任务');
      if (rung >= ceiling) return tt('autoEditorTierComplex', '复杂任务');
      return tt('autoEditorTierMedium', '中等任务');
    }
    if (rung <= 1) return `${rung} · ${tt('autoEditorTierSimplest', '最简单')}`;
    if (rung >= ceiling) return `${rung} · ${tt('autoEditorTierHardest', '最复杂')}`;
    return String(rung);
  }

  // The short form sits on the row's chip; tierLabel() is its tooltip.
  function tierChip(rung, ceiling) {
    if (ceiling > 3) return String(rung);
    if (rung <= 1) return tt('autoEditorTierChipSimple', '简单');
    if (rung >= ceiling) return tt('autoEditorTierChipComplex', '复杂');
    return tt('autoEditorTierChipMedium', '中等');
  }

  // [wire value, option key, option text, folded-summary key, folded-summary text]
  const UNKNOWN_CHOICES = Object.freeze([
    ['strong', 'autoEditorJevUnknownStrong', '当复杂任务处理（稳妥）', 'autoEditorMoreUnknownStrong', '判断不了按复杂'],
    ['weak', 'autoEditorJevUnknownWeak', '当简单任务处理（省钱）', 'autoEditorMoreUnknownWeak', '判断不了按简单'],
    ['priority', 'autoEditorJevUnknownPriority', '不看难度，按顺序用', 'autoEditorMoreUnknownPriority', '判断不了按顺序'],
  ]);

  // Only a first guess the user can override; it just saves most pools from
  // having to be assigned by hand (flash/mini/haiku-class models go simple).
  const LIGHT_MODEL = /(^|[^a-z])(flash|mini|lite|haiku|nano|small|tiny|instant|turbo|air)([^a-z]|$)|(^|[^0-9.])([1-9]|[1-3][0-9])b([^a-z0-9]|$)/i;
  function looksLight(text) {
    return LIGHT_MODEL.test(String(text || ''));
  }

  // Rung of a configured candidate in a declared ladder: the editor shows rungs
  // (1 = weakest) while the wire carries tier keys, so this is the one place the
  // two have to agree. `fallback` is used when the ladder does not name the row.
  function rungFor(configured, ladder, fallback) {
    if (configured && configured.rung != null) return Number(configured.rung) || fallback;
    const tier = configured && configured.tier ? String(configured.tier) : '';
    const index = tier ? ladder.indexOf(tier) : -1;
    return index >= 0 ? index + 1 : fallback;
  }

  // Difficulty routing for one draft. Returns the candidates with their tier key
  // attached plus the frozen routing block, or a failure the editor can show.
  // Rungs are compacted to `t1..tK` in ascending order: only their order carries
  // meaning, so a user who leaves a gap never has to close it by hand.
  function serializeRouting(draft, candidates) {
    const previous = draft.initialRouting && typeof draft.initialRouting === 'object'
      ? draft.initialRouting : null;
    if (draft.routingEnabled !== true) return null;
    const gateway = routingGatewayOf(draft.routingGateway);
    const previousGateway = routingGatewayOf(previous && previous.gateway);
    const endpoint = gateway === CUSTOM_ROUTING_GATEWAY
      ? String(draft.routingEndpoint == null ? '' : draft.routingEndpoint).trim() : '';
    // The address travels to arbitrary hosts, so it is checked here too — this is
    // the value that is actually saved, and a save the server will reject must
    // fail before the pool is written.
    if (gateway === CUSTOM_ROUTING_GATEWAY) {
      const problem = customEndpointError(endpoint);
      if (problem) return fail(problem, 'invalid_provider_routing');
    }
    // 'strong' is the server default: only written when chosen, or when the pool
    // already carried it, so a plain routed pool keeps its minimal wire shape.
    const onUnknown = draft.routingOnUnknown || (previous && previous.onUnknown) || null;
    const writeOnUnknown = onUnknown && (onUnknown !== 'strong' || (previous && previous.onUnknown));
    if (candidates.length < 2) {
      return fail(tt('autoEditorRoutingNeedsTwo', '按难度路由至少需要两个候选 Provider。'),
        'insufficient_candidates');
    }
    // A price-tiered pool carries no hand tags at all: its ladder is the price
    // table's, recomputed every turn, and a rung next to it would be a second
    // ladder nobody reads — the server rejects that pairing outright.
    const priceTiering = routingTieringOf(draft) === PRICE_TIERING;
    const rungs = priceTiering ? [] : [...new Set(candidates.map(candidate => Number(candidate.rung) || 0))]
      .filter(rung => rung > 0).sort((left, right) => left - right);
    if (!priceTiering && rungs.length < 2) {
      return fail(tt('autoEditorRoutingNeedsTwoTiers', '按难度分配时，至少要一条线路负责简单任务、另一条负责复杂任务。'),
        'provider_routing_requires_tiers');
    }
    if (rungs.length > MAX_TIERS) {
      return fail(tt('autoEditorRoutingTooManyTiers', '最多 {max} 个档位。', { max: MAX_TIERS }),
        'invalid_provider_routing');
    }
    const keyByRung = new Map(rungs.map((rung, index) => [rung, `t${index + 1}`]));
    const model = modelOf(gateway, previousGateway, draft, previous);
    return Object.freeze({
      ok: true,
      // `rung` is the editor's own control value and never travels on the wire.
      candidates: candidates.map(({ rung, ...candidate }) => (keyByRung.size
        ? { ...candidate, tier: keyByRung.get(Number(rung) || 0) }
        : candidate)),
      value: Object.freeze({
        version: 1,
        provider: ROUTING_PROVIDER,
        gateway,
        // Only a custom gateway owns its address; a preset's endpoint stays on the
        // server, where a table update reaches it (see validateRoutingTarget).
        ...(endpoint ? { endpoint } : {}),
        // Each gateway has its own vault entry, so a key saved for another one is
        // not this one's key: an apiKeyName carried over from a different gateway
        // would point this pool at an entry the user never intended.
        apiKeyName: previousGateway === gateway && previous && previous.apiKeyName
          ? String(previous.apiKeyName)
          : ROUTING_GATEWAY_INFO[gateway].keyName,
        // Never silently reset a knob the editor does not expose: the API can set
        // onUnknown/timeoutMs/model, and re-saving the pool must not undo it. A
        // gateway change is the one case where the model cannot be carried: the
        // model id belongs to the endpoint it is asked of.
        ...(model ? { model } : {}),
        ...(writeOnUnknown ? { onUnknown: String(onUnknown) } : {}),
        ...(previous && previous.timeoutMs != null ? { timeoutMs: Number(previous.timeoutMs) } : {}),
        ...(previous && previous.escalation ? { escalation: { ...previous.escalation } } : {}),
        // Written only for a price-tiered pool, so a manual pool's routing block
        // is byte-identical to the one it had before tiering existed.
        ...(priceTiering ? { tiering: PRICE_TIERING } : {}),
        tiers: Object.freeze(rungs.map(rung => keyByRung.get(rung))),
      }),
    });
  }

  // Which ladder a routed pool uses. Only the two values the server accepts
  // exist; anything else is the manual default the editor has always written.
  function routingTieringOf(draft) {
    return draft && draft.tiering === PRICE_TIERING ? PRICE_TIERING : DEFAULT_ROUTING_TIERING;
  }

  // A pool is cross-CLI as soon as one candidate names its lane. The server
  // then writes the session's own CLI onto the candidates that carry none, so
  // leaving the field absent on those is the same statement the API makes.
  function selectionCrossesCli(candidates) {
    return (Array.isArray(candidates) ? candidates : []).some(candidate => candidate && candidate.cli);
  }

  function cliSwitchOf(draft) {
    const policy = String(draft && draft.cliSwitch || '').trim();
    return CLI_SWITCH_POLICIES.includes(policy) ? policy : DEFAULT_CLI_SWITCH;
  }

  // The model a routing block is saved with. A custom gateway asks whatever the
  // user typed (blank means the contract's own default), a preset keeps the
  // pool's pinned model only while the gateway has not changed under it.
  function modelOf(gateway, previousGateway, draft, previous) {
    if (gateway === CUSTOM_ROUTING_GATEWAY) {
      return String(draft.routingModel == null ? '' : draft.routingModel).trim() || CUSTOM_ROUTING_MODEL;
    }
    if (previousGateway === gateway && previous && previous.model) return String(previous.model);
    return '';
  }

  function serializeDraft(draft = {}) {
    const protocol = String(draft.protocol || '');
    if (!PROTOCOL_SET.has(protocol)) {
      if (!protocol) return Object.freeze({ ok: true, value: null, error: null, code: null });
      return fail(tt('autoEditorInvalidProtocol', '无效的 Auto Provider 协议。'), 'invalid_protocol');
    }
    const source = Array.isArray(draft.candidates) ? draft.candidates : [];
    const candidates = [];
    const ids = new Set();
    for (let index = 0; index < source.length; index += 1) {
      const raw = source[index];
      if (!raw || raw.enabled === false) continue;
      const providerId = String(raw.providerId || '').trim();
      // '当前 CLI' is the empty value: the field stays off the wire, and the
      // server reads it as the session's own lane. A named lane has to be one
      // the server knows, or the save would be refused after the fact.
      const cli = normalizeCli(raw.cli);
      if (String(raw.cli || '').trim() && !cli) {
        return fail(tt('autoEditorInvalidCli', '候选 {provider} 的 CLI 无效。', { provider: providerId || '?' }),
          'invalid_provider_candidate');
      }
      // The same route may serve two lanes, so a lane-qualified key is what
      // "twice" means here; within one lane it may appear once (the server
      // draws the same line in validateProviderSelection).
      const candidateKey = `${cli}\n${providerId}`;
      if (!providerId || ids.has(candidateKey)) {
        return fail(providerId
          ? tt('autoEditorDuplicateProvider', 'Provider {provider} 重复。', { provider: providerId })
          : tt('autoEditorInvalidProvider', '候选 Provider 无效。'),
          providerId ? 'duplicate_provider' : 'invalid_provider');
      }
      const priority = Number(raw.priority == null ? index + 1 : raw.priority);
      if (!Number.isSafeInteger(priority) || priority < 1 || priority > 100) {
        return fail(tt('autoEditorInvalidPriority', '优先级必须是 1–100 的整数。'), 'invalid_priority');
      }
      const model = raw.model == null || String(raw.model).trim() === '' ? null : String(raw.model).trim();
      // An auto-model line picks its model from the price table each turn; a
      // pinned model next to it would be a second, contradicting answer.
      const autoModel = raw.autoModel === true;
      if (autoModel && model) {
        return fail(tt('autoEditorAutoModelPinnedModel', '「自动选模型」的线路不能再钉住一个模型。'),
          'invalid_provider_candidate');
      }
      ids.add(candidateKey);
      candidates.push({
        providerId,
        model: autoModel ? null : model,
        priority,
        enabled: true,
        ...(cli ? { cli } : {}),
        ...(autoModel ? { autoModel: true } : {}),
        ...(raw.rung == null ? {} : { rung: Number(raw.rung) }),
        _index: index,
      });
    }
    if (candidates.length < 2) {
      return fail(tt('autoEditorInsufficientCandidates', '至少启用两个同协议 Provider。'), 'insufficient_candidates');
    }
    if (candidates.length > MAX_CANDIDATES) {
      return fail(tt('autoEditorTooManyCandidates', '最多启用 {max} 个候选 Provider。', { max: MAX_CANDIDATES }),
        'too_many_candidates');
    }
    candidates.sort((left, right) => left.priority - right.priority || left._index - right._index);
    // `rung` is the editor's own control value: it decides the tier, it never
    // travels on the wire.
    const stripped = candidates.map(({ _index, rung, ...candidate }) => candidate);
    const routing = draft.routingEnabled === true
      ? serializeRouting(draft, candidates.map(({ _index, ...candidate }) => candidate))
      : null;
    if (routing && routing.ok === false) return routing;
    const cleanCandidates = routing ? routing.candidates : stripped;
    // Picking a model per turn needs a router, and the router is whatever the
    // pool's `routing` block describes (Jev, either tiering). Without a routed
    // pool an auto-model line would silently mean "first", which the server
    // refuses with the same code.
    if (cleanCandidates.some(candidate => candidate.autoModel) && !routing) {
      return fail(tt('autoEditorAutoModelNeedsRouting', '「自动选模型」只在「按难度」线路池里可用。'),
        'provider_auto_model_requires_routing');
    }
    const crossCli = selectionCrossesCli(cleanCandidates);
    const providers = Array.isArray(draft.providers) ? draft.providers : [];
    // 混用官方账号与他人自管 Provider 是允许的，默认就这样跑：跨信任域时一律带上
    // allowCrossTrust（服务端只有在它为 true 时才放行跨信任池），不再要求勾选确认。
    const crossesTrust = selectionCrossesTrust(cleanCandidates, providers);
    const requestedAttempts = Number(draft.maxAttempts) || 2;
    const maxAttempts = Math.max(2, Math.min(MAX_ATTEMPTS, cleanCandidates.length, requestedAttempts));
    return Object.freeze({
      ok: true,
      value: {
        version: 1,
        mode: 'auto',
        protocol,
        candidates: cleanCandidates,
        maxAttempts,
        sticky: draft.sticky !== false,
        allowCrossTrust: crossesTrust,
        // Only a pool that actually spans lanes has a lane policy; a single-CLI
        // pool keeps exactly the wire shape it had before cross-CLI existed.
        ...(crossCli ? { cliSwitch: cliSwitchOf(draft) } : {}),
        // Absent for a plain pool, so its wire JSON stays byte-identical.
        ...(routing ? { routing: routing.value } : {}),
      },
      error: null,
      code: null,
    });
  }

  function defaultPresetStore() {
    try {
      const storage = typeof window !== 'undefined' && window.localStorage;
      if (!storage) return null;
      return {
        load() { try { return JSON.parse(storage.getItem(PRESET_KEY) || '[]'); } catch (_) { return []; } },
        save(list) { try { storage.setItem(PRESET_KEY, JSON.stringify(list)); } catch (_) {} },
      };
    } catch (_) { return null; }
  }

  function presetSignature(value) {
    return JSON.stringify([value.protocol, (value.candidates || [])
      .map(candidate => [candidate.providerId, candidate.model || null, candidate.priority])]);
  }

  // 存进去的只是 serializeDraft 的结果，不含任何密钥；跨上游许可不随预设走 ——
  // 套用后仍要重新勾确认，风险提示不能被一份旧预设静默跳过。
  function normalizePresets(raw) {
    return (Array.isArray(raw) ? raw : []).filter(item => item && typeof item === 'object'
      && PROTOCOL_SET.has(item.protocol) && Array.isArray(item.candidates) && item.candidates.length >= 2
      && typeof item.name === 'string');
  }

  function rememberPreset(list, value, { name = '', recent = false, now = Date.now() } = {}) {
    const signature = presetSignature(value);
    const entry = {
      id: `p${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: String(name || '').trim().slice(0, 60),
      recent,
      protocol: value.protocol,
      candidates: value.candidates.map(({ providerId, model, priority }) => ({ providerId, model: model || null, priority })),
      maxAttempts: value.maxAttempts,
      sticky: value.sticky !== false,
      savedAt: now,
    };
    const current = normalizePresets(list);
    if (recent) {
      // 同一份池子已经有具名预设或最近记录：只把它顶到最前，不再多存一条。
      const existing = current.find(item => presetSignature(item) === signature);
      if (existing) return [{ ...existing, savedAt: now }, ...current.filter(item => item !== existing)];
      const recents = [entry, ...current.filter(item => item.recent)].slice(0, MAX_RECENT_PRESETS);
      return [...current.filter(item => !item.recent), ...recents];
    }
    const others = current.filter(item => presetSignature(item) !== signature
      && !(item.name && item.name === entry.name && !item.recent));
    const named = [entry, ...others.filter(item => !item.recent)].slice(0, MAX_NAMED_PRESETS);
    return [...named, ...others.filter(item => item.recent)];
  }

  function ensureStyles(document) {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = editorCss('.multicc-auto-editor');
    (document.head || document.body).appendChild(style);
  }

  // Host pages style bare controls (Air: input{width:100%}, button{min-height:
  // 38px}, dialog label{display:block}), so every rule here is scoped under the
  // root class; the resets use :where() to stay weaker than the component rules.
  // Colours come from host variables — Air, the light chat skin and the dark
  // chat page each bring their own — with dark fallbacks.
  function editorCss(P) {
    return `
${P}{--ape-fg:var(--chat-text,var(--text,#c9d1d9));--ape-muted:var(--chat-muted,var(--muted,#8b949e));--ape-line:var(--chat-line,var(--line-strong,#30363d));--ape-field:var(--chat-surface,var(--well,#0d1117));--ape-panel:var(--panel-soft,transparent);--ape-accent:var(--chat-blue,var(--accent,#58a6ff));--ape-ok:var(--green,#3fb950);--ape-warn:var(--warning,#d29922);--ape-danger:var(--danger,#f85149);container-type:inline-size;box-sizing:border-box;border:1px solid var(--ape-line);border-radius:12px;padding:12px 14px;margin:0 0 12px;background:var(--ape-panel);color:var(--ape-fg);font-size:12px;line-height:1.45;text-align:left}
${P} :where(div,span,p,ol,li,label,input,select,button,details,summary,small,b){margin:0;box-sizing:border-box;letter-spacing:normal}
${P} :where(input,select,button){font:inherit;min-height:0;width:auto;box-shadow:none}
${P} :is(input,select,button):focus{box-shadow:none}
${P} :is(input,select,button,summary):focus-visible{outline:2px solid color-mix(in srgb,var(--ape-accent) 55%,transparent);outline-offset:1px}
${P} :where(label){display:inline-flex;align-items:center;gap:6px;font-size:inherit;color:inherit;cursor:pointer}
${P} input[type=checkbox]{width:14px;height:14px;padding:0;flex:none;accent-color:var(--ape-accent)}
${P} :is(select,input[type=text],input[type=password]){height:28px;padding:0 8px;border:1px solid var(--ape-line);border-radius:7px;background-color:var(--ape-field);color:var(--ape-fg);font-size:12px}
${P} button{height:28px;padding:0 10px;border:1px solid var(--ape-line);border-radius:7px;background:var(--ape-field);color:var(--ape-fg);font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
${P} button:hover{border-color:var(--ape-accent);color:var(--ape-accent);background:var(--ape-field)}
${P} button:disabled{opacity:.45;cursor:default}
${P} ${P}-link{height:auto;padding:0;border:0;background:none;color:var(--ape-accent)}
${P} ${P}-link:hover{border:0;background:none;text-decoration:underline}
${P} ${P}-primary,${P} ${P}-primary:hover{border-color:var(--ape-accent);background:var(--ape-accent);color:#fff}
${P}-muted{color:var(--ape-muted)}
${P}-top{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;margin-bottom:10px}
${P}-title{font-size:13px;font-weight:600}
${P}-presets{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;justify-content:flex-end}
${P} ${P}-presets select{max-width:200px}
${P}-preset-form{display:flex;gap:6px;align-items:center}
${P}-preset-status{flex-basis:100%;text-align:right;color:var(--ape-muted);font-size:11px}
${P}-mode{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
${P}-mode-hint{margin:6px 0 12px;color:var(--ape-muted)}
${P} ${P}-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--ape-line);border-radius:9px;background:var(--ape-field)}
${P} ${P}-seg button{height:26px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--ape-muted)}
${P} ${P}-seg button[aria-checked=true]{background:var(--ape-accent);color:#fff;font-weight:600}
${P} ${P}-seg button:hover:not([aria-checked=true]){color:var(--ape-fg)}
${P} ${P}-jev{display:grid;gap:7px;margin:0 0 12px;padding:9px 11px;border:1px solid var(--ape-line);border-radius:10px;background:var(--ape-field)}
${P} ${P}-jev.missing{border-color:color-mix(in srgb,var(--ape-warn) 55%,var(--ape-line));background:color-mix(in srgb,var(--ape-warn) 6%,var(--ape-field))}
${P}-jev-line{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap}
${P}-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--ape-muted)}
${P}-jev.ok ${P}-dot{background:var(--ape-ok)}
${P}-jev.missing ${P}-dot{background:var(--ape-warn)}
${P}-jev-actions{display:flex;gap:12px;margin-left:auto}
${P} ${P}-steps{padding-left:18px;color:var(--ape-muted)}
${P}-jev-custom{display:grid;gap:6px}
${P} ${P}-jev-custom label{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:center}
${P} ${P}-jev-custom input{width:100%;min-width:0}
${P}-jev-endpoint-error{color:var(--ape-danger);font-size:12px}
${P}-jev-form{display:flex;gap:6px}
${P} ${P}-jev-form input{flex:1 1 auto;min-width:0}
${P}-fine{color:var(--ape-muted);font-size:11px}
${P}-result.good{color:var(--ape-ok)}
${P}-result.bad{color:var(--ape-warn)}
${P}-list-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 8px;margin:0 0 6px;font-weight:600}
${P}-list-head small{font-weight:400;font-size:11px;color:var(--ape-muted)}
${P}-list,${P}-pool{display:grid;gap:6px}
${P} ${P}-row{display:grid;grid-template-columns:22px minmax(0,1fr) minmax(110px,170px) auto auto;grid-template-areas:"rank name model tier act";align-items:center;gap:8px;padding:6px 6px 6px 8px;border:1px solid var(--ape-line);border-radius:9px;background:var(--ape-field)}
${P}-rank{grid-area:rank;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:color-mix(in srgb,var(--ape-accent) 14%,transparent);color:var(--ape-accent);font-size:11px;font-weight:600}
${P}-name{grid-area:name;display:flex;align-items:center;gap:6px;min-width:0}
${P}-name-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${P}-cli-field{flex:none}
${P} ${P}-cli{max-width:118px}
${P} ${P}-model-field{grid-area:model;display:grid;gap:0;min-width:0}
${P} ${P}-provider-field{display:grid;gap:0;min-width:0;margin-bottom:4px}
${P} ${P}-provider{width:100%;min-width:0}
${P} ${P}-model{width:100%;min-width:0}
${P} ${P}-tier{grid-area:tier}
${P}.is-price ${P}-tier{display:none}
${P}-auto-model-field{display:none;align-items:center;gap:5px;margin-top:4px;font-size:11px;color:var(--ape-muted)}
${P}.is-price ${P}-auto-model-field{display:flex}
${P}-cli-switch-hint,${P}-tiering-hint{margin:-4px 0 12px}
${P} ${P}-tier button{height:22px;padding:0 9px;font-size:11px}
${P}.is-order ${P}-tier{display:none}
${P}-act{grid-area:act;display:flex;gap:2px}
${P} ${P}-icon{width:24px;height:24px;padding:0;border-color:transparent;background:transparent;color:var(--ape-muted);font-size:13px}
${P}-list ${P}-add-one,${P}-pool :is(${P}-rank,${P}-model-field,${P}-model,${P}-tier,${P}-icon,${P}-cli-field){display:none}
${P} ${P}-pool ${P}-row{display:flex;padding:4px 6px 4px 10px;border-style:dashed;background:transparent;color:var(--ape-muted)}
${P}-pool ${P}-name{flex:1 1 auto}
${P} ${P}-add-one{height:24px;border-color:transparent;background:transparent;color:var(--ape-accent)}
${P} ${P}-add{margin-top:8px}
${P} ${P}-add>summary{display:inline-block;padding:2px 0;margin-bottom:6px;color:var(--ape-accent);font-size:12px;cursor:pointer;list-style:none}
${P} ${P}-add>summary::-webkit-details-marker{display:none}
${P} ${P}-summary{margin-top:10px;padding:7px 10px;border-radius:8px;background:color-mix(in srgb,var(--ape-accent) 8%,transparent)}
${P} ${P}-summary.bad{background:color-mix(in srgb,var(--ape-warn) 10%,transparent);color:var(--ape-warn)}
${P}-error{margin-top:8px;color:var(--ape-danger)}
${P} ${P}-more{margin-top:10px;padding-top:8px;border-top:1px solid var(--ape-line)}
${P} ${P}-more>summary{padding:2px 0;color:var(--ape-fg);font-size:12px;cursor:pointer}
${P}-more-body{display:grid;justify-items:start;gap:8px;padding:8px 0 2px}
@container (max-width:520px){
  ${P} ${P}-row{grid-template-columns:22px minmax(0,1fr) auto auto;grid-template-areas:"rank name name act" ". model tier tier"}
  ${P}.is-order ${P}-row{grid-template-areas:"rank name name act" ". model model model"}
  ${P}-jev-actions{margin-left:0}
  ${P}-presets{justify-content:flex-start}
  ${P}-preset-status{text-align:left}
}
`;
  }

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function mount(options = {}) {
    const document = options.document
      || (typeof window !== 'undefined' && window.document) || null;
    const container = options.container;
    if (!document || !container || typeof container.appendChild !== 'function') {
      throw new TypeError('Auto Provider editor requires document and container');
    }
    ensureStyles(document);
    let providers = Array.isArray(options.providers) ? options.providers : [];
    let protocol = PROTOCOL_SET.has(options.protocol) ? options.protocol : null;
    let initialSelection = options.initialSelection || null;
    // The host owns every vault/network touch: { check(name), save(name, value),
    // test({ apiKeyName, text }) }, all promise-returning. Without it the panel
    // only names the vault entry.
    const routingKey = options.routingKey && typeof options.routingKey.check === 'function'
      ? options.routingKey : null;
    // 'unknown' until routing is first switched on, so opening the editor for a
    // plain pool costs no request.
    let keyState = 'unknown';
    let keyFormOpen = false;
    let keyGeneration = 0;
    let destroyed = false;
    let routingOn = false;
    let routingGateway = DEFAULT_ROUTING_GATEWAY;
    // The gateway the key steps and the input placeholder were last built for.
    let gatewayRendered = null;
    // Every provider row of the protocol pool, in pool order; `order` holds the
    // rows in use, first = tried first. Unused rows wait in the "添加线路" list.
    let allRows = [];
    let order = [];
    let modelGeneration = 0;
    // Rows whose line declares no models at all, refilled once the local
    // catalog arrives (see the tail of render()).
    let emptyCatalogRows = [];
    // The lane the session runs on: the option every row starts on. '' when the
    // host did not say, which reads as "no candidate names a cli" — the wire
    // shape of every pool stored before cross-CLI existed.
    let homeCli = normalizeCli(options.cli);
    // How a routed pool decides its tiers, and where a cross-CLI pool may go
    // when the current lane runs out. Both are pool-level choices.
    let tiering = DEFAULT_ROUTING_TIERING;
    let cliSwitchPolicy = DEFAULT_CLI_SWITCH;
    // Per-row bookkeeping: the lane's provider, the row's own lane, and the
    // provider the row is pinned to when it runs on the session's CLI.
    const rowState = new Map();
    // Other lanes' provider catalogs, fetched once each through the same
    // /api/providers the host uses for the current CLI (see ensureLane).
    const laneCache = new Map();
    const loadCliProviders = typeof options.loadCliProviders === 'function'
      ? options.loadCliProviders : defaultCliProviderLoader;
    // The stored pool the two pool-level choices were last read from, so a
    // re-render of the same selection does not overwrite the user's own choice.
    let seededKey = null;
    const loadModels = options.loadModels || loadCandidateModels;
    const formatProvider = typeof options.formatProvider === 'function'
      ? options.formatProvider : provider => provider.name || provider.id;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const presetStore = options.presetStore === undefined ? defaultPresetStore() : options.presetStore;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const make = (tag, className, text) => element(document, tag, className, text);
    const button = (className, text) => {
      const node = make('button', className, text);
      node.type = 'button';
      return node;
    };
    const setChecked = (node, on) => node.setAttribute('aria-checked', on ? 'true' : 'false');
    function segment(className, label) {
      const group = make('div', `multicc-auto-editor-seg ${className}`);
      group.setAttribute('role', 'radiogroup');
      if (label) group.setAttribute('aria-label', label);
      return group;
    }
    function segButton(group, className, text) {
      const node = button(className, text);
      node.setAttribute('role', 'radio');
      setChecked(node, false);
      group.appendChild(node);
      return node;
    }

    container.classList.add('multicc-auto-editor');
    const top = make('div', 'multicc-auto-editor-top');
    const title = make('div', 'multicc-auto-editor-title', tt('autoEditorTitle', 'Auto 候选池'));
    const presetBar = make('div', 'multicc-auto-editor-presets');
    const presetSelect = make('select', 'multicc-auto-editor-preset-select');
    presetSelect.setAttribute('aria-label', tt('autoEditorPresetPlaceholder', '套用预设…'));
    const presetDelete = button('multicc-auto-editor-preset-delete multicc-auto-editor-link',
      tt('autoEditorPresetDelete', '删除预设'));
    const presetOpen = button('multicc-auto-editor-preset-open multicc-auto-editor-link',
      tt('autoEditorPresetOpen', '存为预设'));
    const presetForm = make('div', 'multicc-auto-editor-preset-form');
    const presetName = make('input', 'multicc-auto-editor-preset-name');
    presetName.type = 'text';
    presetName.placeholder = tt('autoEditorPresetNamePlaceholder', '预设名称（可选）');
    const presetSave = button('multicc-auto-editor-preset-save multicc-auto-editor-primary',
      tt('autoEditorPresetSave', '保存'));
    const presetCancel = button('multicc-auto-editor-preset-cancel multicc-auto-editor-link',
      tt('autoEditorJevKeyCancel', '取消'));
    presetForm.append(presetName, presetSave, presetCancel);
    const presetStatus = make('div', 'multicc-auto-editor-preset-status');
    presetBar.append(presetSelect, presetDelete, presetOpen, presetForm, presetStatus);
    if (!presetStore) presetBar.style.display = 'none';
    top.append(title, presetBar);

    // How the pool picks a line — the first decision, one click either way.
    const modeRow = make('div', 'multicc-auto-editor-mode');
    const modeLabel = tt('autoEditorModeLabel', '怎么选线路');
    const modeSeg = segment('multicc-auto-editor-modes', modeLabel);
    const orderMode = segButton(modeSeg, 'multicc-auto-editor-mode-order', tt('autoEditorModeOrder', '按顺序'));
    const routingEnabled = segButton(modeSeg, 'multicc-auto-editor-routing', tt('autoEditorModeRouting', '按难度'));
    modeRow.append(make('span', '', modeLabel), modeSeg);
    const modeHint = make('p', 'multicc-auto-editor-mode-hint');

    // Where the pool may go when the session's own CLI has nothing usable left.
    // Only a pool that actually spans lanes has this choice, so it stays hidden
    // until a row names another one.
    const cliSwitchRow = make('div', 'multicc-auto-editor-mode multicc-auto-editor-cli-switch-row');
    const cliSwitchLabel = tt('autoEditorCliSwitchLabel', '换道时机');
    const cliSwitchSeg = segment('multicc-auto-editor-cli-switches', cliSwitchLabel);
    const cliSwitchFailover = segButton(cliSwitchSeg, 'multicc-auto-editor-cli-switch-failover',
      tt('autoEditorCliSwitchFailover', '本车道不可用才换'));
    const cliSwitchRouting = segButton(cliSwitchSeg, 'multicc-auto-editor-cli-switch-routing',
      tt('autoEditorCliSwitchRouting', '按选择换道'));
    cliSwitchRow.append(make('span', '', cliSwitchLabel), cliSwitchSeg);
    const cliSwitchHint = make('p', 'multicc-auto-editor-mode-hint multicc-auto-editor-cli-switch-hint');

    // How a routed pool decides its tiers: by hand, or from the price table.
    const tieringRow = make('div', 'multicc-auto-editor-mode multicc-auto-editor-tiering-row');
    const tieringLabel = tt('autoEditorTieringLabel', '档位依据');
    const tieringSeg = segment('multicc-auto-editor-tierings', tieringLabel);
    const tieringManual = segButton(tieringSeg, 'multicc-auto-editor-tiering-manual',
      tt('autoEditorTieringManual', '手动标注'));
    const tieringPrice = segButton(tieringSeg, 'multicc-auto-editor-tiering-price',
      tt('autoEditorTieringPrice', '按价格'));
    tieringRow.append(make('span', '', tieringLabel), tieringSeg);
    const tieringHint = make('p', 'multicc-auto-editor-mode-hint multicc-auto-editor-tiering-hint');

    const jevBox = make('div', 'multicc-auto-editor-jev');
    // Which gateway every Jev call goes to — the first thing to decide about the
    // connection, so it sits above the key it belongs to.
    const gatewayRow = make('div', 'multicc-auto-editor-mode');
    const gatewayLabel = tt('autoEditorJevGatewayLabel', 'Jev 通过');
    const gatewaySeg = segment('multicc-auto-editor-gateways', gatewayLabel);
    const gatewayButtons = new Map();
    for (const name of ROUTING_GATEWAYS) {
      const node = segButton(gatewaySeg, `multicc-auto-editor-gateway multicc-auto-editor-gateway-${name}`,
        routingGatewayLabel(name));
      node.dataset.gateway = name;
      node.addEventListener('click', () => chooseGateway(name));
      gatewayButtons.set(name, node);
    }
    gatewayRow.append(make('span', '', gatewayLabel), gatewaySeg);
    const jevLine = make('div', 'multicc-auto-editor-jev-line');
    const keyStatus = make('b', 'multicc-auto-editor-jev-status');
    const keyDetail = make('span', 'multicc-auto-editor-muted');
    const jevActions = make('span', 'multicc-auto-editor-jev-actions');
    const testButton = button('multicc-auto-editor-jev-test multicc-auto-editor-link', tt('autoEditorJevTest', '测试'));
    const keyChange = button('multicc-auto-editor-jev-key-change multicc-auto-editor-link',
      tt('autoEditorJevKeyChange', '更换 key'));
    jevActions.append(testButton, keyChange);
    jevLine.append(make('span', 'multicc-auto-editor-dot'), keyStatus, keyDetail, jevActions);
    // A custom gateway is the only one whose address and model id the user owns;
    // the presets come with both.
    const customBox = make('div', 'multicc-auto-editor-jev-custom');
    const endpointField = make('label', '', tt('autoEditorJevEndpointLabel', '接口地址'));
    const endpointInput = make('input', 'multicc-auto-editor-jev-endpoint');
    endpointInput.type = 'text';
    endpointInput.maxLength = MAX_ROUTING_ENDPOINT_CHARS;
    endpointInput.placeholder = 'https://…/v1/evaluate';
    endpointField.appendChild(endpointInput);
    // The address's own verdict sits right under it, not at the foot of the
    // editor: the field is the only thing the user can change to clear it.
    const endpointError = make('div', 'multicc-auto-editor-jev-endpoint-error');
    endpointError.setAttribute('aria-live', 'polite');
    endpointError.style.display = 'none';
    const modelField = make('label', '', tt('autoEditorJevModelLabel', '模型名'));
    const gatewayModel = make('input', 'multicc-auto-editor-jev-model');
    gatewayModel.type = 'text';
    gatewayModel.placeholder = CUSTOM_ROUTING_MODEL;
    modelField.appendChild(gatewayModel);
    const customHint = make('div', 'multicc-auto-editor-fine',
      tt('autoEditorJevCustomHint', '需兼容 Jev 评估接口：POST {model, state, questions}，Bearer 鉴权'));
    customBox.append(endpointField, endpointError, modelField, customHint);
    const keySteps = make('ol', 'multicc-auto-editor-steps');
    const keyForm = make('div', 'multicc-auto-editor-jev-form');
    const keyInput = make('input', 'multicc-auto-editor-jev-key-input');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    const keySave = button('multicc-auto-editor-jev-key-save multicc-auto-editor-primary',
      tt('autoEditorJevKeySave', '保存并测试'));
    keyForm.append(keyInput, keySave);
    const keyHelp = make('div', 'multicc-auto-editor-fine');
    const testResult = make('div', 'multicc-auto-editor-result multicc-auto-editor-jev-test-result');
    testResult.setAttribute('aria-live', 'polite');
    testResult.style.display = 'none';
    jevBox.append(gatewayRow, jevLine, customBox, keySteps, keyForm, keyHelp, testResult);

    const listHead = make('div', 'multicc-auto-editor-list-head');
    const listHint = make('small', '');
    listHead.append(make('span', '', tt('autoEditorListTitle', '使用的线路')), listHint);
    const list = make('div', 'multicc-auto-editor-list');
    const addBox = make('details', 'multicc-auto-editor-add');
    const addSummary = make('summary', '');
    const poolList = make('div', 'multicc-auto-editor-pool');
    addBox.append(addSummary, poolList);

    const summary = make('div', 'multicc-auto-editor-summary');
    summary.setAttribute('aria-live', 'polite');
    const error = make('div', 'multicc-auto-editor-error');
    error.setAttribute('role', 'alert');
    error.style.display = 'none';

    // Rarely-touched knobs stay folded; the summary line shows their values.
    const more = make('details', 'multicc-auto-editor-more');
    const moreSummary = make('summary', '');
    const moreBody = make('div', 'multicc-auto-editor-more-body');
    const maxLabel = make('label', '', tt('autoEditorMaxAttemptsLabel', '一条消息最多尝试 '));
    const maxAttempts = make('select', 'multicc-auto-editor-max-attempts');
    for (let value = 2; value <= MAX_ATTEMPTS; value += 1) {
      const option = make('option', '', String(value));
      option.value = String(value);
      maxAttempts.appendChild(option);
    }
    maxLabel.append(maxAttempts, document.createTextNode(tt('autoEditorMaxAttemptsSuffix', ' 条线路')));
    const stickyLabel = make('label');
    const sticky = make('input', 'multicc-auto-editor-sticky');
    sticky.type = 'checkbox';
    stickyLabel.append(sticky, document.createTextNode(tt('autoEditorStickySuffix', ' 优先保持当前线路')));
    const unknownRow = make('label', '', tt('autoEditorJevUnknownLabel', '判断不了难度时（Jev 超时或没连上） '));
    const onUnknownSelect = make('select', 'multicc-auto-editor-jev-unknown');
    for (const [value, key, fallback] of UNKNOWN_CHOICES) {
      const option = make('option', '', tt(key, fallback));
      option.value = value;
      onUnknownSelect.appendChild(option);
    }
    unknownRow.appendChild(onUnknownSelect);
    const help = make('div', 'multicc-auto-editor-fine',
      tt('autoEditorHelp', '只在还没收到回复、也没执行过工具时才会切换线路；额度已用完的线路会被提前跳过。'));
    moreBody.append(maxLabel, stickyLabel, unknownRow, help);
    more.append(moreSummary, moreBody);

    container.replaceChildren(top, modeRow, modeHint, cliSwitchRow, cliSwitchHint,
      tieringRow, tieringHint, jevBox, listHead, list, addBox, summary,
      error, more);

    function rows() {
      return allRows.slice();
    }

    function tierOf(row) {
      return row.querySelector('.multicc-auto-editor-tier');
    }

    function rowCli(row) {
      return normalizeCli(row.dataset.cli);
    }

    function rowAutoModel(row) {
      const toggle = row.querySelector('.multicc-auto-editor-auto-model');
      return !!(toggle && toggle.checked);
    }

    function rawCandidates() {
      return allRows.map(row => {
        const index = order.indexOf(row);
        return {
          providerId: row.dataset.providerId,
          model: rowModel(row) || null,
          priority: index < 0 ? null : index + 1,
          enabled: index >= 0,
          // The lane is the row's own choice; '' is the session's CLI, which is
          // written as "no cli field" rather than as a named lane.
          cli: rowCli(row),
          autoModel: rowAutoModel(row),
          rung: Number(tierOf(row).dataset.value) || null,
        };
      });
    }

    function rowModel(row) {
      if (rowAutoModel(row)) return '';
      const selected = row.querySelector('.multicc-auto-editor-model').value;
      return selected === '__custom__'
        ? row.querySelector('.multicc-auto-editor-model-custom').value.trim() : selected;
    }

    function fillModels(select, provider, configured, fallback = []) {
      const selected = select.value;
      select.replaceChildren();
      for (const id of candidateModelChoices(provider, configured, fallback)) {
        const option = element(document, 'option', '', id || tt('autoEditorProviderDefault', 'Provider 默认'));
        option.value = id;
        select.appendChild(option);
      }
      const custom = element(document, 'option', '', tt('custom', '自定义…'));
      custom.value = '__custom__';
      select.appendChild(custom);
      select.value = selected || '';
    }

    function enabledCandidates() {
      return rawCandidates().filter(candidate => candidate.enabled);
    }

    function showError(message) {
      error.textContent = message || '';
      error.style.display = message ? '' : 'none';
    }

    function show(node, visible) {
      node.style.display = visible ? '' : 'none';
    }

    function rowText(row) {
      const model = rowModel(row);
      // The name cell also carries the row's CLI select, so the line's name is
      // read off its own span — otherwise every option's text would ride along.
      const name = row.querySelector('.multicc-auto-editor-name-text').textContent;
      const label = rowAutoModel(row)
        ? tt('autoEditorLineAutoModel', '{name}（自动选模型）', { name })
        : (model ? tt('autoEditorLineWithModel', '{name}（{model}）', { name, model }) : name);
      const cli = rowCli(row);
      return cli ? tt('autoEditorLineOnLane', '{name} · {cli} 车道', { name: label, cli: cliName(cli) }) : label;
    }

    // Rows in use go to the list in order and get their rank; the rest wait in
    // the add list in pool order.
    function arrange() {
      list.replaceChildren(...order);
      const rest = allRows.filter(row => !order.includes(row));
      poolList.replaceChildren(...rest);
      order.forEach((row, index) => {
        row.querySelector('.multicc-auto-editor-rank').textContent = String(index + 1);
        row.querySelector('.multicc-auto-editor-move-up').disabled = index === 0;
        row.querySelector('.multicc-auto-editor-move-down').disabled = index === order.length - 1;
      });
      addSummary.textContent = tt('autoEditorAddSummary', '＋ 添加线路（还有 {count} 条可用）', { count: rest.length });
      show(addBox, rest.length > 0);
    }

    function useRow(row, on) {
      if (on && !order.includes(row) && order.length < MAX_CANDIDATES) order.push(row);
      if (!on) order = order.filter(item => item !== row);
      arrange();
      notify();
    }

    function moveRow(row, step) {
      const index = order.indexOf(row);
      const target = index + step;
      if (index < 0 || target < 0 || target >= order.length) return;
      order.splice(index, 1);
      order.splice(target, 0, row);
      arrange();
      notify();
    }

    // `dataset.rung` on a row's tier control is its *chosen* rung — seeded from
    // a configured ladder, then overwritten by every click. Rows without one are
    // re-guessed on each pass (flash/mini-class → simple, the rest → complex),
    // so switching a row's model re-files it until the user picks by hand. When
    // the names can't tell a fresh pool apart, the first line in order takes the
    // simple tasks: a valid split out of the box, never a one-tier ladder.
    let rungCeiling = 2;
    function syncRungs() {
      const enabled = order.slice();
      const chosen = enabled.map(row => Number(tierOf(row).dataset.rung) || 0);
      // Two chips — 简单 | 复杂 — unless a configured ladder already has more.
      rungCeiling = Math.min(Math.max(2, Math.min(MAX_TIERS, enabled.length)), Math.max(2, ...chosen));
      const light = enabled.map(row => looksLight(rowText(row)));
      const undecided = chosen.every(rung => !rung) && light.every(value => value === light[0]);
      for (const row of allRows) {
        const tier = tierOf(row);
        const index = enabled.indexOf(row);
        if (tier.dataset.ceiling !== String(rungCeiling)) buildTierButtons(tier, row);
        if (index < 0) {
          delete tier.dataset.value;
          continue;
        }
        const guess = undecided ? (index === 0 ? 1 : rungCeiling) : (light[index] ? 1 : rungCeiling);
        const value = Math.max(1, Math.min(rungCeiling, chosen[index] || guess));
        tier.dataset.value = String(value);
        for (const option of tier.children) setChecked(option, Number(option.dataset.rung) === value);
      }
    }

    function buildTierButtons(tier) {
      tier.dataset.ceiling = String(rungCeiling);
      tier.replaceChildren();
      for (let rung = 1; rung <= rungCeiling; rung += 1) {
        const label = tierLabel(rung, rungCeiling);
        const option = segButton(tier, 'multicc-auto-editor-tier-option', tierChip(rung, rungCeiling));
        option.dataset.rung = String(rung);
        option.title = label;
        option.addEventListener('click', () => {
          tier.dataset.rung = String(rung);
          notify();
        });
      }
    }

    // One sentence of what the pool will actually do, in both modes.
    function renderSummary() {
      const enabled = order.slice();
      summary.classList.remove('bad');
      if (enabled.length < 2) {
        summary.textContent = tt('autoEditorSummaryNeedTwo', '至少要用两条线路：从「添加线路」里再选一条。');
        summary.classList.add('bad');
        return;
      }
      if (!routingOn) {
        summary.textContent = tt('autoEditorSummaryOrder', '效果：先用 {chain}', {
          chain: enabled.map(rowText).join(tt('autoEditorSummaryThen', '，不行再换 ')),
        });
        return;
      }
      // A price-tiered pool has no hand-tagged ladder to describe — the ladder
      // is the price order of whatever is on screen this turn.
      if (tiering === PRICE_TIERING) {
        summary.textContent = tt('autoEditorSummaryPrice', '按价格自动排档：{chain}', {
          chain: enabled.map(rowText).join('、'),
        });
        return;
      }
      const groups = new Map();
      for (const row of enabled) {
        const rung = Number(tierOf(row).dataset.value) || 1;
        if (!groups.has(rung)) groups.set(rung, []);
        groups.get(rung).push(rowText(row));
      }
      if (groups.size < 2) {
        summary.textContent = tt('autoEditorSummaryNeedSplit',
          '还差一步：至少让一条线路负责「简单任务」、另一条负责「复杂任务」。');
        summary.classList.add('bad');
        return;
      }
      summary.textContent = tt('autoEditorSummaryRouting', '效果：{routes}', {
        routes: [...groups.keys()].sort((left, right) => left - right)
          .map(rung => `${tierLabel(rung, rungCeiling)} → ${groups.get(rung).join('、')}`).join('；'),
      });
    }

    function renderMore() {
      const parts = [
        tt('autoEditorMoreAttempts', '最多试 {count} 条', { count: maxAttempts.value }),
        sticky.checked ? tt('autoEditorMoreSticky', '保持当前线路') : tt('autoEditorMoreNoSticky', '每次从第 1 条开始'),
      ];
      if (routingOn) {
        const choice = UNKNOWN_CHOICES.find(([value]) => value === onUnknownSelect.value) || UNKNOWN_CHOICES[0];
        parts.push(tt(choice[3], choice[4]));
      }
      moreSummary.replaceChildren(document.createTextNode(tt('autoEditorMoreTitle', '更多设置')),
        make('span', 'multicc-auto-editor-muted',
          tt('autoEditorMoreDetail', '（{detail}）', { detail: parts.join(' · ') })));
    }

    function configuredRouting() {
      return initialSelection && initialSelection.mode === 'auto' ? initialSelection.routing : null;
    }

    // The vault entry this gateway's key lives in: its own default, unless the
    // configured pool already used this same gateway and pinned a name (it may
    // have been set through the API). A key saved for another gateway is not this
    // one's key, so a stored name only ever follows its own gateway.
    function keyName() {
      const previous = configuredRouting();
      const previousGateway = routingGatewayOf(previous && previous.gateway);
      if (previous && previousGateway === routingGateway && previous.apiKeyName) {
        return String(previous.apiKeyName);
      }
      return ROUTING_GATEWAY_INFO[routingGateway].keyName;
    }

    function endpointProblem() {
      if (!routingOn || routingGateway !== CUSTOM_ROUTING_GATEWAY) return '';
      return customEndpointError(endpointInput.value);
    }

    // The per-gateway copy: which console to open and what a key looks like. Only
    // rebuilt when the gateway actually changes, because notify() runs on every
    // keystroke of an unrelated field.
    function syncGatewayCopy() {
      for (const [name, node] of gatewayButtons) setChecked(node, name === routingGateway);
      show(customBox, routingGateway === CUSTOM_ROUTING_GATEWAY);
      if (gatewayRendered === routingGateway) return;
      gatewayRendered = routingGateway;
      const info = ROUTING_GATEWAY_INFO[routingGateway];
      keyInput.placeholder = tt(info.placeholderKey, info.placeholder);
      keySteps.replaceChildren(
        make('li', '', tt(info.stepKey, info.step)),
        make('li', '', tt('autoEditorJevStepPaste', '粘贴到下面，点「保存并测试」')));
    }

    // Switching gateway re-checks that gateway's entry from scratch: the key, the
    // test verdict and anything typed for the previous one belong to the previous
    // entry, and carrying a pasted Vercel key over to OpenRouter's entry would
    // store it in the wrong place.
    function chooseGateway(name) {
      if (!ROUTING_GATEWAYS.includes(name) || name === routingGateway) return;
      routingGateway = name;
      keyFormOpen = false;
      keyInput.value = '';
      keyState = 'unknown';
      setTestResult('', '');
      syncGatewayCopy();
      // Consumes the in-flight check of the previous gateway through keyGeneration.
      checkKey();
      notify();
    }

    function setTestResult(text, tone) {
      testResult.textContent = text || '';
      testResult.classList.remove('good', 'bad');
      if (tone) testResult.classList.add(tone);
      show(testResult, !!text);
    }

    function renderJev() {
      const name = keyName();
      jevBox.classList.remove('ok', 'missing');
      const canSave = !!routingKey && typeof routingKey.save === 'function';
      const canTest = !!routingKey && typeof routingKey.test === 'function';
      let status;
      let detail = '';
      if (!routingKey) {
        status = tt('autoEditorJevTitle', 'Jev 判断难度');
        detail = tt('autoEditorJevKeyVaultOnly', 'key 从本机保险箱条目「{name}」读取，可在控制中心 →「敏感信息」里添加。', { name });
      } else if (keyState === 'checking' || keyState === 'unknown') {
        status = tt('autoEditorJevKeyChecking', '正在检查 Jev key…');
      } else if (keyState === 'present') {
        status = tt('autoEditorJevKeyPresent', 'Jev 已连接');
        detail = tt('autoEditorJevKeyPresentDetail', 'key 在本机保险箱 · {gateway} · {name}',
          { gateway: routingGatewayLabel(routingGateway), name });
        jevBox.classList.add('ok');
      } else if (keyState === 'missing') {
        status = tt('autoEditorJevKeyMissing', '还差一步：连接 Jev');
        detail = tt('autoEditorJevKeyMissingDetail', '它负责判断每条消息是简单还是复杂');
        jevBox.classList.add('missing');
      } else {
        status = tt('autoEditorJevKeyCheckFailed', '查不到 key 状态');
        detail = tt('autoEditorJevKeyCheckFailedDetail', '可以直接重新粘贴保存');
        jevBox.classList.add('missing');
      }
      keyStatus.textContent = status;
      keyDetail.textContent = detail;
      show(keyDetail, !!detail);
      const present = keyState === 'present';
      const formVisible = canSave && (keyFormOpen || keyState === 'missing' || keyState === 'error');
      show(keyChange, canSave && present);
      keyChange.textContent = keyFormOpen ? tt('autoEditorJevKeyCancel', '取消') : tt('autoEditorJevKeyChange', '更换 key');
      show(testButton, canTest && present);
      show(keySteps, canSave && keyState === 'missing');
      show(keyForm, formVisible);
      keyHelp.textContent = tt('autoEditorJevKeyHelp',
        'key 只存进本机保险箱（条目 {name}），不写进配置、不发给模型。', { name });
      show(keyHelp, formVisible);
      // A "connected" verdict stops being true once the key is gone; a failure
      // stays up so the user can still read why.
      if ((!canTest || !present) && testResult.classList.contains('good')) setTestResult('', '');
    }

    function checkKey() {
      if (!routingKey) return Promise.resolve();
      const generation = ++keyGeneration;
      keyState = 'checking';
      renderJev();
      return Promise.resolve().then(() => routingKey.check(keyName())).then(present => {
        if (destroyed || generation !== keyGeneration) return;
        keyState = present ? 'present' : 'missing';
        renderJev();
      }, () => {
        if (destroyed || generation !== keyGeneration) return;
        keyState = 'error';
        renderJev();
      });
    }

    // What the host's test endpoint is asked to evaluate: the same four fields a
    // pool persists, read once so a gateway switch mid-request cannot mix them.
    function testRequest() {
      return {
        apiKeyName: keyName(),
        gateway: routingGateway,
        ...(routingGateway === CUSTOM_ROUTING_GATEWAY ? {
          endpoint: endpointInput.value.trim(),
          model: gatewayModel.value.trim(),
        } : {}),
      };
    }

    function saveKey() {
      if (!routingKey || typeof routingKey.save !== 'function') return Promise.resolve();
      // Read once and clear at once: the pasted key never lingers in the form.
      const value = keyInput.value.trim();
      keyInput.value = '';
      if (!value) {
        setTestResult(tt('autoEditorJevKeyEmpty', '先把 key 粘贴到输入框里。'), 'bad');
        return Promise.resolve();
      }
      const generation = ++keyGeneration;
      // Both read once, before the request is built: a gateway switch can land
      // while a save is in flight, and the key must go to the entry it came from.
      const name = keyName();
      const gateway = routingGateway;
      keySave.disabled = true;
      setTestResult(tt('autoEditorJevKeySaving', '正在保存…'), '');
      return Promise.resolve()
        .then(() => routingKey.save(name, value, { gateway }))
        .then(() => {
          if (destroyed || generation !== keyGeneration) return null;
          keyState = 'present';
          keyFormOpen = false;
          setTestResult('', '');
          renderJev();
          return runTest();
        }, err => {
          if (destroyed || generation !== keyGeneration) return;
          setTestResult(tt('autoEditorJevKeySaveFailed', '保存失败：{reason}',
            { reason: (err && err.message) || String(err || '') }), 'bad');
        }).finally(() => { keySave.disabled = false; });
    }

    function describeJevFailure(result) {
      const code = String((result && result.code) || '');
      const status = Number(result && result.status) || 0;
      if (code === 'jev_key_missing') return tt('autoEditorJevErrKeyMissing', '保险箱里没有这个 key，请先粘贴保存。');
      if (status === 401 || status === 403 || code === 'jev_http_401' || code === 'jev_http_403') {
        return tt('autoEditorJevErrKeyInvalid', 'key 无效或没有权限（HTTP {status}），请检查后更换。', { status: status || code.slice(-3) });
      }
      if (code === 'jev_timeout') return tt('autoEditorJevErrTimeout', 'Jev 超时没有回应，稍后再试。');
      if (code === 'jev_network') {
        return tt('autoEditorJevErrNetwork', '连不上 {gateway}，检查网络或代理。',
          { gateway: routingGatewayLabel(routingGateway) });
      }
      if (code === 'test_unavailable') return tt('autoEditorJevErrUnavailable', '服务端还没有测试接口：重启 multicc 后再试。');
      const detail = result && result.detail ? ` · ${String(result.detail).slice(0, 160)}` : '';
      return tt('autoEditorJevErrOther', '测试失败：{code}', { code: code || 'unknown' }) + detail;
    }

    function runTest() {
      if (!routingKey || typeof routingKey.test !== 'function') return Promise.resolve();
      // A bad address is refused here as well as on save: the request would fail
      // anyway, and the reason is more useful than the upstream's 404.
      const problem = endpointProblem();
      if (problem) {
        setTestResult(problem, 'bad');
        return Promise.resolve();
      }
      const generation = keyGeneration;
      const request = testRequest();
      const sample = tt('autoEditorJevSample', '把 README 里的一个错别字改掉');
      testButton.disabled = true;
      setTestResult(tt('autoEditorJevTesting', '正在请 Jev 判断…'), '');
      return Promise.resolve()
        .then(() => routingKey.test({ ...request, text: sample }))
        .then(result => {
          if (destroyed || generation !== keyGeneration) return;
          if (result && result.ok) {
            setTestResult(tt('autoEditorJevTestOk', '✓ 连通了（{ms} ms）：「{sample}」→ {tier}', {
              ms: Math.round(Number(result.latencyMs) || 0),
              sample,
              tier: result.tier === 't1' ? tierLabel(1, 2) : tierLabel(2, 2),
            }), 'good');
            return;
          }
          if (result && result.code === 'jev_key_missing') keyState = 'missing';
          if (result && (result.status === 401 || result.status === 403)) keyFormOpen = true;
          renderJev();
          setTestResult(describeJevFailure(result), 'bad');
        }, err => {
          if (destroyed || generation !== keyGeneration) return;
          setTestResult(describeJevFailure({ code: 'request_failed', detail: err && err.message }), 'bad');
        })
        .finally(() => { testButton.disabled = false; });
    }

    function syncAttemptLimit() {
      const ceiling = Math.max(2, Math.min(MAX_ATTEMPTS, order.length));
      for (const option of maxAttempts.options) option.disabled = Number(option.value) > ceiling;
      if (Number(maxAttempts.value) > ceiling) maxAttempts.value = String(ceiling);
    }

    function syncCandidateLimit() {
      const full = order.length >= MAX_CANDIDATES;
      for (const row of allRows) row.querySelector('.multicc-auto-editor-add-one').disabled = full;
    }

    // Every provider the pool may name: the host's list plus whatever lanes are
    // loaded, so a line on another CLI is still recognised when its trust domain
    // is compared with the rest of the pool.
    function readProviders() {
      const extra = [];
      for (const entry of laneCache.values()) {
        if (Array.isArray(entry.providers)) extra.push(...entry.providers);
      }
      return extra.length ? [...providers, ...extra] : providers;
    }

    function setRouting(on) {
      routingOn = !!on;
      setChecked(orderMode, !routingOn);
      setChecked(routingEnabled, routingOn);
      if (routingOn) container.classList.remove('is-order');
      else container.classList.add('is-order');
    }

    function notify() {
      showError('');
      // A custom address is validated as it is typed: it is the one part of the
      // routing config the server cannot describe for the user, and an address it
      // would reject must not look accepted while the pool is being edited.
      const problem = endpointProblem();
      endpointError.textContent = problem;
      show(endpointError, !!problem);
      syncAttemptLimit();
      syncCandidateLimit();
      syncGatewayCopy();
      // The lane policy only means something once a line leaves the session's
      // own CLI; a single-CLI pool shows neither the row nor a hint about it.
      const crossCli = selectionCrossesCli(enabledCandidates());
      show(cliSwitchRow, crossCli);
      show(cliSwitchHint, crossCli);
      setChecked(cliSwitchFailover, cliSwitchPolicy !== 'routing');
      setChecked(cliSwitchRouting, cliSwitchPolicy === 'routing');
      cliSwitchHint.textContent = cliSwitchPolicy === 'routing'
        ? tt('autoEditorCliSwitchDetailRouting', '每轮的选择落在哪条车道就换到哪条。')
        : tt('autoEditorCliSwitchDetailFailover', '本车道还有可用线路时不动（换道要一次上下文交接）。');
      // Tiering decides how a routed pool builds its ladder, so both the row and
      // the per-line controls that only exist in price mode follow it.
      const priceTiering = tiering === PRICE_TIERING;
      show(tieringRow, routingOn);
      show(tieringHint, routingOn);
      setChecked(tieringManual, !priceTiering);
      setChecked(tieringPrice, priceTiering);
      if (priceTiering) container.classList.add('is-price');
      else container.classList.remove('is-price');
      tieringHint.textContent = priceTiering
        ? tt('autoEditorTieringDetailPrice', '每轮按价格表排档，便宜的先上；标了「自动选模型」的线路还会按这一轮的判断挑模型。')
        : tt('autoEditorTieringDetailManual', '每条线路的难度档位由你亲手标注。');
      if (routingOn && !priceTiering) syncRungs();
      // 自动选模型只在「按价格自动分层」下成立（服务端也只接受这种组合）。切回手动
      // 分层时把它放掉：一个看不见的勾不该把随后的保存顶回去。
      if (!(routingOn && priceTiering)) {
        for (const row of allRows) {
          const toggle = row.querySelector('.multicc-auto-editor-auto-model');
          if (!toggle || !toggle.checked) continue;
          toggle.checked = false;
          const model = row.querySelector('.multicc-auto-editor-model');
          if (model) model.disabled = false;
        }
      }
      modeHint.textContent = routingOn
        ? tt('autoEditorModeRoutingDetail', '每条消息先让 Jev 判断难易：简单的交给便宜模型，复杂的交给强模型。')
        : tt('autoEditorModeOrderDetail', '从第 1 条开始用；它出错或额度用完，就自动换下一条。');
      listHint.textContent = routingOn
        ? (priceTiering
          ? tt('autoEditorListHintPrice', '按价格排档；勾了「自动选模型」的线路由价格表挑模型')
          : tt('autoEditorListHintRouting', '给每条选它负责简单还是复杂任务，同类里按顺序尝试'))
        : tt('autoEditorListHintOrder', '从上往下尝试，↑↓ 调整顺序');
      show(jevBox, routingOn);
      show(unknownRow, routingOn);
      renderSummary();
      renderMore();
      // The key is looked up the first time routing is switched on, not on
      // every open of the editor.
      if (routingOn && keyState === 'unknown') checkKey();
      else renderJev();
      if (onChange) {
        onChange(Object.freeze({
          protocol,
          enabledCount: order.length,
        }));
      }
    }

    function loadPresets() {
      return presetStore ? normalizePresets(presetStore.load()) : [];
    }

    function storePresets(list) {
      if (presetStore) presetStore.save(list);
    }

    function presetLabel(preset) {
      const byId = new Map(providers.map(provider => [String(provider.id), provider]));
      const chain = preset.candidates.slice().sort((a, b) => a.priority - b.priority)
        .map(candidate => byId.get(String(candidate.providerId))?.name || candidate.providerId).join(' → ');
      const head = preset.recent ? tt('autoEditorPresetRecent', '最近使用') : preset.name || chain;
      return preset.recent || preset.name ? `${head} · ${chain}` : head;
    }

    // 只列当前协议、且里面至少还有两个 Provider 仍在本协议池里的预设。
    function usablePresets() {
      const pool = new Set(providersForProtocol(providers, protocol).map(provider => String(provider.id)));
      return loadPresets().filter(preset => preset.protocol === protocol
        && preset.candidates.filter(candidate => pool.has(String(candidate.providerId))).length >= 2);
    }

    function showPresetForm(open) {
      show(presetForm, open);
      show(presetOpen, !open);
      if (open && typeof presetName.focus === 'function') presetName.focus();
    }

    function renderPresets() {
      const presets = protocol ? usablePresets() : [];
      const placeholder = make('option', '', presets.length
        ? tt('autoEditorPresetPlaceholder', '套用预设…')
        : tt('autoEditorPresetEmpty', '还没有预设'));
      placeholder.value = '';
      presetSelect.replaceChildren(placeholder, ...presets.map(preset => {
        const option = make('option', '', presetLabel(preset));
        option.value = preset.id;
        return option;
      }));
      presetSelect.value = '';
      presetSelect.disabled = !presets.length;
      presetDelete.disabled = true;
      show(presetDelete, false);
      showPresetForm(false);
    }

    function applyPreset(id) {
      const preset = loadPresets().find(item => item.id === id);
      if (!preset) return false;
      initialSelection = {
        version: 1, mode: 'auto', protocol: preset.protocol,
        candidates: preset.candidates.map(candidate => ({ ...candidate, enabled: true })),
        maxAttempts: preset.maxAttempts, sticky: preset.sticky !== false, allowCrossTrust: false,
      };
      render();
      presetSelect.value = id;
      presetDelete.disabled = false;
      show(presetDelete, true);
      presetStatus.textContent = tt('autoEditorPresetApplied', '已套用预设，确认无误后保存即可。');
      notify();
      return true;
    }

    function savePreset() {
      const result = controller.read({ remember: false, forPreset: true });
      if (!result.ok || !result.value) return result;
      const name = presetName.value.trim();
      storePresets(rememberPreset(loadPresets(), result.value, { name, now: now() }));
      presetName.value = '';
      renderPresets();
      presetStatus.textContent = tt('autoEditorPresetSaved', '已保存为预设。');
      return result;
    }

    presetSelect.addEventListener('change', () => {
      presetStatus.textContent = '';
      if (presetSelect.value) applyPreset(presetSelect.value);
      else {
        presetDelete.disabled = true;
        show(presetDelete, false);
      }
    });
    presetOpen.addEventListener('click', () => showPresetForm(true));
    presetCancel.addEventListener('click', () => showPresetForm(false));
    presetSave.addEventListener('click', savePreset);
    presetName.addEventListener('keydown', event => {
      if (event && event.key === 'Enter') savePreset();
    });
    presetDelete.addEventListener('click', () => {
      const id = presetSelect.value;
      if (!id) return;
      storePresets(loadPresets().filter(item => item.id !== id));
      renderPresets();
      presetStatus.textContent = tt('autoEditorPresetDeleted', '预设已删除。');
    });

    // ── 跨 CLI：别的车道的 Provider 目录 ───────────────────────────────────────
    //
    // A pool that spans lanes needs each lane's provider list, and the only
    // endpoint that knows one is /api/providers?cli=… — the same one the host
    // page used for the current CLI. Lanes are fetched once, on demand, and a
    // lane that cannot be fetched degrades to "no provider available" rather
    // than to a row pointing at a route the server will refuse.

    function laneEntry(cli) {
      const entry = laneCache.get(cli) || null;
      return entry;
    }

    // The lane's providers for THIS pool's protocol: a cross-CLI pool validates
    // each lane on its own, and every lane has to stay single-protocol, so a
    // line whose protocol differs from the pool's is never offered.
    function laneProviders(cli) {
      const entry = laneEntry(cli);
      const list = entry && Array.isArray(entry.providers) ? entry.providers : null;
      if (!list) return null;
      return list.filter(provider => provider && provider.id && protocolOf(provider) === protocol);
    }

    function ensureLane(cli) {
      const lane = normalizeCli(cli);
      if (!lane || lane === homeCli) return Promise.resolve([]);
      const existing = laneEntry(lane);
      if (existing) return existing.promise;
      const entry = { providers: null, promise: null };
      entry.promise = Promise.resolve().then(() => loadCliProviders(lane)).then(list => {
        entry.providers = Array.isArray(list) ? list.filter(Boolean) : [];
        return entry.providers;
      }, () => {
        entry.providers = [];
        return entry.providers;
      });
      laneCache.set(lane, entry);
      return entry.promise;
    }

    // Provider ids are looked up by the server inside the lane's own catalog,
    // and the pool's protocol decides which of that catalog's providers a line
    // may use, so the fallback for a lane is its first non-official route.
    function laneDefaultProvider(list) {
      return list.find(provider => provider.isOfficial !== true) || list[0] || null;
    }

    function applyRowProvider(row, provider) {
      const state = rowState.get(row);
      if (state) state.provider = provider || null;
      row.dataset.providerId = provider ? String(provider.id) : '';
      const nameText = row.querySelector('.multicc-auto-editor-name-text');
      if (nameText) {
        nameText.textContent = String((provider && formatProvider(provider)) || (provider && provider.id) || '');
        nameText.title = nameText.textContent;
      }
      const model = row.querySelector('.multicc-auto-editor-model');
      const custom = row.querySelector('.multicc-auto-editor-model-custom');
      show(custom, false);
      if (custom) custom.value = '';
      if (!provider) {
        model.replaceChildren();
        model.disabled = true;
        return;
      }
      model.disabled = false;
      // The model list belongs to the provider, so a lane switch rebuilds it;
      // fillModels keeps whatever is still on the new list and otherwise falls
      // back to the new provider's own default.
      fillModels(model, provider, { model: model.value || null });
      if (candidateModelChoices(provider, null).length === 1) emptyCatalogRows.push({ model, provider });
    }

    function fillProviderSelect(row, list, selectedId, { loading = false } = {}) {
      const select = row.querySelector('.multicc-auto-editor-provider');
      if (!select) return;
      select.replaceChildren();
      select.disabled = !!loading;
      if (loading) {
        const option = make('option', '', tt('autoEditorLaneLoading', '加载中…'));
        option.value = '';
        select.appendChild(option);
        return;
      }
      if (!list.length) {
        const option = make('option', '', tt('autoEditorLaneEmpty', '该 CLI 下没有可用的 Provider'));
        option.value = '';
        select.appendChild(option);
        applyRowProvider(row, null);
        return;
      }
      for (const provider of list) {
        const option = make('option', '', String(formatProvider(provider) || provider.id));
        option.value = String(provider.id);
        select.appendChild(option);
      }
      const chosen = list.find(provider => String(provider.id) === String(selectedId))
        || laneDefaultProvider(list);
      select.value = String(chosen.id);
      applyRowProvider(row, chosen);
    }

    // Switching a row's lane swaps which catalog its provider comes from. A row
    // put back on the session's own CLI keeps the provider it started with, so
    // an accidental lane change and back costs nothing.
    function setRowCli(row, value) {
      const cli = normalizeCli(value);
      const state = rowState.get(row);
      const select = row.querySelector('.multicc-auto-editor-cli');
      row.dataset.cli = cli;
      if (select && select.value !== cli) select.value = cli;
      const field = row.querySelector('.multicc-auto-editor-provider-field');
      if (!cli) {
        show(field, false);
        fillProviderSelect(row, providersForProtocol(providers, protocol),
          state && state.homeProvider ? state.homeProvider.id : row.dataset.providerId);
        notify();
        return;
      }
      show(field, true);
      fillProviderSelect(row, laneProviders(cli) || [], row.dataset.providerId,
        { loading: laneProviders(cli) === null });
      notify();
      if (laneProviders(cli) !== null) return;
      ensureLane(cli).then(() => {
        if (destroyed || rowCli(row) !== cli) return;
        fillProviderSelect(row, laneProviders(cli) || [], row.dataset.providerId);
        notify();
      });
    }

    // One line of the pool. `cli` is the row's lane: '' means the session's own
    // CLI (the provider then comes from the host's list, one row per provider),
    // and a named lane means this row picks a provider out of that lane's own
    // catalog instead.
    function buildRow(provider, configured, configuredSelection, cli = '') {
      const lane = normalizeCli(cli);
      const providerId = String(provider.id);
      const label = provider.name || providerId;
      const row = make('div', 'multicc-auto-editor-row');
      row.dataset.providerId = providerId;
      row.dataset.cli = lane;
      rowState.set(row, { cli: lane, provider, homeProvider: provider });
      const name = make('div', 'multicc-auto-editor-name');
      const nameText = make('span', 'multicc-auto-editor-name-text', String(formatProvider(provider) || providerId));
      nameText.title = nameText.textContent;
      const cliField = make('label', 'multicc-auto-editor-cli-field');
      const cliSelect = make('select', 'multicc-auto-editor-cli');
      cliSelect.setAttribute('aria-label', tt('autoEditorCliAria', '{provider} 的 CLI', { provider: label }));
      cliSelect.title = tt('autoEditorCliLabel', '这条线路跑在哪个 CLI');
      // '' first: the session's own lane is the default every pool starts on,
      // and the only value that writes no `cli` field at all.
      const choices = ['', ...AUTO_CLIS.filter(value => value !== 'claude' && value !== 'codex')];
      // A saved legacy row keeps its ID, represented by the same family option.
      const visibleChoices = choices.map(value => (lane === 'claude' && value === 'claude-exp')
        || (lane === 'codex' && value === 'codex-exp') ? lane : value);
      for (const value of visibleChoices) {
        const option = make('option', '', cliOptionLabel(value));
        option.value = value;
        cliSelect.appendChild(option);
      }
      cliSelect.value = lane;
      cliField.appendChild(cliSelect);
      name.append(nameText, cliField);
      const model = make('select', 'multicc-auto-editor-model');
      model.setAttribute('aria-label', tt('autoEditorModelAria', '{provider} 模型', { provider: label }));
      const preferredModel = candidateModel(provider, configured);
      fillModels(model, provider, configured);
      model.value = preferredModel || '';
      const modelField = make('div', 'multicc-auto-editor-model-field');
      // Which of the lane's providers this line runs — only a foreign lane has
      // a choice, because the current CLI is the row list itself.
      const providerField = make('label', 'multicc-auto-editor-provider-field');
      const providerSelect = make('select', 'multicc-auto-editor-provider');
      providerSelect.setAttribute('aria-label',
        tt('autoEditorProviderAria', '{cli} 的 Provider', { cli: cliName(lane) }));
      providerField.appendChild(providerSelect);
      show(providerField, !!lane);
      const custom = make('input', 'multicc-auto-editor-model-custom');
      custom.type = 'text';
      custom.maxLength = 200;
      custom.placeholder = tt('airTaskSettingsCustomModelOption', '自定义模型 ID');
      custom.setAttribute('aria-label',
        tt('autoEditorModelAria', '{provider} 模型', { provider: label }));
      custom.style.cssText = 'box-sizing:border-box;width:100%;min-width:0;margin-top:5px';
      show(custom, false);
      // 自动选模型：这一行不钉住模型，每轮由路由器（Jev）挑。它与钉住的模型互斥
      // （服务端也只在池子带 routing 时才接受 autoModel），所以勾上就把下拉清空并禁掉。
      const autoField = make('label', 'multicc-auto-editor-auto-model-field');
      const autoModel = make('input', 'multicc-auto-editor-auto-model');
      autoModel.type = 'checkbox';
      autoModel.checked = configured?.autoModel === true;
      autoField.title = tt('autoEditorAutoModelHint', '这一行的模型每轮按价格档现挑，所以没有钉死的模型。');
      autoField.append(autoModel, document.createTextNode(tt('autoEditorAutoModel', '自动选模型')));
      modelField.append(providerField, model, custom, autoField);
      // A line with no catalog of its own (an imported relay, for one) needs the
      // same suggestions the manual picker offers; they are resolved after the
      // rows exist so rendering never waits on a request.
      if (candidateModelChoices(provider, null).length === 1) emptyCatalogRows.push({ model, provider });
      const tier = segment('multicc-auto-editor-tier',
        tt('autoEditorTierAria', '{provider} 负责的任务', { provider: label }));
      // A pool that already routes keeps its own ladder; every other row is
      // left unchosen so syncRungs() can guess it from the model name.
      const ladder = configuredSelection?.routing?.tiers || [];
      const seeded = configured && configuredSelection?.routing ? rungFor(configured, ladder, 0) : 0;
      if (seeded) tier.dataset.rung = String(seeded);
      const act = make('span', 'multicc-auto-editor-act');
      const iconButton = (className, glyph, key, fallback) => {
        const node = button(`multicc-auto-editor-icon ${className}`, glyph);
        node.title = tt(key, fallback, { provider: label });
        node.setAttribute('aria-label', node.title);
        act.appendChild(node);
        return node;
      };
      const up = iconButton('multicc-auto-editor-move-up', '↑', 'autoEditorMoveUpAria', '{provider} 往前移');
      const down = iconButton('multicc-auto-editor-move-down', '↓', 'autoEditorMoveDownAria', '{provider} 往后移');
      const remove = iconButton('multicc-auto-editor-remove', '✕', 'autoEditorRemoveAria', '不再使用 {provider}');
      const add = button('multicc-auto-editor-add-one', tt('autoEditorAddOne', '＋ 添加'));
      add.setAttribute('aria-label', tt('autoEditorEnableAria', '使用 {provider}', { provider: label }));
      act.appendChild(add);
      row.append(make('span', 'multicc-auto-editor-rank'), name, modelField, tier, act);
      up.addEventListener('click', () => moveRow(row, -1));
      down.addEventListener('click', () => moveRow(row, 1));
      remove.addEventListener('click', () => useRow(row, false));
      add.addEventListener('click', () => useRow(row, true));
      cliSelect.addEventListener('change', () => setRowCli(row, cliSelect.value));
      providerSelect.addEventListener('change', () => {
        const list = lane ? (laneProviders(lane) || []) : providersForProtocol(providers, protocol);
        applyRowProvider(row, list.find(item => String(item.id) === providerSelect.value) || null);
        notify();
      });
      model.addEventListener('change', () => {
        show(custom, model.value === '__custom__');
        if (model.value === '__custom__' && typeof custom.focus === 'function') custom.focus();
        notify();
      });
      custom.addEventListener('input', notify);
      autoModel.addEventListener('change', () => {
        model.disabled = autoModel.checked;
        notify();
      });
      if (autoModel.checked) model.disabled = true;
      // A foreign row picks its provider out of the lane's catalog, which may
      // still be in flight; the configured provider id is what it starts on.
      if (lane) {
        const list = laneProviders(lane);
        fillProviderSelect(row, list || [], providerId, { loading: list === null });
      }
      return row;
    }

    function render() {
      if (destroyed) return;
      const generation = ++modelGeneration;
      emptyCatalogRows = [];
      renderPresets();
      container.style.display = protocol ? '' : 'none';
      allRows = [];
      order = [];
      list.replaceChildren();
      poolList.replaceChildren();
      showError('');
      if (!protocol) return;
      const configuredSelection = initialSelection && initialSelection.mode === 'auto'
        && initialSelection.protocol === protocol ? initialSelection : null;
      const configuredCandidates = Array.isArray(configuredSelection?.candidates)
        ? configuredSelection.candidates : [];
      // A line is identified by its lane *and* its provider: one route may serve
      // two lanes of the same pool, and the server draws the same distinction.
      const byKey = new Map(configuredCandidates
        .map(candidate => [`${normalizeCli(candidate.cli)}\n${String(candidate.providerId || '')}`, candidate]));
      // The current CLI's own line for a provider: the lane it named, or the
      // plain field every pool written before cross-CLI has.
      const homeOf = providerId => byKey.get(`${homeCli}\n${providerId}`)
        || byKey.get(`\n${providerId}`) || null;
      const defaultsById = new Map(defaultCandidates(providers, protocol)
        .map(candidate => [candidate.providerId, candidate]));
      // Both pool-level choices are seeded from the stored pool and fall back to
      // their defaults, so a pool that predates them opens exactly as before.
      // Only a different stored pool re-seeds them: a host that re-renders the
      // same selection (a provider list refreshed under it) must not undo a
      // toggle the user just made.
      const seedKey = configuredSelection
        ? `${configuredSelection.routing?.tiering || ''}|${configuredSelection.cliSwitch || ''}`
        : '';
      if (seedKey !== seededKey) {
        seededKey = seedKey;
        tiering = configuredSelection?.routing?.tiering === PRICE_TIERING
          ? PRICE_TIERING : DEFAULT_ROUTING_TIERING;
        cliSwitchPolicy = cliSwitchOf({ cliSwitch: configuredSelection?.cliSwitch });
      }
      const used = [];
      const homeProviders = providersForProtocol(providers, protocol);
      homeProviders.forEach((provider, index) => {
        const providerId = String(provider.id);
        const configured = homeOf(providerId);
        const row = buildRow(provider, configured, configuredSelection, '');
        allRows.push(row);
        const enabled = configuredSelection ? !!configured && configured.enabled !== false : defaultsById.has(providerId);
        if (enabled) {
          const priority = Number(configured?.priority || defaultsById.get(providerId)?.priority) || 100 + index;
          used.push({ row, priority, index });
        }
      });
      // Lines on another CLI have no row in the host's list — that list is the
      // session's own lane — so each one gets a row of its own, standing on the
      // id it was configured with until that lane's catalog arrives.
      let foreignIndex = homeProviders.length;
      for (const candidate of configuredCandidates) {
        const lane = normalizeCli(candidate.cli);
        const providerId = String(candidate.providerId || '');
        if (!lane || lane === homeCli || !providerId) continue;
        const row = buildRow({ id: providerId, name: providerId, protocol }, candidate,
          configuredSelection, lane);
        allRows.push(row);
        foreignIndex += 1;
        if (candidate.enabled !== false) {
          used.push({
            row,
            priority: Number(candidate.priority) || 100 + foreignIndex,
            index: foreignIndex,
          });
        }
      }
      order = used.sort((left, right) => left.priority - right.priority || left.index - right.index)
        .slice(0, MAX_CANDIDATES).map(item => item.row);
      rungCeiling = 0;
      arrange();
      // A pool with fewer than two lines can't run; open the add list for it.
      addBox.open = order.length < 2;
      maxAttempts.value = String(configuredSelection?.maxAttempts
        || Math.max(2, Math.min(3, order.length)));
      sticky.checked = configuredSelection ? configuredSelection.sticky !== false : true;
      // The gateway belongs to the routing config, not to the session: seed it
      // from the configured pool so re-saving keeps the same one. A pool that
      // predates the field has none, and it was always evaluated through Vercel.
      const configuredRouting = configuredSelection?.routing || null;
      routingGateway = routingGatewayOf(configuredRouting && configuredRouting.gateway);
      const custom = routingGateway === CUSTOM_ROUTING_GATEWAY;
      endpointInput.value = custom && configuredRouting.endpoint ? String(configuredRouting.endpoint) : '';
      gatewayModel.value = custom && configuredRouting.model ? String(configuredRouting.model) : '';
      // The per-gateway copy is rebuilt on the next notify(), even when the
      // gateway itself did not change: the language may have.
      gatewayRendered = null;
      setRouting(!!configuredSelection?.routing);
      onUnknownSelect.value = String(configuredSelection?.routing?.onUnknown || 'strong');
      notify();
      // Other lanes are fetched after the rows exist, one request per lane and
      // only for lanes some line actually names, so an untouched pool costs none.
      for (const lane of new Set(allRows.map(rowCli).filter(value => value && value !== homeCli))) {
        ensureLane(lane).then(() => {
          if (destroyed || generation !== modelGeneration) return;
          for (const row of allRows) {
            if (rowCli(row) !== lane) continue;
            fillProviderSelect(row, laneProviders(lane) || [], row.dataset.providerId);
          }
          notify();
          fillEmptyCatalogs(generation);
        }).catch(() => {});
      }
      fillEmptyCatalogs(generation);
    }

    // Rows whose line declares no models of its own are refilled once a catalog
    // arrives — the local one for the session's CLI, or the row's own lane list
    // when a foreign lane landed with one. Rendering never waits on either.
    function fillEmptyCatalogs(generation) {
      if (!emptyCatalogRows.length) return;
      Promise.resolve().then(() => loadModels(protocol)).then(models => {
        if (destroyed || generation !== modelGeneration || !Array.isArray(models)) return;
        for (const { model, provider } of emptyCatalogRows) {
          fillModels(model, provider, { model: model.value }, models);
        }
      }).catch(() => {});
    }

    maxAttempts.addEventListener('change', notify);
    sticky.addEventListener('change', notify);
    orderMode.addEventListener('click', () => {
      setRouting(false);
      notify();
    });
    routingEnabled.addEventListener('click', () => {
      setRouting(true);
      notify();
    });
    onUnknownSelect.addEventListener('change', notify);
    cliSwitchFailover.addEventListener('click', () => {
      cliSwitchPolicy = DEFAULT_CLI_SWITCH;
      notify();
    });
    cliSwitchRouting.addEventListener('click', () => {
      cliSwitchPolicy = 'routing';
      notify();
    });
    tieringManual.addEventListener('click', () => {
      tiering = DEFAULT_ROUTING_TIERING;
      notify();
    });
    tieringPrice.addEventListener('click', () => {
      tiering = PRICE_TIERING;
      notify();
    });
    keySave.addEventListener('click', saveKey);
    keyInput.addEventListener('keydown', event => {
      if (event && event.key === 'Enter') saveKey();
    });
    keyChange.addEventListener('click', () => {
      keyFormOpen = !keyFormOpen;
      renderJev();
      if (keyFormOpen && typeof keyInput.focus === 'function') keyInput.focus();
    });
    testButton.addEventListener('click', runTest);
    endpointInput.addEventListener('input', notify);
    gatewayModel.addEventListener('input', notify);

    const controller = Object.freeze({
      setContext(next = {}) {
        if (destroyed) return;
        if (Object.prototype.hasOwnProperty.call(next, 'providers')) {
          providers = Array.isArray(next.providers) ? next.providers : [];
        }
        if (Object.prototype.hasOwnProperty.call(next, 'protocol')) {
          protocol = PROTOCOL_SET.has(next.protocol) ? next.protocol : null;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'initialSelection')) {
          initialSelection = next.initialSelection || null;
        }
        render();
      },
      read(readOptions = {}) {
        if (destroyed) return fail(tt('autoEditorDestroyed', 'Auto Provider 编辑器已关闭。'), 'editor_destroyed');
        const result = serializeDraft({
          protocol,
          providers: readProviders(),
          candidates: rawCandidates(),
          maxAttempts: Number(maxAttempts.value),
          sticky: sticky.checked,
          routingEnabled: routingOn,
          // Both are pool-level: the lane policy is only written when some line
          // spans a lane, and the tiering only ridealong with a routing config.
          tiering,
          cliSwitch: cliSwitchPolicy,
          routingGateway,
          routingEndpoint: endpointInput.value.trim(),
          routingModel: gatewayModel.value.trim(),
          routingOnUnknown: onUnknownSelect.value,
          initialRouting: (initialSelection && initialSelection.mode === 'auto'
            && initialSelection.routing) || null,
        });
        showError(result.ok ? '' : result.error);
        // 宿主读出一份有效池子就意味着它要被用上了：顺手记进「最近使用」。
        if (result.ok && result.value && readOptions.remember !== false && presetStore) {
          storePresets(rememberPreset(loadPresets(), result.value, { recent: true, now: now() }));
        }
        return result;
      },
      applyPreset,
      savePreset,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        laneCache.clear();
        rowState.clear();
        container.replaceChildren();
        container.classList.remove('multicc-auto-editor', 'is-order', 'is-price');
        container.style.display = 'none';
      },
    });
    render();
    return controller;
  }

  return Object.freeze({
    AUTO_CLIS,
    AUTO_PREFIX,
    CLI_SWITCH_POLICIES,
    CUSTOM_ROUTING_GATEWAY,
    CUSTOM_ROUTING_MODEL,
    DEFAULT_CLI_SWITCH,
    DEFAULT_ROUTING_GATEWAY,
    DEFAULT_ROUTING_TIERING,
    MAX_ATTEMPTS,
    MAX_CANDIDATES,
    MAX_ROUTING_ENDPOINT_CHARS,
    MAX_TIERS,
    PRICE_TIERING,
    PROTOCOLS,
    ROUTING_API_KEY_NAME,
    ROUTING_GATEWAYS,
    ROUTING_GATEWAY_INFO,
    ROUTING_PROVIDER,
    availableProtocols,
    candidateModel,
    candidateModelChoices,
    customEndpointError,
    defaultSelection,
    mount,
    optionValue,
    protocolFromValue,
    protocolLabel,
    protocolOf,
    providersForProtocol,
    rememberPreset,
    routingGatewayDescription,
    routingGatewayLabel,
    routingGatewayOf,
    selectionCrossesTrust,
    serializeDraft,
  });
});
