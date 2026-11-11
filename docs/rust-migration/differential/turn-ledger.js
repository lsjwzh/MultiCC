'use strict';
// Differential run for the terminal turn-ledger diagnostics retired from
// src/turn-ledger/runtime.js (`mountRoutes`) and now answered by
// native/gateway/src/app/turn_ledger.rs:
//
//   GET|HEAD  /api/sessions/:id/turn-ledger
//   GET|HEAD  /api/sessions/:id/turn-hooks/codex-trust
//   POST      /api/sessions/:id/turn-hooks/codex-trust
//
//   node docs/rust-migration/differential/turn-ledger.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-turn-ledger-routes.js) over a real TurnLedger and a
// scripted launch table. The Rust front door asks its host port
// (/api/__host/turn-ledger); the stub child answers with the real shim
// (src/routes/turn-ledger-host.js) fed by a second, identically seeded
// TurnLedger, so the only thing under comparison is the front door's own work:
// path matching, the decoded `:id`, the 409, the snapshot DTO and the 502.
//
// The codex trust pair never starts a real CLI: both sides answer through the
// same scripted RPC (a fixed value per CODEX_HOME, one thrown error).
//
// Documented differences, registered apart from the byte-for-byte cases:
//   * methods and paths the retired module never registered (`POST
//     /turn-ledger`, an extra segment, an empty `:id`) answer Express's 404 in
//     the oracle and are forwarded by the front door.
//   * an uppercase `/API/` prefix: Express routing is case-insensitive while
//     the front door only claims an exact `/api/` prefix.
const path = require('path');
const { main } = require('./lib');

// ── the world both sides describe ──────────────────────────────────────────

const LAUNCHES = {
  s1: { epoch: 2, cli: 'codex', launchedAt: 1700000000000, cwd: '/w/s1', codexHome: '/h/s1' },
  s2: { epoch: 1, cli: 'claude', launchedAt: 1700000000001, cwd: '/w/s2' },
  boom: { epoch: 3, cli: 'codex', launchedAt: 1700000000002, cwd: '/w/boom', codexHome: '/h/boom' },
  idle: { epoch: 0, cli: 'codex', launchedAt: 1700000000003, cwd: null, codexHome: null },
};

// Spool envelopes the ledgers ingest, shared by both sides. Session ids match
// the launch table where the trust routes need one.
const EVENTS = [
  // A turn in flight: P with running ownership.
  { v: 1, eventId: 'e1', sessionId: 's1', epoch: 2, cli: 'codex', event: 'SessionStart', ts: 1000 },
  { v: 1, eventId: 'e2', sessionId: 's1', epoch: 2, cli: 'codex', event: 'UserPromptSubmit',
    ts: 1010, turnId: 't1', promptHead: 'Do the thing' },
  // A CLI instance the ledger has never seen a turn for.
  { v: 1, eventId: 'e3', sessionId: 'boom', epoch: 3, cli: 'codex', event: 'SessionStart', ts: 1020 },
  // An abnormal end with an explicit boundary, and one without.
  { v: 1, eventId: 'e4', sessionId: 'e-with', epoch: 1, cli: 'codex', event: 'UserPromptSubmit',
    ts: 1030, turnId: 't9', promptHead: 'Long prompt ' + 'x'.repeat(120) },
  { v: 1, eventId: 'e5', sessionId: 'e-with', epoch: 1, cli: 'codex', event: 'Interrupt',
    ts: 1040, turnId: 't9', boundary: 'interrupted' },
  { v: 1, eventId: 'e6', sessionId: 'e-bare', epoch: 1, cli: 'codex', event: 'UserPromptSubmit', ts: 0 },
  { v: 1, eventId: 'e7', sessionId: 'e-bare', epoch: 1, cli: 'codex', event: 'SessionEnd', ts: 0 },
  // A turn that stopped and is still waiting for second evidence.
  { v: 1, eventId: 'e8', sessionId: 'idle', epoch: 0, cli: 'codex', event: 'SessionStart', ts: 1050 },
  { v: 1, eventId: 'e9', sessionId: 'idle', epoch: 0, cli: 'codex', event: 'UserPromptSubmit',
    ts: 1060, turnId: 'tq' },
];

