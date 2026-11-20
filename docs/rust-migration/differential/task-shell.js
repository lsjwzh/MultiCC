'use strict';
// Differential run for the forty-two task-shell routes retired from
// src/task-shell/routes.js:
//
//   GET    /api/task-shell-tasks/:taskId
//   GET    /api/task-shell-tasks/:taskId/history
//   GET    /api/task-shell-tasks/:taskId/artifacts
//   GET    /api/task-shells/:shellId/artifacts
//   POST   /api/task-shell-tasks/:taskId/fork
//   POST   /api/task-shell-tasks/:taskId/messages
//   GET    /api/task-shells/config
//   GET    /api/sessions/:sessionId/context
//   GET    /api/sessions/:sessionId/task-separation
//   POST   /api/sessions/:sessionId/task-separation/:suggestionId
//   POST   /api/task-shells
//   GET    /api/task-shells/:shellId
//   GET    /api/task-shells/:shellId/chat
//   GET    /api/task-shells/:shellId/history
//   GET    /api/task-shells/:shellId/task-index
//   GET    /api/task-shells/:shellId/task-operations
//   POST   /api/task-shells/:shellId/task-operations/preview
//   POST   /api/task-shells/:shellId/task-operations
//   GET    /api/task-operations/:operationId
//   POST   /api/task-operations/:operationId/cancel
//   POST   /api/task-operations/:operationId/undo
//   GET    /api/task-shells/:shellId/attribution-decisions
//   POST   /api/task-shells/:shellId/attribution-decisions/:decisionId/{accept,dismiss,defer,undo}
//   POST   /api/task-shells/:shellId/tasks/:taskId/independent-continue
//   GET    /api/task-shells/:shellId/task-continuations
//   GET    /api/task-continuations/:continuationId
//   POST   /api/task-continuations/:continuationId/{apply,cancel,retry}
//   GET    /api/task-shells/:shellId/relations
//   POST   /api/task-shells/:shellId/relations
//   POST   /api/task-shells/:shellId/relations/remove
//   DELETE /api/task-shells/:shellId
//   POST   /api/task-shells/:shellId/links
//   POST   /api/task-shells/:shellId/select-target
//   POST   /api/task-shells/:shellId/tasks/resolve
//   GET    /api/task-shells/:shellId/tasks/:taskId
//   POST   /api/task-shells/:shellId/messages
//   POST   /api/task-shells/:shellId/receipts/:receiptId/retry
//
// now answered by native/gateway/src/app/task_shell.rs (rules in
// native/core/src/task_shell.rs).
//
//   node docs/rust-migration/differential/task-shell.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-task-shell-routes.js) over the scripted world in
// tests/helpers/task-shell-scripted-world.js. The Rust front door calls its
// host port (/api/__host/task-shell); the stub Node child here mounts the real
// task-shell host port over the same world, so both sides read
// one set of facts and the comparison covers the split itself: path matching,
// parameter decoding, pagination, DTO field order and the error envelope stay
// in Rust while the runtime/recording facts stay in Node.
//
// Nothing touches a real task board, the clock or the network. Each corpus case
// gets its own shell/task/operation identity, so the artifact memo (8s TTL,
// keyed by task id) never serves a case from an earlier one.
//
// Side effects are compared too: every semantic call the handlers make on the
// runtime / operations / attribution / independent / relations / artifact ports
// is recorded in-process by the oracle and in an NDJSON file by the stub, then
// compared per case in finalize(). A route that answers the same bytes but asks
// Node for the wrong thing (or twice) fails.
//
// No documented differences: every corpus case must agree byte for byte. The
// host port being down (503 rust_backend_unavailable) is a front-door-only
// failure surface — it has no Node-side twin to compare against — and is
// covered by native/gateway/tests/task_shell.rs and docs/gateway.md §9.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const HOST_PATH = '/api/__host/task-shell';
const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };

