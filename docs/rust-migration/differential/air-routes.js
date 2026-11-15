'use strict';
// Differential run for the fifteen Air task-board routes retired from
// src/workspace/air-routes.js:
//
//   GET|HEAD /api/air
//   POST     /api/air/worktrees/reclaim
//   GET|HEAD /api/air/resolve
//   POST     /api/air/tasks
//   GET|HEAD /api/air/tasks/:id
//   GET|HEAD /api/air/tasks/:id/open
//   POST     /api/air/tasks/:id/delivery/reconcile
//   POST     /api/air/tasks/:id/roles
//   GET|HEAD /api/air/pins              POST /api/air/pins   POST /api/air/pins/toggle
//   GET|HEAD /api/air/todos             POST /api/air/todos  POST /api/air/todos/toggle
//   POST     /api/air/todos/ignore
//
// now answered by native/gateway/src/app/air_routes.rs (rules in
// native/core/src/air_routes.rs).
//
//   node docs/rust-migration/differential/air-routes.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-air-routes.js) over the scripted world in
// tests/helpers/air-scripted-world.js. The Rust front door calls its host port
// (/api/__host/air); the stub Node child mounts the real
// src/workspace/air-routes.js composition over the same world, so both sides
// read one set of facts and the comparison covers the split itself: path
// matching, parameter decoding, the conditional request decision (the ETag is
// computed in Node and forwarded verbatim), the `{ ok, … }` envelopes and
// their key order stay in Rust while the board/records/store facts stay in
// Node.
//
// `registerSync` is deliberately absent from the world: without it both sides
// take the direct `airSnapshot` serialization path (the production liveSync
// wiring is covered by tests/test-air-sync-http.js), and the snapshot body and
// ETag are deterministic.
//
// Side effects are compared too: every semantic call the handlers make on the
// task-shell / admission / hibernation ports is recorded in-process by the
// oracle and in an NDJSON file by the stub, then compared per case in
// finalize(). A route that answers the same bytes but asks Node for the wrong
// thing (or twice) fails.
//
// No documented differences: every corpus case must agree byte for byte. The
// host port being down (503 rust_backend_unavailable) is a front-door-only
// failure surface with no Node-side twin; native/gateway/tests/air_routes.rs
// and docs/gateway.md §9 cover it.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };

let worldPath = '';
let effectsPath = '';
let buildDeps = null;
let legacyBag = null;
let legacy = null;
let upstreamText = '';
// The ETag a case handed back on the Node side, keyed by case, plus each
// case's predecessor. A conditional request must use the SAME validator for
// both sides; reading `capturedEtag` while building would hand the Rust side
// the Node response of its own case (which matches) instead of the previous
// case's tag, turning an expected 200 into a 304.
const capturedEtags = new Map();
const priorByCase = new Map();
let lastCase = null;
const nodeEffects = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function priorEtag(tag) {
  return capturedEtags.get(priorByCase.get(tag)) || 'W/"none"';
}

function ids(tag) {
  return { tk: `tk-${tag}`, tk2: `tk2-${tag}`, dir: `dir-${tag}`, sess: `sess-${tag}`, sh: `sh-${tag}` };
}

function entryFor(id) {
  return {
    ok: true,
    task: { id },
    messages: [{ id: 'm1', role: 'user', content: 'hi' }],
    execution: { busy: false, status: 'idle' },
    readOnly: false,
    sessionId: `s-${id}`,
  };
}

// ── corpus plumbing ─────────────────────────────────────────────────────────

let counter = 0;
const pending = [];

function useScenario(scenario) {
  return {
    before(side) {
      if (side.name === 'node') legacyBag = buildDeps(scenario);
      else fs.writeFileSync(worldPath, JSON.stringify(scenario));
    },
    capture(response, side) {
      if (side.name !== 'node') return;
      nodeEffects.set(scenario.case, clone(legacyBag.effects.calls));
      if (response.headers && response.headers.etag) capturedEtags.set(scenario.case, response.headers.etag);
    },
  };
}

