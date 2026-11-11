'use strict';
// Differential run for GET/HEAD/OPTIONS /api/{claude,codex}/subscription.
//
//   node docs/rust-migration/differential/account-subscription.js \
//     <repo> <multicc-gateway> <multicc_core.node> [group]
//
// With no group it forks one child per group (a fresh process is needed: the
// Node oracle pins its data root and native addon at load time).
//
// Both sides must reach an upstream without ever touching the real network.
// This file starts a local CONNECT proxy and, behind it, a local TLS server
// with a certificate for api.anthropic.com / chatgpt.com signed by a throwaway
// CA under /tmp/account-subscription-port. HTTPS_PROXY points both processes
// at the CONNECT proxy and SSL_CERT_FILE makes rustls (gateway and addon)
// trust the CA — reqwest's rustls-tls-native-roots honours that variable.
// The upstream answers from a per-token script and records every request, so
// the run can assert where credentials went and that a redirect never causes
// a second request. Nothing here reads a real credential: HOME is a synthetic
// tree containing only fake tokens.
//
// The claude *no-account* path is NOT diffed: on macOS it reads the Keychain
// item "Claude Code-credentials" through /usr/bin/security, which cannot be
// intercepted and would expose the user's real login. Its rule (ok +
// unexpired → token, otherwise no_auth) is covered by Rust unit tests with an
// injected credential document. The codex global login lives in
// $HOME/.codex/auth.json and is safe under the synthetic HOME, so it is diffed.
//
// Groups:
//   default            upstream/credential matrix, query parsing, HEAD/OPTIONS
//   credentials        malformed / expired / missing credential files
//   cache              the shared SQLite cache both sides write
//   concurrency        N concurrent same-account requests share one query
//   proxy              environment precedence and invalid-proxy refusal
//   protocol           auth gate, trailing slash, case, unclaimed methods
//   relative-data-dir  MULTICC_DATA_DIR relative to the gateway cwd
//   abort              a client disconnect must not cancel the query: one
//                      upstream request, one cache row, the other waiter served

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { execFileSync } = require('child_process');
const { run, send } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ORACLE = require(path.join(ROOT, 'tests/helpers/legacy-account-subscription-route.js'));
const GROUP = process.argv[5] || '';
const BASE = process.env.AS_WORK || '/tmp/account-subscription-port';
const HOME = path.join(BASE, 'home');
const TLS = path.join(BASE, 'tls');
const CA = path.join(TLS, 'ca.crt');
const OPENSSL = process.env.OPENSSL_BIN || '/opt/homebrew/bin/openssl';
const GROUPS = ['default', 'credentials', 'cache', 'concurrency', 'proxy', 'protocol', 'relative-data-dir', 'abort'];

const LOCAL = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const REMOTE = { Host: 'box.example.com', 'X-Request-Id': 'diff-req-1' };

// Fixed ids (16 lowercase hex) and fake tokens.
const A_OK = 'aaaaaaaaaaaaaaaa', A_CANCEL = 'cccccccccccccccc', A_401 = 'dddddddddddddddd';
const A_500 = 'eeeeeeeeeeeeeeee', A_GARBAGE = 'ffffffffffffffff', A_REDIRECT = '0123456789abcdef';
const A_EMPTY = 'fefefefefefefefe', A_EXPIRED = 'bbbbbbbbbbbbbbbb', A_BADJSON = 'deadbeefdeadbeef';
const A_UNKNOWN = '9999999999999999';
const C_OK = '1111111111111111', C_401 = '2222222222222222', C_GARBAGE = '3333333333333333';
const C_MISSING = '4444444444444444', C_BADJSON = '5555555555555555';
// Slow accounts: the upstream holds the answer long enough for the client to
// disconnect before it arrives (`abort` group).
const A_SLOW1 = 'a1a1a1a1a1a1a1a1', A_SLOW2 = 'a2a2a2a2a2a2a2a2';
const UPSTREAM_DELAY_MS = 500;

