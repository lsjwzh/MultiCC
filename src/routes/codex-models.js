'use strict';

// GET /api/codex/models — list models entitled to the host's signed-in Codex
// account. The supported app-server `model/list` method is authoritative: it
// returns wire ids and display names after the CLI applies account rollout and
// visibility policy. We never infer availability from public marketing names.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveCliCommands } = require('../cli-adapters/commands');

// 15 minutes, not 60 seconds: the account catalog changes at most a few times
// a year, while every picker open used to pay a full app-server spawn (1.2s+)
// once the one-minute TTL lapsed. The hourly syncIfDue nudge still refreshes.
const CODEX_MODELS_TTL_MS = 15 * 60 * 1000;
// A models_cache.json Codex refreshed within this window is served
// synchronously while a CLI discovery runs in the background (the disk file is
// the one Codex itself maintains, fetched_at included).
const CODEX_MODELS_DISK_FRESH_MS = 60 * 60 * 1000;
const CODEX_MODELS_STALE_MAX_MS = 15 * 60 * 1000;
// How often a picker open may ask Codex to re-fetch its account catalog. Codex
// itself only goes online when its models_cache.json is past its own TTL or the
// CLI version changed, and when that fetch fails it silently serves the old
// file — which is how new models (gpt-6-sol) stayed invisible until someone ran
// /model in the TUI. The picker nudges a refresh at most this often.
const CODEX_MODELS_SYNC_INTERVAL_MS = 60 * 60 * 1000;
// A catalog Codex has not managed to refresh for this long is reported as
// stale even when model/list itself succeeded (it succeeded from the file).
const CODEX_CATALOG_STALE_MS = 60 * 60 * 1000;
const CODEX_MODELS_TIMEOUT_MS = Number(process.env.CODEX_MODELS_TIMEOUT_MS || 12000);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MODELS = 200;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function safeText(value, max = 160) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeModels(rows) {
  const result = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || row.hidden === true) continue;
    // app-server uses `model`/`id`; ~/.codex/models_cache.json uses `slug`.
    const model = safeText(row.model || row.id || row.slug);
    if (!MODEL_ID_RE.test(model) || seen.has(model)) continue;
    seen.add(model);
    result.push(Object.freeze({
      model,
      label: safeText(row.displayName || row.display_name || row.label || model) || model,
      isDefault: row.isDefault === true,
    }));
    if (result.length >= MAX_MODELS) break;
  }
  return result;
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function readCodexDiskCatalog(options = {}) {
  const fsImpl = options.fs || fs;
  const cachePath = options.cachePath
    || path.join(options.homeDir || os.homedir(), '.codex', 'models_cache.json');
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(cachePath, 'utf8'));
    const rows = (parsed && Array.isArray(parsed.models) ? parsed.models : [])
      .filter(row => row && row.visibility === 'list')
      .sort((a, b) => {
        const left = Number(a.priority);
        const right = Number(b.priority);
        return (Number.isFinite(left) ? left : 999) - (Number.isFinite(right) ? right : 999);
      });
    return Object.freeze({
      models: Object.freeze(normalizeModels(rows)),
      fetchedAt: parseTimestamp(parsed && parsed.fetched_at),
      cliVersion: safeText(parsed && parsed.client_version, 40),
    });
  } catch (_) {
    return Object.freeze({ models: Object.freeze([]), fetchedAt: 0, cliVersion: '' });
  }
}

function protocolFailure(error) {
  const text = safeText(error && (error.message || error.code || error), 500).toLowerCase();
  if (/not logged|login|required|unauthor|auth/.test(text)) return 'login_required';
  if (/method.+not found|unknown method|unsupported/.test(text)) return 'cli_too_old';
  return 'cli_error';
}

