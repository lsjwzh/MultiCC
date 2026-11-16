'use strict';
// Byte-for-byte differential for `GET /api/channels`, retired from
// src/routes/plugins.js (native/gateway/src/app/plugins.rs plus
// multicc_core::plugin_routes::shape_channels).
//
// The Node oracle is the frozen handler copy in
// tests/helpers/legacy-channels-route.js (verbatim from commit e4ec0604). The
// Rust side is the real front door: it asks the Node child for the two
// Node-only facts through `POST /api/__host/plugins` (op `channelsStatus`),
// which this script's stub answers from the SAME scenario the oracle's injected
// `channelHost.status()` / `usage()` return. Both sides therefore see identical
// facts; only the shaping and the rendering are under test.
//
// A scenario is picked per request by writing its name to a file both sides
// read (`hooks.before` runs just before each side's request). The front door
// does not forward request headers to the host port, so a header could not
// carry it.
//
// What it covers that a black-box Rust test cannot: the anonymous / remote
// gate shapes, the 404 HTML Express answers for shapes the route never
// registered, and byte-level JSON (key order, number rendering, spread
// overwrite keeping the original key position).
//
// Usage: node docs/rust-migration/differential/channels.js <repo> <gateway> <addon>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { main } = require('./lib');

// ---- scenarios: the facts channelHost.status() and channelRegistry.usage() would hold ----
// `undefined` fields are included on purpose: Node's res.json drops them, and the
// stub's JSON.stringify drops them too, so both sides must agree on their absence.
const alert = (id, extra = {}) => ({ id, text: `alert ${id}`, since: 1700000000000, ...extra });
const SCENARIOS = {
  mixed: {
    available: true,
    status: [
      { id: 'discord', name: 'Discord', nameEn: 'Discord', version: '1.2.0', channel: { id: 'discord', label: 'Discord' }, ui: '/plugins/discord/ui/index.html', running: true, ready: true, pid: 4242, startedAt: 1700000000123, readyAt: 1700000000456, restarts: 0, lastExit: null, alerts: [] },
      { id: 'feishu', name: '飞书', nameEn: null, version: null, channel: 'feishu', ui: null, running: false, ready: false, pid: null, startedAt: null, readyAt: null, restarts: 3, lastExit: { code: 1, signal: null, at: 1700000009999 }, alerts: [alert('a1'), alert('a2', { level: 'warn' })] },
      { id: 'helper', name: 'Helper', nameEn: null, version: '0.0.1', channel: null, ui: null, running: true, ready: true, pid: 7, startedAt: 1, readyAt: 2, restarts: 0, lastExit: null, alerts: [] },
      { id: 'skipped', name: 'Skipped', nameEn: null, version: null, channel: null, ui: null, running: false, ready: false, unsupported: 'not for this platform', alerts: [] },
    ],
    usage: [
      { plugin: 'discord', kind: 'push', target: 'c1' }, { plugin: 'discord', kind: 'push', target: 'c2' },
      { plugin: 'discord', kind: 'hook', target: 'c3' }, { plugin: 'feishu', kind: 'hook', event: 'done' },
      { plugin: 'ghost', kind: 'push' }, { plugin: 'helper', kind: 'push' },
    ],
  },
  empty: { available: true, status: [], usage: [] },
  noHost: { available: false, status: [], usage: [{ plugin: 'discord', kind: 'push' }] },
  noUsage: {
    available: true,
    status: [{ id: 'discord', name: 'Discord', channel: 'discord', running: true, ready: true, alerts: [] }],
    usage: [],
  },
  // channel truthiness: every JS falsy value is "no channel" (returned untouched),
  // every other value (including empty arrays and objects, 0 as a string) is a channel.
  truthiness: {
    available: true,
    status: [
      { id: 'f-null', channel: null }, { id: 'f-false', channel: false }, { id: 'f-zero', channel: 0 }, { id: 'f-empty', channel: '' },
      { id: 'f-missing' },
      { id: 't-string', channel: 'x' }, { id: 't-zero-string', channel: '0' }, { id: 't-array', channel: [] }, { id: 't-object', channel: {} },
      { id: 't-true', channel: true }, { id: 't-one', channel: 1 }, { id: 't-neg', channel: -1 }, { id: 't-float', channel: 0.5 },
    ],
    usage: [{ plugin: 't-string', kind: 'push' }, { plugin: 'f-null', kind: 'push' }, { plugin: 't-array', kind: 'hook' }],
  },
  // the three added keys when the item already has them: the spread assigns in
  // place, so the key keeps its ORIGINAL position and the missing ones append.
  overwrite: {
    available: true,
    status: [
      { inUse: 'stale', id: 'p', uses: 99, channel: 'p', subscriptions: 'old', tail: true },
      { id: 'q', channel: 'q', inUse: true },
    ],
    usage: [{ plugin: 'p', kind: 'push' }, { plugin: 'p', kind: 'push' }, { plugin: 'p', kind: 'hook' }],
  },
  // strict equality: ids and usage plugins of different JSON types never match.
  strictEquality: {
    available: true,
    status: [{ id: 1, channel: 'a' }, { id: '1', channel: 'a' }, { id: null, channel: 'a' }, { channel: 'a' }, { id: true, channel: 'a' }],
    usage: [{ plugin: '1', kind: 'push' }, { plugin: 1, kind: 'push' }, { plugin: true, kind: 'push' }],
  },
  // kind comparison is strict too.
  kinds: {
    available: true,
    status: [{ id: 'k', channel: 'k' }],
    usage: [{ plugin: 'k', kind: 'push' }, { plugin: 'k', kind: 'PUSH' }, { plugin: 'k', kind: ' push' }, { plugin: 'k', kind: ['push'] }, { plugin: 'k' }, { plugin: 'k', kind: null }],
  },
  numbers: {
    available: true,
    status: [{ id: 'n', channel: 'n', pid: 2147483648, startedAt: 9007199254740991, readyAt: 1.5, restarts: 0.1, ratio: 1e21, tiny: 1e-7, big: 123456789012345680000, neg: -0, exp: 1.5e300, intLike: 100, float: 100.0, fraction: 0.30000000000000004 }],
    usage: [],
  },
  text: {
    available: true,
    status: [
      { id: 'u', name: '中文 😀   \u0007 "quote" \\ back', channel: 'u', description: '<script>&amp;</script>\n\ttab', empty: '', alerts: [{ text: 'line1\nline2' }] },
    ],
    usage: [{ plugin: 'u', kind: 'push' }],
  },
  nested: {
    available: true,
    status: [{ id: 'd', channel: { deep: { a: [1, { b: [] }, null, 'x'] }, order: { z: 1, a: 2, m: 3 } }, alerts: [{ nested: [[], {}, [null]] }], extra: [] }],
    usage: [{ plugin: 'd', kind: 'push', meta: { k: 'v' } }],
  },
  many: {
    available: true,
    status: Array.from({ length: 60 }, (_, i) => ({ id: `plugin-${String(i).padStart(2, '0')}`, name: `Plugin ${i}`, channel: i % 3 === 0 ? null : `ch${i}`, running: i % 2 === 0, ready: i % 4 === 0, alerts: [] })),
    usage: Array.from({ length: 90 }, (_, i) => ({ plugin: `plugin-${String(i % 60).padStart(2, '0')}`, kind: i % 2 ? 'push' : 'hook' })),
  },
};

