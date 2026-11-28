'use strict';

// Scripted dependency world for the quota & pricing retirement differential
// (docs/rust-migration/differential/quota-routes.js).
//
// The twenty-two retired routes (tests/helpers/legacy-quota-routes.js) and the
// surviving host port (src/routes/quota-host.js) bottom out in the same
// handful of process-local facts: the models.dev price table, one fetcher per
// vendor console, the managed browser's visible-login window, the on-disk
// codex auth files, the arkcli subprocess and its installer, the in-process
// quota-bar cache, the Claude usage queue + live 5h map, and the
// recordVendor/recordClaude limit-cache writers. This module turns one plain
// JSON world into that dependency bag, so the frozen oracle and the front
// door's Node child read one world.
//
// Every call that decides something is recorded into `effects.calls`: the
// price table's arguments, each fetcher's arguments (the selectors the front
// door passed), the recorder payloads, the cache keys. finalize() compares the
// oracle's list against the stub's per case, so a route that answers the same
// bytes but asks Node for the wrong thing (or twice) fails.
//
// Determinism: there is no clock, no randomness, no network. `clock` in the
// world is the ONE time source — it feeds `deps.now`, the Claude usage queue's
// one-minute floor and the bar cache's `updatedAt`. The two real process-local
// stores (the usage queue and the bar cache) are the production modules, so
// their first-read / fresh-hit / expired / concurrent-join semantics are
// exercised rather than re-modelled; `apply` resets them when a case asks for
// it (`resetState:false` keeps them, which is how the hit/expiry cases work).

const fs = require('node:fs');
const path = require('node:path');

const barView = require('../../src/native/binding').getQuotaBarView();
const barState = require('../../src/native/binding').claudeBarState;
const usageQueue = require('../../src/native/binding').claudeUsageQueue;
const kimi = require('../../src/routes/kimi-quota');

const CACHE_FILE = 'quota-bar-cache.json';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** `String(value == null ? '' : value)`, only used for effect labels. */
function label(value) {
  return value === undefined ? null : clone(value);
}

