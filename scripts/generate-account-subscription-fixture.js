'use strict';

// Regenerates native/gateway/tests/fixtures/account-subscription.json.
//
//   node scripts/generate-account-subscription-fixture.js          # verify
//   node scripts/generate-account-subscription-fixture.js --write  # rewrite
//
// Expectations come from the frozen Node oracle
// (tests/helpers/legacy-account-subscription-route.js) mounted in a real
// Express app over a synthetic HOME. The oracle's `fetch` is a scripted
// function, so no socket is ever opened: the request plan and the result
// mapping are still the Rust core (the napi addon), exactly what the gateway
// uses. The Rust integration test replays these bodies against the real
// gateway through a local TLS upstream.
//
// The only clock-derived field is `observedAt`; it is replaced with "<clock>"
// in the fixture, and the Rust test performs the same replacement before
// comparing. ETag/Content-Length are omitted for the same reason and checked
// per side for shape instead.
//
// TLS material: the fixture carries the CA, server certificate and key the
// Rust test needs to impersonate api.anthropic.com / chatgpt.com. On --write
// an existing fixture is reused verbatim when present (so repeated writes are
// byte-identical); otherwise the PEMs are generated with openssl and embedded.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const target = path.join(root, 'native', 'gateway', 'tests', 'fixtures', 'account-subscription.json');
const ORACLE = require(path.join(root, 'tests/helpers/legacy-account-subscription-route.js'));
const BASE = process.env.AS_WORK || '/tmp/account-subscription-port';
const TLS = path.join(BASE, 'tls');
const OPENSSL = process.env.OPENSSL_BIN || '/opt/homebrew/bin/openssl';

const A_OK = 'aaaaaaaaaaaaaaaa', A_CANCEL = 'cccccccccccccccc', A_401 = 'dddddddddddddddd';
const A_500 = 'eeeeeeeeeeeeeeee', A_GARBAGE = 'ffffffffffffffff', A_REDIRECT = '0123456789abcdef';
const A_EMPTY = 'fefefefefefefefe', A_EXPIRED = 'bbbbbbbbbbbbbbbb', A_BADJSON = 'deadbeefdeadbeef';
const A_UNKNOWN = '9999999999999999';
// Slow accounts exist only for the client-disconnect integration test: the
// upstream entry carries a delay, no corpus case requests them.
const A_SLOW1 = 'a1a1a1a1a1a1a1a1', A_SLOW2 = 'a2a2a2a2a2a2a2a2';
const UPSTREAM_DELAY_MS = 500;
const C_OK = '1111111111111111', C_401 = '2222222222222222', C_GARBAGE = '3333333333333333';
const C_MISSING = '4444444444444444';

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
  'codex-garbage': { status: 200, body: 'not json at all' },
  'codex-global': { status: 200, body: JSON.stringify(USAGE) },
  'claude-slow': { status: 200, body: JSON.stringify(PROFILE), delayMs: UPSTREAM_DELAY_MS },
  'claude-slow2': { status: 200, body: JSON.stringify(PROFILE), delayMs: UPSTREAM_DELAY_MS },
};

function homeFiles() {
  const files = [];
  const claude = (id, token, expired) => files.push({
    path: `.multicc/official-accounts/claude/${id}.json`,
    text: JSON.stringify({ access_token: token, refresh_token: 'fake-refresh', expired }),
  });
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
  files.push({ path: `.multicc/official-accounts/claude/${A_BADJSON}.json`, text: '{ not json' });
  const codex = (id, token) => files.push({
    path: `.multicc/official-accounts/codex/${id}/auth.json`,
    text: JSON.stringify({ tokens: { access_token: token, account_id: `acct-${id}` } }),
  });
  codex(C_OK, 'codex-ok');
  codex(C_401, 'codex-401');
  codex(C_GARBAGE, 'codex-garbage');
  files.push({ path: '.codex/auth.json', text: JSON.stringify({ tokens: { access_token: 'codex-global', account_id: 'acct-global' } }) });
  return files;
}

const CASES = [
  ['GET claude ok', 'GET', `/api/claude/subscription?account=${A_OK}`],
  ['GET claude cancelled', 'GET', `/api/claude/subscription?account=${A_CANCEL}`],
  ['GET claude 401', 'GET', `/api/claude/subscription?account=${A_401}`],
  ['GET claude 500', 'GET', `/api/claude/subscription?account=${A_500}`],
  ['GET claude garbage', 'GET', `/api/claude/subscription?account=${A_GARBAGE}`],
  ['GET claude redirect not followed', 'GET', `/api/claude/subscription?account=${A_REDIRECT}`],
  ['GET claude empty object', 'GET', `/api/claude/subscription?account=${A_EMPTY}`],
  ['GET claude expired peek', 'GET', `/api/claude/subscription?account=${A_EXPIRED}`],
  ['GET claude unreadable file', 'GET', `/api/claude/subscription?account=${A_BADJSON}`],
  ['GET claude unknown account', 'GET', `/api/claude/subscription?account=${A_UNKNOWN}`],
  ['GET codex ok', 'GET', `/api/codex/subscription?account=${C_OK}`],
  ['GET codex 401', 'GET', `/api/codex/subscription?account=${C_401}`],
  ['GET codex garbage', 'GET', `/api/codex/subscription?account=${C_GARBAGE}`],
  ['GET codex missing file', 'GET', `/api/codex/subscription?account=${C_MISSING}`],
  ['GET codex global', 'GET', '/api/codex/subscription'],
  ['GET invalid account', 'GET', '/api/claude/subscription?account=nothex'],
  ['GET array account', 'GET', `/api/claude/subscription?account[]=${A_OK}`],
  ['GET object account', 'GET', '/api/claude/subscription?account[a]=x'],
  ['HEAD claude', 'HEAD', `/api/claude/subscription?account=${A_OK}`],
  ['OPTIONS claude', 'OPTIONS', `/api/claude/subscription?account=${A_OK}`],
  ['OPTIONS codex', 'OPTIONS', '/api/codex/subscription'],
  ['GET trailing slash', 'GET', `/api/claude/subscription/?account=${A_OK}`],
];

