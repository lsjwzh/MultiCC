'use strict';
// Differential for the ⑤ segment of `validProviderId` at the front door:
//
//   PUT /api/provider-defaults
//
// Node side (the oracle): the frozen pre-retirement route module
// (tests/helpers/legacy-provider-routes.js) mounted on the real pipeline. Its
// `validProviderId` is fed THIS tree's frozen JS rules
// (tests/helpers/legacy-provider-cli-rules.js) through `deps.providers`, so the
// answer is exactly the retired implementation, not a re-derivation.
//
// Rust side: the release multicc-gateway plus a stub Node child that mounts the
// real host port (src/routes/providers-host.js) with the same fake store. The
// front door's `valid_provider_id` must reach that store only through the
// `normalizeId` / `providerSummary` host operations.
//
// One shared scenario file drives both sides (work/world.js is required by the
// parent and by the stub child). Each case writes its own scenario; both sides
// reset from it before answering. Every store lookup is appended to a per
// process NDJSON trace, and finalize() requires the per-case `getProviderSummary`
// count on the Node side to equal the per-case `providerSummary` host-op count
// on the Rust side.
//
//   node docs/rust-migration/differential/provider-defaults-validate.js \
//     <repo> native/target/release/multicc-gateway native/prebuilt/darwin-arm64/multicc_core.node
//
// Documented exclusion: the corpus is the same cli × id corpus the Node
// differential uses, minus anything that would make an unrelated route answer
// first (body shapes the legacy handler throws on before validation). The only
// compared operations are the two the front door performs per key:
// normalizeId and providerSummary.

const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const MOUNT_DEFAULTS = '{"claude":null,"codex":null}';

let world = null;
let scriptFile = '';
let nodeTraceFile = '';
let rustTraceFile = '';
let upstreamText = '';
let resetRouteDefaults = null;
let corpusSize = 0;