const PROFILE = {
  account: {
    email: 'fake@example.invalid',
    subscription: {
      current_period_end: '2027-01-01T00:00:00.000Z',
      next_payment_date: '2027-01-01T00:00:00.000Z',
      auto_renew: true,
    },
  },
};
const USAGE = {
  subscription: {
    current_period_end: '2027-06-01T00:00:00.000Z',
    next_payment_date: '2027-06-01T00:00:00.000Z',
    auto_renew: true,
  },
};

// token -> {status, body, headers}
const SCRIPTS = {
  'claude-ok': { status: 200, body: JSON.stringify(PROFILE) },
  'claude-cancelled': { status: 200, body: JSON.stringify({ account: { subscription: {
    current_period_end: '2027-01-01T00:00:00.000Z', auto_renew: false,
    next_payment_date: '2027-01-01T00:00:00.000Z' } } }) },
  'claude-401': { status: 401, body: JSON.stringify({ error: 'unauthorized' }) },
  'claude-500': { status: 500, body: JSON.stringify({ error: 'boom' }) },
  'claude-garbage': { status: 200, body: 'not json at all' },
  'claude-redirect': { status: 302, body: '', headers: { Location: 'https://evil.invalid/steal' } },
  'claude-empty': { status: 200, body: '{}' },
  'codex-ok': { status: 200, body: JSON.stringify(USAGE) },
  'codex-401': { status: 401, body: JSON.stringify({ error: 'unauthorized' }) },
  'codex-500': { status: 500, body: JSON.stringify({ error: 'boom' }) },
  'codex-garbage': { status: 200, body: 'not json at all' },
  'codex-global': { status: 200, body: JSON.stringify(USAGE) },
  // `abort` group only: answer late so the client can close first.
  'claude-slow': { status: 200, body: JSON.stringify(PROFILE), delayMs: UPSTREAM_DELAY_MS },
  'claude-slow2': { status: 200, body: JSON.stringify(PROFILE), delayMs: UPSTREAM_DELAY_MS },
};

// ── environment and fixtures ───────────────────────────────────────────────

function ensureCerts() {
  fs.mkdirSync(TLS, { recursive: true });
  if (fs.existsSync(CA) && fs.existsSync(path.join(TLS, 'server.crt'))) return;
  const run0 = args => execFileSync(OPENSSL, args, { cwd: TLS, stdio: 'pipe' });
  fs.rmSync(CA, { force: true });
  run0(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-days', '30', '-subj', '/CN=MultiCC Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run0(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr',
    '-subj', '/CN=api.anthropic.com']);
  fs.writeFileSync(path.join(TLS, 'ext.cnf'), [
    'subjectAltName=DNS:api.anthropic.com,DNS:chatgpt.com',
    'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth', '',
  ].join('\n'));
  run0(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-out', 'server.crt', '-days', '30', '-extfile', 'ext.cnf']);
}

// Red line: a differential that forgets a proxy variable falls through to the
// host's system proxy (scutil --proxy), which on a developer machine is the
// user's Clash at 127.0.0.1:7897 — a probe once did exactly that and four
// fake-token requests reached api.anthropic.com. Every differential and
// fixture generator pins the proxy variables itself and refuses to start when
// they are missing or not loopback; never `delete` them or rely on inherited
// values.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
function assertLoopbackProxy(env, where) {
  const required = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'];
  const missing = required.filter(key => !env[key]);
  if (missing.length) {
    throw new Error(`${where}: ${missing.join(', ')} must be set to a loopback proxy; refusing to run `
      + '(an unset proxy falls back to the host system proxy)');
  }
  for (const key of [...required, 'https_proxy', 'http_proxy', 'all_proxy']) {
    const raw = env[key];
    if (!raw) continue;
    let host;
    try { host = new URL(raw).hostname; } catch (_) { throw new Error(`${where}: ${key}=${raw} is not a URL`); }
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(`${where}: ${key}=${raw} does not point at loopback; refusing to contact the real network`);
    }
  }
  return env;
}

