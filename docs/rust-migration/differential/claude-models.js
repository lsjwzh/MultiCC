'use strict';
// Differential run for GET/HEAD/OPTIONS /api/claude/models.
//
//   node docs/rust-migration/differential/claude-models.js \
//     <repo> <multicc-gateway> <multicc_core.node> [group]
//
// With no group it forks one child per group (a fresh module cache is needed:
// both the oracle and the gateway process pin their caches at load time).
// Any single group runs on its own, e.g. the mtime/cache edge cases:
//
//   MULTICC_RUST_ADDON=<prebuilt>/darwin-arm64/multicc_core.node \
//   MULTICC_RUST_PREBUILT_DIR=<prebuilt> \
//   node docs/rust-migration/differential/claude-models.js \
//     . <prebuilt>/darwin-arm64/multicc-gateway \
//     <prebuilt>/darwin-arm64/multicc_core.node edge
//
// `edge` also carries the two `refresh[toString]` cases that are *expected* to
// differ; they use hooks.expectedDifference, are validated per side and are
// reported apart from the byte-for-byte same count.
//
// The Node side is the frozen oracle in
// tests/helpers/legacy-claude-models-route.js running the real Express
// pipeline and auth runtime. The Rust side is the release multicc-gateway.
// Both read the same isolated HOME fixture (the CLI bundle shim), so every
// response is compared byte for byte with no normalization: the route has no
// clock- or random-derived fields.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { run, send } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ORACLE = require(path.join(ROOT, 'tests/helpers/legacy-claude-models-route.js'));
const { listClaudeModelsSync, _resetCacheForTest } = require(path.join(ROOT, 'src/claude-models.js'));

const GROUP = process.argv[5] || '';
const BASE = process.env.CM_WORK || '/tmp/claude-models-port';
const HOME = path.join(BASE, 'home');
const REAL_HOME = process.env.HOME;
const REAL_SHIM = REAL_HOME ? path.join(REAL_HOME, '.local', 'bin', 'claude') : '';
const GROUPS = ['default', 'fallback', 'window', 'semantics', 'fuzz', 'concurrent', 'edge', 'real-bundle', 'relative-data-dir'];

const CHUNK = 4 * 1024 * 1024;
const OVERLAP = 64;
const T0 = 1_700_000_000;
const LOCAL = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const REMOTE = { Host: 'box.example.com', 'X-Request-Id': 'diff-req-1' };

const BUNDLE = path.join(HOME, '.local', 'share', 'claude', 'versions', '1.0.0');
const BUNDLE2 = path.join(HOME, '.local', 'share', 'claude', 'versions', '2.0.0');
const SHIM = path.join(HOME, '.local', 'bin', 'claude');

// ── environment / fixture helpers ──────────────────────────────────────────

function prepareEnvironment() {
  fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.HOME = HOME;
  process.env.TMPDIR = path.join(BASE, 'tmp');
}

function resetHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
}

function putFile(file, bytes, seconds = T0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, seconds, seconds);
}

function linkShim(version = '1.0.0') {
  fs.mkdirSync(path.dirname(SHIM), { recursive: true });
  fs.rmSync(SHIM, { force: true });
  fs.symlinkSync(path.join(HOME, '.local', 'share', 'claude', 'versions', version), SHIM);
}

function fixture(bytes, { version = '1.0.0', seconds = T0 } = {}) {
  putFile(path.join(HOME, '.local', 'share', 'claude', 'versions', version), bytes, seconds);
  linkShim(version);
}

function request(method, url, headers = LOCAL) {
  return { method, url, headers };
}

// The default group's small bundle.
const SMALL = Buffer.from(
  'xx claude-opus-4-8 claude-opus-4-8[1m] claude-sonnet-4-6-20251114 claude-sonnet-4.6 '
  + 'claude-fable-5 claude-haiku-4-5-20251001 zz',
);

function bigBundle() {
  const parts = [];
  for (const family of ['opus', 'sonnet', 'fable', 'haiku']) {
    for (const label of ['1000000000', '999999999']) {
      parts.push(`claude-${family}-${label}[1m] claude-${family}-${label}`);
    }
  }
  return Buffer.from(parts.join('\n'));
}

// ── unclaimed shapes (forwarding only) ─────────────────────────────────────

const FORWARDED = 'gateway-forwarded:';

function isForwarded(view) {
  return view.status === 599 && String(view.body || '').startsWith(FORWARDED);
}

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

function capture(raw, side) {
  side.state.etag = raw.headers.etag;
  side.state.status = raw.status;
}

// ── corpora ────────────────────────────────────────────────────────────────

