'use strict';
// Differential run for GET/HEAD/OPTIONS /api/token-usage/global.
//
//   node docs/rust-migration/differential/token-usage-global.js \
//     <repo> <multicc-gateway> <multicc_core.node> [group]
//
// With no group it forks one child per group (a fresh process is needed: the
// timezone is read once by `Intl` at startup, and each side pins its own 120s
// cache at module load).
//
//   MULTICC_RUST_ADDON=<prebuilt>/darwin-arm64/multicc_core.node \
//   node docs/rust-migration/differential/token-usage-global.js \
//     . <prebuilt>/darwin-arm64/multicc-gateway <prebuilt>/darwin-arm64/multicc_core.node
//
// The Node side is the frozen oracle in
// tests/helpers/legacy-token-usage-global-route.js running the real Express
// pipeline and auth runtime. The Rust side is the release multicc-gateway. Both
// read the same isolated HOME fixture, so the only normalization is
// `generatedAt`, which is each side's own scan clock.
//
// Note what this compares: both sides call the *same* Rust usage kernel
// (multicc_core::usage) through the addon, so row arithmetic is not an
// independent implementation. What is on trial here is the shell around it:
// which files are enumerated and in which order, how the local windows are
// built, timezone resolution, the assembled JSON, the 120s cache and the
// express HTTP semantics (HEAD/OPTIONS/ETag/auth/forwarding).
//
// The `tz-bogus` group is a documented difference: an explicitly unusable TZ
// makes the Rust side report the route's public 500 while Node, whose `Intl`
// process timezone is Asia/Shanghai, answers 200. The `tz-gmt` group is the
// reverse: both processes run under `TZ=GMT`, Node's `Intl` turns it into the
// fixed-offset id `+00:00` (rejected by the kernel → public 500) while the
// front door parses `GMT` as a zone and answers 200. Both are asserted per side
// and reported apart from the byte-for-byte same count.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { run, send } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ORACLE = require(path.join(ROOT, 'tests/helpers/legacy-token-usage-global-route.js'));

const GROUP = process.argv[5] || '';
const BASE = process.env.TUG_WORK || '/tmp/token-usage-global-port';
const HOME = path.join(BASE, 'home');
const TIMEZONE = 'Asia/Shanghai';
const GROUPS = ['default', 'trees', 'rows', 'empty', 'tz-bogus', 'tz-gmt'];

const LOCAL = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const REMOTE = { Host: 'box.example.com', 'X-Request-Id': 'diff-req-1' };
const FORWARDED = 'gateway-forwarded:';
const GZIP = { ...LOCAL, 'Accept-Encoding': 'gzip, deflate' };

// ── environment / fixture helpers ──────────────────────────────────────────

function prepareEnvironment() {
  fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.HOME = HOME;
  process.env.TMPDIR = path.join(BASE, 'tmp');
  // Both sides must resolve the same zone; the gateway gets it again through
  // gatewayEnv because it is spawned with a fixed env. The `tz-gmt` group runs
  // the whole child process under `TZ=GMT`, because V8 reads the zone once and
  // `Intl` reports it as `+00:00`.
  process.env.TZ = GROUP === 'tz-gmt' ? 'GMT' : TIMEZONE;
}

function resetHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
}