// ── the shared fake store ───────────────────────────────────────────────────
// Written to work/world.js, required by both processes. Scenario shape:
//   { case, rows: [{appType,id,apiFormat,protocol,virtual,baseUrl,hasToken}],
//     defaults: { claude: id|null, codex: id|null } }
//
// The ⑤ rules themselves are required from this tree's frozen oracle
// (tests/helpers/legacy-provider-cli-rules.js), so the Node side of the
// differential answers exactly as the retired implementation did.
function worldSource(repo) {
  return `'use strict';
const fs = require('node:fs');
const NL = String.fromCharCode(10);
const RULES = require(${JSON.stringify(path.join(repo, 'tests/helpers/legacy-provider-cli-rules'))});
const APP_TYPE_FOR_CLI = function (cli) { return RULES.appTypeForCli(cli); };
const APP_TYPES_FOR_CLI = function (cli) { return RULES.appTypesForCli(cli); };
const PROVIDER_SUPPORTS_CLI = function (provider, cli) { return RULES.providerSupportsCli(provider, cli); };

function lookupSummary(rows, appType, id) {
  const text = String(id);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.id !== text) continue;
    if (appType === undefined || appType === null || row.appType === appType) {
      return {
        id: row.id,
        appType: row.appType,
        apiFormat: row.apiFormat,
        protocol: row.protocol,
        virtual: !!row.virtual,
        baseUrl: row.baseUrl,
        hasToken: row.hasToken,
      };
    }
  }
  return null;
}

function createWorld(options) {
  const scriptFile = options.scriptFile;
  const traceFile = options.traceFile;
  let scenario = {};
  let caseName = 'mount';

  function trace(entry) {
    const record = { case: caseName };
    const keys = Object.keys(entry);
    for (let index = 0; index < keys.length; index += 1) record[keys[index]] = entry[keys[index]];
    fs.appendFileSync(traceFile, JSON.stringify(record) + NL);
  }

  function reset(next) {
    scenario = next && typeof next === 'object' ? next : {};
    caseName = typeof scenario.case === 'string' ? scenario.case : 'case';
    if (deps.defaultsOwner) deps.defaultsOwner.replace(scenario.defaults || {});
  }

  function resetFromFile() {
    let next = {};
    try { next = JSON.parse(fs.readFileSync(scriptFile, 'utf8')); } catch (_) { next = {}; }
    reset(next);
  }

  function rows() {
    return Array.isArray(scenario.rows) ? scenario.rows : [];
  }

  const noop = function () { return null; };
  const deps = {
    providerDefaultsFile: '/virtual/provider-defaults.json',
    claudeCmd: '/opt/multicc/claude',
    URL: URL,
    http: { request: function () { throw new Error('out of corpus'); } },
    https: { request: function () { throw new Error('out of corpus'); } },
    fs: { readFileSync: function () { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
    logger: { warn: function () {}, info: function () {}, error: function () {} },
    now: function () { return 1700000000000; },
    getPort: function () { return 4321; },
    getClaudeOfficialViaProxy: function () { return null; },
    findProviderReferences: function () { return []; },
    getAuxConfig: function () { return { protocol: 'anthropic', providerId: null }; },
    persistedSessions: new Map(),
    atomicWriteJson: function (file, value) { trace({ op: 'writeDefaults', value: value }); },
    providerRelayShares: {
      create: noop, list: function () { return []; }, getCredential: noop, revoke: noop, revokeProvider: noop,
    },
    providers: {
      WIRE_DEFAULT_MODEL: 'claude-wire-default',
      normalizeOfficialProviderId: function (cli, id) {
        trace({ op: 'normalize', cli: cli === undefined ? '<undefined>' : cli, id: id === undefined ? '<undefined>' : id });
        return id === 'official-alias' ? 'official-canonical' : id;
      },
      appTypeForCli: function (cli) { return APP_TYPE_FOR_CLI(cli); },
      appTypesForCli: function (cli) { return APP_TYPES_FOR_CLI(cli); },
      providerSupportsCli: function (provider, cli) { return PROVIDER_SUPPORTS_CLI(provider, cli); },
      getCcSwitchStatus: function () { return { available: true }; },
      listProviders: function () { return []; },
      getProviderUsageStats: function () { return { stats: {}, windows: {} }; },
      importFromCcSwitch: function () { return {}; },
      createProvider: function () { return {}; },
      updateProvider: function () {},
      deleteProvider: function () { return true; },
      getProvider: function () { return null; },
      probeRelayModels: async function () { return { tested: [], accepted: [] }; },
      claudeProbeRouteEnv: function () { return {}; },
      getRelayImportToken: function () { return ''; },
    },
    providerRouterRuntime: {
      getProviderSummary: function (appType, id) {
        trace({ op: 'summary', appType: appType === undefined ? '<undefined>' : appType, id: String(id) });
        return lookupSummary(rows(), appType, id);
      },
    },
  };

  const native = require(${JSON.stringify(path.join(repo, 'src/native/runtime'))}).getNative();
  const defaultsFile = options.defaultsFile;
  try { fs.writeFileSync(defaultsFile, JSON.stringify(scenario.defaults || { claude: null, codex: null })); } catch (_) {}
  deps.defaultsOwner = new native.RustProviderDefaultsStore(defaultsFile);
  deps.providerDefaults = require(${JSON.stringify(path.join(repo, 'src/providers/defaults-port'))})
    .providerDefaultsView(deps.defaultsOwner);
  deps.saveProviderDefaults = function () { deps.defaultsOwner.persist(); return true; };
  deps.validProviderId = function () { return { ok: false }; };
  deps.isLocalRequest = function () { return true; };

  return {
    deps: deps,
    reset: reset,
    resetFromFile: resetFromFile,
    traceHostCall: function (body) {
      trace({ op: body && typeof body === 'object' ? body.op : '<absent>' });
    },
  };
}

module.exports = { createWorld: createWorld, lookupSummary: lookupSummary };
`;
}

// The frozen rule functions are required from the tree (see worldSource), so
// the parent's legacy route module and the corpus share one definition.

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
const { createWorld } = require(path.join(process.env.VPD_DIFF_WORK, 'world.js'));
const world = createWorld({
  scriptFile: process.env.VPD_DIFF_SCENARIO,
  traceFile: process.env.VPD_DIFF_RUST_TRACE,
  defaultsFile: path.join(process.env.VPD_DIFF_WORK, 'rust-defaults.json'),
});
const { mountProvidersHostRoute } = require(path.join(REPO, 'src/routes/providers-host'));
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  world.resetFromFile();
  world.traceHostCall(req.body);
  next();
});
mountProvidersHostRoute(app, Object.assign({}, world.deps, {
  isLocal: () => true,
  saveProviderDefaults: () => { world.deps.defaultsOwner.persist(); return true; },
}));
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