const SCENARIO_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'channels-scn-')), 'scenario');
process.on('exit', () => { try { fs.rmSync(path.dirname(SCENARIO_FILE), { recursive: true, force: true }); } catch (_) { /* best effort */ } });
const setScenario = name => fs.writeFileSync(SCENARIO_FILE, name);
setScenario('mixed');

// What the real host op answers with for a scenario (src/routes/plugins-host.js).
const hostAnswer = name => {
  const s = SCENARIOS[name];
  return { ok: true, available: s.available, plugins: s.status, usage: s.usage };
};

function upstreamScript() {
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const path = require('node:path'); const fs = require('node:fs');
const repo = ${JSON.stringify(path.resolve(__dirname, '../../..'))};
const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
const { connectAuthControl } = require(path.join(repo, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
const SCENARIOS = ${JSON.stringify(SCENARIOS)};
const SCENARIO_FILE = ${JSON.stringify(SCENARIO_FILE)};
const callsFile = path.join(process.env.MULTICC_DATA_DIR, 'channels-calls.jsonl');
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
    fs.appendFileSync(callsFile, JSON.stringify(body) + '\\n');
    if (req.url !== '/api/__host/plugins') {
      const text = 'forwarded:' + req.method + ' ' + req.url;
      res.writeHead(599, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(text) });
      return res.end(text);
    }
    if (body.op === 'channelsStatus') {
      const name = fs.readFileSync(SCENARIO_FILE, 'utf8');
      if (name === 'hostError') return reply(res, { ok: false, error: { message: 'boom' } });
      if (name === 'hostDown') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('down'); }
      const s = SCENARIOS[name];
      return reply(res, { ok: true, available: s.available, plugins: s.status, usage: s.usage });
    }
    return reply(res, { error: 'unknown host operation' }, 400);
  });
});
function reply(res, value, status = 200) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
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

