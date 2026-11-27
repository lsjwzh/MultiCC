'use strict';
// Byte-for-byte differential for the plugin cluster retired from
// src/routes/plugins.js: `POST /api/channels/recheck` and
// `GET|HEAD /plugins/:id/*` (native/gateway/src/app/plugins.rs plus
// multicc_core::plugin_routes).
//
// The Node oracle is the frozen handler copy in
// tests/helpers/legacy-plugins-routes.js (verbatim from commit 14d6f54a, not a
// live `git show`, so it keeps running as the tree moves). The Rust side is the
// real front door: it asks the Node child for the two Node-only facts through
// `POST /api/__host/plugins`, which this script's stub answers from the very
// same data the oracle's injected `findManifest`/`stillActive` read. Both sides
// therefore see identical facts and an identical on-disk plugin tree (including
// a symlink that points outside it); only the rendering is under test.
//
// What it does NOT cover, on purpose:
//   - recheck's 403 for a non-local client. The differential talks to both
//     servers over 127.0.0.1, so both judge the caller local. That branch is
//     covered by native/gateway/tests/plugins.rs, which can fabricate a
//     non-local peer.
//   - the 500 an unreadable plugin directory produces: it is covered there too.
//
// Usage: node docs/rust-migration/differential/plugins.js <repo> <gateway> <addon>
const path = require('node:path');
const fs = require('node:fs');
const { main } = require('./lib');

// The facts both sides read. Keyed by the session id the recheck corpus sends.
const ACTIVE = { 'sess-active': true, 'sess-idle': false };
const category = c => c;
const stillActive = (sessionId, cat) => {
  // Mirrors channel-registry.stillActive for an unknown category / empty id
  // (the retired code returned true there) and a lookup table otherwise.
  if (!sessionId || !['attention', 'done', 'error'].includes(cat)) return true;
  return Object.prototype.hasOwnProperty.call(ACTIVE, sessionId) ? ACTIVE[sessionId] : false;
};

// One plugin tree both sides read. `ui/` is the declared UI subtree; everything
// outside it must stay unreachable.
function buildTree(work) {
  const root = path.join(work, 'plugins-tree');
  const plain = path.join(root, 'demo');            // manifest.ui = ui/index.html (default)
  const flat = path.join(root, 'flat');             // manifest.ui = index.html (UI root = plugin root)
  const nested = path.join(root, 'nested');         // manifest.ui = web/app/index.html
  for (const dir of [plain, flat, nested]) fs.mkdirSync(dir, { recursive: true });
  const manifest = extra => JSON.stringify({ id: path.basename(extra.dir), commands: ['x'], engine: { type: 'command', binary: 'bin/x' }, ...extra.fields });
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

  write(path.join(plain, 'plugin.json'), manifest({ dir: plain, fields: {} }));
  write(path.join(plain, 'ui/index.html'), '<!doctype html><title>demo 中文 😀</title>\n');
  write(path.join(plain, 'ui/app.js'), 'console.log("app");\n');
  write(path.join(plain, 'ui/style.CSS'), 'body{color:red}\n');
  write(path.join(plain, 'ui/data.json'), '{"a":1}\n');
  write(path.join(plain, 'ui/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  write(path.join(plain, 'ui/pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]));
  write(path.join(plain, 'ui/favicon.ico'), Buffer.from([0, 0, 1, 0, 1, 0]));
  write(path.join(plain, 'ui/archive.bin'), Buffer.from([1, 2, 3, 4]));
  write(path.join(plain, 'ui/noext'), 'no extension\n');
  write(path.join(plain, 'ui/empty.txt'), '');
  write(path.join(plain, 'ui/sub/deep/page.html'), '<p>deep</p>\n');
  write(path.join(plain, 'ui/中文 name.html'), '<p>unicode</p>\n');
  write(path.join(plain, 'ui/a b.js'), '// space\n');
  fs.mkdirSync(path.join(plain, 'ui/dir'), { recursive: true });
  write(path.join(plain, 'secret.txt'), 'outside the UI subtree\n');
  write(path.join(plain, 'bin/x'), '#!/bin/sh\n');
  write(path.join(root, 'outside.txt'), 'outside the plugin dir\n');
  // A symlink inside the UI subtree that escapes the plugin directory.
  try { fs.symlinkSync(path.join(root, 'outside.txt'), path.join(plain, 'ui/escape.txt')); } catch (_) { /* best effort */ }
  // A symlink inside the UI subtree that stays inside the plugin directory but leaves the UI subtree.
  try { fs.symlinkSync(path.join(plain, 'secret.txt'), path.join(plain, 'ui/to-secret.txt')); } catch (_) { /* best effort */ }
  // A symlink inside the UI subtree that stays inside it.
  try { fs.symlinkSync(path.join(plain, 'ui/app.js'), path.join(plain, 'ui/alias.js')); } catch (_) { /* best effort */ }

  write(path.join(flat, 'plugin.json'), manifest({ dir: flat, fields: { ui: 'index.html' } }));
  write(path.join(flat, 'index.html'), '<p>flat</p>\n');
  write(path.join(flat, 'other.js'), 'flat();\n');

  write(path.join(nested, 'plugin.json'), manifest({ dir: nested, fields: { ui: 'web/app/index.html' } }));
  write(path.join(nested, 'web/app/index.html'), '<p>nested</p>\n');
  write(path.join(nested, 'web/app/x.js'), 'n();\n');
  write(path.join(nested, 'web/other.js'), 'outside the declared ui dir\n');
  return root;
}

