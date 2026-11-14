'use strict';
// Compare the frozen Node voice routes (tests/helpers/legacy-voice-gateway-global-routes and
// tests/helpers/legacy-qwen-audio-runtime-routes) with the real Rust gateway in front of the
// real host port (src/routes/voice-runtime-host).
// Usage: node docs/rust-migration/differential/voice-runtime.js <repo> <gateway> <addon>
//
// Both sides get the same records, directories, supervisor and installer, built from ONE
// literal (SETUP) that is evaluated in the oracle's process and serialised into the upstream
// child, so the two cannot drift. A scenario name selects the starting state; every case
// re-applies its scenario on both sides before it runs.
//
// Unlike the Fleet-level batch, the clock and the launch-id source are injectable, so launch ids
// and expiry times are compared byte for byte instead of being blanked. Only the router
// record's createdAt/updatedAt (taken from the real wall clock inside the provisioner) are
// blanked, after asserting they are ISO strings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./lib');

const BASE_URL = 'http://127.0.0.1:3456';
const NOW_MS = Date.parse('2026-11-14T08:00:00.000Z');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-runtime-root-'));

// The scenarios. `applyScenario(name, world)` mutates the world in place; the world is
// { records, directories, calls, state:{...}, launchSeq }. Everything the fake supervisor and
// installer answer comes from world.state, so one scenario name fully determines behaviour.
const SETUP = `(function () {
  const ISO_A = '2026-01-01T00:00:00.000Z';
  const globalGateway = (extra) => Object.assign({
    id: '__voice_gateway__', type: 'gateway', gatewayKind: 'qwen-audio', kind: 'voice',
    label: 'Qwen Audio Voice Gateway', enabled: true, createdAt: ISO_A, updatedAt: ISO_A,
  }, extra || {});
  const chat = (id, dirId, extra) => Object.assign({ id, dirId, type: 'chat', kind: 'chat', label: 'Chat ' + id }, extra || {});
  const router = (extra) => Object.assign({ id: '__voice_router__', type: 'gateway', kind: 'chat', cli: 'claude',
    cliSessionId: null, dirId: null, label: 'router', cwd: '/tmp', createdAt: ISO_A, updatedAt: ISO_A }, extra || {});
  const legacyFleet = () => ({ id: 'gw-b', dirId: 'dir-b', type: 'gateway', kind: 'voice', gatewayKind: 'qwen-audio',
    label: 'Qwen Audio Voice Gateway', enabled: true, commanderSessionId: 'cmd-b', createdAt: ISO_A, updatedAt: ISO_A });
  const base = () => ({
    directories: [['dir-a', { id: 'dir-a', label: 'Alpha', path: '/work/alpha' }], ['dir-b', { id: 'dir-b', name: 'Beta' }]],
    records: [
      ['sess-a', chat('sess-a', 'dir-a')],
      ['sess-ghostdir', chat('sess-ghostdir', 'dir-missing')],
      ['sess-aux', { id: 'sess-aux', dirId: 'dir-a', type: 'aux', kind: 'chat', label: 'Aux' }],
      ['sess-gw', { id: 'sess-gw', dirId: 'dir-a', type: 'gateway', kind: 'chat', label: 'Gw' }],
      ['sess-term', { id: 'sess-term', dirId: 'dir-a', type: 'chat', kind: 'terminal', label: 'Term' }],
      ['cmd-b', { id: 'cmd-b', dirId: 'dir-b', type: 'commander', kind: 'chat', label: 'Commander b' }],
      ['gw-b', legacyFleet()],
    ],
    state: {
      supervisor: { global: { scope: 'global', state: 'running', desired: true, url: 'http://127.0.0.1:9911', pid: 4242 },
        fleet: { scope: 'fleet', state: 'stopped', desired: false, url: null },
        hasGlobal: true, startGlobalResult: 'running', startGlobalThrows: false, restartThrows: false,
        statusGlobalMissing: false },
      installer: { installed: true, version: '1.2.3', state: 'ready', startInstallThrows: false, waitRejects: false },
    },
  });
  const scenarios = {
    'global-running': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]); },
    'global-disabled': w => { w.records.push(['__voice_gateway__', globalGateway({ enabled: false })], ['__voice_router__', router()]); },
    'global-no-router': w => { w.records.push(['__voice_gateway__', globalGateway()]); },
    'global-router-conflict': w => { w.records.push(['__voice_gateway__', globalGateway()],
      ['__voice_router__', { id: '__voice_router__', type: 'chat', kind: 'chat', label: 'squatter' }]); },
    'global-stopped': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.supervisor.global = { scope: 'global', state: 'stopped', desired: false, url: null }; },
    'global-stopped-start-ok': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.supervisor.global = { scope: 'global', state: 'stopped', desired: false, url: null };
      w.state.supervisor.startGlobalResult = 'running'; },
    'global-stopped-start-fails': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.supervisor.global = { scope: 'global', state: 'failed', desired: true, url: null, lastError: { code: 'qwen_audio_spawn_failed' } };
      w.state.supervisor.startGlobalResult = 'failed'; },
    'global-stopped-start-throws': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.supervisor.global = { scope: 'global', state: 'stopped', desired: false, url: null };
      w.state.supervisor.startGlobalThrows = true; },
    'global-running-slash-url': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.supervisor.global = { scope: 'global', state: 'running', desired: true, url: '/' }; },
    'global-restart-throws': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.supervisor.restartThrows = true; },
    'global-status-missing': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.supervisor.statusGlobalMissing = true; },
    'no-global': w => { w.state.supervisor.hasGlobal = false;
      w.state.supervisor.fleet = { scope: 'fleet', state: 'running', desired: true, url: 'http://127.0.0.1:9922', directoryId: 'dir-b' }; },
    'installer-fresh': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.installer = { installed: false, version: null, state: 'idle', startInstallThrows: false, waitRejects: false }; },
    'installer-wait-rejects': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]);
      w.state.installer = { installed: false, version: null, state: 'idle', startInstallThrows: false, waitRejects: true }; },
    'installer-start-throws': w => { w.state.installer = { installed: false, version: null, state: 'idle', startInstallThrows: true, waitRejects: false }; },
    'empty': () => {},
    'no-global-restart-throws': w => { w.state.supervisor.hasGlobal = false; w.state.supervisor.restartThrows = true;
      w.state.supervisor.fleet = { scope: 'fleet', state: 'running', desired: true, url: 'http://127.0.0.1:9922', directoryId: 'dir-b' }; },
    'global-running-then-expire': w => { w.records.push(['__voice_gateway__', globalGateway()], ['__voice_router__', router()]); },
  };
  return {
    scenarioNames: Object.keys(scenarios),
    build(name) {
      if (!scenarios[name]) throw new Error('unknown scenario ' + name);
      const world = base();
      scenarios[name](world);
      return world;
    },
  };
})()`;


