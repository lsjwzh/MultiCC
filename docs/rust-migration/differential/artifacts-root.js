'use strict';
// Differential run for the `/artifacts` dual-root static mount retired from
// src/artifacts.js and now answered by native/gateway/src/app/artifacts.rs
// (rules in native/core/src/static_web.rs):
//
//   GET|HEAD  /artifacts/<id>[/<file>]  -> express.static over two roots
//     (<data root>/artifacts, then ~/.multicc/artifacts), a `?download=1`/`?dl=1`
//     attachment middleware in front, `Cache-Control: no-store, must-revalidate`
//     + `X-Content-Type-Options: nosniff` on every served file
//
//   node docs/rust-migration/differential/artifacts-root.js <repo> <gateway>
//
// Both sides read the SAME trees: the oracle's roots are the gateway's own
// `<gw-data>/artifacts` and `<work>/home/.multicc/artifacts` (the gateway gets
// HOME=<work>/home), so every mtime-derived value (the stat ETag,
// Last-Modified) has one source of truth.
//
// The Node side mounts the FROZEN oracle (tests/helpers/
// legacy-artifacts-routes.js) FIRST and the frozen public/ oracle
// (tests/helpers/legacy-static-assets-routes.js) SECOND — the exact order the
// retired server.js registered them — so the layering cases (a file that only
// exists under public/artifacts, the global .apk guard behind the artifact
// roots) compare byte-for-byte too. Requests every layer passed on land on a
// marker middleware (`599 node-fell-through`); the Rust side forwards what it
// does not claim to a PROXY v1 stub that answers `599 forwarded` and logs the
// URL.
//
// The one documented difference: the retired headers middleware ran before the
// static layers, so a fallthrough that asked `?download=1` carried the
// attachment disposition onto the downstream 404/marker; the front door only
// stamps it on responses it answers itself (`fallback:GET /artifacts/?download=1`
// pins both shapes).

const fs = require('node:fs');
const path = require('node:path');

const { run } = require('./lib');

const HDR = { Host: 'localhost', 'X-Request-Id': 'diff-art-1' };

/** Headers the shared list does not carry but this mount is made of. */
const HEADERS = ['accept-ranges', 'last-modified', 'content-range', 'x-content-type-options'];

/** The primary artifact tree: `<data root>/artifacts`, read by both sides. */
const PRIMARY = {
  'art_1-x/index.html': '<p>root index</p>',
  'art_1-x/guide.txt': 'primary guide',
  'art_1-x/nested/deep.txt': 'deep content',
  'art_1-x/sub/index.html': '<p>sub index</p>',
  'art_1-x/.secret': 'hidden',
  'art_1-x/.hidden/bar.txt': 'dotdir',
  'art_1-x/a/b.txt': 'encoded slash',
  'art_1-x/中文.txt': 'cjk',
  'art_1-x/spa ce.txt': 'spaced',
  'art_1-x/app.apk': 'ARTAPK',
  'art_1-x/locked.txt': 'locked asset',
  'both-roots/shared.txt': 'primary shared',
};
/** The legacy fallback tree: `<home>/.multicc/artifacts`. */
const LEGACY = {
  'art-legacy/old.txt': 'legacy only',
  'art-legacy/index.html': '<p>legacy index</p>',
  'both-roots/shared.txt': 'legacy shared',
};
/** What only the public/ root has, proving the retired chain order. */
const PUBLIC = {
  'artifacts/pubid/pub-only.txt': 'public chain',
};

const primaryRootOf = work => path.join(work, 'gw-data', 'artifacts');
const legacyRootOf = work => path.join(work, 'home', '.multicc', 'artifacts');
const publicDirOf = work => path.join(work, 'gw', 'public');

