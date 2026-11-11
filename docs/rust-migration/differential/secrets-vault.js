'use strict';
// Differential run that retired the five secrets-vault routes from Node:
//
//   GET|HEAD|OPTIONS  /api/secrets
//   POST|OPTIONS      /api/secrets
//   POST|OPTIONS      /api/secrets/:name/rename
//   DELETE|OPTIONS    /api/secrets/:name
//   GET|HEAD|OPTIONS  /api/secrets/:name/value
//
// (src/secrets-vault.js mount(), now answered by
// native/gateway/src/app/secrets_vault.rs).
//
//   MULTICC_RUST_PREBUILT_DIR=<dir> MULTICC_RUST_ADDON=<dir>/<platform-arch>/multicc_core.node \
//     node docs/rust-migration/differential/secrets-vault.js
//
// (An explicit `<repo> <multicc-gateway> <multicc_core.node>` argv triple is
// still accepted, like every other differential.)
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-secrets-vault-routes.js) against the real, current
// src/secrets-vault.js store. Before every case the store is replaced wholesale
// from a JSON seed, so the oracle and the scripted Rust host answers describe
// the same world. The store lives in the harness's node-data temp dir: this
// script sets MULTICC_DATA_DIR before requiring the module, so the real
// ~/.multicc secrets.json is never read or written.
//
// The Rust front door asks its host port (/api/__host/secrets-vault) for the
// five operations. The stub Node child here answers from one JSON script
// (work/secrets-vault-script.json). Those answers are derived with the live host
// shim (src/routes/secrets-vault-host.js createSecretsVaultHost) applied to the
// same seed and the same payload Rust would send — so list ordering, the
// metadata projection, created/updated timestamps and the 409/404 mappings are
// byte-identical by construction, and a mismatch means the Rust route changed
// something it must not.
//
// The clock is frozen at 2026-01-10T00:00:00.000Z for the whole process: the
// retired handlers stamp `new Date().toISOString()` on create/update/rename and
// the derived host answers do the same, so `createdAt`/`updatedAt` compare
// byte-for-byte instead of being normalized away. Seeded rows carry fixed
// 2026-01-01/02 timestamps.
const fs = require('fs');
const path = require('path');
const { run } = require('./lib');

const HOST_PATH = '/api/__host/secrets-vault';
const FIXED_DATE = '2026-01-10T00:00:00.000Z';
const FIXED_NOW = Date.UTC(2026, 0, 10, 0, 0, 0);
const CREATED = '2026-01-01T00:00:00.000Z';
const UPDATED = '2026-01-02T00:00:00.000Z';
const MAX_VALUE = 64 * 1024;
const MAX_ENTRIES = 500;

// Freeze Date for the whole process. The retired handlers and the derived host
// answers both call `new Date().toISOString()`; the same frozen instant makes
// their bodies identical. HTTP timeouts and the (uncompared) `Date` response
// header do not depend on this.
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }
  static now() { return FIXED_NOW; }
}
global.Date = FixedDate;

let scriptPath = '';
let vault = null;
let handleHost = null;
let legacy = null;
let upstreamText = '';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// ── the two Node patterns Rust mirrors, reproduced for derivation ──────────

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LEGACY_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function isName(text) { return NAME_RE.test(text); }
function isLegacyName(text) { return LEGACY_NAME_RE.test(text); }