// ---- fakes: one definition, used in both processes -------------------------------------
// `makeWorld` builds records/directories/supervisor/installer/launch registry/router around a
// scenario. It is serialised into the upstream child and eval'ed for the oracle.
const WORLD = `(function (repo, setup, nowMs, runtimeRoot) {
  const path = require('node:path');
  const { createVoiceLaunchRegistry } = require(path.join(repo, 'src/voice/launch'));
  const { createVoiceRouterProvisioner } = require(path.join(repo, 'src/voice/router'));
  const { createVoiceGatewayService } = require(path.join(repo, 'src/voice/gateway'));
  const { resolveDirectoryCommander } = require(path.join(repo, 'src/task-board/core'));
  const records = new Map(); const directories = new Map();
  const world = { calls: [], seq: 0, state: null, skew: 0 };
  function applyScenario(name) {
    const built = setup.build(name);
    records.clear(); directories.clear(); world.calls = []; world.seq = 0; world.state = built.state; world.skew = 0;
    for (const [k, v] of JSON.parse(JSON.stringify(built.directories))) directories.set(k, v);
    for (const [k, v] of JSON.parse(JSON.stringify(built.records))) records.set(k, v);
  }
  const mutate = (_source, operation) => operation(records);
  const service = createVoiceGatewayService({ records, directories, mutate,
    now: () => new Date(nowMs).toISOString() });
  const launchRegistry = createVoiceLaunchRegistry({ records, directories,
    resolveCommander: (map, id) => resolveDirectoryCommander(map, id),
    now: () => nowMs + world.skew, randomId: () => 'launch-' + (++world.seq) });
  const voiceRouter = createVoiceRouterProvisioner({ records, mutate, runtimeRoot,
    now: () => new Date(nowMs).toISOString() });
  const log = {
    warn: (...a) => world.calls.push(['warn', ...a]),
    info: (...a) => world.calls.push(['info', ...a]),
    error: (...a) => world.calls.push(['error', ...a]),
  };
  const sv = () => world.state.supervisor;
  const supervisor = {
    reconcileAll: (...a) => { world.calls.push(['reconcileAll', ...a]); },
    stopGlobal: () => { world.calls.push(['stopGlobal']); },
    statusGlobal: () => sv().statusGlobalMissing ? undefined : JSON.parse(JSON.stringify(sv().global)),
    startGlobal: async () => {
      world.calls.push(['startGlobal']);
      if (sv().startGlobalThrows) throw new Error('start failed');
      if (sv().startGlobalResult === 'running') sv().global = { scope: 'global', state: 'running', desired: true, url: 'http://127.0.0.1:9911' };
      return JSON.parse(JSON.stringify(sv().global));
    },
    restartGlobal: async () => {
      world.calls.push(['restartGlobal']);
      if (sv().restartThrows) { const e = new Error('restart boom'); e.code = 'restart_failed'; throw e; }
      return JSON.parse(JSON.stringify(sv().global));
    },
    hasGlobalGateway: () => sv().hasGlobal,
    status: (id) => Object.assign({}, JSON.parse(JSON.stringify(sv().fleet)), { requested: id }),
    restart: async (id) => {
      world.calls.push(['restart', id]);
      if (sv().restartThrows) { const e = new Error('fleet restart boom'); throw e; }
      return Object.assign({}, JSON.parse(JSON.stringify(sv().fleet)), { restarted: id });
    },
  };
  const ins = () => world.state.installer;
  const installer = {
    status: () => JSON.parse(JSON.stringify({ installed: ins().installed, version: ins().version, state: ins().state })),
    startInstall: () => {
      world.calls.push(['startInstall']);
      if (ins().startInstallThrows) throw new Error('install boom');
      return { installed: false, version: null, state: 'installing' };
    },
    waitForInstall: () => ins().waitRejects ? Promise.reject(new Error('install failed')) : Promise.resolve(),
  };
  return { world, records, directories, service, launchRegistry, voiceRouter, supervisor, installer, log, applyScenario };
})`;

