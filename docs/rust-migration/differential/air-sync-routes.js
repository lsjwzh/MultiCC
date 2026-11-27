'use strict';
// Differential run for the two live-sync summary routes retired from
// src/workspace/air-routes.js:
//
//   GET|HEAD /api/air/sync
//   GET|HEAD /api/air/page
//
// now claimed by the Rust front door (native/gateway/src/app/air_routes.rs;
// the qs-shaped key extraction is native/core/src/http_gate.rs's
// query_value, the error envelope native/core/src/air_routes.rs's
// error_body).
//
//   node docs/rust-migration/differential/air-sync-routes.js <repo> <multicc-gateway> [addon]
//
// Unlike the air-routes run (which keeps registerSync absent), both sides
// mount the scripted world WITH the summary runtime (scenario.sync): the
// Node oracle mounts the frozen retired handlers
// (tests/helpers/legacy-air-routes.js), the stub child mounts the real host
// composition (src/workspace/air-routes.js). Each side creates its own
// liveSync over one fixed world, so the comparison covers the split itself:
// the front door's key extraction and QueryValue mapping versus express'
// req.query, the error envelope, HEAD stripping, conditional requests and
// gzip.
//
// Two body fields are per-process and masked before comparing: `cursor`
// (each side's read model stamps its own random epoch) and `checkedAt`
// (wall clock). The ETag hashes the raw body, so it differs too and is
// masked; its shape is pinned in finalize. Cursors and ETags are captured
// per side and threaded into later cases (the capturedEtags pattern from
// air-routes.js): a conditional request must present the SAME validator
// that side handed out, and the threaded cursor must arrive at the host
// port verbatim (finalize asserts that against the recorded bodies).
//
// The forwarded host-port body is compared as well: the Node side records
// the `q` each retired handler received, the stub records every raw
// /api/__host/air body, and finalize checks them pairwise after folding the
// Node side through the documented contract (only the keys the front door
// extracts; qs objects collapse to {}). A reconcile republish with
// unchanged facts returns Value::Null without a revision bump, so the fixed
// world stays byte-stable even if a run crosses the 30s reconcile timer.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { main } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };

// Forty cards, so the bootstrap's first-thirty cut and the page projection's
// pagination are observable in the answer bytes themselves (with two cards
// `include`, `ids` and `page` would change nothing a byte compare could see).
const BOARD_IDS = ['tk-a', 'tk-b', ...Array.from({ length: 38 }, (_, i) => `tk-${String(i + 1).padStart(3, '0')}`)];
// A card the plain bootstrap leaves out (it takes the first thirty by id, so
// tk-a and tk-b fall off the end) and only `include` brings in; finalize
// proves both halves so a wrong pick cannot pass silently.
const DEEP_ID = 'tk-b';

// Keys the front door extracts per route (the SyncGet/PageGet arms of
// native/gateway/src/app/air_routes.rs answer()). Anything else in the query
// never crosses the host port.
const FORWARDED = {
  sync: ['dayStart', 'cursor', 'include'],
  page: ['status', 'sort', 'dirId', 'query', 'dayStart', 'limit', 'page', 'visits', 'ids'],
};

let bodiesPath = '';
let readyPath = '';
let upstreamText = '';
let currentCase = null;
const nodeCalls = [];
const seized = { node: {}, rust: {} };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The gateway's QueryValue -> JSON mapping (query_json): strings and lists
// pass through, any qs object collapses to {}.
function contractBody(call) {
  const out = { op: call.op };
  for (const key of FORWARDED[call.op]) {
    const value = call.q[key];
    if (value === undefined) continue;
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? {} : value;
  }
  return out;
}

// A threaded cursor is per-side by construction: mask each side's own seized
// cursor inside the recorded bodies before comparing them.
function unseize(body, side) {
  const out = JSON.parse(JSON.stringify(body));
  if (out.cursor && out.cursor === seized[side].cursor) out.cursor = '<cursor>';
  return out;
}