function prepareEnvironment() {
  fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.HOME = HOME;
  process.env.TMPDIR = path.join(BASE, 'tmp');
  ensureCerts();
  process.env.SSL_CERT_FILE = CA;
  // Closed loopback port: any accidental connection is refused immediately.
  // The lowercase spellings would win over the uppercase ones in the proxy
  // policy, so inherited values are removed rather than silently honoured;
  // the uppercase trio is always present, so system discovery never runs.
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    process.env[key] = 'http://127.0.0.1:1';
  }
  for (const key of ['https_proxy', 'http_proxy', 'all_proxy']) delete process.env[key];
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.no_proxy = '127.0.0.1,localhost';
  assertLoopbackProxy(process.env, 'differential process');
}

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function claudeFile(id) { return path.join(HOME, '.multicc', 'official-accounts', 'claude', `${id}.json`); }
function codexFile(id) { return path.join(HOME, '.multicc', 'official-accounts', 'codex', id, 'auth.json'); }
function globalAuth() { return path.join(HOME, '.codex', 'auth.json'); }

function writeHome() {
  const claude = (id, token, expired) => put(claudeFile(id),
    { access_token: token, refresh_token: 'fake-refresh', expired });
  claude(A_OK, 'claude-ok', '2030-01-01T00:00:00Z');
  claude(A_CANCEL, 'claude-cancelled', '2030-01-01T00:00:00Z');
  claude(A_401, 'claude-401', '2030-01-01T00:00:00Z');
  claude(A_500, 'claude-500', '2030-01-01T00:00:00Z');
  claude(A_GARBAGE, 'claude-garbage', '2030-01-01T00:00:00Z');
  claude(A_REDIRECT, 'claude-redirect', '2030-01-01T00:00:00Z');
  claude(A_EMPTY, 'claude-empty', '2030-01-01T00:00:00Z');
  claude(A_EXPIRED, 'claude-ok', '2020-01-01T00:00:00Z');
  claude(A_SLOW1, 'claude-slow', '2030-01-01T00:00:00Z');
  claude(A_SLOW2, 'claude-slow2', '2030-01-01T00:00:00Z');
  put(claudeFile(A_BADJSON), '{ not json');
  const codex = (id, token) => put(codexFile(id),
    { tokens: { access_token: token, account_id: `acct-${id}` } });
  codex(C_OK, 'codex-ok');
  codex(C_401, 'codex-401');
  codex(C_GARBAGE, 'codex-garbage');
  put(codexFile(C_BADJSON), '{ not json');
  put(globalAuth(), { tokens: { access_token: 'codex-global', account_id: 'acct-global' } });
}

// ── local upstream: CONNECT proxy + TLS server ─────────────────────────────

async function startUpstream() {
  const seen = [];
  const server = https.createServer({
    key: fs.readFileSync(path.join(TLS, 'server.key')),
    cert: fs.readFileSync(path.join(TLS, 'server.crt')),
  }, (req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
    seen.push({ host: req.headers.host, path: req.url, token });
    const script = SCRIPTS[token];
    if (!script) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown token' }));
      return;
    }
    const respond = () => {
      if (res.destroyed) return;
      res.writeHead(script.status, { 'content-type': 'application/json', ...(script.headers || {}) });
      res.end(script.body);
    };
    if (script.delayMs) setTimeout(respond, script.delayMs).unref?.(); else respond();
  });
  server.on('tlsClientError', () => {});
  const proxy = http.createServer((_, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const upstream = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    close() { server.close(); proxy.close(); },
  };
}

// ── side observations and normalization ────────────────────────────────────

function observe(seen) {
  return {
    before(side) { side.state.mark = seen.length; },
    capture(_raw, side) {
      const slice = seen.slice(side.state.mark || 0)
        .map(entry => ({ host: entry.host, path: entry.path, token: entry.token }));
      side.state.observed = (side.state.observed || []).concat(slice);
      side.state.lastSeen = slice;
    },
  };
}

// The only clock-derived field is observedAt (ms). It cannot be equal across
// two processes, so it is replaced on both sides and each value is checked to
// be plausible; the ETag/length that hash it are compared for shape instead.
function stripClock(view) {
  let clocked = false;
  view.body = view.body.replace(/"observedAt":\d+/g, () => { clocked = true; return '"observedAt":"<clock>"'; });
  if (clocked) {
    delete view.headers.etag;
    delete view.headers['content-length'];
  }
  return view;
}