function put(relative, text) {
  const file = path.join(HOME, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// `YYYY-MM-DD` for a local day offset, computed once so every case and both
// sides see the identical bytes.
function shanghaiDate(daysAgo) {
  const shifted = new Date(Date.now() + 8 * 3600e3 - daysAgo * 86400e3);
  const pad = (value) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function stamp(daysAgo, hour = 3) {
  return `${shanghaiDate(daysAgo)}T${String(hour).padStart(2, '0')}:00:00+08:00`;
}

function line(value) {
  return JSON.stringify(value);
}

function claudeRows() {
  const rows = [];
  // Today, week, month, older than a month, older than a year.
  [0, 1, 3, 10, 40, 400].forEach((daysAgo, index) => {
    rows.push(line({
      timestamp: stamp(daysAgo),
      requestId: `req-${index}`,
      type: 'assistant',
      message: {
        id: `msg-${index}`,
        model: `claude-model-${index}`,
        usage: {
          input_tokens: 100 + index,
          output_tokens: 20 + index,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 4000,
        },
      },
    }));
  });
  // A duplicate of the first row (same requestId:msgId), in the same file and
  // again from another project: the dedupe is global across the walk.
  rows.push(rows[0]);
  return rows;
}

function codexRows() {
  const meta = line({ type: 'session_meta', timestamp: stamp(0), payload: { id: 'thread-1' } });
  const context = line({ type: 'turn_context', timestamp: stamp(0), payload: { model: 'gpt-a' } });
  const count = (input, cached, output, daysAgo = 0) => line({
    type: 'event_msg',
    timestamp: stamp(daysAgo),
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
    },
  });
  // Cumulative per thread: 1st event counts in full, the 2nd only the delta, a
  // lower total is skipped, then another delta.
  return [
    meta, context, count(1000, 400, 50), count(1500, 600, 80), count(1400, 500, 70), count(2000, 900, 120, 5),
  ];
}

function seedDefault() {
  resetHome();
  put('.claude/projects/p1/session.jsonl', claudeRows().join('\n') + '\n');
  put('.claude/projects/p2/other.jsonl', claudeRows()[0] + '\n');
  put('.codex/sessions/2026/rollout-a.jsonl', codexRows().join('\n') + '\n');
}

function request(method, url, headers = LOCAL) {
  return { method, url, headers };
}

function isForwarded(view) {
  return view.status === 599 && String(view.body || '').startsWith(FORWARDED);
}

// Methods/paths the front door never claims: compare forwarding only.
function unclaimed(view, side) {
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
  // The scan clock is normalized away before comparing; keep the first raw
  // value so the finalize pass can still prove each side stamped an ISO time.
  const stamp = /"generatedAt":"([^"]*)"/.exec(raw.body || '');
  if (stamp && side.state.generatedAt === undefined) side.state.generatedAt = stamp[1];
}

// ── corpora ────────────────────────────────────────────────────────────────

