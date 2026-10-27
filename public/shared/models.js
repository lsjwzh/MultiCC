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
    const live = readClaudeModelsSync().find(o => o && o.model === model);
    if (live && live.label) return live.label;
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
  // provider/model pairs (cached server-side for 1 hour — opencode refreshes
  // its own models.dev cache on a 60-minute timer). We mirror that in the
  // browser for the same hour, so repeated picker opens stay snappy while an
  // upstream rename still lands the same day. Returns an array of
  // {provider, model, label} entries; see routes/opencode-models.js.
  const OPENCODE_MODELS_TTL_MS = 60 * 60 * 1000; // 1 hour
  const OPENCODE_MODELS_KEY = 'multicc.opencode.models.v2';
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

  // `force` is the user asking for a fresh list (the picker's 刷新模型 button):
  // it ignores the localStorage copy and asks the server to skip its own cache.
  // Without it this is a cache read plus, at worst, one fetch per hour.
  async function loadOpenCodeModels(options) {
    const force = !!(options && options.force);
    const cached = force ? null : readOpenCodeCache();
    if (cached) return cached.models;
    if (!force && opencodeModelsPromise) return opencodeModelsPromise;
    opencodeModelsPromise = (async () => {
      try {
        const url = force ? '/api/opencode/models?refresh=1' : '/api/opencode/models';
        const data = await window.fetch(url, { credentials: 'same-origin' })
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

  // ── WorkBuddy (codebuddy) live model list ───────────────────────────────
  // GET /api/codebuddy/models parses `codebuddy --help` (server-side cache 1
  // hour) — the CLI auto-updates and its --model help line is the only local
  // source tracking the vendor's rapid releases. Mirrored here for 1 hour
  // too. Entries are {model, label}; see routes/codebuddy-models.js.
  const CODEBUDDY_MODELS_TTL_MS = 60 * 60 * 1000; // 1 hour
  const CODEBUDDY_MODELS_KEY = 'multicc.codebuddy.models.v1';
  let codebuddyModelsPromise = null;

  function readCodebuddyCache() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(CODEBUDDY_MODELS_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      const at = Number(obj.at) || 0;
      const models = Array.isArray(obj.models) ? obj.models : [];
      if (!at || (Date.now() - at) >= CODEBUDDY_MODELS_TTL_MS) return null;
      if (!models.length) return null;
      return { at, models };
    } catch (_) { return null; }
  }

  function writeCodebuddyCache(models) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(CODEBUDDY_MODELS_KEY, JSON.stringify({ at: Date.now(), models }));
      }
    } catch (_) { /* ignore quota / disabled storage */ }
  }

  function readCodebuddyModelsSync() {
    const cached = readCodebuddyCache();
    return cached ? cached.models : [];
  }

  async function loadCodebuddyModels() {
    const cached = readCodebuddyCache();
    if (cached) return cached.models;
    if (codebuddyModelsPromise) return codebuddyModelsPromise;
    codebuddyModelsPromise = (async () => {
      try {
        const data = await window.fetch('/api/codebuddy/models', { credentials: 'same-origin' })
          .then(r => (r && r.ok ? r.json() : null));
        const models = data && Array.isArray(data.models) ? data.models : [];
        if (models.length && data.source !== 'fallback') writeCodebuddyCache(models);
        return models;
      } catch (_) { return []; } finally { codebuddyModelsPromise = null; }
    })();
    return codebuddyModelsPromise;
  }

  // ── Command Code / Grok live model lists ────────────────────────────────
  // GET /api/commandcode/models (`commandcode --list-models`, entries carry the
  // vendor's own `group`) and GET /api/grok/models (`grok models`). Same
  // 1-hour contract as WorkBuddy; one small factory instead of a third copy.
  function createLiveCatalog(key, url) {
    const ttl = 60 * 60 * 1000;
    let inflight = null;
    function read() {
      try {
        const raw = window.localStorage && window.localStorage.getItem(key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        const at = Number(obj && obj.at) || 0;
        const models = obj && Array.isArray(obj.models) ? obj.models : [];
        if (!at || (Date.now() - at) >= ttl || !models.length) return null;
        return { at, models };
      } catch (_) { return null; }
    }
    async function load() {
      const cached = read();
      if (cached) return cached.models;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const data = await window.fetch(url, { credentials: 'same-origin' }).then(r => (r && r.ok ? r.json() : null));
          const models = data && Array.isArray(data.models) ? data.models : [];
          // fallback / unauthenticated lists are served but never pinned for an hour
          if (models.length && data.source === 'cli') {
            try { window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), models })); } catch (_) { /* quota */ }
          }
          return models;
        } catch (_) { return []; } finally { inflight = null; }
      })();
      return inflight;
    }
    return { load, readSync: () => { const c = read(); return c ? c.models : []; } };
  }
  const commandcodeCatalog = createLiveCatalog('multicc.commandcode.models.v1', '/api/commandcode/models');
  const grokCatalog = createLiveCatalog('multicc.grok.models.v1', '/api/grok/models');

  // ── Codex account model list ───────────────────────────────────────────
  // 服务端按账号持久缓存一天，并检查 CLI 升级；浏览器只镜像结果，
  // 不按时间拦截请求，否则升级后会继续显示旧目录。
  const codexCatalogs = new Map();
  const codexModelsPromises = new Map();
  const codexCatalogKey = options => String((options && options.providerId) || 'codex-official');

  function normalizeCodexCatalog(data) {
    const models = [];
    const seen = new Set();
    for (const entry of (data && Array.isArray(data.models) ? data.models : [])) {
      if (!entry || typeof entry !== 'object') continue;
      const model = String(entry.model || '').trim();
      if (!model || model.length > 160 || seen.has(model)) continue;
      seen.add(model);
      const label = String(entry.label || model).trim().slice(0, 160) || model;
      models.push({ model, label, isDefault: entry.isDefault === true });
    }
    return {
      at: Date.now(),
      fetchedAt: data && data.fetchedAt || null,
      refreshing: !!(data && data.refreshing),
      models,
      source: String(data && data.source || 'fallback'),
      stale: data && data.stale === true,
      available: data && data.available === true && models.length > 0,
      cliVersion: String(data && data.cliVersion || '').slice(0, 40),
      diagnostic: data && data.diagnostic && typeof data.diagnostic === 'object'
        ? {
            code: String(data.diagnostic.code || '').slice(0, 60),
            message: String(data.diagnostic.message || '').slice(0, 300),
          }
        : { code: models.length ? 'ok' : 'unavailable', message: '' },
    };
  }

  function readCodexModelCatalogSync(options = {}) {
    return codexCatalogs.get(codexCatalogKey(options)) || null;
  }

  async function loadCodexModels(options = {}) {
    const key = codexCatalogKey(options);
    const requestKey = key + (options.poll ? ':poll' : ':open');
    if (codexModelsPromises.has(requestKey)) return codexModelsPromises.get(requestKey);
    const promise = (async () => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timeout;
      try {
        const suffix = `?providerId=${encodeURIComponent(key)}${options.poll ? '&poll=1' : ''}`;
        const data = await Promise.race([
          window.fetch(`/api/codex/models${suffix}`, {
            credentials: 'same-origin', ...(controller ? { signal: controller.signal } : {}),
          }).then(response => {
            if (!response || !response.ok) throw new Error('model_catalog_unavailable');
            return response.json();
          }),
          new Promise((_, reject) => { timeout = setTimeout(() => {
            if (controller) controller.abort();
            reject(new Error('model_catalog_timeout'));
          }, 5000); }),
        ]);
        const catalog = normalizeCodexCatalog(data);
        codexCatalogs.set(key, catalog);
        return catalog;
      } catch (_) {
        return { ...(codexCatalogs.get(key) || normalizeCodexCatalog(null)), refreshing: false,
          diagnostic: { code: 'request_failed', message: '模型列表获取失败，请重新打开后重试。' } };
      } finally { clearTimeout(timeout); codexModelsPromises.delete(requestKey); }
    })();
    codexModelsPromises.set(requestKey, promise);
    return promise;
  }

  // 一次打开只启动一次刷新；后续有界轮询只查询进度，不再次触发刷新。
  // 返回取消函数：关闭弹框或切换线路后，旧响应不能重绘当前选择器。
  function watchCodexModels(options, onUpdate) {
    let cancelled = false;
    let timer = null;
    let remaining = 20;
    const deadline = Date.now() + 20000;
    async function read(poll) {
      const catalog = await loadCodexModels({ ...options, poll });
      if (cancelled) return;
      const timedOut = catalog.refreshing && (remaining === 0 || Date.now() >= deadline);
      onUpdate(timedOut ? { ...catalog, refreshing: false,
        diagnostic: { code: 'refresh_pending', message: '模型仍在后台加载，请稍后重新打开查看。' } } : catalog);
      if (catalog.refreshing && !timedOut && remaining-- > 0 && !cancelled) {
        timer = window.setTimeout(() => read(true), 1000);
      }
    }
    void read(false);
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }

  function syncCodexModelsIfDue(options = {}) {
    return loadCodexModels(options);
  }

  function codexModelOptions(options = {}) {
    const catalog = readCodexModelCatalogSync(options);
    return catalog ? catalog.models.slice() : [];
  }

  function codexModelLabel(model, options = {}) {
    const catalog = readCodexModelCatalogSync(options);
    const entry = catalog && catalog.models.find(item => item.model === model);
    return entry ? entry.label : model;
  }

  // ── Claude live model list ──────────────────────────────────────────────
  // GET /api/claude/models extracts the servable model ids from the installed
  // claude CLI's bundle (server-side cache 1 day) — the only local source that
  // tracks Anthropic's releases; a hardcoded table rots between CLI upgrades
  // (claude-opus-5 was missing from the App picker for weeks). Mirrored here
  // stale-while-revalidate: a list up to a week old still renders instantly,
  // but anything older than CLAUDE_MODELS_FRESH_MS is re-fetched on the next
  // picker open (the server re-extracts as soon as the CLI bundle changes). Entries are {model, label}; the route reports
  // source:'fallback' when the CLI is unreadable, and that variant is never
  // persisted so the next picker open retries.
  const CLAUDE_MODELS_KEY = 'multicc.claude.models.v1';
  const CLAUDE_MODELS_FRESH_MS = 60 * 60 * 1000;
  const CLAUDE_MODELS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
  let claudeModelsPromise = null;
  let claudeCacheMemo = null; // { raw, models, at } keyed on the localStorage blob

  // Memoized sync read: modelShortName() consults this on every model render,
  // so the JSON must not be re-parsed per call. Returns [] on a miss/stale.
  function readClaudeModelsSync() {
    let raw = null;
    try { raw = window.localStorage && window.localStorage.getItem(CLAUDE_MODELS_KEY); } catch (_) { return []; }
    if (!raw) return [];
    if (claudeCacheMemo && claudeCacheMemo.raw === raw) {
      return (Date.now() - claudeCacheMemo.at) < CLAUDE_MODELS_KEEP_MS ? claudeCacheMemo.models : [];
    }
    let models = [];
    let at = 0;
    try {
      const obj = JSON.parse(raw);
      at = Number(obj && obj.at) || 0;
      const list = obj && Array.isArray(obj.models) ? obj.models : [];
      if (at && list.length) models = list;
    } catch (_) { /* corrupted cache — treat as a miss */ }
    claudeCacheMemo = { raw, models, at };
    return (Date.now() - at) < CLAUDE_MODELS_KEEP_MS ? models : [];
  }

  function claudeModelsFresh() {
    readClaudeModelsSync();
    return !!(claudeCacheMemo && claudeCacheMemo.models.length
      && (Date.now() - claudeCacheMemo.at) < CLAUDE_MODELS_FRESH_MS);
  }

  function writeClaudeCache(models) {
    claudeCacheMemo = null; // drop the memo before the blob it keyed on changes
    try {
      if (window.localStorage) {
        window.localStorage.setItem(CLAUDE_MODELS_KEY, JSON.stringify({ at: Date.now(), models }));
      }
    } catch (_) { /* ignore quota / disabled storage */ }
  }

  async function loadClaudeModels() {
    const cached = readClaudeModelsSync();
    if (cached.length && claudeModelsFresh()) return cached;
    if (claudeModelsPromise) return claudeModelsPromise;
    claudeModelsPromise = (async () => {
      try {
        const data = await window.fetch('/api/claude/models', { credentials: 'same-origin' })
          .then(r => (r && r.ok ? r.json() : null));
        const models = data && Array.isArray(data.models) ? data.models : [];
        // Only persist the CLI-derived list: caching the offline fallback for a
        // day would hide the models once the CLI is readable again.
        if (models.length && data.source !== 'fallback') writeClaudeCache(models);
        return models.length ? models : cached;
      } catch (_) { return cached; } finally { claudeModelsPromise = null; }
    })();
    return claudeModelsPromise;
  }

  window.CLAUDE_MODEL_OPTIONS = CLAUDE_MODEL_OPTIONS;
  window.ALIAS_TIERS = ALIAS_TIERS;
  window.modelShortName = modelShortName;
  window.aliasTiersFromMap = aliasTiersFromMap;
  window.formatAliasTierLabel = formatAliasTierLabel;
  window.loadOpenCodeModels = loadOpenCodeModels;
  window.loadQoderModels = loadQoderModels;
  window.readQoderModelsSync = readQoderModelsSync;
  window.loadCodebuddyModels = loadCodebuddyModels;
  window.loadCommandcodeModels = commandcodeCatalog.load;
  window.loadGrokModels = grokCatalog.load;
  window.readCodebuddyModelsSync = readCodebuddyModelsSync;
  window.loadCodexModels = loadCodexModels;
  window.watchCodexModels = watchCodexModels;
  window.readCodexModelCatalogSync = readCodexModelCatalogSync;
  window.codexModelOptions = codexModelOptions;
  window.syncCodexModelsIfDue = syncCodexModelsIfDue;
  window.codexModelLabel = codexModelLabel;
  window.loadClaudeModels = loadClaudeModels;
  window.readClaudeModelsSync = readClaudeModelsSync;
})();