// The oracle's `findManifest`: same result shape as plugins.js readManifest.
function findManifestFor(root) {
  return id => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null;
    const dir = path.resolve(root, id);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch (_) { return null; }
    if (manifest.id !== id) return null;
    return { manifest, dir };
  };
}

function upstreamScript(treeRoot) {
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const path = require('node:path'); const fs = require('node:fs');
const treeRoot = ${JSON.stringify(treeRoot)};
const repo = ${JSON.stringify(path.resolve(__dirname, '../../..'))};
const { createAuthSecurity } = require(path.join(repo, 'src/native/binding')).authSecurity;
const { connectAuthControl } = require(path.join(repo, 'src/native/binding')).gatewayChild;
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
const ACTIVE = ${JSON.stringify(ACTIVE)};
const stillActive = ${stillActive.toString()};
const callsFile = path.join(process.env.MULTICC_DATA_DIR, 'plugins-calls.jsonl');
function findPlugin(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return { ok: true, found: false };
  const dir = path.resolve(treeRoot, id);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch (_) { return { ok: true, found: false }; }
  if (manifest.id !== id) return { ok: true, found: false };
  const ui = typeof manifest.ui === 'string' && manifest.ui ? manifest.ui : 'ui/index.html';
  return { ok: true, found: true, dir, ui };
}
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
    if (body.op === 'findPlugin') return reply(res, findPlugin(body.id));
    if (body.op === 'channelStillActive') {
      const items = Array.isArray(body.items) ? body.items : [];
      return reply(res, { ok: true, active: items.map(item => stillActive(item.sessionId, item.category)) });
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
  const json = (method, url, body, extra = {}) => ({ method, url, headers: { ...h, 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (url, extra = {}) => ({ method: 'GET', url, headers: { ...h, ...extra } });
  const cases = [];
  const add = (name, request, hooks) => cases.push(hooks ? [name, request, hooks] : [name, request]);

  // ---- POST /api/channels/recheck -------------------------------------------------
  const long = n => 'x'.repeat(n);
  const emoji = '😀';
  add('recheck: two items, one active one idle', json('POST', '/api/channels/recheck', { items: [{ sessionId: 'sess-active', category: 'attention' }, { sessionId: 'sess-idle', category: 'done' }] }));
  add('recheck: unknown category keeps active true', json('POST', '/api/channels/recheck', { items: [{ sessionId: 'sess-idle', category: 'nope' }] }));
  add('recheck: empty session id keeps active true', json('POST', '/api/channels/recheck', { items: [{ sessionId: '', category: 'attention' }] }));
  add('recheck: missing fields', json('POST', '/api/channels/recheck', { items: [{}] }));
  add('recheck: non string fields', json('POST', '/api/channels/recheck', { items: [{ sessionId: 7, category: ['attention'] }] }));
  add('recheck: items not an array', json('POST', '/api/channels/recheck', { items: 'sess-active' }));
  add('recheck: items object', json('POST', '/api/channels/recheck', { items: { sessionId: 'sess-active' } }));
  add('recheck: no body items key', json('POST', '/api/channels/recheck', {}));
  add('recheck: empty array', json('POST', '/api/channels/recheck', { items: [] }));
  add('recheck: null body', json('POST', '/api/channels/recheck', null));
  add('recheck: non object elements are dropped', json('POST', '/api/channels/recheck', { items: [null, 1, 'x', true, { sessionId: 'sess-active', category: 'attention' }, [], [1]] }));
  add('recheck: sessionId cut at 128', json('POST', '/api/channels/recheck', { items: [{ sessionId: long(200), category: 'attention' }] }));
  add('recheck: category cut at 32', json('POST', '/api/channels/recheck', { items: [{ sessionId: 'sess-active', category: long(40) }] }));
  add('recheck: surrogate pair straddles the 128 cut', json('POST', '/api/channels/recheck', { items: [{ sessionId: long(127) + emoji + 'tail', category: 'attention' }] }));
  add('recheck: surrogate pair straddles the 32 cut', json('POST', '/api/channels/recheck', { items: [{ sessionId: 'sess-active', category: long(31) + emoji }] }));
  add('recheck: unicode session id', json('POST', '/api/channels/recheck', { items: [{ sessionId: '会话-😀', category: 'attention' }] }));
  add('recheck: 201 items are cut at 200', json('POST', '/api/channels/recheck', { items: Array.from({ length: 201 }, (_, i) => ({ sessionId: i % 2 ? 'sess-active' : 'sess-idle', category: 'attention' })) }));
  add('recheck: 200 items exactly', json('POST', '/api/channels/recheck', { items: Array.from({ length: 200 }, () => ({ sessionId: 'sess-active', category: 'done' })) }));
  add('recheck: non-object entries before the cut are dropped after slicing', json('POST', '/api/channels/recheck', { items: [...Array.from({ length: 199 }, () => null), { sessionId: 'sess-active', category: 'attention' }, { sessionId: 'sess-idle', category: 'attention' }] }));
  add('recheck: malformed json', { method: 'POST', url: '/api/channels/recheck', headers: { ...h, 'content-type': 'application/json' }, body: '{"items": [' });
  add('recheck: form encoded body is ignored', { method: 'POST', url: '/api/channels/recheck', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: 'items=1' });
  add('recheck: no content type', { method: 'POST', url: '/api/channels/recheck', headers: { ...h }, body: '{"items":[{"sessionId":"sess-active","category":"attention"}]}' });
  add('recheck: unauthenticated', { method: 'POST', url: '/api/channels/recheck', headers: { 'content-type': 'application/json', host: 'example.test' }, body: '{"items":[]}' });
  add('recheck: OPTIONS', { method: 'OPTIONS', url: '/api/channels/recheck', headers: { ...h } });
  add('recheck: GET is not registered', get('/api/channels/recheck'), { expectedDifference: { node: v => v.status === 404, rust: v => v.status === 599 && /^forwarded:/.test(v.body) } });
  add('recheck: trailing slash', json('POST', '/api/channels/recheck/', { items: [{ sessionId: 'sess-active', category: 'attention' }] }));
  add('recheck: upper case path', json('POST', '/API/CHANNELS/RECHECK', { items: [{ sessionId: 'sess-active', category: 'attention' }] }), { expectedDifference: { node: v => v.status === 200 && /\"items\"/.test(v.body), rust: v => v.status === 599 && /^forwarded:/.test(v.body) } });

  // ---- GET|HEAD /plugins/:id/* ----------------------------------------------------
  const files = ['index.html', 'app.js', 'style.CSS', 'data.json', 'logo.svg', 'pic.png', 'favicon.ico', 'archive.bin', 'noext', 'empty.txt', 'sub/deep/page.html', 'alias.js'];
  for (const f of files) {
    add(`file: GET ${f}`, get(`/plugins/demo/ui/${f}`));
    add(`file: HEAD ${f}`, { method: 'HEAD', url: `/plugins/demo/ui/${f}`, headers: { ...h } });
  }
  add('file: unicode name (percent encoded)', get('/plugins/demo/ui/%E4%B8%AD%E6%96%87%20name.html'));
  add('file: space (percent encoded)', get('/plugins/demo/ui/a%20b.js'));
  add('file: query string is ignored', get('/plugins/demo/ui/app.js?v=1&x=2'));
  add('file: double slash in the middle', get('/plugins/demo/ui//app.js'));
  add('file: dot segment in the middle', get('/plugins/demo/ui/./app.js'));
  add('file: backslash separator', get('/plugins/demo/ui/sub%5Cdeep%5Cpage.html'));
  add('file: dot dot', get('/plugins/demo/ui/../secret.txt'));
  add('file: encoded dot dot', get('/plugins/demo/ui/%2e%2e/secret.txt'));
  add('file: encoded dot dot slash', get('/plugins/demo/%2e%2e%2fsecret.txt'));
  add('file: dot dot in a name is refused too', get('/plugins/demo/ui/a..b'));
  add('file: leading encoded slash', get('/plugins/demo/%2fetc/passwd'));
  add('file: absolute looking', get('/plugins/demo//etc/passwd'));
  add('file: outside the UI subtree', get('/plugins/demo/secret.txt'));
  add('file: plugin manifest is not served', get('/plugins/demo/plugin.json'));
  add('file: plugin binary is not served', get('/plugins/demo/bin/x'));
  add('file: symlink escaping the plugin dir', get('/plugins/demo/ui/escape.txt'));
  add('file: symlink leaving only the UI subtree', get('/plugins/demo/ui/to-secret.txt'));
  add('file: missing file', get('/plugins/demo/ui/missing.js'));
  add('file: directory', get('/plugins/demo/ui/dir'));
  add('file: directory with trailing slash', get('/plugins/demo/ui/dir/'));
  add('file: ui directory itself', get('/plugins/demo/ui/'));
  add('file: plugin root with only the star empty', get('/plugins/demo/'));
  add('file: plugin without the second segment', get('/plugins/demo'), { expectedDifference: { node: v => v.status === 404, rust: v => v.status === 599 && /^forwarded:/.test(v.body) } });
  add('file: unknown plugin', get('/plugins/ghost/ui/index.html'));
  add('file: unknown plugin id is echoed (unicode)', get('/plugins/%E5%B9%BD%E7%81%B5/ui/index.html'));
  add('file: id with a dot dot', get('/plugins/../ui/index.html'));
  add('file: id failing the pattern', get('/plugins/-bad/ui/index.html'));
  add('file: id with a slash encoded', get('/plugins/de%2Fmo/ui/index.html'));
  add('file: malformed percent escape', get('/plugins/demo/ui/%E0%A4%A'));
  add('file: flat plugin serves its root', get('/plugins/flat/index.html'));
  add('file: flat plugin serves a sibling', get('/plugins/flat/other.js'));
  add('file: flat plugin manifest is inside the UI root', get('/plugins/flat/plugin.json'));
  add('file: nested ui dir serves its tree', get('/plugins/nested/web/app/x.js'));
  add('file: nested ui dir refuses the parent', get('/plugins/nested/web/other.js'));
  add('file: upper case route prefix', get('/PLUGINS/demo/ui/app.js'));
  add('file: unauthenticated', { method: 'GET', url: '/plugins/demo/ui/app.js', headers: { host: 'example.test' } });
  add('file: OPTIONS', { method: 'OPTIONS', url: '/plugins/demo/ui/app.js', headers: { ...h } });
  add('file: POST is not registered', json('POST', '/plugins/demo/ui/app.js', {}), { expectedDifference: { node: v => v.status === 404, rust: v => v.status === 599 && /^forwarded:/.test(v.body) } });
  add('file: If-None-Match miss', get('/plugins/demo/ui/app.js', { 'if-none-match': '"nope"' }));
  add('file: If-Modified-Since', get('/plugins/demo/ui/app.js', { 'if-modified-since': 'Wed, 21 Oct 2099 07:28:00 GMT' }));
  add('file: Range request', get('/plugins/demo/ui/app.js', { range: 'bytes=0-3' }));
  add('file: Accept-Encoding gzip', get('/plugins/demo/ui/index.html', { 'accept-encoding': 'gzip' }));
  add('file: If-None-Match hit (etag learned from the first answer)', ctxSide => ({ method: 'GET', url: '/plugins/demo/ui/app.js', headers: { ...h, 'if-none-match': ctxSide.state.etag || '"unset"' } }), {
    before: async side => { side.state.etag = await etagOf(side.port, '/plugins/demo/ui/app.js', h); },
  });
  add('file: If-None-Match star', get('/plugins/demo/ui/app.js', { 'if-none-match': '*' }));
  add('file: If-None-Match weak hit on HEAD', ctxSide => ({ method: 'HEAD', url: '/plugins/demo/ui/index.html', headers: { ...h, 'if-none-match': ctxSide.state.etag2 || '"unset"' } }), {
    before: async side => { side.state.etag2 = await etagOf(side.port, '/plugins/demo/ui/index.html', h); },
  });

  // ---- anonymous file requests: the shared public-path rule --------------------------
  // A non-local Host makes both sides judge the caller anonymous and remote. Static
  // extensions (case-insensitive) pass the login on Node; everything else is the
  // HTML login redirect.
  const remote = { host: 'example.test' };
  for (const f of ['app.js', 'style.CSS', 'data.json', 'logo.svg', 'pic.png', 'favicon.ico']) {
    add(`anon: GET ${f} is public`, { method: 'GET', url: `/plugins/demo/ui/${f}`, headers: { ...remote } });
    add(`anon: HEAD ${f} is public`, { method: 'HEAD', url: `/plugins/demo/ui/${f}`, headers: { ...remote } });
  }
  for (const f of ['index.html', 'noext', 'archive.bin', 'empty.txt', 'sub/deep/page.html']) {
    add(`anon: GET ${f} is the login redirect`, { method: 'GET', url: `/plugins/demo/ui/${f}`, headers: { ...remote } });
  }
  add('anon: public extension but the plugin does not exist', { method: 'GET', url: '/plugins/ghost/ui/app.js', headers: { ...remote } });
  add('anon: public extension outside the UI subtree', { method: 'GET', url: '/plugins/demo/secret.json', headers: { ...remote } });
  add('anon: public extension, traversal', { method: 'GET', url: '/plugins/demo/ui/..%2fplugin.json', headers: { ...remote } });
  add('anon: upper case extension', { method: 'GET', url: '/plugins/demo/ui/STYLE.CSS', headers: { ...remote } });
  add('anon: Accept text/html does not change a public extension', { method: 'GET', url: '/plugins/demo/ui/app.js', headers: { ...remote, accept: 'text/html' } });
  add('anon: OPTIONS on a public extension', { method: 'OPTIONS', url: '/plugins/demo/ui/app.js', headers: { ...remote } });
  add('anon: OPTIONS on a page', { method: 'OPTIONS', url: '/plugins/demo/ui/index.html', headers: { ...remote } });
  add('anon: wrong token on a public extension', { method: 'GET', url: '/plugins/demo/ui/app.js', headers: { ...remote, 'x-access-token': 'wrong' } });
  add('anon: wrong token on a page', { method: 'GET', url: '/plugins/demo/ui/index.html', headers: { ...remote, 'x-access-token': 'wrong' } });
  return cases;
}

async function etagOf(port, url, headers) {
  const { send } = require('./lib');
  const res = await send(port, { method: 'GET', url, headers });
  return res.headers.etag || '';
}

// The plugin tree is built once, before the run, in a directory of its own: the
// stub upstream is a plain string handed to the front door, so it must already
// know the path, and the Node oracle reads the very same files.
const os = require('node:os');
const TREE_WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-tree-'));
const TREE_ROOT = buildTree(TREE_WORK);
process.on('exit', () => { try { fs.rmSync(TREE_WORK, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

main({
  name: 'plugins',
  mount(app, ctx) {
    const { createLegacyPluginsRoutes } = require(path.join(ctx.repo, 'tests/helpers/legacy-plugins-routes'));
    const { isLocalRequest } = require(path.join(ctx.repo, 'src/request-locality'));
    createLegacyPluginsRoutes({ findManifest: findManifestFor(TREE_ROOT), stillActive, isLocalRequest })(app);
  },
  upstream: upstreamScript(TREE_ROOT),
  corpus,
  // The ETag is a hash of the body, and an error body carries each side's own random
  // request ids, so the two ETags differ even when the normalised bodies are equal. Blank
  // the ETag only for such a body; a body without a placeholder keeps its ETag, which then
  // has to match byte for byte.
  normalizeView(view) {
    if (view.headers.etag !== undefined && view.body.includes('<rand>')) {
      return { ...view, headers: { ...view.headers, etag: '<etag-of-random-body>' } };
    }
    return view;
  },
});
