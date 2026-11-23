'use strict';
// Differential run for the `public/` static web root retired from
// src/routes/static-assets.js and now answered by
// native/gateway/src/app/static_web_root.rs (rules in
// native/core/src/static_web.rs + native/core/src/static_assets_routes.rs):
//
//   GET       <any>  -> the versioned-HTML middleware (the `?v=<mtime>` rewrite)
//   GET|HEAD  <any>  -> express.static(public/, { extensions: ['html'] })
//
//   node docs/rust-migration/differential/static-web-root.js <repo> <gateway>
//
// Both sides read the SAME public/ tree: the oracle's `publicDir` is the
// gateway's own `<cwd>/public`, so every mtime-derived value (the stat ETag,
// Last-Modified, the `?v=` stamp) has one source of truth and a mismatch is a
// real mismatch, not a clock artefact.
//
// The Node side mounts the FROZEN oracle (tests/helpers/
// legacy-static-assets-routes.js, a byte-for-byte copy of the module before
// anything was retired out of it). Requests it would have passed on land on a
// marker middleware (`599 node-fell-through`); the Rust side forwards what it
// does not claim to a PROXY v1 stub that answers `599 forwarded` and logs the
// URL, so `serve-static`'s `fallthrough: true` is proven on both sides.
//
// Claimed cases must be byte-for-byte identical, including the headers this
// migration turns on: Accept-Ranges, Last-Modified, Content-Range, Pragma,
// Expires, Content-Security-Policy and X-Content-Type-Options.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { run } = require('./lib');

