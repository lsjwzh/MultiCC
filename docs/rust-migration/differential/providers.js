'use strict';
// Differential run that retired the provider cluster from Node: the 16 routes
// now answered by native/gateway/src/app/providers.rs (plus
// multicc_core::provider_registry):
//
//   GET|HEAD|OPTIONS /api/providers                (GET answers the catalog)
//   POST|OPTIONS    /api/providers                 (create)
//   GET|HEAD|OPTIONS /api/providers/stats
//   POST|OPTIONS    /api/providers/import
//   PATCH|DELETE|OPTIONS /api/providers/:appType/:id
//   POST|OPTIONS    /api/providers/:appType/:id/probe
//   POST|OPTIONS    /api/providers/:appType/:id/reassign-sessions
//   POST|OPTIONS    /api/providers/:appType/:id/relay-share
//   POST|OPTIONS    /api/providers/:appType/:id/relay-models/sync
//   GET|HEAD|OPTIONS /api/providers/:appType/:id/relay-import-code
//   GET|HEAD|OPTIONS /api/provider-relay-shares
//   DELETE|OPTIONS  /api/provider-relay-shares/:id
//   GET|HEAD|OPTIONS /api/provider-relay-shares/:id/code
//   GET|HEAD|PUT|OPTIONS /api/provider-defaults
//
//   node docs/rust-migration/differential/providers.js \
//     <repo> native/target/release/multicc-gateway <multicc_core.node>
//
// Node side: the frozen route module (tests/helpers/legacy-provider-routes.js)
// mounted on the real pipeline (request ids, /api JSON gzip, auth, express.json,
// safeErrorHandler).
//
// Rust side: the release multicc-gateway plus a stub Node child that mounts the
// real host port (src/routes/providers-host.js, mountProvidersHostRoute) with
// the very same fake subsystems, so the front door sees exactly the state the
// retired handler saw.
//
// One shared scenario file drives both sides. work/providers-world.js (written
// by this script) is loaded by the parent process (the oracle's `deps`) and by
// the stub child (the host port's `deps`). Every corpus case writes that file
// with its own scenario, tagged with the case name; the parent resets its world
// from it before the node request and the stub resets from it before each host
// operation. Each process appends every subsystem call it makes to an NDJSON
// trace (`{case, op, ...}`), and finalize() compares the two traces grouped by
// case, so the side effects of a case are compared in order as well as its
// response. Two exclusions keep that comparison meaningful: the routing-seam
// cases (their two sides are documented to differ) and the eager read-only
// facts reads (`getProviderSummary`, `getRelayImportToken`) whose values the
// body already contains.
//
// Why the oracle handlers are wrapped with the repo's OWN asyncHandler: the
// frozen async handlers (catalog, delete, probe, reassign, relay-*, defaults)
// call `(req.query.X || '').trim()`; a repeated/nested query parameter makes
// `X` an array/object, the `.trim` call throws, and Express 4 never catches an
// async rejection. The repo's stated convention (src/http-errors.js: "Async
// handlers should be wrapped with asyncHandler(fn) so their rejections reach
// here rather than hanging the request", already applied by
// src/routes/file-transfer-host.js) is the 500 internal_error DTO, and that is
// what the Rust handler answers (`express::error(ctx, 500, "...trim is not a
// function")`). Without the wrapper the node side would hang instead.
//
// Documented differences (the only two):
//   a) a host-port answer that is not 2xx (including an unreachable child)
//      becomes 503 rust_backend_unavailable. The corpus never constructs one.
//   b) the Facts/Exec pair is two host round trips, so a concurrent writer
//      between them can change the observation. The corpus is sequential.
// Consequently a fake that THROWS INSIDE a fact-only host operation is out of
// corpus: the oracle would answer 500 while the front door's host seam can only
// say 503. That concerns getCcSwitchStatus/listProviders/getProviderSummary/
// findProviderReferences/getAuxConfig/getProvider/relayModelCatalogRuntime.
// syncProvider (the ops with no try/catch in src/routes/providers-host.js).
// Every route-level catch (stats, import, create, update, deleteExec,
// probeExec, reassignExec, relayShareCreate, relaySharesList, relayShareRevoke,
// relayShareCodeFacts, defaults*) IS covered, because the host returns
// `{ok:false}` and the front door maps it exactly like the retired handler.
//
// qs shapes: the object form (`?appType[x]=1`) is only observable where the
// value is forwarded to the host as JSON (`.trim()` TypeError -> 500, and the
// relay-shares list filter). A qs OBJECT's members are not forwarded (both
// sides see `{}`), so the fake records non-string filter values as
// `<non-string>`; the corpus never depends on the object's contents.
//
// Routing-seam cases (marked expectedDifference, not corpus differences): the
// gateway claims only the exact lower-case `/api/` prefix and only the methods
// listed above, matching how Node's auth/gzip also key on `startsWith('/api/')`.
// `/API/...`, an undeclared method and `/speedtest` (kept in Node because it
// streams SSE) leave the Rust front door through forward() and show up as the
// stub's 599 marker; the Node side shows what the front door forwards TO.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const MOUNT_DEFAULTS = '{"claude":null,"codex":null}';
const SENSITIVE = 'upstream said 401: Authorization: Bearer sk-live-9f8e7d6c5b4a at /Users/alice/private/provider.json';

let world = null;
let scriptFile = '';
let nodeTraceFile = '';
let rustTraceFile = '';
let upstreamText = '';
// Cases whose two sides are documented to answer differently (the routing
// seam); their call traces differ by construction.
const SEAM_CASES = new Set();
// Read-only observations the host facts fetch eagerly and the retired handler
// only fetches on some branches. Their value is fully visible in the response
// body, so the byte comparison already covers them.
const EAGER_READS = new Set(['summary', 'relayImportToken']);