function corpus(ctx) {
  const h = { 'x-access-token': ctx.token };
  const remote = { host: 'example.test' };
  const cases = [];
  const scn = name => ({ before: async () => setScenario(name) });
  const add = (name, request, scenario = 'mixed', hooks = {}) => cases.push([name, request, { ...scn(scenario), ...hooks }]);
  const get = (url, extra = {}) => ({ method: 'GET', url, headers: { ...h, ...extra } });

  // ---- every scenario through the same GET ---------------------------------------------
  for (const name of Object.keys(SCENARIOS)) add(`scenario ${name}`, get('/api/channels'), name);
  // ---- request shapes (mixed facts) ---------------------------------------------------
  add('HEAD', { method: 'HEAD', url: '/api/channels', headers: { ...h } });
  add('trailing slash', get('/api/channels/'));
  add('mixed case path segment', get('/api/Channels'));
  add('query string is ignored', get('/api/channels?x=1&plugin=discord'));
  add('Accept json', get('/api/channels', { accept: 'application/json' }));
  add('Accept gzip', get('/api/channels', { 'accept-encoding': 'gzip' }));
  add('If-None-Match miss', get('/api/channels', { 'if-none-match': '"nope"' }));
  add('If-None-Match star', get('/api/channels', { 'if-none-match': '*' }));
  add('OPTIONS', { method: 'OPTIONS', url: '/api/channels', headers: { ...h } });
  add('POST is not registered', { method: 'POST', url: '/api/channels', headers: { ...h, 'content-type': 'application/json' }, body: '{}' }, 'mixed', { expectedDifference: {
    node: v => v.status === 404,
    rust: v => v.status === 599 && v.body === 'forwarded:POST /api/channels',
  } });
  add('PUT is not registered', { method: 'PUT', url: '/api/channels', headers: { ...h, 'content-type': 'application/json' }, body: '{}' }, 'mixed', { expectedDifference: {
    node: v => v.status === 404,
    rust: v => v.status === 599 && v.body === 'forwarded:PUT /api/channels',
  } });
  add('DELETE is not registered', { method: 'DELETE', url: '/api/channels', headers: { ...h } }, 'mixed', { expectedDifference: {
    node: v => v.status === 404,
    rust: v => v.status === 599 && v.body === 'forwarded:DELETE /api/channels',
  } });
  add('double slash', get('/api//channels'), 'mixed', { expectedDifference: {
    node: v => v.status === 404,
    rust: v => v.status === 599 && v.body === 'forwarded:GET /api//channels',
  } });
  add('extra segment', get('/api/channels/extra'), 'mixed', { expectedDifference: {
    node: v => v.status === 404,
    rust: v => v.status === 599 && v.body === 'forwarded:GET /api/channels/extra',
  } });
  add('targets is another route', get('/api/channels/targets'), 'mixed', { expectedDifference: {
    node: v => v.status === 404,
    rust: v => v.status === 599 && v.body === 'forwarded:GET /api/channels/targets',
  } });
  // The front door leaves a differently cased `/api/` prefix to Node (the convention every
  // other cluster follows), while Express matched it: a documented, guarded difference.
  add('upper case api prefix', get('/API/channels'), 'mixed', { expectedDifference: {
    node: v => v.status === 200 && v.body.startsWith('{"available":true,"plugins":['),
    rust: v => v.status === 599 && /^forwarded:GET \/API\/channels$/.test(v.body),
  } });
  // ---- authentication shapes (the class of difference the plugin files differential caught) ----
  add('anonymous remote', { method: 'GET', url: '/api/channels', headers: { ...remote } });
  add('wrong token remote', { method: 'GET', url: '/api/channels', headers: { ...remote, 'x-access-token': 'wrong' } });
  add('right token remote', { method: 'GET', url: '/api/channels', headers: { ...remote, 'x-access-token': ctx.token } });
  add('anonymous remote asking for html', { method: 'GET', url: '/api/channels', headers: { ...remote, accept: 'text/html' } });
  add('anonymous remote HEAD', { method: 'HEAD', url: '/api/channels', headers: { ...remote } });
  add('anonymous remote OPTIONS', { method: 'OPTIONS', url: '/api/channels', headers: { ...remote } });
  add('anonymous remote POST', { method: 'POST', url: '/api/channels', headers: { ...remote, 'content-type': 'application/json' }, body: '{}' }, 'mixed', { expectedDifference: {
    node: v => v.status === 403,
    rust: v => v.status === 599 && v.body === 'forwarded:POST /api/channels',
  } });
  add('anonymous local', { method: 'GET', url: '/api/channels', headers: {} });
  add('cookie is not a token', { method: 'GET', url: '/api/channels', headers: { ...remote, cookie: 'x=1' } });
  return cases;
}