function defaultCorpus(ctx) {
  const cases = [];
  const add = (name, method, url, before, normalize, headers = LOCAL) => {
    cases.push([name, request(method, url, headers), { before, capture, normalize }]);
  };
  const same = () => fixture(SMALL);
  const prime = () => fixture(SMALL);

  add('GET first cli', 'GET', '/api/claude/models', prime);
  add('GET cached', 'GET', '/api/claude/models', same);
  for (const value of ['?refresh=1', '?refresh=true', '?refresh=TRUE', '?refresh=True',
    '?refresh=yes', '?refresh=0', '?refresh=', '?refresh[]=1', '?refresh[0]=1',
    '?refresh[a]=1', '?refresh=1&refresh=1', '?refresh[]=true']) {
    add(`GET ${value}`, 'GET', `/api/claude/models${value}`, same);
  }
  // Bundle identity: mtime, size, then the shim retargeting to another version.
  add('GET mtime change', 'GET', '/api/claude/models', () => fixture(SMALL, { seconds: T0 + 10 }));
  add('GET size change', 'GET', '/api/claude/models', () => fixture(Buffer.concat([SMALL, Buffer.from(' claude-opus-6')]), { seconds: T0 + 20 }));
  add('GET shim retarget', 'GET', '/api/claude/models', () => {
    putFile(BUNDLE2, Buffer.from('claude-opus-9 claude-sonnet-9-1'), T0 + 30);
    linkShim('2.0.0');
  });
  add('GET after retarget cached', 'GET', '/api/claude/models', () => {});
  add('HEAD', 'HEAD', '/api/claude/models', () => {});
  add('OPTIONS', 'OPTIONS', '/api/claude/models', () => {});
  add('GET trailing slash', 'GET', '/api/claude/models/', () => {});
  add('GET mixed case path', 'GET', '/api/Claude/Models', () => {});
  add('HEAD trailing slash', 'HEAD', '/api/claude/models/', () => {});
  // gzip threshold: this bundle curates 16 rows and the body exceeds 1 KiB.
  add('GET gzip large', 'GET', '/api/claude/models?refresh=1', () => fixture(bigBundle()),
    null, { ...LOCAL, 'Accept-Encoding': 'gzip, deflate' });
  add('GET gzip small', 'GET', '/api/claude/models?refresh=1', same,
    null, { ...LOCAL, 'Accept-Encoding': 'gzip, deflate' });
  add('GET gzip x-gzip word', 'GET', '/api/claude/models?refresh=1', same,
    null, { ...LOCAL, 'Accept-Encoding': 'x-gzip' });
  add('GET no request id', 'GET', '/api/claude/models', () => {},
    null, { Host: 'localhost', 'X-Request-Id': 'bad id!', 'X-Correlation-Id': 'corr-1' });
  // Conditional requests reuse the same side's ETag from the previous answer;
  // the cached body is stable, so the ETag is identical across requests.
  cases.push(['GET if-none-match hit', (side) => request('GET', '/api/claude/models',
    { ...LOCAL, 'If-None-Match': side.state.etag }), { capture }]);
  cases.push(['GET if-none-match star', request('GET', '/api/claude/models', { ...LOCAL, 'If-None-Match': '*' }), { capture }]);
  cases.push(['GET if-none-match miss', request('GET', '/api/claude/models', { ...LOCAL, 'If-None-Match': 'W/"bogus"' }), { capture }]);
  cases.push(['GET if-none-match no-cache', (side) => request('GET', '/api/claude/models',
    { ...LOCAL, 'If-None-Match': side.state.etag, 'Cache-Control': 'no-cache' }), { capture }]);
  // Methods/paths the front door never claims: compare forwarding only.
  add('POST unclaimed', 'POST', '/api/claude/models', () => {},
    (view, side) => unclaimed(view, side));
  add('PUT unclaimed', 'PUT', '/api/claude/models', () => {},
    (view, side) => unclaimed(view, side));
  add('DELETE unclaimed', 'DELETE', '/api/claude/models', () => {},
    (view, side) => unclaimed(view, side));
  add('GET double slash', 'GET', '/api/claude/models//', () => {},
    (view, side) => unclaimed(view, side));
  add('GET percent encoded', 'GET', '/api/clau%64e/models', () => {},
    (view, side) => unclaimed(view, side));
  add('GET uppercase prefix', 'GET', '/API/claude/models', () => {},
    (view, side) => unclaimed(view, side, 'forwardOnly'));
  // Auth matrix.
  add('GET remote no auth', 'GET', '/api/claude/models', () => {}, null, REMOTE);
  add('GET remote token ok', 'GET', '/api/claude/models', () => {},
    null, { ...REMOTE, 'X-Access-Token': 'secret-token-1' });
  add('GET remote token bad', 'GET', '/api/claude/models', () => {},
    null, { ...REMOTE, 'X-Access-Token': 'nope' });
  cases.push(['GET remote cookie ok', request('GET', '/api/claude/models',
    { ...REMOTE, Cookie: ctx.cookie }), { capture }]);
  add('GET remote cookie bad', 'GET', '/api/claude/models', () => {},
    null, { ...REMOTE, Cookie: 'multicc_auth=x.y' });
  add('GET loopback forwarded', 'GET', '/api/claude/models', () => {},
    null, { ...LOCAL, 'X-Forwarded-For': '1.2.3.4' });
  add('GET tailscale host', 'GET', '/api/claude/models', () => {},
    null, { Host: 'mac.tail1.ts.net', 'X-Request-Id': 'diff-req-1' });
  // Bundle resolution positives: newest versions entry wins; a dangling shim
  // falls back to the versions dir.
  add('GET versions newest by mtime', 'GET', '/api/claude/models', () => {
    resetHome();
    const dir = path.join(HOME, '.local', 'share', 'claude', 'versions');
    putFile(path.join(dir, '1.0.0'), Buffer.from('claude-opus-1'), T0);
    putFile(path.join(dir, '2.0.0'), Buffer.from('claude-opus-2'), T0 + 100);
    putFile(path.join(dir, '3.0.0'), Buffer.from('claude-opus-3'), T0 + 50);
    fs.mkdirSync(path.join(dir, '4.0.0-dir'), { recursive: true });
    fs.symlinkSync('/nonexistent-claude-bundle', path.join(dir, '9.0.0'));
  });
  add('GET dangling shim uses versions', 'GET', '/api/claude/models?refresh=1', () => {
    fs.mkdirSync(path.dirname(SHIM), { recursive: true });
    fs.rmSync(SHIM, { force: true });
    fs.symlinkSync('/nonexistent-claude-shim', SHIM);
    putFile(path.join(HOME, '.local', 'share', 'claude', 'versions', '7.0.0'), Buffer.from('claude-opus-7'), T0 + 200);
  });
  return cases;
}