// `decodeURIComponent`, falling back to the literal text (the Rust helper's
// convention too).
function decode(raw) {
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

// Express shape matched by the front door: `/api/` prefix exactly, one optional
// trailing slash, `secrets` case-insensitive, `:name` decoded and trimmed.
function shapeOf(url) {
  const raw = url.split('?')[0];
  if (!raw.startsWith('/api/')) return null;
  let rest = raw.slice('/api/'.length);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  const segments = rest.split('/');
  if (!/^secrets$/i.test(segments[0])) return null;
  if (segments.length === 1) return { shape: 'collection' };
  const name = segments[1];
  if (!name) return null;
  if (segments.length === 2) return { shape: 'item', name };
  if (segments.length !== 3) return null;
  if (/^rename$/i.test(segments[2])) return { shape: 'rename', name };
  if (/^value$/i.test(segments[2])) return { shape: 'value', name };
  return null;
}

function pathNameOf(url) {
  const shape = shapeOf(url);
  if (!shape || !shape.name) return null;
  return decode(shape.name).trim();
}

function parseObject(raw) {
  if (raw === undefined || raw === null) return null;
  let value;
  try { value = JSON.parse(raw); } catch (_) { return null; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// The exact host-port payload native/gateway/src/app/secrets_vault.rs builds
// for a request that passes its validation. `null` means the Rust route would
// reject the request (or not claim the path) before calling the host.
function hostPayload(request) {
  const method = request.method.toUpperCase();
  const shape = shapeOf(request.url);
  if (!shape) return null;

  if (shape.shape === 'collection' && (method === 'GET' || method === 'HEAD')) {
    return { op: 'list' };
  }
  if (shape.shape === 'collection' && method === 'POST') {
    const object = parseObject(request.body);
    const name = object && typeof object.name === 'string' ? object.name.trim() : '';
    if (!isName(name)) return null;
    const value = object ? object.value : undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE) return null;
    const payload = {
      op: 'upsert',
      name,
      value,
      source: object && object.source === 'agent' ? 'agent' : 'user',
    };
    if (object && typeof object.description === 'string') payload.description = object.description;
    if (object && hasOwn(object, 'sessionId')) payload.sessionId = object.sessionId;
    return payload;
  }

  const name = pathNameOf(request.url);
  if (!name || !isLegacyName(name)) return null;

  if (shape.shape === 'item' && method === 'DELETE') return { op: 'remove', name };
  if (shape.shape === 'value' && (method === 'GET' || method === 'HEAD')) {
    return { op: 'reveal', name };
  }
  if (shape.shape === 'rename' && method === 'POST') {
    const object = parseObject(request.body);
    const to = object && typeof object.to === 'string' ? object.to.trim() : '';
    if (!isName(to)) return null;
    return { op: 'rename', name, to };
  }
  return null;
}

// ── oracle state: the real store, replaced per case ────────────────────────

function seedVault(entries) {
  vault._resetForTests();
  fs.writeFileSync(vault.STORE, JSON.stringify(entries));
  vault._loadForTests();
}

// Answers the Rust host port from a per-case script. When `hostDown` is set the
// stub destroys the socket (the front door's `host_port::call` fails); when
// `hostError` is set it answers `{ok:false}` (the store refused).
function deriveScript(entries, request, options = {}) {
  const script = { hostDown: options.hostDown === true, secret: {} };
  if (options.hostError === true) script.secret.down = true;
  if (options.hostDown === true) return script;
  const payload = hostPayload(request);
  if (payload) {
    seedVault(entries);
    try {
      const answer = handleHost(payload);
      if (payload.op === 'list') script.secret.entries = answer.entries;
      else script.secret[payload.op] = answer;
    } catch (_) {
      // The real host shim threw (its route answers 500); the front door sees a
      // non-200 host answer and maps it to the family 503. Represent that as a
      // refusing host so the scripted side takes the same failure branch.
      script.secret.down = true;
    }
  }
  vault._resetForTests();
  return script;
}

function makeScenario({ entries, request, hostDown = false, hostError = false }) {
  return { entries, script: deriveScript(entries, request, { hostDown, hostError }) };
}

function useScenario(scenario, extra = {}) {
  return {
    before(side) {
      if (side.name === 'node') seedVault(scenario.entries);
      // The stub child is a separate process; it reads the script from disk at
      // host-call time. Written only for the side that talks to it.
      else fs.writeFileSync(scriptPath, JSON.stringify(scenario.script));
    },
    ...extra,
  };
}

// ── stub Node child: PROXY v1 + the scripted host port ─────────────────────

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
process.stdin.resume();

const HOST_PATH = ${JSON.stringify(HOST_PATH)};
const scriptPath = process.env.STUB_SCRIPT;
const callsPath = process.env.STUB_CALLS;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function scenario() {
  try { return JSON.parse(fs.readFileSync(scriptPath, 'utf8')); } catch (_) { return {}; }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === HOST_PATH) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const script = scenario();
      if (script.hostDown === true) { req.socket.destroy(); return; }
      let input = {};
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
      if (callsPath) { try { fs.appendFileSync(callsPath, JSON.stringify(input) + '\\n'); } catch (_) {} }
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      const secret = script.secret || {};
      if (secret.down === true) return send({ ok: false });
      if (input.op === 'list') return send({ ok: true, entries: secret.entries || [] });
      if (input.op === 'upsert') return send(hasOwn(secret, 'upsert') ? secret.upsert : { ok: false });
      if (input.op === 'rename') return send(hasOwn(secret, 'rename') ? secret.rename : { ok: false });
      if (input.op === 'remove') return send(hasOwn(secret, 'remove') ? secret.remove : { ok: false });
      if (input.op === 'reveal') return send(hasOwn(secret, 'reveal') ? secret.reveal : { ok: false });
      send({ ok: false });
    });
    return;
  }
  res.statusCode = 599;
  res.setHeader('content-type', 'text/plain');
  res.end('gateway-forwarded:' + req.method + ' ' + req.url);
});

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