function upstream(repo) {
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const path = require('node:path');
const repo = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [repo] }));
const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
const { connectAuthControl } = require(path.join(repo, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
const { createVoiceRuntimeHost } = require(path.join(repo, 'src/routes/voice-runtime-host'));
const setup = ${SETUP};
const w = (${WORLD})(repo, setup, ${NOW_MS}, ${JSON.stringify(RUNTIME_ROOT)});
w.applyScenario('empty');
const app = express(); app.use(express.json());
createVoiceRuntimeHost({
  service: w.service, launchRegistry: w.launchRegistry, voiceRouter: w.voiceRouter, runtime: w.supervisor,
  installer: w.installer, supervisor: w.supervisor, getBaseUrl: () => ${JSON.stringify(BASE_URL)}, log: w.log,
}).mountRoutes(app);
// Test-only controls: the gateway does not claim these, so they reach this child.
app.post('/__setup', (q, r) => { w.applyScenario(q.body.scenario); r.json({ ok: true }); });
app.post('/__skew', (q, r) => { w.world.skew = Number(q.body.ms) || 0; r.json({ ok: true }); });
app.get('/__calls', (_q, r) => r.json({ calls: w.world.calls }));
app.use((req, res) => res.status(599).send('forwarded:' + req.method + ' ' + req.url));
const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
 socket.on('error', () => {}); let buffered = Buffer.alloc(0);
 const onData = chunk => { buffered = Buffer.concat([buffered, chunk]);
  const end = buffered.indexOf('\\r\\n'); if (end < 0) return;
  socket.removeListener('data', onData); socket.pause();
  const rest = buffered.subarray(end + 2); if (rest.length) socket.unshift(rest);
  server.emit('connection', socket); socket.resume(); };
 socket.on('data', onData); socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');`;
}

// The oracle lives in this process; the Rust side's world lives in the upstream child.
let oracleWorld = null;
async function fetchJson(port, method, url, headers, body) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// The router record is created through the real provisioner with the real wall clock.
// Timestamps are the only values blanked, and only after checking their shape.
function blankTimes(text) {
  let body;
  try { body = JSON.parse(text); } catch (_) { return text; }
  let bad = null;
  (function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (key === 'createdAt' || key === 'updatedAt') {
        if (value[key] !== null && !(typeof value[key] === 'string' && ISO.test(value[key]))) bad = `${key}=${value[key]}`;
        else if (value[key] !== null) value[key] = '<iso>';
      } else walk(value[key]);
    }
  })(body);
  if (bad) throw new Error(`timestamp is not an ISO string: ${bad}`);
  return JSON.stringify(body);
}