function seedTree(root, tree) {
  for (const [name, text] of Object.entries(tree)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

function seedAll(work) {
  const primary = primaryRootOf(work);
  seedTree(primary, PRIMARY);
  seedTree(legacyRootOf(work), LEGACY);
  seedTree(publicDirOf(work), PUBLIC);
  fs.mkdirSync(path.join(primary, 'art_1-x', 'emptydir'), { recursive: true });
  if (process.platform !== 'win32') {
    // The one 500 the retired mount forwarded as next(err): a stream error
    // after send had already written its headers.
    fs.chmodSync(path.join(primary, 'art_1-x', 'locked.txt'), 0o000);
    // serve-static follows a symlink inside the root; so does the engine.
    fs.symlinkSync(path.join('nested', 'deep.txt'), path.join(primary, 'art_1-x', 'linked.txt'));
    fs.writeFileSync(path.join(primary, 'art_1-x', 'quote"name.txt'), 'quoted');
  }
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
  const primary = primaryRootOf(ctx.work);
  const etagOf = (name) => {
    const stat = fs.statSync(path.join(primary, name));
    return `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
  };
  const add = (name, request) => cases.push([name, request]);
  const get = (name, url, headers = HDR) => add(`claimed:${name}`, { method: 'GET', url, headers });
  const head = (name, url, headers = HDR) => add(`claimed:${name}`, { method: 'HEAD', url, headers });
  const fallback = (name, request, matchers = { node: isNodeFallthrough, rust: isRustForward }) => {
    fallbackUrls.add(request.url);
    fallbackMatchers.set(`fallback:${name}`, matchers);
    cases.push([`fallback:${name}`, request, { expectedDifference: matchers }]);
  };
  const G = '/artifacts/art_1-x/guide.txt';

  // ── dual root: primary hit, legacy-only hit, primary shadows legacy ──
  get('primary GET guide', G);
  head('primary HEAD guide', G);
  get('legacy GET old', '/artifacts/art-legacy/old.txt');
  get('shadow both roots', '/artifacts/both-roots/shared.txt');
  get('nested file', '/artifacts/art_1-x/nested/deep.txt');
  // The retired mount matched case-insensitively; the auth capability regex
  // did not. The gate still passes on loopback, so the file answers.
  get('uppercase mount', '/ARTIFACTS/art_1-x/guide.txt');
  // `.apk` inside an artifact: the artifact roots answer before the global
  // `.apk`/`.ipa` guard ever sees the path (the retired mount order).
  get('apk inside artifact', '/artifacts/art_1-x/app.apk');

  // ── Range and conditionals ride the same send engine, with no-store ──
  get('range bytes=1-3', G, { ...HDR, Range: 'bytes=1-3' });
  get('range suffix', G, { ...HDR, Range: 'bytes=-2' });
  head('range HEAD', G, { ...HDR, Range: 'bytes=1-3' });
  get('inm exact', G, { ...HDR, 'If-None-Match': etagOf('art_1-x/guide.txt') });
  get('inm mismatch', G, { ...HDR, 'If-None-Match': '"nope"' });

  // ── the ?download=1 / ?dl=1 attachment middleware (qs semantics) ──
  get('download=1', `${G}?download=1`);
  head('download=1 HEAD', `${G}?download=1`);
  get('dl=1', `${G}?dl=1`);
  get('download=1&dl=0', `${G}?download=1&dl=0`);
  get('download=0&dl=1', `${G}?download=0&dl=1`);
  get('download=0 inline', `${G}?download=0`);
  // A repeated key parses to an array in qs, which never `=== '1'`.
  get('download repeated', `${G}?download=1&download=1`);
  get('download bracket', `${G}?download[]=1`);
  // qs decodes keys and values: %64ownload is `download`, %31 is `1`.
  get('download encoded key', `${G}?%64ownload=1`);
  get('download encoded value', `${G}?download=%31`);
  // The filename is path.basename of the RAW mounted path, sanitized.
  get('download cjk raw basename', '/artifacts/art_1-x/%E4%B8%AD%E6%96%87.txt?download=1');
  // basename('/art_1-x/') is 'art_1-x': the index answer names the directory.
  get('download index basename', '/artifacts/art_1-x/?download=1');
  // The disposition rides the 301 too: the middleware ran before serve-static.
  get('download directory 301', '/artifacts/art_1-x/sub?download=1');

  // ── directories: 301 keeps the /artifacts prefix and the query ──
  get('directory 301', '/artifacts/art_1-x/sub');
  get('directory 301 query', '/artifacts/art_1-x/sub?x=1&y=2');
  head('directory 301 HEAD', '/artifacts/art_1-x/sub');
  get('directory index', '/artifacts/art_1-x/sub/');
  get('root index', '/artifacts/art_1-x/');
  get('bare id redirect', '/artifacts/art_1-x');
  get('bare legacy id redirect', '/artifacts/art-legacy');
  get('legacy root index', '/artifacts/art-legacy/');

  // ── URL decoding, dot segments, symlinks ──
  get('encoded space', '/artifacts/art_1-x/spa%20ce.txt');
  get('encoded cjk', '/artifacts/art_1-x/%E4%B8%AD%E6%96%87.txt');
  get('encoded slash', '/artifacts/art_1-x/a%2Fb.txt');
  get('dot segment collapse', '/artifacts/art_1-x/./guide.txt');
  if (process.platform !== 'win32') {
    get('symlink inside root', '/artifacts/art_1-x/linked.txt');
    get('download quote sanitized', '/artifacts/art_1-x/quote%22name.txt?download=1');
    // The forwarded 500, and the disposition the middleware stamped first.
    get('unreadable asset', '/artifacts/art_1-x/locked.txt');
    get('unreadable asset download', '/artifacts/art_1-x/locked.txt?download=1');
  }

  // ── layering: the public/ root answered next, exactly like the retired chain ──
  get('chain public file', '/artifacts/pubid/pub-only.txt');
  get('chain public directory', '/artifacts/pubid');
  // A bare `/artifacts` is not answered by the artifact roots at all (no
  // index.html at either root): the public/ root has the `artifacts/`
  // directory and redirects it to the trailing slash, on both sides.
  get('chain public root redirect', '/artifacts');
  // An unknown .apk falls through the artifact roots into the global guard.
  get('guard unknown apk', '/artifacts/art_1-x/missing.apk');

  // ── fallthrough: every miss was a plain next() ──
  for (const url of [
    '/artifacts/art_1-x/nope.txt', '/artifacts/nope-id/file.txt',
    '/artifacts/art_1-x/.secret', '/artifacts/art_1-x/.hidden/bar.txt',
    '/artifacts/art_1-x/emptydir/', '/artifacts/',
    '/artifacts/../etc/passwd', '/artifacts/%2e%2e/etc', '/artifacts/art_1-x/../../etc',
    '/artifacts/art_1-x/guide.txt/', '/artifactsfoo/guide.txt',
    '/artifacts/pubid/missing.txt',
  ]) {
    fallback(`GET ${url}`, { method: 'GET', url, headers: HDR });
  }
  for (const url of ['/artifacts/art_1-x/nope.txt', '/artifacts/art_1-x/.secret']) {
    fallback(`HEAD ${url}`, { method: 'HEAD', url, headers: HDR });
  }
  fallback('POST guide', { method: 'POST', url: G, headers: HDR, body: '{}' });
  // OPTIONS matches no registered route, so Express's automatic answer has no
  // method list and the app's final handler 404s it.
  fallback(
    'OPTIONS guide (no route layers)',
    { method: 'OPTIONS', url: G, headers: HDR },
    { node: v => v.status === 404 && !v.headers.allow, rust: isRustForward },
  );
  // A documented difference, not a divergence: Node's HTTP server emits
  // `upgrade` instead of `request` when an `upgrade` listener exists, so the
  // real server's static chain never sees one. This oracle app registers no
  // such listener, so it answers the file; the front door must still decline
  // and let the upgrade reach the child that owns the WebSocket handshake.
  fallback(
    'GET guide with Upgrade',
    { method: 'GET', url: G, headers: { ...HDR, Connection: 'Upgrade', Upgrade: 'websocket' } },
    { node: v => v.status === 200 && v.body === 'primary guide', rust: isRustForward },
  );
  // The one byte difference this migration accepts: the retired headers
  // middleware stamped the attachment disposition onto the downstream 404 of
  // a fallthrough too; the front door forwards without ever having run it.
  fallback(
    'GET /artifacts/?download=1',
    { method: 'GET', url: '/artifacts/?download=1', headers: HDR },
    {
      node: v => isNodeFallthrough(v) && v.headers['content-disposition'] === 'attachment; filename="download"',
      rust: v => isRustForward(v) && v.headers['content-disposition'] === undefined,
    },
  );

  return cases;
}

/** The PROXY v1 stub: every unclaimed request is logged and answered 599. */
function upstream(repo, work) {
  const log = path.join(work, 'forwarded.jsonl');
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const fs = require('node:fs');
const path = require('node:path');
const repo = ${JSON.stringify(repo)};
const log = ${JSON.stringify(log)};
// The front door's auth gate needs a live control channel before it answers;
// the real child opens it in src/gateway-child.js.
const { createAuthSecurity } = require(path.join(repo, 'src/native/binding')).authSecurity;
const { connectAuthControl } = require(path.join(repo, 'src/native/binding')).gatewayChild;
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
  'claimed:primary GET guide',
  'claimed:primary HEAD guide',
  'claimed:legacy GET old',
  'claimed:shadow both roots',
  'claimed:uppercase mount',
  'claimed:apk inside artifact',
  'claimed:range bytes=1-3',
  'claimed:inm exact',
  'claimed:download=1',
  'claimed:dl=1',
  'claimed:download=0 inline',
  'claimed:download repeated',
  'claimed:download bracket',
  'claimed:download encoded key',
  'claimed:download cjk raw basename',
  'claimed:download index basename',
  'claimed:download directory 301',
  'claimed:directory 301',
  'claimed:directory 301 query',
  'claimed:directory index',
  'claimed:root index',
  'claimed:bare id redirect',
  'claimed:encoded slash',
  'claimed:dot segment collapse',
  'claimed:chain public file',
  'claimed:chain public directory',
  'claimed:chain public root redirect',
  'claimed:guard unknown apk',
  'fallback:GET /artifacts/art_1-x/nope.txt',
  'fallback:GET /artifacts/art_1-x/.secret',
  'fallback:GET /artifacts/art_1-x/emptydir/',
  'fallback:GET /artifacts/../etc/passwd',
  'fallback:GET /artifacts/art_1-x/guide.txt/',
  'fallback:GET /artifactsfoo/guide.txt',
  'fallback:POST guide',
  'fallback:OPTIONS guide (no route layers)',
  'fallback:GET guide with Upgrade',
  'fallback:GET /artifacts/?download=1',
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
  if (total < 55) problems.push(`corpus too small: ${total} < 55`);
  if (claimed.length === 0) problems.push('no claimed cases');
  if (fallbacks.length === 0) problems.push('no fallback cases');
  if (identical !== claimed.length) {
    problems.push(`only ${identical}/${claimed.length} claimed cases are byte-identical`);
  }
  console.log(`[artifacts-root] corpus total=${total}; byte-identical=${identical}; claimed=${claimed.length}; fallback=${fallbacks.length}`);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    return { ok: false, problems };
  }
  return { ok: true };
}

let upstreamText = '';

const spec = {
  name: 'artifacts-root',
  headers: HEADERS,
  mount(app, ctx) {
    // One set of trees, seeded into the gateway's own roots and read by both
    // sides, so every mtime-derived byte has a single source.
    seedAll(ctx.work);
    const legacyArtifacts = require(path.join(ctx.repo, 'tests/helpers/legacy-artifacts-routes'));
    legacyArtifacts.mountArtifacts(app, [primaryRootOf(ctx.work), legacyRootOf(ctx.work)]);
    // The retired server mounted the public/ static layer right after the
    // artifact roots; the layering cases above need both.
    const legacyStatic = require(path.join(ctx.repo, 'tests/helpers/legacy-static-assets-routes'));
    legacyStatic.createStaticAssetsRoutes({
      express: ctx.express,
      fs: require('node:fs'),
      path: require('node:path'),
      publicDir: publicDirOf(ctx.work),
    }).mountRoutes(app);
    // Anything every retired layer passed on dies here with a marker body.
    // OPTIONS is left to the app's automatic answer, exactly like Node.
    app.use((req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      res.status(599).type('text/plain').send('node-fell-through');
    });
    upstreamText = upstream(ctx.repo, ctx.work);
  },
  gatewayEnv(work) {
    // The legacy root is `<HOME>/.multicc/artifacts`: point the gateway's HOME
    // at the seeded fixture so the real home directory is never read.
    return { HOME: path.join(work, 'home') };
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

module.exports = { corpus, spec, finalize, seedAll };