// ── the shared scenario world ───────────────────────────────────────────────
// Written to work/providers-world.js and required by both processes. It uses
// only single-quoted strings (no template literals) so this source string needs
// no escaping beyond its own text.
function worldSource() {
  return `'use strict';
// Scenario-driven fakes shared by the Node oracle and the host-port stub of the
// providers differential. One file, one meaning of a scenario JSON, two
// processes. Every subsystem call is appended to a per-process NDJSON trace.

const fs = require('node:fs');

const NL = String.fromCharCode(10);
const DEFAULT_NOW = 1700000000000;
const DEFAULT_PORT = 4321;
const CLI_APP_TYPE = {
  claude: 'claude', 'claude-exp': 'claude', opencode: 'claude', dsh: 'claude',
  codex: 'codex', 'codex-exp': 'codex',
};
const GLOBAL_POOL_CLIS = ['opencode', 'zcode', 'kimi', 'grok'];

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function scenarioError(spec) {
  const error = new Error(spec && typeof spec.message === 'string' ? spec.message : 'scenario failure');
  if (spec && spec.code !== undefined) error.code = spec.code;
  if (spec && spec.reason !== undefined) error.reason = spec.reason;
  return error;
}

function throwIf(spec) { if (spec) throw scenarioError(spec); }

// qs builds arrays/objects for repeated and bracketed keys; a trace records
// only the shape a filter can observe.
function describe(value) {
  if (value === undefined) return '<absent>';
  if (typeof value === 'string') return value;
  return '<non-string>';
}

function createWorld(options) {
  const traceFile = options.traceFile;
  const scriptFile = options.scriptFile;
  const mountDefaultsText = options.mountDefaultsText || '{}';
  const providerDefaultsFile = '/virtual/provider-defaults.json';
  const deps = {};
  let scenario = {};
  let caseName = 'mount';
  let defaults = null;
  let sessions = new Map();

  function trace(entry) {
    const record = { case: caseName };
    const keys = Object.keys(entry);
    for (let index = 0; index < keys.length; index += 1) record[keys[index]] = entry[keys[index]];
    fs.appendFileSync(traceFile, JSON.stringify(record) + NL);
  }

  function providersList() {
    return Array.isArray(scenario.providers) ? scenario.providers : [];
  }

  function providerSummary(appType, id) {
    const key = (appType === undefined || appType === null ? 'undefined' : String(appType)) + ':' + String(id);
    const table = scenario.summaries && typeof scenario.summaries === 'object' ? scenario.summaries : {};
    trace({ op: 'summary', appType: describe(appType), id: String(id) });
    return table[key] === undefined ? undefined : clone(table[key]);
  }

  deps.claudeCmd = '/opt/multicc/claude';
  deps.providerDefaultsFile = providerDefaultsFile;
  deps.URL = URL;
  deps.isLocalRequest = function () { return true; };
  deps.getClaudeOfficialViaProxy = function () { return null; };
  deps.logger = { warn: function () {}, info: function () {}, error: function () {} };
  deps.now = function () { return scenario.now === undefined ? DEFAULT_NOW : scenario.now; };
  deps.getPort = function () { return scenario.port === undefined ? DEFAULT_PORT : scenario.port; };

  deps.fs = {
    readFileSync: function (file) {
      if (file === providerDefaultsFile) return mountDefaultsText;
      const error = new Error('ENOENT: no such file or directory, open ' + String(file));
      error.code = 'ENOENT';
      throw error;
    },
  };
  deps.http = { request: function () { throw new Error('http.request is outside this differential'); } };
  deps.https = { request: function () { throw new Error('https.request is outside this differential'); } };
  deps.atomicWriteJson = function (file, value) {
    trace({ op: 'writeDefaults', value: clone(value) });
    throwIf(scenario.writeError);
  };

  deps.providers = {
    appTypeForCli: function (cli) { return CLI_APP_TYPE[cli] || null; },
    appTypesForCli: function (cli) {
      if (GLOBAL_POOL_CLIS.indexOf(cli) >= 0) return ['claude', 'codex'];
      const appType = CLI_APP_TYPE[cli];
      return appType ? [appType] : [];
    },
    providerSupportsCli: function (provider, cli) {
      if (!provider || !cli) return false;
      const blocked = Array.isArray(provider.unsupportedClis) ? provider.unsupportedClis : [];
      return blocked.indexOf(String(cli)) < 0;
    },
    getProvider: function (appType, id) {
      const text = String(id);
      const list = providersList();
      for (let index = 0; index < list.length; index += 1) {
        const provider = list[index];
        if (String(provider.id) !== text) continue;
        if (appType === undefined || appType === null || provider.appType === appType) return provider;
      }
      return null;
    },
    listProviders: function (appType) {
      trace({ op: 'listProviders', appType: describe(appType) });
      const list = providersList().filter(function (provider) {
        return appType === undefined || appType === null || provider.appType === appType;
      });
      return clone(list);
    },
    getCcSwitchStatus: function () {
      trace({ op: 'ccSwitchStatus' });
      return clone(scenario.ccSwitchStatus === undefined ? { available: false } : scenario.ccSwitchStatus);
    },
    getProviderUsageStats: function () {
      trace({ op: 'usageStats' });
      throwIf(scenario.usageStatsError);
      return clone(scenario.usageStats === undefined ? { stats: {}, updatedAt: DEFAULT_NOW } : scenario.usageStats);
    },
    importFromCcSwitch: function () {
      trace({ op: 'import' });
      throwIf(scenario.importError);
      return clone(scenario.importResult === undefined ? {} : scenario.importResult);
    },
    createProvider: function (input) {
      trace({ op: 'create', input: clone(input) });
      throwIf(scenario.createError);
      return clone(scenario.createResult === undefined ? {} : scenario.createResult);
    },
    updateProvider: function (appType, id, input) {
      trace({ op: 'update', appType: String(appType), id: String(id), input: clone(input) });
      throwIf(scenario.updateError);
    },
    deleteProvider: function (appType, id) {
      trace({ op: 'delete', appType: String(appType), id: String(id) });
      throwIf(scenario.deleteError);
      return scenario.deleteOk !== false;
    },
    claudeProbeRouteEnv: function (appType, id, port) {
      trace({ op: 'probeRouteEnv', appType: String(appType), id: String(id), port: port });
      if (Object.prototype.hasOwnProperty.call(scenario, 'probeRouteEnv')) return clone(scenario.probeRouteEnv);
      return {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port + '/claude-proxy/' + encodeURIComponent(String(id)) + '/remote',
        ANTHROPIC_API_KEY: 'multicc-probe',
      };
    },
    probeRelayModels: async function (routeEnv, candidates, claudeCmd) {
      trace({
        op: 'probe',
        routeEnv: clone(routeEnv),
        candidates: candidates === undefined ? '<absent>' : clone(candidates),
        claudeCmd: claudeCmd,
      });
      throwIf(scenario.probeError);
      return clone(scenario.probeResult === undefined ? { tested: [], accepted: [] } : scenario.probeResult);
    },
    getRelayImportToken: function (appType, id) {
      trace({ op: 'relayImportToken', appType: String(appType), id: String(id) });
      return scenario.relayImportToken === undefined ? '' : scenario.relayImportToken;
    },
  };

  deps.providerRouterRuntime = { getProviderSummary: providerSummary };

  deps.providerRelayShares = {
    create: async function (input) {
      trace({ op: 'shareCreate', input: clone(input) });
      throwIf(scenario.shareCreateError);
      const share = clone(scenario.shareRecord === undefined ? {
        id: 'share-1',
        appType: input.appType,
        providerId: input.providerId,
        providerName: input.providerName,
        publicBaseUrl: input.publicBaseUrl,
        relayBaseUrl: input.relayBaseUrl,
        createdAt: DEFAULT_NOW,
      } : scenario.shareRecord);
      return {
        share: share,
        credential: scenario.shareCredential === undefined
          ? 'mcr1.AbCdEf0123456789.secret-value'
          : scenario.shareCredential,
      };
    },
    list: async function (filter) {
      trace({
        op: 'shareList',
        appType: describe(filter && filter.appType),
        providerId: describe(filter && filter.providerId),
      });
      throwIf(scenario.shareListError);
      return clone(scenario.shareList === undefined ? [] : scenario.shareList);
    },
    getCredential: async function (id) {
      trace({ op: 'shareCredential', id: String(id) });
      throwIf(scenario.credentialError);
      return clone(scenario.credential === undefined ? { ok: false, code: 'not_found' } : scenario.credential);
    },
    revoke: async function (id) {
      trace({ op: 'shareRevoke', id: String(id) });
      throwIf(scenario.shareRevokeError);
      return clone(scenario.shareRevokeValue === undefined ? null : scenario.shareRevokeValue);
    },
    revokeProvider: async function (appType, providerId) {
      trace({ op: 'shareRevokeProvider', appType: String(appType), providerId: String(providerId) });
      throwIf(scenario.revokeProviderError);
    },
  };

  deps.findProviderReferences = function (args) {
    trace({
      op: 'references',
      appType: describe(args.appType),
      providerId: describe(args.providerId),
      defaults: clone(args.defaults),
      aux: clone(args.aux),
    });
    throwIf(scenario.referencesError);
    return clone(scenario.references === undefined ? [] : scenario.references);
  };
  deps.getAuxConfig = function () {
    trace({ op: 'getAuxConfig' });
    return clone(scenario.aux === undefined ? {} : scenario.aux);
  };

  function makePatch(kind) {
    return function (sessionId, body) {
      trace({ op: kind, sessionId: String(sessionId), body: clone(body) });
      const table = kind === 'applySessionPatch' ? scenario.applyPatches : scenario.previewPatches;
      const spec = table && Object.prototype.hasOwnProperty.call(table, String(sessionId))
        ? table[String(sessionId)] : undefined;
      if (spec === 'throw') throw new Error('session patch failed');
      const result = spec && typeof spec === 'object' ? spec : { status: 200, body: {} };
      return {
        status: result.status === undefined ? 200 : result.status,
        body: clone(result.body === undefined ? {} : result.body),
      };
    };
  }

  function clearAux(providerId) {
    trace({ op: 'clearAuxProvider', providerId: String(providerId) });
  }

  function reset(next) {
    scenario = next || {};
    caseName = typeof scenario.case === 'string' ? scenario.case : 'case';
    sessions = new Map();
    const rows = Array.isArray(scenario.sessions) ? scenario.sessions : [];
    for (let index = 0; index < rows.length; index += 1) {
      sessions.set(String(rows[index].id), clone(rows[index]));
    }
    deps.persistedSessions = sessions;

    if (scenario.relayRuntime === false) delete deps.relayModelCatalogRuntime;
    else deps.relayModelCatalogRuntime = {
      refreshDue: async function (args) {
        trace({ op: 'refreshDue', appType: clone(args && args.appType), cli: clone(args && args.cli) });
        throwIf(scenario.refreshDueError);
      },
      syncProvider: async function (appType, id, syncOptions) {
        trace({ op: 'syncProvider', appType: String(appType), id: String(id), force: !!(syncOptions && syncOptions.force) });
        throwIf(scenario.syncError);
        return clone(scenario.syncResult === undefined ? { ok: true } : scenario.syncResult);
      },
    };

    if (scenario.codexCatalog === false) delete deps.codexAccountModelCatalogRuntime;
    else deps.codexAccountModelCatalogRuntime = {
      refreshProvider: function (id) {
        trace({ op: 'refreshProvider', id: String(id) });
        return Promise.resolve({ ok: true });
      },
    };

    if (scenario.limitCache === false) delete deps.providerLimitCache;
    else deps.providerLimitCache = {
      prune: function (keys) {
        trace({ op: 'prune', keys: clone(keys) });
        throwIf(scenario.limitCacheError);
      },
      get: function (appType, id) {
        trace({ op: 'limitGet', appType: String(appType), id: String(id) });
        const table = scenario.limits && typeof scenario.limits === 'object' ? scenario.limits : {};
        const entry = table[String(appType) + ':' + String(id)];
        return entry === undefined ? null : clone(entry);
      },
    };

    if (scenario.limitRecorder === false) delete deps.limitRecorder;
    else deps.limitRecorder = {
      liveKeys: function () {
        trace({ op: 'liveKeys' });
        return clone(scenario.liveKeys === undefined ? [] : scenario.liveKeys);
      },
    };

    deps.limitCacheStaleMs = scenario.limitCacheStaleMs;

    if (scenario.patchRuntime === false) {
      delete deps.applySessionPatch;
      delete deps.previewSessionPatch;
      delete deps.clearAuxProvider;
    } else {
      deps.applySessionPatch = makePatch('applySessionPatch');
      deps.previewSessionPatch = makePatch('previewSessionPatch');
      deps.clearAuxProvider = clearAux;
    }

    if (defaults) {
      const source = clone(scenario.defaults === undefined ? { claude: null, codex: null } : scenario.defaults) || {};
      const current = Object.keys(defaults);
      for (let index = 0; index < current.length; index += 1) delete defaults[current[index]];
      const keys = Object.keys(source);
      for (let index = 0; index < keys.length; index += 1) defaults[keys[index]] = source[keys[index]];
    }
  }

  function attach(routes) {
    defaults = routes.providerDefaults;
    deps.providerDefaults = defaults;
    deps.validProviderId = routes.validProviderId;
    deps.saveProviderDefaults = function () {
      try {
        deps.atomicWriteJson(deps.providerDefaultsFile, defaults);
        return true;
      } catch (_) {
        return false;
      }
    };
    reset(scenario);
  }

  function resetFromFile() {
    let next = {};
    try { next = JSON.parse(fs.readFileSync(scriptFile, 'utf8')); } catch (_) { next = {}; }
    reset(next);
  }

  reset(scenario);
  return { deps: deps, reset: reset, attach: attach, resetFromFile: resetFromFile };
}

module.exports = { createWorld: createWorld };
`;
}