function fallbackCorpus() {
  const cases = [];
  const twice = (name, build) => {
    for (const repeat of ['', ' again']) {
      cases.push([name + repeat, request('GET', '/api/claude/models'), {
        before: build,
        capture,
      }]);
    }
  };
  twice('missing home', () => resetHome());
  twice('empty bundle', () => { resetHome(); fixture(Buffer.alloc(0)); });
  twice('no match', () => { resetHome(); fixture(Buffer.from('nothing model-like here')); });
  twice('unknown family only', () => { resetHome(); fixture(Buffer.from('claude-gpt-5 claude-opus-6x')); });
  twice('unreadable bundle', () => {
    resetHome();
    const file = path.join(HOME, '.local', 'share', 'claude', 'versions', '1.0.0');
    fixture(SMALL);
    fs.chmodSync(file, 0o000);
  });
  twice('directory bundle', () => {
    resetHome();
    fs.mkdirSync(path.join(HOME, '.local', 'share', 'claude', 'versions', '1.0.0'), { recursive: true });
    leafDirShim('1.0.0');
  });
  twice('versions dir only subdir', () => {
    resetHome();
    const dir = path.join(HOME, '.local', 'share', 'claude', 'versions');
    fs.mkdirSync(path.join(dir, '1.0.0'), { recursive: true });
    fs.mkdirSync(path.join(dir, '2.0.0'), { recursive: true });
  });
  return cases;
}

function leafDirShim(version) {
  fs.mkdirSync(path.dirname(SHIM), { recursive: true });
  fs.rmSync(SHIM, { force: true });
  fs.symlinkSync(path.join(HOME, '.local', 'share', 'claude', 'versions', version), SHIM);
}

// window group: ids straddling the 4 MiB and 8 MiB window boundaries.
function windowCorpus() {
  const cases = [];
  const families = ['opus', 'sonnet', 'fable', 'haiku'];
  const id = (family, major) => `claude-${family}-${major}`;
  // Place one observable id per family (huge major so it wins curation; the
  // small decoy only shows up if the boundary id was missed).
  function bundle(placements) {
    const size = 2 * CHUNK + 4096;
    const buf = Buffer.alloc(size, 0x20);
    families.forEach((family, index) => {
      const spot = placements[index];
      const text = Buffer.from(id(family, 900000 + index));
      const at = spot.endAt === undefined ? spot.at : spot.endAt - (spot.back || 0) - text.length;
      text.copy(buf, at);
      spot.at = at;
      if (spot.before !== undefined) buf[spot.at - 1] = spot.before;
      if (spot.after !== undefined) buf[spot.at + text.length] = spot.after;
      const decoy = Buffer.from(` ${id(family, 1)} `);
      decoy.copy(buf, 8);
    });
    return buf;
  }
  const add = (name, placements) => {
    cases.push([name, request('GET', '/api/claude/models?refresh=1'), {
      before: () => fixture(bundle(placements)),
      capture,
    }]);
  };
  const word = 0x78; // 'x': \w, blocks the lookbehind
  const dash = 0x2d; // '-': blocks the lookbehind and the lookahead
  const under = 0x5f;

  add('4MiB starts k=63/64/65/0 preceded by word', families.map((family, index) => ({
    at: CHUNK - [63, 64, 65, 0][index],
    before: word,
  })));
  add('4MiB starts k=63/64/65/0 preceded by dash', families.map((family, index) => ({
    at: CHUNK - [63, 64, 65, 0][index],
    before: dash,
  })));
  add('4MiB starts k=63/64/65/0 preceded by underscore', families.map((family, index) => ({
    at: CHUNK - [63, 64, 65, 0][index],
    before: under,
  })));
  add('8MiB starts k=63/64/65/0 preceded by word', families.map((family, index) => ({
    at: 2 * CHUNK - [63, 64, 65, 0][index],
    before: word,
  })));
  // One family ends exactly at the window end (the next file byte, a digit,
  // is never read), the others end fully inside the window and are followed
  // by a space.
  add('window end exactly after id, next byte word/dash/underscore/digit', families.map((family, index) => (
    index === 3
      ? { endAt: CHUNK + OVERLAP, after: 0x37 }
      : { endAt: CHUNK + OVERLAP, back: 30 * (index + 1), after: 0x20 })));
  add('id ends one byte before window end, next byte word', families.map((family, index) => (
    index === 3
      ? { endAt: CHUNK + OVERLAP - 1, after: word }
      : { endAt: CHUNK + OVERLAP - 1, back: 30 * (index + 1), after: 0x20 })));
  add('8MiB window end exactly after id', families.map((family, index) => (
    index === 3
      ? { endAt: 2 * CHUNK + OVERLAP, after: 0x37 }
      : { endAt: 2 * CHUNK + OVERLAP, back: 30 * (index + 1), after: 0x20 })));
  add('id fully inside window but after a blocking byte', families.map((family, index) => ({
    at: CHUNK + 100 + 100 * index,
    before: word,
  })));
  return cases;
}