function scriptedFetch(url, options) {
  const token = String(options.headers.Authorization || '').replace(/^Bearer\s+/, '');
  const script = SCRIPTS[token];
  assert(script, `no script for token ${token} (${url})`);
  return Promise.resolve(new Response(script.body, {
    status: script.status, headers: { 'content-type': 'application/json', ...(script.headers || {}) },
  }));
}

function readPem(file) { return fs.readFileSync(file, 'utf8'); }

function ensureTls(existing) {
  if (existing && existing.tls) return existing.tls;
  fs.mkdirSync(TLS, { recursive: true });
  const run0 = args => execFileSync(OPENSSL, args, { cwd: TLS, stdio: 'pipe' });
  run0(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-days', '3650', '-subj', '/CN=MultiCC Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run0(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr',
    '-subj', '/CN=api.anthropic.com']);
  fs.writeFileSync(path.join(TLS, 'ext.cnf'), [
    'subjectAltName=DNS:api.anthropic.com,DNS:chatgpt.com',
    'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth', '',
  ].join('\n'));
  run0(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-out', 'server.crt', '-days', '3650', '-extfile', 'ext.cnf']);
  return {
    caPem: readPem(path.join(TLS, 'ca.crt')),
    certPem: readPem(path.join(TLS, 'server.crt')),
    keyPem: readPem(path.join(TLS, 'server.key')),
  };
}

async function collect(tls) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-subscription-fixture-'));
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  for (const file of homeFiles()) {
    const full = path.join(home, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.text);
  }
  process.env.HOME = home;
  process.env.TMPDIR = path.join(BASE, 'tmp');
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
  try {
    const express = require(require.resolve('express', { paths: [root] }));
    const { createOfficialAccountStore } = require(path.join(root, 'src/official-accounts'));
    const { createClaudeAccountCredentialService } = require(path.join(root, 'src/claude-auth/account-credentials'));
    const accounts = createOfficialAccountStore({});
    // The oracle itself owns the routes; Express only has to provide get/json.
    const expressApp = express();
    ORACLE.mountAccountSubscriptionRoute(expressApp, 'claude', {
      accounts,
      credentials: createClaudeAccountCredentialService({ accounts }),
      fetch: scriptedFetch,
    });
    ORACLE.mountAccountSubscriptionRoute(expressApp, 'codex', {
      resolveAccountAuthFile: id => accounts.codexAuthFile(id),
      fetch: scriptedFetch,
    });
    const server = http.createServer(expressApp);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const cases = [];
    for (const [name, method, url] of CASES) {
      const raw = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: url, agent: false,
          headers: { Host: 'localhost', 'X-Request-Id': 'diff-req-1' } }, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
      });
      const body = raw.body.toString('utf8').replace(/"observedAt":\d+/g, '"observedAt":"<clock>"');
      cases.push({
        name, method, url,
        status: raw.status,
        contentType: raw.headers['content-type'] || null,
        allow: raw.headers.allow || null,
        cacheControl: raw.headers['cache-control'] || null,
        contentEncoding: raw.headers['content-encoding'] || null,
        body,
      });
    }
    server.close();
    return cases;
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved.TMPDIR;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Red line (same as docs/rust-migration/differential): an unset proxy falls
// back to the host's system proxy (scutil --proxy) and a later edit could turn
// an injected fetch into a real request. Pin every spelling at a closed
// loopback port and refuse to run when a present value is not loopback.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
function pinLoopbackProxy() {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    process.env[key] = process.env[key] || 'http://127.0.0.1:1';
    const host = new URL(process.env[key]).hostname;
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(`${key}=${process.env[key]} does not point at loopback; refusing to generate fixtures`);
    }
  }
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.no_proxy = '127.0.0.1,localhost';
}

async function main() {
  pinLoopbackProxy();
  const write = process.argv.includes('--write');
  const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  const tls = ensureTls(existing);
  const cases = await collect(tls);
  const documents = {
    home: { files: homeFiles() },
    upstream: Object.entries(SCRIPTS).map(([token, script]) => ({
      token, status: script.status, body: script.body, headers: script.headers || {},
      ...(script.delayMs ? { delayMs: script.delayMs } : {}),
    })),
    tls,
    cases,
  };
  const text = `${JSON.stringify(documents, null, 2)}\n`;
  if (write) {
    fs.writeFileSync(target, text);
    console.log(`wrote ${path.relative(root, target)} (${text.length} bytes, ${cases.length} cases)`);
    return;
  }
  if (!existing) {
    console.error(`missing ${path.relative(root, target)}; run with --write`);
    process.exitCode = 1;
    return;
  }
  const drift = JSON.stringify(existing) !== JSON.stringify(documents);
  if (drift) {
    console.error(`fixture drift: ${path.relative(root, target)} does not match the oracle`);
    const a = JSON.stringify(existing, null, 2).split('\n');
    const b = text.trimEnd().split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.error(`first difference at line ${i + 1}:\n  ${a[i]}\n  ${b[i]}`); break; }
    }
    process.exitCode = 1;
    return;
  }
  console.log(`fixture ok: ${cases.length} cases, tls embedded, ${text.length} bytes`);
}

main().catch(error => { console.error(error); process.exit(1); });