// ── the stub Node child ─────────────────────────────────────────────────────
function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [REPO] }));
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
const { createWorld } = require(${JSON.stringify(path.join(process.env.PROVIDERS_DIFF_WORK || '', 'providers-world.js'))});
const world = createWorld({
  traceFile: process.env.PROVIDERS_DIFF_RUST_TRACE,
  scriptFile: process.env.PROVIDERS_DIFF_SCENARIO,
  mountDefaultsText: ${JSON.stringify(MOUNT_DEFAULTS)},
});
const { createProviderRoutes } = require(path.join(REPO, 'tests/helpers/legacy-provider-routes'));
const routes = createProviderRoutes(world.deps);
world.attach(routes);
const { mountProvidersHostRoute } = require(path.join(REPO, 'src/routes/providers-host'));
const app = express();
app.use(express.json({ limit: '50mb' }));
// Each host operation answers from the scenario the case wrote; ops inside one
// request (facts then exec) accumulate on top of that same starting state.
app.use((req, res, next) => { world.resetFromFile(); next(); });
mountProvidersHostRoute(app, world.deps);
// Anything the front door forwards (a path outside what it claims) lands here
// and is marked, so the corpus can see the routing seam instead of a 404.
app.use((req, res) => {
  res.statusCode = 599;
  res.setHeader('content-type', 'text/plain');
  res.end('gateway-forwarded:' + req.method + ' ' + req.url);
});
const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const end = buffered.indexOf('\\r\\n');
    if (end < 0) return;
    socket.removeListener('data', onData);
    socket.pause();
    const rest = buffered.subarray(end + 2);
    if (rest.length) socket.unshift(rest);
    server.emit('connection', socket);
    socket.resume();
  };
  socket.on('data', onData);
  socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
