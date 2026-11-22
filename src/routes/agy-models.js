'use strict';
// Node mirror of native/gateway/src/app/agy_catalog.rs — same discovery, same
// rules, same cache windows. The Rust front door owns GET /api/agy/models; this
// module exists for the one Node consumer that cannot wait on that route: the
// Auto Provider pool builds `<cli>-native:<cli>` candidates synchronously
// (`nativeVendorModels`), and an empty list there leaves the agy line without a
// model to pin.
//
// Like the Rust side, the catalog is read from a real ACP `session/new` on the
// signed-in account (spawn `agy acp`, `initialize`, `session/new`, take the
// `model` config option). Nothing here knows vendor model names, so the Node
// catalog cannot drift from what the Web picker gets from Rust.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

/// Mirrors TTL / FAIL_TTL in agy_catalog.rs.
const TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 30 * 1000;
/// The Rust route wraps the probe in a 25s timeout; a background warm needs its
/// own since no request is waiting on it.
const TIMEOUT_MS = Number(process.env.AGY_MODELS_TIMEOUT_MS || 25000);
const MAX_LINE = 4_000_000;

/// `{ at, models }` with `models === null` recording a failed probe inside the
/// same window, exactly like the Rust `Option<(Instant, Option<Vec<Value>>)>`.
let entry = null;
let warming = false;

// Mirrors executable() in agy_catalog.rs (which itself mirrors resolveAgy()):
// AGY_CMD wins, then the usual install locations, then the bare name on PATH.
function executable() {
  const override = process.env.AGY_CMD;
  if (override) return override;
  const binary = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const candidates = [];
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, '.local', 'bin', binary));
  }
  if (process.platform === 'darwin') {
    candidates.push(path.join('/opt/homebrew/bin', binary));
    candidates.push(path.join('/usr/local/bin', binary));
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) { /* keep looking */ }
  }
  return binary;
}

// Mirrors model_options(): find the config option whose id or category is
// `model`, keep each option's trimmed `value`, and fall back to the id when the
// agent omits `name`.
function modelOptions(session) {
  const options = session && Array.isArray(session.configOptions)
    ? session.configOptions
    : null;
  if (!options) return [];
  const model = options.find(
    (item) => item && (item.id === 'model' || item.category === 'model'),
  );
  if (!model || !Array.isArray(model.options)) return [];
  const models = [];
  for (const item of model.options) {
    const value = item && typeof item.value === 'string' ? item.value.trim() : '';
    if (!value || value.length > 100) continue;
    const label = item && typeof item.name === 'string' ? item.name : value;
    models.push({ model: value, label });
  }
  return models;
}

// Mirrors fetch(): one `agy acp` child, `initialize` then `session/new`, read
// lines until the matching id. Any parse failure, closed stream, oversized line
// or empty catalog fails the probe.
function fetchModels() {
  return new Promise((resolve, reject) => {
    // 账号切换后，模型目录也要跟着走：agy 的登录全在 `$HOME/.gemini`。
    const pin = require('../agy-accounts').accountEnv();
    const child = spawn(executable(), ['acp'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(pin ? { env: { ...process.env, ...pin } } : {}),
    });
    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    // One persistent queue: a `for await` loop per response would close the
    // readline interface when the loop is left, so the second read would never
    // see its line.
    const buffered = [];
    let waiting = null;
    const failWaiters = (error) => {
      if (waiting) {
        const waiter = waiting;
        waiting = null;
        waiter.reject(error);
      }
    };
    lines.on('line', (line) => {
      if (waiting) {
        const waiter = waiting;
        waiting = null;
        waiter.resolve(line);
      } else {
        buffered.push(line);
      }
    });
    lines.on('close', () => failWaiters(new Error('agy acp closed early')));

    let settled = false;
    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      failWaiters(error || new Error('agy acp finished'));
      lines.close();
      try { child.stdin.end(); } catch (_) {}
      child.kill();
      if (error) reject(error); else resolve(models);
    };
    const timer = setTimeout(
      () => finish(new Error('agy acp timeout')),
      TIMEOUT_MS,
    );
    child.on('error', (error) => finish(error));
    child.on('close', () => finish(new Error('agy acp exited')));

    const nextLine = () => {
      if (buffered.length) return Promise.resolve(buffered.shift());
      return new Promise((resolveLine, rejectLine) => {
        waiting = { resolve: resolveLine, reject: rejectLine };
      });
    };
    const readResponse = async (id) => {
      for (;;) {
        const line = await nextLine();
        if (line.length > MAX_LINE) throw new Error('agy acp line too long');
        let message;
        try {
          message = JSON.parse(line);
        } catch (_) {
          throw new Error('agy acp sent invalid json');
        }
        if (Number(message && message.id) !== id) continue;
        if (!message.result) throw new Error('agy acp answered without a result');
        return message.result;
      }
    };

    (async () => {
      try {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'multicc-models', version: '1.0.0' },
          },
        })}\n`);
        await readResponse(1);
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: process.cwd(), mcpServers: [] },
        })}\n`);
        const result = await readResponse(2);
        const models = modelOptions(result);
        if (!models.length) throw new Error('agy acp returned no model option');
        finish(null, models);
      } catch (error) {
        finish(error);
      }
    })();
  });
}

function fresh() {
  if (!entry) return false;
  const ttl = entry.models ? TTL_MS : FAIL_TTL_MS;
  return Date.now() - entry.at < ttl;
}

// `source` is `cli` for a live probe, `cache` for the warm catalog, and
// `unavailable` for a failed probe (also what the 30s backoff answers).
function listAgyModels(callback, opts = {}) {
  if (!opts.refresh && fresh()) {
    const { models } = entry;
    return setImmediate(
      () => callback(null, models || [], models ? 'cache' : 'unavailable'),
    );
  }
  fetchModels().then(
    (models) => {
      entry = { at: Date.now(), models };
      callback(null, models, 'cli');
    },
    () => {
      entry = { at: Date.now(), models: null };
      callback(null, [], 'unavailable');
    },
  );
}

// Synchronous best effort for the Auto Provider pool. A cold cache kicks off a
// single background warm (never blocks the caller, never retries while the
// failed probe is still fresh) and answers [] until it lands.
function peekAgyModels() {
  if (fresh()) return (entry.models || []).slice();
  if (!warming) {
    warming = true;
    listAgyModels(() => { warming = false; });
  }
  return [];
}

module.exports = {
  listAgyModels,
  peekAgyModels,
  _modelOptionsForTest: modelOptions,
  _resetCacheForTest() { entry = null; warming = false; },
};
