'use strict';
// Differential run for the sixteen task-surface routes retired from
// src/routes/task-board.js, src/routes/task-search.js, src/routes/task-goal.js,
// src/routes/task-graph.js and src/task-shell/attribution-settings.js:
//
//   POST     /api/task-board/tasks
//   POST     /api/task-board/tasks/:taskId/update
//   POST     /api/task-board/tasks/:taskId/planning      (update alias)
//   POST     /api/task-board/tasks/:taskId/title
//   POST     /api/task-board/tasks/:taskId/move
//   GET|HEAD /api/task-board/directories/:dirId/retention
//   POST     /api/task-board/directories/:dirId/retention
//   POST     /api/task-board/tasks/:taskId/status
//   DELETE   /api/task-board/tasks/:taskId
//   POST     /api/task-board/tasks/:taskId/relocate
//   POST     /api/task-board/tasks/:taskId/chat-session
//   GET|HEAD /api/task-board/search
//   GET|HEAD /api/search/messages
//   POST     /api/air/tasks/mark-achieved
//   GET|HEAD /api/task-graph
//   GET|HEAD /api/settings/task-attribution
//
// now answered by native/gateway/src/app/task_routes.rs (rules in
// native/core/src/task_routes.rs).
//
//   node docs/rust-migration/differential/task-routes.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-task-routes.js) over the scripted world in
// tests/helpers/task-routes-scripted-world.js. The Rust front door calls its
// host port (/api/__host/task-routes); the stub Node child mounts the real
// src/routes/task-routes-host.js composition over the same world, so both sides
// read one set of facts and the comparison covers the split itself: path
// matching, parameter decoding, the query/body validation ladders, the
// planning error→status ladder, the `{ ok, … }` envelopes and their key order,
// the retention re-sort and the mark-achieved eligibility ladder stay in Rust
// while the board/store writes, locks, session binding, message index, graph
// aggregation and the live attribution tier stay in Node.
//
// Side effects are compared too: every semantic call the handlers make on the
// board store, session queue, retention/purge, session binding, message index
// and graph ports is recorded in-process by the oracle and in an NDJSON file
// by the stub, then compared per case in finalize(). A route that answers the
// same bytes but asks Node for the wrong thing (or twice) fails.
//
// OPTIONS on /api/air/tasks/mark-achieved is a shared path: `server.js` mounts
// this cluster's literal POST before Air's `GET /api/air/tasks/:id`, so the
// whole-app Allow is `POST,GET,HEAD`. The oracle mounts Air's GET beside this
// cluster (as the real server does) and the front door unions the two clusters
// (native/gateway/src/app/mod.rs `OPTIONS_SOURCES`), so the case is compared
// byte for byte like every other one.
//
// Normalization: a created task gets a random `tsk-plan-…` id and every write
// stamps `Date.now()`; task-graph stamps `meta.durationMs` with wall time. Both
// sides are normalized on exactly those values (never on structure, key order
// or any other field), and finalize() asserts the ids/timestamps are present.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
// Both sides stamp task writes with Date.now(); the two processes are the only
// clock either side has, so the run freezes it to one value. Otherwise every
// write in the corpus would differ by the milliseconds between the Node
// handler and the host call, and so would the ETag computed over it.
const FROZEN_NOW = 1794687600000;

let worldPath = '';
let effectsPath = '';
let buildDeps = null;
let legacyBag = null;
let currentHandler = null;
let setLegacyHandler = null;
let upstreamText = '';
const nodeEffects = new Map();
const responses = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── corpus plumbing ─────────────────────────────────────────────────────────

const pending = [];

function useScenario(scenario) {
  return {
    before(side) {
      if (side.name === 'node') {
        legacyBag = buildDeps(scenario);
        setLegacyHandler(legacyBag);
      } else {
        fs.writeFileSync(worldPath, JSON.stringify(scenario));
      }
    },
    capture(response, side) {
      if (side.name === 'rust') return;
      nodeEffects.set(scenario.case, clone(legacyBag.effects.calls));
      responses.set(scenario.case, response);
    },
  };
}