function normalizeView(view) {
  const normalized = stripClock(view);
  if (!normalized.headers.etag) return normalized;
  // HEAD: the body is empty but its ETag hashes the clock-bearing JSON the
  // other side generated; the Content-Length still matches (same digit count).
  if (normalized.status === 200 && normalized.body === '') delete normalized.headers.etag;
  return normalized;
}

function parseJson(view) {
  try { return JSON.parse(view.body); } catch (_) { return null; }
}

// ── unclaimed methods and the one documented case difference ───────────────

function isForwarded(view) {
  return view.status === 599 && String(view.body || '').startsWith('gateway-forwarded:');
}

function unclaimed(view, side) {
  if (side.name === 'rust') {
    if (!isForwarded(view)) {
      view.status = `<not-forwarded:${view.status}>`;
      view.body = `<not-forwarded:${String(view.body).slice(0, 120)}>`;
      view.headers = {};
      return view;
    }
    view.status = '<unclaimed>'; view.body = '<unclaimed>'; view.headers = {};
    return view;
  }
  view.status = view.status === 404 ? '<unclaimed>' : `<node-did-not-404:${view.status}>`;
  view.body = '<unclaimed>'; view.headers = {};
  return view;
}

// ── corpus ─────────────────────────────────────────────────────────────────

function request(method, url, headers = LOCAL) { return { method, url, headers }; }

