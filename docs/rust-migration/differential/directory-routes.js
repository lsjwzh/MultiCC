'use strict';
// Differential run for the thirteen directory / onboarding / ui-layout routes
// retired from Node:
//
//   GET|HEAD        /api/fs/list
//   GET|HEAD|POST   /api/directories
//   POST            /api/onboarding/sample-workspace
//   PUT             /api/directories/order
//   PATCH|DELETE    /api/directories/:id
//   POST            /api/directories/:id/push
//   GET|HEAD        /api/directories/:id/uncommitted
//   POST            /api/directories/:id/commit
//   GET|HEAD        /api/ui-layout
//   PUT             /api/ui-layout/dir-order
//   PUT             /api/ui-layout/session-order/:dirId
//
// now answered by native/gateway/src/app/directory_routes.rs (rules in
// native/core/src/directory_routes.rs).
//
//   node docs/rust-migration/differential/directory-routes.js <repo> <multicc-gateway> <addon>
//
// The Node side mounts the frozen retired handlers (src/directory/controller.js,
// src/directory/service.js, src/directory/ports.js, src/directory/ui-layout.js
// and src/ui-layout.js as of HEAD, see tests/helpers/legacy-directory-routes.js)
// over the seeded world in tests/helpers/directory-scripted-world.js. The Rust
// front door answers the routes itself and reaches the real host composition
// (src/routes/directory-host.js over src/directory/*) through its Node child,
// which is seeded identically. The comparison therefore covers the split itself:
// path matching (including the 2-segment `:id` claim next to `order`, `push`,
// `uncommitted`, `commit`), automatic OPTIONS Allow, parameter decoding, query
// and body reading, the `isHomeOrAbove` traversal verdict, the browse
// filter/sort/cap, DTO assembly and key order, the `{code, error, …}` envelope,
// the reorder merge, the ui-layout prune rules, and the git / filesystem /
// session side effects on both sides.
//
// Every effect is appended to `<dataRoot>/effects.log` by the scripted world
// (git subprocesses, repo saves, cascades, event appends, the cross-file
// transaction, sample files, layout saves). finalize() compares the two effect
// sequences line by line and pins every critical branch, so a route that
// answers the same bytes while asking Node for the wrong thing (or nothing at
// all) cannot pass. The repos are throwaway directories with a throwaway bare
// remote; no real repository is touched.
//
// No documented differences: every corpus case must agree byte for byte. The
// host port being down (503 rust_backend_unavailable) is a front-door-only
// failure surface with no Node twin; native/gateway/tests/directory_routes.rs
// and docs/gateway.md §9 cover it, and finalize() refuses to pass unless that
// test still exists.
const fs = require('fs');
const path = require('path');
const { main, waitForFixture } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-dir-1' };
const JSONH = { ...L, 'Content-Type': 'application/json' };

let nodeData = '';
let gwData = '';
let repoPath = '';
let upstreamText = '';

const cases = [];

// An ETag is a hash of the raw body, and most bodies embed the per-side data
// root or a timestamp, so the hash (and the length of the raw bytes) legitimately
// differ even though the bodies are identical after normalization. Every case
// therefore records *whether* Express stamped an ETag and a Content-Length and
// compares that stamp, instead of the two volatile values. The bodies themselves
// are still compared byte for byte. (Bodies with no per-side content keep their
// exact entity headers: see the `keepHeaders` option below.)
function withoutEntityHeaders(view) {
  view.headers['x-entity'] = `${view.headers.etag ? 'etag' : 'no-etag'}`
    + `/${view.headers['content-length'] ? 'len' : 'no-len'}`;
  delete view.headers.etag;
  delete view.headers['content-length'];
  return view;
}

function add(name, request, options = {}) {
  const { keepHeaders = false, ...hooks } = options;
  cases.push([name, request, keepHeaders ? hooks : { normalize: withoutEntityHeaders, ...hooks }]);
}

