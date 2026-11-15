'use strict';

// Differential run for the 40 host-and-system-operation routes retired from
// src/routes/{server-restart-route,update-route,developer-tools,macos-privacy,
// ops-terminal,host-write,host-power,skill-sync,doctor,env-doctor}.js and now
// answered by native/gateway/src/app/host_ops_routes.rs (rules in
// native/core/src/host_ops_routes.rs):
//
//   POST                 /api/restart, /api/desktop-shutdown
//   GET|HEAD             /api/update/status          POST /api/update
//   GET|HEAD             /api/system/developer-tools
//   POST                 /api/system/developer-tools/install
//   GET|HEAD|POST        /api/system/developer-tools/install-git
//   GET|HEAD             /api/system/disk-access     POST …/disk-access/open
//   GET|HEAD             /api/system/agent-permissions
//   POST                 …/agent-permissions/{open,restart}
//   GET|HEAD             /api/system/agent-install   POST …/agent-install/replace
//   GET|HEAD             /api/system/ops-env
//   GET|HEAD|POST        /api/system/ops-run         POST /api/system/ops-run/stop
//   POST                 /api/settings/notify, /api/settings/tunnel
//   POST                 /api/tunnel/restart/:provider
//   POST                 /api/tunnel/sakurafrp/public-url, /api/tunnel/funnel
//   POST                 /api/settings/access-token
//   POST                 /api/settings/power, …/power/auto-unlock
//   POST|DELETE          /api/settings/power/unlock-password
//   POST                 …/unlock-password/authorize
//   POST                 /api/settings/task-attribution
//   GET|HEAD             /api/skill-sync/status      POST /api/skill-sync/run
//   POST                 /api/system/env-doctor
//   GET|HEAD             /api/system/env-doctor/:runId
//   POST                 /api/system/env-doctor/:runId/cancel
//   POST                 /api/sessions/:id/doctor
//   GET|HEAD             /api/sessions/:id/doctor
//   GET|HEAD             /api/doctor/runs/:runId
//   POST                 /api/doctor/runs/:runId/cancel
//
//   node docs/rust-migration/differential/host-ops-routes.js <repo> <gateway> [addon]
//
// The Node side mounts the frozen retired layers (tests/helpers/
// legacy-host-ops-routes/) over one scripted world (…/world.js). The Rust front
// door calls its host port (/api/__host/host-ops); the stub child mounts the
// live src/routes/host-ops-host.js over the same world, so both sides read one
// set of facts and the comparison covers the split itself: path matching,
// parameter decoding, the query subset, the body Express parsed, the automatic
// OPTIONS union (including the methods other clusters register on shared
// paths), the session access guard, the non-local refusal, the relayed
// headers and the response envelope.
//
// Two process-level routes are exercised without running anything:
// `POST /api/restart` and `POST /api/update` get a fake spawn that records the
// call and never starts a process, and the fake manager file the preflight
// reads lives in a temporary root, so the run can prove the launcher was
// scheduled exactly once and that no updater ever started. The 503 branch is a
// case of its own: the child drops the socket for one request (recognised by
// its `?down=1` URL), which is the one documented difference — Express has no
// equivalent, so the oracle answers its ordinary 409 there.
//
// Numeric safety is not a claim here, it is a measurement: the password, the
// sanitized skill-sync failure and the masked tunnel message are canaries that
// fail the run if any response leaks them.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-host-ops-1' };
const REMOTE_IP = '203.0.113.9';
// A remote-looking client: Host stays localhost, the forwarding header makes the
// auth gate accept the session cookie without a login redirect (the same rule
// Rust's http_gate applies).
const remoteHeaders = ctx => ({ ...L, 'X-Forwarded-For': REMOTE_IP, Cookie: 'multicc_auth=' + ctx.cookie });

// The paths another production layer also registers, and on which side of this
// cluster it is mounted. Express derives its automatic OPTIONS Allow list from
// the mounted layers, so a pass-through keeps the other method visible.
const HOST_READ_GETS = [
  '/api/settings/notify', '/api/settings/tunnel', '/api/tunnel/funnel',
  '/api/settings/access-token', '/api/settings/power',
];
const TASK_GET = '/api/settings/task-attribution';