function entry(name, extra = {}) {
  return {
    name,
    value: extra.value !== undefined ? extra.value : `value-${name}`,
    description: extra.description !== undefined ? extra.description : '',
    source: extra.source !== undefined ? extra.source : 'user',
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...(extra.updatedBy !== undefined ? { updatedBy: extra.updatedBy } : {}),
  };
}

// Locale order (Node's localeCompare in the store) differs from byte order for
// this set: `_under`, `a.b-c`, `ALPHA`, `lower`, `ZED`. The Rust list route
// re-emits whatever the host returned, so this proves pass-through rather than
// a re-sort.
function baseEntries() {
  return [
    entry('ALPHA', { value: 'alpha-secret', description: 'first entry', updatedBy: 'chat-9' }),
    entry('a.b-c', { value: 'legacy-secret' }),
    entry('ZED', { value: 'zed-secret', description: 'last', source: 'agent' }),
    entry('lower', { value: 'lower-secret' }),
    entry('_under', { value: 'under-secret' }),
  ];
}

function fullEntries() {
  const list = [];
  for (let i = 0; i < MAX_ENTRIES; i++) {
    list.push(entry(`K${String(i).padStart(3, '0')}`, { value: `v${i}` }));
  }
  return list;
}

function parseBody(view) {
  try { return JSON.parse(view.body); } catch (_) { return null; }
}

function rustUnavailable(view) {
  const body = parseBody(view);
  return view.status === 503 && body !== null && body.code === 'rust_backend_unavailable';
}

// The audit bridge (Rust, via src/secret-audit.js) only accepts string session
// ids. A numeric `sessionId` makes the retired handler's audited call throw;
// safeErrorHandler renders that as its 500 DTO with the error's own code. The
// front door makes the same host call, the host route throws too, and its 500
// answer is mapped to the family 503.
function nodeAuditFailure(view) {
  const body = parseBody(view);
  return view.status === 500 && body !== null && body.code === 'secret_audit_unavailable';
}

// `GET /API/secrets`: the front door treats the `/api/` prefix as exact and
// leaves the path to Node (native/gateway/src/app/mod.rs asserts
// `claim(GET, "/API/secrets") == None`). The oracle still mounts the retired
// route, and Express's default routing is case-insensitive, so the oracle
// answers 200 from that route; the production Node child has no such route and
// would 404. This is the one intentional path difference in the run.
function nodeCaseInsensitiveList(view) {
  const body = parseBody(view);
  return view.status === 200 && Array.isArray(body);
}

function rustForwarded(view) {
  return view.status === 599 && String(view.body || '').startsWith('gateway-forwarded:');
}