function semanticsCorpus() {
  const cases = [];
  const add = (name, bytes, extra = '') => {
    cases.push([name, request('GET', `/api/claude/models?refresh=1${extra}`), {
      before: () => fixture(Buffer.from(bytes)),
      capture,
    }]);
  };
  add('1m variants and plain', 'claude-opus-5 claude-opus-5[1m]');
  add('1m dated id', 'claude-opus-5-20250514[1m]');
  add('uppercase 1M ignored', 'claude-opus-5[1M]');
  add('1m skipped by lookahead', 'claude-opus-5[1m]x');
  add('date collapse', 'claude-opus-4-20250514 claude-sonnet-4-6-20251114');
  add('dot minor', 'claude-sonnet-4.6 claude-opus-5.12');
  add('three digit minor rejected', 'claude-opus-5-123 claude-opus-5.123');
  add('substring rejected', 'xclaude-opus-5 -claude-opus-5 _claude-opus-5 claude-opus-5x');
  add('unknown family ignored', 'claude-gpt-5 claude-opus-6');
  add('fable before haiku', 'claude-haiku-4-5 claude-fable-5');
  add('newest two per family', 'claude-opus-5-1 claude-opus-5 claude-opus-4-8 claude-opus-4-7');
  add('equal version and length ties', 'claude-opus-04-1 claude-opus-4-01');
  add('huge digits', `claude-opus-${'9'.repeat(21)}`);
  add('invalid utf8 around id', Buffer.concat([Buffer.from([0xff]), Buffer.from('claude-opus-5'), Buffer.from([0xff])]));
  add('invalid utf8 in 1m tail', Buffer.concat([Buffer.from('claude-opus-5[1m]'), Buffer.from([0xff])]));
  // The 500-id early return: a marker id after the 500th distinct id must not
  // appear; the same marker at position 499 must.
  const many = (markerAt) => {
    const parts = [];
    for (let index = 0; index < 500; index++) {
      parts.push(index === markerAt ? 'claude-opus-999999' : `claude-opus-${index + 1}`);
    }
    if (markerAt === 500) parts.push('claude-opus-999999');
    return parts.join(' ');
  };
  add('500 ids marker after limit', many(500));
  add('500 ids marker at position 499', many(499));
  return cases;
}

// ── fuzz ───────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzBundles(count) {
  const random = mulberry32(0xC1A0DE);
  const alphabet = 'claude-opus-sonnet-haiku-fable-.0123456789[]m1 xyz_\n';
  const tokens = [
    'claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5',
    'claude-opus-4-8[1m]', 'claude-opus-4.8', 'claude-sonnet-4.6',
    'claude-opus-4-20250514', 'claude-opus-5-20250514[1m]', 'xclaude-opus-5',
    'claude-opus-5x', 'claude-opus-5[1M]', 'claude-gpt-5', 'claude-opus-5-123',
    'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-999999999999',
  ];
  const bundles = [];
  for (let index = 0; index < count; index++) {
    const length = 200 + Math.floor(random() * 3800);
    const bytes = Buffer.alloc(length);
    for (let offset = 0; offset < length; offset++) {
      const roll = random();
      if (roll < 0.02) bytes[offset] = 0x80 + Math.floor(random() * 0x7f);
      else bytes[offset] = alphabet.charCodeAt(Math.floor(random() * alphabet.length));
    }
    const inserts = 1 + Math.floor(random() * 6);
    for (let n = 0; n < inserts; n++) {
      const token = Buffer.from(tokens[Math.floor(random() * tokens.length)]);
      const at = Math.floor(random() * Math.max(1, length - token.length));
      token.copy(bytes, at);
    }
    // A few cases straddle the (tiny) window edge by seeding the token at a
    // position derived from the real boundary, near the start or end.
    if (index % 7 === 0) Buffer.from(`claude-opus-${900000 + index}`).copy(bytes, Math.max(0, Math.min(length - 20, random() < 0.5 ? 0 : length - 20)));
    bundles.push(bytes);
  }
  return bundles;
}