let workPath = '';
let rootDir = '';
let world = null;
let upstreamText = '';
const problems = [];
const pending = [];

function add(name, request, hooks = {}) {
  pending.push([name, request, hooks]);
}

function corpus(ctx) {
  const REMOTE = remoteHeaders(ctx);
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  const json = { ...L, 'Content-Type': 'application/json' };
  const post = (url, body, headers = json) => ({ method: 'POST', url, headers, body: JSON.stringify(body === undefined ? {} : body) });
  // Node 26's server rejects a chunked DELETE body, and the harness sends the
  // body itself, so length has to be stated.
  const del = (url, body, headers = json) => {
    const text = JSON.stringify(body === undefined ? {} : body);
    return { method: 'DELETE', url, headers: { ...headers, 'Content-Length': String(Buffer.byteLength(text)) }, body: text };
  };

  // ── restart / update ────────────────────────────────────────────────────
  add('restart schedules the detached launcher', () => post('/api/restart', {}));
  add('restart debounces a second request', () => post('/api/restart', {}));
  // The front door cannot reach the child for this one: Rust 503, Express 409.
  add('restart with the host unreachable', () => post('/api/restart?down=1', {}), {
    expectedDifference: {
      node: view => view.status === 409,
      rust: view => view.status === 503 && view.body.includes('rust_backend_unavailable'),
    },
  });
  add('desktop shutdown is a 404 outside desktop mode', () => post('/api/desktop-shutdown', {}));
  add('update status before any update', () => get('/api/update/status'));
  add('update schedules the detached launcher', () => post('/api/update', {}));
  add('update debounces a second request', () => post('/api/update', {}));
  add('update status while scheduled', () => get('/api/update/status'));

  // ── developer tools ─────────────────────────────────────────────────────
  add('developer tools status', () => get('/api/system/developer-tools'));
  add('developer tools status HEAD', () => head('/api/system/developer-tools'));
  add('developer tools install when already installed', () => post('/api/system/developer-tools/install', {}));
  add('portable git status before installing', () => get('/api/system/developer-tools/install-git'));
  add('portable git install starts a job', () => post('/api/system/developer-tools/install-git', {}));
  add('portable git status while running', () => get('/api/system/developer-tools/install-git'));

  // ── macOS privacy / Agent ───────────────────────────────────────────────
  add('disk access target', () => get('/api/system/disk-access'));
  add('open the full disk access pane', () => post('/api/system/disk-access/open', {}));
  add('agent permissions', () => get('/api/system/agent-permissions'));
  add('agent permissions on a remote peer is still readable', () => get('/api/system/agent-permissions', REMOTE));
  add('open the accessibility pane', () => post('/api/system/agent-permissions/open', { permission: 'accessibility' }));
  add('open a pane the agent refuses', () => post('/api/system/agent-permissions/open', { permission: 'screenRecording' }));
  add('open an unknown permission', () => post('/api/system/agent-permissions/open', { permission: 'microphone' }));
  add('restart the agent', () => post('/api/system/agent-permissions/restart', {}));
  add('agent install state', () => get('/api/system/agent-install'));
  add('replace the other owner agent', () => post('/api/system/agent-install/replace', {}));

  // ── repair terminal ─────────────────────────────────────────────────────
  add('ops environment probe', () => get('/api/system/ops-env'));
  add('ops run with an empty command', () => post('/api/system/ops-run', { command: '   ' }));
  add('ops run starts a job', () => post('/api/system/ops-run', { command: 'apt-get install -y git' }));
  add('ops run status from the start', () => get('/api/system/ops-run?from=0'));
  add('ops run status from the middle', () => get('/api/system/ops-run?from=8'));
  add('ops run stop', () => post('/api/system/ops-run/stop', {}));
  add('ops run status after the stop', () => get('/api/system/ops-run'));

  // ── settings / tunnel ───────────────────────────────────────────────────
  add('notify settings update', () => post('/api/settings/notify', { barkUrl: 'https://bark.example/new' }));
  add('notify settings reject a non-url', () => post('/api/settings/notify', { barkUrl: 'not a url' }));
  add('tunnel settings apply a provider', () => post('/api/settings/tunnel', { natapp: { enabled: true, url: 'https://tunnel.example' } }));
  add('tunnel settings reject a bad interval', () => post('/api/settings/tunnel', { intervalSec: 1 }));
  add('restart a known provider', () => post('/api/tunnel/restart/natapp', {}));
  add('restart a provider that fails', () => post('/api/tunnel/restart/cpolar', {}));
  add('restart an unknown provider', () => post('/api/tunnel/restart/unknown', {}));
  add('restart a percent-encoded provider', () => post('/api/tunnel/restart/a%2Fb', {}));
  add('restart with a traversal-looking provider', () => post('/api/tunnel/restart/..%2F..%2Fetc%2Fpasswd', {}));
  add('backfill the sakura public url', () => post('/api/tunnel/sakurafrp/public-url', { boundDomain: 'demo.nyat.app' }));
  add('backfill without a bound domain', () => post('/api/tunnel/sakurafrp/public-url', {}));
  add('enable funnel', () => post('/api/tunnel/funnel', { on: true, port: 8443 }));
  add('disable funnel', () => post('/api/tunnel/funnel', { on: false }));
  add('funnel with an invalid port', () => post('/api/tunnel/funnel', { on: true, port: 70000 }));
  add('access token update', () => post('/api/settings/access-token', { token: 'new-token' }));

  // ── power ───────────────────────────────────────────────────────────────
  add('lid mode without an unlock password', () => post('/api/settings/power', { enabled: true }));
  add('save the unlock password', () => post('/api/settings/power/unlock-password', { password: 'hunter2' }));
  add('lid mode with the password and authorization', () => post('/api/settings/power', { enabled: true }));
  add('enable auto unlock', () => post('/api/settings/power/auto-unlock', { enabled: true }));
  add('clear the password while lid mode is on', () => del('/api/settings/power/unlock-password'));
  add('lid mode off', () => post('/api/settings/power', { enabled: false }));
  add('disable auto unlock', () => post('/api/settings/power/auto-unlock', { enabled: false }));
  add('clear the password', () => del('/api/settings/power/unlock-password'));
  add('authorize with no password saved', () => post('/api/settings/power/unlock-password/authorize', {}));
  add('save the password again', () => post('/api/settings/power/unlock-password', { password: 'hunter2' }));
  add('authorize with a password saved', () => post('/api/settings/power/unlock-password/authorize', {}));
  add('save the password from a remote peer', () => post('/api/settings/power/unlock-password', { password: 'hunter2' }, REMOTE));
  add('save an empty password', () => post('/api/settings/power/unlock-password', { password: '' }));
  add('task attribution update', () => post('/api/settings/task-attribution', { mode: 'manual' }));
  add('task attribution rejects an unknown mode', () => post('/api/settings/task-attribution', { mode: 'bogus' }));
  add('task attribution from a remote peer', () => post('/api/settings/task-attribution', { mode: 'auto' }, REMOTE));

  // ── skill sync ──────────────────────────────────────────────────────────
  add('skill sync status', () => get('/api/skill-sync/status'));
  add('skill sync run', () => post('/api/skill-sync/run', {}));
  add('skill sync run while busy', () => post('/api/skill-sync/run', {}));
  add('skill sync failure is sanitized', () => post('/api/skill-sync/run', {}));

  // ── environment doctor ──────────────────────────────────────────────────
  add('env doctor without an error or path', () => post('/api/system/env-doctor', {}));
  add('env doctor starts a run', () => post('/api/system/env-doctor', { path: '/tmp/project', fix: true }));
  add('env doctor run result', () => get('/api/system/env-doctor/env-1'));
  add('env doctor unknown run', () => get('/api/system/env-doctor/env-9'));
  add('env doctor cancel a running run', () => post('/api/system/env-doctor/env-1/cancel', {}));
  add('env doctor cancel an unknown run', () => post('/api/system/env-doctor/env-9/cancel', {}));

  // ── session doctor ──────────────────────────────────────────────────────
  add('session doctor starts a run', () => post('/api/sessions/s1/doctor', { autofix: true }));
  add('session doctor lists runs', () => get('/api/sessions/s1/doctor'));
  add('session doctor for an unknown session', () => post('/api/sessions/ghost/doctor', {}));
  add('session doctor for an internal execution slot', () => get('/api/sessions/internal1/doctor'));
  add('session doctor OPTIONS for an internal slot', () => options('/api/sessions/internal1/doctor'));
  add('doctor run result', () => get('/api/doctor/runs/doc-1'));
  add('doctor unknown run', () => get('/api/doctor/runs/nope'));
  add('doctor cancel', () => post('/api/doctor/runs/doc-1/cancel', {}));
  add('doctor cancel an unknown run', () => post('/api/doctor/runs/nope/cancel', {}));

  // ── automatic OPTIONS, measured against the retired Express stack ───────
  add('OPTIONS restart', () => options('/api/restart'));
  add('OPTIONS desktop shutdown', () => options('/api/desktop-shutdown'));
  add('OPTIONS update status', () => options('/api/update/status'));
  add('OPTIONS developer tools install-git', () => options('/api/system/developer-tools/install-git'));
  add('OPTIONS disk access', () => options('/api/system/disk-access'));
  add('OPTIONS ops run', () => options('/api/system/ops-run'));
  add('OPTIONS unlock password', () => options('/api/settings/power/unlock-password'));
  add('OPTIONS settings power', () => options('/api/settings/power'));
  add('OPTIONS settings tunnel', () => options('/api/settings/tunnel'));
  add('OPTIONS tunnel funnel', () => options('/api/tunnel/funnel'));
  add('OPTIONS access token', () => options('/api/settings/access-token'));
  add('OPTIONS task attribution', () => options('/api/settings/task-attribution'));
  add('OPTIONS session doctor', () => options('/api/sessions/s1/doctor'));
  add('OPTIONS env doctor run', () => options('/api/system/env-doctor/env-1'));

  return pending;
}