function defaultCorpus(ctx) {
  const cases = [];
  const add = (name, method, url, before, headers = LOCAL) => {
    cases.push([name, request(method, url, headers), { before, capture }]);
  };
  const same = () => {};

  add('GET first scan', 'GET', '/api/token-usage/global', seedDefault);
  add('GET cached', 'GET', '/api/token-usage/global', same);
  for (const value of ['?refresh=1', '?refresh=true', '?refresh=TRUE', '?refresh=yes',
    '?refresh=0', '?refresh=', '?refresh[]=1', '?refresh[0]=1', '?refresh[a]=1',
    '?refresh=1&refresh=1', '?refresh[toString]=1', '?refresh[toString]=']) {
    add(`GET ${value}`, 'GET', `/api/token-usage/global${value}`, same);
  }
  // A new transcript, then the cache vs `?refresh=1` difference.
  add('GET new file cached', 'GET', '/api/token-usage/global', () => {
    put('.claude/projects/p1/later.jsonl', line({
      timestamp: stamp(0, 5),
      requestId: 'req-later',
      type: 'assistant',
      message: { id: 'msg-later', model: 'claude-model-0', usage: { input_tokens: 7, output_tokens: 1 } },
    }) + '\n');
  });
  add('GET new file refresh', 'GET', '/api/token-usage/global?refresh=1', same);
  add('GET after refresh cached', 'GET', '/api/token-usage/global', same);
  add('HEAD', 'HEAD', '/api/token-usage/global', same);
  add('OPTIONS', 'OPTIONS', '/api/token-usage/global', same);
  add('GET trailing slash', 'GET', '/api/token-usage/global/', same);
  add('HEAD trailing slash', 'HEAD', '/api/token-usage/global/', same);
  add('GET mixed case path', 'GET', '/api/Token-Usage/Global', same);
  // Conditional requests reuse the same side's ETag; the cached body is
  // stable, so both sides must answer identically.
  cases.push(['GET if-none-match hit', (side) => request('GET', '/api/token-usage/global',
    { ...LOCAL, 'If-None-Match': side.state.etag }), { capture }]);
  cases.push(['GET if-none-match star', request('GET', '/api/token-usage/global',
    { ...LOCAL, 'If-None-Match': '*' }), { capture }]);
  cases.push(['GET if-none-match miss', request('GET', '/api/token-usage/global',
    { ...LOCAL, 'If-None-Match': 'W/"bogus"' }), { capture }]);
  // gzip: a body above the compression threshold, then one below it.
  add('GET gzip large', 'GET', '/api/token-usage/global?refresh=1', () => {
    seedDefault();
    const rows = [];
    for (let index = 0; index < 80; index++) {
      rows.push(line({
        timestamp: stamp(index % 9),
        requestId: `bulk-${index}`,
        type: 'assistant',
        message: {
          id: `bulk-msg-${index}`,
          model: `claude-bulk-model-${String(index).padStart(2, '0')}`,
          usage: { input_tokens: 1000.5 + index, output_tokens: 250.25, cache_creation_input_tokens: 1234, cache_read_input_tokens: 98765 },
        },
      }));
    }
    put('.claude/projects/bulk/session.jsonl', rows.join('\n') + '\n');
  }, GZIP);
  // An empty HOME answers with a ~287-byte body: below the 1024-byte floor, so
  // no compression even though the client offers it. (The previous case cached
  // the large scan, so this one has to force its own.)
  add('GET gzip small', 'GET', '/api/token-usage/global?refresh=1', () => {
    resetHome();
  }, GZIP);
  add('GET gzip x-gzip word', 'GET', '/api/token-usage/global?refresh=1', seedDefault,
    { ...LOCAL, 'Accept-Encoding': 'x-gzip' });
  // Methods/paths the front door never claims: compare forwarding only.
  const addUnclaimed = (name, method, url) => cases.push([name, request(method, url),
    { before: same, capture, normalize: (view, side) => unclaimed(view, side) }]);
  addUnclaimed('POST unclaimed', 'POST', '/api/token-usage/global');
  addUnclaimed('PUT unclaimed', 'PUT', '/api/token-usage/global');
  addUnclaimed('DELETE unclaimed', 'DELETE', '/api/token-usage/global');
  addUnclaimed('GET double slash', 'GET', '/api/token-usage/global//');
  addUnclaimed('GET percent encoded', 'GET', '/api/token-us%61ge/global');
  addUnclaimed('GET sibling path', 'GET', '/api/token-usage/globals');
  addUnclaimed('GET by-role untouched', 'GET', '/api/token-usage/by-role');
  // The one documented difference in this group: Express matched routes case
  // insensitively, so the old Node route answered `/API/...`; the front door
  // only claims a case-sensitive `/api/` prefix, and once the route is deleted
  // the real Node server falls through to 404. Asserted per side, not counted
  // as a byte-for-byte same.
  cases.push(['GET uppercase prefix', request('GET', '/API/token-usage/global'), {
    before: same,
    capture,
    expectedDifference: {
      node: (view) => view.status === 200
        && JSON.parse(view.body).generatedAt === '<scan-clock>',
      rust: (view) => view.status === 599
        && view.body === 'gateway-forwarded:GET /API/token-usage/global',
    },
  }]);
  // Auth matrix.
  add('GET remote no auth', 'GET', '/api/token-usage/global', same, REMOTE);
  add('GET remote token ok', 'GET', '/api/token-usage/global', same, { ...REMOTE, 'X-Access-Token': 'secret-token-1' });
  add('GET remote token bad', 'GET', '/api/token-usage/global', same, { ...REMOTE, 'X-Access-Token': 'nope' });
  // `ctx.cookie` is minted by the Node pipeline's own auth runtime before the
  // corpus is built, so it is a literal header here (a `(side) =>` builder
  // would be handed the side object, not this ctx).
  add('GET remote cookie ok', 'GET', '/api/token-usage/global', same, { ...REMOTE, Cookie: ctx.cookie });
  add('GET remote cookie bad', 'GET', '/api/token-usage/global', same, { ...REMOTE, Cookie: 'multicc_auth=x.y' });
  add('GET loopback forwarded', 'GET', '/api/token-usage/global', same, { ...LOCAL, 'X-Forwarded-For': '1.2.3.4' });
  add('GET tailscale host', 'GET', '/api/token-usage/global', same, { Host: 'mac.tail1.ts.net', 'X-Request-Id': 'diff-req-1' });
  return cases;
}

