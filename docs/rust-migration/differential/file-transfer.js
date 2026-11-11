'use strict';
// Differential run for the file-browser routes retired from
// src/routes/file-transfer.js (and the multer pipeline of
// src/upload-middleware.js):
//
//   GET|HEAD|OPTIONS /api/files
//   POST|OPTIONS     /api/upload
//
// now answered by native/gateway/src/app/file_transfer.rs.
//
//   node docs/rust-migration/differential/file-transfer.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-file-transfer-routes.js) over the real multer pipeline
// and a real directory tree. The Rust front door asks its host port
// (/api/__host/file-transfer); the stub child below answers with the real shim
// module (src/routes/file-transfer-host.js) over the same tree, so both sides
// describe one world.
//
// What this proves and what it does not: the ordered entry list for
// /api/files comes from the shim on the Rust side (ICU `localeCompare` is a
// Node fact), so ordering itself is not compared here — the shim's own
// ordering is covered by tests/test-file-transfer-routes.js. What is compared
// byte for byte is everything else: route matching, query trimming, the
// response shape and `parent`, every error mapping, the multipart parser and
// its policy table, the stored bytes, their mode and the reported name.
//
// Both sides write uploads into their own directory (TMPDIR for the front
// door, `node-uploads` for the oracle); the response path and the generated
// `multicc_<ms>_<hex>` name are normalized, and `finalize` compares the two
// directories themselves (normalized name, mode, size, bytes).
//
// Documented differences, registered apart from the byte-for-byte cases:
//   * methods and paths the retired module never registered
//     (`GET|HEAD /api/upload`, `POST /api/files`, an extra segment) answer
//     Express's 404 in the oracle and are forwarded by the front door.
//   * `/API/files`: Express routing is case-insensitive while the front door
//     only claims an exact `/api/` prefix.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const HOST_PATH = '/api/__host/file-transfer';
const BOUNDARY = 'DIFFBOUNDARY';

let scriptPath = '';

// ── the tree both sides see ────────────────────────────────────────────────

function writeTree(work) {
  const files = path.join(work, 'files');
  const dirs = ['', 'sub', 'sub/deep', '.dir', 'Zeta', 'alpha', '中文'];
  for (const dir of dirs) fs.mkdirSync(path.join(files, dir), { recursive: true });
  const entries = {
    'a.txt': 'data',
    'A.txt': 'upper',
    'b.png': 'png',
    '.hidden': 'secret',
    'empty.txt': '',
    '中文 名.txt': 'cjk',
    'café.txt': 'latin1',
    'sub/inside.txt': 'inside',
    'sub/deep/x.bin': 'bin',
    '.dir/y.txt': 'dot dir',
    'Zeta/z.txt': 'z',
    'alpha/a.txt': 'a',
  };
  for (const [name, content] of Object.entries(entries)) {
    fs.writeFileSync(path.join(files, name), content);
  }
  const home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'profile.txt'), 'home');
  return files;
}

// ── stub Node child: PROXY v1 + the real host-port shim ────────────────────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
const { createFileTransferHost } = require(path.join(REPO, 'src/routes/file-transfer-host'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

const HOST_PATH = ${JSON.stringify(HOST_PATH)};
const filesDir = process.env.STUB_FILES;
const sessions = {
  'active-1': { active: { cwd: filesDir } },
  'persisted-1': { persisted: { cwd: path.join(filesDir, 'sub') } },
};
const handle = createFileTransferHost({
  fs,
  path,
  os: { homedir: () => process.env.STUB_HOME, tmpdir: os.tmpdir },
  getActiveSession: id => (sessions[id] || {}).active,
  getPersistedSession: id => (sessions[id] || {}).persisted,
});

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === HOST_PATH) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      let input = {};
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
      let answer;
      try { answer = await handle(input); } catch (error) { answer = { ok: false, threw: String(error) }; }
      const text = JSON.stringify(answer);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
    return;
  }
  res.statusCode = 599;
  res.setHeader('content-type', 'text/plain');
  res.end('gateway-forwarded:' + req.method + ' ' + req.url);
});

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

