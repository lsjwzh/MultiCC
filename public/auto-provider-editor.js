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

  // Rung of a configured candidate in a declared ladder: the editor shows rungs
  // (1 = weakest) while the wire carries tier keys, so this is the one place the
  // two have to agree. `fallback` is the row's own priority rank.
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
    if (candidates.length < 2) {
      return fail(tt('autoEditorRoutingNeedsTwo', '按难度路由至少需要两个候选 Provider。'),
        'insufficient_candidates');
    }
    const rungs = [...new Set(candidates.map(candidate => Number(candidate.rung) || 0))]
      .filter(rung => rung > 0).sort((left, right) => left - right);
    if (rungs.length < 2) {
      return fail(tt('autoEditorRoutingNeedsTwoTiers', '按难度路由至少需要两个不同档位（简单任务与复杂任务各一档）。'),
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
        ...(previous && previous.onUnknown ? { onUnknown: String(previous.onUnknown) } : {}),
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
    style.textContent = `
      .multicc-auto-editor{border:1px solid var(--line-strong,#30363d);border-radius:8px;padding:10px;margin:0 0 12px;color:var(--text,#c9d1d9)}
      .multicc-auto-editor-title{font-size:12px;font-weight:600;margin-bottom:3px}
      .multicc-auto-editor-help{font-size:11px;color:var(--muted,#8b949e);line-height:1.45;margin-bottom:8px}
      .multicc-auto-editor-list{min-width:0}
      .multicc-auto-editor-row{display:grid;grid-template-columns:22px minmax(150px,1fr) 70px minmax(130px,1fr) 58px;gap:7px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line,#21262d)}
      .multicc-auto-editor-name{font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .multicc-auto-editor input[type=number],.multicc-auto-editor select{box-sizing:border-box;width:100%;min-width:0;background:var(--well,#0d1117);color:var(--text,#c9d1d9);border:1px solid var(--line-strong,#30363d);border-radius:5px;padding:5px}
      .multicc-auto-editor-error{color:var(--danger,#f85149);font-size:11px;margin:6px 0}
      .multicc-auto-editor-warning{color:var(--warning,#d29922);font-size:11px;line-height:1.45;margin:7px 0;padding:7px;border:1px solid color-mix(in srgb,var(--warning,#d29922) 45%,transparent);border-radius:6px}
      .multicc-auto-editor-warning label{display:flex;align-items:flex-start;gap:6px;margin-top:6px;color:var(--text,#c9d1d9)}
      .multicc-auto-editor-controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:11px;color:var(--muted,#8b949e)}
      .multicc-auto-editor-controls select{width:auto;padding:3px 6px}
      .multicc-auto-editor-presets{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 8px}
      .multicc-auto-editor-presets select{flex:1 1 180px;width:auto}
      .multicc-auto-editor-presets input[type=text]{box-sizing:border-box;flex:1 1 120px;min-width:0;background:var(--well,#0d1117);color:var(--text,#c9d1d9);border:1px solid var(--line-strong,#30363d);border-radius:5px;padding:5px}
      .multicc-auto-editor-presets button{border:1px solid var(--line-strong,#30363d);border-radius:5px;background:transparent;color:var(--text,#c9d1d9);padding:4px 9px;font-size:11px;cursor:pointer}
      .multicc-auto-editor-preset-status{flex-basis:100%;font-size:11px;color:var(--muted,#8b949e)}
      .multicc-auto-editor-routing-hint{font-size:11px;color:var(--muted,#8b949e);line-height:1.45;margin-top:6px}
      @media (max-width:640px){
        .multicc-auto-editor-row{grid-template-columns:22px minmax(0,1fr);gap:6px 8px;padding:9px 0}
        .multicc-auto-editor-name{white-space:normal;overflow:visible}
        .multicc-auto-editor-priority,.multicc-auto-editor-model,.multicc-auto-editor-tier{grid-column:2}
      }
    `;
    (document.head || document.body).appendChild(style);
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
    // Whether the vault holds the key routing will call Jev with. `null` means
    // the host hasn't checked yet (e.g. the /api/secrets round trip is still in
    // flight) — stay silent rather than flash a false warning. The editor never
    // reads the vault itself; the host resolves this and pushes it in.
    let routingKeyConfigured = options.routingKeyConfigured ?? null;
    let destroyed = false;
    const formatProvider = typeof options.formatProvider === 'function'
      ? options.formatProvider : provider => provider.name || provider.id;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const presetStore = options.presetStore === undefined ? defaultPresetStore() : options.presetStore;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    container.classList.add('multicc-auto-editor');
    const title = element(document, 'div', 'multicc-auto-editor-title',
      tt('autoEditorTitle', 'Auto Provider 候选池'));
    const help = element(document, 'div', 'multicc-auto-editor-help',
      tt('autoEditorHelp', '按优先级尝试；仅在首字节前且没有工具副作用时切换。新鲜额度已耗尽的候选会预先跳过。'));
    const list = element(document, 'div', 'multicc-auto-editor-list');
    const error = element(document, 'div', 'multicc-auto-editor-error');
    error.setAttribute('role', 'alert');
    error.style.display = 'none';
    const warning = element(document, 'div', 'multicc-auto-editor-warning');
    warning.style.display = 'none';
    const warningText = element(document, 'div', '',
      tt('autoEditorCrossTrustWarning', '已选择 Official 与自管 Provider：同一对话上下文可能在自动切换时发送给多个上游。'));
    const confirmLabel = element(document, 'label');
    const confirm = document.createElement('input');
    confirm.type = 'checkbox';
    confirm.className = 'multicc-auto-editor-cross-trust-confirm';
    confirmLabel.append(confirm, document.createTextNode(
      tt('autoEditorCrossTrustConfirm', '我确认允许本候选池跨这些上游发送对话上下文')));
    warning.append(warningText, confirmLabel);
    const controls = element(document, 'div', 'multicc-auto-editor-controls');
    const maxLabel = element(document, 'label', '', tt('autoEditorMaxAttemptsLabel', '最多尝试 '));
    const maxAttempts = document.createElement('select');
    maxAttempts.className = 'multicc-auto-editor-max-attempts';
    for (let value = 2; value <= MAX_ATTEMPTS; value += 1) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      maxAttempts.appendChild(option);
    }
    maxLabel.appendChild(maxAttempts);
    const stickyLabel = element(document, 'label');
    const sticky = document.createElement('input');
    sticky.type = 'checkbox';
    sticky.className = 'multicc-auto-editor-sticky';
    stickyLabel.append(sticky, document.createTextNode(tt('autoEditorStickySuffix', ' 成功后优先沿用')));
    const routingLabel = element(document, 'label');
    const routingEnabled = document.createElement('input');
    routingEnabled.type = 'checkbox';
    routingEnabled.className = 'multicc-auto-editor-routing';
    routingLabel.append(routingEnabled, document.createTextNode(
      tt('autoEditorRoutingSuffix', ' 按难度自动选档（Jev 逐条评估）')));
    controls.append(maxLabel, stickyLabel, routingLabel);
    const routingHint = element(document, 'div', 'multicc-auto-editor-routing-hint',
      tt('autoEditorRoutingHint', '档位 1 最弱、数字越大越强：简单任务给最低档，复杂任务给最高档。评估不可用时按最保守的档位兜底。'));
    routingHint.style.display = 'none';
    const routingKeyWarning = element(document, 'div', 'multicc-auto-editor-warning multicc-auto-editor-routing-key-warning',
      tt('autoEditorRoutingKeyMissing', '尚未配置 {key}：按难度路由会一直请求失败，全部回退到最保守档位。',
        { key: ROUTING_API_KEY_NAME }));
    routingKeyWarning.style.display = 'none';
    const presetBar = element(document, 'div', 'multicc-auto-editor-presets');
    const presetSelect = document.createElement('select');
    presetSelect.className = 'multicc-auto-editor-preset-select';
    presetSelect.setAttribute('aria-label', tt('autoEditorPresetPlaceholder', '套用已保存的预设…'));
    const presetName = document.createElement('input');
    presetName.type = 'text';
    presetName.className = 'multicc-auto-editor-preset-name';
    presetName.placeholder = tt('autoEditorPresetNamePlaceholder', '预设名称（可选）');
    const presetSave = element(document, 'button', 'multicc-auto-editor-preset-save', tt('autoEditorPresetSave', '保存为预设'));
    presetSave.type = 'button';
    const presetDelete = element(document, 'button', 'multicc-auto-editor-preset-delete', tt('autoEditorPresetDelete', '删除预设'));
    presetDelete.type = 'button';
    const presetStatus = element(document, 'div', 'multicc-auto-editor-preset-status');
    presetBar.append(presetSelect, presetDelete, presetName, presetSave, presetStatus);
    if (!presetStore) presetBar.style.display = 'none';
    container.replaceChildren(title, help, presetBar, list, error, warning, controls, routingHint, routingKeyWarning);

    function rows() {
      return [...list.querySelectorAll('.multicc-auto-editor-row')];
    }

    function rawCandidates() {
      return rows().map(row => ({
        providerId: row.dataset.providerId,
        model: row.querySelector('.multicc-auto-editor-model').value || null,
        priority: Number(row.querySelector('.multicc-auto-editor-priority').value),
        enabled: row.querySelector('.multicc-auto-editor-enabled').checked,
        rung: Number(row.querySelector('.multicc-auto-editor-tier').value) || null,
      }));
    }

    function enabledCandidates() {
      return rawCandidates().filter(candidate => candidate.enabled);
    }

    function showError(message) {
      error.textContent = message || '';
      error.style.display = message ? '' : 'none';
    }

    // Rungs are only meaningful for an enabled candidate: a disabled row keeps its
    // number but cannot claim a tier, so the ladder follows the enabled pool.
    // `dataset.rung` is how a configured (or freshly rendered) row states its rung
    // before the option list exists; it seeds the very first pass only. Once the
    // select has real options, its own `.value` is the live, user-editable state —
    // reading `dataset.rung` first here would re-apply that stale seed on every
    // notify() (e.g. after any other row's checkbox changes) and silently snap a
    // user's tier edit back to whatever it started at.
    function syncRungs() {
      const enabled = rows().filter(row => row.querySelector('.multicc-auto-editor-enabled').checked);
      const ceiling = Math.max(2, Math.min(MAX_TIERS, enabled.length));
      for (const row of rows()) {
        const select = row.querySelector('.multicc-auto-editor-tier');
        const isEnabled = row.querySelector('.multicc-auto-editor-enabled').checked;
        const requested = Number(select.value) || Number(select.dataset.rung) || 0;
        select.replaceChildren();
        for (let rung = 1; rung <= ceiling; rung += 1) {
          const option = document.createElement('option');
          option.value = String(rung);
          option.textContent = String(rung);
          select.appendChild(option);
        }
        select.value = String(isEnabled
          ? Math.max(1, Math.min(ceiling, requested || enabled.indexOf(row) + 1)) : 1);
        select.disabled = !isEnabled;
      }
    }

    function syncAttemptLimit() {
      const enabledCount = enabledCandidates().length;
      const ceiling = Math.max(2, Math.min(MAX_ATTEMPTS, enabledCount));
      for (const option of maxAttempts.options) option.disabled = Number(option.value) > ceiling;
      if (Number(maxAttempts.value) > ceiling) maxAttempts.value = String(ceiling);
    }

    function syncCandidateLimit() {
      const enabledCount = enabledCandidates().length;
      for (const row of rows()) {
        const checkbox = row.querySelector('.multicc-auto-editor-enabled');
        checkbox.disabled = !checkbox.checked && enabledCount >= MAX_CANDIDATES;
      }
    }

    function syncTrustWarning({ preserveConfirmation = true } = {}) {
      const mixed = selectionCrossesTrust(enabledCandidates(), providers);
      warning.style.display = mixed ? '' : 'none';
      if (!mixed || !preserveConfirmation) confirm.checked = false;
      return mixed;
    }

    function notify() {
      showError('');
      syncAttemptLimit();
      syncCandidateLimit();
      const crossesTrust = syncTrustWarning();
      if (routingEnabled.checked) syncRungs();
      for (const row of rows()) {
        row.querySelector('.multicc-auto-editor-tier').style.visibility =
          routingEnabled.checked ? '' : 'hidden';
      }
      routingHint.style.display = routingEnabled.checked ? '' : 'none';
      routingKeyWarning.style.display = routingEnabled.checked && routingKeyConfigured === false ? '' : 'none';
      if (onChange) {
        onChange(Object.freeze({
          protocol,
          enabledCount: enabledCandidates().length,
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

    function renderPresets() {
      const presets = protocol ? usablePresets() : [];
      const placeholder = element(document, 'option', '', presets.length
        ? tt('autoEditorPresetPlaceholder', '套用已保存的预设…')
        : tt('autoEditorPresetEmpty', '还没有保存过预设'));
      placeholder.value = '';
      presetSelect.replaceChildren(placeholder, ...presets.map(preset => {
        const option = element(document, 'option', '', presetLabel(preset));
        option.value = preset.id;
        return option;
      }));
      presetSelect.value = '';
      presetSelect.disabled = !presets.length;
      presetDelete.disabled = true;
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
      else presetDelete.disabled = true;
    });
    presetSave.addEventListener('click', savePreset);
    presetDelete.addEventListener('click', () => {
      const id = presetSelect.value;
      if (!id) return;
      storePresets(loadPresets().filter(item => item.id !== id));
      renderPresets();
      presetStatus.textContent = tt('autoEditorPresetDeleted', '预设已删除。');
    });

    function render() {
      if (destroyed) return;
      renderPresets();
      container.style.display = protocol ? '' : 'none';
      list.replaceChildren();
      showError('');
      if (!protocol) return;
      const configuredSelection = initialSelection && initialSelection.mode === 'auto'
        && initialSelection.protocol === protocol ? initialSelection : null;
      const configuredById = new Map((configuredSelection?.candidates || [])
        .map(candidate => [String(candidate.providerId || ''), candidate]));
      const defaultsById = new Map(defaultCandidates(providers, protocol)
        .map(candidate => [candidate.providerId, candidate]));
      let nextUnconfiguredPriority = Math.max(0,
        ...[...configuredById.values(), ...defaultsById.values()]
          .map(candidate => Number(candidate.priority) || 0));
      const pool = providersForProtocol(providers, protocol);
      pool.forEach((provider, index) => {
        const providerId = String(provider.id);
        const configured = configuredById.get(providerId);
        const row = element(document, 'div', 'multicc-auto-editor-row');
        row.dataset.providerId = providerId;
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.className = 'multicc-auto-editor-enabled';
        enabled.checked = configuredSelection ? !!configured && configured.enabled !== false : defaultsById.has(providerId);
        enabled.setAttribute('aria-label',
        tt('autoEditorEnableAria', '启用 {provider}', { provider: provider.name || providerId }));
        const name = element(document, 'span', 'multicc-auto-editor-name', String(formatProvider(provider) || providerId));
        name.title = name.textContent;
        const priority = document.createElement('input');
        priority.type = 'number';
        priority.min = '1';
        priority.max = '100';
        priority.className = 'multicc-auto-editor-priority';
        priority.value = String(configured?.priority || defaultsById.get(providerId)?.priority
          || ++nextUnconfiguredPriority);
        priority.title = tt('autoEditorPriorityTitle', '优先级（数字越小越优先）');
        priority.setAttribute('aria-label',
        tt('autoEditorPriorityAria', '{provider} 优先级', { provider: provider.name || providerId }));
        const model = document.createElement('select');
        model.className = 'multicc-auto-editor-model';
        model.setAttribute('aria-label',
        tt('autoEditorModelAria', '{provider} 模型', { provider: provider.name || providerId }));
        const preferredModel = candidateModel(provider, configured);
        const models = [...new Set([
          '', provider.model, ...(Array.isArray(provider.modelOptions) ? provider.modelOptions : []), preferredModel,
        ].filter(value => value != null).map(value => String(value)))];
        for (const modelId of models) {
          const option = document.createElement('option');
          option.value = modelId;
          option.textContent = modelId || tt('autoEditorProviderDefault', 'Provider 默认');
          model.appendChild(option);
        }
        model.value = preferredModel || '';
        const tier = document.createElement('select');
        tier.className = 'multicc-auto-editor-tier';
        tier.title = tt('autoEditorTierTitle', '档位：1 最弱，数字越大越强');
        tier.setAttribute('aria-label',
        tt('autoEditorTierAria', '{provider} 档位', { provider: provider.name || providerId }));
        row.append(enabled, name, priority, model, tier);
        list.appendChild(row);
        // A pool that already routes keeps its own ladder; a fresh one starts at
        // priority order, which is what the pool list already means.
        const ladder = configuredSelection?.routing?.tiers || [];
        tier.dataset.rung = String(rungFor(configured, ladder, index + 1));
        enabled.addEventListener('change', () => {
          if (!selectionCrossesTrust(enabledCandidates(), providers)) confirm.checked = false;
          notify();
        });
        priority.addEventListener('input', notify);
        model.addEventListener('change', notify);
        tier.addEventListener('change', notify);
      });
      maxAttempts.value = String(configuredSelection?.maxAttempts
        || Math.max(2, Math.min(3, enabledCandidates().length)));
      sticky.checked = configuredSelection ? configuredSelection.sticky !== false : true;
      confirm.checked = configuredSelection?.allowCrossTrust === true;
      routingEnabled.checked = !!configuredSelection?.routing;
      syncAttemptLimit();
      syncCandidateLimit();
      syncRungs();
      syncTrustWarning();
      notify();
    }

    maxAttempts.addEventListener('change', notify);
    sticky.addEventListener('change', notify);
    confirm.addEventListener('change', notify);
    // Without this, checking the box does nothing until some other field is
    // touched: the tier columns stay hidden, the hint and key warning don't
    // show, and the ladder never gets its first syncRungs() pass.
    routingEnabled.addEventListener('change', notify);

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
        if (Object.prototype.hasOwnProperty.call(next, 'routingKeyConfigured')) {
          routingKeyConfigured = next.routingKeyConfigured ?? null;
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
          routingEnabled: routingEnabled.checked,
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
        container.classList.remove('multicc-auto-editor');
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