// ── the oracle ──────────────────────────────────────────────────────────────

function mountOracle(app, { repo, work }) {
  workPath = work;
  rootDir = path.join(work, 'host-root');
  // The fake manager the restart/update preflight reads, and the .git the
  // update preflight requires. A temporary root only.
  fs.mkdirSync(path.join(rootDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'multicc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(rootDir, '.git'), { recursive: true });
  Date.now = () => require(path.join(repo, 'tests/helpers/legacy-host-ops-routes/world')).FROZEN_NOW;

  const { createWorld, mountFrozen, FROZEN_NOW } = require(path.join(repo, 'tests/helpers/legacy-host-ops-routes/world'));
  const frozen = require(path.join(repo, 'tests/helpers/legacy-host-ops-routes'));
  world = createWorld({ rootDir });

  // The locality fact the front door computes on the real client address and
  // passes to the host port. macos-privacy reads the socket directly, so the
  // oracle has to move it too.
  app.use((req, _res, next) => {
    const remote = Boolean(req.headers['x-forwarded-for']);
    req.local = !remote;
    // Node's net.Socket exposes remoteAddress as a prototype getter; an own
    // property is the only way to retell the frozen handler who is connected.
    if (remote) Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: REMOTE_IP });
    next();
  });
  // `publicSessionAccessGuard` before the handlers and before OPTIONS.
  app.use((req, res, next) => {
    const match = /^\/api\/sessions\/([^/]+)\/doctor\/?$/.exec(req.path);
    if (match && match[1].startsWith('internal')) {
      return res.status(404).json({ error: 'session not found' });
    }
    return next();
  });
  // The host-read cluster registers the GET on these first in server.js.
  for (const routePath of HOST_READ_GETS) app.get(routePath, (_req, _res, next) => next());
  mountFrozen(app, frozen, world);
  // …and the task surface registers the GET on this one after host-write.
  app.get(TASK_GET, (_req, _res, next) => next());

  upstreamText = upstreamSource(repo);
}