const TRUST = {
  // codexHome -> the answer the scripted app-server gives
  '/h/s1': { state: 'untrusted', total: 1, trusted: 0, hooks: [{ key: 'k1', event: 'stop', trustStatus: 'untrusted' }] },
  '/h/boom': { error: 'codex app-server timed out' },
};
const GRANT = {
  '/h/s1': { state: 'trusted', total: 1, trusted: 1, hooks: [{ key: 'k1', event: 'stop', trustStatus: 'trusted' }] },
  '/h/boom': { error: 'codex app-server exited' },
};

// `apply` schedules its evidence confirmations; dropping them keeps both
// ledgers deterministic (a Stop stays P).
function seedEvents() {
  return EVENTS.map(event => JSON.parse(JSON.stringify(event)));
}

function buildLedger(createTurnLedger, normalizeEnvelope) {
  const ledger = createTurnLedger({
    now: () => 1000, schedule: () => {}, confirmTurnEnd: async () => 'pending',
  });
  for (const raw of seedEvents()) {
    const env = normalizeEnvelope(raw);
    if (env) ledger.apply(env);
  }
  return ledger;
}

// The scripted codex RPC both sides answer with.
function scriptedTrust(table, write) {
  return async target => {
    const key = target.codexHome || '';
    const entry = table[key];
    if (!entry) throw new Error(`no scripted answer for ${key}`);
    if (entry.error) throw new Error(entry.error);
    return Object.assign({}, entry, write ? { write: true } : {});
  };
}

