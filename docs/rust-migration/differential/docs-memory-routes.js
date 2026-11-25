'use strict';
// Differential run for the sixteen docs / memory / memo / directory-events
// routes retired from Node:
//
//   GET|HEAD|POST   /api/docs-registry
//   PATCH|DELETE    /api/docs-registry/:id
//   POST            /api/docs-registry/:id/start
//   POST            /api/docs-registry/:id/stop
//   GET|HEAD        /api/docs-registry/:id/log
//   GET|HEAD        /api/memory/graph
//   GET|HEAD        /api/memory/tree
//   GET|HEAD|PUT|DELETE /api/memory/file
//   GET|HEAD|PUT    /api/directories/:id/memo
//   POST            /api/directories/:id/memo/send
//   GET|HEAD        /api/directories/:id/events
//
// now answered by native/gateway/src/app/docs_memory_routes.rs (rules in
// native/core/src/docs_memory_routes.rs).
//
//   node docs/rust-migration/differential/docs-memory-routes.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers (src/docs-registry.js,
// src/routes/memory-browser.js, src/memo/router.js, src/notes-store.js as of
// HEAD) over the seeded world in tests/helpers/docs-memory-scripted-world.js.
// The Rust front door answers the routes itself and reaches the real host
// composition (src/routes/docs-memory-host.js over the current modules) through
// its Node child, which is seeded identically. The comparison therefore covers
// the split itself: path matching, OPTIONS Allow, parameter decoding, body and
// query reading, the memory rel traversal judgment, DTO assembly and key order,
// the error envelopes, and the side effects (service spawn/kill, log read, memo
// turn delivery) on both sides.
//
// The service start command writes `start` to a per-side effect log and its
// `TERM` trap writes `stop`; memo delivery appends the delivered turn. finalize()
// compares the effect sequences line by line and pins every critical branch, so
// a route that answers the same bytes while asking Node for the wrong thing (or
// nothing at all) cannot pass.
//
// No documented differences: every corpus case must agree byte for byte. The
// host port being down (503 rust_backend_unavailable) is a front-door-only
// failure surface with no Node twin; native/gateway/tests/docs_memory_routes.rs
// and docs/gateway.md §9 cover it, and finalize() refuses to pass unless that
// test still exists.
const fs = require('fs');
const path = require('path');
const { main, loadDeleted, waitForFixture } = require('./lib');

// Parent of the commit that retired the Node docs/memory/memo routes
// (feat(gateway): move eleven route clusters into the Rust front door).
const LEGACY_REV = '57ec6260';

const L = { Host: 'localhost', 'X-Request-Id': 'diff-dm-1' };
const JSONH = { ...L, 'Content-Type': 'application/json' };

let nodeData = '';
let gwData = '';
let repoPath = '';
let upstreamText = '';

const SESSION_TASK = 'task-abcdefabcdefabcdefabcdefabcdef12';
const TASK_ID = 'tsk_abcdefabcdefabcdefabcdefabcdef12';

const cases = [];

function add(name, request, hooks = {}) {
  cases.push([name, request, hooks]);
}

function effectsFor(side) {
  return path.join(side.name === 'node' ? nodeData : gwData, 'effects.log');
}

function startCmdFor(side) {
  const effects = effectsFor(side);
  return `trap 'printf "stop\\n" >> "${effects}"; exit 0' TERM; `
    + `printf 'start\\n' >> "${effects}"; `
    + `printf 'svc log line\\n'; `
    + 'for i in $(seq 1 600); do sleep 0.1; done';
}