// ── the gateway's stub child ────────────────────────────────────────────────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const { createWorld, FROZEN_NOW } = require(path.join(REPO, 'tests/helpers/legacy-host-ops-routes/world'));
// The same frozen clock the oracle uses; the restart route counts streaming
// turns with Date.now() and the update route stamps its startedAt.
Date.now = () => FROZEN_NOW;

const express = require(require.resolve('express', { paths: [REPO] }));
const world = createWorld({ rootDir: process.env.HOST_OPS_ROOT });

// Both detached launchers are fakes; the log is written so this process can
// prove it scheduled each of them exactly once without starting anything.
const spawnLog = [];
for (const [name, deps] of [['restart', world.restartDeps], ['update', world.updateDeps]]) {
  const base = deps.spawn;
  deps.spawn = (file, args, options) => {
    spawnLog.push({ module: name, file, args });
    fs.writeFileSync(process.env.HOST_OPS_SPAWN_LOG, JSON.stringify(spawnLog));
    return base(file, args, options);
  };
}

const { createServerRestartRoute } = require(path.join(REPO, 'src/routes/server-restart-route'));
const { createUpdateRoute } = require(path.join(REPO, 'src/routes/update-route'));
const { createHostOpsHost } = require(path.join(REPO, 'src/routes/host-ops-host'));

