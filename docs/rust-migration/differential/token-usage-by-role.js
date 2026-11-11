'use strict';
// Differential run for GET|HEAD|OPTIONS /api/token-usage/by-role, retired from
// the `mountRoutes` of src/routes/token-usage.js and now answered by
// native/gateway/src/app/token_usage_by_role.rs.
//
//   node docs/rust-migration/differential/token-usage-by-role.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen route (tests/helpers/legacy-token-usage-route.js)
// with a scripted tracker; the front door asks its host port
// (/api/__host/token-usage) and the stub Node child answers from the same
// script, so both sides read identical snapshots and ledgers. The tracker
// throws for the session `boom` on the Node side and the stub answers ok:false
// for it, which exercises the retired catch branch on both sides.
//
// Two documented differences are registered apart from the byte-for-byte
// cases: an uppercase `/API/` prefix (Express routing is case-insensitive and
// still answers, the front door does not claim it and forwards it to Node) and
// any other method on the path (the retired route is GET-only, the front door
// forwards instead of answering 404).
const path = require('path');
const { main } = require('./lib');

const SNAPSHOTS = {
  'session-a': {
    main: { inputTokens: 1200, outputTokens: 340, cacheWrite: 56, cacheRead: 7800 },
    mainByProvider: [
      { providerId: 'official-claude', name: 'Official login', model: 'claude-sonnet-5-5',
        inputTokens: 1200, outputTokens: 340, cacheWrite: 56, cacheRead: 7800 },
    ],
    sub: { inputTokens: 90, outputTokens: 12, cacheWrite: 0, cacheRead: 300 },
    subByProvider: [
      { providerId: 'sub-claude', name: 'sub-claude', model: 'claude-haiku-5-5',
        inputTokens: 90, outputTokens: 12, cacheWrite: 0, cacheRead: 300 },
    ],
  },
  'session b/c': {
    main: { inputTokens: 1, outputTokens: 2, cacheWrite: 3, cacheRead: 4 },
    mainByProvider: [],
    sub: null,
    subByProvider: [],
  },
  // No `sub` usage: the tracker drops the bucket and empties subByProvider.
  'session c': {
    main: { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 5 },
    mainByProvider: [
      { providerId: '_unknown_', name: '_unknown_', model: '',
        inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 5 },
    ],
    sub: null,
    subByProvider: [],
  },
  '0': {
    main: { inputTokens: 7, outputTokens: 0, cacheWrite: 0, cacheRead: 0 },
    mainByProvider: [],
    sub: null,
    subByProvider: [],
  },
};

const LEDGER = {
  '2026-01-09': {
    main: {
      'official-claude': {
        name: 'Official login', inputTokens: 1000, outputTokens: 200,
        cacheWrite: 0, cacheRead: 5000, turns: 3,
      },
    },
    sub: {
      'sub-claude': {
        name: 'sub-claude', inputTokens: 40, outputTokens: 5,
        cacheWrite: 0, cacheRead: 100, turns: 1,
      },
    },
    aux: {
      '_default_': {
        name: '', inputTokens: 12, outputTokens: 0,
        cacheWrite: 0, cacheRead: 0, turns: 1,
      },
    },
  },
};

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

// The scripted tracker both sides read: the oracle calls it in-process, the
// stub answers the host port from the same tables.
function tracker() {
  return {
    snapshot(sessionId) {
      if (sessionId === 'boom') {
        const error = new Error('tracker exploded');
        error.code = 'EBOOM';
        throw error;
      }
      return Object.prototype.hasOwnProperty.call(SNAPSHOTS, sessionId)
        ? copy(SNAPSHOTS[sessionId])
        : null;
    },
    readLedger() {
      return copy(LEDGER);
    },
  };
}

// The stub Node child: the real auth-control bridge (the front door refuses
// every native route without it), the host port, then a marker for anything
// that should have been answered in Rust.
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
process.stdin.resume();
const snapshots = ${JSON.stringify(SNAPSHOTS)};
const ledger = ${JSON.stringify(LEDGER)};
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/__host/token-usage') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      let out;
      if (input.op === 'snapshot') {
        if (input.session === 'boom') out = { ok: false };
        else if (Object.prototype.hasOwnProperty.call(snapshots, input.session)) {
          out = { ok: true, payload: snapshots[input.session] };
        } else out = { ok: true, payload: { main: null, sub: null, subByProvider: [] } };
      } else if (input.op === 'ledger') {
        out = { ok: true, payload: ledger };
      } else {
        out = { ok: false };
      }
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