function worldPath(side, rel) {
  return path.join(side.name === 'node' ? nodeData : gwData, rel);
}

function dirRequest(method, suffix, body, headers = JSONH) {
  return side => ({
    method,
    url: `/api/directories/${suffix(side)}`,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  const json = (method, url, body, headers = JSONH) => ({
    method, url, headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const asSide = (fn) => side => fn(side);
  const fsQuery = (rel) => asSide(side => get(`/api/fs/list?path=${encodeURIComponent(worldPath(side, rel))}`));
  const body = (value) => () => value;

  // ── fs/list: the path-safe directory browser ──────────────────────────
  add('GET fs list home', () => get('/api/fs/list'));
  add('HEAD fs list home', () => head('/api/fs/list'));
  add('OPTIONS fs list', () => options('/api/fs/list'));
  add('GET fs list workspace', fsQuery('ws'));
  add('GET fs list prefix', fsQuery('ws/a'));
  add('GET fs list prefix case', fsQuery('ws/B'));
  add('GET fs list dotfile prefix', fsQuery('ws/.h'));
  add('GET fs list tilde', () => get('/api/fs/list?path=~'));
  add('GET fs list home parent', asSide(side => get(`/api/fs/list?path=${encodeURIComponent(path.dirname(require('os').homedir()))}`)));
  add('GET fs list child of home', asSide(() => get(`/api/fs/list?path=${encodeURIComponent(path.join(require('os').homedir(), '.ssh'))}`)));
  add('GET fs list missing parent', fsQuery('nope/deep'));
  add('GET fs list traversal dots', asSide(side =>
    get(`/api/fs/list?path=${encodeURIComponent(worldPath(side, 'ws'))}/%2e%2e/%2e%2e`)));
  add('GET fs list encoded traversal', () => get('/api/fs/list?path=%2F..%2F..%2Fetc'));
  add('GET fs list parent segment', fsQuery('ws/alpha/..'));
  add('GET fs list file path', fsQuery('ws/README.md'));

  // ── directories: the annotated list and registration ──────────────────
  add('GET directories', () => get('/api/directories'));
  add('HEAD directories', () => head('/api/directories'));
  add('OPTIONS directories', () => options('/api/directories'));
  add('OPTIONS directories id', () => options('/api/directories/dir-1'));
  add('OPTIONS directories order', () => options('/api/directories/order'));
  add('OPTIONS directories push', () => options('/api/directories/dir-1/push'));
  add('OPTIONS directories uncommitted', () => options('/api/directories/dir-1/uncommitted'));
  add('OPTIONS onboarding sample', () => options('/api/onboarding/sample-workspace'));
  add('POST directories missing name', () => json('POST', '/api/directories', { path: '/tmp/x' }));
  add('POST directories home', () => json('POST', '/api/directories', { name: 'Home', path: '~' }));
  add('POST directories home parent', () => json('POST', '/api/directories', {
    name: 'Above', path: path.join(require('os').homedir(), '..'),
  }));
  add('POST directories missing path', asSide(side =>
    json('POST', '/api/directories', { name: 'Missing', path: worldPath(side, 'nope') })));
  add('POST directories relative path', () => json('POST', '/api/directories', { name: 'Rel', path: 'probe/relative' }));
  add('POST directories file path', fsPathPost('ws/README.md'));
  add('POST directories duplicate', fsPathPost('ws'));
  add('POST directories literal percent path', asSide(side =>
    json('POST', '/api/directories', { name: 'Percent', path: `${worldPath(side, 'ws')}/%2e%2e` })));
  add('POST directories create', asSide(side =>
    json('POST', '/api/directories', { name: '  Created  ', path: worldPath(side, 'newdir'), create: true })));
  add('POST directories create duplicate', asSide(side =>
    json('POST', '/api/directories', { name: 'Created again', path: worldPath(side, 'newdir'), create: true })));
  add('GET directories after create', () => get('/api/directories'));
  add('POST directories create broken repo', asSide(side =>
    json('POST', '/api/directories', { name: 'Broken', path: worldPath(side, 'broken-repo'), create: true })));
  add('POST directories create no git tools', asSide(side =>
    json('POST', '/api/directories', { name: 'NoTools', path: worldPath(side, 'no-git-tools'), create: true })));
  add('POST sample workspace', () => json('POST', '/api/onboarding/sample-workspace'));
  add('POST sample workspace again', () => json('POST', '/api/onboarding/sample-workspace'));
  add('GET directories after sample', () => get('/api/directories'));

  // ── order: the literal wins over `:id` for PUT ────────────────────────
  add('PUT directories order', () => json('PUT', '/api/directories/order',
    { ids: ['dir-2', 'dir-1', 'nope', 'dir-2', 7, '', 'dir-3'] }));
  add('PUT directories order non-array', () => json('PUT', '/api/directories/order', { ids: 'dir-1' }));
  add('PUT directories order empty', () => json('PUT', '/api/directories/order', { ids: [] }));
  add('GET directories after reorder', () => get('/api/directories'));

  // ── PATCH /api/directories/:id ────────────────────────────────────────
  add('PATCH directory name', dirRequest('PATCH', () => 'dir-1', { name: 'Renamed One' }));
  add('PATCH directory encoded id', dirRequest('PATCH', () => 'dir%2D1', { name: 'Renamed One' }));
  add('PATCH the literal order path is the id 404', dirRequest('PATCH', () => 'order', { name: 'X' }));
  add('PATCH unknown directory', dirRequest('PATCH', () => 'nope', { name: 'X' }));
  add('PATCH malformed percent escape', dirRequest('PATCH', () => 'dir%2', { name: 'X' }));
  add('PATCH missing path keeps the new name', dirRequest('PATCH', () => 'dir-2', { name: '  Named  ', path: 'MISSING' },
    undefined));
  add('GET directories after failed patch', () => get('/api/directories'));
  add('PATCH path unchanged', asSide(side => json('PATCH', '/api/directories/dir-2', {
    path: `${worldPath(side, 'ws2')}${path.sep}`,
  })));
  add('PATCH path to a broken repo', asSide(side => json('PATCH', '/api/directories/dir-2', {
    path: worldPath(side, 'broken-repo'),
  })));
  add('GET directories after broken move', () => get('/api/directories'));
  add('PATCH path duplicate', asSide(side => json('PATCH', '/api/directories/dir-2', {
    path: worldPath(side, 'ws'),
  })));
  add('PATCH role prompt', dirRequest('PATCH', () => 'dir-3', { rolePrompt: '  be nice  ' }));
  add('PATCH role prompt null', dirRequest('PATCH', () => 'dir-3', { rolePrompt: null }));
  add('PATCH role prompt too long', dirRequest('PATCH', () => 'dir-3', { rolePrompt: 'x'.repeat(40001) }));
  add('PATCH empty body', dirRequest('PATCH', () => 'dir-3', {}));

  // ── DELETE: cascade, force, the cross-file transaction ────────────────
  add('DELETE directory with sessions', () => ({ method: 'DELETE', url: '/api/directories/dir-1', headers: L }));
  add('DELETE fragile cascade refusal', () => ({ method: 'DELETE', url: '/api/directories/dir-4?force=1', headers: L }));
  add('DELETE directory with force', () => ({ method: 'DELETE', url: '/api/directories/dir-2?force=1', headers: L }));
  add('DELETE unknown directory', () => ({ method: 'DELETE', url: '/api/directories/nope', headers: L }));
  add('DELETE created directory', () => ({ method: 'DELETE', url: '/api/directories/dir-new-1', headers: L }));
  add('GET directories after deletes', () => get('/api/directories'));

  // ── uncommitted / commit / push ───────────────────────────────────────
  add('GET uncommitted', () => get('/api/directories/dir-1/uncommitted'));
  add('HEAD uncommitted', () => head('/api/directories/dir-1/uncommitted'));
  add('GET uncommitted not a repository', () => get('/api/directories/dir-3/uncommitted'));
  add('GET uncommitted unknown', () => get('/api/directories/nope/uncommitted'));
  add('POST commit default message', dirRequest('POST', () => 'dir-1/commit', {}), {
    before: side => fs.writeFileSync(path.join(worldPath(side, 'ws'), 'dirty2.txt'), 'two\n'),
  });
  add('POST commit Unicode message', dirRequest('POST', () => 'dir-1/commit', { message: '更新 → 文档' }), {
    before: side => fs.writeFileSync(path.join(worldPath(side, 'ws'), 'dirty3.txt'), 'three\n'),
  });
  add('POST commit explicit message', dirRequest('POST', () => 'dir-1/commit', { message: 'chore: tidy the tree' }), {
    before: side => fs.writeFileSync(path.join(worldPath(side, 'ws'), 'dirty4.txt'), 'four\n'),
  });
  add('POST commit clean tree', dirRequest('POST', () => 'dir-1/commit', {}));
  add('POST commit unknown', dirRequest('POST', () => 'nope/commit', {}));
  add('POST push', dirRequest('POST', () => 'dir-1/push'));
  add('POST push again', dirRequest('POST', () => 'dir-1/push'));
  add('POST push not a repository', dirRequest('POST', () => 'dir-3/push'));
  add('POST push unknown', dirRequest('POST', () => 'nope/push'));
  add('GET uncommitted after commits', () => get('/api/directories/dir-1/uncommitted'));

  // ── ui-layout ─────────────────────────────────────────────────────────
  add('GET ui layout', () => get('/api/ui-layout'));
  add('HEAD ui layout', () => head('/api/ui-layout'));
  add('OPTIONS ui layout', () => options('/api/ui-layout'));
  add('OPTIONS ui layout dir order', () => options('/api/ui-layout/dir-order'));
  add('OPTIONS ui layout session order', () => options('/api/ui-layout/session-order/dir-1'));
  add('PUT ui layout dir order', () => json('PUT', '/api/ui-layout/dir-order',
    { order: ['dir-1', 'gone', 'dir-3', 7, '', 'dir-1', 'y'.repeat(201)] }));
  add('PUT ui layout dir order non-array', () => json('PUT', '/api/ui-layout/dir-order', { order: 'dir-1' }));
  add('PUT ui layout session order', () => json('PUT', '/api/ui-layout/session-order/dir-1',
    { order: ['sess-2', 'sess-1', 'gone', 'sess-2'] }));
  add('PUT ui layout session order pruned empty', () => json('PUT', '/api/ui-layout/session-order/dir-3',
    { order: ['ghost'] }));
  add('PUT ui layout session order unknown directory', () => json('PUT', '/api/ui-layout/session-order/nope',
    { order: ['sess-1'] }));
  add('PUT ui layout session order encoded id', () => json('PUT', '/api/ui-layout/session-order/dir%2D1',
    { order: ['sess-1', 'sess-2'] }));
  add('PUT ui layout session order non-array', () => json('PUT', '/api/ui-layout/session-order/dir-1',
    { order: 'sess-1' }));
  add('GET ui layout after writes', () => get('/api/ui-layout'));

  return cases;

  // `POST /api/directories` with a path inside the per-side world.
  function fsPathPost(rel) {
    return asSide(side => json('POST', '/api/directories', { name: 'Post', path: worldPath(side, rel) }));
  }
}

// ── the stub Node child: the real host composition over the same seed ──────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const { requestIdMiddleware, safeErrorHandler } = require(path.join(REPO, 'src/http-errors'));
const { jsonCompression } = require(path.join(REPO, 'src/http/json-compression'));
const world = require(path.join(REPO, 'tests/helpers/directory-scripted-world'));
const { createDirectoryHost } = require(path.join(REPO, 'src/routes/directory-host'));

const state = world.state(process.env.MULTICC_DATA_DIR);
const app = express();
app.get('/__health', (_req, res) => res.send('ok'));
app.use(requestIdMiddleware, jsonCompression);
app.use(express.json({ limit: '50mb' }));
createDirectoryHost({
  ...state.deps,
  uiLayout: world.layoutStore(state),
  isLocal: () => true,
}).mount(app);
app.use(safeErrorHandler({ warn() {}, info() {}, error() {} }));

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
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
`;
}

// ── normalization shared by both sides ────────────────────────────────────

function normalizeText(text) {
  let out = text;
  if (nodeData) out = out.split(nodeData).join('<data>');
  if (gwData) out = out.split(gwData).join('<data>');
  out = out.replace(/"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"/g, '"<iso>"');
  return out;
}

// ── run ───────────────────────────────────────────────────────────────────

main({
  name: 'directory-routes',
  seed: dataRoot => require(path.join(__dirname, '../../../tests/helpers/directory-scripted-world')).seed(dataRoot),
  mount(app, { repo, work }) {
    const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'directory-diff-home-'));
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.mkdirSync(path.join(home, 'projects'));
    process.env.HOME = process.env.USERPROFILE = home;
    process.once('exit', () => fs.rmSync(home, { recursive: true, force: true }));
    repoPath = repo;
    nodeData = path.join(work, 'node-data');
    gwData = path.join(work, 'gw-data');
    process.env.MULTICC_DATA_DIR = nodeData;
    process.env.NODE_PATH = path.join(repo, 'node_modules');
    require('module').Module._initPaths();

    const world = require(path.join(repo, 'tests/helpers/directory-scripted-world'));
    const legacy = require(path.join(repo, 'tests/helpers/legacy-directory-routes'));
    legacy.mountLegacyDirectory(app, world.state(nodeData));
    upstreamText = upstreamSource(repo);
  },
  ready: waitForFixture,
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: () => ({
    HOST: '127.0.0.1', USERPROFILE: process.env.HOME,
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: gwData,
  }),
  normalize: normalizeText,
  corpus,
  // The three state files are compared in finalize() so the per-side roots and
  // timestamps can be normalized first.
  stores: [],
  async finalize({ views, work }) {
    const problems = [];
    const byName = new Map(views.map(entry => [entry.name, entry]));

    // The judge of the side-effect sequence: every git subprocess, repo save,
    // cascade, event append, transaction and sample write, in order.
    const readEffects = file => {
      try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; }
    };
    const nodeEffects = readEffects(path.join(nodeData, 'effects.log'));
    const rustEffects = readEffects(path.join(gwData, 'effects.log'));
    if (JSON.stringify(nodeEffects) !== JSON.stringify(rustEffects)) {
      let at = 0;
      while (at < nodeEffects.length && at < rustEffects.length && nodeEffects[at] === rustEffects[at]) at++;
      problems.push(`effect sequence diverges at #${at}: node ${JSON.stringify(nodeEffects.slice(at, at + 3))} `
        + `vs rust ${JSON.stringify(rustEffects.slice(at, at + 3))}`);
    }

    const expectations = [
      ['git-commit', 'chore: tidy the tree'],
      ['git-push', 'ws'],
      ['tx', 'delete-directory:dir=dir-2 force=true'],
      ['destroy-cascade', 'sess-3:force=true'],
      ['repo-remove', 'dir-new-2'],
      ['repo-remove', 'dir-new-3'],
      ['git-unmark-ready', 'dir-2'],
      ['event', 'dir-1:pushed:'],
      ['seed-commander', 'dir-new-1'],
      ['sample-file', 'README.md'],
      ['ensure-ready', 'dir-4'],
    ];
    const joined = rustEffects.join('\n');
    for (const [a, b] of expectations) {
      if (!joined.includes(a) || (b && !joined.includes(b))) {
        problems.push(`rust effects are missing ${a}${b ? ' / ' + b : ''}`);
      }
    }

    // The three state files, blanked of the per-side roots and timestamps.
    const readStore = (root, file) => {
      try { return normalizeText(fs.readFileSync(path.join(root, file), 'utf8')); }
      catch (_) { return '<absent>'; }
    };
    for (const file of ['directories.json', 'sessions.json', 'ui-layout.json']) {
      const nodeStore = readStore(nodeData, file);
      const rustStore = readStore(gwData, file);
      if (nodeStore !== rustStore) {
        const details = path.join(work, `store-diff-${file.replace(/\W/g, '-')}.json`);
        fs.writeFileSync(details, JSON.stringify({ node: nodeStore, rust: rustStore }, null, 2));
        problems.push(`${file} differs after normalization; see ${details}`);
      }
    }

    // A body that silently 500s on both sides would still "match"; pin the
    // branches this cluster exists to protect.
    const pinned = (name, check) => {
      const view = byName.get(name);
      if (!view) { problems.push(`${name}: missing from the corpus`); return; }
      const result = check(view);
      if (result !== true) problems.push(`${name}: ${result}`);
    };
    const both200 = view => (view.node.status === 200 && view.rust.status === 200) || 'expected 200 on both sides';
    const body = view => JSON.parse(view.node.body);

    pinned('GET fs list home', view => {
      if (both200(view) !== true) return both200(view);
      const answer = body(view);
      return (answer.selectable === false && answer.entries.length > 0)
        || `home must not be selectable, got ${view.node.body.slice(0, 120)}`;
    });
    pinned('GET fs list workspace', view => {
      if (both200(view) !== true) return both200(view);
      const answer = body(view);
      const names = answer.entries.map(entry => entry.name);
      return (answer.selectable === true && names.includes('alpha') && names.includes('alink')
        && !names.includes('README.md')) || `unexpected browse ${view.node.body.slice(0, 160)}`;
    });
    pinned('GET fs list prefix', view => {
      const names = body(view).entries.map(entry => entry.name);
      return JSON.stringify(names) === JSON.stringify(['alink', 'alpha']) || `prefix filter ${JSON.stringify(names)}`;
    });
    pinned('GET fs list dotfile prefix', view => {
      const names = body(view).entries.map(entry => entry.name);
      return JSON.stringify(names) === JSON.stringify(['.hidden']) || `dotfile filter ${JSON.stringify(names)}`;
    });
    pinned('GET fs list home parent', view => body(view).selectable === false || 'an ancestor of home must not be selectable');
    pinned('GET fs list traversal dots', view => {
      // The browser never rejects a path: the host normalizes it and the kernel
      // only marks $HOME-or-above unselectable. `<data>/ws/../..` is the scratch
      // root, so it stays selectable — the verdict, not a string filter, is the
      // rule that must be replicated.
      const answer = body(view);
      return (answer.selectable === true && answer.base === '<data>/ws/../..')
        || `dot-dot verdict ${view.node.body.slice(0, 160)}`;
    });
    pinned('GET fs list encoded traversal', view =>
      (Array.isArray(body(view).entries)) || 'encoded traversal answered nothing');
    pinned('GET fs list missing parent', view => {
      const answer = body(view);
      return (answer.parent === null && answer.selectable === false && answer.entries.length === 0)
        || `missing parent ${view.node.body.slice(0, 120)}`;
    });
    pinned('POST directories home', view =>
      (view.node.status === 400 && body(view).error === '不允许选择 $HOME 或更高层目录') || 'home was accepted');
    pinned('POST directories home parent', view =>
      (view.node.status === 400 && body(view).error === '不允许选择 $HOME 或更高层目录') || 'home parent was accepted');
    pinned('POST directories create', view => {
      if (both200(view) !== true) return both200(view);
      const answer = body(view);
      return (answer.name === 'Created' && answer.baseBranch === 'main' && answer.gitInitialized === true)
        || `registered record ${view.node.body.slice(0, 160)}`;
    });
    pinned('POST directories create broken repo', view => {
      const answer = body(view);
      return (view.node.status === 400 && answer.fix === 'open-ops-terminal'
        && String(answer.error).includes('无法将目录初始化为 git 仓库')) || `unexpected ${view.node.body.slice(0, 160)}`;
    });
    pinned('POST directories create no git tools', view => {
      const answer = body(view);
      return (view.node.status === 400 && answer.fix === 'fix-git-missing') || `unexpected ${view.node.body.slice(0, 160)}`;
    });
    pinned('POST sample workspace', view => {
      if (both200(view) !== true) return both200(view);
      const answer = body(view);
      return (answer.reused === false && JSON.stringify(answer.createdFiles) === JSON.stringify(['README.md', 'index.html', 'styles.css', 'TASKS.md']))
        || `sample answer ${view.node.body.slice(0, 200)}`;
    });
    pinned('POST sample workspace again', view => {
      const answer = body(view);
      return (answer.reused === true && answer.createdFiles.length === 0) || `reuse answer ${view.node.body.slice(0, 160)}`;
    });
    pinned('PUT directories order', view => {
      const answer = body(view);
      const head = answer.ids.slice(0, 3);
      return JSON.stringify(head) === JSON.stringify(['dir-2', 'dir-1', 'dir-3'])
        || `order merge ${JSON.stringify(answer.ids)}`;
    });
    pinned('PATCH directory name', view => {
      if (both200(view) !== true) return both200(view);
      return body(view).name === 'Renamed One' || 'name was not updated';
    });
    pinned('PATCH the literal order path is the id 404', view =>
      (view.node.status === 404 && body(view).code === 'not_found') || 'PATCH order was not the :id 404');
    pinned('PATCH malformed percent escape', view =>
      (view.node.status === 400 && body(view).code === 'request_error') || 'malformed escape was not a request_error');
    pinned('PATCH missing path keeps the new name', view => {
      const answer = body(view);
      return (view.node.status === 400 && String(answer.error).startsWith('path does not exist: '))
        || `unexpected ${view.node.body.slice(0, 160)}`;
    });
    pinned('GET directories after failed patch', view => {
      const dir2 = body(view).find(entry => entry.id === 'dir-2');
      return (dir2 && dir2.name === 'Named') || 'the partial name mutation did not survive (Node quirk)';
    });
    pinned('PATCH path unchanged', view => both200(view) === true || both200(view));
    pinned('PATCH path to a broken repo', view => {
      const answer = body(view);
      return (view.node.status === 400 && answer.fix === 'open-ops-terminal') || `unexpected ${view.node.body.slice(0, 160)}`;
    });
    pinned('GET directories after broken move', view => {
      const dir2 = body(view).find(entry => entry.id === 'dir-2');
      return (dir2 && dir2.path === '<data>/broken-repo') || 'the failed readiness check did not keep the new path (Node quirk)';
    });
    pinned('PATCH path duplicate', view => {
      const answer = body(view);
      return (view.node.status === 400 && String(answer.error).includes('不允许重复')) || 'duplicate path accepted';
    });
    pinned('PATCH role prompt', view => body(view).rolePrompt === 'be nice' || 'rolePrompt was not trimmed');
    pinned('PATCH role prompt too long', view =>
      (view.node.status === 400 && String(body(view).error).startsWith('rolePrompt too long')) || 'long rolePrompt accepted');
    pinned('DELETE directory with sessions', view => {
      const answer = body(view);
      return (view.node.status === 400 && JSON.stringify(answer.sessions) === JSON.stringify(['sess-1', 'sess-2']))
        || `unexpected ${view.node.body.slice(0, 160)}`;
    });
    pinned('DELETE fragile cascade refusal', view => {
      const answer = body(view);
      return (view.node.status === 400 && answer.ok === false && answer.error === 'cascade refused')
        || `unexpected ${view.node.body.slice(0, 160)}`;
    });
    pinned('DELETE directory with force', view => {
      const answer = body(view);
      return (view.node.status === 200 && answer.removedSessions === 1) || `unexpected ${view.node.body.slice(0, 160)}`;
    });
    pinned('GET uncommitted', view => {
      if (both200(view) !== true) return both200(view);
      return body(view).files.some(file => file.path === 'dirty.txt') || 'dirty.txt missing from porcelain';
    });
    pinned('GET uncommitted not a repository', view =>
      (view.node.status === 400 && String(body(view).error).includes('not a git repository')) || 'non-repo uncommitted accepted');
    pinned('POST commit default message', view => {
      if (both200(view) !== true) return both200(view);
      const answer = body(view);
      return (answer.committed === true && answer.pushState.dirty === 0) || `unexpected ${view.node.body.slice(0, 200)}`;
    });
    pinned('POST commit Unicode message', view =>
      (view.node.status === 200 && body(view).committed === true && body(view).pushState.ahead === 3) || 'Unicode commit did not advance the branch');
    pinned('POST commit explicit message', view => {
      const answer = body(view);
      return (view.node.status === 200 && answer.committed === true && answer.pushState.ahead === 4)
        || `unexpected ${view.node.body.slice(0, 200)}`;
    });
    pinned('POST commit clean tree', view => body(view).committed === false || 'a clean tree still committed');
    pinned('POST push', view => {
      if (both200(view) !== true) return both200(view);
      const answer = body(view);
      return (answer.pushed === true && answer.before.ahead === 4 && answer.after.ahead === 0)
        || `unexpected ${view.node.body.slice(0, 200)}`;
    });
    pinned('POST push again', view => body(view).pushed === false || 'an empty push claimed to push');
    pinned('POST push not a repository', view =>
      (view.node.status === 400 && body(view).error === '当前目录没有可推送的分支') || 'non-repo push accepted');
    pinned('GET ui layout', view => {
      if (both200(view) !== true) return both200(view);
      const layout = body(view).layout;
      // dir-3 has no sessions, `gone-dir` does not exist and `dir-2` has no
      // known sessions: all three entries prune away on read.
      return (JSON.stringify(layout.dirOrder) === JSON.stringify(['dir-1'])
        && JSON.stringify(layout.sessionOrder) === JSON.stringify({ 'dir-1': ['sess-2', 'sess-1'] }))
        || `layout prune ${view.node.body.slice(0, 200)}`;
    });
    pinned('PUT ui layout dir order', view => {
      const layout = body(view).layout;
      return JSON.stringify(layout.dirOrder) === JSON.stringify(['dir-1', 'dir-3'])
        || `dir order ${JSON.stringify(layout.dirOrder)}`;
    });
    pinned('PUT ui layout session order pruned empty', view => {
      const layout = body(view).layout;
      return !Object.prototype.hasOwnProperty.call(layout.sessionOrder, 'dir-3') || 'an empty order kept a slot';
    });
    pinned('PUT ui layout session order unknown directory', view =>
      (view.node.status === 404 && body(view).error === 'directory not found') || 'unknown directory accepted');

    // Nothing in the corpus may fall into the generic 500 on either side.
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        if (view[side].status === 500 && view[side].body.includes('"code":"internal_error"')) {
          problems.push(`${view.name}: ${side} hit the generic 500 (${view[side].body})`);
        }
      }
    }

    // The 503 surface has no Node twin and is covered by the live suite only.
    let suiteText = '';
    try {
      suiteText = fs.readFileSync(path.join(repoPath, 'native/gateway/tests/directory_routes.rs'), 'utf8');
    } catch (_) {}
    if (!suiteText.includes('an_unreachable_host_is_the_documented_503')) {
      problems.push('native/gateway/tests/directory_routes.rs lost the 503 coverage test');
    }

    if (problems.length) {
      for (const problem of problems) console.log(`[directory-routes] ${problem}`);
      const file = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(file, JSON.stringify(problems, null, 2));
      return { ok: false, details: file };
    }
    console.log(`[directory-routes] side effects identical: ${rustEffects.length} lines`);
    return { ok: true };
  },
});