// The stub child loads the native addon and builds its read model before it
// listens, which takes longer than the gateway needs to accept connections.
// Without this gate the first requests hit a refused host-port connection and
// the front door answers its 503 fallback, which would be a harness race, not
// a behaviour difference. The stub writes the marker once it is listening.
async function childReady() {
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(readyPath)) {
    if (Date.now() > deadline) throw new Error('the stub child never became ready');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function hooksFor(name, { seize = false } = {}) {
  return {
    async before(side) {
      currentCase = name;
      if (side.name === 'rust') await childReady();
    },
    capture(response, side) {
      if (!seize) return;
      let body = response.body;
      if (response.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (parsed && typeof parsed.cursor === 'string') seized[side.name].cursor = parsed.cursor;
      } catch (_) { /* an unparseable body cannot lend a cursor */ }
      if (response.headers.etag) seized[side.name].etag = response.headers.etag;
    },
  };
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  const pending = [];
  const add = (name, request, opts) => pending.push([name, request, hooksFor(name, opts)]);

  // ── sync: the bootstrap arm ──────────────────────────────────────────
  add('sync bootstrap', () => get('/api/air/sync'), { seize: true });
  add('sync bootstrap with a day boundary', () => get('/api/air/sync?dayStart=1700000000000'));
  add('sync bootstrap include list', () => get('/api/air/sync?include=tk-a&include=tk-b'));
  add('sync bootstrap include commas', () => get('/api/air/sync?include=tk-a,,tk-b'));
  add('sync include pulls a card past the first thirty', () => get(`/api/air/sync?include=${DEEP_ID}`));
  add('sync include list pulls a deep card', () => get(`/api/air/sync?include=nope&include=${DEEP_ID}`));
  add('sync dayStart repeated coerces NaN', () => get('/api/air/sync?dayStart=5&dayStart=6'));
  add('sync dayStart garbage coerces zero', () => get('/api/air/sync?dayStart=abc'));
  add('sync unknown keys stay home', () => get('/api/air/sync?foo=bar'));

  // ── sync: the cursor arm ─────────────────────────────────────────────
  add('sync with the seized cursor',
    side => get(`/api/air/sync?cursor=${encodeURIComponent(seized[side.name].cursor || 'missing')}`));
  add('sync an unknown epoch resets', () => get('/api/air/sync?cursor=nope:1'));
  add('sync a malformed cursor resets', () => get('/api/air/sync?cursor=nope'));
  add('sync a repeated cursor joins', () => get('/api/air/sync?cursor=a&cursor=b'));
  add('sync an object cursor folds like qs', () => get('/api/air/sync?cursor[x]=1'));
  add('sync an empty cursor bootstraps', () => get('/api/air/sync?cursor='));

  // ── sync: methods, caching, compression ──────────────────────────────
  add('HEAD sync', () => head('/api/air/sync'));
  add('OPTIONS sync', () => options('/api/air/sync'));
  add('sync conditional with the seized etag',
    side => get('/api/air/sync', { ...L, 'If-None-Match': seized[side.name].etag || 'W/"missing"' }));
  add('sync gzip', () => get('/api/air/sync', { ...L, 'Accept-Encoding': 'gzip, deflate' }));

  // ── page ─────────────────────────────────────────────────────────────
  add('page default', () => get('/api/air/page'));
  add('page status all', () => get('/api/air/page?status=all'));
  add('page second page', () => get('/api/air/page?status=all&page=2'));
  add('page past the last page clamps', () => get('/api/air/page?status=all&page=99'));
  add('page small limit', () => get('/api/air/page?status=all&limit=7&page=3'));
  add('page ids narrows the board', () => get(`/api/air/page?status=all&ids=${DEEP_ID},tk-a`));
  add('page limit clamps to fifty', () => get('/api/air/page?status=all&limit=500'));
  add('page limit garbage is a 500', () => get('/api/air/page?status=all&limit=abc'));
  add('page repeated status is a 500', () => get('/api/air/page?status=all&status=archived'));
  add('page ids selection and order', () => get('/api/air/page?status=all&ids=tk-b,tk-a'));
  add('page empty ids selects nothing', () => get('/api/air/page?status=all&ids='));
  add('page visits sort', () => get(`/api/air/page?status=all&sort=visit&visits=${encodeURIComponent('{"tk-b":2,"tk-a":9}')}`));
  add('page visits garbage coerces empty', () => get('/api/air/page?status=all&visits=not-json'));
  add('page visits list coerces empty', () => get('/api/air/page?status=all&visits=a&visits=b'));
  add('page query filter', () => get('/api/air/page?status=all&query=tk-b'));
  add('page dirId filter', () => get('/api/air/page?status=all&dirId=dir-1'));
  add('page unknown dirId', () => get('/api/air/page?status=all&dirId=nope'));
  add('page unknown keys stay home', () => get('/api/air/page?status=all&foo=bar'));
  add('HEAD page', () => head('/api/air/page?status=all'));
  add('OPTIONS page', () => options('/api/air/page'));
  return pending;
}

// ── the stub Node child: the real host composition over the fixed world ────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/native/binding')).authSecurity;
const { connectAuthControl } = require(path.join(REPO, 'src/native/binding')).gatewayChild;
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const world = require(path.join(REPO, 'tests/helpers/air-scripted-world'));
const { mountAirRoutes } = require(path.join(REPO, 'src/workspace/air-routes'));

const app = express();
app.use(express.json({ limit: '50mb' }));
const bag = world.buildDeps({ case: 'stub', sync: true, board: world.makeBoard(${JSON.stringify(BOARD_IDS)}).tasks, answers: {} });
// Every body the front door forwards, verbatim and in order.
app.post('/api/__host/air', (req, res, next) => {
  fs.appendFileSync(process.env.STUB_BODIES, JSON.stringify(req.body) + '\\n');
  next();
});
mountAirRoutes(app, world.bindDeps(() => bag));

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
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1',
  () => fs.writeFileSync(process.env.STUB_READY, 'ready'));