// ── multipart bodies ────────────────────────────────────────────────────────

function part(head, data) {
  const chunks = [Buffer.from(`--${BOUNDARY}\r\n${head}\r\n\r\n`)];
  chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  chunks.push(Buffer.from('\r\n'));
  return chunks;
}

function fileHead(name, filename, mime) {
  return `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
    + `Content-Type: ${mime}`;
}

function fieldHead(name) {
  return `Content-Disposition: form-data; name="${name}"`;
}

function form(...parts) {
  return Buffer.concat([...parts.flat(), Buffer.from(`--${BOUNDARY}--\r\n`)]);
}

function filePart(filename, mime, data = 'hello', name = 'file') {
  return part(fileHead(name, filename, mime), data);
}

// The oracle answers Express's 404 for methods and paths the retired module
// never registered; the front door forwards those to the stub, which marks
// itself with 599.
const notRegistered = {
  node: view => view.status === 404,
  rust: view => view.status === 599,
};
// `/API/files` is a different case: Express routing is case-insensitive, so the
// oracle answers it, while the front door only claims an exact `/api/` prefix.
const uppercasePrefix = {
  node: view => view.status === 200,
  rust: view => view.status === 599,
};

// ── corpus ─────────────────────────────────────────────────────────────────

function corpus({ work }) {
  const files = path.join(work, 'files');
  const f = name => path.join(files, name);
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  const q = p => `/api/files?path=${encodeURIComponent(p)}`;
  const upload = body => ({
    method: 'POST',
    url: '/api/upload',
    headers: {
      ...L,
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  const uploadJson = body => ({
    method: 'POST',
    url: '/api/upload',
    headers: { ...L, 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    body,
  });
  const uploadRaw = (body, type) => ({
    method: 'POST',
    url: '/api/upload',
    headers: { ...L, 'Content-Type': type, 'Content-Length': String(body.length) },
    body,
  });
  const huge = Buffer.alloc(25 * 1024 * 1024 + 1, 0x78);
  const exact = Buffer.alloc(25 * 1024 * 1024, 0x78);
  const octetPart = part('Content-Disposition: form-data; name="file"\r\nContent-Type: application/octet-stream', 'x');
  const unnamedPart = part('Content-Disposition: form-data; filename="a.png"\r\nContent-Type: image/png', 'x');
  const junkPart = part('Content-Type: text/plain', 'x');
  return [
    // /api/files
    ['files homedir', get('/api/files')],
    ['files empty path', get('/api/files?path=')],
    ['files trimmed path', get(q(`  ${files}  `))],
    ['files tree', get(q(files))],
    ['files subdirectory', get(q(f('sub')))],
    ['files dot dir', get(q(f('.dir')))],
    ['files tilde', get('/api/files?path=~')],
    ['files tilde slash', get('/api/files?path=~/sub')],
    ['files session active', get('/api/files?session=active-1')],
    ['files session persisted', get('/api/files?session=persisted-1')],
    ['files session unknown', get('/api/files?session=nope')],
    ['files path wins over session', get(`${q(f('sub'))}&session=active-1`)],
    ['files missing dir', get(q(f('missing')))],
    ['files a file', get(q(f('a.txt')))],
    ['files array path', get('/api/files?path=a&path=b')],
    ['files array session', get(`${q(files)}&session=a&session=b`)],
    ['files nested query', get(`/api/files?path[]=${encodeURIComponent(files)}`)],
    ['files mixed case', get('/api/Files')],
    ['files trailing slash', get('/api/files/')],
    ['HEAD files', head(q(files))],
    ['OPTIONS files', options('/api/files')],
    ['OPTIONS files trailing slash', options('/api/files/')],
    // /api/upload — accepted shapes
    ['upload text', upload(form(filePart('note.txt', 'text/plain')))],
    ['upload utf8 name', upload(form(filePart('中文 名.png', 'image/png')))],
    ['upload latin1 name', upload(form(filePart('café.txt', 'text/plain')))],
    ['upload windows path name', upload(form(filePart('..\\..\\etc\\passwd', 'text/plain')))],
    ['upload long name', upload(form(filePart(`${'b'.repeat(300)}.png`, 'image/png')))],
    ['upload empty file', upload(form(filePart('empty.txt', 'text/plain', '')))],
    ['upload image with params', upload(form(filePart('x.png', 'image/png; charset=binary')))],
    ['upload octet stream', upload(form(filePart('x.bin', 'application/octet-stream')))],
    ['upload json type', upload(form(filePart('x.json', 'application/json')))],
    ['upload no extension name', upload(form(filePart('noext', 'text/plain')))],
    ['upload dotfile name', upload(form(filePart('.bashrc', 'text/plain')))],
    ['upload basename to nothing', upload(form(filePart('/', 'image/png')))],
    // /api/upload — policy answers
    ['upload empty filename', upload(form(filePart('', 'text/plain')))],
    ['upload wrong field', upload(form(filePart('a.png', 'image/png', 'x', 'image')))],
    ['upload extra field', upload(form(part(fieldHead('note'), 'hello'), filePart('a.png', 'image/png')))],
    ['upload field after file', upload(form(filePart('a.png', 'image/png'), part(fieldHead('note'), 'hello')))],
    ['upload two files', upload(form(filePart('a.png', 'image/png'), filePart('b.png', 'image/png')))],
    ['upload junk part after file', upload(form(filePart('a.png', 'image/png'), junkPart))],
    ['upload octet part without filename', upload(form(octetPart))],
    ['upload octet part then file', upload(form(octetPart, filePart('a.png', 'image/png')))],
    ['upload unnamed part', upload(form(unnamedPart))],
    ['upload unsupported mime', upload(form(filePart('a.exe', 'application/x-msdownload')))],
    ['upload long field name', upload(form(filePart('a.png', 'image/png', 'x', 'a'.repeat(65))))],
    ['upload long field name empty filename', upload(form(filePart('', 'text/plain', 'x', 'a'.repeat(65))))],
    ['upload no boundary', uploadRaw(Buffer.from('x'), 'multipart/form-data')],
    ['upload empty form', uploadRaw(Buffer.from(`--${BOUNDARY}--\r\n`), `multipart/form-data; boundary=${BOUNDARY}`)],
    ['upload truncated form', uploadRaw(
      Buffer.from(`--${BOUNDARY}\r\n${fileHead('file', 'a.txt', 'text/plain')}\r\n\r\ndata`),
      `multipart/form-data; boundary=${BOUNDARY}`,
    )],
    ['upload oversized', upload(form(filePart('big.bin', 'application/octet-stream', huge)))],
    ['upload exactly at the limit', upload(form(filePart('exact.bin', 'application/octet-stream', exact)))],
    // /api/upload — the express.json branch
    ['upload json body', uploadJson(Buffer.from('{"a":1}'))],
    ['upload invalid json', uploadJson(Buffer.from('{oops'))],
    ['upload json array', uploadJson(Buffer.from('[1]'))],
    ['upload text body', uploadRaw(Buffer.from('x'), 'text/plain')],
    ['upload no type', { method: 'POST', url: '/api/upload', headers: { ...L, 'Content-Length': '1' }, body: Buffer.from('x') }],
    ['OPTIONS upload', options('/api/upload')],
    ['OPTIONS upload trailing slash', options('/api/upload/')],
    // not registered by the retired module: documented differences
    ['GET upload', get('/api/upload'), { expectedDifference: notRegistered }],
    ['HEAD upload', head('/api/upload'), { expectedDifference: notRegistered }],
    ['POST files', { method: 'POST', url: '/api/files', headers: L }, { expectedDifference: notRegistered }],
    ['files extra segment', get('/api/files/x'), { expectedDifference: notRegistered }],
    ['uppercase prefix', get('/API/files'), { expectedDifference: uppercasePrefix }],
  ];
}

// ── normalization ──────────────────────────────────────────────────────────

function normalize(text, work) {
  return text
    .split(path.join(work, 'node-uploads')).join('<tmp>')
    .split(path.join(work, 'gw-uploads')).join('<tmp>')
    .replace(/multicc_\d+_[0-9a-f]{8}/g, 'multicc_<ms>_<hex>');
}

function normalizeView(view) {
  // A successful upload reports the directory it wrote into, so the two sides'
  // bodies have different lengths (and therefore ETags) before normalization.
  if (view.status === 200 && view.body.includes('"path":"<tmp>/multicc_')) {
    if (view.headers.etag) view.headers.etag = '<etag>';
    if (view.headers['content-length']) view.headers['content-length'] = '<len>';
  }
  return view;
}

// ── mount ──────────────────────────────────────────────────────────────────

main({
  name: 'file-transfer',
  upstream: upstreamSource(path.resolve(process.argv[2] || '')),
  mount(app, { repo, work }) {
    const files = writeTree(work);
    const uploads = path.join(work, 'node-uploads');
    fs.mkdirSync(uploads, { recursive: true });
    const legacy = require(path.join(repo, 'tests/helpers/legacy-file-transfer-routes.js'));
    const sessions = {
      'active-1': { active: { cwd: files } },
      'persisted-1': { persisted: { cwd: path.join(files, 'sub') } },
    };
    legacy.mountFileTransferRoutes(app, {
      fs,
      path,
      os: { homedir: () => path.join(work, 'home'), tmpdir: () => uploads },
      upload: legacy.createUploadSuite(),
      persistChatUpload: file => legacy.persistChatUpload(file, { tmpDir: uploads }),
      sendUploadError: legacy.sendUploadError,
      getActiveSession: id => (sessions[id] || {}).active,
      getPersistedSession: id => (sessions[id] || {}).persisted,
      log: () => {},
    });
  },
  gatewayEnv(work) {
    const uploads = path.join(work, 'gw-uploads');
    fs.mkdirSync(uploads, { recursive: true });
    return {
      // The stub child requires the repo's request-locality module, which loads
      // the native addon at require time; a debug gateway binary does not sit
      // next to the fingerprint directory, so point it at the addon explicitly.
      MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
      // The listing order comes from ICU `localeCompare`, whose default locale
      // follows the environment; the gateway child must inherit the same one
      // the oracle process runs with or the two sides disagree on CJK names.
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_COLLATE: process.env.LC_COLLATE,
      TMPDIR: `${uploads}/`,
      STUB_FILES: path.join(work, 'files'),
      STUB_HOME: path.join(work, 'home'),
      // The stub script needs the script file path; it reads nothing else.
      STUB_SCRIPT: path.join(work, 'unused.json'),
    };
  },
  corpus,
  normalize,
  normalizeView,
  finalize({ work }) {
    const summarize = dir => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).sort().map(name => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return {
          name: name.replace(/^multicc_\d+_[0-9a-f]{8}/, 'multicc_<ms>_<hex>'),
          mode: (stat.mode & 0o777).toString(8),
          size: stat.size,
          data: fs.readFileSync(full).toString('base64'),
        };
      });
    };
    const node = summarize(path.join(work, 'node-uploads'));
    const rust = summarize(path.join(work, 'gw-uploads'));
    return {
      ok: JSON.stringify(node) === JSON.stringify(rust),
      details: {
        nodeCount: node.length,
        rustCount: rust.length,
        node,
        rust,
      },
    };
  },
});