`;
}

// ── corpus fixtures ─────────────────────────────────────────────────────────
function baseScenario() {
  return {
    defaults: { claude: 'claude-1', codex: null },
    providers: [
      { id: 'claude-1', appType: 'claude', name: 'Claude Line', baseUrl: 'https://claude.example', apiFormat: 'anthropic', hasToken: true },
      { id: 'claude-2', appType: 'claude', name: 'Second Claude', baseUrl: 'https://second.example', apiFormat: 'anthropic', hasToken: true },
      { id: 'codex-1', appType: 'codex', name: 'Codex Line', baseUrl: 'https://codex.example', apiFormat: 'openai-responses' },
      { id: 'codex-official', appType: 'codex', name: 'Codex Official', isOfficial: true },
      { id: 'opencode-1', appType: 'claude', name: 'Global Pool', apiFormat: 'anthropic', hasToken: true },
    ],
    summaries: {
      'claude:claude-1': { appType: 'claude', name: 'Claude Line', model: 'claude-sonnet-5', modelOptions: ['claude-sonnet-5', ' claude-haiku-5 ', 'claude-sonnet-5'] },
      'claude:claude-2': { appType: 'claude', name: 'Second Claude', modelOptions: [] },
      'codex:codex-1': { appType: 'codex', name: 'Codex Line', model: 'gpt-5-codex', modelOptions: ['gpt-5-codex'] },
      'codex:codex-official': { appType: 'codex', name: 'Codex Official', model: 'gpt-5.1-codex', isOfficial: true },
      'claude:opencode-1': { appType: 'claude', name: 'Global Pool', model: 'claude-opus-5' },
      'undefined:opencode-1': { appType: 'claude', name: 'Global Pool', model: 'claude-opus-5' },
    },
    sessions: [
      { id: 'sess-a', name: 'A', label: 'A', cli: 'claude', provider: 'claude-1' },
      { id: 'sess-b', name: 'B', label: 'B', cli: 'claude', provider: 'claude-1', model: 'claude-old' },
      {
        id: 'sess-auto', name: 'Auto', label: 'Auto', cli: 'claude',
        providerSelection: {
          mode: 'auto', maxAttempts: 2,
          candidates: [{ providerId: 'claude-1', enabled: true }, { providerId: 'claude-2', enabled: true }],
        },
      },
      { id: 'sess-sub', name: 'Sub', label: 'Sub', cli: 'claude', provider: 'claude-2', subagent: { providerId: 'claude-1', model: 'm1' } },
      { id: 'sess-sys', name: 'Sys', label: 'Sys', cli: 'claude', type: 'aux', provider: 'claude-1' },
    ],
    references: [{ kind: 'main', sessionId: 'sess-a' }, { kind: 'main', sessionId: 'sess-auto' }],
    aux: { claude: null, codex: null },
    ccSwitchStatus: { available: true, dir: '/Users/alice/.cc-switch', count: 3 },
    usageStats: { stats: { total: 12, byProvider: { 'claude:claude-1': 5 } }, updatedAt: 1700000000000 },
    limits: {
      'claude:claude-1': {
        kind: 'window',
        status: 'ok',
        summary: { provider: 'claude', windows: [{ window: '5h', usedPercent: 20, resetMs: 1700003600000 }] },
        summaryText: '5h 80%',
        fetchedAt: 1699999990000,
        updatedAt: 1699999991000,
        lastError: null,
        lastErrorAt: null,
      },
      'codex:codex-1': {
        kind: 'window',
        status: 'ok',
        summary: { provider: 'codex', windows: [{ window: '1wk', usedPercent: 55, resetMs: 1700300000000 }] },
        summaryText: '1wk 45%',
        fetchedAt: 1699999980000,
        updatedAt: 1699999985000,
        lastError: 'rate limited at /Users/alice/state',
        lastErrorAt: 1699999986000,
      },
    },
    liveKeys: ['claude:claude-1', 'codex:codex-1'],
  };
}

function sc(overrides) {
  return Object.assign(baseScenario(), overrides || {});
}

function readTrace(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    const name = record.case;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(record);
  }
  return map;
}

function isForwarded(method, url) {
  const body = `gateway-forwarded:${method} ${url}`;
  return (view) => view.status === 599 && view.body === body;
}

// The trace as the comparison sees it: no seam cases, no eager reads.
function comparableTrace(map) {
  const out = new Map();
  for (const [name, list] of map) {
    if (SEAM_CASES.has(name)) continue;
    const kept = list.filter(record => !EAGER_READS.has(record.op));
    if (kept.length) out.set(name, kept);
  }
  return out;
}

main({
  name: 'providers',
  mount(app, { repo, work }) {
    scriptFile = path.join(work, 'scenario.json');
    nodeTraceFile = path.join(work, 'node-trace.ndjson');
    rustTraceFile = path.join(work, 'rust-trace.ndjson');
    const worldPath = path.join(work, 'providers-world.js');
    fs.writeFileSync(worldPath, worldSource());
    fs.writeFileSync(nodeTraceFile, '');
    fs.writeFileSync(rustTraceFile, '');
    fs.writeFileSync(scriptFile, JSON.stringify({ case: 'mount' }));
    process.env.PROVIDERS_DIFF_WORK = work;
    process.env.PROVIDERS_DIFF_SCENARIO = scriptFile;
    process.env.PROVIDERS_DIFF_RUST_TRACE = rustTraceFile;

    const { createWorld } = require(worldPath);
    world = createWorld({ traceFile: nodeTraceFile, scriptFile, mountDefaultsText: MOUNT_DEFAULTS });
    const { createProviderRoutes } = require(path.join(repo, 'tests/helpers/legacy-provider-routes'));
    const routes = createProviderRoutes(world.deps);
    world.attach(routes);

    // Express 4 does not catch async rejections; the repo's own asyncHandler
    // is how every current async route reaches safeErrorHandler.
    const { asyncHandler } = require(path.join(repo, 'src/http-errors'));
    const wrapped = {};
    for (const method of ['get', 'post', 'patch', 'delete', 'put', 'options', 'all', 'use']) {
      wrapped[method] = function (first, ...rest) {
        if (typeof first === 'function') {
          return app[method](asyncHandler(first), ...rest.filter(item => typeof item !== 'function'));
        }
        return app[method](first, ...rest.map(item => (typeof item === 'function' ? asyncHandler(item) : item)));
      };
    }
    routes.mountCatalogRoutes(wrapped);
    routes.mountManagementRoutes(wrapped);
    upstreamText = upstreamSource(repo);
  },
  get upstream() { return upstreamText; },
  gatewayEnv: (work) => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    PROVIDERS_DIFF_SCENARIO: path.join(work, 'scenario.json'),
    PROVIDERS_DIFF_RUST_TRACE: path.join(work, 'rust-trace.ndjson'),
    PROVIDERS_DIFF_WORK: work,
  }),
  corpus() {
    const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
    const J = Object.assign({}, L, { 'Content-Type': 'application/json' });
    const get = (url) => ({ method: 'GET', url, headers: L });
    const head = (url) => ({ method: 'HEAD', url, headers: L });
    const options = (url) => ({ method: 'OPTIONS', url, headers: L });
    const send = (method, url, body, headers = J) => ({
      method,
      url,
      headers,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const post = (url, body, headers) => send('POST', url, body, headers);
    const patch = (url, body) => send('PATCH', url, body);
    const put = (url, body) => send('PUT', url, body);
    const del = (url) => ({ method: 'DELETE', url, headers: J });

    const cases = [];
    function add(name, scenario, request, extra) {
      const hooks = {
        before(side) {
          scenario.case = name;
          fs.writeFileSync(scriptFile, JSON.stringify(scenario));
          if (side.name === 'node') world.reset(scenario);
        },
      };
      if (extra && extra.normalize) hooks.normalize = extra.normalize;
      if (extra && extra.expectedDifference) {
        hooks.expectedDifference = extra.expectedDifference;
        SEAM_CASES.add(name);
      }
      cases.push([name, request, hooks]);
    }

    // ── catalog ────────────────────────────────────────────────────────────
    add('catalog base', sc(), get('/api/providers'));
    add('catalog trailing slash', sc(), get('/api/providers/'));
    add('catalog mixed case segments', sc(), get('/api/Providers'));
    add('catalog appType claude', sc(), get('/api/providers?appType=claude'));
    add('catalog appType codex', sc(), get('/api/providers?appType=codex'));
    add('catalog appType trimmed', sc(), get('/api/providers?appType=%20claude%20'));
    add('catalog appType unknown', sc(), get('/api/providers?appType=qoder'));
    add('catalog cli claude', sc(), get('/api/providers?cli=claude'));
    add('catalog cli codex incompatible', sc({
      providers: baseScenario().providers.map((provider) => (
        provider.id === 'claude-1' ? Object.assign({}, provider, { unsupportedClis: ['codex'] }) : provider
      )),
    }), get('/api/providers?cli=codex'));
    add('catalog appType+cli', sc(), get('/api/providers?appType=codex&cli=codex'));
    add('catalog poll=1', sc(), get('/api/providers?poll=1'));
    add('catalog poll=2', sc(), get('/api/providers?poll=2'));
    add('catalog poll empty', sc(), get('/api/providers?poll='));
    add('catalog poll repeated', sc(), get('/api/providers?poll=1&poll=2'));
    add('catalog poll object', sc(), get('/api/providers?poll[x]=1'));
    add('catalog repeated appType', sc(), get('/api/providers?appType=a&appType=b'));
    add('catalog nested appType', sc(), get('/api/providers?appType[x]=1'));
    add('catalog nested cli', sc(), get('/api/providers?cli[]=x'));
    add('catalog stale limit', sc({ limitCacheStaleMs: 5000 }), get('/api/providers'));
    add('catalog limit cache throws', sc({ limitCacheError: { message: 'cache exploded' } }), get('/api/providers'));
    add('catalog no limit cache', sc({ limitCache: false }), get('/api/providers'));
    add('catalog no limit recorder', sc({ limitRecorder: false }), get('/api/providers'));
    add('catalog no relay runtime', sc({ relayRuntime: false }), get('/api/providers'));
    add('catalog no codex catalog', sc({ codexCatalog: false }), get('/api/providers'));
    add('catalog refresh throws', sc({ refreshDueError: { message: 'refresh blew up' } }), get('/api/providers'));
    add('catalog ccSwitchStatus empty', sc({ ccSwitchStatus: {} }), get('/api/providers'));
    add('catalog HEAD', sc(), head('/api/providers'));
    add('catalog OPTIONS', sc(), options('/api/providers'));

    // ── stats ──────────────────────────────────────────────────────────────
    add('stats base', sc(), get('/api/providers/stats'));
    add('stats trailing slash', sc(), get('/api/providers/stats/'));
    add('stats mixed case path', sc(), get('/api/providers/Stats'));
    add('stats error sanitized', sc({ usageStatsError: { message: SENSITIVE } }), get('/api/providers/stats'));
    add('stats HEAD', sc(), head('/api/providers/stats'));
    add('stats OPTIONS', sc(), options('/api/providers/stats'));

    // ── import ─────────────────────────────────────────────────────────────
    add('import ok', sc(), post('/api/providers/import'));
    add('import result spread', sc({ importResult: { imported: 2, skipped: 1, source: 'cc-switch' } }), post('/api/providers/import'));
    add('import error dto', sc({
      importError: { message: SENSITIVE, code: 'CC_SWITCH_INVALID_STATE', reason: '/Users/alice/private cc-switch.json' },
    }), post('/api/providers/import'));
    add('import error unclean code', sc({
      importError: { message: 'cannot read /Users/alice/x', code: 'bad code!', reason: 'Bearer abc123' },
    }), post('/api/providers/import'));
    add('import OPTIONS', sc(), options('/api/providers/import'));
    add('import GET forwarded', sc(), get('/api/providers/import'), {
      expectedDifference: {
        node: (view) => view.status === 404,
        rust: isForwarded('GET', '/api/providers/import'),
      },
    });

    // ── create ─────────────────────────────────────────────────────────────
    add('create full', sc(), post('/api/providers', {
      appType: 'claude', name: 'New Line', baseUrl: 'https://new.example', authToken: 'tok-1234',
      model: 'claude-sonnet-5', models: ['claude-sonnet-5'], apiFormat: 'anthropic',
      settingsConfig: { env: { A: '1' } }, virtual: false, aliasMap: { a: 'b' },
    }));
    add('create minimal', sc(), post('/api/providers', {}));
    add('create trimmed', sc(), post('/api/providers', {
      appType: '  claude  ', baseUrl: ' https://x.example ', authToken: ' t ', model: ' m ',
    }));
    add('create result echo', sc({ createResult: { id: 'created-1', count: 2 } }), post('/api/providers', {
      appType: 'codex', baseUrl: 'https://c.example', model: 'gpt-5-codex',
    }));
    add('create egress ip valid', sc(), post('/api/providers', {
      appType: 'claude', baseUrl: 'https://x.example', egressIpAllowlist: ['10.0.0.1', ' 10.0.0.2 '],
    }));
    add('create egress ip empty', sc(), post('/api/providers', { appType: 'claude', egressIpAllowlist: [] }));
    add('create egress ip null', sc(), post('/api/providers', { appType: 'claude', egressIpAllowlist: null }));
    add('create egress ip invalid', sc(), post('/api/providers', {
      appType: 'claude', egressIpAllowlist: ['10.0.0.999'],
    }));
    add('create egress ip coerce', sc(), post('/api/providers', {
      appType: 'claude', egressIpAllowlist: [1, null],
    }));
    add('create egress ip not array', sc(), post('/api/providers', {
      appType: 'claude', egressIpAllowlist: '10.0.0.1',
    }));
    add('create egress binding valid', sc(), post('/api/providers', {
      appType: 'claude', egressBinding: { pluginId: 'plugin-a', profileId: 'profile-b', extra: 1 },
    }));
    add('create egress binding null', sc(), post('/api/providers', { appType: 'claude', egressBinding: null }));
    add('create egress binding array', sc(), post('/api/providers', { appType: 'claude', egressBinding: [1] }));
    add('create egress binding string', sc(), post('/api/providers', { appType: 'claude', egressBinding: 'x' }));
    add('create appType array', sc(), post('/api/providers', { appType: ['claude'] }));
    add('create appType number', sc(), post('/api/providers', { appType: 7 }));
    add('create body array', sc(), post('/api/providers', [1, 2]));
    add('create body null json', sc(), post('/api/providers', 'null'));
    add('create body primitive json', sc(), post('/api/providers', '"claude"'));
    add('create malformed json', sc(), post('/api/providers', '{"appType":'));
    add('create body no content type', sc(), send('POST', '/api/providers', '{"appType":"claude"}', L));
    add('create error sanitized', sc({ createError: { message: SENSITIVE } }), post('/api/providers', {
      appType: 'claude', baseUrl: 'https://x.example',
    }));
    add('create OPTIONS', sc(), options('/api/providers'));

    // ── update (PATCH) ─────────────────────────────────────────────────────
    add('update raw fields', sc(), patch('/api/providers/claude/claude-1', {
      name: 'Renamed', baseUrl: ' https://raw.example ', authToken: ' t ', model: ' m ',
      models: ['a', 'b'], apiFormat: 'anthropic', settingsConfig: { env: {} }, virtual: true,
      aliasMap: { a: 'b' },
    }));
    add('update empty body', sc(), patch('/api/providers/claude/claude-1', {}));
    add('update body array', sc(), patch('/api/providers/claude/claude-1', [1]));
    add('update encoded id', sc(), patch('/api/providers/claude/claude%2D1', { name: 'X' }));
    add('update egress invalid ip', sc(), patch('/api/providers/claude/claude-1', {
      egressIpAllowlist: ['999.1.1.1'],
    }));
    add('update egress binding invalid', sc(), patch('/api/providers/claude/claude-1', {
      egressBinding: 'nope',
    }));
    add('update error sanitized', sc({ updateError: { message: SENSITIVE } }), patch('/api/providers/claude/claude-1', {
      name: 'X',
    }));
    add('update bad param encoding', sc(), patch('/api/providers/claude/%E0%A4%A', { name: 'X' }));
    add('update OPTIONS', sc(), options('/api/providers/claude/claude-1'));

    // ── delete ─────────────────────────────────────────────────────────────
    add('delete unreferenced', sc({ references: [] }), del('/api/providers/claude/claude-1'));
    add('delete in use', sc({
      references: [{ kind: 'main', sessionId: 'sess-a' }],
    }), del('/api/providers/claude/claude-1'));
    add('delete force=1', sc({
      references: [{ kind: 'main', sessionId: 'sess-a' }],
    }), del('/api/providers/claude/claude-1?force=1'));
    add('delete force=TRUE', sc({
      references: [{ kind: 'main', sessionId: 'sess-a' }],
    }), del('/api/providers/claude/claude-1?force=TRUE'));
    add('delete force=0', sc({
      references: [{ kind: 'main', sessionId: 'sess-a' }],
    }), del('/api/providers/claude/claude-1?force=0'));
    add('delete force default reference', sc({
      references: [{ kind: 'default', cli: 'claude' }],
    }), del('/api/providers/claude/claude-1?force=1'));
    add('delete force aux reference', sc({
      references: [{ kind: 'aux', protocol: 'claude' }],
    }), del('/api/providers/claude/claude-1?force=1'));
    add('delete force auto session', sc({
      references: [{ kind: 'main', sessionId: 'sess-auto' }],
    }), del('/api/providers/claude/claude-1?force=1'));
    add('delete force subagent session', sc({
      references: [{ kind: 'main', sessionId: 'sess-sub' }],
    }), del('/api/providers/claude/claude-1?force=1'));
    add('delete force patch failed', sc({
      references: [{ kind: 'main', sessionId: 'sess-a' }],
      applyPatches: { 'sess-a': { status: 500, body: { error: SENSITIVE } } },
    }), del('/api/providers/claude/claude-1?force=1'));
    add('delete patch runtime missing', sc({
      patchRuntime: false,
      references: [{ kind: 'main', sessionId: 'sess-a' }],
    }), del('/api/providers/claude/claude-1?force=1'));
    add('delete returns false', sc({ references: [], deleteOk: false }), del('/api/providers/claude/claude-1'));
    add('delete throws', sc({ references: [], deleteError: { message: SENSITIVE } }), del('/api/providers/claude/claude-1'));
    add('delete revoke throws', sc({
      references: [],
      revokeProviderError: { message: SENSITIVE },
    }), del('/api/providers/claude/claude-1'));
    add('delete encoded id', sc({ references: [] }), del('/api/providers/claude/claude%2D1'));
    add('delete bad param encoding', sc(), del('/api/providers/claude/%E0%A4%A'));
    add('delete force repeated', sc({
      references: [{ kind: 'main', sessionId: 'sess-a' }],
    }), del('/api/providers/claude/claude-1?force=1&force=1'));

    // ── probe ──────────────────────────────────────────────────────────────
    add('probe no candidates', sc(), post('/api/providers/claude/claude-1/probe', {}));
    add('probe candidates', sc(), post('/api/providers/claude/claude-1/probe', {
      candidates: [' claude-sonnet-5 ', 'claude-sonnet-5', 'claude-haiku-5'],
    }));
    add('probe sanitizes result', sc({
      probeResult: {
        tested: [{ model: 'm', error: SENSITIVE, sample: 'Bearer sk-live-1 at /Users/alice/x', reason: '/Users/alice/y' }],
        accepted: ['m'],
        error: '/Users/alice/z',
        extra: 1,
      },
    }), post('/api/providers/claude/claude-1/probe', { candidates: ['m'] }));
    add('probe 20 candidates', sc(), post('/api/providers/claude/claude-1/probe', {
      candidates: Array.from({ length: 20 }, (_, index) => `model-${index}-${'x'.repeat(189)}`),
    }));
    add('probe 21 candidates', sc(), post('/api/providers/claude/claude-1/probe', {
      candidates: Array.from({ length: 21 }, (_, index) => `model-${index}`),
    }));
    add('probe candidate 200 chars', sc(), post('/api/providers/claude/claude-1/probe', {
      candidates: ['m'.repeat(200)],
    }));
    add('probe candidate 201 chars', sc(), post('/api/providers/claude/claude-1/probe', {
      candidates: ['m'.repeat(201)],
    }));
    add('probe candidate empty', sc(), post('/api/providers/claude/claude-1/probe', { candidates: ['   '] }));
    add('probe candidate non-string', sc(), post('/api/providers/claude/claude-1/probe', { candidates: [1] }));
    add('probe candidates not array', sc(), post('/api/providers/claude/claude-1/probe', { candidates: 'm' }));
    add('probe candidates null', sc(), post('/api/providers/claude/claude-1/probe', { candidates: null }));
    add('probe no base url', sc({ probeRouteEnv: null }), post('/api/providers/claude/claude-1/probe', {}));
    add('probe missing provider', sc(), post('/api/providers/claude/ghost/probe', {}));
    add('probe throws', sc({ probeError: { message: SENSITIVE } }), post('/api/providers/claude/claude-1/probe', {}));
    add('probe OPTIONS', sc(), options('/api/providers/claude/claude-1/probe'));
    add('probe bad param encoding', sc(), post('/api/providers/claude/%E0%A4%A/probe', {}));

    // ── reassign sessions ──────────────────────────────────────────────────
    add('reassign list', sc(), post('/api/providers/claude/claude-1/reassign-sessions', { dryRun: true }));
    add('reassign list dryRun string', sc(), post('/api/providers/claude/claude-1/reassign-sessions', { dryRun: 'true' }));
    add('reassign dry run target', sc({
      previewPatches: {
        'sess-a': { status: 200, body: { model: 'claude-sonnet-5' } },
        'sess-b': { status: 200, body: { model: 'claude-sonnet-5' } },
      },
    }), post('/api/providers/claude/claude-1/reassign-sessions', {
      targetProviderId: 'claude-2', dryRun: true,
    }));
    add('reassign apply target', sc({
      applyPatches: {
        'sess-a': { status: 200, body: { model: 'claude-sonnet-5' } },
        'sess-b': { status: 200, body: { model: 'claude-sonnet-5', deferred: true } },
      },
    }), post('/api/providers/claude/claude-1/reassign-sessions', { targetProviderId: 'claude-2' }));
    add('reassign patch rejected', sc({
      previewPatches: { 'sess-a': { status: 409, body: { error: SENSITIVE } } },
    }), post('/api/providers/claude/claude-1/reassign-sessions', {
      targetProviderId: 'claude-2', dryRun: true,
    }));
    add('reassign target same', sc(), post('/api/providers/claude/claude-1/reassign-sessions', {
      targetProviderId: 'claude-1', dryRun: true,
    }));
    add('reassign target same padded', sc(), post('/api/providers/claude/claude-1/reassign-sessions', {
      targetProviderId: '  claude-1  ', dryRun: true,
    }));
    add('reassign needs target', sc(), post('/api/providers/claude/claude-1/reassign-sessions', {}));
    add('reassign unknown target', sc(), post('/api/providers/claude/claude-1/reassign-sessions', {
      targetProviderId: 'ghost', dryRun: true,
    }));
    add('reassign invalid appType', sc(), post('/api/providers/qoder/claude-1/reassign-sessions', { dryRun: true }));
    add('reassign trimmed appType', sc(), post('/api/providers/%20claude%20/claude-1/reassign-sessions', { dryRun: true }));
    add('reassign missing source', sc(), post('/api/providers/claude/ghost/reassign-sessions', { dryRun: true }));
    add('reassign no patch runtime', sc({ patchRuntime: false }), post('/api/providers/claude/claude-1/reassign-sessions', { dryRun: true }));
    add('reassign dryRun number', sc(), post('/api/providers/claude/claude-1/reassign-sessions', { dryRun: 1 }));
    add('reassign body array', sc(), post('/api/providers/claude/claude-1/reassign-sessions', [1]));
    add('reassign OPTIONS', sc(), options('/api/providers/claude/claude-1/reassign-sessions'));

    // ── relay share ────────────────────────────────────────────────────────
    const SHARE_BODY = { publicBaseUrl: 'https://Share.Example.com:443/base?x=1', token: 'tok-12345678', label: 'L' };
    add('relay share ok', sc(), post('/api/providers/claude/claude-1/relay-share', SHARE_BODY));
    add('relay share http', sc(), post('/api/providers/claude/claude-1/relay-share', {
      publicBaseUrl: 'http://share.example.com/', token: 'tok-12345678',
    }));
    add('relay share no base', sc(), post('/api/providers/claude/claude-1/relay-share', { token: 'tok-12345678' }));
    add('relay share ftp', sc(), post('/api/providers/claude/claude-1/relay-share', { publicBaseUrl: 'ftp://x.example' }));
    add('relay share invalid url', sc(), post('/api/providers/claude/claude-1/relay-share', { publicBaseUrl: 'not a url' }));
    add('relay share missing provider', sc(), post('/api/providers/claude/ghost/relay-share', SHARE_BODY));
    add('relay share codex', sc(), post('/api/providers/codex/codex-1/relay-share', SHARE_BODY));
    add('relay share no provider name', sc({
      providers: baseScenario().providers.map((provider) => (
        provider.id === 'claude-1' ? Object.assign({}, provider, { name: '' }) : provider
      )),
    }), post('/api/providers/claude/claude-1/relay-share', SHARE_BODY));
    add('relay share unicode name', sc({
      providers: baseScenario().providers.map((provider) => (
        provider.id === 'claude-1' ? Object.assign({}, provider, { name: '线路 · 一号' }) : provider
      )),
    }), post('/api/providers/claude/claude-1/relay-share', SHARE_BODY));
    add('relay share empty models', sc(), post('/api/providers/claude/claude-2/relay-share', SHARE_BODY));
    add('relay share official claude models', sc({
      providers: baseScenario().providers.concat([
        { id: 'claude-official', appType: 'claude', name: 'Claude Official', isOfficial: true },
      ]),
      summaries: Object.assign({}, baseScenario().summaries, {
        'claude:claude-official': { appType: 'claude', name: 'Claude Official', isOfficial: true },
      }),
    }), post('/api/providers/claude/claude-official/relay-share', SHARE_BODY));
    add('relay share token invalid', sc({
      shareCreateError: { code: 'RELAY_TOKEN_INVALID', message: SENSITIVE },
    }), post('/api/providers/claude/claude-1/relay-share', SHARE_BODY));
    add('relay share create throws', sc({
      shareCreateError: { message: SENSITIVE },
    }), post('/api/providers/claude/claude-1/relay-share', SHARE_BODY));
    add('relay share empty credential', sc({ shareCredential: '' }), post('/api/providers/claude/claude-1/relay-share', SHARE_BODY));
    add('relay share share record', sc({
      shareRecord: { id: 'share-9', appType: 'claude', providerId: 'claude-1', relayBaseUrl: 'https://s.example/x', createdAt: 1700000000123 },
    }), post('/api/providers/claude/claude-1/relay-share', SHARE_BODY));
    add('relay share OPTIONS', sc(), options('/api/providers/claude/claude-1/relay-share'));

    // ── relay models sync ──────────────────────────────────────────────────
    add('relay sync ok', sc({ syncResult: { ok: true, models: ['m1', 'm2'] } }), post('/api/providers/claude/claude-1/relay-models/sync'));
    add('relay sync not relay', sc({ syncResult: { ok: false, reason: 'not_relay' } }), post('/api/providers/claude/claude-1/relay-models/sync'));
    add('relay sync failure', sc({
      syncResult: { ok: false, reason: 'upstream', detail: 'Bearer sk-live-1 at /Users/alice/x' },
    }), post('/api/providers/claude/claude-1/relay-models/sync'));
    add('relay sync unavailable', sc({ relayRuntime: false }), post('/api/providers/claude/claude-1/relay-models/sync'));
    add('relay sync missing provider', sc({ relayRuntime: false }), post('/api/providers/claude/ghost/relay-models/sync'));
    add('relay sync trailing slash', sc(), post('/api/providers/claude/claude-1/relay-models/sync/'));
    add('relay sync OPTIONS', sc(), options('/api/providers/claude/claude-1/relay-models/sync'));

    // ── relay shares list / revoke / code ──────────────────────────────────
    add('relay shares list', sc({ shareList: [{ id: 'share-1', appType: 'claude', providerId: 'claude-1' }] }), get('/api/provider-relay-shares'));
    add('relay shares list filters', sc(), get('/api/provider-relay-shares?appType=claude&providerId=claude-1'));
    add('relay shares list empty filter', sc(), get('/api/provider-relay-shares?appType=claude&providerId='));
    add('relay shares list repeated', sc(), get('/api/provider-relay-shares?appType=a&appType=b'));
    add('relay shares list object', sc(), get('/api/provider-relay-shares?appType[x]=1'));
    add('relay shares list error', sc({ shareListError: { message: SENSITIVE } }), get('/api/provider-relay-shares'));
    add('relay shares HEAD', sc(), head('/api/provider-relay-shares'));
    add('relay shares OPTIONS', sc(), options('/api/provider-relay-shares'));
    add('relay share delete ok', sc({
      shareRevokeValue: { id: 'share-1', appType: 'claude', providerId: 'claude-1', revokedAt: 1700000000000 },
    }), del('/api/provider-relay-shares/share-1'));
    add('relay share delete missing', sc({ shareRevokeValue: null }), del('/api/provider-relay-shares/share-1'));
    add('relay share delete error', sc({ shareRevokeError: { message: SENSITIVE } }), del('/api/provider-relay-shares/share-1'));
    add('relay share delete encoded id', sc(), del('/api/provider-relay-shares/a%2Fb'));
    add('relay share delete bad encoding', sc(), del('/api/provider-relay-shares/%E0%A4%A'));
    add('relay share delete OPTIONS', sc(), options('/api/provider-relay-shares/share-1'));
    const CREDENTIAL_SHARE = {
      ok: true,
      share: {
        id: 'share-1',
        appType: 'claude',
        providerId: 'claude-1',
        providerName: 'Claude Line',
        relayBaseUrl: 'https://share.example.com/claude-proxy/claude-1/remote',
      },
      credential: 'mcr1.AbCdEf0123456789.secret-value',
    };
    add('relay share code ok', sc({ credential: CREDENTIAL_SHARE }), get('/api/provider-relay-shares/share-1/code'));
    add('relay share code not found', sc({ credential: { ok: false, code: 'not_found' } }), get('/api/provider-relay-shares/share-1/code'));
    add('relay share code revoked', sc({ credential: { ok: false, code: 'revoked' } }), get('/api/provider-relay-shares/share-1/code'));
    add('relay share code legacy', sc({ credential: { ok: false, code: 'legacy' } }), get('/api/provider-relay-shares/share-1/code'));
    add('relay share code empty code', sc({ credential: { ok: false } }), get('/api/provider-relay-shares/share-1/code'));
    add('relay share code provider gone', sc({
      credential: Object.assign({}, CREDENTIAL_SHARE, {
        share: Object.assign({}, CREDENTIAL_SHARE.share, { providerId: 'ghost' }),
      }),
    }), get('/api/provider-relay-shares/share-1/code'));
    add('relay share code throws', sc({ credentialError: { message: SENSITIVE } }), get('/api/provider-relay-shares/share-1/code'));
    add('relay share code HEAD', sc({ credential: CREDENTIAL_SHARE }), head('/api/provider-relay-shares/share-1/code'));
    add('relay share code OPTIONS', sc(), options('/api/provider-relay-shares/share-1/code'));

    // ── relay import code ──────────────────────────────────────────────────
    const IMPORT_RELAY = {
      summaries: Object.assign({}, baseScenario().summaries, {
        'claude:claude-1': {
          appType: 'claude', name: 'Claude Line', baseUrl: 'https://relay.example.com/claude-proxy/claude-1/remote',
          model: 'claude-sonnet-5', modelOptions: ['claude-sonnet-5'],
        },
      }),
      relayImportToken: 'mcr1.AbCdEf0123456789.secret-value',
    };
    add('relay import ok', sc(IMPORT_RELAY), get('/api/providers/claude/claude-1/relay-import-code'));
    add('relay import not relay', sc(), get('/api/providers/claude/claude-1/relay-import-code'));
    add('relay import appType mismatch', sc({
      summaries: Object.assign({}, baseScenario().summaries, {
        'claude:claude-1': { appType: 'claude', baseUrl: 'https://relay.example.com/codex-proxy/codex-1' },
      }),
      relayImportToken: 'mcr1.AbCdEf0123456789.secret-value',
    }), get('/api/providers/claude/claude-1/relay-import-code'));
    add('relay import bad token', sc({
      summaries: IMPORT_RELAY.summaries,
      relayImportToken: 'not-a-credential',
    }), get('/api/providers/claude/claude-1/relay-import-code'));
    add('relay import no token', sc({ summaries: IMPORT_RELAY.summaries }), get('/api/providers/claude/claude-1/relay-import-code'));
    add('relay import missing provider', sc(), get('/api/providers/claude/ghost/relay-import-code'));
    add('relay import summary name', sc({
      providers: baseScenario().providers.map((provider) => (
        provider.id === 'claude-1' ? Object.assign({}, provider, { name: '' }) : provider
      )),
      summaries: Object.assign({}, IMPORT_RELAY.summaries, {
        'claude:claude-1': Object.assign({}, IMPORT_RELAY.summaries['claude:claude-1'], { name: 'Summary Name' }),
      }),
      relayImportToken: IMPORT_RELAY.relayImportToken,
    }), get('/api/providers/claude/claude-1/relay-import-code'));
    add('relay import id name', sc({
      providers: baseScenario().providers.map((provider) => (
        provider.id === 'claude-1' ? Object.assign({}, provider, { name: '' }) : provider
      )),
      summaries: Object.assign({}, IMPORT_RELAY.summaries, {
        'claude:claude-1': Object.assign({}, IMPORT_RELAY.summaries['claude:claude-1'], { name: '' }),
      }),
      relayImportToken: IMPORT_RELAY.relayImportToken,
    }), get('/api/providers/claude/claude-1/relay-import-code'));
    add('relay import codex', sc({
      summaries: Object.assign({}, baseScenario().summaries, {
        'codex:codex-1': { appType: 'codex', name: 'Codex Line', baseUrl: 'https://relay.example.com/codex-proxy/codex-1', model: 'gpt-5-codex' },
      }),
      relayImportToken: 'mcr1.AbCdEf0123456789.secret-value',
    }), get('/api/providers/codex/codex-1/relay-import-code'));
    add('relay import encoded id', sc(IMPORT_RELAY), get('/api/providers/claude/claude%2D1/relay-import-code'));
    add('relay import HEAD', sc(IMPORT_RELAY), head('/api/providers/claude/claude-1/relay-import-code'));
    add('relay import OPTIONS', sc(), options('/api/providers/claude/claude-1/relay-import-code'));

    // ── provider defaults ──────────────────────────────────────────────────
    add('defaults get', sc(), get('/api/provider-defaults'));
    add('defaults get HEAD', sc(), head('/api/provider-defaults'));
    add('defaults get OPTIONS', sc(), options('/api/provider-defaults'));
    add('defaults put claude', sc(), put('/api/provider-defaults', { claude: 'claude-2' }));
    add('defaults put null', sc(), put('/api/provider-defaults', { claude: null }));
    add('defaults put empty string', sc(), put('/api/provider-defaults', { claude: '' }));
    add('defaults put codex', sc(), put('/api/provider-defaults', { codex: 'codex-1' }));
    add('defaults put both', sc(), put('/api/provider-defaults', { claude: 'claude-1', codex: 'codex-1' }));
    add('defaults put native vendor mismatch', sc(), put('/api/provider-defaults', { claude: 'qoder-native:qoder' }));
    add('defaults put invalid id', sc(), put('/api/provider-defaults', { claude: 'ghost' }));
    add('defaults put invalid stops', sc(), put('/api/provider-defaults', { claude: 'ghost', codex: 'codex-1' }));
    add('defaults put number id', sc(), put('/api/provider-defaults', { claude: 5 }));
    add('defaults put padded id', sc(), put('/api/provider-defaults', { claude: '  claude-1  ' }));
    add('defaults put empty object', sc(), put('/api/provider-defaults', {}));
    add('defaults put array body', sc(), put('/api/provider-defaults', [1]));
    add('defaults put unknown cli', sc(), put('/api/provider-defaults', { opencode: 'x', claude: 'claude-2' }));
    add('defaults put write fails', sc({ writeError: { message: 'disk full at /Users/alice' } }), put('/api/provider-defaults', { claude: 'claude-2' }));
    add('defaults put subagent extra', sc(), put('/api/provider-defaults', { claude: 'claude-2', subagent: { claude: null } }));
    add('defaults POST forwarded', sc(), post('/api/provider-defaults', {}), {
      expectedDifference: {
        node: (view) => view.status === 404,
        rust: isForwarded('POST', '/api/provider-defaults'),
      },
    });

    // ── routing seams the front door deliberately forwards ────────────────
    add('uppercase API prefix forwarded', sc(), get('/API/providers'), {
      expectedDifference: {
        node: (view) => view.status === 200,
        rust: isForwarded('GET', '/API/providers'),
      },
    });
    add('undeclared method forwarded', sc(), post('/api/providers/claude/claude-1', {}), {
      expectedDifference: {
        node: (view) => view.status === 404,
        rust: isForwarded('POST', '/api/providers/claude/claude-1'),
      },
    });
    add('speedtest stays in Node', sc(), post('/api/providers/claude/ghost/speedtest', {}), {
      expectedDifference: {
        node: (view) => view.status === 404,
        rust: isForwarded('POST', '/api/providers/claude/ghost/speedtest'),
      },
    });
    add('speedtest OPTIONS stays in Node', sc(), options('/api/providers/claude/claude-1/speedtest'), {
      expectedDifference: {
        node: (view) => view.status === 200 && view.headers.allow === 'POST',
        rust: isForwarded('OPTIONS', '/api/providers/claude/claude-1/speedtest'),
      },
    });

    return cases;
  },
  // The trace is the second half of the comparison: same subsystem calls, same
  // order, same arguments, grouped by case name.
  finalize({ work }) {
    const node = comparableTrace(readTrace(nodeTraceFile));
    const rust = comparableTrace(readTrace(rustTraceFile));
    const names = new Set();
    for (const name of node.keys()) names.add(name);
    for (const name of rust.keys()) names.add(name);
    const mismatches = [];
    let compared = 0;
    for (const name of names) {
      const left = node.get(name) || [];
      const right = rust.get(name) || [];
      compared += left.length;
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        mismatches.push({ case: name, node: left, rust: right });
      }
    }
    const summary = {
      casesWithCalls: names.size,
      nodeCalls: [...node.values()].reduce((total, list) => total + list.length, 0),
      rustCalls: [...rust.values()].reduce((total, list) => total + list.length, 0),
      compared,
      mismatches: mismatches.length,
    };
    return { ok: mismatches.length === 0, details: { summary, mismatches } };
  },
});