function fuzzCorpus() {
  const bundles = fuzzBundles(1200);
  return bundles.map((bytes, index) => [
    `fuzz ${index}`,
    request('GET', '/api/claude/models?refresh=1'),
    { before: () => fixture(bytes, { seconds: T0 + index }), capture },
  ]);
}

function concurrentCorpus() {
  return [[
    'cold concurrent 8',
    request('GET', '/api/claude/models'),
    {
      before: async (side) => {
        fixture(SMALL);
        const answers = await Promise.all(Array.from({ length: 8 }, () =>
          send(side.port, request('GET', '/api/claude/models'))
            .then(raw => JSON.parse(raw.body.toString('utf8')))));
        side.state.sources = answers.map(answer => answer.source);
      },
      capture,
    },
  ]];
}

function realBundleCorpus() {
  return [[
    'real bundle first cli',
    request('GET', '/api/claude/models?refresh=1'),
    {
      before: (side) => {
        side.state.t0 = Date.now();
        resetHome();
        fixture(SMALL); // create dirs, then point at the real bundle
        const real = fs.realpathSync(REAL_SHIM);
        const stat = fs.statSync(real);
        if (!stat.isFile()) throw new Error('real claude bundle is not a file');
        fs.rmSync(SHIM, { force: true });
        fs.symlinkSync(real, SHIM);
      },
      capture,
      normalize: (view, side) => {
        side.state.ms = Date.now() - side.state.t0;
        return view;
      },
    },
  ], [
    'real bundle cached',
    request('GET', '/api/claude/models'),
    { before: () => {}, capture },
  ]];
}

function relativeCorpus() {
  const cases = [];
  const same = () => fixture(SMALL);
  const add = (name, url) => {
    cases.push([name, request('GET', url), { before: same, capture }]);
  };
  add('GET relative defaults', '/api/claude/models');
  add('GET relative refresh', '/api/claude/models?refresh=1');
  add('HEAD relative', '/api/claude/models');
  add('OPTIONS relative', '/api/claude/models');
  return cases;
}

// ── edge: mtime ties, sub-millisecond mtimes, cache stamping ───────────────
//
// One case may be a documented difference (hooks.expectedDifference); it is
// validated per side and reported apart from the byte-for-byte same count.

function versionFile(name, text, seconds) {
  const file = path.join(HOME, '.local', 'share', 'claude', 'versions', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, seconds, seconds);
  return file;
}

// What this filesystem actually reads back for the fractional seconds the edge
// group uses; the case name carries the numbers both sides saw.
function probeFractionalMtimes() {
  const probe = path.join(BASE, 'tmp', 'mtime-probe');
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.writeFileSync(probe, '');
  fs.utimesSync(probe, 1_700_000_000.0001, 1_700_000_000.0001);
  const first = fs.statSync(probe).mtimeMs;
  fs.utimesSync(probe, 1_700_000_000.0002, 1_700_000_000.0002);
  const second = fs.statSync(probe).mtimeMs;
  fs.rmSync(probe, { force: true });
  return { first, second };
}