// ── corpus ──────────────────────────────────────────────────────────────────
const CLI_ROWS = [
  { appType: 'claude', id: 'anthropic-token', apiFormat: 'anthropic', protocol: 'anthropic', baseUrl: 'https://a.example', hasToken: true },
  { appType: 'claude', id: 'anthropic-no-token', apiFormat: 'anthropic', protocol: 'anthropic', baseUrl: 'https://a.example', hasToken: false },
  { appType: 'codex', id: 'openai-token', apiFormat: 'openai_responses', protocol: 'openai_responses', baseUrl: 'https://c.example', hasToken: true },
  { appType: 'codex', id: 'openai-no-token', apiFormat: 'openai_responses', protocol: 'openai_responses', baseUrl: '', hasToken: false },
  { appType: 'claude', id: 'virtual-pool', apiFormat: 'anthropic', protocol: 'anthropic', virtual: true, baseUrl: '', hasToken: false },
  { appType: 'codex', id: 'dual-pool', apiFormat: 'openai_responses', protocol: 'openai_responses', baseUrl: 'https://d.example', hasToken: true },
  { appType: 'claude', id: 'official-canonical', apiFormat: 'anthropic', protocol: 'anthropic', baseUrl: '', hasToken: false },
];

const IDS = [
  null, '', 'x', 'claude-native:x', 'codex-native:x',
  'opencode-native:ok-1', 'opencode-native:-bad', 'a-native:b',
  'official-alias', 'official-canonical',
  'anthropic-token', 'anthropic-no-token', 'openai-token', 'openai-no-token',
  'virtual-pool', 'dual-pool', 'missing-id',
];

function scenario(caseName, rows = CLI_ROWS, defaults = { claude: null, codex: null }) {
  return { case: caseName, rows, defaults };
}

// See finalize(): the frozen route helper has no `opencode-native:` branch, so
// these four requests reach the store once on the Node side and never on the
// Rust side. Their answers are still compared byte for byte like every other
// case; only this one lookup delta is documented.
const STALE_FREEZE_LOOKUPS = new Set([
  'claude opencode-native:ok-1', 'claude opencode-native:-bad',
  'codex opencode-native:ok-1', 'codex opencode-native:-bad',
]);

function readTrace(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    if (!map.has(record.case)) map.set(record.case, []);
    map.get(record.case).push(record);
  }
  return map;
}