let counter = 0;

function add(name, buildRequest, buildScenario, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  const scenario = typeof buildScenario === 'function'
    ? buildScenario(tag) : (buildScenario || { answers: {} });
  scenario.case = tag;
  if (!scenario.answers) scenario.answers = {};
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) hooks[hook] = fn;
  pending.push([name, buildRequest, hooks]);
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  // Node's http client drops the body of a DELETE unless Content-Length is
  // set; the stray bytes then parse as a second request and the server answers
  // a bare 400. Real clients frame the body, so the corpus does too.
  // The ETag is computed over the raw body, so a response the harness has to
  // normalize cannot carry a comparable validator: a created task's random
  // `tsk-plan-…` id and the graph's measured `meta.durationMs`. The bodies are
  // still compared byte for byte after normalization, and the status,
  // content-type and content-length stay in the comparison.
  const dropEtag = view => { delete view.headers.etag; return view; };
  const del = (url, body, headers = L) => {
    const payload = JSON.stringify(body === undefined ? {} : body);
    return {
      method: 'DELETE', url,
      headers: { ...headers, 'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)) },
      body: payload,
    };
  };
  const post = (url, body, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const answers = obj => () => ({ answers: obj });

  // ── Express automatic OPTIONS ──────────────────────────────────────────
  add('OPTIONS tasks', () => options('/api/task-board/tasks'));
  add('OPTIONS task id', () => options('/api/task-board/tasks/tk-1'));
  add('OPTIONS retention', () => options('/api/task-board/directories/dir-1/retention'));
  add('OPTIONS board search', () => options('/api/task-board/search'));
  add('OPTIONS message search', () => options('/api/search/messages'));
  add('OPTIONS task graph', () => options('/api/task-graph'));
  add('OPTIONS attribution', () => options('/api/settings/task-attribution'));

  // ── create ─────────────────────────────────────────────────────────────
  add('create planned task', () => post('/api/task-board/tasks',
    { title: 'New task', dirId: 'dir-1' }), null, { normalize: dropEtag });
  add('create with full fields', () => post('/api/task-board/tasks', {
    title: 'Full', description: 'body', dirId: 'dir-1', priority: 'high',
    dueAt: '2026-02-01T00:00:00.000Z', acceptanceCriteria: 'done',
  }), null, { normalize: dropEtag });
  add('create from a source task', () => post('/api/task-board/tasks',
    { sourceTaskId: 'tk-1', title: 'Copy' }), null, { normalize: dropEtag });
  add('create from a missing source', () => post('/api/task-board/tasks',
    { sourceTaskId: 'tk-gone', title: 'Copy' }));
  add('create from an archived source', () => post('/api/task-board/tasks',
    { sourceTaskId: 'tk-3', title: 'Copy' }), null, { normalize: dropEtag });
  add('create into an unknown directory', () => post('/api/task-board/tasks',
    { title: 'New', dirId: 'dir-missing' }));
  add('create without a title', () => post('/api/task-board/tasks', { dirId: 'dir-1' }));
  add('create from a source in another directory', () => post('/api/task-board/tasks',
    { sourceTaskId: 'tk-9' }), null, { normalize: dropEtag });

  // ── update / alias / rename / move ─────────────────────────────────────
  add('update title', () => post('/api/task-board/tasks/tk-1/update',
    { title: 'Changed', revision: 1 }));
  add('update an unknown task', () => post('/api/task-board/tasks/tk-gone/update', { title: 'X' }));
  add('update into an unknown directory', () => post('/api/task-board/tasks/tk-1/update',
    { dirId: 'dir-missing' }));
  add('update with a stale revision', () => post('/api/task-board/tasks/tk-1/update',
    { title: 'X', revision: 99 }));
  add('update to done while the session queue is busy', () => post(
    '/api/task-board/tasks/tk-1/update', { workflowStage: 'done' },
  ), () => ({ answers: {
    'resolveSessionQueue:s-done': { value: { ok: false, code: 'workspace_busy' } },
  } }));
  add('update with an invalid stage', () => post('/api/task-board/tasks/tk-1/update',
    { workflowStage: 'nowhere' }));
  add('planning alias', () => post('/api/task-board/tasks/tk-1/planning',
    { title: 'Alias', revision: 1 }));
  add('rename', () => post('/api/task-board/tasks/tk-1/title', { title: 'Renamed' }));
  add('rename an unknown task', () => post('/api/task-board/tasks/tk-gone/title', { title: 'X' }));
  add('rename to an empty title', () => post('/api/task-board/tasks/tk-1/title', { title: '  ' }));
  add('move to done', () => post('/api/task-board/tasks/tk-1/move',
    { workflowStage: 'done', revision: 1 }));
  add('move with an unknown anchor', () => post('/api/task-board/tasks/tk-1/move',
    { workflowStage: 'inbox', anchorTaskId: 'tk-gone' }));
  add('move an unknown task', () => post('/api/task-board/tasks/tk-gone/move',
    { workflowStage: 'done' }));

  // ── retention ──────────────────────────────────────────────────────────
  add('retention preview', () => get('/api/task-board/directories/dir-1/retention'));
  add('retention preview of an unknown directory', () => get(
    '/api/task-board/directories/dir-missing/retention'));
  add('retention delete one', () => post('/api/task-board/directories/dir-1/retention',
    { taskIds: ['tk-2'] }));
  add('retention delete an empty selection', () => post(
    '/api/task-board/directories/dir-1/retention', { taskIds: [] }));
  add('retention delete skips an unsafe candidate', () => post(
    '/api/task-board/directories/dir-1/retention', { taskIds: ['tk-2', 'tk-3'] },
  ), () => ({ answers: {
    'prepareDelete:tk-3': { throw: { code: 'git_dirty', message: 'dirty' } },
  } }));

  // ── status ─────────────────────────────────────────────────────────────
  add('status done', () => post('/api/task-board/tasks/tk-1/status', { status: 'done' }));
  add('status archived', () => post('/api/task-board/tasks/tk-1/status', { status: 'archived' }));
  add('status restore', () => post('/api/task-board/tasks/tk-3/status', { status: 'active' }));
  add('status invalid', () => post('/api/task-board/tasks/tk-1/status', { status: 'bogus' }));
  add('status of an unknown task', () => post('/api/task-board/tasks/tk-gone/status',
    { status: 'done' }));
  add('status done with a busy legacy queue', () => post(
    '/api/task-board/tasks/tk-1/status', { status: 'done' },
  ), () => ({ answers: {
    'resolveSessionQueue:s-done': { value: { ok: false, code: 'workspace_busy' } },
  } }));
  add('status with a stale revision', () => post('/api/task-board/tasks/tk-1/status',
    { status: 'done', revision: 99 }));

  // ── delete ─────────────────────────────────────────────────────────────
  add('delete a task', () => del('/api/task-board/tasks/tk-1'));
  add('delete an unknown task', () => del('/api/task-board/tasks/tk-gone'));
  add('delete a busy task', () => del('/api/task-board/tasks/tk-1'),
    () => ({ answers: {
      'assertIdle:tk-1': { throw: { code: 'task_busy', message: 'busy' } },
    } }));

  // ── relocate ───────────────────────────────────────────────────────────
  add('relocate a task', () => post('/api/task-board/tasks/tk-1/relocate', { dirId: 'dir-2' }));
  add('relocate to the current directory', () => post('/api/task-board/tasks/tk-9/relocate',
    { dirId: 'dir-2' }));
  add('relocate without a dirId', () => post('/api/task-board/tasks/tk-1/relocate', {}));
  add('relocate into an unknown directory', () => post('/api/task-board/tasks/tk-1/relocate',
    { dirId: 'dir-missing' }));
  add('relocate an archived task', () => post('/api/task-board/tasks/tk-3/relocate',
    { dirId: 'dir-2' }));

  // ── chat session ───────────────────────────────────────────────────────
  add('chat session creates a binding', () => post('/api/task-board/tasks/tk-1/chat-session', {}));
  add('chat session reuses the binding', () => post('/api/task-board/tasks/tk-2/chat-session', {}));
  add('chat session of an unknown task', () => post(
    '/api/task-board/tasks/tk-gone/chat-session', {}));
  add('chat session of a read-only shell task', () => post(
    '/api/task-board/tasks/tk-1/chat-session', {},
  ), () => ({ answers: {
    'taskEntry:tk-1': { value: { ok: true, task: { id: 'tk-1' }, readOnly: true } },
  } }));

  // ── board search ───────────────────────────────────────────────────────
  add('board search', () => get('/api/task-board/search?q=Task'));
  add('board search empty query', () => get('/api/task-board/search?q='));
  add('board search too long', () => get(`/api/task-board/search?q=${'x'.repeat(201)}`));
  add('board search with filters', () => get(
    '/api/task-board/search?q=Task&limit=5&dirId=dir-1&statuses=active,done&minScore=0.5'));
  add('board search repeated params', () => get('/api/task-board/search?q=a&q=b'));
  add('HEAD board search', () => head('/api/task-board/search?q=Task'));

  // ── message search ─────────────────────────────────────────────────────
  add('message search without a runtime', () => get('/api/search/messages?q=hi'),
    () => ({ messagesRuntime: false }));
  add('message search empty query', () => get('/api/search/messages?q='));
  add('message search warming', () => get('/api/search/messages?q=hi'),
    () => ({ warming: true, answers: { findMessages: { value: [] } } }));
  add('message search', () => get('/api/search/messages?q=hi'), () => ({
    answers: { findMessages: { value: [{
      sessionId: 's-done', messageId: 'm-1', kind: 'user',
      updatedAt: '2026-01-03T00:00:00.000Z', score: 1.5,
      snippet: { text: 'hi there', ranges: [] },
    }] } },
  }));
  add('message search too long', () => get(`/api/search/messages?q=${'x'.repeat(201)}`));
  add('message search with a too long directory filter', () => get(
    `/api/search/messages?q=hi&dirId=${'d'.repeat(201)}`));
  add('message search index failure', () => get('/api/search/messages?q=hi'),
    () => ({ answers: { findMessages: { throw: { code: 'search_failed', message: 'boom' } } } }));

  // ── mark achieved ──────────────────────────────────────────────────────
  add('mark achieved', () => post('/api/air/tasks/mark-achieved', { taskId: 'tk-D' }));
  add('mark achieved without a task id', () => post('/api/air/tasks/mark-achieved', {}));
  add('mark achieved on an unknown task', () => post('/api/air/tasks/mark-achieved',
    { taskId: 'tk-gone' }));
  add('mark achieved on an already achieved task', () => post('/api/air/tasks/mark-achieved',
    { taskId: 'tk-A' }));
  add('mark achieved on a streaming task', () => post('/api/air/tasks/mark-achieved',
    { taskId: 'tk-S' }));
  add('mark achieved through the legacy attribution path', () => post(
    '/api/air/tasks/mark-achieved', { taskId: 'tk-2' }));

  // ── task graph ─────────────────────────────────────────────────────────
  add('task graph', () => get('/api/task-graph'), null, { normalize: dropEtag });
  add('task graph filtered', () => get('/api/task-graph?dirId=dir-2'), null, { normalize: dropEtag });
  add('task graph empty filter means all', () => get('/api/task-graph?dirId='), null, { normalize: dropEtag });
  add('task graph build failure', () => get('/api/task-graph'),
    () => ({ graphThrows: 'boom' }));
  add('HEAD task graph', () => head('/api/task-graph'), null, { normalize: dropEtag });

  // ── attribution ────────────────────────────────────────────────────────
  add('attribution read', () => get('/api/settings/task-attribution'));
  add('HEAD attribution', () => head('/api/settings/task-attribution'));

  return pending;
}

// ── the shared Air path ────────────────────────────────────────────────────

const MARK_ACHIEVED_OPTIONS = (() => {
  const scenario = { case: 'mark-achieved-options', answers: {} };
  const hooks = useScenario(scenario);
  pending.push(['OPTIONS mark achieved unions task-routes and Air',
    () => ({ method: 'OPTIONS', url: '/api/air/tasks/mark-achieved', headers: L }), hooks]);
})();

// ── the stub Node child: the real host-port composition over the world ─────

function upstreamSource(repo) {
  return `'use strict';
// Same frozen clock as the oracle side: task writes must agree byte for byte.
Date.now = () => ${FROZEN_NOW};
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
const world = require(path.join(REPO, 'tests/helpers/task-routes-scripted-world'));
const { mountTaskRoutesHostRoute } = require(path.join(REPO, 'src/routes/task-routes-host'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return { case: null, answers: {} }; }
}

// One world per case, like one server process: the two host operations a
// message search makes (scope, then search) must reach the same memoized
// search runtime, and the board file must keep the case's own state.
const bags = new Map();
const reported = new Map();
function bagFor(scenario) {
  const key = String(scenario.case || '');
  let bag = bags.get(key);
  if (!bag) { bag = world.buildDeps(scenario); bags.set(key, bag); }
  return bag;
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.post('/api/__host/task-routes', (req, res, next) => {
  const scenario = readWorld();
  const key = String(scenario.case || '');
  const bag = bagFor(scenario);
  res.on('finish', () => {
    const calls = bag.effects.calls;
    const from = reported.get(key) || 0;
    const fresh = calls.slice(from);
    reported.set(key, calls.length);
    if (!fresh.length) return;
    fs.appendFileSync(effectsPath,
      JSON.stringify({ case: bag.scenario.case || null, calls: fresh }) + '\\n');
  });
  const inner = express();
  mountTaskRoutesHostRoute(inner, world.currentHostOptions(bag));
  return inner(req, res, next);
});
app.use((_req, res) => res.status(404).end('forwarded'));

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

// ── response normalization ─────────────────────────────────────────────────

// Only the values that cannot agree by construction: a generated task id, the
// wall-clock stamps two processes take, and the graph's measured duration.
function normalize(text) {
  return text
    .replace(/tsk-plan-[0-9a-f]{32}/g, 'tsk-plan-<uuid>')
    .replace(/"((?:createdAt|updatedAt|goalStateManualAt))":1[6-9]\d{11}/g, '"$1":<ms>')
    .replace(/("durationMs":)\d+/g, '$1<ms>');
}

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'task-routes',
  mount(app, { repo, work }) {
    // A missed board dependency would otherwise fall back to the data root
    // (the checkout itself) and leak test ids into the real files.
    process.env.MULTICC_DATA_DIR = work;
    // The Node side stamps writes in this process; the stub child gets the
    // same value (below), so the two sides see one clock.
    Date.now = () => FROZEN_NOW;
    worldPath = path.join(work, 'task-world.json');
    effectsPath = path.join(work, 'task-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify({ case: 'initial', answers: {} }));
    const helper = require(path.join(repo, 'tests/helpers/task-routes-scripted-world'));
    buildDeps = helper.buildDeps;
    const express = require(require.resolve('express', { paths: [repo] }));
    setLegacyHandler = (bag) => {
      const inner = express();
      inner.use(express.json({ limit: '50mb' }));
      // The real server registers host-write's POST on this path before the task
      // surface's GET, so the whole-app Allow is `POST,GET,HEAD` (the host-ops
      // cluster owns that POST now; native/gateway/src/app/mod.rs unions them).
      inner.post('/api/settings/task-attribution', (_req, res) => res.json({}));
      helper.mountLegacy(inner, bag);
      // The real server also answers GET on this shape (Air). Mounting it here
      // makes the oracle's automatic OPTIONS union match the front door's.
      inner.get('/api/air/tasks/:id', (_req, res) => res.json({}));
      currentHandler = inner;
    };
    app.use((req, res, next) => (currentHandler ? currentHandler(req, res, next) : next()));
    legacyBag = buildDeps({ case: 'initial', answers: {} });
    setLegacyHandler(legacyBag);
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
  normalize,
  corpus,
  finalize({ work, views }) {
    // Byte-identical is not enough on its own: if the scripted world failed to
    // resolve, both sides could 500 with the same envelope for every case and
    // still "match". Pin the answers that prove each route really ran, and
    // check that the routes are all exercised.
    const byName = new Map(views.map(view => [view.name, view]));
    const problems = [];
    const expect = (name, status, needle) => {
      const view = byName.get(name);
      if (!view) { problems.push(`${name}: missing from the corpus`); return; }
      for (const side of ['node', 'rust']) {
        if (view[side].status !== status) {
          problems.push(`${name}: ${side} answered ${view[side].status}, expected ${status}`);
        }
        if (needle && !view[side].body.includes(needle)) {
          problems.push(`${name}: ${side} body lacks ${needle} (${view[side].body})`);
        }
      }
    };
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        if (view[side].status === 500 && view[side].body.includes('"error":"internal_error"')) {
          problems.push(`${view.name}: ${side} hit the generic 500 (${view[side].body})`);
        }
      }
    }
    expect('create planned task', 200, '"ok":true');
    expect('update title', 200, '"ok":true');
    expect('rename', 200, '"ok":true');
    expect('move to done', 200, '"ok":true');
    expect('retention preview', 200, '"maxBatch":100');
    expect('retention delete one', 200, '"deleted":["tk-2"]');
    expect('status done', 200, '"releasedSession":false');
    expect('delete a task', 200, '"deleted":true');
    expect('relocate a task', 200, '"dirId":"dir-2"');
    expect('chat session creates a binding', 200, '"ok":true');
    expect('board search', 200, '"ok":true');
    expect('message search', 200, '"mode":"message"');
    expect('mark achieved', 200, '"goalState":"achieved"');
    expect('task graph', 200, '"maxNodes":800');
    expect('attribution read', 200, '"modes":["off","shadow","suggest","auto"]');
    expect('HEAD attribution', 200, '');
    expect('status invalid', 400, '"error":"invalid_status"');
    expect('message search without a runtime', 503, 'message_search_unavailable');
    expect('task graph build failure', 500, '"error":"task graph build failed');
    expect('OPTIONS retention', 200, '');

    // Every route group must have produced a 2xx at least once; a corpus that
    // stopped exercising a route would otherwise silently shrink.
    const exercised = {
      'create planned task': true,
      'update title': true,
      'planning alias': true,
      rename: true,
      'move to done': true,
      'retention preview': true,
      'retention delete one': true,
      'status done': true,
      'delete a task': true,
      'relocate a task': true,
      'chat session creates a binding': true,
      'board search': true,
      'message search': true,
      'mark achieved': true,
      'task graph': true,
      'attribution read': true,
    };
    for (const [name, _flag] of Object.entries(exercised)) {
      const view = byName.get(name);
      if (!view || view.node.status < 200 || view.node.status >= 300) {
        problems.push(`${name}: route was not exercised (node status ${view ? view.node.status : 'missing'})`);
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
      for (const problem of problems) console.log(`[task-routes] ${problem}`);
      const problemFile = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(problemFile, JSON.stringify(problems, null, 2));
      return { ok: false, details: problemFile };
    }
    if (mismatches.length) {
      console.log(`[task-routes] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[task-routes] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