function edgeCorpus(ctx) {
  const cases = [];
  const add = (name, req, hooks) => cases.push([name, req, hooks]);
  const refresh = () => request('GET', '/api/claude/models?refresh=1');

  // Exact ties: libuv's scandir sorts the names before readdirSync returns and
  // the mtime sort is stable, so the byte-wise earlier name wins no matter
  // which file was created first.
  add('tie mtimes pick the byte-wise first name (created last first)', refresh(), {
    before: () => {
      resetHome();
      versionFile('1.1.0', 'claude-opus-9', T0);
      versionFile('1.0.0', 'claude-opus-3', T0);
      versionFile('0.9.0', 'claude-opus-1', T0);
    },
    capture,
  });
  add('tie mtimes, byte-wise later name created last', refresh(), {
    before: () => {
      resetHome();
      versionFile('1.0.0', 'claude-opus-1', T0);
      versionFile('2.0.0', 'claude-opus-9', T0);
    },
    capture,
  });

  // A 40-entry versions dir is big enough that APFS readdir order is hash
  // order, not name order; only an explicit name pass reproduces Node.
  add('40 equal-mtime versions pick the byte-wise first name', refresh(), {
    before: () => {
      resetHome();
      for (let index = 0; index < 40; index++) {
        const name = `v${String(index).padStart(2, '0')}`;
        versionFile(name, index === 0 ? 'claude-opus-999' : 'claude-sonnet-4-6', T0);
      }
    },
    capture,
  });

  // Sub-millisecond near tie: 0.1ms apart inside the same whole millisecond.
  const fractional = probeFractionalMtimes();
  add(`sub-ms mtimes ${fractional.first} < ${fractional.second} pick the later file`, refresh(), {
    before: () => {
      resetHome();
      // The byte-wise earlier name holds the older mtime, so an implementation
      // that truncates to whole milliseconds would tie and pick it instead.
      versionFile('0.0.1', 'claude-opus-1', 1_700_000_000.0001);
      versionFile('2.0.0', 'claude-opus-9', 1_700_000_000.0002);
    },
    capture,
  });

  // Large-directory version of the sub-millisecond tie: 39 files share one
  // fractional mtime and v39 is 0.1ms later. Truncation makes all 40 equal and
  // the hash-order first file wins instead of v39.
  add(`40 fractional mtimes (${fractional.first} x39, v39 ${fractional.second}) pick v39`, refresh(), {
    before: () => {
      resetHome();
      for (let index = 0; index < 39; index++) {
        versionFile(`v${String(index).padStart(2, '0')}`, 'claude-sonnet-4-6', 1_700_000_000.0001);
      }
      versionFile('v39', 'claude-opus-999', 1_700_000_000.0002);
    },
    capture,
  });

  // Same whole millisecond, same size, rewritten bytes: Node's fractional
  // mtimeMs changes the bundle key, so the second request must rescan.
  add('same-millisecond same-size rewrite invalidates', request('GET', '/api/claude/models'), {
    before: async (side) => {
      resetHome();
      versionFile('1.0.0', 'claude-opus-4', 1_700_000_000.0010);
      const primed = JSON.parse((await send(side.port, refresh())).body.toString('utf8'));
      side.state.primed = primed.source;
      versionFile('1.0.0', 'claude-opus-8', 1_700_000_000.0012);
    },
    capture,
  });

  // The cache's `at` is the scan's finish, not the request's start; the
  // follow-up request proves the entry is still fresh.
  add('cache stamped at scan end', request('GET', '/api/claude/models'), {
    before: (side) => {
      resetHome();
      fixture(SMALL);
      side.state.t0 = Date.now();
    },
    capture: (raw, side) => {
      side.state.t1 = Date.now();
      if (side.name === 'rust') {
        // Read the file now: later cases scan again and overwrite `at`.
        try {
          const file = path.join(ctx.work, 'gw-data', 'claude-models-cache.json');
          side.state.cacheAt = JSON.parse(fs.readFileSync(file, 'utf8')).at;
        } catch (_) {
          side.state.cacheAt = null;
        }
      }
      capture(raw, side);
    },
  });
  add('second request served from cache', request('GET', '/api/claude/models'), {
    before: () => {},
    capture,
  });

  // Documented differences: `String(req.query.refresh)` throws on an object in
  // Node (safeErrorHandler 500 internal_error); Rust's query_value is an object
  // whose String() is "[object Object]", so it is simply non-force.
  for (const url of ['/api/claude/models?refresh[toString]=1', '/api/claude/models?refresh[toString]=']) {
    cases.push([`${url} object refresh: Node 500, Rust 200`, request('GET', url), {
      before: async (side) => {
        resetHome();
        fixture(SMALL);
        await send(side.port, refresh());
      },
      expectedDifference: {
        node: (view) => view.status === 500 && /"error":"internal_error"/.test(view.body),
        rust: (view) => view.status === 200 && JSON.parse(view.body).source === 'cache',
      },
    }]);
  }
  return cases;
}

// ── spec ───────────────────────────────────────────────────────────────────

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

function readCache(dir) {
  const file = path.join(dir, 'claude-models-cache.json');
  if (!fs.existsSync(file)) return { exists: false };
  const mode = (fs.statSync(file).mode & 0o777).toString(8);
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      exists: true,
      mode,
      keys: Object.keys(doc),
      at: typeof doc.at,
      atValue: typeof doc.at === 'number' ? doc.at : null,
      bundleKey: typeof doc.bundleKey,
      models: Array.isArray(doc.models) ? doc.models.length : null,
      first: Array.isArray(doc.models) && doc.models[0] ? doc.models[0].model : null,
    };
  } catch (error) {
    return { exists: true, mode, unreadable: String(error.message || error) };
  }
}