// Send a real request and destroy the socket before the (slow) upstream
// answers. The response is never read: the point is the client disconnect.
function abortAfter(port, url, delayMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: diff-abort\r\nConnection: close\r\n\r\n`);
      setTimeout(() => { socket.destroy(); done(); }, delayMs);
    });
    socket.on('error', done);
    socket.on('close', done);
  });
}

function corpusFor(group, seen) {
  const obs = observe(seen);
  const cases = [];
  const add = (name, req, hooks = {}) => {
    const extra = hooks.normalize;
    cases.push([name, req, {
      ...obs,
      ...hooks,
      normalize(view, side) { return extra ? extra(normalizeView(view), side) : normalizeView(view); },
    }]);
  };

  if (group === 'default' || group === 'credentials') {
    add('claude ok profile', request('GET', `/api/claude/subscription?account=${A_OK}`));
    add('claude cancelled', request('GET', `/api/claude/subscription?account=${A_CANCEL}`));
    add('claude 401', request('GET', `/api/claude/subscription?account=${A_401}`));
    add('claude 500', request('GET', `/api/claude/subscription?account=${A_500}`));
    add('claude invalid json body', request('GET', `/api/claude/subscription?account=${A_GARBAGE}`));
    add('claude empty object body', request('GET', `/api/claude/subscription?account=${A_EMPTY}`));
    add('claude redirect is not followed', request('GET', `/api/claude/subscription?account=${A_REDIRECT}`));
    add('claude expired peek', request('GET', `/api/claude/subscription?account=${A_EXPIRED}`));
    add('claude unreadable account file', request('GET', `/api/claude/subscription?account=${A_BADJSON}`));
    add('claude unknown account', request('GET', `/api/claude/subscription?account=${A_UNKNOWN}`));
    add('codex ok usage', request('GET', `/api/codex/subscription?account=${C_OK}`));
    add('codex 401', request('GET', `/api/codex/subscription?account=${C_401}`));
    add('codex 500 keeps stale fallback', request('GET', `/api/codex/subscription?account=${C_GARBAGE}`));
    add('codex malformed auth file', request('GET', `/api/codex/subscription?account=${C_BADJSON}`));
    add('codex missing auth file', request('GET', `/api/codex/subscription?account=${C_MISSING}`));
    add('codex global login', request('GET', '/api/codex/subscription'));
    // Remove and restore the shared login around both sides; the corpus stays
    // deterministic because the hook runs before each side's request.
    add('codex global login missing', request('GET', '/api/codex/subscription'), {
      before(side) {
        obs.before(side);
        fs.rmSync(globalAuth(), { force: true });
      },
    });
    add('codex global login restored', request('GET', '/api/codex/subscription'), {
      before(side) {
        obs.before(side);
        put(globalAuth(), { tokens: { access_token: 'codex-global', account_id: 'acct-global' } });
      },
    });
    add('account array of one', request('GET', `/api/claude/subscription?account[]=${A_OK}`));
    add('account index zero', request('GET', `/api/claude/subscription?account[0]=${A_OK}`));
    add('account array of two', request('GET', `/api/claude/subscription?account[]=${A_OK}&account[]=${A_CANCEL}`));
    add('account object', request('GET', '/api/claude/subscription?account[a]=x'));
    add('account padded', request('GET', `/api/claude/subscription?account=%20${A_OK}%20`));
    add('account plus sign', request('GET', `/api/claude/subscription?account=+${A_OK}`));
    add('account uppercase hex', request('GET', '/api/claude/subscription?account=AAAAAAAAAAAAAAAA'));
    add('account short', request('GET', '/api/claude/subscription?account=abc'));
    add('account empty', request('GET', '/api/claude/subscription?account='));
  }

  if (group === 'credentials') {
    add('codex 500 maps to unavailable', request('GET', `/api/codex/subscription?account=${C_MISSING}`));
  }

  if (group === 'cache') {
    add('claude ok profile', request('GET', `/api/claude/subscription?account=${A_OK}`));
    add('claude cancelled', request('GET', `/api/claude/subscription?account=${A_CANCEL}`));
    add('claude 401', request('GET', `/api/claude/subscription?account=${A_401}`));
    add('claude unreadable account file', request('GET', `/api/claude/subscription?account=${A_BADJSON}`));
    add('codex ok usage', request('GET', `/api/codex/subscription?account=${C_OK}`));
    add('codex global login', request('GET', '/api/codex/subscription'));
  }

  if (group === 'concurrency') {
    add('six concurrent queries collapse to one', request('GET', `/api/claude/subscription?account=${A_OK}`), {
      async before(side) {
        side.state.mark = seen.length;
        side.state.parallel = await Promise.all(Array.from({ length: 6 }, () => send(side.port,
          request('GET', `/api/claude/subscription?account=${A_OK}`))));
        side.state.parallelSeen = seen.slice(side.state.mark)
          .map(entry => ({ host: entry.host, path: entry.path, token: entry.token }));
        side.state.mark = seen.length;
      },
    });
  }

  if (group === 'proxy') {
    add('proxy environment query', request('GET', `/api/claude/subscription?account=${A_OK}`));
    add('proxy unused for second account', request('GET', `/api/codex/subscription?account=${C_OK}`));
  }

  if (group === 'protocol') {
    add('HEAD claude', request('HEAD', `/api/claude/subscription?account=${A_OK}`));
    add('OPTIONS claude', request('OPTIONS', `/api/claude/subscription?account=${A_OK}`));
    add('OPTIONS codex', request('OPTIONS', `/api/codex/subscription?account=${C_OK}`));
    add('trailing slash', request('GET', `/api/claude/subscription/?account=${A_OK}`));
    add('remote without token', request('GET', `/api/claude/subscription?account=${A_OK}`, REMOTE));
    add('remote codex without token', request('GET', '/api/codex/subscription', REMOTE));
    add('POST is unclaimed', request('POST', '/api/claude/subscription?account=a'), {
      normalize: (view, side) => unclaimed(view, side),
    });
    add('DELETE is unclaimed', request('DELETE', '/api/codex/subscription'), {
      normalize: (view, side) => unclaimed(view, side),
    });
    add('uppercase path is unclaimed by the router', request('GET', `/API/claude/subscription?account=${A_OK}`), {
      expectedDifference: {
        node: view => view.status === 200 && String(view.body).includes('"autoRenew":true'),
        rust: view => isForwarded(view),
      },
    });
  }

  if (group === 'relative-data-dir') {
    add('claude ok profile', request('GET', `/api/claude/subscription?account=${A_OK}`));
  }

  if (group === 'abort') {
    // A unique client hangs up while the slow upstream is thinking. The query
    // must complete anyway: one upstream request and one cache row per side,
    // even though nobody is left to read the answer.
    add('unique disconnect still records', request('GET', `/api/claude/subscription?account=${A_OK}`), {
      async before(side) {
        side.state.mark = seen.length;
        await abortAfter(side.port, `/api/claude/subscription?account=${A_SLOW1}`, 50);
      },
    });
    // The first waiter hangs up, the second stays: still exactly one upstream
    // request, and the survivor gets the correct profile.
    add('second waiter after the first disconnects', request('GET', `/api/claude/subscription?account=${A_SLOW2}`), {
      async before(side) {
        side.state.mark = seen.length;
        await abortAfter(side.port, `/api/claude/subscription?account=${A_SLOW2}`, 50);
      },
    });
  }

  return cases;
}

// ── specs ──────────────────────────────────────────────────────────────────

function specFor(group, upstream, options = {}) {
  const env = {
    HTTPS_PROXY: options.httpsProxy || upstream.proxyUrl,
    // Present so nothing can fall back to the system proxy; HTTPS_PROXY above
    // is what the code under test reads for https URLs.
    HTTP_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    SSL_CERT_FILE: CA,
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
  };
  if (options.env) Object.assign(env, options.env);
  return {
    name: `account-subscription-${group}${options.tag || ''}`,
    mount(app, ctx) {
      const { createOfficialAccountStore } = require(path.join(ROOT, 'src/official-accounts'));
      const { createClaudeAccountCredentialService } = require(path.join(ROOT, 'src/claude-auth/account-credentials'));
      const subscriptions = require(path.join(ROOT, 'src/quota/account-subscription-cache'));
      subscriptions.configure({ file: path.join(ctx.dataRoot, 'provider-limit-cache.db') });
      const accounts = createOfficialAccountStore({});
      ORACLE.mountAccountSubscriptionRoute(app, 'claude', {
        accounts,
        credentials: createClaudeAccountCredentialService({ accounts }),
      });
      ORACLE.mountAccountSubscriptionRoute(app, 'codex', {
        resolveAccountAuthFile: id => accounts.codexAuthFile(id),
      });
    },
    upstream: UPSTREAM,
    gatewayEnv: () => assertLoopbackProxy({ ...env }, `gateway env (${group})`),
    corpus: () => corpusFor(group, upstream.seen),
    stores: [],
    finalize: finalize(group, upstream, options),
  };
}

const UPSTREAM = `
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
const server = http.createServer((req, res) => {
  res.statusCode = 599;
  res.setHeader('content-type', 'text/plain');
  res.end('gateway-forwarded:' + req.method + ' ' + req.url);
});
const listener = net.createServer({ pauseOnConnect: true }, (socket) => {
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
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

// ── finalize ───────────────────────────────────────────────────────────────

function readSubscriptions(file) {
  if (!fs.existsSync(file)) return { exists: false };
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT vendor, account_id, subscription_json FROM provider_subscriptions ORDER BY vendor, account_id').all();
    return { exists: true, rows: rows.map(row => ({
      vendor: row.vendor, account: row.account_id,
      subscription: row.subscription_json == null ? null : JSON.parse(row.subscription_json),
    })) };
  } finally { db.close(); }
}

function finalize(group, upstream, options) {
  return async ({ nodeData, gwData, work, views, sides }) => {
    const details = { group };
    let ok = true;
    const fail = (key, value) => { details[key] = value; ok = false; };

    // Both sides must have gone through the CONNECT proxy, and every request
    // must have carried the token of the account it named.
    const nodeSeen = sides.node.state.observed || [];
    const rustSeen = sides.rust.state.observed || [];
    details.requests = { node: nodeSeen.length, rust: rustSeen.length };
    const wanted = group === 'proxy' ? (options.proxyMode === 'invalid' ? 0 : 2) : null;
    if (wanted && (nodeSeen.length !== wanted || rustSeen.length !== wanted)) {
      fail('requestCount', { node: nodeSeen.length, rust: rustSeen.length });
    }
    for (const entry of [...nodeSeen, ...rustSeen]) {
      const expected = entry.token.startsWith('codex') ? 'codex' : 'claude';
      const host = String(entry.host || '');
      if (!host.startsWith(expected === 'codex' ? 'chatgpt.com' : 'api.anthropic.com')) {
        fail('provenance', entry);
      }
    }
    // A redirect must never be followed: exactly one upstream request per side
    // for that case, and it is the profile endpoint that saw the token.
    if (group === 'default' || group === 'credentials') {
      const redirects = [...nodeSeen, ...rustSeen].filter(entry => entry.token === 'claude-redirect');
      details.redirect = redirects;
      if (redirects.length !== 2) fail('redirectFollowed', redirects);
    }

    // Clock fields are plausible and independently different.
    for (const view of views) {
      const body = view.rust.body;
      const match = /"observedAt":"<clock>"/.test(body);
      if (match) {
        const raw = views.find(v => v === view);
        if (!raw) continue;
      }
    }

    // `abort` group: the leader outlives the disconnected client, so its row
    // lands after the last response. Poll both caches before comparing them.
    const slowRows = async (file) => {
      for (let i = 0; i < 100; i++) {
        const subs = readSubscriptions(file);
        const accounts = new Set((subs.rows || []).map(row => row.account));
        if (accounts.has(A_SLOW1) && accounts.has(A_SLOW2)) return subs;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return readSubscriptions(file);
    };
    const nodeSubs = group === 'abort'
      ? await slowRows(path.join(nodeData, 'provider-limit-cache.db'))
      : readSubscriptions(path.join(nodeData, 'provider-limit-cache.db'));
    const gwSubs = group === 'abort'
      ? await slowRows(path.join(gwData, 'provider-limit-cache.db'))
      : readSubscriptions(path.join(gwData, 'provider-limit-cache.db'));
    details.cache = { node: nodeSubs, rust: gwSubs };
    const strip = rows => JSON.stringify(rows.map(row => ({
      vendor: row.vendor, account: row.account,
      subscription: row.subscription && { ...row.subscription, observedAt: '<clock>' },
    })));
    if (nodeSubs.exists !== gwSubs.exists || (nodeSubs.exists && strip(nodeSubs.rows) !== strip(gwSubs.rows))) {
      fail('cacheRows', { node: nodeSubs.rows, rust: gwSubs.rows });
    }
    if (group === 'default' || group === 'credentials' || group === 'cache') {
      if (!gwSubs.exists || !gwSubs.rows.length) fail('cacheMissing', gwSubs);
      // 401 / invalid-file answers record no subscription but still a row;
      // an unknown claude account is rejected before the query and is never
      // written.
      const accounts = new Set(gwSubs.rows.map(row => row.account));
      const expected = group === 'cache'
        ? [A_OK, A_CANCEL, A_401, A_BADJSON, C_OK]
        : [A_OK, A_EXPIRED, A_401, A_BADJSON, C_OK];
      for (const id of expected) {
        if (!accounts.has(id)) fail(`cacheAccount:${id}`, [...accounts]);
      }
      if (accounts.has(A_UNKNOWN)) fail('cacheUnknownAccount', [...accounts]);
    }

    if (group === 'concurrency') {
      details.parallel = {
        node: { statuses: (sides.node.state.parallel || []).map(r => r.status), requests: (sides.node.state.parallelSeen || []).length },
        rust: { statuses: (sides.rust.state.parallel || []).map(r => r.status), requests: (sides.rust.state.parallelSeen || []).length },
      };
      for (const side of ['node', 'rust']) {
        const entry = details.parallel[side];
        if (entry.requests !== 1) fail(`singleflight:${side}`, entry);
        if (entry.statuses.length !== 6 || entry.statuses.some(status => status !== 200)) {
          fail(`singleflightStatus:${side}`, entry);
        }
      }
    }

    if (group === 'abort') {
      // Both sides request the same two slow accounts against one shared
      // upstream, so the deterministic total is exactly two per token (one
      // per side). Counting the upstream itself avoids racing the per-case
      // observation slices: the slow answer lands after the filler response.
      const upstreamCounts = {
        slow1: upstream.seen.filter(entry => entry.token === 'claude-slow').length,
        slow2: upstream.seen.filter(entry => entry.token === 'claude-slow2').length,
      };
      details.abort = { upstream: upstreamCounts, cache: {} };
      if (upstreamCounts.slow1 !== 2 || upstreamCounts.slow2 !== 2) fail('abortUpstream', upstreamCounts);
      for (const [side, subs] of [['node', nodeSubs], ['rust', gwSubs]]) {
        const accounts = new Set((subs.rows || []).map(row => row.account));
        const cached = { slow1: accounts.has(A_SLOW1), slow2: accounts.has(A_SLOW2) };
        details.abort.cache[side] = cached;
        if (!cached.slow1 || !cached.slow2) fail(`abortCache:${side}`, [...accounts]);
      }
    }

    if (group === 'relative-data-dir') {
      const relative = path.join(work, 'gw', path.relative(path.join(work, 'gw'), gwData));
      const file = path.join(relative, 'provider-limit-cache.db');
      details.relative = { file, exists: fs.existsSync(file) };
      const rows = readSubscriptions(file);
      if (!fs.existsSync(file) || !rows.exists || !rows.rows.length) fail('relativeDataDir', details.relative);
    }

    if (group === 'proxy' && options.proxyMode === 'invalid') {
      // Unsupported proxy URL: both refuse before any connection. A silent
      // direct fallback would have reached the real host, so the empty record
      // is itself the safety assertion.
      details.proxyRefusal = { node: nodeSeen.length, rust: rustSeen.length };
      if (nodeSeen.length || rustSeen.length) fail('proxyFallback', details.proxyRefusal);
      for (const view of views) {
        if (view.node.status !== 200 || parseJson(view.node)?.status !== 'unavailable') fail('proxyNodeBody', view.node);
        if (view.rust.status !== 200 || parseJson(view.rust)?.status !== 'unavailable') fail('proxyRustBody', view.rust);
      }
    }

    console.log(`[account-subscription:${group}${options.tag || ''}] ${ok ? 'finalize ok' : 'finalize FAILED'} ${JSON.stringify(details).slice(0, 900)}`);
    return { ok, details };
  };
}

// ── entry point ────────────────────────────────────────────────────────────

async function main() {
  prepareEnvironment();
  writeHome();
  const argv = process.argv.slice(2, 5);
  if (!GROUP) {
    if (!process.argv[4]) throw new Error('usage: <repo> <multicc-gateway> <multicc_core.node>');
    let failed = false;
    for (const group of GROUPS) {
      try {
        execFileSync(process.execPath, [__filename, ...argv, group], { stdio: 'inherit', env: process.env });
      } catch (_) { failed = true; }
    }
    process.exitCode = failed ? 1 : 0;
    return;
  }
  const upstream = await startUpstream();
  let ok = false;
  try {
    if (GROUP === 'proxy') {
      // Lowercase https_proxy must win over HTTPS_PROXY (nullish precedence).
      Object.assign(process.env, { https_proxy: upstream.proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1' });
      assertLoopbackProxy(process.env, 'proxy/lowercase');
      ok = await run(specFor('proxy', upstream, {
        tag: '-lowercase', env: { https_proxy: upstream.proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1' },
      }), argv);
      if (ok) {
        // An unsupported proxy URL is refused before any socket: if either
        // side silently went direct it would reach the real account host.
        // HTTPS_PROXY stays a loopback decoy: lowercase wins by precedence, and
        // no proxy variable may ever be missing (system-proxy fallback).
        Object.assign(process.env, { https_proxy: 'socks5://127.0.0.1:1', HTTPS_PROXY: 'socks5://127.0.0.1:1' });
        assertLoopbackProxy(process.env, 'proxy/invalid');
        ok = await run(specFor('proxy', upstream, {
          tag: '-invalid', proxyMode: 'invalid',
          env: { https_proxy: 'socks5://127.0.0.1:1' }, httpsProxy: 'socks5://127.0.0.1:1',
        }), argv);
      }
    } else if (GROUP === 'relative-data-dir') {
      process.env.HTTPS_PROXY = upstream.proxyUrl;
      const spec = specFor('relative-data-dir', upstream);
      // lib sets MULTICC_DATA_DIR itself; a relative value overrides it.
      const env = spec.gatewayEnv;
      spec.gatewayEnv = work => ({ ...env(), MULTICC_DATA_DIR: path.relative(path.join(work, 'gw'), path.join(work, 'gw-data')) });
      ok = await run(spec, argv);
    } else {
      process.env.HTTPS_PROXY = upstream.proxyUrl;
      ok = await run(specFor(GROUP, upstream), argv);
    }
  } finally {
    upstream.close();
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch(error => { console.error(error); process.exit(1); });