function treesCorpus() {
  const cases = [];
  const add = (name, before) => {
    cases.push([name, request('GET', '/api/token-usage/global?refresh=1'), { before, capture }]);
  };
  const row = (id, daysAgo = 0) => line({
    timestamp: stamp(daysAgo),
    requestId: id,
    type: 'assistant',
    message: { id, model: 'claude-tree', usage: { input_tokens: 5, output_tokens: 1 } },
  }) + '\n';

  add('nested dirs and name order', () => {
    resetHome();
    put('.claude/projects/b-project/a.jsonl', row('b-a'));
    put('.claude/projects/b-project/nested/z.jsonl', row('b-nested-z'));
    put('.claude/projects/a-project/m.jsonl', row('a-m'));
    put('.claude/projects/a-project/n.jsonl', row('a-n'));
  });
  add('non-jsonl and dot files ignored', () => {
    put('.claude/projects/p/session.json', row('json-not-jsonl'));
    put('.claude/projects/p/session.JSONL', row('uppercase-not-jsonl'));
    put('.claude/projects/p/session.jsonl.bak', row('bak-not-jsonl'));
    put('.claude/projects/p/.hidden.jsonl', row('hidden-jsonl'));
  });
  add('directory named like a transcript', () => {
    fs.mkdirSync(path.join(HOME, '.claude/projects/p/weird.jsonl'), { recursive: true });
    put('.claude/projects/p/weird.jsonl/inner.jsonl', row('inner'));
  });
  // Each `before` hook runs once per side, so every one of them has to be
  // idempotent: no bare mkdir, no second symlink.
  add('symlinked file and directory', () => {
    const target = put('.claude/projects/real/target.jsonl', row('symlink-target'));
    const outside = put('outside/dir/entry.jsonl', row('outside-dir'));
    for (const [from, to] of [[target, 'p/link.jsonl'], [path.dirname(outside), 'p/linkdir']]) {
      const link = path.join(HOME, '.claude/projects', to);
      fs.rmSync(link, { force: true });
      fs.symlinkSync(from, link);
    }
  });
  add('unreadable directory skipped', () => {
    const dir = path.join(HOME, '.claude/projects/locked');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o000);
  });
  add('projects path is a file', () => {
    // The case above leaves a mode-000 directory that `rm` cannot walk into;
    // restore it first, or the reset throws EACCES.
    const locked = path.join(HOME, '.claude/projects/locked');
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755);
    resetHome();
    put('.claude/projects', 'not a directory');
  });
  add('codex nested and sorted', () => {
    resetHome();
    put('.codex/sessions/z/last.jsonl', codexRows().join('\n') + '\n');
    put('.codex/sessions/a/first.jsonl', codexRows().slice(0, 3).join('\n') + '\n');
  });
  add('codex non-jsonl ignored', () => {
    put('.codex/sessions/a/notes.txt', 'ignored\n');
    put('.codex/sessions/a/rollout.jsonl', codexRows().join('\n') + '\n');
  });
  return cases;
}