function finalize(group) {
  return async ({ views, nodeData, gwData, sides }) => {
    const details = { group };
    let ok = true;
    const nodeCache = readCache(nodeData);
    const gwCache = readCache(gwData);
    details.nodeCache = nodeCache;
    details.gwCache = gwCache;
    if (group === 'fallback') {
      // Fallbacks are never cached: no cache file on the gateway either.
      if (gwCache.exists) ok = false;
    } else if (group !== 'real-bundle' || gwCache.exists) {
      if (!gwCache.exists || gwCache.mode !== '600' || gwCache.at !== 'number'
        || gwCache.bundleKey !== 'string' || typeof gwCache.models !== 'number'
        || gwCache.keys.join(',') !== 'at,bundleKey,models') ok = false;
    }
    // The Node-side synchronous reader consumes the gateway-written file.
    if (gwCache.exists) {
      const before = process.env.MULTICC_DATA_DIR;
      process.env.MULTICC_DATA_DIR = group === 'relative-data-dir'
        ? path.relative(ROOT, gwData) : gwData;
      _resetCacheForTest();
      let ids = [];
      try { ids = listClaudeModelsSync(); } catch (_) { ids = []; }
      process.env.MULTICC_DATA_DIR = before;
      _resetCacheForTest();
      details.reader = ids;
      // The cache file holds the last *scanned* list (fallbacks are never
      // cached), so compare against the last cli answer.
      const parsed = [...views].reverse()
        .filter(v => v.rust.status === 200 && v.rust.body.startsWith('{'))
        .map(v => JSON.parse(v.rust.body))
        .find(body => body.source === 'cli');
      if (parsed) {
        const models = parsed.models.map(entry => entry.model);
        details.readerMatches = JSON.stringify(ids) === JSON.stringify(models);
        if (!details.readerMatches) ok = false;
      }
      if (!ids.length) ok = false;
    }
    // The gateway must never write a cache file on the Node side.
    if (nodeCache.exists) ok = false;
    if (group === 'concurrent') {
      const nodeSources = (sides.node.state.sources || []).slice().sort();
      const rustSources = (sides.rust.state.sources || []).slice().sort();
      details.sources = { node: nodeSources, rust: rustSources };
      details.sourcesMatch = JSON.stringify(nodeSources) === JSON.stringify(rustSources);
      if (!details.sourcesMatch) ok = false;
      if (nodeSources.filter(source => source === 'cli').length !== 1) ok = false;
    }
    if (group === 'real-bundle') {
      details.real = {
        shim: REAL_SHIM,
        exists: !!REAL_SHIM && fs.existsSync(REAL_SHIM),
        ms: { node: sides.node.state.ms, rust: sides.rust.state.ms },
      };
    }
    if (group === 'default') {
      const sourceOf = (name) => {
        const view = views.find(v => v.name === name);
        if (!view || view.rust.status !== 200 || !view.rust.body.startsWith('{')) return '<missing>';
        return JSON.parse(view.rust.body).source;
      };
      const expected = {
        'GET first cli': 'cli', 'GET cached': 'cache',
        'GET ?refresh=1': 'cli', 'GET ?refresh=true': 'cli', 'GET ?refresh=TRUE': 'cli',
        'GET ?refresh=True': 'cli', 'GET ?refresh=yes': 'cache', 'GET ?refresh=0': 'cache',
        'GET ?refresh=': 'cache', 'GET ?refresh[]=1': 'cli', 'GET ?refresh[0]=1': 'cli',
        'GET ?refresh[a]=1': 'cache', 'GET ?refresh=1&refresh=1': 'cache', 'GET ?refresh[]=true': 'cli',
        'GET mtime change': 'cli', 'GET size change': 'cli', 'GET shim retarget': 'cli',
        'GET after retarget cached': 'cache', 'GET gzip large': 'cli', 'GET gzip small': 'cli',
      };
      details.sources = {};
      for (const [name, want] of Object.entries(expected)) {
        const got = sourceOf(name);
        details.sources[name] = got;
        if (got !== want) { details.sources[name] = `<${got}!=${want}>`; ok = false; }
      }
      const small = views.find(v => v.name === 'GET gzip small');
      if (small && small.rust.headers['content-encoding'] !== undefined) {
        details.gzipSmall = small.rust.headers['content-encoding'];
        ok = false;
      }
    }
    if (group === 'window') {
      const modelsOf = (name) => {
        const view = views.find(v => v.name === name);
        if (!view || view.rust.status !== 200) return null;
        return JSON.parse(view.rust.body).models.map(entry => entry.model);
      };
      const families = ['opus', 'sonnet', 'fable', 'haiku'];
      const majors = families.map((family, index) => `claude-${family}-${900000 + index}`);
      const expect = (name, present) => {
        const models = modelsOf(name);
        if (!models) { details[`window:${name}`] = '<missing>'; ok = false; return; }
        for (const index of [0, 1, 2, 3]) {
          const want = present.includes(index);
          const got = models.includes(majors[index]);
          if (got !== want) { details[`window:${name}`] = `family ${index} ${got} != ${want}`; ok = false; }
        }
      };
      expect('4MiB starts k=63/64/65/0 preceded by word', [3]);
      expect('4MiB starts k=63/64/65/0 preceded by dash', [3]);
      expect('4MiB starts k=63/64/65/0 preceded by underscore', [3]);
      expect('8MiB starts k=63/64/65/0 preceded by word', [3]);
      expect('window end exactly after id, next byte word/dash/underscore/digit', [0, 1, 2, 3]);
      expect('id ends one byte before window end, next byte word', [0, 1, 2]);
      expect('8MiB window end exactly after id', [0, 1, 2, 3]);
      expect('id fully inside window but after a blocking byte', []);
    }
    if (group === 'edge') {
      const answerOf = (name) => {
        const view = views.find(v => v.name === name);
        if (!view || view.rust.status !== 200) return null;
        return JSON.parse(view.rust.body);
      };
      const wantModel = {
        'tie mtimes pick the byte-wise first name (created last first)': 'claude-opus-1',
        'tie mtimes, byte-wise later name created last': 'claude-opus-1',
      };
      details.edge = {};
      for (const [name, model] of Object.entries(wantModel)) {
        const body = answerOf(name);
        details.edge[name] = body ? body.models[0].model : '<missing>';
        if (!body || body.models[0].model !== model) ok = false;
      }
      const many = answerOf('40 equal-mtime versions pick the byte-wise first name');
      details.edge.manyTies = many ? many.models.map(entry => entry.model) : '<missing>';
      if (!many || !many.models.some(entry => entry.model === 'claude-opus-999')) ok = false;

      const fractionalMany = views.find(v => v.name.startsWith('40 fractional mtimes '));
      const fractionalBody = fractionalMany && fractionalMany.rust.status === 200
        ? JSON.parse(fractionalMany.rust.body) : null;
      details.edge.fractionalMany = fractionalBody
        ? fractionalBody.models.map(entry => entry.model) : '<missing>';
      if (!fractionalBody || !fractionalBody.models.some(entry => entry.model === 'claude-opus-999')) ok = false;

      const sub = views.find(v => v.name.startsWith('sub-ms mtimes '));
      const subBody = sub && sub.rust.status === 200 ? JSON.parse(sub.rust.body) : null;
      details.edge.subMs = subBody ? subBody.models[0].model : '<missing>';
      if (!subBody || subBody.models[0].model !== 'claude-opus-9') ok = false;

      const rewrite = answerOf('same-millisecond same-size rewrite invalidates');
      details.edge.rewrite = {
        primed: sides.rust.state.primed,
        after: rewrite ? rewrite.source : '<missing>',
      };
      // The bundle key changed inside one millisecond: the second answer must
      // rescan rather than serve the primed list.
      if (details.edge.rewrite.primed !== 'cli' || details.edge.rewrite.after !== 'cli') ok = false;

      // `at` is the scan's finish: inside [request start, response end].
      const t0 = sides.rust.state.t0;
      const t1 = sides.rust.state.t1;
      const at = sides.rust.state.cacheAt;
      details.edge.cacheAt = { at, t0, t1 };
      if (at == null || !(at >= t0 - 1 && at <= t1 + 5)) ok = false;
      const second = answerOf('second request served from cache');
      details.edge.second = second ? second.source : '<missing>';
      if (!second || second.source !== 'cache') ok = false;
    }
    const big = views.find(v => v.name === 'GET gzip large');
    if (big) details.bigGzip = { encoding: big.rust.headers['content-encoding'], bytes: Buffer.byteLength(big.rust.body) };
    if (big && (BigInt(Buffer.byteLength(big.rust.body)) < 1024n || big.rust.headers['content-encoding'] !== 'gzip')) ok = false;
    if (group === 'window') details.windowCases = views.length;
    console.log(`[claude-models:${group}] ${ok ? 'finalize ok' : 'finalize FAILED'} ${JSON.stringify(details).slice(0, 600)}`);
    return { ok, details };
  };
}

