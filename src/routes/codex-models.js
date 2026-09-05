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

const CODEX_MODELS_TTL_MS = 60 * 1000;
const CODEX_MODELS_STALE_MAX_MS = 15 * 60 * 1000;
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
  let cache = null; // last verified account catalog only
  let inFlight = null;

  function response({ models, source, fetchedAt, cliVersion, code, stale = false }) {
    return Object.freeze({
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
      const models = normalizeModels(live && live.models);
      const fetchedAt = now();
      const result = response({
        models, source: 'cli', fetchedAt,
        cliVersion: live && live.cliVersion,
        code: models.length ? 'ok' : 'account_no_models',
      });
      // An authoritative empty response invalidates old entitlements too.
      cache = { at: fetchedAt, result };
      return result;
    } catch (error) {
      const code = Object.prototype.hasOwnProperty.call(DIAGNOSTICS, error && error.code)
        ? error.code : 'cli_error';
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
        code: cache.result.models.length ? 'ok' : 'account_no_models',
      });
    }
    if (inFlight) return inFlight;
    inFlight = refresh().finally(() => { inFlight = null; });
    return inFlight;
  }

  return Object.freeze({
    list,
    _resetForTest() { cache = null; inFlight = null; },
  });
}

const defaultRuntime = createCodexModelsRuntime();

function mountCodexModelRoutes(app, runtime = defaultRuntime) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/codex/models', async (req, res) => {
    const forceRefresh = /^(?:1|true)$/i.test(String(req.query && req.query.refresh || ''));
    const result = await runtime.list({ forceRefresh });
    res.json(result);
  });
}

module.exports = {
  mountCodexModelRoutes,
  createCodexModelsRuntime,
  discoverCodexModels,
  readCodexDiskCatalog,
  normalizeModels,
  CODEX_MODELS_TTL_MS,
  CODEX_MODELS_STALE_MAX_MS,
};
