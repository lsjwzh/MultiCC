'use strict';
// Byte-for-byte differential for the server-core cluster retired from server.js
// and src/health.js: GET|HEAD /healthz, /readyz, /metrics and
// GET /api/repo-operations/:operationId (native/gateway/src/app/server_core.rs).
//
// The Node oracle is the frozen handler copy in
// tests/helpers/legacy-server-core-routes.js (not `git show`, so it keeps
// running as the tree moves). The Rust side is the real front door: it asks the
// Node child for the same host facts through `POST /api/__host/server-core`,
// which this script's stub answers with the exact DTO the retired host adapter
// produces. Both sides therefore see identical facts; only the rendering is
// under test (status, headers, body, gzip, the metrics sort/number format).
//
// Prints THREE numbers the brief asks for: total requests, byte-identical
// requests, and the per-op host-call counts (health/metrics/repoOperation).
//
// Usage: node docs/rust-migration/differential/server-core.js <repo> <gateway> <addon>
const path = require('node:path');
const fs = require('node:fs');
const { run, waitForFixture } = require('./lib');

const FIXED = { 'x-request-id': 'req-fixed', 'x-correlation-id': 'corr-fixed' };

// The retired `metrics.render` sorted with `localeCompare`; Rust sorts by bytes.
// For every name this process emits the two orders coincide, and the corpus is
// restricted to that alphabet. Assert it here instead of trusting it, so the
// premise cannot silently rot.
function assertMetricOrder(names) {
  const locale = [...names].sort((a, b) => a.localeCompare(b));
  const bytes = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (JSON.stringify(locale) !== JSON.stringify(bytes)) {
    throw new Error(`metric names disagree on locale vs byte order: ${locale.join(', ')} | ${bytes.join(', ')}`);
  }
}

function metricsText(table) {
  const { createMetrics } = require('../../../tests/helpers/frozen-batch10').frozen('observability');
  const metrics = createMetrics();
  for (const [name, value] of Object.entries(table)) metrics.set(name, value);
  return metrics.render();
}

// The exact `{ok, ...}` DTOs the real host adapter would answer with for these
// facts (src/routes/server-core-host.js).
function hostDtos(state) {
  return {
    health: { ok: true, uptimeSeconds: state.health.uptimeSeconds, ready: state.health.ready, checks: state.health.checks },
    metrics: { ok: true, metrics: state.metrics },
  };
}