function specFor(group) {
  const spec = {
    name: `claude-models-${group}`,
    mount(app) {
      process.env.MULTICC_DATA_DIR = path.join(BASE, `node-data-${group}`);
      ORACLE.mountClaudeModelRoutes(app);
    },
    upstream: UPSTREAM,
    gatewayEnv: (work) => ({
      MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
      ...(group === 'relative-data-dir'
        ? { MULTICC_DATA_DIR: path.relative(path.join(work, 'gw'), path.join(work, 'gw-data')) }
        : {}),
    }),
    finalize: finalize(group),
  };
  if (group === 'default') spec.corpus = defaultCorpus;
  else if (group === 'fallback') spec.corpus = fallbackCorpus;
  else if (group === 'window') spec.corpus = windowCorpus;
  else if (group === 'semantics') spec.corpus = semanticsCorpus;
  else if (group === 'fuzz') spec.corpus = fuzzCorpus;
  else if (group === 'concurrent') spec.corpus = concurrentCorpus;
  else if (group === 'edge') spec.corpus = edgeCorpus;
  else if (group === 'real-bundle') spec.corpus = realBundleCorpus;
  else if (group === 'relative-data-dir') spec.corpus = relativeCorpus;
  else throw new Error(`unknown group ${group}`);
  return spec;
}

// ── entry point ────────────────────────────────────────────────────────────

async function main() {
  prepareEnvironment();
  const [, , , addon] = process.argv;
  const argv = process.argv.slice(2, 5);
  if (GROUP) {
    if (GROUP === 'real-bundle' && (!REAL_SHIM || !fs.existsSync(REAL_SHIM))) {
      console.log('[claude-models:real-bundle] skipped: no real ~/.local/bin/claude');
      return;
    }
    let ok = false;
    try {
      ok = await run(specFor(GROUP), argv);
    } catch (error) {
      console.error(error);
    }
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (!addon) throw new Error('usage: <repo> <multicc-gateway> <multicc_core.node>');
  let failed = false;
  const groups = GROUPS.filter(group => group !== 'real-bundle' || (REAL_SHIM && fs.existsSync(REAL_SHIM)));
  if (!groups.includes('real-bundle')) console.log('[claude-models:real-bundle] skipped: no real ~/.local/bin/claude');
  for (const group of groups) {
    try {
      execFileSync(process.execPath, [__filename, ...argv, group], { stdio: 'inherit', env: process.env });
    } catch (_) {
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