function discoverCodexModels(options = {}) {
  const spawnFn = options.spawn || spawn;
  const codexBin = options.codexBin || resolveCliCommands({
    logger: { log() {}, warn() {} },
  }).codex;
  const timeoutMs = Number(options.timeoutMs) || CODEX_MODELS_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stdout = '';
    let stdoutBytes = 0;
    let initialized = false;
    let nextId = 2;
    let activeRequestId = null;
    let userAgent = '';
    const rows = [];

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child && child.stdin) child.stdin.end(); } catch (_) {}
      try { if (child && typeof child.kill === 'function') child.kill('SIGTERM'); } catch (_) {}
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (code) => {
      const error = new Error(code);
      error.code = code;
      finish(error);
    };
    const timer = setTimeout(() => fail('cli_timeout'), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch (_) { fail('cli_error'); }
    };
    const requestPage = (cursor = null) => {
      activeRequestId = nextId++;
      send({
        method: 'model/list', id: activeRequestId,
        params: { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) },
      });
    };
    const consume = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.id === 1 && !initialized) {
        if (message.error) return fail(protocolFailure(message.error));
        initialized = true;
        userAgent = safeText(message.result && message.result.userAgent, 120);
        requestPage();
        return;
      }
      if (message.id !== activeRequestId) return;
      if (message.error) return fail(protocolFailure(message.error));
      const result = message.result || {};
      if (Array.isArray(result.data)) rows.push(...result.data);
      if (rows.length < MAX_MODELS && result.nextCursor) {
        requestPage(safeText(result.nextCursor, 500));
        return;
      }
      const versionMatch = /(?:^|\/)(\d+\.\d+\.\d+)(?:$|\s)/.exec(userAgent);
      finish(null, Object.freeze({
        models: Object.freeze(normalizeModels(rows)),
        cliVersion: versionMatch ? versionMatch[1] : '',
        // model/list answers from ~/.codex/models_cache.json whenever its own
        // online fetch fails, so the file's fetched_at is the real age of what
        // we were just handed.
        catalogFetchedAt: readCodexDiskCatalog(options).fetchedAt,
      }));
    };

    try {
      child = spawnFn(codexBin, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (_) {
      return fail('cli_not_installed');
    }
    child.once('error', error => fail(error && error.code === 'ENOENT' ? 'cli_not_installed' : 'cli_error'));
    child.once('exit', () => { if (!settled) fail('cli_error'); });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) return fail('cli_output_too_large');
      stdout += chunk.toString('utf8');
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        try { consume(JSON.parse(line)); } catch (_) { /* ignore non-protocol diagnostics */ }
      }
    });
    // stderr is deliberately neither buffered nor logged: CLI diagnostics can
    // contain paths or provider details. Exit/error codes are enough here.
    child.stderr.on('data', () => {});
    send({
      method: 'initialize', id: 1,
      params: {
        clientInfo: { name: 'multicc', title: 'MultiCC', version: '1' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
  });
}

const DIAGNOSTICS = Object.freeze({
  ok: '已从当前 Codex 账号验证模型目录。',
  stale_cache: '实时刷新失败，暂用最近一次账号模型目录。',
  login_required: 'Codex 尚未登录；登录后刷新即可查看账号可用模型。',
  cli_not_installed: '未找到 Codex CLI；安装后刷新即可发现账号模型。',
  cli_too_old: '当前 Codex CLI 不支持模型发现；升级 CLI 后刷新。',
  cli_timeout: 'Codex 模型目录刷新超时；当前仅保留默认/自定义模型。',
  cli_error: 'Codex 模型目录暂不可用；当前仅保留默认/自定义模型。',
  cli_output_too_large: 'Codex 模型目录响应异常；当前仅保留默认/自定义模型。',
  account_no_models: '当前 Codex 账号没有返回可选模型；可能尚未获权或受工作区策略限制。',
  catalog_stale: 'Codex 在线刷新模型目录失败（多为到 chatgpt.com 的网络不通），当前列表来自较早的本地缓存。',
});

function diagnostic(code) {
  const safeCode = Object.prototype.hasOwnProperty.call(DIAGNOSTICS, code) ? code : 'cli_error';
  return Object.freeze({ code: safeCode, message: DIAGNOSTICS[safeCode] });
}

function createCodexModelsRuntime(options = {}) {
  const now = options.now || Date.now;
  const ttlMs = Number(options.ttlMs) || CODEX_MODELS_TTL_MS;
  const staleMaxMs = Number(options.staleMaxMs) || CODEX_MODELS_STALE_MAX_MS;
  const discover = options.discover || (() => discoverCodexModels(options));
  const readDisk = options.readDisk || (() => readCodexDiskCatalog(options));
  const diskFreshMs = Number(options.diskFreshMs) || CODEX_MODELS_DISK_FRESH_MS;
  let cache = null; // last verified account catalog only
  let inFlight = null;
  // Set when a discovery failed; cleared by the next success. A login failure
  // means the account behind any cached catalog is gone, so the warm-disk path
  // must stand down rather than keep serving another account's entitlements.
  let lastFailCode = '';

  let lastSyncAt = 0;

  function response({ models, source, fetchedAt, cliVersion, code, stale = false, catalogFetchedAt = 0 }) {
    return Object.freeze({
      catalogFetchedAt: catalogFetchedAt || null,
      models: Object.freeze(models.map(model => Object.freeze({ ...model }))),
      source,
      cached: source !== 'cli',
      stale,
      available: models.length > 0,
      fetchedAt: fetchedAt || null,
      cliVersion: safeText(cliVersion, 40) || null,
      diagnostic: diagnostic(code),
      // The only universally safe offline fallback is leaving model unset so
      // Codex chooses an entitled default. Clients always render that option.
      fallback: 'codex_default',
    });
  }

  async function refresh() {
    try {
      const live = await discover();
      lastFailCode = '';
      const models = normalizeModels(live && live.models);
      const fetchedAt = now();
      const catalogFetchedAt = Number(live && live.catalogFetchedAt) || 0;
      const catalogStale = models.length > 0 && catalogFetchedAt > 0
        && fetchedAt - catalogFetchedAt > CODEX_CATALOG_STALE_MS;
      const result = response({
        models, source: 'cli', fetchedAt,
        cliVersion: live && live.cliVersion,
        code: catalogStale ? 'catalog_stale' : (models.length ? 'ok' : 'account_no_models'),
        stale: catalogStale,
        catalogFetchedAt,
      });
      // An authoritative empty response invalidates old entitlements too.
      cache = { at: fetchedAt, result };
      return result;
    } catch (error) {
      const code = Object.prototype.hasOwnProperty.call(DIAGNOSTICS, error && error.code)
        ? error.code : 'cli_error';
      lastFailCode = code;
      // Never reuse another account's old list after an auth failure.
      if (code !== 'login_required' && cache && now() - cache.at <= staleMaxMs
          && cache.result.models.length) {
        return response({
          models: cache.result.models, source: 'last_good', fetchedAt: cache.at,
          cliVersion: cache.result.cliVersion, code: 'stale_cache', stale: true,
        });
      }
      if (code !== 'login_required') {
        const disk = readDisk();
        const age = disk.fetchedAt ? now() - disk.fetchedAt : Infinity;
        if (disk.models.length && age >= 0 && age <= staleMaxMs) {
          const result = response({
            models: disk.models, source: 'disk_cache', fetchedAt: disk.fetchedAt,
            cliVersion: disk.cliVersion, code: 'stale_cache', stale: age > ttlMs,
          });
          cache = { at: disk.fetchedAt, result };
          return result;
        }
      }
      return response({ models: [], source: 'fallback', fetchedAt: 0, cliVersion: '', code });
    }
  }

  async function list({ forceRefresh = false } = {}) {
    if (!forceRefresh && cache && now() - cache.at < ttlMs) {
      return response({
        models: cache.result.models, source: 'memory_cache', fetchedAt: cache.at,
        cliVersion: cache.result.cliVersion,
        code: cache.result.diagnostic.code === 'catalog_stale' ? 'catalog_stale'
          : (cache.result.models.length ? 'ok' : 'account_no_models'),
        stale: cache.result.stale,
        catalogFetchedAt: cache.result.catalogFetchedAt,
      });
    }
    if (inFlight) return inFlight;
    // Stale-while-revalidate: this process has verified a catalog before (so a
    // login change would surface through the background refresh) and the last
    // discovery did not fail on auth — never make a picker open wait on a CLI
    // spawn. Prefer Codex's own disk copy while it is fresh; once it has aged
    // past that window (nothing spawned Codex to rewrite models_cache.json),
    // fall back to the last verified in-memory catalog instead of blocking:
    // the account catalog changes at most a few times a day, so serving the
    // previous list while a background discovery re-verifies is strictly
    // better than a 1-2s frozen dropdown.
    if (!forceRefresh && cache && lastFailCode !== 'login_required'
        && !(cache.result.source === 'cli' && cache.result.models.length === 0)
        && cache.result.models.length) {
      const disk = readDisk();
      const diskFresh = disk.models.length && disk.fetchedAt
        && now() - disk.fetchedAt >= 0 && now() - disk.fetchedAt < diskFreshMs;
      inFlight = refresh().finally(() => { inFlight = null; });
      if (diskFresh) {
        const age = now() - disk.fetchedAt;
        return response({
          models: disk.models, source: 'disk_cache', fetchedAt: disk.fetchedAt,
          cliVersion: disk.cliVersion,
          code: age > ttlMs ? 'stale_cache' : 'ok',
          stale: age > ttlMs,
          catalogFetchedAt: disk.fetchedAt,
        });
      }
      return response({
        models: cache.result.models, source: 'memory_cache', fetchedAt: cache.at,
        cliVersion: cache.result.cliVersion,
        code: 'stale_cache', stale: true,
        catalogFetchedAt: cache.result.catalogFetchedAt,
      });
    }
    inFlight = refresh().finally(() => { inFlight = null; });
    return inFlight;
  }

  // Picker-open hook: kick one background discovery (which makes Codex try its
  // online catalog fetch and, on success, rewrite models_cache.json — the file
  // the provider picker reads) at most once per interval. Never awaits the
  // discovery: opening a dropdown must not wait on a 12s CLI spawn.
  function syncIfDue({ minIntervalMs = CODEX_MODELS_SYNC_INTERVAL_MS } = {}) {
    const at = now();
    const disk = readDisk();
    const catalogFetchedAt = disk.fetchedAt || 0;
    if (at - lastSyncAt < minIntervalMs) {
      return Object.freeze({ triggered: false, reason: 'throttled', lastSyncAt, catalogFetchedAt: catalogFetchedAt || null });
    }
    if (catalogFetchedAt && at - catalogFetchedAt >= 0 && at - catalogFetchedAt < minIntervalMs) {
      return Object.freeze({ triggered: false, reason: 'fresh', lastSyncAt, catalogFetchedAt });
    }
    lastSyncAt = at;
    list({ forceRefresh: true }).catch(() => {});
    return Object.freeze({ triggered: true, reason: 'due', lastSyncAt, catalogFetchedAt: catalogFetchedAt || null });
  }

  return Object.freeze({
    list,
    syncIfDue,
    // Last verified account catalog without triggering a discovery. Callers
    // that must stay synchronous (catalog projections) use this; interactive
    // refreshes use list().
    peek() { return cache ? cache.result : null; },
    _resetForTest() { cache = null; inFlight = null; lastSyncAt = 0; lastFailCode = ''; },
  });
}

const defaultRuntime = createCodexModelsRuntime();

function mountCodexModelRoutes(app, runtime, accountRuntime, providerModelsRuntime) {
  if (!app || typeof app.get !== 'function') return;
  // Existing embedders may inject the legacy single-account runtime. The
  // production API uses the Rust account catalog; Express only projects its
  // snapshot and schedules work, never waits for a CLI discovery.
  if (!runtime) accountRuntime ||= require('../codex/model-catalog').defaultRuntime;
  async function accountResponse(req, res, pollOnly = false) {
    const providerId = String(req.query?.providerId || req.body?.providerId || 'codex-official');
    const provider = accountRuntime.resolveProvider(providerId);
    if (!provider) return res.status(404).json({ error: '账号线路不存在' });
    if (provider.appType !== 'codex') return res.status(400).json({ error: '该线路不是 Codex 官方账号' });
    const { isOfficialCodexOAuthProvider } = require('../codex/official-relay');
    if (!isOfficialCodexOAuthProvider(provider)) {
      // 借道（第三方中转）线路: this endpoint used to reject it with "该线路
      // 不是 Codex 官方账号", so 刷新模型 could never work on a relay. Those
      // rows carry their own base URL/key, not an OAuth account, so delegate to
      // the provider live-catalog path (same fetch as /api/providers/:id/models).
      // The response keeps the account-catalog shape loadCodexModels() expects.
      const catalogRuntime = providerModelsRuntime || require('./provider-models').getSharedProviderModelsRuntime();
      const result = await catalogRuntime.listProviderModels(provider.id, {
        refresh: /^(?:1|true)$/i.test(String(req.query?.refresh || '')),
      });
      const models = (result.body && Array.isArray(result.body.models) ? result.body.models : [])
        .map(item => Object.freeze({ model: item.model, label: item.label || item.model }));
      res.set?.('Cache-Control', 'no-store');
      return res.json({
        models, source: result.body?.source || 'fallback', cached: false,
        available: models.length > 0, refreshing: false, fallback: 'custom',
        diagnostic: { code: models.length ? 'ok' : 'none', message: '' },
      });
    }
    if (!pollOnly) {
      // No force flag here: opening a picker must respect the one-day cache.
      // Only successful login explicitly requests a new-identity refresh.
      void accountRuntime.refreshProvider(provider).catch(() => {});
    }
    const result = accountRuntime.peekProvider(provider);
    res.set?.('Cache-Control', 'no-store');
    return res.json({ ...result, available: !!result?.models?.length,
      refreshing: accountRuntime.isRefreshing(provider) });
  }
  app.get('/api/codex/models', async (req, res) => {
    // 老版客户端没有进度轮询协议，保留其等待全局目录的响应契约。
    // 新选择器总会携带 providerId，走下方立即响应的后台刷新路径。
    if (accountRuntime && !req.query?.providerId && !req.query?.poll) {
      await accountRuntime.refreshProvider('codex-official');
      return accountResponse(req, res, true);
    }
    if (accountRuntime) return accountResponse(req, res, /^(?:1|true)$/i.test(String(req.query?.poll || '')));
    const forceRefresh = /^(?:1|true)$/i.test(String(req.query && req.query.refresh || ''));
    const result = await runtime.list({ forceRefresh });
    res.json(result);
  });
  // Compatibility endpoint for older clients. Rust owns cache age/version
  // checks; this request cannot bypass them.
  if (typeof app.post === 'function') {
    app.post('/api/codex/models/sync', (req, res) => {
      if (accountRuntime) return accountResponse(req, res);
      res.json({ ok: true, ...runtime.syncIfDue() });
    });
  }
}

module.exports = {
  mountCodexModelRoutes,
  createCodexModelsRuntime,
  defaultRuntime,
  discoverCodexModels,
  readCodexDiskCatalog,
  normalizeModels,
  CODEX_MODELS_TTL_MS,
  CODEX_MODELS_DISK_FRESH_MS,
  CODEX_MODELS_STALE_MAX_MS,
  CODEX_MODELS_SYNC_INTERVAL_MS,
};
