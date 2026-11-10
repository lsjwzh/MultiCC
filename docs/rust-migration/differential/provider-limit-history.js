'use strict';
// Differential run for GET/HEAD/OPTIONS /api/providers/limit-history.
//
//   node docs/rust-migration/differential/provider-limit-history.js \
//     <repo> <multicc-gateway> <multicc_core.node> [group]
//
// With no group it forks one child per group (a fresh Node module cache is
// required: src/providers/core.js pins MULTICC_DATA_DIR at load time).
//
// The Node side is the frozen oracle in
// tests/helpers/legacy-provider-limit-history-route.js running the real
// express pipeline, auth runtime and the real napi RustQuotaHistory. The Rust
// side is the release multicc-gateway with an isolated data root and HOME.
//
// Normalization: the two sides answer milliseconds apart, so generatedAt can
// never be byte-identical. Each case supplies the exact expected sinceMs
// *relative to that side's own generatedAt* (range offset, 90-day clamp, or an
// explicit value) and the expected points; the comparison then blanks only
// those clock values. ETag and Content-Length are verified per side against
// that side's own raw body (the etag package's weak hash) and then neutralized.
// Everything else is compared byte for byte after gunzip.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { run, send } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ORACLE = require(path.join(ROOT, 'tests/helpers/legacy-provider-limit-history-route.js'));
const { DatabaseSync } = require('node:sqlite');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const GROUP = process.argv[5] || '';
const BASE = process.env.PLH_WORK || '/tmp/provider-limit-history-port';
const HOME = path.join(BASE, 'home');

const GROUPS = ['default', 'empty-db', 'fresh-db', 'unavailable-garbage', 'unavailable-readonly', 'relative-data-dir'];

// ── isolated environment ───────────────────────────────────────────────────

function prepareEnvironment() {
  fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.HOME = HOME;
  process.env.TMPDIR = path.join(BASE, 'tmp');
}

// ── per-side state ─────────────────────────────────────────────────────────

let NODE_DATA = null;
let GW_DATA = null;
const SEED_NOW = Date.now();

function rootFor(side) {
  return side.name === 'node' ? NODE_DATA : GW_DATA;
}