function buildDeps(initialWorld = {}, options = {}) {
  const state = { world: initialWorld || {}, case: undefined };
  const effects = { calls: [] };
  const dataRoot = options.dataRoot || process.cwd();
  const codexAuthFile = path.join(dataRoot, 'quota-fixture-auth.json');
  let cache = null;
  let cacheFile = '';

  const record = entry => { effects.calls.push(entry); };
  const world = () => state.world || {};
  const clock = () => {
    const value = Number(world().clock);
    return Number.isFinite(value) ? value : 0;
  };

  // ── src/pricing/price-table.js ─────────────────────────────────────────

  const priceTable = {
    status() {
      record({ op: 'price.status' });
      const spec = world().price || {};
      return clone(spec.status === undefined ? { loaded: true, entries: 2 } : spec.status);
    },
    lookupMany(models) {
      record({ op: 'price.lookup', models: clone(models) });
      const prices = (world().price || {}).prices || {};
      return models.map(model => (prices[model] === undefined ? null : clone(prices[model])));
    },
    async refresh(input) {
      record({ op: 'price.refresh', force: !!(input && input.force === true) });
      const spec = (world().price || {}).refresh;
      if (spec && spec.throw !== undefined) throw new Error(spec.throw || 'refresh failed');
      return clone(spec === undefined ? { loaded: true, entries: 2 } : spec);
    },
    search(query, input) {
      const limit = input && input.limit !== undefined ? input.limit : null;
      record({ op: 'price.search', query, limit });
      const table = (world().price || {}).search || {};
      const rows = Array.isArray(table[query]) ? table[query] : [];
      return clone(limit === null ? rows : rows.slice(0, limit));
    },
  };

  // ── the vendor fetchers ────────────────────────────────────────────────

  function fetchValue(kind) {
    const spec = (world().fetch || {})[kind];
    if (spec === undefined) throw new Error(`${kind} fetch failed`);
    if (spec.throw !== undefined) throw new Error(spec.throw || `${kind} fetch failed`);
    return clone(spec.value === undefined ? null : spec.value);
  }

  async function fetchOpenCodeUsage() {
    record({ op: 'fetch', kind: 'opencode' });
    return fetchValue('opencode');
  }

  async function fetchQoderUsage() {
    record({ op: 'fetch', kind: 'qoder' });
    return fetchValue('qoder');
  }

  function codexWireFetch(url, init) {
    const headers = init.headers;
    record({
      op: 'codexWireFetch',
      valid: url === 'https://chatgpt.com/backend-api/wham/usage' && init.method === 'GET'
        && JSON.stringify(Object.keys(headers)) === JSON.stringify(['Authorization', 'ChatGPT-Account-Id', 'originator', 'Accept'])
        && headers.Authorization === 'Bearer quota-fixture-token' && headers['ChatGPT-Account-Id'] === 'fixture-account'
        && headers.originator === 'codex_cli_rs' && headers.Accept === 'application/json'
        && init.signal instanceof AbortSignal && !init.signal.aborted,
    });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      plan_type: 'fixture-plan', rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 604800, reset_at: 1800000000 } },
    }) });
  }

  async function fetchCodexUsage(nowMs, usageOptions) {
    if (world().codexWire) {
      if (usageOptions?.authFile !== codexAuthFile || usageOptions.fetch !== codexWireFetch) {
        throw new Error('expected the fixture account and transport');
      }
      return options.codexUsage(clock(), usageOptions);
    }
    record({
      op: 'fetch',
      kind: 'codex',
      nowMs: typeof nowMs === 'number' ? nowMs : null,
      authFile: usageOptions && usageOptions.authFile !== undefined ? usageOptions.authFile : null,
      injectedFetch: !!(usageOptions && typeof usageOptions.fetch === 'function'),
    });
    return fetchValue('codex');
  }

  async function fetchArkUsage() {
    record({ op: 'fetch', kind: 'ark' });
    return fetchValue('ark');
  }

  async function fetchKimiUsage(host, nowMs, usageDeps) {
    record({
      op: 'fetch',
      kind: 'kimi',
      host: host === undefined ? null : host,
      nowMs: typeof nowMs === 'number' ? nowMs : null,
      usageDeps: usageDeps === undefined ? null : Object.keys(usageDeps),
    });
    return fetchValue('kimi');
  }

  async function fetchAliyunUsage(nowMs, usageDeps) {
    record({
      op: 'fetch',
      kind: 'aliyun',
      nowMs: typeof nowMs === 'number' ? nowMs : null,
      usageDeps: usageDeps === undefined ? null : Object.keys(usageDeps),
    });
    return fetchValue('aliyun');
  }

  async function fetchClaudeUsage(...args) {
    // The usage queue calls fetchUsage() for the shared key and
    // fetchUsage({ accountId }) for a borrowed official account.
    record({
      op: 'fetch',
      kind: 'claude',
      argc: args.length,
      accountId: args.length && args[0] && args[0].accountId !== undefined ? args[0].accountId : null,
    });
    return fetchValue('claude');
  }

  // ── the visible-login window on the managed profile ───────────────────

  // The deps bag carries an object (`deps.loginUrl[kind]`), so the per-world
  // URLs are getters rather than a snapshot.
  function loginUrlFor(kind) {
    const urls = world().loginUrl || {};
    return urls[kind] === undefined ? `https://quota.test/${kind}/login` : urls[kind];
  }
  const loginUrl = {};
  for (const kind of ['opencode', 'qoder', 'kimi', 'claude', 'aliyun']) {
    Object.defineProperty(loginUrl, kind, { enumerable: true, get: () => loginUrlFor(kind) });
  }

  async function openLogin(url) {
    record({ op: 'login', url });
    const fail = (world().login || {}).fail;
    if (fail) {
      const error = new Error(fail.message === undefined ? 'login window failed' : fail.message);
      if (fail.code !== undefined) error.code = fail.code;
      throw error;
    }
    return undefined;
  }

  // ── codex official accounts ───────────────────────────────────────────

  function resolveAccountAuthFile(id) {
    record({ op: 'accountAuthFile', id });
    if (world().codexWire && id === 'fixture-account') return codexAuthFile;
    const files = (world().accounts || {}).files || {};
    return files[id] === undefined ? null : files[id];
  }

  // ── arkcli: locate, spawn login, install ──────────────────────────────

  function resolveArkcliBin() {
    record({ op: 'arkcli.resolve' });
    const spec = world().arkcli || {};
    if (spec.resolveThrows !== undefined) throw new Error(spec.resolveThrows || 'PATH lookup failed');
    return clone(spec.bin === undefined ? null : spec.bin);
  }

  function spawnArkcli(cmd, args, spawnOptions) {
    record({
      op: 'arkcli.spawn',
      cmd,
      args: clone(args),
      detached: !!(spawnOptions && spawnOptions.detached === true),
      stdio: spawnOptions ? clone(spawnOptions.stdio) : null,
    });
    const spec = (world().arkcli || {}).spawn || {};
    if (spec.throw !== undefined) throw new Error(spec.throw || 'spawn failed');
    return {
      pid: spec.pid === undefined ? 4242 : spec.pid,
      unref() { record({ op: 'arkcli.unref' }); },
    };
  }

  async function installArkcli() {
    record({ op: 'arkcli.install' });
    const spec = (world().arkcli || {}).install || {};
    if (spec.throw !== undefined) throw new Error(spec.throw || 'install failed');
    const out = { ok: spec.ok !== false };
    if (spec.error !== undefined) out.error = spec.error;
    return out;
  }

  // ── the quota-bar cache (the production module) ───────────────────────

  function resetCache() {
    cache = null;
    if (!cacheFile) return;
    for (const suffix of ['', '.bak1', '.bak2', '.bak3', '.tmp']) {
      fs.rmSync(cacheFile + suffix, { force: true });
    }
  }

  function currentCache() {
    if (cache) return cache;
    const { createQuotaBarCache } = require('../../src/native/binding').quotaBarCache;
    cacheFile = path.join(dataRoot, CACHE_FILE);
    cache = createQuotaBarCache({ file: cacheFile, now: clock, logger: { warn() {} } });
    return cache;
  }

  const quotaBarCache = {
    record(kind, result, bar, selector) {
      record({
        op: 'cache.record',
        kind,
        status: result && result.status !== undefined ? clone(result.status) : null,
        selector: label(selector),
      });
      return currentCache().record(kind, result, bar, selector);
    },
    get(kind, selector) {
      record({ op: 'cache.get', kind, selector: label(selector) });
      return currentCache().get(kind, selector);
    },
    snapshotFor(selector) {
      record({ op: 'cache.snapshot', selector: label(selector) });
      return currentCache().snapshotFor(selector);
    },
  };

  // ── recorders ─────────────────────────────────────────────────────────

  async function recordVendor(payload) {
    record({ op: 'recordVendor', record: clone(payload) });
    if (world().recordVendorThrows) throw new Error('recorder exploded');
  }

  async function recordClaude(session, result, text) {
    record({
      op: 'recordClaude',
      session,
      result: clone(result),
      text: text === undefined ? null : text,
    });
    if (world().recordClaudeThrows) throw new Error('recorder exploded');
  }

  const deps = {
    priceTable,
    fetchOpenCodeUsage,
    fetchQoderUsage,
    fetchCodexUsage,
    fetchArkUsage,
    fetchKimiUsage,
    fetchAliyunUsage,
    fetchClaudeUsage,
    loginUrl,
    openLogin,
    resolveAccountAuthFile,
    resolveArkcliBin,
    spawn: spawnArkcli,
    installArkcli,
    loadSavedCookies: () => {
      record({ op: 'cookies' });
      return clone(world().cookies);
    },
    rememberKimiBalance: kimi.rememberKimiBalance,
    lastKimiBalance: kimi.lastKimiBalance,
    claudeUsageKey: usageQueue.claudeUsageKey,
    readClaudeUsage: usageQueue.readClaudeUsage,
    enqueueClaudeUsage: usageQueue.enqueueClaudeUsage,
    readClaudeLive: barState.readClaudeLive,
    renderQuotaBar: barView.renderQuotaBar,
    idleQuotaBars: barView.idleQuotaBars,
    renderClaudeBar: session => barState.renderClaudeBar(session, clock()),
    // server.js passes `limitRecorder.recordVendor/recordClaude`; the world
    // always provides them, so the "no recorder" arms of the retired code
    // stay uncovered (they are unreachable in production).
    recordVendor,
    recordClaude,
    quotaBarCache,
    codexFetch: undefined,
    kimiUsageDeps: {},
    aliyunUsageDeps: {},
    now: clock,
  };

  // ── world application ─────────────────────────────────────────────────

  async function apply(next) {
    const scenario = next || {};
    state.world = scenario;
    const caseId = scenario.case === undefined ? null : scenario.case;
    const changed = caseId !== state.case;
    state.case = caseId;
    // The front door may call the host port more than once for one request
    // (a bar refresh commits after fetching); a second apply inside the same
    // case must not wipe the state the first call just built.
    if (!changed) return;
    effects.calls.length = 0;
    deps.codexFetch = scenario.codexWire ? codexWireFetch : undefined;
    if (scenario.codexWire) {
      fs.writeFileSync(codexAuthFile, JSON.stringify({ tokens: {
        access_token: 'quota-fixture-token', account_id: 'fixture-account',
      } }), { mode: 0o600 });
    }
    if (scenario.resetState !== false) {
      usageQueue.resetClaudeUsageQueue();
      barState.resetClaudeBarState();
      if (scenario.cache !== false) resetCache();
    }
    // The queue's one-minute floor and its injected fetcher are per-world.
    usageQueue.configureClaudeUsageQueue({ fetchUsage: fetchClaudeUsage, now: clock });
    if (scenario.accounts && scenario.accounts.enabled === false) {
      deps.resolveAccountAuthFile = undefined;
    } else {
      deps.resolveAccountAuthFile = resolveAccountAuthFile;
    }
    if (scenario.claude && scenario.claude.seed !== undefined) {
      // The queue keeps its readings private, so a seed goes in the one way
      // production does: through a scrape. The temporary fetcher hands it the
      // scenario's reading, which the queue stamps at the world's clock.
      const key = usageQueue.claudeUsageKey(scenario.claude.session || '');
      const seed = clone(scenario.claude.seed);
      usageQueue.configureClaudeUsageQueue({ fetchUsage: async () => seed, now: clock });
      await usageQueue.enqueueClaudeUsage(key);
      usageQueue.configureClaudeUsageQueue({ fetchUsage: fetchClaudeUsage, now: clock });
    }
    if (scenario.claudeLive) {
      for (const entry of [].concat(scenario.claudeLive)) {
        const normalized = barView.normalizeWindowEvent(clone(entry.info), clock());
        barState.rememberClaudeLive(entry.session || '', normalized);
      }
    }
    // `prewarmClaude` starts a scrape for that session just before the
    // request, the way another caller (the chat composer, a second tab) would
    // already have one open: the route must join it instead of scraping again.
    if (scenario.prewarmClaude !== undefined) {
      usageQueue.enqueueClaudeUsage(usageQueue.claudeUsageKey(scenario.prewarmClaude)).catch(() => {});
    }
  }

  apply(initialWorld);

  return { deps, apply, effects, world, clock };
}

module.exports = { buildDeps, CACHE_FILE };
