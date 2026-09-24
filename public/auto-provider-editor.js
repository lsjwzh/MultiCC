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
  // 候选池预设：每次新建 Auto Provider 都要重新勾一遍候选、调一遍优先级太费事，
  // 所以可以把配好的池子存成具名预设，也会自动记住最近真正用过的几份。存在浏览器
  // localStorage 里 —— 同源的 chat 弹窗、manage 任务板、Air 任务配置共用一份。
  const PRESET_KEY = 'multicc.autoProvider.presets.v1';
  const MAX_NAMED_PRESETS = 20;
  const MAX_RECENT_PRESETS = 5;
  // Difficulty routing talks to Jev through the Vercel AI Gateway; the key lives
  // in the local vault under this name and never reaches the browser.
  const ROUTING_PROVIDER = 'jev';
  const ROUTING_API_KEY_NAME = 'vercel-api-key';

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
    // 'strong' is the server default: only written when chosen, or when the pool
    // already carried it, so a plain routed pool keeps its minimal wire shape.
    const onUnknown = draft.routingOnUnknown || (previous && previous.onUnknown) || null;
    const writeOnUnknown = onUnknown && (onUnknown !== 'strong' || (previous && previous.onUnknown));
    if (candidates.length < 2) {
      return fail(tt('autoEditorRoutingNeedsTwo', '按难度路由至少需要两个候选 Provider。'),
        'insufficient_candidates');
    }
    const rungs = [...new Set(candidates.map(candidate => Number(candidate.rung) || 0))]
      .filter(rung => rung > 0).sort((left, right) => left - right);
    if (rungs.length < 2) {
      return fail(tt('autoEditorRoutingNeedsTwoTiers', '按难度分配时，至少要一条线路负责简单任务、另一条负责复杂任务。'),
        'provider_routing_requires_tiers');
    }
    if (rungs.length > MAX_TIERS) {
      return fail(tt('autoEditorRoutingTooManyTiers', '最多 {max} 个档位。', { max: MAX_TIERS }),
        'invalid_provider_routing');
    }
    const keyByRung = new Map(rungs.map((rung, index) => [rung, `t${index + 1}`]));
    return Object.freeze({
      ok: true,
      // `rung` is the editor's own control value and never travels on the wire.
      candidates: candidates.map(({ rung, ...candidate }) => ({
        ...candidate,
        tier: keyByRung.get(Number(rung) || 0),
      })),
      value: Object.freeze({
        version: 1,
        provider: ROUTING_PROVIDER,
        apiKeyName: previous && previous.apiKeyName ? String(previous.apiKeyName) : ROUTING_API_KEY_NAME,
        // Never silently reset a knob the editor does not expose: the API can set
        // onUnknown/timeoutMs/model, and re-saving the pool must not undo it.
        ...(previous && previous.model ? { model: String(previous.model) } : {}),
        ...(writeOnUnknown ? { onUnknown: String(onUnknown) } : {}),
        ...(previous && previous.timeoutMs != null ? { timeoutMs: Number(previous.timeoutMs) } : {}),
        ...(previous && previous.escalation ? { escalation: { ...previous.escalation } } : {}),
        tiers: Object.freeze(rungs.map(rung => keyByRung.get(rung))),
      }),
    });
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
      if (!providerId || ids.has(providerId)) {
        return fail(providerId
          ? tt('autoEditorDuplicateProvider', 'Provider {provider} 重复。', { provider: providerId })
          : tt('autoEditorInvalidProvider', '候选 Provider 无效。'),
          providerId ? 'duplicate_provider' : 'invalid_provider');
      }
      const priority = Number(raw.priority == null ? index + 1 : raw.priority);
      if (!Number.isSafeInteger(priority) || priority < 1 || priority > 100) {
        return fail(tt('autoEditorInvalidPriority', '优先级必须是 1–100 的整数。'), 'invalid_priority');
      }
      ids.add(providerId);
      candidates.push({
        providerId,
        model: raw.model == null || String(raw.model).trim() === '' ? null : String(raw.model).trim(),
        priority,
        enabled: true,
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
    const providers = Array.isArray(draft.providers) ? draft.providers : [];
    const crossesTrust = selectionCrossesTrust(cleanCandidates, providers);
    if (crossesTrust && draft.crossTrustConfirmed !== true) {
      return fail(tt('autoEditorCrossTrustRequired', '混合 Official 与自管 Provider 前，请先确认跨上游发送风险。'),
        'cross_trust_confirmation_required');
    }
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
        allowCrossTrust: crossesTrust && draft.crossTrustConfirmed === true,
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
${P}-name{grid-area:name;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${P} ${P}-model-field{grid-area:model;display:grid;gap:0;min-width:0}
${P} ${P}-model{width:100%;min-width:0}
${P} ${P}-tier{grid-area:tier}
${P} ${P}-tier button{height:22px;padding:0 9px;font-size:11px}
${P}.is-order ${P}-tier{display:none}
${P}-act{grid-area:act;display:flex;gap:2px}
${P} ${P}-icon{width:24px;height:24px;padding:0;border-color:transparent;background:transparent;color:var(--ape-muted);font-size:13px}
${P}-list ${P}-add-one,${P}-pool :is(${P}-rank,${P}-model-field,${P}-model,${P}-tier,${P}-icon){display:none}
${P} ${P}-pool ${P}-row{display:flex;padding:4px 6px 4px 10px;border-style:dashed;background:transparent;color:var(--ape-muted)}
${P}-pool ${P}-name{flex:1 1 auto}
${P} ${P}-add-one{height:24px;border-color:transparent;background:transparent;color:var(--ape-accent)}
${P} ${P}-add{margin-top:8px}
${P} ${P}-add>summary{display:inline-block;padding:2px 0;margin-bottom:6px;color:var(--ape-accent);font-size:12px;cursor:pointer;list-style:none}
${P} ${P}-add>summary::-webkit-details-marker{display:none}
${P} ${P}-summary{margin-top:10px;padding:7px 10px;border-radius:8px;background:color-mix(in srgb,var(--ape-accent) 8%,transparent)}
${P} ${P}-summary.bad{background:color-mix(in srgb,var(--ape-warn) 10%,transparent);color:var(--ape-warn)}
${P}-error{margin-top:8px;color:var(--ape-danger)}
${P} ${P}-warning{display:grid;gap:6px;margin-top:10px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--ape-warn) 45%,transparent);border-radius:8px;color:var(--ape-warn)}
${P} ${P}-warning label{align-items:flex-start;color:var(--ape-fg)}
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
    // Every provider row of the protocol pool, in pool order; `order` holds the
    // rows in use, first = tried first. Unused rows wait in the "添加线路" list.
    let allRows = [];
    let order = [];
    let modelGeneration = 0;
    // Rows whose line declares no models at all, refilled once the local
    // catalog arrives (see the tail of render()).
    let emptyCatalogRows = [];
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

    const jevBox = make('div', 'multicc-auto-editor-jev');
    const jevLine = make('div', 'multicc-auto-editor-jev-line');
    const keyStatus = make('b', 'multicc-auto-editor-jev-status');
    const keyDetail = make('span', 'multicc-auto-editor-muted');
    const jevActions = make('span', 'multicc-auto-editor-jev-actions');
    const testButton = button('multicc-auto-editor-jev-test multicc-auto-editor-link', tt('autoEditorJevTest', '测试'));
    const keyChange = button('multicc-auto-editor-jev-key-change multicc-auto-editor-link',
      tt('autoEditorJevKeyChange', '更换 key'));
    jevActions.append(testButton, keyChange);
    jevLine.append(make('span', 'multicc-auto-editor-dot'), keyStatus, keyDetail, jevActions);
    const keySteps = make('ol', 'multicc-auto-editor-steps');
    keySteps.append(
      make('li', '', tt('autoEditorJevStepCreate', '打开 Vercel 控制台 → AI Gateway → API Keys，新建一个 key')),
      make('li', '', tt('autoEditorJevStepPaste', '粘贴到下面，点「保存并测试」')));
    const keyForm = make('div', 'multicc-auto-editor-jev-form');
    const keyInput = make('input', 'multicc-auto-editor-jev-key-input');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.placeholder = tt('autoEditorJevKeyPlaceholder', '粘贴 key（vck_ 开头）');
    const keySave = button('multicc-auto-editor-jev-key-save multicc-auto-editor-primary',
      tt('autoEditorJevKeySave', '保存并测试'));
    keyForm.append(keyInput, keySave);
    const keyHelp = make('div', 'multicc-auto-editor-fine');
    const testResult = make('div', 'multicc-auto-editor-result multicc-auto-editor-jev-test-result');
    testResult.setAttribute('aria-live', 'polite');
    testResult.style.display = 'none';
    jevBox.append(jevLine, keySteps, keyForm, keyHelp, testResult);

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
    const warning = make('div', 'multicc-auto-editor-warning');
    warning.style.display = 'none';
    const confirmLabel = make('label');
    const confirm = make('input', 'multicc-auto-editor-cross-trust-confirm');
    confirm.type = 'checkbox';
    confirmLabel.append(confirm, document.createTextNode(
      tt('autoEditorCrossTrustConfirm', '我确认允许本候选池跨这些上游发送对话上下文')));
    warning.append(make('div', '',
      tt('autoEditorCrossTrustWarning', '已选择 Official 与自管 Provider：同一对话上下文可能在自动切换时发送给多个上游。')),
    confirmLabel);

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
    stickyLabel.append(sticky, document.createTextNode(tt('autoEditorStickySuffix', ' 成功后优先沿用这条线路')));
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

    container.replaceChildren(top, modeRow, modeHint, jevBox, listHead, list, addBox, summary,
      error, warning, more);

    function rows() {
      return allRows.slice();
    }

    function tierOf(row) {
      return row.querySelector('.multicc-auto-editor-tier');
    }

    function rawCandidates() {
      return allRows.map(row => {
        const index = order.indexOf(row);
        return {
          providerId: row.dataset.providerId,
          model: rowModel(row) || null,
          priority: index < 0 ? null : index + 1,
          enabled: index >= 0,
          rung: Number(tierOf(row).dataset.value) || null,
        };
      });
    }

    function rowModel(row) {
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
      const name = row.querySelector('.multicc-auto-editor-name').textContent;
      return model ? tt('autoEditorLineWithModel', '{name}（{model}）', { name, model }) : name;
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
      if (!selectionCrossesTrust(enabledCandidates(), providers)) confirm.checked = false;
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
        sticky.checked ? tt('autoEditorMoreSticky', '沿用成功的线路') : tt('autoEditorMoreNoSticky', '每次从第 1 条开始'),
      ];
      if (routingOn) {
        const choice = UNKNOWN_CHOICES.find(([value]) => value === onUnknownSelect.value) || UNKNOWN_CHOICES[0];
        parts.push(tt(choice[3], choice[4]));
      }
      moreSummary.replaceChildren(document.createTextNode(tt('autoEditorMoreTitle', '更多设置')),
        make('span', 'multicc-auto-editor-muted',
          tt('autoEditorMoreDetail', '（{detail}）', { detail: parts.join(' · ') })));
    }

    function keyName() {
      const routing = initialSelection && initialSelection.mode === 'auto' ? initialSelection.routing : null;
      return routing && routing.apiKeyName ? String(routing.apiKeyName) : ROUTING_API_KEY_NAME;
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
        detail = tt('autoEditorJevKeyPresentDetail', 'key 在本机保险箱 · {name}', { name });
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
      keySave.disabled = true;
      setTestResult(tt('autoEditorJevKeySaving', '正在保存…'), '');
      return Promise.resolve().then(() => routingKey.save(keyName(), value)).then(() => {
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
      if (code === 'jev_network') return tt('autoEditorJevErrNetwork', '连不上 Vercel AI Gateway，检查网络或代理。');
      if (code === 'test_unavailable') return tt('autoEditorJevErrUnavailable', '服务端还没有测试接口：重启 multicc 后再试。');
      const detail = result && result.detail ? ` · ${String(result.detail).slice(0, 160)}` : '';
      return tt('autoEditorJevErrOther', '测试失败：{code}', { code: code || 'unknown' }) + detail;
    }

    function runTest() {
      if (!routingKey || typeof routingKey.test !== 'function') return Promise.resolve();
      const generation = keyGeneration;
      const sample = tt('autoEditorJevSample', '把 README 里的一个错别字改掉');
      testButton.disabled = true;
      setTestResult(tt('autoEditorJevTesting', '正在请 Jev 判断…'), '');
      return Promise.resolve()
        .then(() => routingKey.test({ apiKeyName: keyName(), text: sample }))
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

    function syncTrustWarning({ preserveConfirmation = true } = {}) {
      const mixed = selectionCrossesTrust(enabledCandidates(), providers);
      warning.style.display = mixed ? '' : 'none';
      if (!mixed || !preserveConfirmation) confirm.checked = false;
      return mixed;
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
      syncAttemptLimit();
      syncCandidateLimit();
      const crossesTrust = syncTrustWarning();
      if (routingOn) syncRungs();
      modeHint.textContent = routingOn
        ? tt('autoEditorModeRoutingDetail', '每条消息先让 Jev 判断难易：简单的交给便宜模型，复杂的交给强模型。')
        : tt('autoEditorModeOrderDetail', '从第 1 条开始用；它出错或额度用完，就自动换下一条。');
      listHint.textContent = routingOn
        ? tt('autoEditorListHintRouting', '给每条选它负责简单还是复杂任务，同类里按顺序尝试')
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
          crossesTrust,
          crossTrustConfirmed: confirm.checked,
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
      const result = controller.read({ remember: false });
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

    function buildRow(provider, configured, configuredSelection) {
      const providerId = String(provider.id);
      const label = provider.name || providerId;
      const row = make('div', 'multicc-auto-editor-row');
      row.dataset.providerId = providerId;
      const name = make('span', 'multicc-auto-editor-name', String(formatProvider(provider) || providerId));
      name.title = name.textContent;
      const model = make('select', 'multicc-auto-editor-model');
      model.setAttribute('aria-label', tt('autoEditorModelAria', '{provider} 模型', { provider: label }));
      const preferredModel = candidateModel(provider, configured);
      fillModels(model, provider, configured);
      model.value = preferredModel || '';
      const modelField = make('div', 'multicc-auto-editor-model-field');
      const custom = make('input', 'multicc-auto-editor-model-custom');
      custom.type = 'text';
      custom.maxLength = 200;
      custom.placeholder = tt('airTaskSettingsCustomModelOption', '自定义模型 ID');
      custom.setAttribute('aria-label',
        tt('autoEditorModelAria', '{provider} 模型', { provider: label }));
      custom.style.cssText = 'box-sizing:border-box;width:100%;min-width:0;margin-top:5px';
      show(custom, false);
      modelField.append(model, custom);
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
      model.addEventListener('change', () => {
        show(custom, model.value === '__custom__');
        if (model.value === '__custom__' && typeof custom.focus === 'function') custom.focus();
        notify();
      });
      custom.addEventListener('input', notify);
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
      const configuredById = new Map((configuredSelection?.candidates || [])
        .map(candidate => [String(candidate.providerId || ''), candidate]));
      const defaultsById = new Map(defaultCandidates(providers, protocol)
        .map(candidate => [candidate.providerId, candidate]));
      const used = [];
      providersForProtocol(providers, protocol).forEach((provider, index) => {
        const providerId = String(provider.id);
        const configured = configuredById.get(providerId);
        const row = buildRow(provider, configured, configuredSelection);
        allRows.push(row);
        const enabled = configuredSelection ? !!configured && configured.enabled !== false : defaultsById.has(providerId);
        if (enabled) {
          const priority = Number(configured?.priority || defaultsById.get(providerId)?.priority) || 100 + index;
          used.push({ row, priority, index });
        }
      });
      order = used.sort((left, right) => left.priority - right.priority || left.index - right.index)
        .slice(0, MAX_CANDIDATES).map(item => item.row);
      rungCeiling = 0;
      arrange();
      // A pool with fewer than two lines can't run; open the add list for it.
      addBox.open = order.length < 2;
      maxAttempts.value = String(configuredSelection?.maxAttempts
        || Math.max(2, Math.min(3, order.length)));
      sticky.checked = configuredSelection ? configuredSelection.sticky !== false : true;
      confirm.checked = configuredSelection?.allowCrossTrust === true;
      setRouting(!!configuredSelection?.routing);
      onUnknownSelect.value = String(configuredSelection?.routing?.onUnknown || 'strong');
      syncRungs();
      notify();
      if (emptyCatalogRows.length) {
        Promise.resolve().then(() => loadModels(protocol)).then(models => {
          if (destroyed || generation !== modelGeneration || !Array.isArray(models)) return;
          for (const { model, provider } of emptyCatalogRows) {
            fillModels(model, provider, { model: model.value }, models);
          }
        }).catch(() => {});
      }
    }

    maxAttempts.addEventListener('change', notify);
    sticky.addEventListener('change', notify);
    confirm.addEventListener('change', notify);
    orderMode.addEventListener('click', () => {
      setRouting(false);
      notify();
    });
    routingEnabled.addEventListener('click', () => {
      setRouting(true);
      notify();
    });
    onUnknownSelect.addEventListener('change', notify);
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
          providers,
          candidates: rawCandidates(),
          maxAttempts: Number(maxAttempts.value),
          sticky: sticky.checked,
          crossTrustConfirmed: confirm.checked,
          routingEnabled: routingOn,
          routingOnUnknown: onUnknownSelect.value,
          initialRouting: (initialSelection && initialSelection.mode === 'auto'
            && initialSelection.routing) || null,
        });
        showError(result.ok ? '' : result.error);
        if (!result.ok && result.code === 'cross_trust_confirmation_required') confirm.focus();
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
        container.replaceChildren();
        container.classList.remove('multicc-auto-editor', 'is-order');
        container.style.display = 'none';
      },
    });
    render();
    return controller;
  }

  return Object.freeze({
    AUTO_PREFIX,
    MAX_ATTEMPTS,
    MAX_CANDIDATES,
    MAX_TIERS,
    PROTOCOLS,
    ROUTING_API_KEY_NAME,
    ROUTING_PROVIDER,
    availableProtocols,
    candidateModel,
    candidateModelChoices,
    defaultSelection,
    mount,
    optionValue,
    protocolFromValue,
    protocolLabel,
    protocolOf,
    providersForProtocol,
    rememberPreset,
    selectionCrossesTrust,
    serializeDraft,
  });
});