function upstreamScript(repo, state) {
  const dtos = hostDtos(state);
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const path = require('node:path'); const fs = require('node:fs');
const repo = ${JSON.stringify(repo)};
const stateDir = process.env.MULTICC_DATA_DIR;
// The front door's auth gate needs a live control channel before it answers;
// the real child opens it in src/gateway-child.js. Keep the security object on
// globalThis exactly like the other differential stubs (the native runtime must
// find it still alive when a later snapshot is requested).
const { createAuthSecurity } = require(path.join(repo, 'src/native/binding')).authSecurity;
const { connectAuthControl } = require(path.join(repo, 'src/native/binding')).gatewayChild;
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
const STATE = ${JSON.stringify({ health: dtos.health, metrics: dtos.metrics, ops: state.ops })};
const server = http.createServer((req, res) => {
  if (req.url === '/__health') { res.end('ok'); return; }
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
    fs.appendFileSync(path.join(stateDir, 'server-core-calls.jsonl'), JSON.stringify(body) + '\\n');
    if (req.url !== '/api/__host/server-core') {
      const text = 'forwarded:' + req.method + ' ' + req.url;
      res.writeHead(599, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(text) });
      return res.end(text);
    }
    if (body.op === 'health') return reply(res, STATE.health);
    if (body.op === 'metrics') return reply(res, STATE.metrics);
    if (body.op === 'repoOperation') {
      const exists = Object.prototype.hasOwnProperty.call(STATE.ops, body.operationId);
      return reply(res, { ok: true, operation: exists ? STATE.ops[body.operationId] : null });
    }
    return reply(res, { error: 'unknown host operation' }, 400);
  });
});
function reply(res, value, status = 200) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
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
process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
`;
}

function oracleMount(repo, state) {
  const { createLegacyServerCoreRoutes } = require(path.join(repo, 'tests/helpers/legacy-server-core-routes'));
  const deps = {
    uptime: () => state.health.uptimeSeconds,
    isReady: () => state.health.ready,
    readinessDetails: () => state.health.checks,
    renderMetrics: () => metricsText(state.metrics),
    status: id => (Object.prototype.hasOwnProperty.call(state.ops, id) ? state.ops[id] : null),
  };
  return createLegacyServerCoreRoutes(deps);
}

const readyBigOperation = {
  id: 'big',
  status: 'done',
  steps: Array.from({ length: 24 }, (_, i) => ({ index: i, label: `step-${i}`, outcome: 'ok' })),
  note: 'z'.repeat(400),
};

function readyState() {
  return {
    health: { uptimeSeconds: 42, ready: true, checks: { commanderMigration: { ready: true, phase: 'ready' } } },
    metrics: {
      multicc_ready: 1,
      multicc_active_turns: 3,
      multicc_ws_clients: 2,
      multicc_git_queue_depth: 0,
      multicc_active_waits: 5,
      multicc_event_loop_lag_mean_seconds: 0.001234,
      multicc_event_loop_lag_max_seconds: 0.0125,
      multicc_some_decimal: 0.5,
      multicc_big_number: 1e21,
      multicc_alpha_total: 7,
      multicc_zeta: 100,
      multicc_api_error_decision_retry_total: 2,
    },
    ops: {
      'op-1': { id: 'op-1', status: 'done', kind: 'merge', files: ['a.js', 'b.js'] },
      big: readyBigOperation,
    },
  };
}

function notReadyState() {
  return {
    health: { uptimeSeconds: 7, ready: false, checks: null },
    metrics: {},
    ops: {},
  };
}

function requests(state, ctx) {
  const base = { ...FIXED };
  const authed = { ...FIXED, Cookie: ctx.cookie };
  const gzip = { ...authed, 'accept-encoding': 'gzip' };
  const get = (method, url, headers) => ({ method, url, headers });
  const list = [
    ['healthz GET', get('GET', '/healthz', base)],
    ['healthz HEAD', get('HEAD', '/healthz', base)],
    ['healthz OPTIONS', get('OPTIONS', '/healthz', base)],
    ['healthz GET no auth', get('GET', '/healthz', base)],
  ];
  if (state.health.ready) {
    list.push(
      ['readyz GET ready', get('GET', '/readyz', authed)],
      ['readyz HEAD ready', get('HEAD', '/readyz', authed)],
      ['metrics GET rich', get('GET', '/metrics', authed)],
      ['metrics HEAD rich', get('HEAD', '/metrics', authed)],
      ['metrics OPTIONS authed', get('OPTIONS', '/metrics', authed)],
      ['metrics GET no auth (redirect)', get('GET', '/metrics', base)],
      ['metrics OPTIONS no auth', get('OPTIONS', '/metrics', base)],
      ['repo GET exists', get('GET', '/api/repo-operations/op-1', authed)],
      ['repo GET missing', get('GET', '/api/repo-operations/missing', authed)],
      ['repo GET url-decoded id', get('GET', '/api/repo-operations/op%2D1', authed)],
      ['repo GET big gzip', get('GET', '/api/repo-operations/big', gzip)],
      ['repo GET big plain', get('GET', '/api/repo-operations/big', authed)],
      ['repo HEAD big gzip', get('HEAD', '/api/repo-operations/big', gzip)],
      ['repo OPTIONS authed', get('OPTIONS', '/api/repo-operations/op-1', authed)],
      ['repo GET no auth (403)', get('GET', '/api/repo-operations/op-1', base)],
    );
  } else {
    list.push(
      ['readyz GET not-ready', get('GET', '/readyz', authed)],
      ['readyz HEAD not-ready', get('HEAD', '/readyz', authed)],
      ['metrics GET empty', get('GET', '/metrics', authed)],
      ['metrics HEAD empty', get('HEAD', '/metrics', authed)],
      ['repo GET all-missing', get('GET', '/api/repo-operations/op-x', authed)],
    );
  }
  return list;
}

function spec(name, repo, state) {
  assertMetricOrder(Object.keys(state.metrics));
  return {
    name,
    mount(app) {
      oracleMount(repo, state)(app);
    },
    upstream: upstreamScript(repo, state),
    ready: waitForFixture,
    // Differential-only mutations (native/gateway/src/app/server_core.rs reads
    // this); the parent process forwards it so a mutation run cannot be missed.
    gatewayEnv: process.env.MULTICC_SERVER_CORE_MUTATION
      ? { MULTICC_SERVER_CORE_MUTATION: process.env.MULTICC_SERVER_CORE_MUTATION }
      : undefined,
    corpus(ctx) {
      return requests(state, ctx);
    },
    finalize({ views, gwData }) {
      // The per-op host-call counts are the stub's own log, so they measure what
      // the front door actually asked Node for (not what the corpus intended).
      const log = path.join(gwData, 'server-core-calls.jsonl');
      const hostCalls = { health: 0, metrics: 0, repoOperation: 0 };
      if (fs.existsSync(log)) {
        for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
          if (!line) continue;
          const op = JSON.parse(line).op;
          if (Object.prototype.hasOwnProperty.call(hostCalls, op)) hostCalls[op] += 1;
        }
      }
      const identical = views.filter(v => JSON.stringify(v.node) === JSON.stringify(v.rust)).length;
      // The brief asks for three numbers on stdout: total requests compared,
      // how many were byte-identical, and what the front door actually asked
      // the host for per operation.
      console.log(`total ${views.length} identical ${identical} host-calls ${JSON.stringify(hostCalls)}`);
      return { ok: true, total: views.length, identical, hostCalls };
    },
  };
}

async function main2() {
  const argv = process.argv.slice(2);
  const [repoArg, gatewayBin] = argv;
  if (!repoArg || !gatewayBin) throw new Error('usage: node server-core.js <repo> <gateway> <addon>');
  const repo = path.resolve(repoArg);

  const ready = readyState();
  const notReady = notReadyState();
  const okReady = await run(spec('server-core-ready', repo, ready), argv);
  const okNotReady = await run(spec('server-core-not-ready', repo, notReady), argv);
  if (process.env.MULTICC_SERVER_CORE_MUTATION) {
    console.log(`mutation ${process.env.MULTICC_SERVER_CORE_MUTATION}${okReady && okNotReady ? ' WAS NOT CAUGHT' : ' caught'}`);
  }
  process.exitCode = okReady && okNotReady ? 0 : 1;
}

if (require.main === module) {
  main2().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { spec, readyState, notReadyState, assertMetricOrder };