const app = express();
app.use(express.json({ limit: '50mb' }));
app.post('/api/__host/session-admin', (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const text = JSON.stringify({
    record: id ? { id } : null,
    internal: id.startsWith('internal'),
    taskStateWritable: true,
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
});
createHostOpsHost({
  express,
  serverRestart: createServerRestartRoute(world.restartDeps),
  update: createUpdateRoute(world.updateDeps),
  hostWrite: world.hostWrite,
  skillSync: world.skillSync,
  envDoctor: world.envDoctor,
  doctor: world.doctor,
  developerTools: world.developerTools,
  macosPrivacy: world.macosPrivacy,
  opsTerminal: world.opsTerminal,
}).mountRoute(app);
app.use((_req, res) => res.status(404).end('forwarded'));

// The host-ops POST is answered by a real Express request, so body-parser
// reads a real stream. One request (?down=1) is dropped before it is answered.
const inner = http.createServer(app);
inner.listen(0, '127.0.0.1', () => {
  const innerPort = inner.address().port;
  const forward = (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/api/__host/host-ops' && req.method === 'POST') {
        let input = {};
        try { input = JSON.parse(body.toString('utf8') || '{}'); } catch (_) {}
        if (String(input.originalUrl || '').includes('down=1')) { req.socket.destroy(); return; }
      }
      const upstream = http.request({
        host: '127.0.0.1', port: innerPort, method: req.method, path: req.url,
        headers: { ...req.headers, 'content-length': String(body.length) },
      }, reply => {
        res.writeHead(reply.statusCode || 502, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', () => { try { res.destroy(); } catch (_) {} });
      upstream.end(body);
    });
  };
  const server = http.createServer(forward);
  const listener = net.createServer({ pauseOnConnect: true }, socket => {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    const onData = chunk => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      const marker = buffered.indexOf('\\r\\n');
      if (marker < 0) return;
      socket.removeListener('data', onData);
      socket.pause();
      const rest = buffered.subarray(marker + 2);
      if (rest.length) socket.unshift(rest);
      server.emit('connection', socket);
      socket.resume();
    };
    socket.on('data', onData);
    socket.resume();
  });
  listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
});
`;
}

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'host-ops-routes',
  mount: mountOracle,
  get upstream() { return upstreamText; },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: path.join(work, 'gw-data'),
    HOST_OPS_ROOT: path.join(work, 'host-root'),
    HOST_OPS_SPAWN_LOG: path.join(work, 'host-ops-spawns.json'),
  }),
  corpus,
  finalize({ views }) {
    const byName = new Map(views.map(view => [view.name, view]));
    const expect = (name, status, needle) => {
      const view = byName.get(name);
      if (!view) { problems.push(`${name}: missing from the corpus`); return; }
      for (const side of ['node', 'rust']) {
        if (view[side].status !== status) {
          problems.push(`${name}: ${side} answered ${view[side].status}, expected ${status} (${view[side].body})`);
        }
        if (needle && !view[side].body.includes(needle)) {
          problems.push(`${name}: ${side} body lacks ${needle} (${view[side].body})`);
        }
      }
    };
    // A silently failing world would let both sides 500 identically.
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        const body = view[side].body;
        if (/unexpected |invalid child process|TypeError/.test(body)) {
          problems.push(`${view.name}: ${side} hit a harness error (${body})`);
        }
      }
    }

    expect('restart schedules the detached launcher', 202, '"activeStreaming":1');
    expect('restart debounces a second request', 409, 'restart already in progress');
    // The one documented difference: the front door cannot reach its host.
  {
    const view = byName.get('restart with the host unreachable');
    if (!view) problems.push('restart with the host unreachable: missing from the corpus');
    else {
      if (view.node.status !== 409 || !view.node.body.includes('restart already in progress')) {
        problems.push(`restart with the host unreachable: oracle answered ${view.node.status} (${view.node.body})`);
      }
      if (view.rust.status !== 503 || !view.rust.body.includes('rust_backend_unavailable')) {
        problems.push(`restart with the host unreachable: rust answered ${view.rust.status} (${view.rust.body})`);
      }
    }
  }
    expect('desktop shutdown is a 404 outside desktop mode', 404, '"requestId":"diff-host-ops-1"');
    expect('update status before any update', 200, '"state":"idle"');
    expect('update schedules the detached launcher', 202, '"status":"started"');
    expect('update debounces a second request', 409, 'update already in progress');
    expect('update status while scheduled', 200, '"state":"scheduled"');
    expect('developer tools status', 200, '"gitWorks":true');
    expect('developer tools install when already installed', 200, 'already-installed');
    expect('portable git install starts a job', 202, '"status":"started"');
    expect('portable git status while running', 200, '"state":"running"');
    expect('disk access target', 200, '/opt/multicc/multicc');
    expect('open the full disk access pane', 200, '"status":"opened"');
    expect('agent permissions', 200, '"accessibility":true');
    expect('agent permissions on a remote peer is still readable', 200, '"local":false');
    expect('open the accessibility pane', 200, '"status":"opened"');
    expect('open a pane the agent refuses', 503, 'Agent permission request failed');
    expect('open an unknown permission', 400, 'unknown permission');
    expect('restart the agent', 200, '"accessibility":true');
    expect('agent install state', 200, '"installed":"2.14.0"');
    expect('replace the other owner agent', 200, '"replaced":true');
    expect('ops environment probe', 200, '"version":"2.39.2"');
    expect('ops run with an empty command', 400, 'INVALID_COMMAND');
    expect('ops run starts a job', 200, '"running":true');
    // `from=8` skips the first eight bytes of the captured output.
  expect('ops run status from the middle', 200, '"chunk":"ng git');
  expect('ops run status from the start', 200, '"chunk":"installing git');
    expect('ops run stop', 200, '"stopped":true');
    expect('ops run status after the stop', 200, '"running":false');
    expect('notify settings update', 200, '"ok":true');
    expect('notify settings reject a non-url', 400, 'notification URL must be http(s)');
    expect('tunnel settings apply a provider', 200, '"enabled":true');
    expect('tunnel settings reject a bad interval', 400, 'intervalSec must be an integer');
    expect('restart a known provider', 200, '"restarted":true');
    expect('restart a provider that fails', 400, 'tunnel_restart_failed');
    expect('restart an unknown provider', 400, 'unknown provider');
    expect('restart a percent-encoded provider', 400, 'unknown provider');
    expect('restart with a traversal-looking provider', 400, 'unknown provider');
    expect('backfill the sakura public url', 200, 'https://demo.nyat.app');
    expect('backfill without a bound domain', 400, '"reason":"underivable"');
    expect('enable funnel', 200, '"port":8443');
    expect('disable funnel', 400, 'Funnel 操作失败');
    expect('funnel with an invalid port', 400, 'port must be an integer');
    expect('access token update', 200, '"hasToken":true');
    expect('lid mode without an unlock password', 409, 'unlock_setup_required');
    expect('save the unlock password', 200, '"set":true');
    expect('lid mode with the password and authorization', 200, '"enabled":true');
    expect('enable auto unlock', 200, '"ok":true');
    expect('clear the password while lid mode is on', 409, '关盖运行');
    expect('lid mode off', 200, '"enabled":false');
    expect('disable auto unlock', 200, '"ok":true');
    expect('clear the password', 200, '"set":false');
    expect('authorize with no password saved', 200, '"state":"no-password"');
    expect('save the password again', 200, '"set":true');
    expect('authorize with a password saved', 200, '"state":"authorized"');
    expect('save the password from a remote peer', 403, '请在这台 Mac 上打开全局设置');
    expect('save an empty password', 400, 'password is required');
    expect('task attribution update', 200, '"mode":"manual"');
    expect('task attribution rejects an unknown mode', 400, 'invalid attribution mode');
    // The retired handler calls requireLocal(deps, req) without passing `res`, so a
  // non-local ask throws on res.status and both sides answer the 500 envelope.
  // Pre-existing behaviour, preserved byte for byte (see the report).
  expect('task attribution from a remote peer', 500, '"code":"internal_error"');
    expect('skill sync status', 200, '"running":false');
    expect('skill sync run', 200, '"synced":2');
    expect('skill sync run while busy', 409, 'sync already running');
    expect('skill sync failure is sanitized', 500, 'skill sync failed');
    expect('env doctor without an error or path', 400, 'INVALID_INPUT');
    expect('env doctor starts a run', 200, '"id":"env-1"');
    expect('env doctor run result', 200, '"status":"done"');
    expect('env doctor unknown run', 404, 'diagnosis not found');
    expect('env doctor cancel a running run', 200, '"ok":true');
    expect('env doctor cancel an unknown run', 200, '"ok":false');
    expect('session doctor starts a run', 200, '"id":"doc-1"');
    expect('session doctor lists runs', 200, '"doc-1"');
    expect('session doctor for an unknown session', 404, 'session not found');
    expect('session doctor for an internal execution slot', 404, 'session not found');
    expect('session doctor OPTIONS for an internal slot', 404, 'session not found');
    expect('doctor run result', 200, '"id":"doc-1"');
    expect('doctor unknown run', 404, 'doctor run not found');
    expect('doctor cancel', 200, '"ok":true');
    expect('doctor cancel an unknown run', 200, '"ok":false');

    // The union measured against the retired Express stack. The four settings
    // paths and the funnel are shared with the host-read GET; task attribution
    // with the task surface's GET.
    const allows = {
      'OPTIONS restart': 'POST',
      'OPTIONS desktop shutdown': 'POST',
      'OPTIONS update status': 'GET,HEAD',
      'OPTIONS developer tools install-git': 'GET,HEAD,POST',
      'OPTIONS disk access': 'GET,HEAD',
      'OPTIONS ops run': 'GET,HEAD,POST',
      'OPTIONS unlock password': 'POST,DELETE',
      'OPTIONS settings power': 'GET,HEAD,POST',
      'OPTIONS settings tunnel': 'GET,HEAD,POST',
      'OPTIONS tunnel funnel': 'GET,HEAD,POST',
      'OPTIONS access token': 'GET,HEAD,POST',
      'OPTIONS task attribution': 'POST,GET,HEAD',
      'OPTIONS session doctor': 'POST,GET,HEAD',
      'OPTIONS env doctor run': 'GET,HEAD',
    };
    for (const [name, allow] of Object.entries(allows)) expect(name, 200, allow);
    for (const [name, allow] of Object.entries(allows)) {
      const view = byName.get(name);
      if (view) {
        for (const side of ['node', 'rust']) {
          if (view[side].headers.allow !== allow) {
            problems.push(`${name}: ${side} Allow ${view[side].headers.allow}, expected ${allow}`);
          }
        }
      }
    }

    // Desensitization canaries, on both sides, before normalization.
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        const text = view[side].body;
        if (text.includes('hunter2')) problems.push(`${view.name}: ${side} leaked the unlock password`);
        if (text.includes('/Users/secret/path') || text.includes('registry mirror unreachable')) {
          problems.push(`${view.name}: ${side} leaked the raw skill-sync failure`);
        }
        if (text.includes('NT-SECRET-AUTHTOKEN')) problems.push(`${view.name}: ${side} leaked a tunnel token`);
      }
    }

    // Neither launcher may run: the fake spawn must be called exactly once per
    // side, and no update log may exist.
    const oracleSpawns = world.state.spawns.map(entry => entry.module);
    if (oracleSpawns.filter(name => name === 'restart').length !== 1) {
      problems.push(`oracle scheduled restart ${oracleSpawns.filter(name => name === 'restart').length} times, expected 1`);
    }
    if (oracleSpawns.filter(name => name === 'update').length !== 1) {
      problems.push(`oracle scheduled update ${oracleSpawns.filter(name => name === 'update').length} times, expected 1`);
    }
    let childSpawns = [];
    try { childSpawns = JSON.parse(fs.readFileSync(path.join(workPath, 'host-ops-spawns.json'), 'utf8')); } catch (_) {}
    for (const name of ['restart', 'update']) {
      const calls = childSpawns.filter(entry => entry.module === name);
      if (calls.length !== 1) problems.push(`the Node child scheduled ${name} ${calls.length} times, expected 1`);
      if (calls[0] && calls[0].file !== '/bin/sh') problems.push(`the Node child ${name} spawn did not use /bin/sh`);
    }
    if (fs.existsSync(path.join(rootDir, 'logs', 'update.log'))) {
      problems.push('an updater wrote logs/update.log — it must never run');
    }

    // Every route must have been exercised at least once.
    const exercised = [
      'restart schedules the detached launcher', 'desktop shutdown is a 404 outside desktop mode',
      'update status before any update', 'update schedules the detached launcher',
      'developer tools status', 'developer tools install when already installed',
      'portable git status before installing', 'portable git install starts a job',
      'disk access target', 'open the full disk access pane', 'agent permissions',
      'open the accessibility pane', 'restart the agent', 'agent install state',
      'replace the other owner agent', 'ops environment probe', 'ops run starts a job',
      'ops run status from the start', 'ops run stop', 'notify settings update',
      'tunnel settings apply a provider', 'restart a known provider',
      'backfill the sakura public url', 'enable funnel', 'access token update',
      'lid mode with the password and authorization', 'save the unlock password',
      'clear the password', 'task attribution update', 'skill sync status',
      'skill sync run', 'env doctor starts a run', 'env doctor run result',
      'env doctor cancel a running run', 'session doctor starts a run',
      'session doctor lists runs', 'doctor run result', 'doctor cancel',
    ];
    const wanted = {
      'desktop shutdown is a 404 outside desktop mode': 404,
      'restart schedules the detached launcher': 202,
      'update schedules the detached launcher': 202,
      'portable git install starts a job': 202,
      'ops run starts a job': 200,
    };
    for (const name of exercised) {
      const view = byName.get(name);
      const status = wanted[name] || 200;
      if (!view || view.node.status !== status) {
        problems.push(`${name}: route was not exercised (node status ${view ? view.node.status : 'missing'})`);
      }
    }

    if (!problems.length) {
      console.log('[host-ops-routes] all 40 routes compared; spawns recorded once per side; canaries hold');
    }
    for (const problem of problems) console.log(`[host-ops-routes] ${problem}`);
    if (problems.length) {
      const file = path.join(workPath, 'coverage-problems.json');
      fs.writeFileSync(file, JSON.stringify(problems, null, 2));
      return { ok: false, details: file };
    }
    return { ok: true, details: path.join(workPath, 'result.json') };
  },
});