// ── stub Node child: PROXY v1 + the real host-port shim ────────────────────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
const { createTurnLedger } = require(path.join(REPO, 'src/turn-ledger/ledger'));
const { normalizeEnvelope } = require(path.join(REPO, 'src/turn-ledger/contract'));
const { createTurnLedgerHost } = require(path.join(REPO, 'src/routes/turn-ledger-host'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

const HOST_PATH = ${JSON.stringify('/api/__host/turn-ledger')};
const launches = ${JSON.stringify(LAUNCHES)};
const trust = ${JSON.stringify(TRUST)};
const grant = ${JSON.stringify(GRANT)};
const ledger = (function () {
  const table = createTurnLedger({ now: () => 1000, schedule: () => {}, confirmTurnEnd: async () => 'pending' });
  for (const raw of ${JSON.stringify(EVENTS)}) {
    const env = normalizeEnvelope(raw);
    if (env) table.apply(env);
  }
  return table;
})();
function answer(table, target, write) {
  const entry = table[target.codexHome || ''];
  if (!entry) throw new Error('no scripted answer for ' + (target.codexHome || ''));
  if (entry.error) throw new Error(entry.error);
  return write ? Object.assign({}, entry, { write: true }) : Object.assign({}, entry);
}
const handle = createTurnLedgerHost({
  launch: id => launches[id] || null,
  record: id => ledger.record(id),
  trust: async target => answer(target.write ? grant : trust, target, target.write),
});

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === HOST_PATH) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      let input = {};
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
      let out;
      try { out = await handle(input); } catch (error) { out = { ok: false, message: String(error.message || error) }; }
      const text = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
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

// ── corpus ─────────────────────────────────────────────────────────────────

function corpus() {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const post = url => ({ method: 'POST', url, headers: L });
  const options = url => ({ method: 'OPTIONS', url, headers: L });

  const notRegistered = {
    node: view => view.status === 404,
    rust: view => view.status === 599 && String(view.body || '').startsWith('gateway-forwarded:'),
  };
  const uppercasePrefix = {
    node: view => view.status === 200,
    rust: view => view.status === 599 && String(view.body || '').startsWith('gateway-forwarded:'),
  };

  return [
    // ── /turn-ledger ─────────────────────────────────────────────────────
    ['ledger launched session', get('/api/sessions/s1/turn-ledger')],
    ['ledger unknown session', get('/api/sessions/nope/turn-ledger')],
    ['ledger trailing slash', get('/api/sessions/s1/turn-ledger/')],
    ['ledger mixed case path', get('/api/Sessions/S1/Turn-Ledger')],
    ['ledger HEAD', head('/api/sessions/s1/turn-ledger')],
    ['ledger gzip', get('/api/sessions/e-with/turn-ledger', { ...L, 'Accept-Encoding': 'gzip' })],
    ['ledger abnormal with boundary', get('/api/sessions/e-with/turn-ledger')],
    ['ledger abnormal without boundary', get('/api/sessions/e-bare/turn-ledger')],
    ['ledger stopped turn', get('/api/sessions/idle/turn-ledger')],
    ['ledger session without launch', get('/api/sessions/e-with/turn-ledger')],
    ['ledger encoded slash in id', get('/api/sessions/a%2Fb/turn-ledger')],
    ['ledger encoded space in id', get('/api/sessions/My%20Session/turn-ledger')],
    ['OPTIONS ledger', options('/api/sessions/s1/turn-ledger')],
    ['OPTIONS ledger trailing slash', options('/api/sessions/s1/turn-ledger/')],

    // ── /turn-hooks/codex-trust ───────────────────────────────────────────
    ['trust launched codex', get('/api/sessions/s1/turn-hooks/codex-trust')],
    ['trust HEAD', head('/api/sessions/s1/turn-hooks/codex-trust')],
    ['trust launched claude', get('/api/sessions/s2/turn-hooks/codex-trust')],
    ['trust unknown session', get('/api/sessions/nope/turn-hooks/codex-trust')],
    ['trust encoded slash in id', get('/api/sessions/a%2Fb/turn-hooks/codex-trust')],
    ['trust mixed case path', get('/api/Sessions/S1/Turn-Hooks/Codex-Trust')],
    ['trust without codex home', get('/api/sessions/idle/turn-hooks/codex-trust')],
    ['trust rpc failure', get('/api/sessions/boom/turn-hooks/codex-trust')],
    ['grant codex trust', post('/api/sessions/s1/turn-hooks/codex-trust')],
    ['grant claude refusal', post('/api/sessions/s2/turn-hooks/codex-trust')],
    ['grant rpc failure', post('/api/sessions/boom/turn-hooks/codex-trust')],
    ['OPTIONS trust', options('/api/sessions/s1/turn-hooks/codex-trust')],
    ['OPTIONS trust trailing slash', options('/api/sessions/s1/turn-hooks/codex-trust/')],

    // ── documented differences ───────────────────────────────────────────
    ['POST ledger', post('/api/sessions/s1/turn-ledger'), { expectedDifference: notRegistered }],
    ['DELETE trust', { method: 'DELETE', url: '/api/sessions/s1/turn-hooks/codex-trust', headers: L },
      { expectedDifference: notRegistered }],
    ['empty id', get('/api/sessions//turn-ledger'), { expectedDifference: notRegistered }],
    ['extra segment', get('/api/sessions/s1/turn-ledger/x'), { expectedDifference: notRegistered }],
    ['uppercase prefix', get('/API/sessions/s1/turn-ledger'), { expectedDifference: uppercasePrefix }],
  ];
}

// ── mount ──────────────────────────────────────────────────────────────────

main({
  name: 'turn-ledger',
  upstream: upstreamSource(path.resolve(process.argv[2] || '')),
  mount(app, { repo }) {
    const legacy = require(path.join(repo, 'tests/helpers/legacy-turn-ledger-routes.js'));
    const { createTurnLedger } = require(path.join(repo, 'src/turn-ledger/ledger'));
    const { normalizeEnvelope } = require(path.join(repo, 'src/turn-ledger/contract'));
    const ledger = buildLedger(createTurnLedger, normalizeEnvelope);
    legacy.mountTurnLedgerRoutes(app, {
      launches: LAUNCHES,
      snapshot: id => ledger.snapshot(id),
      trustStatus: scriptedTrust(TRUST, false),
      grantTrust: scriptedTrust(GRANT, true),
    });
  },
  gatewayEnv() {
    // The stub child requires the repo's request-locality module, which loads
    // the native addon at require time; a debug gateway binary does not sit
    // next to the fingerprint directory, so point it at the addon explicitly.
    return { MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON };
  },
  corpus,
});