function rowsCorpus() {
  const cases = [];
  let index = 0;
  const add = (name, rows) => {
    cases.push([name, request('GET', '/api/token-usage/global?refresh=1'), {
      before: () => {
        resetHome();
        put('.claude/projects/p/session.jsonl', rows.join('\n') + '\n');
      },
      capture,
    }]);
  };
  const row = (overrides) => line({
    timestamp: stamp(0),
    requestId: `row-${index++}`,
    type: 'assistant',
    message: { id: 'm', model: 'claude-rows', usage: { input_tokens: 10, output_tokens: 2 } },
    ...overrides,
  });

  add('malformed lines are skipped', [
    'not json at all',
    '{"usage":',
    row({}),
  ]);
  add('missing usage / model / timestamp', [
    line({ timestamp: stamp(0), requestId: 'no-usage', type: 'assistant', message: { id: 'x' } }),
    line({ timestamp: stamp(0), requestId: 'no-model', type: 'assistant', message: { id: 'y', usage: { input_tokens: 3 } } }),
    line({ timestamp: '', requestId: 'empty-ts', type: 'assistant', message: { id: 'z', usage: { input_tokens: 4 } } }),
  ]);
  add('all-zero usage dropped', [row({ message: { id: 'zero', model: 'claude-rows', usage: { input_tokens: 0, output_tokens: 0 } } })]);
  add('fractional and huge amounts', [
    row({ message: { id: 'frac', model: 'claude-rows', usage: { input_tokens: 0.5, output_tokens: 0.25, cache_read_input_tokens: 1.75 } } }),
    row({ message: { id: 'huge', model: 'claude-rows', usage: { input_tokens: 1e21, output_tokens: 1 } } }),
  ]);
  add('string amounts are not numbers', [
    row({ message: { id: 'str', model: 'claude-rows', usage: { input_tokens: '10', output_tokens: 1 } } }),
  ]);
  add('unparseable timestamp kept in all only', [row({ timestamp: 'yesterday-ish' })]);
  add('dedupe by requestId and msgId', [
    row({ requestId: 'same', message: { id: 'a', model: 'claude-rows', usage: { input_tokens: 1, output_tokens: 1 } } }),
    row({ requestId: 'same', message: { id: 'a', model: 'claude-rows', usage: { input_tokens: 9, output_tokens: 9 } } }),
    row({ requestId: 'same', message: { id: 'b', model: 'claude-rows', usage: { input_tokens: 1, output_tokens: 1 } } }),
    row({ requestId: 'other', message: { id: 'a', model: 'claude-rows', usage: { input_tokens: 1, output_tokens: 1 } } }),
  ]);
  add('unknown model and unicode model', [
    row({ message: { id: 'u1', usage: { input_tokens: 1, output_tokens: 1 } } }),
    row({ message: { id: 'u2', model: '模型', usage: { input_tokens: 1, output_tokens: 1 } } }),
  ]);
  add('lone surrogate in request id', [
    '{"timestamp":"' + stamp(0) + '","requestId":"\\ud800","type":"assistant","message":{"id":"a","model":"claude-rows","usage":{"input_tokens":9,"output_tokens":1}}}',
  ]);
  add('empty file', []);
  add('crlf line endings', [JSON.stringify({ timestamp: stamp(0), requestId: 'crlf', message: { id: 'crlf', model: 'claude-rows', usage: { input_tokens: 2, output_tokens: 2 } } })].map(text => text + '\r'));
  return cases;
}