// An unclaimed path: Express answers its own 404, the front door forwards to
// the Node child, which answers 599 text.
function unclaimed(view, side) {  if (side.name === 'rust') {
    if (!(view.status === 599 && String(view.body || '').startsWith('gateway-forwarded:'))) {
      view.status = `<not-forwarded:${view.status}>`;
      view.body = `<not-forwarded:${String(view.body).slice(0, 120)}>`;
      view.headers = {};
      return view;
    }
  } else if (view.status !== 404) {
    view.status = `<node-did-not-404:${view.status}>`;
    view.body = '<unclaimed>';
    view.headers = {};
    return view;
  }
  view.status = '<unclaimed>';
  view.body = '<unclaimed>';
  view.headers = {};
  return view;
}

function corpus() {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const get = url => ({ method: 'GET', url, headers: { ...L } });
  const head = url => ({ method: 'HEAD', url, headers: { ...L } });
  const options = url => ({ method: 'OPTIONS', url, headers: { ...L } });
  const del = url => ({ method: 'DELETE', url, headers: { ...L } });
  const sendJson = (method, url, body) => ({
    method,
    url,
    headers: { ...L, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const post = (url, body) => sendJson('POST', url, body);

  const cases = [];
  // `scenario` is a fresh object per case, derived now (before any request).
  const add = (name, request, scenario, extra) =>
    cases.push([name, request, useScenario(scenario, extra)]);
  const addFor = (name, request, { entries = baseEntries(), hostDown = false, hostError = false, extra } = {}) =>
    add(name, request, makeScenario({ entries, request, hostDown, hostError }), extra);

  // ── list ─────────────────────────────────────────────────────────────────
  addFor('GET list empty', get('/api/secrets'), { entries: [] });
  addFor('GET list several entries', get('/api/secrets'));
  addFor('HEAD list several entries', head('/api/secrets'));
  addFor('GET list trailing slash', get('/api/secrets/'));
  addFor('GET list case-insensitive literal', get('/api/SECRETS'));
  addFor('GET list mixed case trailing slash', get('/api/Secrets/'));

  // ── create / update ──────────────────────────────────────────────────────
  addFor('POST create new', post('/api/secrets', { name: 'NEW_KEY', value: 'v1' }));
  addFor('POST update existing', post('/api/secrets', { name: 'ALPHA', value: 'v2' }));
  addFor('POST create padded name', post('/api/secrets', { name: '  SPACED  ', value: 'v' }));
  addFor('POST create leading digit name', post('/api/secrets', { name: '9x', value: 'v' }));
  addFor('POST create dashed name', post('/api/secrets', { name: 'has-dash', value: 'v' }));
  addFor('POST create 65-char name', post('/api/secrets', { name: 'a'.repeat(65), value: 'v' }));
  addFor('POST create empty name', post('/api/secrets', { name: '', value: 'v' }));
  addFor('POST create non-string name', post('/api/secrets', { name: 7, value: 'v' }));
  addFor('POST create non-ascii name', post('/api/secrets', { name: 'naïve', value: 'v' }));
  addFor('POST create value missing', post('/api/secrets', { name: 'OK_KEY' }));
  addFor('POST create value null', post('/api/secrets', { name: 'OK_KEY', value: null }));
  addFor('POST create value number', post('/api/secrets', { name: 'OK_KEY', value: 7 }));
  addFor('POST create value empty', post('/api/secrets', { name: 'OK_KEY', value: '' }));
  addFor('POST create value at boundary', post('/api/secrets', { name: 'LONG_KEY', value: 'x'.repeat(MAX_VALUE) }));
  addFor('POST create value over boundary', post('/api/secrets', { name: 'LONG_KEY', value: 'x'.repeat(MAX_VALUE + 1) }));
  addFor('POST create value astral at boundary',
    post('/api/secrets', { name: 'AST_KEY', value: '😀'.repeat(MAX_VALUE / 2) }));
  addFor('POST create description trimmed',
    post('/api/secrets', { name: 'DESC_KEY', value: 'v', description: '  note  ' }));
  addFor('POST create description absent', post('/api/secrets', { name: 'DESC_KEY', value: 'v' }));
  addFor('POST create description non-string',
    post('/api/secrets', { name: 'DESC_KEY', value: 'v', description: 7 }));
  addFor('POST create description empty',
    post('/api/secrets', { name: 'DESC_KEY', value: 'v', description: '' }));
  addFor('POST create source agent',
    post('/api/secrets', { name: 'SRC_KEY', value: 'v', source: 'agent' }));
  addFor('POST create source other',
    post('/api/secrets', { name: 'SRC_KEY', value: 'v', source: 'robot' }));
  addFor('POST create session string',
    post('/api/secrets', { name: 'SESS_KEY', value: 'v', sessionId: 'chat-42' }));
  addFor('POST create session number',
    post('/api/secrets', { name: 'SESS_KEY', value: 'v', sessionId: 42 }), {
      extra: { expectedDifference: { node: nodeAuditFailure, rust: rustUnavailable } },
    });
  addFor('POST create capacity full',
    post('/api/secrets', { name: 'NEW_KEY', value: 'v' }), { entries: fullEntries() });
  addFor('POST update existing at capacity',
    post('/api/secrets', { name: 'K000', value: 'v2' }), { entries: fullEntries() });
  addFor('POST create trailing slash',
    post('/api/secrets/', { name: 'NEW_KEY', value: 'v' }));
  addFor('POST create array body',
    sendJson('POST', '/api/secrets', []));

  // ── rename ───────────────────────────────────────────────────────────────
  addFor('POST rename legacy old', post('/api/secrets/a.b-c/rename', { to: 'RENAMED' }));
  addFor('POST rename same name', post('/api/secrets/ALPHA/rename', { to: 'ALPHA' }));
  addFor('POST rename missing old', post('/api/secrets/ghost/rename', { to: 'NEW_KEY' }));
  addFor('POST rename existing target', post('/api/secrets/ALPHA/rename', { to: 'ZED' }));
  addFor('POST rename bad target', post('/api/secrets/ALPHA/rename', { to: '1bad' }));
  addFor('POST rename missing target', post('/api/secrets/ALPHA/rename', { to: 7 }));
  addFor('POST rename encoded old', post('/api/secrets/%20ALPHA%20/rename', { to: 'NEW_KEY' }));
  addFor('POST rename encoded slash old', post('/api/secrets/a%2Fb/rename', { to: 'NEW_KEY' }));
  addFor('POST rename trailing slash', post('/api/secrets/ALPHA/rename/', { to: 'NEW_KEY' }));
  addFor('POST rename padded target', post('/api/secrets/ALPHA/rename', { to: '  RENAMED  ' }));

  // ── delete ───────────────────────────────────────────────────────────────
  addFor('DELETE legacy name', del('/api/secrets/a.b-c'));
  addFor('DELETE missing', del('/api/secrets/ghost'));
  addFor('DELETE padded name', del('/api/secrets/%20ALPHA%20'));
  addFor('DELETE trailing slash', del('/api/secrets/ALPHA/'));
  addFor('DELETE encoded slash name', del('/api/secrets/a%2Fb'));
  addFor('DELETE mixed case name', del('/api/secrets/AlPhA'));

  // ── reveal ───────────────────────────────────────────────────────────────
  addFor('GET reveal', get('/api/secrets/ALPHA/value'));
  addFor('GET reveal missing', get('/api/secrets/ghost/value'));
  addFor('GET reveal padded', get('/api/secrets/%20ALPHA%20/value'));
  addFor('GET reveal trailing slash', get('/api/secrets/ALPHA/value/'));
  addFor('HEAD reveal', head('/api/secrets/ALPHA/value'));

  // ── Express OPTIONS / HEAD parity ────────────────────────────────────────
  addFor('OPTIONS collection', options('/api/secrets'));
  addFor('OPTIONS collection trailing slash', options('/api/secrets/'));
  addFor('OPTIONS item', options('/api/secrets/ALPHA'));
  addFor('OPTIONS rename', options('/api/secrets/ALPHA/rename'));
  addFor('OPTIONS value', options('/api/secrets/ALPHA/value'));

  // ── unclaimed paths still reach Node ─────────────────────────────────────
  addFor('GET unclaimed item', get('/api/secrets/foo'), { extra: { normalize: unclaimed } });
  addFor('POST unclaimed item', post('/api/secrets/foo', {}), { extra: { normalize: unclaimed } });
  addFor('PUT unclaimed item', sendJson('PUT', '/api/secrets/foo', {}), { extra: { normalize: unclaimed } });
  addFor('GET unclaimed two segments', get('/api/secrets/a/b'), { extra: { normalize: unclaimed } });
  addFor('GET unclaimed uppercase api prefix', get('/API/secrets'), {
    extra: { expectedDifference: { node: nodeCaseInsensitiveList, rust: rustForwarded } },
  });

  // ── documented differences: the host port is down or refuses ─────────────
  // Node answered itself; the front door's host port is its only source, so it
  // answers 503 rust_backend_unavailable.
  addFor('GET list host down', get('/api/secrets'), { hostDown: true, extra: {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  } });
  addFor('POST create host down', post('/api/secrets', { name: 'NEW_KEY', value: 'v' }), { hostDown: true, extra: {
    expectedDifference: { node: view => view.status === 201, rust: rustUnavailable },
  } });
  addFor('POST rename host down', post('/api/secrets/ALPHA/rename', { to: 'NEW_KEY' }), { hostDown: true, extra: {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  } });
  addFor('DELETE host down', del('/api/secrets/ALPHA'), { hostDown: true, extra: {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  } });
  addFor('GET reveal host down', get('/api/secrets/ALPHA/value'), { hostDown: true, extra: {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  } });

  // The host answered ok:false (the store refused). Node still answered from
  // its own store; the front door maps the refusal to the family 503.
  addFor('GET list host error', get('/api/secrets'), { hostError: true, extra: {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  } });
  addFor('POST create host error', post('/api/secrets', { name: 'NEW_KEY', value: 'v' }), { hostError: true, extra: {
    expectedDifference: { node: view => view.status === 201, rust: rustUnavailable },
  } });
  addFor('DELETE host error', del('/api/secrets/ALPHA'), { hostError: true, extra: {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  } });

  return cases;
}

const spec = {
  name: 'secrets-vault',
  mount(app, { repo, work, dataRoot }) {
    process.env.MULTICC_DATA_DIR = dataRoot;
    scriptPath = path.join(work, 'secrets-vault-script.json');
    fs.writeFileSync(scriptPath, JSON.stringify({ secret: {} }));
    legacy = require(path.join(repo, 'tests/helpers/legacy-secrets-vault-routes'));
    vault = require(path.join(repo, 'src/secrets-vault'));
    const { createSecretsVaultHost } = require(path.join(repo, 'src/routes/secrets-vault-host'));
    handleHost = createSecretsVaultHost(vault);
    legacy.mount(app);
    upstreamText = upstreamSource(repo);
  },
  get upstream() { return upstreamText; },
  // The stub child loads the real auth-control bridge, which loads the native
  // addon (src/native/runtime) — the same module the front door calls.
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    STUB_SCRIPT: path.join(work, 'secrets-vault-script.json'),
    STUB_CALLS: path.join(work, 'secrets-vault-calls.jsonl'),
  }),
  corpus,
};

// The task's run command names only the two env vars; an explicit argv triple
// (the convention of the other differentials) still wins when present.
const repo = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
if (args.length < 2 && process.env.MULTICC_RUST_PREBUILT_DIR) {
  args.push(
    repo,
    path.join(process.env.MULTICC_RUST_PREBUILT_DIR, `${process.platform}-${process.arch}`, 'multicc-gateway'),
    process.env.MULTICC_RUST_ADDON || '',
  );
}

run(spec, args).then(
  ok => { process.exitCode = ok ? 0 : 1; },
  error => { console.error(error); process.exit(1); },
);