function corpus() {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = url => ({ method: 'HEAD', url, headers: L });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  const cases = [];

  // ── the persisted ledger (no `session`) ──────────────────────────────────
  cases.push(['GET ledger', get('/api/token-usage/by-role')]);
  cases.push(['GET ledger trailing slash', get('/api/token-usage/by-role/')]);
  cases.push(['GET ledger mixed case path', get('/api/Token-Usage/By-Role')]);
  cases.push(['HEAD ledger', head('/api/token-usage/by-role')]);
  cases.push(['GET ledger gzip', get('/api/token-usage/by-role',
    { ...L, 'Accept-Encoding': 'gzip, deflate' })]);
  cases.push(['OPTIONS by-role', options('/api/token-usage/by-role')]);

  // ── one session's runtime snapshot ───────────────────────────────────────
  cases.push(['GET snapshot', get('/api/token-usage/by-role?session=session-a')]);
  cases.push(['GET snapshot encoded space and slash',
    get('/api/token-usage/by-role?session=session%20b%2Fc')]);
  cases.push(['GET snapshot plus is a space',
    get('/api/token-usage/by-role?session=session+c')]);
  cases.push(['GET snapshot unknown session',
    get('/api/token-usage/by-role?session=missing')]);
  cases.push(['GET snapshot session 0',
    get('/api/token-usage/by-role?session=0')]);
  cases.push(['HEAD snapshot', head('/api/token-usage/by-role?session=session-a')]);
  cases.push(['GET snapshot gzip', get('/api/token-usage/by-role?session=session-a',
    { ...L, 'Accept-Encoding': 'gzip' })]);

  // ── `req.query.session` truthiness: qs array / object / empty ────────────
  cases.push(['GET empty session', get('/api/token-usage/by-role?session=')]);
  cases.push(['GET bare session key', get('/api/token-usage/by-role?session')]);
  cases.push(['GET repeated session', get('/api/token-usage/by-role?session=a&session=b')]);
  cases.push(['GET bracketed array', get('/api/token-usage/by-role?session[]=a')]);
  cases.push(['GET bracketed object', get('/api/token-usage/by-role?session[k]=a')]);
  cases.push(['GET indexed array', get('/api/token-usage/by-role?session[0]=a')]);

  // ── the retired catch branch: both sides answer the public 500 ───────────
  cases.push(['GET snapshot throws', get('/api/token-usage/by-role?session=boom')]);

  // ── documented differences ───────────────────────────────────────────────
  cases.push(['GET uppercase API prefix', get('/API/token-usage/by-role'), {
    expectedDifference: {
      node: view => view.status === 200,
      rust: view => view.status === 599
        && String(view.body || '').startsWith('gateway-forwarded:'),
    },
  }]);
  cases.push(['POST by-role', { method: 'POST', url: '/api/token-usage/by-role', headers: L }, {
    expectedDifference: {
      node: view => view.status === 404,
      rust: view => view.status === 599
        && String(view.body || '').startsWith('gateway-forwarded:'),
    },
  }]);
  cases.push(['GET extra segment', get('/api/token-usage/by-role/x'), {
    expectedDifference: {
      node: view => view.status === 404,
      rust: view => view.status === 599
        && String(view.body || '').startsWith('gateway-forwarded:'),
    },
  }]);
  return cases;
}

main({
  name: 'token-usage-by-role',
  mount(app, { repo }) {
    const legacy = require(path.join(repo, 'tests/helpers/legacy-token-usage-route'));
    const logFailure = [];
    legacy.mount(app, { roleTokenTracker: tracker(), logFailure: (event, error) => logFailure.push([event, error.code]) });
    // The oracle's failure branch must log the retired event name; the corpus
    // asserts it after the run through this closure.
    globalThis.__tokenUsageRoleLog = logFailure;
  },
  get upstream() {
    return upstreamSource(path.resolve(__dirname, '..', '..', '..'));
  },
  gatewayEnv: () => ({ MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON }),
  corpus,
  finalize() {
    const calls = globalThis.__tokenUsageRoleLog || [];
    return {
      ok: calls.length === 1 && calls[0][0] === 'token_usage_role_read_failed' && calls[0][1] === 'EBOOM',
      calls,
    };
  },
});