main({
  name: 'provider-defaults-validate',
  mount(app, { repo, work }) {
    scriptFile = path.join(work, 'scenario.json');
    nodeTraceFile = path.join(work, 'node-trace.ndjson');
    rustTraceFile = path.join(work, 'rust-trace.ndjson');
    const worldPath = path.join(work, 'world.js');
    fs.writeFileSync(worldPath, worldSource(repo));
    fs.writeFileSync(nodeTraceFile, '');
    fs.writeFileSync(rustTraceFile, '');
    fs.writeFileSync(scriptFile, JSON.stringify(scenario('mount')));

    process.env.VPD_DIFF_WORK = work;
    process.env.VPD_DIFF_SCENARIO = scriptFile;
    process.env.VPD_DIFF_RUST_TRACE = rustTraceFile;

    const { createWorld } = require(worldPath);
    world = createWorld({
      scriptFile,
      traceFile: nodeTraceFile,
      defaultsFile: path.join(work, 'node-defaults.json'),
    });
    const { createProviderRoutes } = require(path.join(repo, 'tests/helpers/legacy-provider-routes'));
    const routes = createProviderRoutes(world.deps);
    // The frozen route module keeps the defaults in a plain object; the Rust
    // side reads a fresh native owner per request, so reset both per case.
    resetRouteDefaults = (defaults) => {
      const live = routes.providerDefaults;
      for (const key of Object.keys(live)) delete live[key];
      Object.assign(live, defaults);
    };
    // Setup normalizes the two defaults owners; only cases belong in the trace.
    fs.writeFileSync(nodeTraceFile, '');

    // Express 4 does not catch async rejections; the repo's own asyncHandler is
    // how every current async route reaches safeErrorHandler.
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
    VPD_DIFF_WORK: work,
    VPD_DIFF_SCENARIO: path.join(work, 'scenario.json'),
    VPD_DIFF_RUST_TRACE: path.join(work, 'rust-trace.ndjson'),
  }),
  corpus() {
    const headers = { Host: 'localhost', 'X-Request-Id': 'vpd-diff-1', 'Content-Type': 'application/json' };
    const put = body => ({ method: 'PUT', url: '/api/provider-defaults', headers, body: JSON.stringify(body) });
    const cases = [];
    function add(name, spec, body) {
      cases.push([name, put(body), {
        before() {
          const next = scenario(name, spec.rows, spec.defaults);
          fs.writeFileSync(scriptFile, JSON.stringify(next));
          world.reset(next);
          if (resetRouteDefaults) resetRouteDefaults(next.defaults);
        },
      }]);
    }
    for (const cli of ['claude', 'codex']) {
      for (const id of IDS) add(`${cli} ${String(id)}`, scenario(''), { [cli]: id });
    }
    add('both accepted', scenario(''), { claude: 'anthropic-token', codex: 'openai-token' });
    add('first invalid stops', scenario(''), { claude: 'missing-id', codex: 'openai-token' });
    add('second invalid stops', scenario(''), { codex: 'missing-id' });
    add('empty body', scenario(''), {});
    add('unknown key ignored', scenario(''), { opencode: 'x', claude: 'anthropic-token' });
    add('empty store', scenario('', []), { claude: 'anthropic-token' });
    add('virtual claude', scenario(''), { claude: 'virtual-pool' });
    add('virtual codex lane', scenario(''), { codex: 'virtual-pool' });
    add('gated cross pool', scenario(''), { claude: 'openai-token' });
    corpusSize = cases.length;
    return cases;
  },
  async finalize({ work }) {
    const node = readTrace(path.join(work, 'node-trace.ndjson'));
    const rust = readTrace(path.join(work, 'rust-trace.ndjson'));
    const count = (map, name, op) => (map.get(name) || []).filter(record => record.op === op).length;
    const mismatches = [];
    let compared = 0;
    for (const name of new Set([...node.keys(), ...rust.keys()])) {
      // The stub child answers one host-port request before the first case (the
      // gateway's child handshake); it carries no corpus scenario, so it is not
      // a case.
      if (name === 'mount') continue;
      const nodeSummary = count(node, name, 'summary');
      const rustSummary = count(rust, name, 'providerSummary');
      const nodeNormalize = count(node, name, 'normalize');
      const rustNormalize = count(rust, name, 'normalizeId');
      compared += 1;
      if (nodeNormalize !== rustNormalize) mismatches.push({ case: name, nodeNormalize, rustNormalize });
      if (nodeSummary === rustSummary) continue;
      // The frozen route helper predates the `opencode-native:` structural rule
      // (HEAD's route, i.e. the real retiree, rejects those ids before any store
      // lookup). On a non-opencode lane both sides answer "not a valid provider"
      // byte for byte; the helper just asks the store once first. That single
      // extra lookup is pinned here instead of being waved through.
      if (!STALE_FREEZE_LOOKUPS.has(name)) {
        mismatches.push({ case: name, nodeSummary, rustSummary });
        continue;
      }
      if (nodeSummary - rustSummary !== 1) {
        mismatches.push({ case: name, nodeSummary, rustSummary, staleFreeze: 'delta is not exactly one lookup' });
      }
    }
    for (const name of STALE_FREEZE_LOOKUPS) {
      if (count(node, name, 'summary') - count(rust, name, 'providerSummary') !== 1) {
        mismatches.push({ case: name, staleFreeze: 'the pinned stale-freeze lookup did not happen' });
      }
    }
    if (compared !== corpusSize) mismatches.push({ case: '<corpus>', compared, corpusSize });
    const total = (map, op) => [...map.values()].reduce((sum, list) => sum + list.filter(r => r.op === op).length, 0);
    const nodeTotal = total(node, 'summary');
    const rustTotal = total(rust, 'providerSummary');
    const nodeNormalizeTotal = total(node, 'normalize');
    const rustNormalizeTotal = total(rust, 'normalizeId');
    if (nodeTotal - rustTotal !== STALE_FREEZE_LOOKUPS.size) {
      mismatches.push({ case: '<total>', nodeSummary: nodeTotal, rustSummary: rustTotal });
    }
    if (nodeNormalizeTotal !== rustNormalizeTotal) {
      mismatches.push({ case: '<total>', nodeNormalize: nodeNormalizeTotal, rustNormalize: rustNormalizeTotal });
    }
    console.log(`[provider-defaults-validate] summary host-op calls: node=${nodeTotal} rust=${rustTotal} `
      + `(documented stale-freeze lookups ${STALE_FREEZE_LOOKUPS.size}); `
      + `normalize host-op calls: node=${nodeNormalizeTotal} rust=${rustNormalizeTotal}; cases compared=${compared}`);
    return {
      ok: mismatches.length === 0,
      details: { mismatches, nodeTotal, rustTotal, nodeNormalizeTotal, rustNormalizeTotal, compared },
    };
  },
});