function add(name, buildRequest, buildScenario, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  priorByCase.set(tag, lastCase);
  lastCase = tag;
  const scenario = typeof buildScenario === 'function' ? buildScenario(tag) : { answers: {} };
  scenario.case = tag;
  if (!scenario.answers) scenario.answers = {};
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) hooks[hook] = fn;
  pending.push([name, () => buildRequest(tag), hooks]);
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  const post = (url, body, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const answers = obj => () => ({ answers: obj });

  // ── Express automatic OPTIONS ──────────────────────────────────────────
  add('OPTIONS snapshot', () => options('/api/air'));
  add('OPTIONS pins', () => options('/api/air/pins'));
  add('OPTIONS todos', () => options('/api/air/todos'));
  add('OPTIONS task detail', tag => options(`/api/air/tasks/${ids(tag).tk}`));
  add('OPTIONS roles', tag => options(`/api/air/tasks/${ids(tag).tk}/roles`));

  // ── the snapshot: body, ETag, conditional 304 ──────────────────────────
  add('HEAD snapshot', () => head('/api/air'));
  add('GET snapshot', () => get('/api/air'));
  add('GET snapshot if-none-match star', () => get('/api/air', { ...L, 'If-None-Match': '*' }));
  add('GET snapshot if-none-match weak form', tag => get('/api/air', {
    ...L, 'If-None-Match': priorEtag(tag),
  }));
  add('GET snapshot if-none-match strong form', tag => get('/api/air', {
    ...L, 'If-None-Match': priorEtag(tag).replace(/^W\//, ''),
  }));
  add('GET snapshot if-none-match mismatch', () => get('/api/air', { ...L, 'If-None-Match': 'W/"other"' }));
  add('GET snapshot gzip', () => get('/api/air', { ...L, 'Accept-Encoding': 'gzip, deflate' }));

  // ── task detail ────────────────────────────────────────────────────────
  add('task detail', tag => get(`/api/air/tasks/${ids(tag).tk}`),
    tag => ({ answers: { [`taskEntry:${ids(tag).tk}`]: { value: entryFor(ids(tag).tk) } } }));
  // Same task as the previous case, so the validator handed back there matches
  // and both sides must answer 304 without a body.
  add('task detail conditional', tag => get(`/api/air/tasks/${ids(priorByCase.get(tag)).tk}`,
    { ...L, 'If-None-Match': priorEtag(tag) }),
  tag => ({ answers: { [`taskEntry:${ids(priorByCase.get(tag)).tk}`]: { value: entryFor(ids(priorByCase.get(tag)).tk) } } }));
  add('task detail percent-decoded id', tag => get(`/api/air/tasks/${ids(tag).tk}%2Fsub`),
    tag => ({ answers: { [`taskEntry:${ids(tag).tk}/sub`]: { value: entryFor(`${ids(tag).tk}/sub`) } } }));
  add('task detail refusal', tag => get(`/api/air/tasks/${ids(tag).tk}`),
    tag => ({ answers: { [`taskEntry:${ids(tag).tk}`]: { throw: { code: 'task_not_found', message: 'task not found', status: 404 } } } }));
  add('malformed percent escape', tag => get(`/api/air/tasks/%E0%A4%A`));

  // ── task open / reconcile / roles ──────────────────────────────────────
  add('task open with a chat record', tag => get(`/api/air/tasks/${ids(tag).tk}/open`),
    tag => ({ answers: {
      [`taskEntry:${ids(tag).tk}`]: { value: entryFor(ids(tag).tk) },
      [`roleBindings:${ids(tag).tk}`]: { value: [{ roleId: 'reviewer', memberId: 'm1' }] },
    } }));
  add('task open readOnly follows the source record', tag => get(`/api/air/tasks/${ids(tag).tk}/open`),
    tag => ({ answers: {
      [`taskEntry:${ids(tag).tk}`]: { value: { ...entryFor(ids(tag).tk), readOnly: true, sourceSessionId: 's-tk-a' } },
      [`roleBindings:${ids(tag).tk}`]: { value: null },
    } }));
  add('task open refusal', tag => get(`/api/air/tasks/${ids(tag).tk}/open`),
    tag => ({ answers: { [`taskEntry:${ids(tag).tk}`]: { throw: { code: 'task_not_found', message: 'gone', status: 404 } } } }));
  add('delivery reconcile', tag => post(`/api/air/tasks/${ids(tag).tk}/delivery/reconcile`, {}),
    tag => ({ answers: {
      [`taskEntry:${ids(tag).tk}`]: { value: entryFor(ids(tag).tk) },
      [`recoverEvidence:s-${ids(tag).tk}`]: { value: [{ artifactId: 'report', state: 'published' }] },
    } }));
  add('roles forwards the body', tag => post(`/api/air/tasks/${ids(tag).tk}/roles`, { roleId: 'reviewer', memberId: 'm2' }),
    tag => ({ answers: { [`roleBindings:${ids(tag).tk}`]: { value: [{ roleId: 'reviewer', memberId: 'm2' }] } } }));
  add('roles refusal', tag => post(`/api/air/tasks/${ids(tag).tk}/roles`, { roleId: 'nope' }),
    tag => ({ answers: { [`roleBindings:${ids(tag).tk}`]: { throw: { code: 'role_unknown', message: 'unknown role', status: 409 } } } }));

  // ── create a task ──────────────────────────────────────────────────────
  add('create task', () => post('/api/air/tasks', { title: 'New', sessionId: 's1' }),
    () => ({ answers: { createTask: { value: { ok: true, task: { id: 'tk-new' }, sessionId: 's-tk-a' } } } }));
  add('create task with a failing admission identify', () => post('/api/air/tasks', { title: 'New' }),
    () => ({
      identifyThrow: { code: 'workspace_directory_missing', message: 'directory missing', status: 409 },
      answers: { createTask: { value: { ok: true, task: { id: 'tk-new' }, sessionId: 's-gone' } } },
    }));
  add('create task refusal without a status', () => post('/api/air/tasks', {}),
    () => ({ answers: { createTask: { throw: { code: 'create_failed', message: 'nope' } } } }));

  // ── worktree reclaim ───────────────────────────────────────────────────
  add('reclaim everything', tag => post('/api/air/worktrees/reclaim', {}),
    () => ({ answers: { reclaim: { value: { ok: true, considered: 3, hibernated: 2 } } } }));
  add('reclaim one directory with force', tag => post('/api/air/worktrees/reclaim',
    { dirId: ids(tag).dir, force: true }),
  tag => ({
    directories: { [ids(tag).dir]: { id: ids(tag).dir, name: 'D', path: '/tmp/d' } },
    answers: { reclaim: { value: { ok: true, considered: 1, hibernated: 1 } } },
  }));
  add('reclaim reports ok false', () => post('/api/air/worktrees/reclaim', {}),
    () => ({ answers: { reclaim: { value: { ok: false, considered: 1, hibernated: 0, reason: 'busy' } } } }));
  add('reclaim without hibernation', () => post('/api/air/worktrees/reclaim', {}),
    () => ({ hibernation: false }));
  add('reclaim an unknown directory', () => post('/api/air/worktrees/reclaim', { dirId: 'dir-missing' }));
  add('reclaim refusal', () => post('/api/air/worktrees/reclaim', {}),
    () => ({ answers: { reclaim: { throw: { code: 'reclaim_failed', message: 'sweep failed', status: 500 } } } }));
  add('reclaim with a numeric dirId', () => post('/api/air/worktrees/reclaim', { dirId: 7, force: 'true' }),
    () => ({ answers: { reclaim: { value: { ok: true } } } }));
  add('reclaim with an empty dirId', () => post('/api/air/worktrees/reclaim', { dirId: '' }),
    () => ({ answers: { reclaim: { value: { ok: true } } } }));

  // ── resolve ────────────────────────────────────────────────────────────
  add('resolve by task', tag => get(`/api/air/resolve?task=${ids(tag).tk}`),
    tag => ({ answers: {
      [`taskEntry:${ids(tag).tk}`]: { value: { ...entryFor(ids(tag).tk), sessionId: 's-tk-a' } },
      resolve: { value: { taskId: ids(tag).tk, dirId: 'dir-1' } },
    } }));
  add('resolve by session', tag => get(`/api/air/resolve?session=${ids(tag).sess}`),
    tag => ({ answers: {
      [`stateTarget:${ids(tag).sess}`]: { value: { taskId: ids(tag).tk } },
      [`taskEntry:${ids(tag).tk}`]: { value: { ...entryFor(ids(tag).tk), sessionId: 's-tk-b' } },
      resolve: { value: { taskId: ids(tag).tk, dirId: 'dir-1' } },
    } }));
  add('resolve by shell', tag => get(`/api/air/resolve?shell=${ids(tag).sh}`),
    tag => ({ answers: {
      [`chatScope:${ids(tag).sh}`]: { value: { taskId: ids(tag).tk } },
      [`taskEntry:${ids(tag).tk}`]: { value: { ...entryFor(ids(tag).tk), sessionId: 's-tk-b' } },
      resolve: { value: { taskId: ids(tag).tk, dirId: 'dir-1' } },
    } }));
  add('resolve with nothing', () => get('/api/air/resolve'), () => ({ answers: { resolve: { value: { taskId: null, dirId: null } } } }));
  add('resolve with an empty task param', () => get('/api/air/resolve?task='),
    () => ({ answers: { resolve: { value: { taskId: null, dirId: null } } } }));
  // A repeated `task` reaches the handler as qs' array; the lookup is the same
  // single call with that array, and the redirect keeps the first identity the
  // entry names. Both sides must ask the port once and answer identically.
  add('resolve a repeated task param', () => get('/api/air/resolve?task=a&task=b'),
    () => ({ answers: { 'taskEntry:a,b': { value: { ...entryFor('a,b'), sessionId: 's-tk-a' } } } }));
  add('resolve with a directory-less entry', tag => get(`/api/air/resolve?task=${ids(tag).tk}`),
    tag => ({ answers: {
      [`taskEntry:${ids(tag).tk}`]: { value: { ...entryFor(ids(tag).tk), sessionId: 's-no-record' } },
    } }));
  add('resolve with a session that names no task', tag => get(`/api/air/resolve?session=${ids(tag).sess}`),
    tag => ({ answers: {
      [`stateTarget:${ids(tag).sess}`]: { value: { taskId: null } },
      [`artifactTaskId:${ids(tag).sess}`]: { value: null },
      resolve: { value: { taskId: null, dirId: null } },
    } }));

  // ── pins ───────────────────────────────────────────────────────────────
  // The pin/todo runtimes prune ids against the visible board (tk-a, tk-b), so
  // the corpus uses those ids and keeps one unknown id to compare pruning.
  add('pins read on a fresh store', () => get('/api/air/pins'));
  add('pins replace', () => post('/api/air/pins', { taskIds: ['tk-a'] }));
  add('pins read after replace', () => get('/api/air/pins'));
  add('pins replace prunes unknown ids', () => post('/api/air/pins', { taskIds: ['tk-a', 'tk-gone'] }));
  add('pins toggle on', () => post('/api/air/pins/toggle', { taskId: 'tk-b' }));
  add('pins read after toggle', () => get('/api/air/pins'));
  add('pins toggle off', () => post('/api/air/pins/toggle', { taskId: 'tk-b' }));
  add('pins replace rejects a non-array', () => post('/api/air/pins', { taskIds: 'tk-a' }));
  add('pins replace rejects a missing field', () => post('/api/air/pins', {}));
  add('pins toggle rejects a non-string id', () => post('/api/air/pins/toggle', { taskId: 12 }));
  add('pins toggle an unknown task', () => post('/api/air/pins/toggle', { taskId: 'tk-gone' }));

  // ── todos ──────────────────────────────────────────────────────────────
  add('todos read on a fresh store', () => get('/api/air/todos'));
  add('todos replace', () => post('/api/air/todos', { taskIds: ['tk-b'] }));
  add('todos read after replace', () => get('/api/air/todos'));
  add('todos toggle', () => post('/api/air/todos/toggle', { taskId: 'tk-a' }));
  add('todos replace rejects a non-array', () => post('/api/air/todos', { taskIds: null }));
  add('todos toggle rejects a non-string id', () => post('/api/air/todos/toggle', { taskId: null }));
  add('todo ignore on an unknown task', () => post('/api/air/todos/ignore', { taskId: 'nope' }));
  add('todo ignore without a task id', () => post('/api/air/todos/ignore', {}));
  add('todo ignore on a task without a problem', () => post('/api/air/todos/ignore', { taskId: 'tk-a' }));

  return pending;
}

// ── the stub Node child: the real host composition over the world ──────────

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

const express = require(require.resolve('express', { paths: [REPO] }));
const world = require(path.join(REPO, 'tests/helpers/air-scripted-world'));
const { mountAirRoutes } = require(path.join(REPO, 'src/workspace/air-routes'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return { case: null, answers: {} }; }
}

const app = express();
app.use(express.json({ limit: '50mb' }));
let active = world.buildDeps({ case: null, answers: {} });
app.post('/api/__host/air', (req, res, next) => {
  const session = world.buildDeps(readWorld());
  active = session;
  res.on('finish', () => {
    if (!session.effects.calls.length) return;
    fs.appendFileSync(effectsPath,
      JSON.stringify({ case: session.scenario.case || null, calls: session.effects.calls }) + '\\n');
  });
  next();
});
mountAirRoutes(app, world.bindDeps(() => active));

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

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'air-routes',
  mount(app, { repo, work }) {
    // A missed pins/todos dependency would otherwise fall back to the data
    // root (the checkout itself) and leak test ids into the real files.
    process.env.MULTICC_DATA_DIR = work;
    worldPath = path.join(work, 'air-world.json');
    effectsPath = path.join(work, 'air-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify({ case: 'initial', answers: {} }));
    const helper = require(path.join(repo, 'tests/helpers/air-scripted-world'));
    buildDeps = helper.buildDeps;
    legacyBag = buildDeps({ case: 'initial', answers: {} });
    legacy = require(path.join(repo, 'tests/helpers/legacy-air-routes'));
    legacy.mountAirRoutes(app, helper.bindDeps(() => legacyBag));
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: work,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
  }),
  corpus,
  finalize({ work, views }) {
    // Byte-identical is not enough on its own: if the scripted deps failed to
    // resolve, both sides could 500 with the same envelope for every case and
    // still "match". Pin the responses that prove the handlers really ran,
    // including the conditional reads.
    const byName = new Map(views.map(view => [view.name, view]));
    const problems = [];
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        if (view[side].status === 500 && view[side].body.includes('"code":"air_request_failed"')) {
          problems.push(`${view.name}: ${side} hit the generic 500 (${view[side].body})`);
        }
      }
    }
    for (const name of ['GET snapshot', 'task detail', 'pins read after replace', 'todos read after replace']) {
      const view = byName.get(name);
      if (!view || view.node.status !== 200) problems.push(`${name}: expected a 200 body`);
    }
    for (const name of ['GET snapshot if-none-match weak form',
      'GET snapshot if-none-match strong form', 'task detail conditional']) {
      const view = byName.get(name);
      if (!view || view.node.status !== 304 || view.rust.status !== 304) {
        problems.push(`${name}: expected 304 on both sides`);
      }
    }
    const rustEffects = new Map();
    const text = fs.readFileSync(effectsPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!entry.case) continue;
      if (!rustEffects.has(entry.case)) rustEffects.set(entry.case, []);
      rustEffects.get(entry.case).push(...entry.calls);
    }
    const mismatches = [];
    for (const [tag, calls] of nodeEffects) {
      const rust = rustEffects.get(tag) || [];
      if (JSON.stringify(calls) !== JSON.stringify(rust)) mismatches.push({ tag, node: calls, rust });
    }
    const details = path.join(work, 'effect-mismatches.json');
    fs.writeFileSync(details, JSON.stringify(mismatches, null, 2));
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
    }
    if (problems.length) {
      for (const problem of problems) console.log(`[air-routes] ${problem}`);
      const problemFile = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(problemFile, JSON.stringify(problems, null, 2));
      return { ok: false, details: problemFile };
    }
    if (mismatches.length) {
      console.log(`[air-routes] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[air-routes] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