const HDR = { Host: 'localhost', 'X-Request-Id': 'diff-swr-1' };
const HTML = { ...HDR, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

/** Headers the shared list does not carry but this route is made of. */
const HEADERS = [
  'accept-ranges', 'last-modified', 'content-range', 'pragma', 'expires',
  'content-security-policy', 'x-content-type-options',
];

/** The tree both sides serve. One writer, so one set of mtimes. */
const TREE = {
  'index.html': '<link href="air.css"><script src="air.js"></script><script src="missing.js"></script>',
  'task-entry.html': '<link href="air.css">',
  'chat.html': '<p>canonical chat</p>',
  'air.css': 'body{color:red}',
  'air.js': 'console.log(1)',
  'plain.txt': 'hello!',
  'data.json': '{"a":1}',
  'pixel.png': 'PNGPNG',
  'vector.svg': '<svg/>',
  'config.yaml': 'a: 1',
  'module.mjs': 'export default 1',
  'binary.bin': 'BINBIN',
  'photo.webp': 'WEBPWE',
  'app.wasm': 'WASMWA',
  'multicc.apk': 'APKAPK',
  'multicc-ios.ipa': 'IPAIPA',
  '.env': 'SECRET=1',
  'a b.txt': 'spaced',
  '\u4e2d\u6587.txt': 'cjk',
  'docs/index.html': '<p>docs index</p>',
  'docs/guide.html': '<p>guide</p>',
  'docs/deep/index.html': '<p>deep</p>',
  '.hidden/bar.txt': 'intermediate',
  'pub/.secret': 'dotfile tail',
  'a/b.txt': 'encoded slash',
  'locked.txt': 'locked asset',
};

/** The gateway derives `public_dir` from its script's directory (`<work>/gw`). */
const publicDirOf = work => path.join(work, 'gw', 'public');

/** Seeded once into the gateway's own public/, which the oracle also reads. */
function seedTree(publicDir) {
  fs.mkdirSync(publicDir, { recursive: true });
  for (const [name, text] of Object.entries(TREE)) {
    const file = path.join(publicDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.mkdirSync(path.join(publicDir, 'empty'), { recursive: true });
  // The one 500 the retired mount forwarded as next(err): a stream error after
  // send had already written its headers.
  if (process.platform !== 'win32') fs.chmodSync(path.join(publicDir, 'locked.txt'), 0o000);
}

const isNodeFallthrough = v => v.status === 599
  && (v.body === 'node-fell-through'
    || (v.body === '' && v.headers['content-length'] === String('node-fell-through'.length)));
const isRustForward = v => v.status === 599
  && (v.body === 'forwarded' || (v.body === '' && v.headers['content-length'] === '9'));

const fallbackUrls = new Set();
const fallbackMatchers = new Map();

function corpus(ctx) {
  const cases = [];
  const publicDir = publicDirOf(ctx.work);
  const etagOf = (name) => {
    const file = path.join(publicDir, name);
    const stat = fs.statSync(file);
    return `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
  };
  const lastModifiedOf = (name) => fs.statSync(path.join(publicDir, name)).mtime.toUTCString();
  const add = (name, request) => cases.push([name, request]);
  const get = (name, url, headers = HDR) => add(`claimed:${name}`, { method: 'GET', url, headers });
  const head = (name, url, headers = HDR) => add(`claimed:${name}`, { method: 'HEAD', url, headers });
  const fallback = (name, request, matchers = { node: isNodeFallthrough, rust: isRustForward }) => {
    fallbackUrls.add(request.url);
    fallbackMatchers.set(`fallback:${name}`, matchers);
    cases.push([`fallback:${name}`, request, { expectedDifference: matchers }]);
  };

  // ── mime 1.6.0 + send's charset rule, one case per table row that matters ──
  for (const name of [
    'plain.txt', 'air.css', 'air.js', 'data.json', 'pixel.png', 'vector.svg',
    'config.yaml', 'module.mjs', 'binary.bin', 'photo.webp', 'app.wasm',
  ]) {
    get(`mime GET /${name}`, `/${name}`);
    head(`mime HEAD /${name}`, `/${name}`);
  }

  // ── the setHeaders hook ──
  // `/multicc.apk` is not here: the front door claims it for the
  // release-history cluster (the host decides local file / redirect / missing),
  // so its parity lives in release-history-routes.js, which has that host
  // fixture. `/multicc-ios.ipa` is pure static and covers the `.ipa` branch.
  for (const name of ['multicc-ios.ipa']) {
    get(`hook GET /${name}`, `/${name}`);
    head(`hook HEAD /${name}`, `/${name}`);
    get(`hook range /${name}`, `/${name}`, { ...HDR, Range: 'bytes=1-3' });
    get(`hook fresh /${name}`, `/${name}`, { ...HDR, 'If-None-Match': etagOf(name) });
  }

  // ── Range: range-parser 1.2.1 with combine: true ──
  for (const range of [
    'bytes=0-0', 'bytes=1-3', 'bytes=-2', 'bytes=2-', 'bytes=0-99', 'bytes=99-',
    'bytes=5-1', 'bytes=0-1,2-3', 'bytes=0-1,3-4', 'bytes=3-4,0-1', 'bytes=0-5',
    'bytes=', 'bytes=abc', 'items=0-1', 'bytes=-0', 'bytes=6-', 'bytes=-99',
    '  bytes=1-2', 'bytes = 1-2',
  ]) {
    get(`range ${range}`, '/plain.txt', { ...HDR, Range: range });
    head(`range HEAD ${range}`, '/plain.txt', { ...HDR, Range: range });
  }
  // If-Range decides whether the range survives at all.
  get('range if-range etag fresh', '/plain.txt', { ...HDR, Range: 'bytes=1-3', 'If-Range': etagOf('plain.txt') });
  get('range if-range etag stale', '/plain.txt', { ...HDR, Range: 'bytes=1-3', 'If-Range': 'W/"0-0"' });
  get('range if-range date fresh', '/plain.txt', { ...HDR, Range: 'bytes=1-3', 'If-Range': lastModifiedOf('plain.txt') });
  get('range if-range date stale', '/plain.txt', { ...HDR, Range: 'bytes=1-3', 'If-Range': 'Sat, 01 Jan 2000 00:00:00 GMT' });
  get('range if-range garbage', '/plain.txt', { ...HDR, Range: 'bytes=1-3', 'If-Range': 'not-a-date' });

  // ── Conditional requests: fresh 0.5.2 + send's precondition rules ──
  const etag = etagOf('plain.txt');
  const modified = lastModifiedOf('plain.txt');
  for (const [label, headers] of [
    ['inm exact', { 'If-None-Match': etag }],
    ['inm star', { 'If-None-Match': '*' }],
    ['inm list', { 'If-None-Match': `"other", ${etag}` }],
    ['inm strong form', { 'If-None-Match': etag.slice(2) }],
    ['inm mismatch', { 'If-None-Match': '"nope"' }],
    ['inm + no-cache', { 'If-None-Match': etag, 'Cache-Control': 'no-cache' }],
    ['inm + max-age', { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' }],
    ['ims exact', { 'If-Modified-Since': modified }],
    ['ims future', { 'If-Modified-Since': 'Sat, 01 Jan 2050 00:00:00 GMT' }],
    ['ims past', { 'If-Modified-Since': 'Sat, 01 Jan 2000 00:00:00 GMT' }],
    ['ims garbage', { 'If-Modified-Since': 'nonsense' }],
    ['ims + inm', { 'If-Modified-Since': modified, 'If-None-Match': '"nope"' }],
    ['im exact', { 'If-Match': etag }],
    ['im star', { 'If-Match': '*' }],
    ['im mismatch', { 'If-Match': '"nope"' }],
    ['ius future', { 'If-Unmodified-Since': 'Sat, 01 Jan 2050 00:00:00 GMT' }],
    ['ius past', { 'If-Unmodified-Since': 'Sat, 01 Jan 2000 00:00:00 GMT' }],
    ['ius garbage', { 'If-Unmodified-Since': 'nonsense' }],
    ['im mismatch + range', { 'If-Match': '"nope"', Range: 'bytes=1-2' }],
    ['inm exact + range', { 'If-None-Match': etag, Range: 'bytes=1-2' }],
  ]) {
    get(`conditional ${label}`, '/plain.txt', { ...HDR, ...headers });
    head(`conditional HEAD ${label}`, '/plain.txt', { ...HDR, ...headers });
  }

  // ── Directories, the index list and the 301 document ──
  for (const url of ['/docs', '/docs?x=1&y=2', '/docs?x=%E4%B8%AD', '//docs', '/empty', '/docs/deep']) {
    get(`directory ${url}`, url);
    head(`directory HEAD ${url}`, url);
  }
  // `.` and `..` segments collapse to the root, which is a directory: these
  // redirect instead of taking the dotfile 404, because `containsDotFile`
  // ignores a one-character segment.
  for (const url of ['/.', '/a/..', '/a/b/../..']) {
    get(`directory collapse ${url}`, url);
  }
  for (const url of ['/docs/', '/docs/deep/']) {
    get(`index ${url}`, url);
    head(`index HEAD ${url}`, url);
  }

  // ── The extension retry (HEAD only: GET belongs to the middleware above) ──
  head('extensions HEAD /docs/guide', '/docs/guide');

  // ── URL decoding, dotfiles and the traversal guard ──
  get('encoded space', '/a%20b.txt');
  get('encoded cjk', '/%E4%B8%AD%E6%96%87.txt');
  get('encoded slash', '/a%2Fb.txt');
  get('intermediate dot segment', '/.hidden/bar.txt');
  head('intermediate dot segment HEAD', '/.hidden/bar.txt');

  // ── The versioned-HTML middleware ──
  for (const url of [
    '/?id=s1', '/?newid=1', '/?cwd=/tmp', '/index.html', '/chat', '/chat.html',
    '/task-shell', '/task-shell.html', '/chat.html?air=1', '/chat.html?air=1&task=',
    '/chat.html?air=1&task=t1', '/chat?air=1&session=s1', '/chat.html?air=0&task=t1',
    '/chat.html?air=1&air=1&task=t1', '/docs/guide', '/docs/index.html', '/index',
    '/task-entry.html',
  ]) {
    get(`versioned ${url}`, url);
    get(`versioned html-accept ${url}`, url, HTML);
  }

  // ── The one forwarded 500: a stream error after send's headers ──
  if (process.platform !== 'win32') {
    get('unreadable asset', '/locked.txt');
    head('unreadable asset HEAD', '/locked.txt');
  }

  // ── fallthrough: every <500 send error was a plain next() ──
  for (const url of [
    '/nope', '/nope.txt', '/.env', '/.hidden', '/pub/.secret', '/empty/', '/%',
    '/a%ZZ', '/a%00b', '/../etc/passwd', '/%2e%2e/etc', '/a/../../etc',
    '/plain.txt/', '/air.css/', '/docs/guide.htmlx', '/docs/guide/',
    '/missing/dir/',
  ]) {
    fallback(`GET ${url}`, { method: 'GET', url, headers: HDR });
  }
  for (const url of ['/nope', '/.env', '/.hidden', '/empty/', '/plain.txt/', '/docs/guide/']) {
    fallback(`HEAD ${url}`, { method: 'HEAD', url, headers: HDR });
  }
  for (const [method, url] of [
    ['POST', '/plain.txt'], ['PUT', '/plain.txt'], ['DELETE', '/plain.txt'],
    ['PATCH', '/air.css'], ['POST', '/'], ['POST', '/chat.html'],
  ]) {
    fallback(`${method} ${url}`, { method, url, headers: HDR, body: '{}' });
  }
  // OPTIONS matches no registered route, so Express's automatic answer has no
  // method list and the app's final handler 404s it.
  fallback(
    'OPTIONS /plain.txt (no route layers)',
    { method: 'OPTIONS', url: '/plain.txt', headers: HDR },
    { node: v => v.status === 404 && !v.headers.allow, rust: isRustForward },
  );
  // A documented difference, not a divergence: Node's HTTP server emits
  // `upgrade` instead of `request` when an `upgrade` listener exists, so the
  // real server's static chain never sees one. This oracle app registers no
  // such listener, so it answers the file; the front door must still decline
  // and let the upgrade reach the child that owns the WebSocket handshake.
  fallback(
    'GET /plain.txt with Upgrade',
    { method: 'GET', url: '/plain.txt', headers: { ...HDR, Connection: 'Upgrade', Upgrade: 'websocket' } },
    {
      node: v => v.status === 200 && v.body === 'hello!',
      rust: isRustForward,
    },
  );

  return cases;
}

/** The PROXY v1 stub: every unclaimed request is logged and answered 599. */
function upstream(repo, rootDir, work) {
  const log = path.join(work, 'forwarded.jsonl');
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const fs = require('node:fs');
const path = require('node:path');
const repo = ${JSON.stringify(repo)};
const log = ${JSON.stringify(log)};
// The front door's auth gate needs a live control channel before it answers;
// the real child opens it in src/gateway-child.js.
const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
const { connectAuthControl } = require(path.join(repo, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
const server = http.createServer((req, res) => {
  fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url }) + '\\n');
  if (req.url.split('?')[0] === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' }); res.end('ok'); return;
  }
  res.writeHead(599, { 'Content-Type': 'text/plain', 'Content-Length': '9' }); res.end('forwarded');
});
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.on('error', () => {}); let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\\r\\n'); if (end < 0) return;
    socket.removeListener('data', onData); socket.pause();
    const rest = buffered.subarray(end + 2); if (rest.length) socket.unshift(rest);
    server.emit('connection', socket); socket.resume();
  };
  socket.on('data', onData); socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');`;
}

/** Coverage the corpus must actually exercise, by case name. */
const REQUIRED = [
  'claimed:mime GET /plain.txt',
  'claimed:mime GET /config.yaml',
  'claimed:mime GET /module.mjs',
  'claimed:mime GET /app.wasm',
  'claimed:mime GET /photo.webp',
  'claimed:hook GET /multicc-ios.ipa',
  'claimed:hook HEAD /multicc-ios.ipa',
  'claimed:hook range /multicc-ios.ipa',
  'claimed:hook fresh /multicc-ios.ipa',
  'claimed:range bytes=1-3',
  'claimed:range bytes=-2',
  'claimed:range bytes=99-',
  'claimed:range bytes=0-1,2-3',
  'claimed:range bytes=0-1,3-4',
  'claimed:range items=0-1',
  'claimed:range if-range etag stale',
  'claimed:conditional inm exact',
  'claimed:conditional inm star',
  'claimed:conditional inm + no-cache',
  'claimed:conditional ims exact',
  'claimed:conditional im mismatch',
  'claimed:conditional ius past',
  'claimed:directory /docs',
  'claimed:directory collapse /.',
  'claimed:directory collapse /a/..',
  'claimed:directory /docs?x=1&y=2',
  'claimed:directory //docs',
  'claimed:index /docs/',
  'claimed:extensions HEAD /docs/guide',
  'claimed:encoded space',
  'claimed:encoded cjk',
  'claimed:encoded slash',
  'claimed:intermediate dot segment',
  'claimed:versioned /?id=s1',
  'claimed:versioned /chat.html',
  'claimed:versioned /chat.html?air=1&task=t1',
  'claimed:versioned /docs/guide',
  'fallback:GET /nope',
  'fallback:GET /.env',
  'fallback:GET /.hidden',
  'fallback:GET /docs/guide/',
  'fallback:GET /pub/.secret',
  'fallback:GET /empty/',
  'fallback:GET /%',
  'fallback:GET /a%00b',
  'fallback:GET /../etc/passwd',
  'fallback:GET /plain.txt/',
  'fallback:POST /plain.txt',
  'fallback:OPTIONS /plain.txt (no route layers)',
  'fallback:GET /plain.txt with Upgrade',
];

function finalize({ views, work }) {
  const problems = [];
  const claimed = views.filter(v => v.name.startsWith('claimed:'));
  const fallbacks = views.filter(v => v.name.startsWith('fallback:'));
  const total = views.length;
  let identical = 0;
  for (const v of claimed) {
    if (JSON.stringify(v.node) === JSON.stringify(v.rust)) {
      identical++;
    } else {
      problems.push(`claimed mismatch: ${v.name}\n  node ${JSON.stringify(v.node)}\n  rust ${JSON.stringify(v.rust)}`);
    }
  }
  for (const v of fallbacks) {
    const matchers = fallbackMatchers.get(v.name) || { node: isNodeFallthrough, rust: isRustForward };
    if (matchers.node(v.node) !== true) problems.push(`fallback not seen by the oracle: ${v.name}`);
    if (matchers.rust(v.rust) !== true) problems.push(`fallback claimed by the front door: ${v.name}`);
  }
  const logPath = path.join(work, 'forwarded.jsonl');
  const forwarded = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  for (const url of fallbackUrls) {
    if (!forwarded.some(entry => entry.url === url)) {
      problems.push(`fallback url never reached the PROXY stub: ${url}`);
    }
  }
  const missing = REQUIRED.filter(name => !views.some(v => v.name === name));
  for (const name of missing) problems.push(`corpus lost a required case: ${name}`);
  if (total < 200) problems.push(`corpus too small: ${total} < 200`);
  if (claimed.length === 0) problems.push('no claimed cases');
  if (fallbacks.length === 0) problems.push('no fallback cases');
  if (identical !== claimed.length) {
    problems.push(`only ${identical}/${claimed.length} claimed cases are byte-identical`);
  }
  console.log(`[static-web-root] corpus total=${total}; byte-identical=${identical}; claimed=${claimed.length}; fallback=${fallbacks.length}`);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    return { ok: false, problems };
  }
  return { ok: true };
}

let upstreamText = '';

const spec = {
  name: 'static-web-root',
  gatewayEnv: () => ({ HOST: '127.0.0.1', MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON }),
  headers: HEADERS,
  mount(app, ctx) {
    // One tree, seeded into the gateway's own public/ and read by both sides,
    // so every mtime-derived byte has a single source.
    const publicDir = publicDirOf(ctx.work);
    seedTree(publicDir);
    const legacy = require(path.join(ctx.repo, 'tests/helpers/legacy-static-assets-routes'));
    legacy.createStaticAssetsRoutes({
      express: ctx.express,
      fs: require('node:fs'),
      path: require('node:path'),
      publicDir,
    }).mountRoutes(app);
    // Anything the retired module passed on dies here with a marker body.
    // OPTIONS is left to the app's automatic answer, exactly like Node.
    app.use((req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      res.status(599).type('text/plain').send('node-fell-through');
    });
    upstreamText = upstream(ctx.repo, ctx.work, ctx.work);
  },
  get upstream() {
    return upstreamText;
  },
  corpus,
  finalize,
};

async function main() {
  const argv = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const ok = await run(spec, argv);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { corpus, spec, finalize, seedTree, publicDirOf };