let worldPath = '';
let effectsPath = '';
let buildDeps = null;
let legacyBag = null;
let legacy = null;
let upstreamText = '';
const nodeEffects = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ids(tag) {
  return {
    sh: `sh-${tag}`, tk: `tk-${tag}`, op: `op-${tag}`, dec: `dec-${tag}`,
    cont: `cont-${tag}`, rel: `rel-${tag}`, sess: `sess-${tag}`, rec: `rec-${tag}`, sug: `sug-${tag}`,
  };
}

function entry7() {
  return {
    ok: true,
    task: { id: 'tk', title: 'Seven messages' },
    messages: Array.from({ length: 7 }, (_, i) => ({
      id: `msg-${i}`, sourceMessageId: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `body ${i}`,
    })),
    execution: { busy: false, status: 'idle' },
    readOnly: false,
    ownerShellId: 'sh-owner',
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
    capture(_response, side) {
      if (side.name !== 'node') return;
      nodeEffects.set(scenario.case, clone(legacyBag.effects.calls));
    },
  };
}

function add(name, buildRequest, buildScenario, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  const scenario = typeof buildScenario === 'function' ? buildScenario(tag) : { case: tag, answers: {} };
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
  const del = (url, headers = L) => ({ method: 'DELETE', url, headers });
  const post = (url, body, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const answers = obj => () => obj;

  // ── auto-OPTIONS: the Allow union follows Express registration order ────
  add('OPTIONS config', () => options('/api/task-shells/config'));
  add('OPTIONS shell', tag => options(`/api/task-shells/${ids(tag).sh}`));
  add('OPTIONS task-operations', tag => options(`/api/task-shells/${ids(tag).sh}/task-operations`));
  add('OPTIONS tasks/resolve', tag => options(`/api/task-shells/${ids(tag).sh}/tasks/resolve`));
  add('OPTIONS messages', tag => options(`/api/task-shells/${ids(tag).sh}/messages`));

  // ── HEAD is served by the GET handler, body suppressed ─────────────────
  add('HEAD shell chat', tag => head(`/api/task-shells/${ids(tag).sh}/chat`));

  // ── GET /api/task-shell-tasks/:taskId ──────────────────────────────────
  add('task entry', tag => get(`/api/task-shell-tasks/${ids(tag).tk}`),
    tag => ({ answers: { [`bindPlannedTask:${ids(tag).tk}`]: { ok: true, task: { id: ids(tag).tk }, readOnly: false } } }));

  // ── GET .../history: pagination permutations ───────────────────────────
  const historyEntry = tag => ({ answers: { [`bindPlannedTask:${ids(tag).tk}`]: entry7() } });
  add('task history default page', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/history`), historyEntry);
  add('task history limit', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/history?limit=2`), historyEntry);
  add('task history before', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/history?before=msg-3`), historyEntry);
  add('task history around', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/history?around=msg-3&limit=4`), historyEntry);
  add('task history around missing', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/history?around=nope`), historyEntry);
  add('task history clamps a huge limit', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/history?limit=9999`), historyEntry);
  add('task history without messages', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/history`),
    tag => ({ answers: { [`bindPlannedTask:${ids(tag).tk}`]: { task: { id: ids(tag).tk } } } }));

  // ── artifacts, including one large (gzip) body ─────────────────────────
  const bigItems = Array.from({ length: 220 }, (_, i) => ({ name: `file-${i}.json`, bytes: i, kind: 'artifact' }));
  add('task artifacts small', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/artifacts`),
    tag => ({ answers: { [`artifacts:${ids(tag).tk}`]: { taskId: ids(tag).tk, title: 'small', items: [{ name: 'a.png', bytes: 12 }] } } }));
  add('task artifacts gzip', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/artifacts`, { ...L, 'Accept-Encoding': 'gzip, deflate' }),
    tag => ({ answers: { [`artifacts:${ids(tag).tk}`]: { taskId: ids(tag).tk, title: 'big', items: bigItems } } }));
  add('shell artifacts bound to a task', tag => get(`/api/task-shells/${ids(tag).sh}/artifacts`),
    tag => ({ answers: {
      [`chatScope:${ids(tag).sh}`]: { shellId: ids(tag).sh, taskId: ids(tag).tk, sessionIds: [] },
      [`artifacts:${ids(tag).tk}`]: { taskId: ids(tag).tk, title: 'bound', items: [{ name: 'b.png', bytes: 3 }] },
    } }));
  add('shell artifacts fall back when unbound', tag => get(`/api/task-shells/${ids(tag).sh}/artifacts`),
    tag => ({ answers: { [`chatScope:${ids(tag).sh}`]: { shellId: ids(tag).sh, taskId: null, sessionIds: [] } } }));
  add('shell artifacts fall back on an empty task id', tag => get(`/api/task-shells/${ids(tag).sh}/artifacts`),
    tag => ({ answers: { [`chatScope:${ids(tag).sh}`]: { shellId: ids(tag).sh, taskId: '', sessionIds: [] } } }));

  // ── task fork / task message ───────────────────────────────────────────
  add('task fork forwards the body', tag => post(`/api/task-shell-tasks/${ids(tag).tk}/fork`, { title: 'Branch', sessionId: 's1' }),
    tag => ({ answers: { [`forkTask:${ids(tag).tk}`]: { ok: true, taskId: `${ids(tag).tk}-fork` } } }));
  add('task message runs the preflight and send', tag => post(`/api/task-shell-tasks/${ids(tag).tk}/messages`, { text: 'go' }),
    tag => ({ answers: {
      [`taskEntry:${ids(tag).tk}`]: { ok: true, ownerShellId: ids(tag).sh, task: { id: ids(tag).tk } },
      sendExplicit: { ok: true, receiptId: 'rc-1', taskId: ids(tag).tk },
    } }));

  // ── config / session context / separation ──────────────────────────────
  add('config', () => get('/api/task-shells/config'));
  add('context with trace and messages', tag => get(`/api/sessions/${ids(tag).sess}/context?traceId=tr-1&include=messages`),
    tag => ({ answers: { [`contextTrace:${ids(tag).sess}`]: { traceId: 'tr-1', currentTask: { taskId: 'tk-ctx' }, messages: [] } } }));
  add('context plain', tag => get(`/api/sessions/${ids(tag).sess}/context`),
    tag => ({ answers: { [`contextTrace:${ids(tag).sess}`]: { traceId: null, currentTask: null } } }));
  add('separation latest', tag => get(`/api/sessions/${ids(tag).sess}/task-separation`),
    tag => ({ answers: { [`separation.latest:${ids(tag).sess}`]: { state: 'pending', taskId: 'tk-sep' } } }));
  add('separation decide', tag => post(`/api/sessions/${ids(tag).sess}/task-separation/${ids(tag).sug}`, { decision: 'accept' }),
    tag => ({ answers: { [`separation.decide:${ids(tag).sess}`]: { ok: true, state: 'accepted' } } }));

  // ── open / view / chat / history / task-index ──────────────────────────
  add('open with a session', tag => post('/api/task-shells', { sessionId: 's-open' }),
    () => ({ answers: { 'open:s-open': { id: 'sh-open', currentTaskId: null } } }));
  add('open without a body field', tag => post('/api/task-shells', {}),
    () => ({ answers: { open: { id: 'sh-open', currentTaskId: null } } }));
  add('shell view', tag => get(`/api/task-shells/${ids(tag).sh}`),
    tag => ({ answers: { [`view:${ids(tag).sh}`]: { id: ids(tag).sh, currentTaskId: ids(tag).tk, cursorVersion: 3 } } }));
  add('shell chat', tag => get(`/api/task-shells/${ids(tag).sh}/chat`),
    tag => ({ answers: { [`chatScope:${ids(tag).sh}`]: { shellId: ids(tag).sh, taskId: ids(tag).tk, sessionIds: ['s1'] } } }));
  add('shell history plain', tag => get(`/api/task-shells/${ids(tag).sh}/history`),
    () => ({ answers: { history: { messages: [{ id: 'm1' }], hasMore: false } } }));
  add('shell history forwards query', tag => get(`/api/task-shells/${ids(tag).sh}/history?before=m5&around=m2&limit=7&historyScope=archive`),
    () => ({ answers: { history: { messages: [], hasMore: true } } }));
  add('task index includeEmpty', tag => get(`/api/task-shells/${ids(tag).sh}/task-index?includeEmpty=1`),
    tag => ({ answers: { [`taskIndex:${ids(tag).sh}`]: { shellId: ids(tag).sh, tasks: [{ id: ids(tag).tk }] } } }));
  add('task index default', tag => get(`/api/task-shells/${ids(tag).sh}/task-index`),
    tag => ({ answers: { [`taskIndex:${ids(tag).sh}`]: { shellId: ids(tag).sh, tasks: [] } } }));

  // ── task operations ────────────────────────────────────────────────────
  add('task operations list', tag => get(`/api/task-shells/${ids(tag).sh}/task-operations`),
    () => ({ answers: { 'operations.list': [{ id: 'op-1', status: 'applied' }] } }));
  add('task operations preview', tag => post(`/api/task-shells/${ids(tag).sh}/task-operations/preview`, { turns: [1, 2], range: { start: 1, end: 2 }, target: 'tk-t' }),
    tag => ({ answers: {
      [`chatScope:${ids(tag).sh}`]: { shellId: ids(tag).sh, taskId: ids(tag).tk, sessionIds: [] },
      'operations.preview': { previewToken: 'pv-1', moves: [{ turn: 1 }] },
    } }));
  add('task operations apply', tag => post(`/api/task-shells/${ids(tag).sh}/task-operations`, {
    clientMsgId: 'cm-1', previewToken: 'pv-1', expectedRevision: 4, turns: [3], range: { start: 3, end: 3 }, target: 'tk-t', queue: true,
  }), tag => ({ answers: {
    [`chatScope:${ids(tag).sh}`]: { shellId: ids(tag).sh, taskId: ids(tag).tk, sessionIds: [] },
    'operations.apply': { ok: true, id: 'op-2', status: 'queued' },
  } }));
  add('task operations get', tag => get(`/api/task-operations/${ids(tag).op}`),
    tag => ({ answers: { [`operations.get:${ids(tag).op}`]: { id: ids(tag).op, status: 'applied' } } }));
  add('task operations cancel', tag => post(`/api/task-operations/${ids(tag).op}/cancel`, { clientMsgId: 'cm-2' }),
    () => ({ answers: { 'operations.cancel': { id: 'op-c', status: 'cancelled' } } }));
  add('task operations undo', tag => post(`/api/task-operations/${ids(tag).op}/undo`, {}),
    () => ({ answers: { 'operations.undo': { id: 'op-u', status: 'undone' } } }));

  // ── attribution decisions ──────────────────────────────────────────────
  add('attribution list includeHidden', tag => get(`/api/task-shells/${ids(tag).sh}/attribution-decisions?includeHidden=1`),
    () => ({ answers: { 'attribution.list': [{ id: 'd-1' }] } }));
  add('attribution accept', tag => post(`/api/task-shells/${ids(tag).sh}/attribution-decisions/${ids(tag).dec}/accept`, { clientMsgId: 'cm-3' }),
    () => ({ answers: { 'attribution.accept': { ok: true, id: 'd-1', action: 'apply' } } }));
  add('attribution dismiss', tag => post(`/api/task-shells/${ids(tag).sh}/attribution-decisions/${ids(tag).dec}/dismiss`, {}),
    () => ({ answers: { 'attribution.dismiss': { ok: true, id: 'd-1', action: 'dismiss' } } }));
  add('attribution defer', tag => post(`/api/task-shells/${ids(tag).sh}/attribution-decisions/${ids(tag).dec}/defer`, {}),
    () => ({ answers: { 'attribution.defer': { ok: true, id: 'd-1', action: 'defer' } } }));
  add('attribution undo', tag => post(`/api/task-shells/${ids(tag).sh}/attribution-decisions/${ids(tag).dec}/undo`, {}),
    () => ({ answers: { 'attribution.undo': { ok: true, id: 'd-1', action: 'undo' } } }));

  // ── independent continuations ──────────────────────────────────────────
  add('independent continue request', tag => post(`/api/task-shells/${ids(tag).sh}/tasks/${ids(tag).tk}/independent-continue`, { clientMsgId: 'cm-4' }),
    () => ({ answers: { 'independent.request': { ok: true, id: 'c-1', state: 'waiting' } } }));
  add('continuations list maps public rows', tag => get(`/api/task-shells/${ids(tag).sh}/task-continuations`),
    () => ({ answers: {
      'independent.list': [{ id: 'c-1', state: 'waiting' }, { id: 'c-2', state: 'applied' }],
      'independent.publicOp': { id: 'c-x', state: 'public' },
    } }));
  add('continuation get', tag => get(`/api/task-continuations/${ids(tag).cont}`),
    tag => ({ answers: {
      [`independent.get:${ids(tag).cont}`]: { id: ids(tag).cont, state: 'waiting' },
      'independent.publicOp': { id: ids(tag).cont, state: 'public' },
    } }));
  add('continuation apply', tag => post(`/api/task-continuations/${ids(tag).cont}/apply`, {}),
    () => ({ answers: { 'independent.apply': { ok: true, id: 'c-1', state: 'applied' } } }));
  add('continuation cancel', tag => post(`/api/task-continuations/${ids(tag).cont}/cancel`, {}),
    () => ({ answers: { 'independent.cancel': { ok: true, id: 'c-1', state: 'cancelled' } } }));
  add('continuation retry', tag => post(`/api/task-continuations/${ids(tag).cont}/retry`, {}),
    () => ({ answers: { 'independent.retry': { ok: true, id: 'c-1', state: 'waiting' } } }));

  // ── relations ──────────────────────────────────────────────────────────
  add('relations list', tag => get(`/api/task-shells/${ids(tag).sh}/relations`),
    () => ({ answers: { 'relations.list': [{ id: 'r-1', kind: 'blocks' }] } }));
  add('relations create', tag => post(`/api/task-shells/${ids(tag).sh}/relations`, { kind: 'blocks', fromTaskId: 'a', toTaskId: 'b', clientMsgId: 'cm-5' }),
    () => ({ answers: { 'relations.create': { ok: true, id: 'r-2' } } }));
  add('relations remove', tag => post(`/api/task-shells/${ids(tag).sh}/relations/remove`, { relationId: 'r-3', clientMsgId: 'cm-6' }),
    () => ({ answers: { 'relations.remove': { ok: true, id: 'r-3' } } }));

  // ── remaining shell mutations ──────────────────────────────────────────
  add('remove shell', tag => del(`/api/task-shells/${ids(tag).sh}`),
    tag => ({ answers: { [`remove:${ids(tag).sh}`]: { ok: true, removed: true } } }));
  add('link a task', tag => post(`/api/task-shells/${ids(tag).sh}/links`, { taskId: ids(tag).tk }),
    tag => ({ answers: { [`link:${ids(tag).sh}`]: { ok: true, taskId: ids(tag).tk } } }));
  add('select target', tag => post(`/api/task-shells/${ids(tag).sh}/select-target`, { taskId: ids(tag).tk, expectedCursorVersion: 2 }),
    tag => ({ answers: { [`selectTarget:${ids(tag).sh}`]: { ok: true, changed: true, cursorVersion: 3 } } }));
  add('resolve task', tag => post(`/api/task-shells/${ids(tag).sh}/tasks/resolve`, { taskId: ids(tag).tk, taskText: 'Do it', title: 'Do' }),
    tag => ({ answers: { [`resolveTask:${ids(tag).sh}`]: { ok: true, taskId: ids(tag).tk } } }));
  add('shell task detail', tag => get(`/api/task-shells/${ids(tag).sh}/tasks/${ids(tag).tk}`),
    tag => ({ answers: { [`detail:${ids(tag).tk}`]: { taskId: ids(tag).tk, execution: { busy: true } } } }));
  add('shell message', tag => post(`/api/task-shells/${ids(tag).sh}/messages`, { text: 'hello' }),
    tag => ({ answers: { [`send:${ids(tag).sh}`]: { ok: true, receiptId: 'rc-2', taskId: ids(tag).tk } } }));
  add('receipt retry', tag => post(`/api/task-shells/${ids(tag).sh}/receipts/${ids(tag).rec}/retry`, {}),
    tag => ({ answers: { [`retry:${ids(tag).sh}`]: { ok: true, receiptId: ids(tag).rec } } }));

  // ── error envelope: status, code, conflicts, detail, receipt facts ─────
  add('refusal keeps status and code', tag => get(`/api/task-shell-tasks/${ids(tag).tk}`),
    tag => ({ answers: { [`bindPlannedTask:${ids(tag).tk}`]: { throw: { code: 'not_found', message: 'task not found', status: 404 } } } }));
  add('refusal carries conflicts and detail', tag => post(`/api/task-shells/${ids(tag).sh}/task-operations`, { turns: [9] }),
    tag => ({ answers: {
      [`chatScope:${ids(tag).sh}`]: { shellId: ids(tag).sh, taskId: ids(tag).tk, sessionIds: [] },
      'operations.apply': { throw: { code: 'stale_revision', message: 'turns moved', status: 409, conflicts: [3, 4], detail: { moved: 2 } } },
    } }));
  add('refusal carries receipt facts', tag => post(`/api/task-shells/${ids(tag).sh}/messages`, { text: 'x' }),
    tag => ({ answers: { [`send:${ids(tag).sh}`]: { throw: {
      code: 'send_failed', message: 'not delivered', status: 502, receiptId: 'rc-9', taskId: ids(tag).tk, notDelivered: true } } } }));
  add('refusal defaults status to 500', tag => get(`/api/task-shell-tasks/${ids(tag).tk}/artifacts`),
    tag => ({ answers: { [`artifacts:${ids(tag).tk}`]: { throw: { code: 'artifacts_failed', message: 'scan failed' } } } }));
  add('refusal redacts a bearer token', tag => get(`/api/sessions/${ids(tag).sess}/context`),
    tag => ({ answers: { [`contextTrace:${ids(tag).sess}`]: { throw: { code: 'trace_failed', message: 'upstream said Bearer abcdef123456', status: 500 } } } }));

  // ── request parsing: a malformed percent escape ────────────────────────
  add('malformed percent escape in the shell id', () => get('/api/task-shells/%E0%A4%A/chat'));

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
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const world = require(path.join(REPO, 'tests/helpers/task-shell-scripted-world'));
const { mountTaskShellHostRoute } = require(path.join(REPO, 'src/task-shell/host'));
const { createArtifactsMemo } = require(path.join(REPO, 'src/task-shell/artifacts'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return { case: null, answers: {} }; }
}

const app = express();
app.use(express.json({ limit: '50mb' }));
let active = world.buildDeps({ case: null, answers: {} });
app.post('/api/__host/task-shell', (req, res, next) => {
  const session = world.buildDeps(readWorld());
  active = session;
  res.on('finish', () => {
    if (!session.effects.calls.length) return;
    fs.appendFileSync(effectsPath,
      JSON.stringify({ case: session.scenario.case || null, calls: session.effects.calls }) + '\\n');
  });
  next();
});
const deps = world.bindDeps(() => active);
mountTaskShellHostRoute(app, {
  ...deps, artifacts: createArtifactsMemo(deps.artifacts, { memoMs: deps.artifactsMemoMs }),
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
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1', () => {
  connectAuthControl(globalThis.__gatewayAuthSecurity);
});
`;
}

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'task-shell',
  mount(app, { repo, work }) {
    worldPath = path.join(work, 'task-shell-world.json');
    effectsPath = path.join(work, 'task-shell-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify({ case: 'initial', answers: {} }));
    const helper = require(path.join(repo, 'tests/helpers/task-shell-scripted-world'));
    buildDeps = helper.buildDeps;
    legacyBag = buildDeps({ case: 'initial', answers: {} });
    legacy = require(path.join(repo, 'tests/helpers/legacy-task-shell-routes'));
    legacy.mountTaskShellRoutes(app, helper.bindDeps(() => legacyBag));
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
  }),
  corpus,
  finalize({ work }) {
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
      console.log(`[task-shell] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[task-shell] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