// Requests the front door does not claim reach the upstream child (Express 404 in the real
// service). Each side is pinned to its own exact shape; lib.js requires both predicates.
function forwardedPair(method, url, nodeCheck) {
  return { expectedDifference: {
    node: view => nodeCheck(view) === true,
    rust: view => view.status === 599 && view.body === `forwarded:${method} ${url}`,
  } };
}
const cannot = (method, url) => view => view.status === 404 && view.body.includes(`<pre>Cannot ${method} ${url}</pre>`);

function main() {
  let upstreamText = '';
  return run({
    name: 'voice-runtime',
    mount(app, { repo }) {
      const setup = eval(SETUP); // eslint-disable-line no-eval -- the same literal the upstream evaluates
      oracleWorld = eval(WORLD)(repo, setup, NOW_MS, RUNTIME_ROOT);
      oracleWorld.applyScenario('empty');
      const w = oracleWorld;
      const global = require(path.join(repo, 'tests/helpers/legacy-voice-gateway-global-routes'));
      const qwen = require(path.join(repo, 'tests/helpers/legacy-qwen-audio-runtime-routes'));
      // The Fleet-level gateway routes are owned by the previous batch; they are not under test
      // here, so the oracle does not mount them. /runtime and /restart under /directories/:id are.
      global.createGlobalVoiceGatewayRoutes({
        service: w.service, launchRegistry: w.launchRegistry, voiceRouter: w.voiceRouter, runtime: w.supervisor,
        getBaseUrl: () => BASE_URL, log: w.log,
      }).mountRoutes(app);
      qwen.createQwenAudioRuntimeRoutes({ installer: w.installer, supervisor: w.supervisor, log: w.log }).mountRoutes(app);
      app.post('/__skew', (q, r) => { w.world.skew = Number(q.body.ms) || 0; r.json({ ok: true }); });
      app.get('/__calls', (_q, r) => r.json({ calls: w.world.calls }));
      upstreamText = upstream(repo);
    },
    get upstream() { return upstreamText; },
    gatewayEnv: () => ({ MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON }),
    normalize: blankTimes,
    normalizeView(v) {
      // /__calls is this script's own control endpoint: the oracle serves it through the
      // request-id middleware, the Rust side through the upstream stub.
      if (/^\{"calls":\[/.test(v.body)) {
        for (const name of ['x-multicc-api-version', 'x-multicc-request-id', 'x-correlation-id']) delete v.headers[name];
      }
      if (v.body.includes('"<iso>"') && v.headers.etag !== undefined) {
        if (!/^W\/"[0-9a-f]+-[A-Za-z0-9+\/]{27}"$/.test(v.headers.etag)) throw new Error(`unexpected ETag shape: ${v.headers.etag}`);
        v.headers.etag = '<etag>';
      }
      return v;
    },
    // Equal answers prove nothing if both sides only ever said "no". Fail the run unless every
    // success and failure family was really walked.
    finalize({ views }) {
      // DIFF_TRACE=<substring> prints both sides of every matching case (debugging aid only).
      if (process.env.DIFF_TRACE) {
        for (const v of views.filter(x => x.name.includes(process.env.DIFF_TRACE))) {
          console.log(`TRACE ${v.name}\n  node: ${v.node.status} ${v.node.body.slice(0, 160)}\n  rust: ${v.rust.status} ${v.rust.body.slice(0, 160)}`);
        }
      }
      const seen = {
        launchOk: 0, launchNoUrl: 0, revokeObserved: 0, launchBeginFail404: 0, launchBeginFail400: 0, launchBeginFail409: 0,
        resolveOk: 0, resolveSweptAfterExpiry404: 0, resolveRevoked404: 0, resolveUnknown404: 0,
        put201: 0, put200: 0, putAutoInstallBad: 0, deleteOk: 0, getConfigured: 0, getUnconfigured: 0,
        runtimeUrlStripped: 0, restartOk: 0, restartThrown500: 0,
        installed200: 0, installing202: 0, fleetProjected: 0, fleetPlain: 0, fleetRestartProjected: 0,
        loopbackTrue: 0, loopbackFalse: 0, startGlobalCalled: 0, infoLogged: 0, reconcileAllInstall: 0,
      };
      for (const { name, node, rust } of views) {
        for (const side of [node, rust]) {
          const b = side.body; const st = side.status;
          if (name.startsWith('launch ') && st === 200 && b.includes('"transport":{"loopbackOnly":true}')) seen.loopbackTrue++;
          if (name.startsWith('launch ') && st === 200 && b.includes('"transport":{"loopbackOnly":false}')) seen.loopbackFalse++;
          if (name.startsWith('launch ') && st === 200 && b.includes('"launch":{"url"')) seen.launchOk++;
          if (name.startsWith('launch ') && st === 409 && /voice_gateway_not_running|qwen_audio_spawn_failed/.test(b)) seen.launchNoUrl++;
          if (name.startsWith('launch ') && st === 404) seen.launchBeginFail404++;
          if (name.startsWith('launch ') && st === 400) seen.launchBeginFail400++;
          if (name.startsWith('launch ') && st === 409 && /voice_router_|voice_launch_directory/.test(b)) seen.launchBeginFail409++;
          if (name.startsWith('resolve') && st === 200 && b.includes('"context"')) seen.resolveOk++;
          // voice_launch_expired (410) cannot happen through the real registry: sweep() runs first and
          // deletes an expired ticket, so the caller sees voice_launch_unknown (404). The 410 mapping is
          // covered by the core unit tests and the gateway integration tests, not by this differential.
          if (name.includes('step5 expired gone') && st === 404 && b.includes('voice_launch_unknown')) seen.resolveSweptAfterExpiry404++;
          if (name.includes('revoked step2') && st === 404 && b.includes('voice_launch_unknown')) { seen.resolveRevoked404++; seen.revokeObserved++; }
          if (name.startsWith('resolve') && st === 404) seen.resolveUnknown404++;
          if (name.startsWith('put') && st === 201) seen.put201++;
          if (name.startsWith('put') && st === 200) seen.put200++;
          if (name.startsWith('put') && st === 400 && b.includes('voice_gateway_auto_install_invalid')) seen.putAutoInstallBad++;
          if (name.startsWith('delete') && st === 200 && b.includes('"removed":true')) seen.deleteOk++;
          if (name.startsWith('get gateway') && st === 200 && b.includes('"configured":true')) seen.getConfigured++;
          if (name.startsWith('get gateway') && st === 200 && b.includes('"configured":false')) seen.getUnconfigured++;
          if (name.startsWith('runtime') && st === 200 && b.includes('"runtime":{') && !b.includes('"url"')) seen.runtimeUrlStripped++;
          if (name.startsWith('restart') && st === 200) seen.restartOk++;
          if (name.startsWith('restart') && st === 500) seen.restartThrown500++;
          if (name.startsWith('install') && st === 200) seen.installed200++;
          if (name.startsWith('install') && st === 202) seen.installing202++;
          if (name.startsWith('fleet runtime') && st === 200 && b.includes('"projectedFrom":"global"')) seen.fleetProjected++;
          if (name.startsWith('fleet runtime') && st === 200 && !b.includes('"projectedFrom"')) seen.fleetPlain++;
          if (name.startsWith('fleet restart') && st === 200 && b.includes('"projectedFrom":"global"')) seen.fleetRestartProjected++;
          if (b.includes('["startGlobal"]')) seen.startGlobalCalled++;
          if (b.includes('["info","[multicc/voice] launch issued"')) seen.infoLogged++;
          if (b.includes('["reconcileAll",{"installIfNeeded":true}]')) seen.reconcileAllInstall++;
        }
      }
      const missing = Object.entries(seen).filter(([, n]) => n === 0).map(([k]) => k);
      return { ok: missing.length === 0, details: { seen, missing } };
    },
    corpus(ctx) {
      const headers = { Host: '127.0.0.1:3456', 'X-Request-Id': 'diff-req-1', 'Content-Type': 'application/json' };
      const setScenario = scenario => async side => {
        if (side.name === 'node') { oracleWorld.applyScenario(scenario); return; }
        await fetchJson(side.port, 'POST', '/__setup', { Host: 'localhost', Cookie: `multicc_auth=${ctx.cookie}` }, { scenario });
      };
      const skew = ms => async side => {
        if (side.name === 'node') { oracleWorld.world.skew = ms; return; }
        await fetchJson(side.port, 'POST', '/__skew', { Host: 'localhost', Cookie: `multicc_auth=${ctx.cookie}` }, { ms });
      };
      const req = (method, url, body, extra) => ({ method, url, headers: { ...headers, ...(extra || {}) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      const cases = [];
      const add = (name, scenario, request, hooks) => cases.push([name, request, { before: setScenario(scenario), ...(hooks || {}) }]);
      // Case pairs that must observe the same world: only the first one resets it.
      const follow = (name, request, hooks) => cases.push([name, request, { before: async () => {}, ...(hooks || {}) }]);
      const calls = name => follow(`${name} calls`, { method: 'GET', url: '/__calls', headers });

      for (const v of ['', '/v1']) {
        const G = `/api${v}/voice-gateway`;
        // ---- GET / HEAD / OPTIONS / trailing slash / upper path --------------------------
        for (const scenario of ['global-running', 'empty', 'global-disabled']) {
          add(`get gateway${v} ${scenario}`, scenario, req('GET', G));
        }
        add(`get gateway${v} HEAD`, 'global-running', req('HEAD', G));
        add(`get gateway${v} trailing slash`, 'global-running', req('GET', `${G}/`));
        add(`gateway${v} OPTIONS`, 'global-running', req('OPTIONS', G));
        add(`get gateway${v} upper path`, 'global-running', req('GET', `/API${v}/Voice-Gateway`), forwardedPair('GET', `/API${v}/Voice-Gateway`,
          view => view.status === 200 && view.body.includes('"gateway"')));
        for (const m of ['POST', 'PATCH']) add(`gateway${v} ${m}`, 'global-running', req(m, G), forwardedPair(m, G, cannot(m, G)));
        // ---- PUT -------------------------------------------------------------------------
        const put = (name, body, scenario = 'empty') => add(`put gateway${v} ${name}`, scenario, req('PUT', G, body));
        put('create default', {});
        put('create enabled=false', { enabled: false });
        put('create enabled=true', { enabled: true });
        put('update existing', { enabled: false }, 'global-running');
        put('update keep', {}, 'global-running');
        put('provider ok', { provider: 'qwen-audio-agent' });
        put('provider bad', { provider: 'other' });
        put('provider null', { provider: null });
        put('enabled string', { enabled: 'yes' });
        put('enabled null', { enabled: null });
        put('commander host-owned', { commanderSessionId: 'x' });
        put('commander null', { commanderSessionId: null });
        put('autoInstall true', { autoInstall: true });
        put('autoInstall false', { autoInstall: false });
        put('autoInstall string', { autoInstall: 'true' });
        put('autoInstall null', { autoInstall: null });
        put('autoInstall 1', { autoInstall: 1 });
        put('extra keys', { enabled: true, autoInstall: true, ignored: [1] });
        put('array body', [1, 2]);
        put('string body', '"text"');
        put('null body', 'null');
        put('router conflict (provision refused, still ok)', { enabled: true }, 'global-router-conflict');
        put('router missing is provisioned', { enabled: true }, 'global-no-router');
        // ---- DELETE ----------------------------------------------------------------------
        add(`delete gateway${v} existing`, 'global-running', req('DELETE', G));
        add(`delete gateway${v} missing`, 'empty', req('DELETE', G));
        // ---- runtime / restart -----------------------------------------------------------
        for (const scenario of ['global-running', 'global-stopped', 'global-status-missing']) {
          add(`runtime gateway${v} ${scenario}`, scenario, req('GET', `${G}/runtime`));
        }
        add(`runtime gateway${v} HEAD`, 'global-running', req('HEAD', `${G}/runtime`));
        add(`runtime gateway${v} OPTIONS`, 'global-running', req('OPTIONS', `${G}/runtime`));
        add(`restart gateway${v} ok`, 'global-running', req('POST', `${G}/restart`, {}));
        add(`restart gateway${v} throws`, 'global-restart-throws', req('POST', `${G}/restart`, {}));
        add(`restart gateway${v} status missing`, 'global-status-missing', req('POST', `${G}/restart`, {}));
        add(`restart gateway${v} GET`, 'global-running', req('GET', `${G}/restart`), forwardedPair('GET', `${G}/restart`, cannot('GET', `${G}/restart`)));
        add(`restart gateway${v} OPTIONS`, 'global-running', req('OPTIONS', `${G}/restart`));
        // ---- launch ----------------------------------------------------------------------
        const launch = (name, scenario, body, hdr) => add(`launch ${name}${v}`, scenario, req('POST', `${G}/launch`, body, hdr));
        launch('global running', 'global-running', {});
        launch('chat source', 'global-running', { sourceSessionId: 'sess-a' });
        launch('chat source trimmed', 'global-running', { sourceSessionId: '  sess-a  ' });
        launch('stopped then started', 'global-stopped-start-ok', {});
        launch('stopped start fails (lastError code)', 'global-stopped-start-fails', {});
        launch('stopped start throws', 'global-stopped-start-throws', {});
        launch('slash url', 'global-running-slash-url', {});
        launch('not configured', 'empty', {});
        launch('disabled', 'global-disabled', {});
        launch('router missing', 'global-no-router', {});
        launch('router conflict', 'global-router-conflict', {});
        launch('chat router missing is fine', 'global-no-router', { sourceSessionId: 'sess-a' });
        launch('source unknown', 'global-running', { sourceSessionId: 'nope' });
        launch('source aux', 'global-running', { sourceSessionId: 'sess-aux' });
        launch('source gateway', 'global-running', { sourceSessionId: 'sess-gw' });
        launch('source terminal', 'global-running', { sourceSessionId: 'sess-term' });
        launch('source dir missing', 'global-running', { sourceSessionId: 'sess-ghostdir' });
        launch('source blank string', 'global-running', { sourceSessionId: '   ' });
        launch('source number', 'global-running', { sourceSessionId: 7 });
        launch('source null', 'global-running', { sourceSessionId: null });
        launch('extra keys ignored', 'global-running', { scope: 'chat', cwd: '/etc', prompt: 'x' });
        launch('array body', 'global-running', [1]);
        launch('no body', 'global-running', undefined);
        // loopbackOnly follows the Host header the caller used
        for (const [label, host] of [['ip', '127.0.0.1:3456'], ['localhost upper', 'LOCALHOST:3456'], ['v6 bracket', '[::1]:3456'],
          ['v6 bare bracket', '[::1]'], ['v6 no bracket', '::1'], ['lan', '192.168.1.9:3456'], ['domain', 'example.com'], ['funnel', 'm.tail94695a.ts.net']]) {
          // A non-loopback Host is refused by the auth gate (403, identically on both sides) unless the
          // request carries credentials; without them loopbackOnly=false would never be observed.
          launch(`host ${label}`, 'global-running', {}, { Host: host, Cookie: `multicc_auth=${ctx.cookie}` });
        }
        add(`launch${v} GET`, 'global-running', req('GET', `${G}/launch`), forwardedPair('GET', `${G}/launch`, cannot('GET', `${G}/launch`)));
        add(`launch${v} OPTIONS`, 'global-running', req('OPTIONS', `${G}/launch`));
        add(`launch${v} malformed json`, 'global-running', req('POST', `${G}/launch`, '{'));
        // ---- resolve (needs a real ticket on the same world) -----------------------------
        add(`resolve${v} step1 issue`, 'global-running', req('POST', `${G}/launch`, {}));
        follow(`resolve${v} step2 ok`, req('GET', `${G}/launch/launch-1`));
        follow(`resolve${v} step2 HEAD`, req('HEAD', `${G}/launch/launch-1`));
        follow(`resolve${v} step2 OPTIONS`, req('OPTIONS', `${G}/launch/launch-1`));
        follow(`resolve${v} step2 trailing slash`, req('GET', `${G}/launch/launch-1/`));
        follow(`resolve${v} step3 unknown`, req('GET', `${G}/launch/launch-999`));
        follow(`resolve${v} step3 encoded`, req('GET', `${G}/launch/launch%2D1`));
        follow(`resolve${v} step3 bad escape`, req('GET', `${G}/launch/bad%ZZ`));
        follow(`resolve${v} step3 deeper path`, req('GET', `${G}/launch/launch-1/extra`), forwardedPair('GET', `${G}/launch/launch-1/extra`, cannot('GET', `${G}/launch/launch-1/extra`)));
        follow(`resolve${v} step4 expire`, req('GET', `${G}/launch/launch-1`), { before: skew(31 * 60 * 1000) });
        follow(`resolve${v} step5 expired gone`, req('GET', `${G}/launch/launch-1`));
        // a launch that ends without a URL revokes its ticket: resolving that id must now fail
        add(`resolve${v} revoked step1 launch without url`, 'global-stopped-start-fails', req('POST', `${G}/launch`, {}));
        follow(`resolve${v} revoked step2 id is gone`, req('GET', `${G}/launch/launch-1`));
        // a chat ticket re-validates against live records: delete the source, then resolve
        add(`resolve${v} chat step1 issue`, 'global-running', req('POST', `${G}/launch`, { sourceSessionId: 'sess-a' }));
        follow(`resolve${v} chat step2 ok`, req('GET', `${G}/launch/launch-1`));
        // ---- side effects ----------------------------------------------------------------
        for (const [label, scenario, request] of [
          ['put autoInstall true', 'empty', req('PUT', G, { enabled: true, autoInstall: true })],
          ['put autoInstall false', 'empty', req('PUT', G, { enabled: true })],
          ['put disabled gateway', 'empty', req('PUT', G, { enabled: false })],
          ['delete', 'global-running', req('DELETE', G)],
          ['launch ok', 'global-stopped-start-ok', req('POST', `${G}/launch`, {})],
          ['launch no url', 'global-stopped-start-fails', req('POST', `${G}/launch`, {})],
          ['restart', 'global-running', req('POST', `${G}/restart`, {})],
        ]) {
          cases.push([`effects ${label}${v}`, request, { before: setScenario(scenario) }]);
          calls(`effects ${label}${v}`);
        }

        // ---- qwen-audio-runtime: /voice-runtime ------------------------------------------
        const R = `/api${v}/voice-runtime`;
        add(`runtime status${v} installed`, 'global-running', req('GET', R));
        add(`runtime status${v} fresh`, 'installer-fresh', req('GET', R));
        add(`runtime status${v} HEAD`, 'global-running', req('HEAD', R));
        add(`runtime status${v} OPTIONS`, 'global-running', req('OPTIONS', R));
        add(`runtime status${v} trailing slash`, 'global-running', req('GET', `${R}/`));
        add(`install${v} already installed`, 'global-running', req('POST', `${R}/install`, {}));
        add(`install${v} fresh`, 'installer-fresh', req('POST', `${R}/install`, {}));
        add(`install${v} wait rejects`, 'installer-wait-rejects', req('POST', `${R}/install`, {}));
        add(`install${v} start throws`, 'installer-start-throws', req('POST', `${R}/install`, {}));
        add(`install${v} OPTIONS`, 'global-running', req('OPTIONS', `${R}/install`));
        add(`install${v} GET`, 'global-running', req('GET', `${R}/install`), forwardedPair('GET', `${R}/install`, cannot('GET', `${R}/install`)));
        // ---- Fleet runtime projection ----------------------------------------------------
        const F = d => `/api${v}/directories/${d}/voice-gateway`;
        for (const [scenario, label] of [['global-running', 'projected'], ['no-global', 'plain']]) {
          for (const dir of ['dir-b', 'dir-a', 'dir-%E5%86%B7', 'bad%ZZ']) {
            add(`fleet runtime${v} ${label} ${dir}`, scenario, req('GET', `${F(dir)}/runtime`));
            add(`fleet restart${v} ${label} ${dir}`, scenario, req('POST', `${F(dir)}/restart`, {}));
          }
        }
        add(`fleet runtime${v} HEAD`, 'global-running', req('HEAD', `${F('dir-b')}/runtime`));
        add(`fleet runtime${v} OPTIONS`, 'global-running', req('OPTIONS', `${F('dir-b')}/runtime`));
        add(`fleet restart${v} OPTIONS`, 'global-running', req('OPTIONS', `${F('dir-b')}/restart`));
        add(`fleet runtime${v} trailing slash`, 'global-running', req('GET', `${F('dir-b')}/runtime/`));
        add(`fleet restart${v} throws projected`, 'global-restart-throws', req('POST', `${F('dir-b')}/restart`, {}));
        add(`fleet restart${v} throws plain`, 'no-global-restart-throws', req('POST', `${F('dir-b')}/restart`, {}));
        add(`fleet restart${v} GET`, 'global-running', req('GET', `${F('dir-b')}/restart`), forwardedPair('GET', `${F('dir-b')}/restart`, cannot('GET', `${F('dir-b')}/restart`)));
        add(`fleet upper path${v}`, 'global-running', req('GET', `/API${v}/Directories/dir-b/Voice-Gateway/Runtime`), forwardedPair('GET', `/API${v}/Directories/dir-b/Voice-Gateway/Runtime`,
          view => view.status === 200 && view.body.includes('"runtime"')));
      }
      return cases;
    },
  });
}
main().then(ok => { process.exitCode = ok ? 0 : 1; }).catch(error => { console.error(error); process.exitCode = 1; });
