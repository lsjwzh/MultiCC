// multicc shared model/alias helpers.
//
// Loaded by BOTH chat.html and manage.html, right after i18n.js (it uses tt()).
// Owns the PURE pieces of the provider/model UI logic that were previously
// byte-duplicated across chat.js and manage.js. Exposed as plain globals
// (window.*) so the classic chat.js / manage.js scripts can reference them
// bare, exactly as they referenced their own local copies before.
//
// Page-state-coupled helpers (providerAliasMap / providerAliasTiers /
// modelDisplayName, which read each page's own provider-list cache) stay in
// their respective pages — only provably-pure, byte-identical logic lives here.
(function () {
  // Claude model choices for new sessions. value '' = follow the user's /model
  // default. __custom__ = free-text model id.
  const CLAUDE_MODEL_OPTIONS = [
    { value: '', labelKey: 'defaultClaudeSetting' },
    { value: 'claude-opus-5', label: 'Opus 5' },
    { value: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-fable-5', label: 'Fable 5' },
    { value: 'claude-fable-5[1m]', label: 'Fable 5 (1M context)' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { value: '__custom__', labelKey: 'custom' },
  ];

  // Claude alias tiers in display/precedence order. Single source of truth for
  // the vocabulary previously hardcoded as ['opus','sonnet','haiku','fable'] at
  // 6+ sites across chat.js and manage.js.
  const ALIAS_TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

  // Short display name for a wire model id, falling back to the id itself.
  function modelShortName(model) {
    const opt = CLAUDE_MODEL_OPTIONS.find(o => o.value === model);
    return opt ? (opt.labelKey ? tt(opt.labelKey) : opt.label) : model;
  }

  // Ordered [tier, entry] pairs for an alias-mapped relay, or []. Pure over the
  // resolved aliasMap — single source of truth for the tier-filter+order logic
  // that providerAliasTiers (chat.js & manage.js) and rebuildModelOptions
  // (manage.js) previously reimplemented.
  function aliasTiersFromMap(aliasMap) {
    if (!aliasMap) return [];
    return ALIAS_TIERS.filter(t => aliasMap[t] && aliasMap[t].model).map(t => [t, aliasMap[t]]);
  }

  // Format an alias-tier option label as "tier · displayName · wireModelId"
  // (别名 - 展示名 - 真实id). displayName is omitted when the entry has none,
  // yielding "tier · wireModelId".
  function formatAliasTierLabel(tier, entry) {
    const e = entry || {};
    return `${tier}${e.name ? ` · ${e.name}` : ''} · ${e.model}`;
  }

  // ── OpenCode live model list ────────────────────────────────────────────
  // GET /api/opencode/models enumerates the local opencode CLI's available
  // provider/model pairs (cached server-side for 1 day). We mirror that in the
  // browser for 1 day too, so repeated picker opens stay snappy. Returns an
  // array of {provider, model, label} entries; see routes/opencode-models.js.
  const OPENCODE_MODELS_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
  const OPENCODE_MODELS_KEY = 'multicc.opencode.models.v1';
  let opencodeModelsPromise = null;

  function readOpenCodeCache() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(OPENCODE_MODELS_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      const at = Number(obj.at) || 0;
      const models = Array.isArray(obj.models) ? obj.models : [];
      if (!at || (Date.now() - at) >= OPENCODE_MODELS_TTL_MS) return null;
      if (!models.length) return null;
      return { at, models };
    } catch (_) { return null; }
  }

  function writeOpenCodeCache(models) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(OPENCODE_MODELS_KEY, JSON.stringify({ at: Date.now(), models }));
      }
    } catch (_) { /* ignore quota / disabled storage */ }
  }

  async function loadOpenCodeModels() {
    const cached = readOpenCodeCache();
    if (cached) return cached.models;
    if (opencodeModelsPromise) return opencodeModelsPromise;
    opencodeModelsPromise = (async () => {
      try {
        const data = await window.fetch('/api/opencode/models', { credentials: 'same-origin' })
          .then(r => (r && r.ok ? r.json() : null));
        const models = data && Array.isArray(data.models) ? data.models : [];
        if (models.length) writeOpenCodeCache(models);
        return models;
      } catch (_) { return []; } finally { opencodeModelsPromise = null; }
    })();
    return opencodeModelsPromise;
  }

  // ── Qoder CN live model list ────────────────────────────────────────────
  // GET /api/qoder/models runs `qoderclicn --list-models` (cached server-side
  // for 1 day) and returns the catalog entitled to the logged-in account.
  // Mirrored here for 1 day too. Entries are {model, label}; see
  // routes/qoder-models.js.
  const QODER_MODELS_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
  const QODER_MODELS_KEY = 'multicc.qoder.models.v1';
  let qoderModelsPromise = null;

  function readQoderCache() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(QODER_MODELS_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      const at = Number(obj.at) || 0;
      const models = Array.isArray(obj.models) ? obj.models : [];
      if (!at || (Date.now() - at) >= QODER_MODELS_TTL_MS) return null;
      if (!models.length) return null;
      return { at, models };
    } catch (_) { return null; }
  }

  function writeQoderCache(models) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(QODER_MODELS_KEY, JSON.stringify({ at: Date.now(), models }));
      }
    } catch (_) { /* ignore quota / disabled storage */ }
  }

  // Synchronous cache peek for callers that build a <select> inline and cannot
  // await (manage.html's session create/edit dialog). Returns [] on a miss.
  function readQoderModelsSync() {
    const cached = readQoderCache();
    return cached ? cached.models : [];
  }

  async function loadQoderModels() {
    const cached = readQoderCache();
    if (cached) return cached.models;
    if (qoderModelsPromise) return qoderModelsPromise;
    qoderModelsPromise = (async () => {
      try {
        const data = await window.fetch('/api/qoder/models', { credentials: 'same-origin' })
          .then(r => (r && r.ok ? r.json() : null));
        const models = data && Array.isArray(data.models) ? data.models : [];
        // Only persist the real catalog: caching the offline tier fallback for
        // a day would hide the models once the CLI recovers.
        if (models.length && data.source !== 'fallback') writeQoderCache(models);
        return models;
      } catch (_) { return []; } finally { qoderModelsPromise = null; }
    })();
    return qoderModelsPromise;
  }

  window.CLAUDE_MODEL_OPTIONS = CLAUDE_MODEL_OPTIONS;
  window.ALIAS_TIERS = ALIAS_TIERS;
  window.modelShortName = modelShortName;
  window.aliasTiersFromMap = aliasTiersFromMap;
  window.formatAliasTierLabel = formatAliasTierLabel;
  window.loadOpenCodeModels = loadOpenCodeModels;
  window.loadQoderModels = loadQoderModels;
  window.readQoderModelsSync = readQoderModelsSync;
})();