async function waitForEffect(side, line, timeoutMs = 10_000) {
  const file = effectsFor(side);
  const started = Date.now();
  for (;;) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (text.split('\n').includes(line)) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${side.name}: effect "${line}" never appeared in ${file} (have: ${JSON.stringify(text)})`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// The validators and the byte length move with the per-side randomness the
// body normalizer blanks (ids, timestamps, pids, absolute paths, durations).
function volatile(view) {
  delete view.headers.etag;
  delete view.headers['content-length'];
  return view;
}

function dropVolatileHeaders() {
  return { normalize: volatile };
}

function captureListEtag(raw, side) {
  if (raw.headers.etag) side.state.listEtag = raw.headers.etag;
}

function captureServiceId(raw, side) {
  try { side.state.serviceId = JSON.parse(raw.body.toString('utf8')).id; } catch (_) {}
}

function requestWithEtag(side) {
  return {
    method: 'GET', url: '/api/docs-registry',
    headers: { ...L, 'If-None-Match': side.state.listEtag || 'W/"none"' },
  };
}

function serviceRequest(method, suffix, body) {
  return side => ({
    method,
    url: `/api/docs-registry/${side.state.serviceId}${suffix || ''}`,
    headers: JSONH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  const json = (method, url, body, headers = JSONH) => ({
    method, url, headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const post = (url, body, headers) => json('POST', url, body, headers);
  const put = (url, body, headers) => json('PUT', url, body, headers);
  const patch = (url, body, headers) => json('PATCH', url, body, headers);
  // Node's http client drops a DELETE body unless the length is explicit, so
  // the by-body delete case names it itself.
  const del = (url, body, headers = JSONH) => {
    if (body === undefined) return json('DELETE', url, undefined, headers);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      method: 'DELETE', url,
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(text)) },
      body: text,
    };
  };

  // ── Express automatic OPTIONS ──────────────────────────────────────────
  add('OPTIONS docs list', () => options('/api/docs-registry'));
  add('OPTIONS docs entry', () => options('/api/docs-registry/doc_seed01'));
  add('OPTIONS docs start', () => options('/api/docs-registry/doc_seed01/start'));
  add('OPTIONS docs stop', () => options('/api/docs-registry/doc_seed01/stop'));
  add('OPTIONS docs log', () => options('/api/docs-registry/doc_seed01/log'));
  add('OPTIONS memory graph', () => options('/api/memory/graph'));
  add('OPTIONS memory tree', () => options('/api/memory/tree'));
  add('OPTIONS memory file', () => options('/api/memory/file'));
  add('OPTIONS memo', () => options('/api/directories/dir-1/memo'));
  add('OPTIONS memo send', () => options('/api/directories/dir-1/memo/send'));
  add('OPTIONS events', () => options('/api/directories/dir-1/events'));
  add('OPTIONS trailing slash', () => options('/api/memory/file/'));
  add('OPTIONS case-insensitive path', () => options('/api/DOCS-REGISTRY'));
  add('OPTIONS parameter is one segment', () => options('/api/docs-registry/a/b'));

  // ── HEAD, validators, gzip, the directory scope ────────────────────────
  add('HEAD docs list', () => head('/api/docs-registry'));
  add('HEAD memory graph', () => head('/api/memory/graph'), dropVolatileHeaders());
  add('HEAD memory file', () => head('/api/memory/file?rel=p-one/_shared/shared.md'), dropVolatileHeaders());
  add('HEAD memo', () => head('/api/directories/dir-1/memo'), dropVolatileHeaders());
  add('HEAD events', () => head('/api/directories/dir-1/events'));

  add('GET docs list', () => get('/api/docs-registry'), { capture: captureListEtag });
  add('GET docs list conditional weak', requestWithEtag);
  add('GET docs list conditional strong', side => ({
    method: 'GET', url: '/api/docs-registry',
    headers: { ...L, 'If-None-Match': (side.state.listEtag || 'W/"none"').replace(/^W\//, '') },
  }));
  add('GET docs list gzip', () => get('/api/docs-registry', { ...L, 'Accept-Encoding': 'gzip, deflate' }));
  add('GET docs list scoped to a directory', () => get('/api/docs-registry?dir=/work/app'));
  add('GET docs list scoped collapse a worktree',
    () => get('/api/docs-registry?dir=/work/app/.multicc-worktrees/task-1'));
  add('GET docs list scoped relative is empty', () => get('/api/docs-registry?dir=work/app'));
  add('GET docs list scoped unknown is empty', () => get('/api/docs-registry?dir=/nowhere'));

  // ── register: validation, prefill, upsert ──────────────────────────────
  add('POST docs missing title', () => post('/api/docs-registry', { url: '/docs/x', kind: 'page' }));
  add('POST docs missing url', () => post('/api/docs-registry', { title: 'x', kind: 'page' }));
  add('POST docs bad kind falls back to page',
    () => post('/api/docs-registry', { title: 'Kind', url: '/docs/kind', kind: 'weird' }), dropVolatileHeaders());
  add('POST docs javascript url', () => post('/api/docs-registry', { title: 'J', url: 'javascript:alert(1)' }));
  add('POST docs dot segment url', () => post('/api/docs-registry', { title: 'D', url: '/docs/../escape' }));
  add('POST docs absolute url normalized',
    () => post('/api/docs-registry', { title: 'Abs', url: 'HTTP://Example.COM:80/Docs/X' }), dropVolatileHeaders());
  add('POST docs session prefill',
    () => post('/api/docs-registry', { title: 'Pre', url: '/docs/prefill', sessionId: SESSION_TASK }),
    dropVolatileHeaders());
  add('POST docs worktree cwd collapses',
    () => post('/api/docs-registry', { title: 'Wt', url: '/docs/worktree', cwd: '/work/app/.multicc-worktrees/task-9' }),
    dropVolatileHeaders());
  add('POST docs relative cwd is ignored',
    () => post('/api/docs-registry', { title: 'Rel', url: '/docs/relative', cwd: 'relative/path' }),
    dropVolatileHeaders());
  add('POST docs artifact url',
    () => post('/api/docs-registry', { title: 'Art', url: '/artifacts/abc123/' }), dropVolatileHeaders());
  add('POST docs upsert the same url',
    () => post('/api/docs-registry', { title: 'Upserted', url: '/docs/shared', note: 'again' }),
    dropVolatileHeaders());
  add('POST docs invalid json', () => post('/api/docs-registry', '{'));

  // ── patch / delete ─────────────────────────────────────────────────────
  add('PATCH docs rename', () => patch('/api/docs-registry/doc_seed01', { title: 'Renamed' }), dropVolatileHeaders());
  add('PATCH docs unknown entry', () => patch('/api/docs-registry/doc_missing', { title: 'Renamed' }));
  add('PATCH docs empty title', () => patch('/api/docs-registry/doc_seed01', { title: '' }));
  add('PATCH docs malformed percent escape', () => patch('/api/docs-registry/%E0%A4%A', { title: 'x' }));
  add('DELETE docs unknown entry', () => del('/api/docs-registry/doc_missing'));
  add('DELETE docs long note', () => del('/api/docs-registry/doc_seed04'));
  add('GET docs list after the mutations', () => get('/api/docs-registry'), dropVolatileHeaders());

  // ── service lifecycle: spawn / kill / log ──────────────────────────────
  add('POST docs register a service',
    side => post('/api/docs-registry', {
      title: 'Svc', url: 'http://127.0.0.1:1/', kind: 'service', startCmd: startCmdFor(side),
    }),
    { capture: captureServiceId, normalize: volatile });
  add('POST docs start the service', serviceRequest('POST', '/start', {}), {
    before: side => waitForEffect(side, 'start').catch(() => undefined),
    normalize: volatile,
  });
  add('POST docs stop the service', serviceRequest('POST', '/stop', {}), {
    before: side => waitForEffect(side, 'start'),
    normalize: volatile,
  });
  add('POST docs stop again', serviceRequest('POST', '/stop', {}));
  add('GET docs service log', side => ({
    method: 'GET',
    url: `/api/docs-registry/${side.state.serviceId}/log`,
    headers: L,
  }));
  add('GET docs service log unknown', () => get('/api/docs-registry/doc_missing/log'));
  add('GET docs list with the service', () => get('/api/docs-registry'), dropVolatileHeaders());
  add('DELETE docs service', serviceRequest('DELETE'), { normalize: volatile });
  add('POST docs start a non-service entry', () => post('/api/docs-registry/doc_seed01/start', {}));
  add('POST docs start an unknown entry', () => post('/api/docs-registry/doc_missing/start', {}));

  // ── memory graph / tree ────────────────────────────────────────────────
  add('GET memory graph all', () => get('/api/memory/graph'), dropVolatileHeaders());
  add('GET memory graph scoped', () => get('/api/memory/graph?dirId=p-one'), dropVolatileHeaders());
  add('GET memory graph unknown directory', () => get('/api/memory/graph?dirId=nope'), dropVolatileHeaders());
  add('GET memory tree', () => get('/api/memory/tree'), dropVolatileHeaders());

  // ── memory file: the traversal surface first, then the happy paths ─────
  add('GET memory file traversal', () => get('/api/memory/file?rel=../outside.md'));
  add('GET memory file absolute rel', () => get('/api/memory/file?rel=/etc/passwd.md'));
  add('GET memory file inner traversal', () => get('/api/memory/file?rel=p-one/../../x.md'));
  add('GET memory file encoded traversal', () => get('/api/memory/file?rel=%2e%2e%2fa.md'));
  add('GET memory file wrong extension', () => get('/api/memory/file?rel=p-one/_shared/note.txt'));
  add('GET memory file missing', () => get('/api/memory/file?rel=p-one/_shared/absent.md'));
  add('GET memory file', () => get('/api/memory/file?rel=p-one/_shared/shared.md'), dropVolatileHeaders());
  add('GET memory file percent-encoded rel',
    () => get('/api/memory/file?rel=p-one%2F_shared%2Fshared.md'), dropVolatileHeaders());
  add('PUT memory file',
    () => put('/api/memory/file', { rel: 'p-one/_shared/new.md', content: 'written by the corpus\n' }),
    dropVolatileHeaders());
  add('GET memory file after write',
    () => get('/api/memory/file?rel=p-one/_shared/new.md'), dropVolatileHeaders());
  add('PUT memory file invalid rel', () => put('/api/memory/file', { rel: '../x.md', content: 'a' }));
  add('PUT memory file missing content', () => put('/api/memory/file', { rel: 'p-one/_shared/new.md' }));
  add('PUT memory file missing parent', () => put('/api/memory/file', { rel: 'nope/x.md', content: 'a' }));
  add('PUT memory file too long',
    () => put('/api/memory/file', { rel: 'p-one/_shared/new.md', content: 'x'.repeat(200001) }));
  add('DELETE memory file by body', () => del('/api/memory/file', { rel: 'p-two/_shared/other.md' }));
  add('GET memory file after delete', () => get('/api/memory/file?rel=p-two/_shared/other.md'));
  add('DELETE memory file by query', () => del('/api/memory/file?rel=p-one/tasks/t1/task.md'));
  add('DELETE memory file missing', () => del('/api/memory/file?rel=p-one/_shared/absent.md'));
  add('DELETE memory file invalid', () => del('/api/memory/file?rel=../x.md'));

  // ── memo ───────────────────────────────────────────────────────────────
  add('GET memo', () => get('/api/directories/dir-1/memo'), dropVolatileHeaders());
  add('GET memo unknown directory', () => get('/api/directories/nope/memo'));
  add('PUT memo', () => put('/api/directories/dir-1/memo', { text: 'new memo body\n' }), dropVolatileHeaders());
  add('GET memo after write', () => get('/api/directories/dir-1/memo'), dropVolatileHeaders());
  add('PUT memo non-string text', () => put('/api/directories/dir-1/memo', { text: 5 }));
  add('PUT memo unknown directory', () => put('/api/directories/nope/memo', { text: 'x' }));
  add('POST memo send', () => post('/api/directories/dir-1/memo/send', { text: 'hello', sessionId: 'sess-1' }));
  add('POST memo send missing text', () => post('/api/directories/dir-1/memo/send', { sessionId: 'sess-1' }));
  add('POST memo send unknown session',
    () => post('/api/directories/dir-1/memo/send', { text: 'x', sessionId: 'nope' }));
  add('POST memo send directory mismatch',
    () => post('/api/directories/dir-1/memo/send', { text: 'x', sessionId: 'sess-x' }));
  add('POST memo send non-chat session',
    () => post('/api/directories/dir-1/memo/send', { text: 'x', sessionId: 'sess-t' }));
  add('POST memo send percent-decoded id',
    () => post('/api/directories/dir%2D1/memo/send', { text: 'encoded', sessionId: 'sess-1' }));

  // ── directory event log ────────────────────────────────────────────────
  add('GET events', () => get('/api/directories/dir-1/events'));
  add('GET events unknown directory', () => get('/api/directories/nope/events'));
  add('GET events registered without a log', () => get('/api/directories/dir-2/events'));

  return cases;
}

// ── the stub Node child: the real host composition over the same seed ──────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
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
const { requestIdMiddleware, safeErrorHandler } = require(path.join(REPO, 'src/http-errors'));
const { jsonCompression } = require(path.join(REPO, 'src/http/json-compression'));
const world = require(path.join(REPO, 'tests/helpers/docs-memory-scripted-world'));
const { createDocsMemoryHost } = require(path.join(REPO, 'src/routes/docs-memory-host'));
const { createMemoryBrowserRoutes } = require(path.join(REPO, 'src/routes/memory-browser'));
const { createMemoModule } = require(path.join(REPO, 'src/memo'));
const { createNotesStore } = require(path.join(REPO, 'src/notes-store'));

const state = world.buildState(process.env.MULTICC_DATA_DIR);
const docs = require(path.join(REPO, 'src/docs-registry'));
const memory = createMemoryBrowserRoutes(world.memoryDeps(state));
const memo = createMemoModule(world.memoDeps(state)).controller;
const notes = createNotesStore(world.notesDeps(state));

const app = express();
app.get('/__health', (_req, res) => res.type('text/plain').send('ok'));
app.use(requestIdMiddleware, jsonCompression);
app.use(express.json({ limit: '50mb' }));
createDocsMemoryHost({
  docs, memory, memo, notes,
  directories: state.directories,
  ...world.docsDeps(),
  isLocal: () => true,
}).mount(app);
app.use(safeErrorHandler({ warn() {}, info() {}, error() {} }));

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

// ── normalization shared by both sides ────────────────────────────────────

function normalizeText(text) {
  let out = text;
  if (nodeData) out = out.split(nodeData).join('<data>');
  if (gwData) out = out.split(gwData).join('<data>');
  out = out.replace(/"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"/g, '"<iso>"');
  out = out.replace(/"mtime":-?[0-9]+(?:\.[0-9]+)?/g, '"mtime":<n>');
  out = out.replace(/"durationMs":[0-9]+/g, '"durationMs":<n>');
  out = out.replace(/"pid":[0-9]+/g, '"pid":<pid>');
  out = out.replace(/doc_[0-9a-z]+/g, 'doc_<id>');
  return out;
}

// ── run ───────────────────────────────────────────────────────────────────

main({
  name: 'docs-memory-routes',
  mount(app, { repo, work }) {
    repoPath = repo;
    nodeData = path.join(work, 'node-data');
    gwData = path.join(work, 'gw-data');
    // The frozen registry and the current modules both read these at require
    // time; the child gets its own pair. Never the checkout's data dir.
    process.env.MULTICC_DATA_DIR = nodeData;
    process.env.MULTICC_MEMORY_ROOT = path.join(nodeData, 'memory-store');
    // loadDeleted() parks the rewritten source in a temp dir, so the frozen
    // memo router's bare `require('express')` resolves through the repo.
    process.env.NODE_PATH = path.join(repo, 'node_modules');
    require('module').Module._initPaths();

    const world = require(path.join(repo, 'tests/helpers/docs-memory-scripted-world'));
    const state = world.buildState(nodeData);
    // The oracle is the code as it stood BEFORE the commit that retired it:
    // `HEAD` stops working once that commit lands (src/memo/router.js is gone
    // from HEAD, and the other three have been rewritten there), so the
    // revision is pinned to the parent of the retiring commit.
    const legacyNotes = loadDeleted(repo, LEGACY_REV, 'src/notes-store.js');
    const legacyMemory = loadDeleted(repo, LEGACY_REV, 'src/routes/memory-browser.js');
    const legacyMemo = loadDeleted(repo, LEGACY_REV, 'src/memo/router.js');
    const legacyDocs = loadDeleted(repo, LEGACY_REV, 'src/docs-registry.js');
    const { createMemoController } = require('../../../tests/helpers/frozen-file-batch12/controller');
    const { createMemoFilePort } = require('../../../tests/helpers/frozen-file-batch12/file-port');

    // server.js registration order: notes, memo, memory, docs.
    legacyNotes.createNotesStore(world.notesDeps(state)).mountRoutes(app);
    app.use(legacyMemo.createMemoRouter(createMemoController({ ...world.memoDeps(state), files: createMemoFilePort() })));
    legacyMemory.createMemoryBrowserRoutes(world.memoryDeps(state)).mountRoutes(app);
    legacyDocs.mount(app, world.docsDeps());
    upstreamText = upstreamSource(repo);
  },
  ready: waitForFixture,
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: () => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: gwData,
    MULTICC_MEMORY_ROOT: path.join(gwData, 'memory-store'),
  }),
  normalize: normalizeText,
  corpus,
  stores: [
    'memo-store/dir-1/memo.md',
    'memory-store/p-one/_shared/new.md',
    'memory-store/p-two/_shared/other.md',
    'memory-store/p-one/tasks/t1/task.md',
  ],
  async finalize({ views, work }) {
    const problems = [];
    const byName = new Map(views.map(entry => [entry.name, entry]));

    // The judge of the side-effect sequence: the shell prints `start`, its TERM
    // trap prints `stop`, and each delivered memo turn appends its own line.
    const readEffects = file => {
      try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; }
    };
    const nodeEffectsFile = path.join(nodeData, 'effects.log');
    const rustEffectsFile = path.join(gwData, 'effects.log');
    const expectedEffects = ['start', 'stop', 'turn:sess-1:hello', 'turn:sess-1:encoded'];
    for (const file of [nodeEffectsFile, rustEffectsFile]) {
      const started = Date.now();
      while (readEffects(file).length < expectedEffects.length && Date.now() - started < 10_000) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      // One more beat for the trailing lines to land.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const nodeEffects = readEffects(nodeEffectsFile);
    const rustEffects = readEffects(rustEffectsFile);
    if (JSON.stringify(nodeEffects) !== JSON.stringify(expectedEffects)) {
      problems.push(`node side effects ${JSON.stringify(nodeEffects)} != ${JSON.stringify(expectedEffects)}`);
    }
    if (JSON.stringify(rustEffects) !== JSON.stringify(expectedEffects)) {
      problems.push(`rust side effects ${JSON.stringify(rustEffects)} != ${JSON.stringify(expectedEffects)}`);
    }

    // The registry store, blanked of the per-side randomness, must agree.
    const readStore = root => {
      try { return normalizeText(fs.readFileSync(path.join(root, 'docs_registry.json'), 'utf8')); }
      catch (_) { return '<absent>'; }
    };
    const nodeStore = readStore(nodeData);
    const rustStore = readStore(gwData);
    if (nodeStore !== rustStore) {
      const details = path.join(work, 'store-diff.json');
      fs.writeFileSync(details, JSON.stringify({ node: nodeStore, rust: rustStore }, null, 2));
      problems.push(`docs_registry.json differs after normalization; see ${details}`);
    }

    // A body that silently 500s on both sides would still "match"; pin the
    // branches this cluster exists to protect.
    const pinned = (name, check) => {
      const view = byName.get(name);
      if (!view) { problems.push(`${name}: missing from the corpus`); return; }
      const result = check(view);
      if (result !== true) problems.push(`${name}: ${result}`);
    };
    const both200 = view => (view.node.status === 200 && view.rust.status === 200) || 'expected 200 on both sides';
    pinned('GET docs list', view => {
      if (both200(view) !== true) return both200(view);
      const body = JSON.parse(view.node.body);
      return (Array.isArray(body) && body.length === 4
        && body.some(entry => entry.title === 'Long note')) || `unexpected list ${view.node.body.slice(0, 120)}`;
    });
    pinned('GET docs list conditional weak', view =>
      (view.node.status === 304 && view.rust.status === 304) || 'expected 304 on both sides');
    pinned('GET docs list gzip', view => {
      if (view.node.status !== 200) return `node status ${view.node.status}`;
      return view.node.headers['content-encoding'] === 'gzip' || 'expected a gzip body';
    });
    pinned('GET memory file traversal', view =>
      (view.node.status === 400 && view.node.body.includes('invalid rel')) || 'traversal was not rejected');
    pinned('GET memory file encoded traversal', view =>
      (view.node.status === 400 && view.node.body.includes('invalid rel')) || 'encoded traversal was not rejected');
    pinned('GET memory file inner traversal', view =>
      (view.node.status === 400 && view.node.body.includes('invalid rel')) || 'inner traversal was not rejected');
    pinned('PUT memory file too long', view =>
      (view.node.status === 413) || `expected 413, got ${view.node.status}`);
    pinned('GET memory file', view => {
      if (both200(view) !== true) return both200(view);
      return JSON.parse(view.node.body).content.includes('links [[global]]') || 'wrong file content';
    });
    pinned('GET memo unknown directory', view => {
      const body = JSON.parse(view.node.body);
      return (view.node.status === 404 && body.code === 'memo_directory_not_found')
        || `unexpected refusal ${view.node.body}`;
    });
    pinned('POST memo send', view => {
      if (both200(view) !== true) return both200(view);
      return view.node.body.includes('"sentTo":"sess-1"') || `unexpected answer ${view.node.body}`;
    });
    pinned('POST docs start the service', view => {
      if (both200(view) !== true) return both200(view);
      return view.node.body.includes('"status":"starting"') || `no start status in ${view.node.body}`;
    });
    pinned('POST docs stop the service', view => {
      if (both200(view) !== true) return both200(view);
      return view.node.body.includes('"status":"down"') || `no stop status in ${view.node.body}`;
    });
    pinned('GET docs service log', view => {
      if (both200(view) !== true) return both200(view);
      return view.node.headers['content-type'] === 'text/plain; charset=utf-8'
        || `content-type ${view.node.headers['content-type']}`;
    });
    pinned('POST docs start a non-service entry', view =>
      (view.node.status === 404) || `expected 404, got ${view.node.status}`);
    pinned('PATCH docs malformed percent escape', view =>
      (view.node.status === 400 && JSON.parse(view.node.body).code === 'request_error')
        || `expected the request_error envelope, got ${view.node.body}`);
    pinned('GET events', view => {
      if (both200(view) !== true) return both200(view);
      return view.node.body.includes('"detail":"first"') || `unexpected events ${view.node.body}`;
    });

    for (const view of views) {
      for (const side of ['node', 'rust']) {
        if (view[side].status === 500 && view[side].body.includes('"code":"internal_error"')) {
          problems.push(`${view.name}: ${side} hit the generic 500 (${view[side].body})`);
        }
      }
    }

    // The 503 surface has no Node twin and is covered by the live suite only.
    let suiteText = '';
    try {
      suiteText = fs.readFileSync(path.join(repoPath, 'native/gateway/tests/docs_memory_routes.rs'), 'utf8');
    } catch (_) {}
    if (!suiteText.includes('an_unreachable_host_is_the_documented_503')) {
      problems.push('native/gateway/tests/docs_memory_routes.rs lost the 503 coverage test');
    }

    if (problems.length) {
      for (const problem of problems) console.log(`[docs-memory-routes] ${problem}`);
      const file = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(file, JSON.stringify(problems, null, 2));
      return { ok: false, details: file };
    }
    console.log(`[docs-memory-routes] side effects identical: ${JSON.stringify(nodeEffects)}`);
    return { ok: true };
  },
});