main({
  name: 'channels',
  mount(app, ctx) {
    const express = require(require.resolve('express', { paths: [ctx.repo] }));
    const { createLegacyChannelsRoute } = require(path.join(ctx.repo, 'tests/helpers/legacy-channels-route'));
    const current = () => SCENARIOS[fs.readFileSync(SCENARIO_FILE, 'utf8')];
    // `available` is `Boolean(channelHost)`, fixed when the frozen factory runs, so two
    // instances of the unchanged oracle are mounted on two plain routers and a thin
    // middleware picks one per request from the scenario. A router adds no prefix and
    // changes neither `req.url` nor any header, so the oracle answers exactly as it would
    // mounted directly on the app.
    const build = withHost => {
      const router = express.Router();
      createLegacyChannelsRoute({
        channelHost: withHost ? { status: () => current().status } : null,
        usage: () => current().usage,
      })(router);
      return router;
    };
    const withHost = build(true);
    const withoutHost = build(false);
    app.use((req, res, next) => (current().available ? withHost : withoutHost)(req, res, next));
  },
  upstream: upstreamScript(),
  corpus,
  // ETag is a hash of the body; an error body carries each side's own random request
  // ids, so blank it only for a body with the placeholder (a body without one keeps
  // its ETag and must match byte for byte).
  normalizeView(view) {
    // A HEAD answer has no body to carry the placeholder, but its ETag is still the hash of the
    // GET body, so the random request id header marks it the same way.
    const randomBody = view.body.includes('<rand>')
      || (view.body === '' && view.headers['x-multicc-request-id'] === '<rand>');
    if (view.headers.etag !== undefined && randomBody) {
      return { ...view, headers: { ...view.headers, etag: '<etag-of-random-body>' } };
    }
    return view;
  },
});