function emptyCorpus() {
  const cases = [];
  const add = (name, before, url = '/api/token-usage/global') => {
    cases.push([name, request('GET', url), { before, capture }]);
  };
  add('no home dirs', () => resetHome());
  add('empty dirs', () => {
    resetHome();
    fs.mkdirSync(path.join(HOME, '.claude/projects'), { recursive: true });
    fs.mkdirSync(path.join(HOME, '.codex/sessions'), { recursive: true });
  }, '/api/token-usage/global?refresh=1');
  add('empty dirs cached', () => {});
  add('empty dirs refresh', () => {}, '/api/token-usage/global?refresh=1');
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

function finalize(group) {
  return async ({ views, sides }) => {
    const details = { group };
    let ok = true;
    const answerOf = (name) => {
      const view = views.find(entry => entry.name === name);
      if (!view || view.rust.status !== 200) return null;
      try { return JSON.parse(view.rust.body); } catch (_) { return null; }
    };
    if (group === 'default') {
      const first = answerOf('GET first scan');
      details.first = first && {
        scannedFiles: first.scannedFiles,
        responses: first.responses,
        models: Object.keys(first.windows.all),
        today: Object.keys(first.windows.today),
        generatedAt: first.generatedAt,
      };
      if (!first || first.scannedFiles !== 3) ok = false;
      const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      details.clocks = { node: sides.node.state.generatedAt, rust: sides.rust.state.generatedAt };
      if (!ISO.test(sides.rust.state.generatedAt || '')) ok = false;
      if (!ISO.test(sides.node.state.generatedAt || '')) ok = false;
      if (!first || first.generatedAt !== '<scan-clock>') ok = false;
      details.sources = first && first.sources;
      if (!first || first.sources.claude !== path.join(HOME, '.claude', 'projects')) ok = false;
      if (!first || first.sources.codex !== path.join(HOME, '.codex', 'sessions')) ok = false;
      // Today's window only holds rows whose local day is today.
      const todayKeys = first ? Object.keys(first.windows.today) : [];
      details.todayModels = todayKeys;
      if (!todayKeys.includes('claude-model-0') || todayKeys.includes('claude-model-1')
        || todayKeys.includes('claude-model-5')) ok = false;
      const afterRefresh = answerOf('GET new file refresh');
      details.afterRefresh = afterRefresh && { scannedFiles: afterRefresh.scannedFiles };
      if (!afterRefresh || afterRefresh.scannedFiles !== 4) ok = false;
      const cached = answerOf('GET new file cached');
      details.cached = cached && { scannedFiles: cached.scannedFiles };
      if (!cached || cached.scannedFiles !== 3) ok = false;
      const large = views.find(entry => entry.name === 'GET gzip large');
      details.gzipLarge = large && {
        encoding: large.rust.headers['content-encoding'],
        compressed: Buffer.byteLength(large.rust.body),
      };
      if (!large || large.rust.headers['content-encoding'] !== 'gzip') ok = false;
      const small = views.find(entry => entry.name === 'GET gzip small');
      details.gzipSmall = small && { encoding: small.rust.headers['content-encoding'] ?? null };
      if (!small || small.rust.headers['content-encoding'] !== undefined) ok = false;
      const head = views.find(entry => entry.name === 'HEAD');
      details.head = head && { status: head.rust.status, length: head.rust.headers['content-length'] };
      if (!head || head.rust.body !== '') ok = false;
      const options = views.find(entry => entry.name === 'OPTIONS');
      details.options = options && { status: options.rust.status, allow: options.rust.headers.allow };
      if (!options || options.rust.headers.allow !== 'GET,HEAD') ok = false;
    }
    if (group === 'trees' || group === 'rows' || group === 'empty') {
      details.shapes = views.map(view => ({
        name: view.name,
        status: view.rust.status,
        scannedFiles: view.rust.status === 200 ? JSON.parse(view.rust.body).scannedFiles : null,
      }));
    }
    if (group === 'tz-gmt') {
      const view = views[0];
      details.tz = { node: view.node.status, rust: view.rust.status };
      if (view.node.status !== 500 || view.rust.status !== 200) ok = false;
      const body = view.rust.status === 200 ? JSON.parse(view.rust.body) : null;
      if (!body || !body.windows || body.generatedAt !== '<scan-clock>') ok = false;
    }
    console.log(`[token-usage-global:${group}] ${ok ? 'finalize ok' : 'finalize FAILED'} ${JSON.stringify(details).slice(0, 700)}`);
    return { ok, details };
  };
}

function specFor(group) {
  return {
    name: `token-usage-global-${group}`,
    mount(app) {
      ORACLE.mountTokenUsageGlobalRoute(app);
    },
    upstream: UPSTREAM,
    // The forwarded-request stub is a Node process that mounts the real auth
    // security module, so it needs the addon too; the gateway hands its own
    // environment down to that child.
    gatewayEnv: () => ({
      MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
      TZ: group === 'tz-bogus' ? 'Bogus/Zone' : group === 'tz-gmt' ? 'GMT' : TIMEZONE,
    }),
    // Each side stamps its own scan clock.
    normalize: (text) => text.replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"<scan-clock>"'),
    // The weak ETag is a digest of the body, so a body whose only difference
    // is the self-stamped `generatedAt` cannot have the same ETag. Mask it
    // exactly where the clock was masked above — including HEAD and 304, which
    // carry the ETag of a body they do not send. Every other header, and every
    // body outside `generatedAt`, is still compared byte for byte.
    normalizeView: (v) => {
      if (v.headers.etag && (v.body === '' || v.body.includes('"generatedAt":"<scan-clock>"'))) {
        v.headers.etag = '<scan-clock-etag>';
      }
      return v;
    },
    corpus: group === 'default' ? defaultCorpus
      : group === 'trees' ? treesCorpus
        : group === 'rows' ? rowsCorpus
          : group === 'empty' ? emptyCorpus
            : group === 'tz-gmt' ? tzGmtCorpus
              : tzBogusCorpus,
    finalize: finalize(group),
  };
}

// One case, asserted per side, with BOTH processes running under `TZ=GMT`.
// V8/ICU resolves `GMT` to the fixed-offset id `+00:00`, which the usage kernel
// refuses, so the old Node route answers its public 500; the front door parses
// the raw `TZ` (`GMT` is a real zone) and answers 200 with UTC windows. This is
// the reverse direction of the `tz-bogus` difference and is likewise a fix, not
// a silent behavior change.
function tzGmtCorpus() {
  return [[
    'GET under TZ=GMT',
    request('GET', '/api/token-usage/global?refresh=1'),
    {
      before: seedDefault,
      capture,
      expectedDifference: {
        node: (view) => view.status === 500
          && view.body === '{"error":"Token usage is temporarily unavailable"}',
        rust: (view) => view.status === 200
          && JSON.parse(view.body).generatedAt === '<scan-clock>',
      },
    },
  ]];
}

// One case, asserted per side: Node resolves its own process zone
// (Asia/Shanghai) and answers 200; the gateway is started with an unusable TZ
// and reports the route's public 500.
function tzBogusCorpus() {
  return [[
    'GET with unusable gateway TZ',
    request('GET', '/api/token-usage/global?refresh=1'),
    {
      before: seedDefault,
      capture,
      expectedDifference: {
        node: (view) => view.status === 200 && JSON.parse(view.body).generatedAt === '<scan-clock>',
        rust: (view) => view.status === 500
          && view.body === '{"error":"Token usage is temporarily unavailable"}',
      },
    },
  ]];
}

// ── entry point ────────────────────────────────────────────────────────────

async function main() {
  prepareEnvironment();
  const argv = process.argv.slice(2, 5);
  // The forwarded-request stub mounts `src/auth-security`, which needs the
  // native module; without it the gateway's Node child crash-loops with
  // `rust_backend_unavailable` and every group only ends at the watchdog.
  const addon = argv[2] ? path.resolve(argv[2]) : '';
  if (!addon || !fs.existsSync(addon)) {
    throw new Error('<multicc_core.node> is required and must exist: the forwarded-request stub loads it');
  }
  process.env.MULTICC_RUST_ADDON = addon;
  if (GROUP) {
    if (!GROUPS.includes(GROUP)) throw new Error(`unknown group ${GROUP}`);
    let ok = false;
    try {
      ok = await run(specFor(GROUP), argv);
    } catch (error) {
      console.error(error);
    }
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (!argv[2]) throw new Error('usage: <repo> <multicc-gateway> <multicc_core.node>');
  let failed = false;
  for (const group of GROUPS) {
    try {
      execFileSync(process.execPath, [__filename, ...argv, group], {
        stdio: 'inherit',
        env: {
          ...process.env,
          TZ: group === 'tz-gmt' ? 'GMT' : TIMEZONE,
          HOME,
          TMPDIR: path.join(BASE, 'tmp'),
        },
      });
    } catch (_) {
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