`;
}

// ── run ────────────────────────────────────────────────────────────────────

main({
  name: 'air-sync-routes',
  mount(app, { repo, work }) {
    // A missed pins/todos path would otherwise fall back to the data root and
    // leak test ids into the real files.
    process.env.MULTICC_DATA_DIR = work;
    bodiesPath = path.join(work, 'air-sync-bodies.ndjson');
    readyPath = path.join(work, 'stub-ready');
    fs.writeFileSync(bodiesPath, '');
    const world = require(path.join(repo, 'tests/helpers/air-scripted-world'));
    const legacy = require(path.join(repo, 'tests/helpers/legacy-air-routes'));
    const bag = world.buildDeps({ case: 'boot', sync: true, board: world.makeBoard(BOARD_IDS).tasks, answers: {} });
    const liveSync = legacy.mountAirRoutes(app, world.bindDeps(() => bag));
    if (!liveSync) throw new Error('the sync world must produce a liveSync runtime');
    // Record exactly what the retired handlers received as `q`; finalize
    // compares it with the raw bodies the gateway sent the host port.
    for (const [method, op] of [['syncHttp', 'sync'], ['pageHttp', 'page']]) {
      const original = liveSync[method];
      liveSync[method] = q => {
        nodeCalls.push({ case: currentCase, op, q: clone(q || {}) });
        return original(q);
      };
    }
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: () => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    STUB_BODIES: bodiesPath,
    STUB_READY: readyPath,
  }),
  corpus,
  // cursor carries a per-process epoch, checkedAt is a wall clock, and the
  // ETag hashes the raw body; mask all three (finalize pins the etag shape).
  normalizeView(view) {
    const out = { ...view, headers: { ...view.headers } };
    if (out.headers.etag) out.headers.etag = '<etag>';
    out.body = out.body
      .replace(/"cursor":"[0-9a-f-]{36}:\d+"/g, '"cursor":"<cursor>"')
      .replace(/"previous":"[0-9a-f-]{36}:\d+"/g, '"previous":"<cursor>"')
      .replace(/"checkedAt":\d+/g, '"checkedAt":<now>');
    return out;
  },
  finalize({ work, views }) {
    const problems = [];
    const byName = new Map(views.map(view => [view.name, view]));

    // Byte-identical envelopes could hide a read model that never became
    // ready, so pin the proofs that the real handlers ran.
    const bootstrap = byName.get('sync bootstrap');
    if (!bootstrap || bootstrap.node.status !== 200
      || !bootstrap.node.body.includes('"taskStats"')
      || !bootstrap.node.body.includes('"id":"tk-001"')
      || !bootstrap.node.body.includes('"checkedAt":<now>')) {
      problems.push(`sync bootstrap: not a real bootstrap body (${bootstrap && bootstrap.node.body})`);
    }
    for (const name of ['sync an unknown epoch resets', 'sync a malformed cursor resets',
      'sync a repeated cursor joins', 'sync an object cursor folds like qs']) {
      const view = byName.get(name);
      if (!view || view.node.status !== 200 || !view.node.body.includes('"reset":true')) {
        problems.push(`${name}: expected a reset reply`);
      }
    }
    // `include` must be observable in the bytes, not only in the forwarded
    // bodies: the deep card is absent from the plain bootstrap and present
    // once it is requested (as a scalar and as part of a repeated key).
    const deepKey = `"id":"${DEEP_ID}"`;
    if (bootstrap && bootstrap.node.body.includes(deepKey)) {
      problems.push(`sync bootstrap: ${DEEP_ID} must sit past the first thirty cards`);
    }
    for (const name of ['sync include pulls a card past the first thirty', 'sync include list pulls a deep card']) {
      const view = byName.get(name);
      if (!view || view.node.status !== 200 || !view.node.body.includes(deepKey)) {
        problems.push(`${name}: include must bring ${DEEP_ID} into the bootstrap`);
      }
    }
    // The page projection really paginated: 40 cards, 20 per page.
    const pageShape = (name, want) => {
      const view = byName.get(name);
      let body = null;
      try { body = JSON.parse(view.node.body); } catch (_) { /* reported below */ }
      if (!body || body.page !== want.page || body.pages !== want.pages
        || body.total !== want.total || body.tasks.length !== want.rows) {
        problems.push(`${name}: expected ${JSON.stringify(want)}, node answered ${view && view.node.body.slice(0, 160)}`);
      }
    };
    pageShape('page default', { page: 1, pages: 2, total: 40, rows: 20 });
    pageShape('page second page', { page: 2, pages: 2, total: 40, rows: 20 });
    pageShape('page past the last page clamps', { page: 2, pages: 2, total: 40, rows: 20 });
    pageShape('page small limit', { page: 3, pages: 6, total: 40, rows: 7 });
    pageShape('page ids narrows the board', { page: 1, pages: 1, total: 2, rows: 2 });
    const threaded = byName.get('sync with the seized cursor');
    if (!threaded || threaded.node.status !== 200
      || !threaded.node.body.includes('"events":[]') || threaded.node.body.includes('"reset":true')) {
      problems.push('sync with the seized cursor: the threaded cursor must answer events, not reset');
    }
    // The native page projection rejects a non-numeric limit and a repeated
    // status with a napi error that carries no HTTP status but does carry the
    // napi code "GenericFailure"; the retired catch arm keeps `error.code`
    // (default air_request_failed only when it is absent) and hides the
    // message behind "Request failed" because `error.status` is unset.
    for (const name of ['page limit garbage is a 500', 'page repeated status is a 500']) {
      const view = byName.get(name);
      const want = '{"ok":false,"code":"GenericFailure","message":"Request failed"}';
      if (!view || view.node.status !== 500 || view.node.body !== want) {
        problems.push(`${name}: expected the 500 GenericFailure envelope, node answered `
          + `${view && view.node.status} ${view && view.node.body}`);
      }
    }
    // No other case may fall into the generic 500.
    for (const view of views) {
      if (['page limit garbage is a 500', 'page repeated status is a 500'].includes(view.name)) continue;
      for (const side of ['node', 'rust']) {
        if (view[side].status === 500) problems.push(`${view.name}: ${side} answered 500 (${view[side].body})`);
      }
    }
    const conditional = byName.get('sync conditional with the seized etag');
    if (!conditional || conditional.node.status !== 304 || conditional.rust.status !== 304) {
      problems.push('sync conditional with the seized etag: expected 304 on both sides');
    }
    for (const name of ['HEAD sync', 'HEAD page']) {
      const view = byName.get(name);
      if (!view || view.node.body !== '' || !view.node.headers['content-length']) {
        problems.push(`${name}: expected a stripped body with Content-Length`);
      }
    }
    // etag 1.8.1: W/"<byte length in hex>-<27 base64 chars of the sha1>"
    const etagShape = /^W\/"[0-9a-f]+-[A-Za-z0-9+/]{27}"$/;
    if (!etagShape.test(seized.node.etag || '') || !etagShape.test(seized.rust.etag || '')) {
      problems.push(`etag shape: node=${seized.node.etag} rust=${seized.rust.etag}`);
    }

    // The forwarded host-port bodies, pairwise against the retired handlers' q
    // folded through the documented contract.
    const rustBodies = fs.readFileSync(bodiesPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const hostHitting = corpus()
      .filter(([, request]) => ['GET', 'HEAD'].includes(request({ name: 'node', state: {} }).method))
      .map(([name]) => name);
    if (nodeCalls.length !== hostHitting.length
      || nodeCalls.some((call, index) => call.case !== hostHitting[index])) {
      problems.push(`node side recorded ${nodeCalls.length} host calls, expected ${hostHitting.length} in corpus order`);
    }
    if (rustBodies.length !== hostHitting.length) {
      problems.push(`rust side recorded ${rustBodies.length} host bodies, expected ${hostHitting.length}`);
    }
    const mismatches = [];
    const pairs = Math.min(nodeCalls.length, rustBodies.length);
    for (let i = 0; i < pairs; i++) {
      const expected = unseize(contractBody(nodeCalls[i]), 'node');
      const actual = unseize(rustBodies[i], 'rust');
      if (stable(actual) !== stable(expected)) {
        mismatches.push({ case: nodeCalls[i].case, expected, actual });
      }
    }
    // The interesting shapes must really have flowed: a list, an object fold,
    // a verbatim garbage string and the threaded per-side cursor.
    const saw = {
      list: rustBodies.some(body => Array.isArray(body.include) && body.include.length === 2),
      fold: rustBodies.some(body => body.cursor && typeof body.cursor === 'object'
        && !Array.isArray(body.cursor) && Object.keys(body.cursor).length === 0),
      garbage: rustBodies.some(body => body.dayStart === 'abc'),
      threaded: rustBodies.some(body => body.cursor === seized.rust.cursor),
    };
    for (const [shape, present] of Object.entries(saw)) {
      if (!present) problems.push(`forwarded bodies: never saw the ${shape} shape`);
    }
    const details = path.join(work, 'forwarded-bodies.json');
    fs.writeFileSync(details, JSON.stringify({ mismatches, nodeCalls, rustBodies, views }, null, 2));
    for (const problem of problems) console.log(`[air-sync-routes] ${problem}`);
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
      return { ok: false, details };
    }
    if (problems.length) return { ok: false, details };
    console.log(`[air-sync-routes] forwarded bodies identical in ${pairs} case(s)`);
    return { ok: true, details };
  },
});