function dataFile(dir, name) {
  return path.join(dir, name);
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function removeFile(file) {
  fs.rmSync(file, { force: true });
}

// Provider records shared by the "rich" scenarios. The ids are chosen so the
// identity list exercises: synthetic alias, logged-in accounts, a relay per
// type, a duplicate id, a numeric id, a non-ASCII id, official-shaped records
// that must be hidden, and >64 entries for the adapter's slice(0, 64).
const RICH_PROVIDERS = [
  { id: 'claude-relay', appType: 'claude', name: 'Relay', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 't' } } },
  { id: 'codex-relay', appType: 'codex', name: 'Relay', settingsConfig: { auth: { OPENAI_API_KEY: 'k' }, config: 'model_provider = "c"\n[model_providers.c]\nbase_url = "https://relay.example/v1"\n' } },
  { id: 'dup', appType: 'claude', name: 'Dup one', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://one', ANTHROPIC_AUTH_TOKEN: 't' } } },
  { id: 'dup', appType: 'claude', name: 'Dup two', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://two', ANTHROPIC_AUTH_TOKEN: 't' } } },
  { id: 42, appType: 'claude', name: 'Numeric', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://n', ANTHROPIC_AUTH_TOKEN: 't' } } },
  { id: '线路一', appType: 'codex', name: 'Unicode', settingsConfig: { auth: { OPENAI_API_KEY: 'k' }, config: 'base_url = "https://u/v1"\n' } },
  // Official-shaped records: content test (claude env empty, codex chatgpt) and
  // id test (the alias itself must never duplicate the synthetic entry).
  { id: 'claude-legacy-official', appType: 'claude', name: 'Old official', settingsConfig: { env: {} } },
  { id: 'codex-legacy-official', appType: 'codex', name: 'Old official', settingsConfig: { auth: { auth_mode: 'chatgpt' }, config: '' } },
  { id: 'claude-official', appType: 'claude', name: 'Alias override', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://should-not-list', ANTHROPIC_AUTH_TOKEN: 't' } } },
  { id: 'codex-official-0123456789abcdef', appType: 'codex', name: 'Account override', egressIpAllowlist: ['1.2.3.4'] },
  { id: 'wrong-pool', appType: 'bogus', name: 'Wrong pool', settingsConfig: {} },
  { id: 'old-relay', appType: 'claude', name: 'Old relay', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://old', ANTHROPIC_AUTH_TOKEN: 't' } } },
  ...Array.from({ length: 70 }, (_, index) => ({
    id: `bulk-${index}`,
    appType: index % 2 === 0 ? 'claude' : 'codex',
    name: `Bulk ${index}`,
    settingsConfig: index % 2 === 0
      ? { env: { ANTHROPIC_BASE_URL: `https://bulk${index}`, ANTHROPIC_AUTH_TOKEN: 't' } }
      : { auth: { OPENAI_API_KEY: 'k' }, config: `base_url = "https://bulk${index}/v1"\n` },
  })),
];

const RICH_ACCOUNTS = {
  claude: [
    { id: '0123456789abcdef', data: { label: 'one', createdAt: 100, access_token: 'a' } },
    { id: '1111111111111111', data: { label: 'two', createdAt: 100, access_token: 'b' } },
    { id: '2222222222222222', data: { label: 'three', createdAt: 50, access_token: 'c' } },
    { id: 'not-hex-account', data: { label: 'ignored', createdAt: 1, access_token: 'd' } },
    { id: '3333333333333333', data: { label: 'empty token', createdAt: 2, access_token: '  ' } },
  ],
  codex: [
    { id: 'aaaaaaaaaaaaaaaa', meta: { label: 'codex one', createdAt: 200 }, auth: { tokens: { access_token: 'x' } } },
    { id: 'bbbbbbbbbbbbbbbb', meta: { label: 'codex two', createdAt: 200 }, auth: { tokens: {} } },
    { id: 'cccccccccccccccc', auth: { tokens: { access_token: 'y' } } },
    { id: 'not-hex', meta: { createdAt: 1 }, auth: { tokens: { access_token: 'z' } } },
  ],
  extra: [
    { file: 'claude/4444444444444444.json.old', text: '{}' },
    { file: 'claude/5555555555555555.home/.keep', text: '' },
  ],
};

const RICH_STATE = { providers: RICH_PROVIDERS, accounts: RICH_ACCOUNTS, selection: { claude: 'global', codex: 'global' } };

function applyAccounts(accounts) {
  const base = path.join(HOME, '.multicc', 'official-accounts');
  fs.rmSync(base, { recursive: true, force: true });
  if (!accounts || accounts === 'none') return;
  for (const account of accounts.claude || []) {
    writeJsonFile(path.join(base, 'claude', `${account.id}.json`), account.data);
  }
  for (const account of accounts.codex || []) {
    const dir = path.join(base, 'codex', account.id);
    if (account.meta !== undefined) writeJsonFile(path.join(dir, 'account.json'), account.meta);
    if (account.auth !== undefined) writeJsonFile(path.join(dir, 'auth.json'), account.auth);
    if (account.meta === undefined && account.auth === undefined) fs.mkdirSync(dir, { recursive: true });
  }
  for (const extra of accounts.extra || []) {
    writeJsonFile(path.join(base, extra.file), extra.text);
  }
}

function applyState(side, state) {
  const dir = rootFor(side);
  const providerFile = dataFile(dir, 'providers.json');
  if (state.providers === undefined) removeFile(providerFile);
  else writeJsonFile(providerFile, state.providers);
  const selectionFile = dataFile(dir, 'official-provider-selection.json');
  if (state.selection === undefined) removeFile(selectionFile);
  else writeJsonFile(selectionFile, state.selection);
  applyAccounts(state.accounts === undefined ? 'none' : state.accounts);
}

// ── quota-history seeding (real Rust kernel, same file the route opens) ─────

const SAMPLE_WINDOWS = [
  { appType: 'claude', providerId: 'claude-official', series: '5h', from: 20, step: HOUR },
  { appType: 'claude', providerId: 'claude-official', series: '7d', from: 5 * 24, step: 24 * HOUR },
  { appType: 'claude', providerId: 'claude-official-0123456789abcdef', series: '5h', from: 4, step: HOUR },
  { appType: 'claude', providerId: 'claude-official-1111111111111111', series: '5h', from: 3, step: HOUR },
  { appType: 'codex', providerId: 'codex-official', series: 'balance', from: 5, step: HOUR },
  { appType: 'codex', providerId: 'codex-official-aaaaaaaaaaaaaaaa', series: '5h', from: 6, step: HOUR },
  { appType: 'claude', providerId: 'claude-relay', series: '5h', from: 2, step: HOUR },
  { appType: 'codex', providerId: 'codex-relay', series: 'balance', from: 2, step: HOUR },
  { appType: 'claude', providerId: 'dup', series: '5h', from: 2, step: HOUR },
  { appType: 'claude', providerId: '42', series: '5h', from: 2, step: HOUR },
  { appType: 'codex', providerId: '线路一', series: '5h', from: 2, step: HOUR },
  { appType: 'claude', providerId: 'old-relay', series: '5h', from: 10 * 24, step: HOUR },
  ...Array.from({ length: 70 }, (_, index) => ({
    appType: index % 2 === 0 ? 'claude' : 'codex',
    providerId: `bulk-${index}`,
    series: '5h',
    from: 3,
    step: HOUR,
  })),
];

function recordPayload(sample, index) {
  const sampledAt = SEED_NOW - sample.from * HOUR + index * sample.step;
  const summary = sample.series === 'balance'
    ? { kind: 'balance', available: true, total: 100 + index, currency: 'CNY' }
    : {
      kind: 'window',
      windows: [
        { window: sample.series === '7d' ? '7d' : '5h', label: sample.series === '7d' ? '7d' : '5h', usedPercent: (index * 7 + 3) % 100, resetMs: SEED_NOW + DAY },
        ...(sample.series === '5h' ? [{ window: '1m', label: '30d', usedPercent: (index * 11) % 100, resetMs: SEED_NOW + 30 * DAY }] : []),
      ],
    };
  return JSON.stringify({ appType: sample.appType, providerId: sample.providerId, sampledAt, summary });
}

async function seedHistory(dir) {
  const { getNative, runNative } = require(path.join(ROOT, 'src/native/runtime.js'));
  const file = dataFile(dir, 'provider-quota-history.db');
  for (const suffix of ['', '-wal', '-shm']) removeFile(file + suffix);
  const handle = new (getNative().RustQuotaHistory)(file, 14 * DAY);
  for (const sample of SAMPLE_WINDOWS) {
    for (let index = 0; index < sample.from; index++) {
      await runNative(() => handle.record(recordPayload(sample, index)));
    }
  }
}

async function ensureDb(side, group) {
  if (side.state.dbSeeded) return;
  side.state.dbSeeded = true;
  const dir = rootFor(side);
  if (group === 'default' || group === 'relative-data-dir') await seedHistory(dir);
  if (group === 'empty-db') {
    const { getNative } = require(path.join(ROOT, 'src/native/runtime.js'));
    const file = dataFile(dir, 'provider-quota-history.db');
    for (const suffix of ['', '-wal', '-shm']) removeFile(file + suffix);
    // Open (creates schema) and drop; no samples.
    new (getNative().RustQuotaHistory)(file, 14 * DAY);
  }
}

// ── response bookkeeping ───────────────────────────────────────────────────

function weakEtag(body) {
  if (!body.length) return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  const digest = crypto.createHash('sha1').update(body).digest('base64');
  return `W/"${body.length.toString(16)}-${digest.slice(0, 27)}"`;
}

function capture(raw, side) {
  side.state.etag = raw.headers.etag;
  const body = raw.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw.body) : raw.body;
  side.state.etagOk = raw.headers.etag === weakEtag(body);
  side.state.lengthOk = raw.headers['content-length'] === undefined
    || raw.headers['content-length'] === String(raw.body.length);
}

// The exact sinceMs a side must have produced, evaluated against its own clock.
const sinceRange = (range) => (generatedAt) => generatedAt - range;
const sinceValue = (value) => (generatedAt) => Math.max(value, generatedAt - 90 * DAY);
const sinceNumber = (value) => (generatedAt) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(number, generatedAt - 90 * DAY) : generatedAt - DAY;
};

function normalizer({ since, points, available }) {
  return (view, side) => {
    view.headers.etag = side.state.etagOk ? '<etag:body>' : '<etag:MISMATCH>';
    if (view.headers['content-length'] !== undefined) {
      view.headers['content-length'] = side.state.lengthOk ? '<length:body>' : '<length:MISMATCH>';
    }
    if (!view.body || view.body[0] !== '{') return view;
    const parsed = JSON.parse(view.body);
    if (available !== undefined && parsed.available !== available) {
      parsed.available = `<available:${parsed.available}>`;
    }
    if (parsed.available === true || parsed.available === false) {
      const expected = since === null ? null : since(parsed.generatedAt);
      const actual = parsed.sinceMs;
      const same = (expected === null && actual === null)
        || (typeof expected === 'number' && actual === expected);
      parsed.sinceMs = same ? '<since>' : `<since:${actual}!=${expected}>`;
      if (points !== undefined) {
        const expectedPoints = typeof points === 'function' ? points(parsed) : points;
        if (parsed.points !== expectedPoints) parsed.points = `<points:${parsed.points}!=${expectedPoints}>`;
        else parsed.points = '<points>';
      }
      parsed.generatedAt = '<generatedAt>';
    }
    view.body = JSON.stringify(parsed);
    return view;
  };
}

// ── corpus helpers ─────────────────────────────────────────────────────────

const LOCAL = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const REMOTE = { Host: 'box.example.com', 'X-Request-Id': 'diff-req-1' };

// Upstream stub for the cases that must fall through to Node. It has to parse
// the PROXY v1 line the front door puts in front of every forwarded
// connection (docs/gateway.md §3/§5), like src/gateway-child.js.
const UPSTREAM = `
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
// The real child registers the gateway's private auth control channel before
// serving, otherwise every claimed route answers 503 "authentication runtime
// unavailable". Reuse the production wiring and a real RustAuthSecurity.
const REPO = ${JSON.stringify(ROOT)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
// Keep the security object alive: dropping it aborts the napi control task and
// the gateway sees EOF on the auth stream. A CommonJS top-level const is not
// retained after module evaluation, so pin it on the global object.
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
const FORWARDED = 'gateway-forwarded:';

function request(method, url, headers = LOCAL) {
  return { method, url, headers };
}

function isForwarded(view) {
  return view.status === 599 && String(view.body || '').startsWith(FORWARDED);
}

// A shape the front door never claims. The observable contract is only "the
// front door forwards it"; the Node pipeline still owns the leftover answer in
// this run, so its status is asserted against what Express does today:
//   'notfound'    – Express 404 (the route never matched this method/path).
//                   After the move the leftover Node 404 is identical.
//   'forwardOnly' – Express matches the path today (case-insensitive paths,
//                   percent-decoding), so the answer is 200. The front door is
//                   case-sensitive like its /api prefix; after the Node route
//                   is deleted this becomes 404, an intentional difference
//                   recorded in docs/gateway.md §9.
// Both sides normalize to `<unclaimed>` once their own contract holds.
function unclaimed(view, side, mode = 'notfound') {
  if (side.name === 'rust') {
    if (!isForwarded(view)) {
      view.status = `<not-forwarded:${view.status}>`;
      view.body = `<not-forwarded:${String(view.body).slice(0, 120)}>`;
      view.headers = {};
      return view;
    }
    view.status = '<unclaimed>';
    view.body = '<unclaimed>';
    view.headers = {};
    return view;
  }
  view.body = '<unclaimed>';
  view.headers = {};
  if (mode === 'forwardOnly') {
    if (view.status === 404) {
      // The oracle no longer proves the pre-move behavior.
      view.status = '<node-did-not-match:404>';
      return view;
    }
    view.status = '<unclaimed>';
    return view;
  }
  if (view.status !== 404) {
    view.status = `<node-not-404:${view.status}>`;
    return view;
  }
  view.status = '<unclaimed>';
  return view;
}

/**
 * One case. opts:
 *   state       – files every request starts from (default RICH_STATE)
 *   since       – (generatedAt) => expected sinceMs, or null for the
 *                 toString/valueOf NaN path
 *   points      – expected points (number) or (body) => number
 *   available   – expected response.available
 *   unclaimed   – shape the path/method never claims (compare forwarding only)
 */
function caseOf(name, method, url, opts = {}) {
  const state = opts.state === undefined ? RICH_STATE : opts.state;
  const headers = opts.headers || LOCAL;
  return [
    name,
    request(method, url, headers),
    {
      before: async (side) => {
        await ensureDb(side, GROUP);
        if (opts.beforeState) opts.beforeState(side, state);
        applyState(side, state);
      },
      capture,
      normalize: (view, side) => {
        if (opts.unclaimed) return unclaimed(view, side, opts.unclaimed === true ? 'notfound' : opts.unclaimed);
        return normalizer(opts)(view, side);
      },
    },
  ];
}

// A GET whose IF-None-Match must be the same side's own first answer.
function conditional(name, etagTransform, opts = {}) {
  const state = opts.state === undefined ? RICH_STATE : opts.state;
  return [
    name,
    (side) => {
      const etag = etagTransform(side.state.etag);
      const extra = etag === undefined ? {} : { 'If-None-Match': etag };
      return request('GET', '/api/providers/limit-history', { ...LOCAL, ...extra });
    },
    {
      before: async (side) => {
        await ensureDb(side, GROUP);
        applyState(side, state);
        // Prime the same side's ETag: the corpus position after it is an auth
        // rejection with no representation.
        const raw = await send(side.port, request('GET', '/api/providers/limit-history', LOCAL));
        side.state.etag = raw.headers.etag;
      },
      capture,
      normalize: (view, side) => {
        const out = normalizer(opts)(view, side);
        if (out.status === 304) {
          // Each side hands back its own ETag; both matching is the assertion.
          out.headers.etag = '<etag:own>';
          out.body = '';
        }
        return out;
      },
    },
  ];
}

function corpus() {
  const now = SEED_NOW;
  const cases = [];
  const add = (...args) => cases.push(caseOf(...args));

  // ── shapes / range ──────────────────────────────────────────────────────
  add('GET defaults', 'GET', '/api/providers/limit-history', { since: sinceRange(DAY), points: 48, available: true });
  add('GET range 24h', 'GET', '/api/providers/limit-history?range=24h', { since: sinceRange(DAY) });
  add('GET range 7d', 'GET', '/api/providers/limit-history?range=7d', { since: sinceRange(7 * DAY) });
  add('GET range 30d', 'GET', '/api/providers/limit-history?range=30d', { since: sinceRange(30 * DAY) });
  add('GET range 1d unknown', 'GET', '/api/providers/limit-history?range=1d', { since: sinceRange(DAY) });
  add('GET range empty', 'GET', '/api/providers/limit-history?range=', { since: sinceRange(DAY) });
  add('GET range padded', 'GET', '/api/providers/limit-history?range=%20%207d%20', { since: sinceRange(7 * DAY) });
  add('GET range toString', 'GET', '/api/providers/limit-history?range=toString', { since: null });
  add('GET range valueOf', 'GET', '/api/providers/limit-history?range=valueOf', { since: null });
  add('GET range truncated', 'GET', '/api/providers/limit-history?range=123456789', { since: sinceRange(DAY) });
  add('GET range repeated', 'GET', '/api/providers/limit-history?range=7d&range=30d', { since: sinceRange(DAY) });
  add('GET range array', 'GET', '/api/providers/limit-history?range[]=7d', { since: sinceRange(DAY) });
  add('GET range utf8', 'GET', '/api/providers/limit-history?range=%E4%B8%AD%E6%96%87', { since: sinceRange(DAY) });

  // ── points ──────────────────────────────────────────────────────────────
  add('GET points 0', 'GET', '/api/providers/limit-history?points=0', { since: sinceRange(DAY), points: 48 });
  add('GET points 1', 'GET', '/api/providers/limit-history?points=1', { since: sinceRange(DAY), points: 2 });
  add('GET points 2', 'GET', '/api/providers/limit-history?points=2', { since: sinceRange(DAY), points: 2 });
  add('GET points 240', 'GET', '/api/providers/limit-history?points=240', { since: sinceRange(DAY), points: 240 });
  add('GET points 241', 'GET', '/api/providers/limit-history?points=241', { since: sinceRange(DAY), points: 240 });
  add('GET points 9999', 'GET', '/api/providers/limit-history?points=9999', { since: sinceRange(DAY), points: 240 });
  add('GET points -5', 'GET', '/api/providers/limit-history?points=-5', { since: sinceRange(DAY), points: 2 });
  add('GET points 2.9', 'GET', '/api/providers/limit-history?points=2.9', { since: sinceRange(DAY), points: 2 });
  add('GET points abc', 'GET', '/api/providers/limit-history?points=abc', { since: sinceRange(DAY), points: 48 });
  add('GET points empty', 'GET', '/api/providers/limit-history?points=', { since: sinceRange(DAY), points: 48 });
  add('GET points repeated', 'GET', '/api/providers/limit-history?points=5&points=6', { since: sinceRange(DAY), points: 48 });
  add('GET points array', 'GET', '/api/providers/limit-history?points[]=5', { since: sinceRange(DAY), points: 5 });
  // qs numeric indexes (Express runs qs with arrayLimit 1000): a single index
  // compacts to an array of one, several indexes join with ',' and become NaN.
  add('GET points index 0', 'GET', '/api/providers/limit-history?points[0]=5', { since: sinceRange(DAY), points: 5 });
  add('GET points index 1', 'GET', '/api/providers/limit-history?points[1]=5', { since: sinceRange(DAY), points: 5 });
  add('GET points indexes 0,1', 'GET', '/api/providers/limit-history?points[0]=5&points[1]=6', { since: sinceRange(DAY), points: 48 });
  add('GET points index 20', 'GET', '/api/providers/limit-history?points[20]=5', { since: sinceRange(DAY), points: 5 });
  add('GET points index 21', 'GET', '/api/providers/limit-history?points[21]=5', { since: sinceRange(DAY), points: 5 });
  add('GET points index 1000', 'GET', '/api/providers/limit-history?points[1000]=5', { since: sinceRange(DAY), points: 48 });
  add('GET points index encoded', 'GET', '/api/providers/limit-history?points%5B0%5D=5', { since: sinceRange(DAY), points: 5 });
  add('GET points index and push', 'GET', '/api/providers/limit-history?points[0]=5&points[]=6', { since: sinceRange(DAY), points: 48 });
  add('GET points nested index', 'GET', '/api/providers/limit-history?points[0][0]=5', { since: sinceRange(DAY), points: 5 });
  add('GET points infinity', 'GET', '/api/providers/limit-history?points=1e309', { since: sinceRange(DAY), points: 240 });
  add('GET points padded', 'GET', '/api/providers/limit-history?points=%20%207%20', { since: sinceRange(DAY), points: 7 });

  // ── since ───────────────────────────────────────────────────────────────
  add('GET since empty', 'GET', '/api/providers/limit-history?since=', { since: sinceRange(DAY) });
  add('GET since 0', 'GET', '/api/providers/limit-history?since=0', { since: sinceRange(DAY) });
  add('GET since -1', 'GET', '/api/providers/limit-history?since=-1', { since: sinceRange(DAY) });
  add('GET since 123 clamps', 'GET', '/api/providers/limit-history?since=123', { since: sinceValue(123) });
  add('GET since now-1d', 'GET', `/api/providers/limit-history?since=${now - DAY}`, { since: sinceValue(now - DAY) });
  add('GET since now-89d', 'GET', `/api/providers/limit-history?since=${now - 89 * DAY}`, { since: sinceValue(now - 89 * DAY) });
  add('GET since now-91d', 'GET', `/api/providers/limit-history?since=${now - 91 * DAY}`, { since: sinceValue(now - 91 * DAY) });
  add('GET since 1e309', 'GET', '/api/providers/limit-history?since=1e309', { since: sinceRange(DAY) });
  add('GET since 0x10', 'GET', '/api/providers/limit-history?since=0x10', { since: sinceValue(16) });
  add('GET since 1e3', 'GET', '/api/providers/limit-history?since=1e3', { since: sinceValue(1000) });
  add('GET since 1.5', 'GET', '/api/providers/limit-history?since=1.5', { since: sinceValue(1.5) });
  add('GET since repeated', 'GET', `/api/providers/limit-history?since=${now - DAY}&since=${now - 2 * DAY}`, { since: sinceRange(DAY) });
  add('GET since array', 'GET', `/api/providers/limit-history?since[]=${now - DAY}`, { since: sinceValue(now - DAY) });
  add('GET since index 0', 'GET', `/api/providers/limit-history?since[0]=${now - DAY}`, { since: sinceValue(now - DAY) });
  add('GET since object key', 'GET', '/api/providers/limit-history?since[a]=1', { since: sinceRange(DAY) });
  add('GET range index 0', 'GET', '/api/providers/limit-history?range[0]=7d', { since: sinceRange(DAY) });

  // ── appType / id ────────────────────────────────────────────────────────
  add('GET appType claude', 'GET', '/api/providers/limit-history?appType=claude', { since: sinceRange(DAY) });
  add('GET appType codex', 'GET', '/api/providers/limit-history?appType=codex', { since: sinceRange(DAY) });
  add('GET appType bogus', 'GET', '/api/providers/limit-history?appType=bogus', { since: sinceRange(DAY) });
  add('GET appType upper', 'GET', '/api/providers/limit-history?appType=CLAUDE', { since: sinceRange(DAY) });
  add('GET appType padded', 'GET', '/api/providers/limit-history?appType=%20claude%20', { since: sinceRange(DAY) });
  add('GET id alias', 'GET', '/api/providers/limit-history?appType=claude&id=claude-official', { since: sinceRange(DAY) });
  add('GET id account', 'GET', '/api/providers/limit-history?appType=claude&id=claude-official-0123456789abcdef', { since: sinceRange(DAY) });
  add('GET id codex account', 'GET', '/api/providers/limit-history?appType=codex&id=codex-official-aaaaaaaaaaaaaaaa', { since: sinceRange(DAY) });
  add('GET id missing', 'GET', '/api/providers/limit-history?appType=claude&id=missing', { since: sinceRange(DAY) });
  add('GET id 81 chars', 'GET', `/api/providers/limit-history?appType=claude&id=${'x'.repeat(81)}`, { since: sinceRange(DAY) });
  add('GET id unicode', 'GET', `/api/providers/limit-history?id=${encodeURIComponent('线路一')}`, { since: sinceRange(DAY) });
  add('GET id empty', 'GET', '/api/providers/limit-history?appType=claude&id=', { since: sinceRange(DAY) });
  add('GET id numeric record', 'GET', '/api/providers/limit-history?id=42', { since: sinceRange(DAY) });

  // ── providers.json shapes ───────────────────────────────────────────────
  const shape = (name, providers, extra = {}) => add(name, 'GET', '/api/providers/limit-history',
    { state: { providers, accounts: 'none', selection: { claude: 'global', codex: 'global' } }, since: sinceRange(DAY), ...extra });
  shape('GET providers missing', undefined);
  shape('GET providers empty', []);
  shape('GET providers envelope', { version: 3, keep: true, providers: RICH_PROVIDERS });
  shape('GET providers official claude hidden', [{ id: 'c-official-shape', appType: 'claude', settingsConfig: { env: {} } }, RICH_PROVIDERS[0]]);
  shape('GET providers official codex hidden', [{ id: 'x-official-shape', appType: 'codex', settingsConfig: { auth: { auth_mode: 'chatgpt' }, config: '' } }, RICH_PROVIDERS[1]]);
  shape('GET providers duplicate id', [RICH_PROVIDERS[2], RICH_PROVIDERS[3]]);
  shape('GET providers numeric id', [RICH_PROVIDERS[4]]);
  shape('GET providers unicode id', [RICH_PROVIDERS[5]]);
  shape('GET providers alias id hidden', [{ id: 'claude-official', appType: 'claude', settingsConfig: { env: {} } }]);
  shape('GET providers account id hidden', [{ id: 'codex-official-0123456789abcdef', appType: 'codex', egressIpAllowlist: ['1.2.3.4'] }]);
  shape('GET providers wrong pool', [RICH_PROVIDERS[10]]);
  shape('GET providers invalid json', '{not json');
  shape('GET providers null record', '[null]');
  shape('GET providers non-object', '[5,"x",true]');
  shape('GET providers settingsConfig null', [{ id: 'c-null', appType: 'claude', settingsConfig: 'null' }]);
  shape('GET providers codex legacy ccswitch', [{ id: 'codex-official', source: 'ccswitch', appType: 'codex', settingsConfig: { auth: {}, config: '' } }]);

  // ── official accounts ───────────────────────────────────────────────────
  const account = (name, accounts, selection = { claude: 'global', codex: 'global' }) => add(name, 'GET', '/api/providers/limit-history',
    { state: { providers: RICH_PROVIDERS, accounts, selection }, since: sinceRange(DAY) });
  account('GET accounts none', 'none');
  account('GET accounts claude', { claude: RICH_ACCOUNTS.claude, codex: [] });
  account('GET accounts codex', { claude: [], codex: RICH_ACCOUNTS.codex });
  account('GET accounts tie', { claude: RICH_ACCOUNTS.claude.slice(0, 3), codex: [] });
  account('GET accounts all', RICH_ACCOUNTS);
  add('GET accounts codex no auth', 'GET', '/api/providers/limit-history',
    { state: { providers: RICH_PROVIDERS, accounts: { claude: [], codex: [{ id: 'dddddddddddddddd', meta: { label: 'no auth', createdAt: 5 } }] }, selection: { claude: 'global', codex: 'global' } }, since: sinceRange(DAY) });
  add('GET accounts codex invalid auth', 'GET', '/api/providers/limit-history',
    { state: { providers: RICH_PROVIDERS, accounts: { claude: [], codex: [{ id: 'eeeeeeeeeeeeeeee', meta: { createdAt: 5 }, auth: '{broken' }] }, selection: { claude: 'global', codex: 'global' } }, since: sinceRange(DAY) });
  add('GET accounts claude invalid', 'GET', '/api/providers/limit-history',
    { state: { providers: RICH_PROVIDERS, accounts: { claude: [{ id: 'ffffffffffffffff', data: '{broken' }], codex: [] }, selection: { claude: 'global', codex: 'global' } }, since: sinceRange(DAY) });

  // ── selection ───────────────────────────────────────────────────────────
  const selection = (name, value) => add(name, 'GET', '/api/providers/limit-history',
    { state: { providers: RICH_PROVIDERS, accounts: RICH_ACCOUNTS, selection: value }, since: sinceRange(DAY) });
  selection('GET selection missing', undefined);
  selection('GET selection global', { claude: 'global', codex: 'global' });
  selection('GET selection valid', { claude: '0123456789abcdef', codex: 'aaaaaaaaaaaaaaaa' });
  selection('GET selection invalid string', { claude: 'zzz', codex: 'global' });
  selection('GET selection broken json', '{broken');
  selection('GET selection null document', 'null');
  selection('GET selection array document', '[]');

  // ── methods / paths ─────────────────────────────────────────────────────
  add('HEAD', 'HEAD', '/api/providers/limit-history', { since: sinceRange(DAY), points: 48 });
  add('OPTIONS', 'OPTIONS', '/api/providers/limit-history');
  add('GET trailing slash', 'GET', '/api/providers/limit-history/', { since: sinceRange(DAY) });
  add('GET mixed case path', 'GET', '/api/Providers/Limit-History', { since: sinceRange(DAY) });
  add('POST unclaimed', 'POST', '/api/providers/limit-history', { unclaimed: true });
  add('PUT unclaimed', 'PUT', '/api/providers/limit-history', { unclaimed: true });
  add('DELETE unclaimed', 'DELETE', '/api/providers/limit-history', { unclaimed: true });
  // Express routes case-insensitively and decodes %2D before matching, the
  // front door does neither. Those two reach Node today and will reach the
  // leftover Node 404 after the move, so for them Node is only neutralised and
  // Rust must forward (intentional difference, documented in docs/gateway.md).
  add('GET uppercase prefix', 'GET', '/API/providers/limit-history', { unclaimed: 'forwardOnly' });
  add('GET double slash', 'GET', '/api/providers/limit-history//', { unclaimed: true });
  add('GET percent encoded', 'GET', '/api/providers/limit%2Dhistory', { unclaimed: true });

  // ── caching / gzip / request id ─────────────────────────────────────────
  add('GET gzip', 'GET', '/api/providers/limit-history', { headers: { ...LOCAL, 'Accept-Encoding': 'gzip, deflate' }, since: sinceRange(DAY) });
  add('GET x-gzip word', 'GET', '/api/providers/limit-history', { headers: { ...LOCAL, 'Accept-Encoding': 'x-gzip' }, since: sinceRange(DAY) });
  add('GET no request id', 'GET', '/api/providers/limit-history', { headers: { Host: 'localhost', 'X-Request-Id': 'bad id!', 'X-Correlation-Id': 'corr-1' }, since: sinceRange(DAY) });

  // ── auth ────────────────────────────────────────────────────────────────
  add('GET remote no auth', 'GET', '/api/providers/limit-history', { headers: REMOTE, unclaimed: false, since: null, available: undefined });
  add('GET remote token ok', 'GET', '/api/providers/limit-history', { headers: { ...REMOTE, 'X-Access-Token': 'secret-token-1' }, since: sinceRange(DAY) });
  add('GET remote token bad', 'GET', '/api/providers/limit-history', { headers: { ...REMOTE, 'X-Access-Token': 'nope' } });
  add('GET remote machine grant', 'GET', '/api/providers/limit-history', { headers: { ...REMOTE, 'X-Access-Token': 'secret-token-1', 'X-Multicc-Machine-Grant': `mcg_${'a'.repeat(48)}` }, since: sinceRange(DAY) });
  add('GET loopback forwarded', 'GET', '/api/providers/limit-history', { headers: { ...LOCAL, 'X-Forwarded-For': '1.2.3.4' }, since: sinceRange(DAY) });
  add('GET tailscale host', 'GET', '/api/providers/limit-history', { headers: { Host: 'mac.tail1.ts.net', 'X-Request-Id': 'diff-req-1' } });
  add('GET remote cookie bad', 'GET', '/api/providers/limit-history', { headers: { ...REMOTE, Cookie: 'multicc_auth=x.y' } });

  return cases;
}

// Conditional requests need the first answer's etag; the corpus is a function
// in lib.js, so append them here with side state captured by `capture`.
function withConditionals(cases) {
  // generatedAt is part of the body, so a byte-identical ETag hit cannot be
  // arranged across two requests; '*' is the deterministic 304 path.
  cases.push(conditional('GET if-none-match hit', etag => etag, { since: sinceRange(DAY) }));
  cases.push(conditional('GET if-none-match miss', () => 'W/"bogus"', { since: sinceRange(DAY) }));
  cases.push(conditional('GET if-none-match star', () => '*', { since: null }));
  cases.push(conditional('GET if-none-match no-cache', etag => etag, {
    headers: { ...LOCAL, 'Cache-Control': 'no-cache' }, since: sinceRange(DAY),
  }));
  return cases;
}

// ── final comparison (stores are binary; rows, not WAL) ────────────────────

function readDb(dir) {
  const file = path.join(dir, 'provider-quota-history.db');
  if (!fs.existsSync(file)) return { exists: false };
  const mode = (fs.statSync(file).mode & 0o777).toString(8);
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(
      'SELECT app_type, provider_id, series, sampled_at, remaining, label, unit, reset_at FROM provider_quota_samples ORDER BY app_type, provider_id, series, sampled_at',
    ).all();
    db.close();
    return { exists: true, mode, rows: rows.length, digest: digest(rows) };
  } catch (error) {
    return { exists: true, mode, unreadable: String(error.message || error) };
  }
}

function digest(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function finalize(group) {
  return async ({ views, nodeData, gwData, work }) => {
    fs.mkdirSync(BASE, { recursive: true });
    fs.writeFileSync(path.join(BASE, `baseline-${group}.json`), JSON.stringify(views.map(v => ({ name: v.name, node: v.node })), null, 2));
    const node = readDb(nodeData);
    const rust = readDb(gwData);
    const same = JSON.stringify(node) === JSON.stringify(rust);
    console.log(`[provider-limit-history:${group}] db ${same ? 'identical' : 'DIFFERENT'} node=${JSON.stringify(node)} rust=${JSON.stringify(rust)}; work ${work}`);
    return { ok: same, db: { same, node, rust } };
  };
}

// ── groups ─────────────────────────────────────────────────────────────────

function basicCorpus(available, cases) {
  return [
    caseOf('GET unavailable', 'GET', '/api/providers/limit-history', { state: RICH_STATE, available, since: sinceRange(DAY), points: 48 }),
    caseOf('GET unavailable again', 'GET', '/api/providers/limit-history?range=7d', { state: RICH_STATE, available, since: sinceRange(7 * DAY) }),
    caseOf('HEAD unavailable', 'HEAD', '/api/providers/limit-history', { state: RICH_STATE, available, since: sinceRange(DAY), points: 48 }),
    caseOf('OPTIONS unavailable', 'OPTIONS', '/api/providers/limit-history', { state: RICH_STATE }),
    caseOf('GET unavailable appType', 'GET', '/api/providers/limit-history?appType=claude&points=3', { state: RICH_STATE, available, since: sinceRange(DAY), points: 3 }),
    ...cases,
  ];
}

function specFor(group) {
  const spec = {
    name: `provider-limit-history-${group}`,
    seed(dir) {
      if (NODE_DATA === null) NODE_DATA = dir;
      else GW_DATA = dir;
      fs.mkdirSync(dir, { recursive: true });
      writeJsonFile(path.join(dir, 'providers.json'), RICH_PROVIDERS);
      writeJsonFile(path.join(dir, 'official-provider-selection.json'), { claude: 'global', codex: 'global' });
      if (group === 'unavailable-garbage') {
        fs.writeFileSync(path.join(dir, 'provider-quota-history.db'), 'not a sqlite database\n');
      }
      if (group === 'unavailable-readonly') {
        const file = path.join(dir, 'provider-quota-history.db');
        fs.writeFileSync(file, '');
        fs.chmodSync(file, 0o444);
      }
    },
    mount(app, { dataRoot }) {
      // The real server enables the official catalog before mounting routes;
      // MULTICC_DATA_DIR must be set before core.js pins its paths.
      // The relative-data-dir group proves Node resolves a relative root against
      // the package root (src/paths.js `path.resolve(PKG_ROOT, raw)`), not cwd.
      process.env.MULTICC_DATA_DIR = group === 'relative-data-dir'
        ? path.relative(ROOT, dataRoot) : dataRoot;
      const providers = require(path.join(ROOT, 'src/providers/core.js'));
      providers.enableUnifiedOfficialProviders();
      const history = ORACLE.createLegacyProviderQuotaHistory({
        file: path.join(dataRoot, 'provider-quota-history.db'),
        logger: { warn() {} },
      });
      ORACLE.mountLegacyProviderLimitHistoryRoutes(app, { history, providers });
    },
    finalize: finalize(group),
    upstream: UPSTREAM,
    // The stub child loads the real napi auth security, so it needs the addon
    // path the harness resolved from argv.
    // relative-data-dir: the gateway's package root is <work>/gw (`--cwd`,
    // server.js there), so a relative root must resolve there too; if it
    // resolved against the inherited process cwd the seeded stores would be
    // somewhere else and every answer below would differ.
    gatewayEnv: (work) => ({
      MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
      ...(group === 'relative-data-dir'
        ? { MULTICC_DATA_DIR: path.relative(path.join(work, 'gw'), path.join(work, 'gw-data')) }
        : {}),
    }),
  };
  if (group === 'default') spec.corpus = () => withConditionals(corpus());
  else if (group === 'empty-db') {
    spec.corpus = () => [
      caseOf('GET empty db', 'GET', '/api/providers/limit-history', { since: sinceRange(DAY), points: 48 }),
      caseOf('GET empty db appType', 'GET', '/api/providers/limit-history?appType=codex', { since: sinceRange(DAY) }),
      caseOf('HEAD empty db', 'HEAD', '/api/providers/limit-history', { since: sinceRange(DAY), points: 48 }),
    ];
  } else if (group === 'fresh-db') {
    // Nothing is seeded at all: the route's first open creates the schema.
    spec.seed = (dir) => {
      if (NODE_DATA === null) NODE_DATA = dir; else GW_DATA = dir;
      fs.mkdirSync(dir, { recursive: true });
      writeJsonFile(path.join(dir, 'providers.json'), []);
      writeJsonFile(path.join(dir, 'official-provider-selection.json'), { claude: 'global', codex: 'global' });
    };
    spec.corpus = () => [
      caseOf('GET fresh db', 'GET', '/api/providers/limit-history', { state: { providers: [], accounts: 'none', selection: { claude: 'global', codex: 'global' } }, since: sinceRange(DAY), points: 48 }),
      caseOf('GET fresh db again', 'GET', '/api/providers/limit-history', { state: { providers: [], accounts: 'none', selection: { claude: 'global', codex: 'global' } }, since: sinceRange(DAY), points: 48 }),
    ];
  } else if (group === 'relative-data-dir') {
    // Both sides read their seeded providers.json and sample DB through a
    // relative MULTICC_DATA_DIR, resolved against each side's package root.
    spec.corpus = () => [
      caseOf('GET relative defaults', 'GET', '/api/providers/limit-history', { since: sinceRange(DAY), points: 48, available: true }),
      caseOf('GET relative range 7d', 'GET', '/api/providers/limit-history?range=7d', { since: sinceRange(7 * DAY) }),
      caseOf('GET relative points 3', 'GET', '/api/providers/limit-history?points=3', { since: sinceRange(DAY), points: 3 }),
      caseOf('GET relative appType', 'GET', '/api/providers/limit-history?appType=codex', { since: sinceRange(DAY) }),
      caseOf('HEAD relative', 'HEAD', '/api/providers/limit-history', { since: sinceRange(DAY), points: 48 }),
    ];
  } else {
    spec.corpus = () => basicCorpus(false, []);
  }
  return spec;
}

// ── entry point ────────────────────────────────────────────────────────────

async function main() {
  prepareEnvironment();
  const [, , , addon] = process.argv;
  const argv = process.argv.slice(2, 5);
  if (GROUP) {
    const ok = await run(specFor(GROUP), argv).catch((error) => {
      console.error(error);
      return false;
    });
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (!addon) throw new Error('usage: <repo> <multicc-gateway> <multicc_core.node>');
  let failed = false;
  for (const group of GROUPS) {
    try {
      execFileSync(process.execPath, [__filename, ...argv, group], { stdio: 'inherit', env: process.env });
    } catch (_) {
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
