'use strict';
// Differential run for the ten release-asset, iOS OTA and chat-history routes
// retired from src/routes/{system,chat-history,static-assets}.js and
// src/ios-udid.js and now answered by native/gateway/src/app/
// release_history_routes.rs (rules in native/core/src/release_history_routes.rs):
//
//   GET|HEAD /api/apk-info  /api/ios-ota-info  /ios-ota/manifest.plist
//   GET|HEAD /ios-ota/udid.mobileconfig  /ios-ota/udid/result/:token
//   POST     /ios-ota/udid/callback/:token
//   DELETE   /api/sessions/:id/messages/:msgId
//   GET|HEAD /api/sessions/:id/history  /api/sessions/:id/context-level
//   GET|HEAD /   (only when it redirects)
//
//   node docs/rust-migration/differential/release-history-routes.js <repo> <gateway> [addon]
//
// The Node side mounts the frozen retired modules (tests/helpers/
// legacy-release-history-routes/, never `git show` at run time) in the order the
// retired server mounted them, behind the real public-session guard. The Rust
// front door calls its host port (/api/__host/release-history); the stub child
// mounts the live src/routes/release-history-host.js over the SAME world
// (buildWorld below, shared by both sides through this file).
//
// Three things make this group different from the others:
//  * Random values. The profile route mints a random 32-byte token, a random
//    32-byte challenge and a random UUID, and the callback 301s to a URL with a
//    random result token. Two processes can never agree on them. `scrub` maps a
//    value to a placeholder only when it has the exact legal shape (a lone
//    64-hex run, a v4 UUID); a malformed or wrong-length value stays verbatim
//    and shows up as a diff. The profile response is additionally checked for
//    internal consistency (the URL token equals the PayloadIdentifier token, the
//    challenge differs from the token) and the ETag of a scrubbed body keeps its
//    length part, so byte-length differences are still caught.
//  * openssl. Both sides inject the same `decode` stand-in (decodeStub) instead
//    of spawning `openssl cms`: the signed reply is just the plist text, so the
//    test builds it from the challenge the profile handed THAT side.
//  * Deletes are real. Both chat runtimes write into their own isolated data
//    root (lib's MULTICC_DATA_DIR), and the two history trees are compared byte
//    for byte afterwards, together with the broadcasts each side emitted.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const APPLE = 'application/x-apple-aspen-deviceinfo';
const PKCS7 = 'application/pkcs7-signature';
const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');
const UDID = '00008030-001A2B3C4D5E6F78';
const OLD_UDID = 'a'.repeat(40);

// ── the shared world (both sides run exactly this) ──────────────────────────

/** Stand-in for `openssl cms -verify`: the "signed reply" is the plist text. */
function decodeStub(body) {
  const text = Buffer.from(body).toString('utf8');
  if (text.startsWith('FAIL-ENOENT')) {
    return Promise.reject(Object.assign(new Error('spawn openssl ENOENT'), { code: 'ENOENT' }));
  }
  if (text.startsWith('FAIL')) return Promise.reject(new Error('cms verify failed'));
  return Promise.resolve(text);
}

/** A GitHub that is always unreachable: the remote branch settles as unknown. */
function offlineHttps() {
  return {
    get() {
      const request = new EventEmitter();
      request.destroy = () => {};
      process.nextTick(() => request.emit('error', Object.assign(new Error('offline'), { code: 'ENOTFOUND' })));
      return request;
    },
  };
}

function devicePlist({ udid = UDID, challenge, product = 'iPhone15,2', version = '17.4.1', extra = '' }) {
  const field = (key, value) => (value == null ? '' : `<key>${key}</key><string>${value}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${field('UDID', udid)}${field('CHALLENGE', challenge)}${field('PRODUCT', product)}${field('VERSION', version)}${extra}</dict></plist>`;
}

function messages() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message number ${index + 1}`,
    ts: 1_700_000_000_000 + index * 1000,
  }));
}

function projectDir(work) { return path.join(work, 'proj'); }

/** Everything on disk a side's world reads: the install root's public files. */
function ensureRoot(root) {
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.7.3"}');
  fs.writeFileSync(path.join(root, 'app', 'pubspec.yaml'), 'name: multicc\nversion: 1.7.3+173\n');
}

function writeAsset(file, content) {
  if (content === null) { fs.rmSync(file, { force: true }); return; }
  fs.writeFileSync(file, content);
  fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
}

/** send's stat ETag for the seeded apk: 20 bytes at the pinned mtime. */
const APK_ETAG = `W/"${(20).toString(16)}-${FIXED_TIME.getTime().toString(16)}"`;

/** `scene` -> files: apk 'none'|'local', ipa 'none'|'bare'|'full'. */
function setScene(root, scene) {
  const pub = path.join(root, 'public');
  if (scene.apk) {
    const local = scene.apk === 'local';
    writeAsset(path.join(pub, 'multicc.apk'), local ? 'APK-BYTES-0123456789' : null);
    writeAsset(path.join(pub, 'multicc.apk.json'), local ? '{"versionName":"1.7.3","versionCode":173}' : null);
  }
  if (scene.ipa) {
    const has = scene.ipa !== 'none';
    writeAsset(path.join(pub, 'multicc-ios.ipa'), has ? 'IPA-BYTES-0123456789' : null);
    writeAsset(path.join(pub, 'multicc-ios.ipa.json'), scene.ipa === 'full' ? JSON.stringify({
      versionName: '1.7.3', versionCode: 173, bundleId: 'com.multicc.app', title: 'MultiCC <Beta> & "Co"',
      sha256: 'c'.repeat(64), builtAt: '2026-01-01T00:00:00Z',
    }) : null);
  }
}

// The retired Node adapter (src/session/adapters/chat-history-file-repository.js)
// is gone from current trees; an older <repo> checkout may still carry it.
function historyRepository(repo, dataDir) {
  const R = rel => require(path.join(repo, rel));
  if (fs.existsSync(path.join(repo, 'src/session/adapters/chat-history-file-repository.js'))) {
    return R('src/session/adapters/chat-history-file-repository').createChatHistoryFileRepository({ dataDir });
  }
  return R('src/native/binding').getNative().chatHistoryFileRepositoryCreate({
    root: R('src/paths').createPaths({ dataDir }).chatHistoryDir,
    reportFailure: (fs.existsSync(path.join(repo, 'src/state/store.js'))
      ? R('src/state/store') : R('src/native/binding').stateStore).reportFailure,
  });
}

function buildWorld({ repo, dataRoot, rootDir, work, side, createChatHistoryRuntime, createIosUdid }) {
  const R = rel => require(path.join(repo, rel));
  const { createApkDistribution } = R('src/apk-distribution');
  const { createIosOta } = R('src/ios-ota');
  const proj = projectDir(work);
  const persistedSessions = new Map([
    ['s1', { id: 's1', kind: 'chat', cli: 'claude', cwd: proj, cliSessionId: 'cli-s1' }],
    ['s2', { id: 's2', kind: 'chat', cli: 'codex' }],
    ['oc1', { id: 'oc1', kind: 'chat', cli: 'opencode', cliSessionId: 'oc-native', model: 'oc-model' }],
    ['empty', { id: 'empty', kind: 'chat', cli: 'claude', cwd: proj, cliSessionId: 'cli-none' }],
    ['bad', { id: 'bad', kind: 'chat', cli: 'claude', cwd: proj }],
    ['internal1', { id: 'internal1', kind: 'chat', cli: 'claude', taskExecutionSlot: true }],
    ['a/b', { id: 'a/b', kind: 'chat', cli: 'claude', cwd: proj }],
  ]);
  const history = historyRepository(repo, dataRoot);
  const broadcastFile = path.join(work, `${side}-broadcast.jsonl`);
  let sequence = 0;
  const chat = createChatHistoryRuntime({
    history,
    persistedSessions,
    chatSessions: new Map([['s1', { cli: 'claude' }]]),
    idFactory: () => `id-${++sequence}`,
    now: () => 1_800_000_000_000,
    maxMessages: 100,
    historyPageSize: 5,
    auxSessionId: '__aux__',
    chatBroadcast(sessionId, payload) {
      fs.appendFileSync(broadcastFile, `${JSON.stringify({ sessionId, payload })}\n`);
    },
    distillHistoryIntoMemory: async () => ({ updated: true }),
    maybeSchedulePeriodicMemoryReview() {},
    cliSwitchGitSnapshot: async () => ({ branch: 'main', head: 'abc', changes: [] }),
    clearAllNativeCliStates: () => 0,
    buildHandoffCheckpoint: input => ({ createdAt: 1, history: input.history, git: input.git }),
    rememberActiveCliState() {},
    sessionPersistence: { mutate: (_source, mutator) => mutator(persistedSessions) },
    getSessionRunState: () => 'idle',
    getActiveBackgroundTasks: () => [],
    chatStream: {
      close() {},
      status: id => (id === 's1' ? { alive: true, busy: false, recycleRequested: true } : null),
    },
    cwdForSession: record => record.cwd,
    opencodeContextReader: {
      read: async (cliSessionId, model) => ({ cliSessionId, model, used: 1234, limit: 200000 }),
    },
    logger: { warn() {}, info() {}, error() {} },
  });
  return {
    persistedSessions,
    chat,
    apk: createApkDistribution({ fs, path, https: offlineHttps(), rootDir }),
    ota: createIosOta({ fs, path, rootDir }),
    udid: createIosUdid({ decode: decodeStub }),
  };
}

// ── random-value normalisation ──────────────────────────────────────────────

const HEX64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;
const UUID_V4 = /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![0-9a-f-])/g;

/** Only a value of exactly the legal shape is mapped; anything else stays. */
function scrub(text) {
  return String(text).replace(HEX64, '<HEX64>').replace(UUID_V4, '<UUID>');
}

// ── the run (not loaded when the upstream child requires this file) ─────────

function upstream(repo, rootDir, work) {
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const path = require('node:path');
const repo = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [repo] }));
const { buildWorld } = require(${JSON.stringify(__filename)});
const { createReleaseHistoryHost } = require(path.join(repo, 'src/routes/release-history-host'));
const { mountApkDownload } = require(path.join(repo, 'src/routes/release-history-host'));
const { createAuthSecurity } = require(path.join(repo, 'src/native/binding')).authSecurity;
const { connectAuthControl } = require(path.join(repo, 'src/native/binding')).gatewayChild;
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
const world = buildWorld({
  repo, dataRoot: process.env.MULTICC_DATA_DIR, rootDir: ${JSON.stringify(rootDir)}, work: ${JSON.stringify(work)},
  side: 'rust',
  createChatHistoryRuntime: require(path.join(repo, 'src/routes/chat-history/index')).createChatHistoryRuntime,
  createIosUdid: require(path.join(repo, 'src/ios-udid')).createIosUdid,
});
const { requestIdMiddleware, safeErrorHandler } = require(path.join(repo, 'src/http-errors'));
const { jsonCompression } = require(path.join(repo, 'src/native/binding')).jsonCompression;
const app = express(); app.use(requestIdMiddleware, jsonCompression); app.use(express.json({ limit: '50mb' }));
// A request marked ?down=1 is dropped before it is answered: the host is broken.
app.use((req, res, next) => {
  if (req.path === '/api/__host/release-history' && String((req.body || {}).originalUrl || '').includes('down=1')) {
    req.socket.destroy(); return;
  }
  next();
});
// The public-session guard's one fact (what session-admin's guard-record returns).
app.post('/api/__host/session-admin', (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const record = world.persistedSessions.get(id) || null;
  const text = JSON.stringify({ record: record ? { id } : null, internal: !!(record && record.taskExecutionSlot === true), taskStateWritable: true });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }); res.end(text);
});
createReleaseHistoryHost({ chatHistory: world.chat, apkDistribution: world.apk, iosOta: world.ota, iosUdid: world.udid }).mountRoute(app);
mountApkDownload(app, { apkDistribution: world.apk, iosOta: world.ota });
app.use((req, res, next) => (req.method === 'OPTIONS' ? next() : res.status(599).send('forwarded:' + req.method + ' ' + req.url)));
app.use(safeErrorHandler({ warn() {}, info() {}, error() {} }));
const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
 socket.on('error', () => {}); let buffered = Buffer.alloc(0);
 const onData = chunk => { buffered = Buffer.concat([buffered, chunk]);
  const end = buffered.indexOf('\\r\\n'); if (end < 0) return;
  socket.removeListener('data', onData); socket.pause();
  const rest = buffered.subarray(end + 2); if (rest.length) socket.unshift(rest);
  server.emit('connection', socket); socket.resume(); };
 socket.on('data', onData); socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');`;
}

/** One raw HTTP/1.1 exchange written byte for byte (a request with neither Content-Length nor Transfer-Encoding). */
function rawSend(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const timer = setTimeout(() => socket.destroy(new Error('raw exchange timed out')), 15_000);
    socket.on('connect', () => socket.write(text));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      const split = data.indexOf('\r\n\r\n');
      if (split < 0) { reject(new Error('no response head')); return; }
      const lines = data.subarray(0, split).toString('latin1').split('\r\n');
      const headers = {};
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      let body = data.subarray(split + 4);
      if (/chunked/i.test(headers['transfer-encoding'] || '')) {
        const out = []; let rest = body;
        for (;;) {
          const eol = rest.indexOf('\r\n'); if (eol < 0) break;
          const size = parseInt(rest.subarray(0, eol).toString(), 16);
          if (!size) break;
          out.push(rest.subarray(eol + 2, eol + 2 + size)); rest = rest.subarray(eol + 2 + size + 2);
        }
        body = Buffer.concat(out);
      }
      resolve({ status: Number(lines[0].split(' ')[1]), headers, body });
    });
  });
}

let workPath = '';
let nodeRoot = '';
let gwRoot = '';
let upstreamText = '';
let seedText = '';
let initialHistory = new Map();
const problems = [];
const pending = [];
const rootOf = side => (side.name === 'node' ? nodeRoot : gwRoot);

/** Learn the token/challenge a profile response handed THIS side. */
function learnProfile(raw, side) {
  const text = Buffer.from(raw.body).toString('utf8');
  const url = /\/ios-ota\/udid\/callback\/([0-9a-f]{64})<\/string>/.exec(text);
  const challenge = /<key>Challenge<\/key><string>([0-9a-f]{64})<\/string>/.exec(text);
  const identifier = /<key>PayloadIdentifier<\/key><string>com\.multicc\.udid\.([0-9a-f]{64})<\/string>/.exec(text);
  const uuid = /<key>PayloadUUID<\/key><string>([^<]*)<\/string>/.exec(text);
  const name = side.state.profileCase || 'profile';
  if (raw.status !== 200 || !url || !challenge || !identifier) {
    side.state.token = null; side.state.challenge = null;
    return;
  }
  if (url[1] !== identifier[1]) problems.push(`${name}: ${side.name} profile URL token differs from the PayloadIdentifier token`);
  if (url[1] === challenge[1]) problems.push(`${name}: ${side.name} profile token equals its challenge`);
  if (!uuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid[1])) {
    problems.push(`${name}: ${side.name} PayloadUUID is not a v4 UUID`);
  }
  side.state.token = url[1];
  side.state.challenge = challenge[1];
}

const HDR = { Host: 'localhost', 'X-Request-Id': 'diff-rh-1' };
// A forwarded host/proto marks a request as remote, so the https cases carry the
// login cookie; the EXT_* ones are the same requests from an external peer with
// no credential at all.
const NO_COOKIE_HTTPS = { ...HDR, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'ota.example.com' };
let HTTPS = NO_COOKIE_HTTPS;
const EXT = { ...HDR, 'X-Forwarded-For': '203.0.113.9' };
const EXT_HTTPS = { ...NO_COOKIE_HTTPS, 'X-Forwarded-For': '203.0.113.9' };

function add(name, request, hooks = {}) {
  const { scene, fresh, control, ...rest } = hooks;
  pending.push([name, request, {
    ...rest,
    async before(side) {
      if (scene) setScene(rootOf(side), scene);
      if (fresh) {
        const { send } = require('./lib');
        side.state.profileCase = `${name} (setup)`;
        learnProfile(await send(side.port, { method: 'GET', url: '/ios-ota/udid.mobileconfig', headers: HTTPS }), side);
      }
    },
  }]);
}

function corpus(ctx) {
  HTTPS = { ...NO_COOKIE_HTTPS, Cookie: `multicc_auth=${ctx.cookie}` };
  const get = (url, headers = HDR) => ({ method: 'GET', url, headers });
  const head = (url, headers = HDR) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = HDR) => ({ method: 'OPTIONS', url, headers });
  const del = (url, headers = HDR) => ({ method: 'DELETE', url, headers });
  const post = (url, body, headers) => ({ method: 'POST', url, headers, body });
  const cbUrl = side => `/ios-ota/udid/callback/${side.state.token}`;
  const plist = (side, over = {}) => devicePlist({ challenge: side.state.challenge, ...over });
  const callback = (make, type = APPLE, extraHeaders = {}) => side => post(cbUrl(side), make(side), { ...HTTPS, 'Content-Type': type, ...extraHeaders });

  // ── APK ───────────────────────────────────────────────────────────────────
  add('apk-info without a local file', () => get('/api/apk-info'), { scene: { apk: 'none', ipa: 'none' } });
  add('HEAD apk-info', () => head('/api/apk-info'));
  add('apk-info with a trailing slash', () => get('/api/apk-info/'));
  add('apk-info with mixed case', () => get('/api/Apk-Info'));
  add('apk-info with a query', () => get('/api/apk-info?x=1&y=2'));
  add('multicc.apk without a local file', () => get('/multicc.apk'));
  // The retired `app.get('/multicc.apk')` matched case-insensitively and
  // non-strictly, so the claim has to carry both spellings to the host op.
  add('multicc.apk with mixed case', () => get('/MULTICC.APK'));
  add('multicc.apk with a trailing slash', () => get('/multicc.apk/'));
  add('apk-info with a local file', () => get('/api/apk-info'), { scene: { apk: 'local' } });
  add('multicc.apk with a local file is streamed', () => get('/multicc.apk'));
  // The handler's next() landed in the `.apk` guard, which only exempts the
  // exact lowercase name: a case variant dies there even with a usable file.
  add('MULTICC.APK with a local file hits the binary guard', () => get('/MULTICC.APK'));
  add('HEAD MULTICC.APK with a local file hits the binary guard', () => head('/MULTICC.APK'));
  // ...and a trailing slash matched neither the guard nor a file, so the
  // retired chain passed the request on; the front door forwards it too.
  add('multicc.apk with a trailing slash and a local file falls through', () => get('/multicc.apk/'));
  add('HEAD multicc.apk with a local file', () => head('/multicc.apk'));
  add('multicc.apk range', () => get('/multicc.apk', { ...HDR, Range: 'bytes=2-5' }));
  add('multicc.apk multi range is a plain 200', () => get('/multicc.apk', { ...HDR, Range: 'bytes=0-1,4-5' }));
  add('multicc.apk conditional', () => get('/multicc.apk', { ...HDR, 'If-None-Match': APK_ETAG }));
  add('multicc.apk precondition failure', () => get('/multicc.apk', { ...HDR, 'If-Match': '"nope"' }));
  add('multicc.apk unsatisfiable range', () => get('/multicc.apk', { ...HDR, Range: 'bytes=999-' }));
  add('POST apk-info is not a route', () => post('/api/apk-info', '{}', { ...HDR, 'Content-Type': 'application/json' }));
  add('apk-info with an extra segment is not a route', () => get('/api/apk-info/extra'));
  // ── iOS OTA info and manifest ─────────────────────────────────────────────
  add('ios-ota-info without an ipa', () => get('/api/ios-ota-info'), { scene: { ipa: 'none' } });
  add('manifest without an ipa', () => get('/ios-ota/manifest.plist', HTTPS));
  add('ios-ota-info with an ipa and no sidecar', () => get('/api/ios-ota-info'), { scene: { ipa: 'bare' } });
  add('manifest with an ipa and no sidecar', () => get('/ios-ota/manifest.plist', HTTPS));
  add('ios-ota-info with a full sidecar', () => get('/api/ios-ota-info'), { scene: { ipa: 'full' } });
  add('HEAD ios-ota-info', () => head('/api/ios-ota-info'));
  add('manifest through https', () => get('/ios-ota/manifest.plist', HTTPS));
  add('HEAD manifest', () => head('/ios-ota/manifest.plist', HTTPS));
  add('manifest over plain http', () => get('/ios-ota/manifest.plist'));
  add('manifest with a hostile forwarded host', () => get('/ios-ota/manifest.plist', { ...HTTPS, 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'evil.example/<x>' }));
  add('manifest with an unknown forwarded proto', () => get('/ios-ota/manifest.plist', { ...HTTPS, 'X-Forwarded-Proto': 'ftp' }));
  add('manifest with a forwarded proto list', () => get('/ios-ota/manifest.plist', { ...HTTPS, 'X-Forwarded-Proto': 'https, http', 'X-Forwarded-Host': 'a.example:8443, b.example' }));
  add('manifest with a trailing slash', () => get('/ios-ota/manifest.plist/', HTTPS));
  add('manifest with mixed case', () => get('/IOS-OTA/Manifest.plist', HTTPS));
  // ── UDID profile ──────────────────────────────────────────────────────────
  add('profile over plain http', () => get('/ios-ota/udid.mobileconfig'));
  add('profile from a cross-site fetch', () => get('/ios-ota/udid.mobileconfig', { ...HTTPS, 'Sec-Fetch-Site': 'cross-site' }));
  add('profile over https', () => get('/ios-ota/udid.mobileconfig', HTTPS), {
    capture(raw, side) { side.state.profileCase = 'profile over https'; learnProfile(raw, side); },
  });
  add('profile with an xml-hostile forwarded host', () => get('/ios-ota/udid.mobileconfig', { ...HTTPS, 'X-Forwarded-Host': 'a&b.example' }));
  add('HEAD profile', () => head('/ios-ota/udid.mobileconfig', HTTPS), {
    // A HEAD carries the ETag of a body that held random values.
    normalize(view) { return normalizeView({ ...view, body: '<HEX64>' }) && { ...view, headers: { ...view.headers, etag: String(view.headers.etag).replace(/^(W\/"[0-9a-f]+-)[^"]+"$/, '$1<HASH>"') } }; },
  });
  add('profile with a same-origin fetch', () => get('/ios-ota/udid.mobileconfig', { ...HTTPS, 'Sec-Fetch-Site': 'same-origin' }));
  // ── UDID result before any callback ───────────────────────────────────────
  add('result with a malformed token', () => get('/ios-ota/udid/result/not-a-token'));
  add('result with an unknown token', () => get(`/ios-ota/udid/result/${'ab'.repeat(32)}`));
  add('HEAD result with an unknown token', () => head(`/ios-ota/udid/result/${'ab'.repeat(32)}`));
  add('result with an upper-case token', () => get(`/ios-ota/udid/result/${'AB'.repeat(32)}`));
  add('result with a bad escape', () => get('/ios-ota/udid/result/%E0%A4%A'));
  // ── UDID callback ─────────────────────────────────────────────────────────
  add('callback with an unknown token', () => post(`/ios-ota/udid/callback/${'cd'.repeat(32)}`, 'x', { ...HDR, 'Content-Type': APPLE }));
  add('callback with a malformed token', () => post('/ios-ota/udid/callback/short', 'x', { ...HDR, 'Content-Type': APPLE }));
  add('callback with a challenge mismatch', callback(() => devicePlist({ challenge: 'f'.repeat(64) })), { fresh: true });
  add('callback retried after the mismatch succeeds', callback(side => plist(side)), {
    capture(raw, side) { const m = /\/ios-ota\/udid\/result\/([0-9a-f]{64})$/.exec(raw.headers.location || ''); side.state.result = m ? m[1] : null; },
  });
  add('callback replayed after success', callback(side => plist(side)));
  add('result after a successful callback', side => get(`/ios-ota/udid/result/${side.state.result}`));
  add('HEAD result after a successful callback', side => head(`/ios-ota/udid/result/${side.state.result}`));
  add('result replayed', side => get(`/ios-ota/udid/result/${side.state.result}`));
  add('callback with a pkcs7 content type and a 40-hex udid', callback(side => plist(side, { udid: OLD_UDID }), PKCS7), {
    fresh: true,
    capture(raw, side) { const m = /\/ios-ota\/udid\/result\/([0-9a-f]{64})$/.exec(raw.headers.location || ''); side.state.result = m ? m[1] : null; },
  });
  add('result of the 40-hex udid', side => get(`/ios-ota/udid/result/${side.state.result}`));
  add('callback with a plain text content type', callback(side => plist(side), 'text/plain'), { fresh: true });
  add('callback with an xml-escaped product', callback(side => plist(side, { product: 'iPad<8>' })), { fresh: true });
  add('callback with an invalid udid', callback(side => plist(side, { udid: 'not-a-udid' })), { fresh: true });
  add('callback without a challenge', callback(() => devicePlist({ challenge: undefined })), { fresh: true });
  add('callback with a duplicate key', callback(side => plist(side, { extra: '<key>UDID</key><string>x</string>' })), { fresh: true });
  add('callback with a hostile field', callback(side => plist(side, { product: 'a&amp;b' })), { fresh: true });
  add('callback with trailing junk', callback(side => `${plist(side)} junk`), { fresh: true });
  add('callback that is not a plist', callback(() => 'hello'), { fresh: true });
  add('callback the verifier refuses', callback(() => 'FAIL'), { fresh: true });
  add('callback with openssl missing', callback(() => 'FAIL-ENOENT'), { fresh: true });
  add('callback with an empty body', side => post(cbUrl(side), '', { ...HTTPS, 'Content-Type': APPLE, 'Content-Length': '0' }), { fresh: true });
  add('callback body with no framing at all', {}, {
    fresh: true,
    send(side, _spec) {
      return rawSend(side.port, `POST ${cbUrl(side)} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: diff-rh-1\r\nContent-Type: ${APPLE}\r\nConnection: close\r\n\r\n`);
    },
  });
  add('callback with a json body', callback(() => '{"a":1}', 'application/json'), { fresh: true });
  add('callback with a malformed json body', callback(() => '{', 'application/json'), { fresh: true });
  add('callback with an oversize declared length', callback(() => 'x'.repeat(70_000)), { fresh: true });
  add('callback with an oversize chunked body', callback(() => 'x'.repeat(80_000), APPLE, { 'Transfer-Encoding': 'chunked' }), { fresh: true });
  add('callback with an exactly-at-limit body', callback(() => 'y'.repeat(64 * 1024)), { fresh: true });
  add('callback with a content encoding', callback(() => 'x', APPLE, { 'Content-Encoding': 'gzip' }), { fresh: true });
  add('callback with an identity content encoding', callback(side => plist(side), APPLE, { 'Content-Encoding': 'identity' }), {
    capture(raw, side) { const m = /\/ios-ota\/udid\/result\/([0-9a-f]{64})$/.exec(raw.headers.location || ''); side.state.result = m ? m[1] : null; },
  });
  add('callback with a chunked body', callback(side => plist(side), APPLE, { 'Transfer-Encoding': 'chunked' }), { fresh: true });
  add('OPTIONS callback', () => options('/ios-ota/udid/callback/abc'));
  add('callback by GET is not a route', () => get(`/ios-ota/udid/callback/${'ab'.repeat(32)}`));
  add('result by POST is not a route', () => post(`/ios-ota/udid/result/${'ab'.repeat(32)}`, '{}', { ...HDR, 'Content-Type': 'application/json' }));
  // ── authentication exemptions (an external peer with no token) ────────────
  add('external apk-info is gated', () => get('/api/apk-info', EXT));
  add('external ios-ota-info is gated', () => get('/api/ios-ota-info', EXT));
  add('external manifest is public', () => get('/ios-ota/manifest.plist', EXT_HTTPS));
  add('external profile is gated', () => get('/ios-ota/udid.mobileconfig', EXT_HTTPS));
  add('external result is public', () => get(`/ios-ota/udid/result/${'ab'.repeat(32)}`, EXT));
  add('external callback with the apple type is public', () => post(`/ios-ota/udid/callback/${'ab'.repeat(32)}`, 'x', { ...EXT, 'Content-Type': APPLE }));
  add('external callback with the pkcs7 type is public', () => post(`/ios-ota/udid/callback/${'ab'.repeat(32)}`, 'x', { ...EXT, 'Content-Type': PKCS7 }));
  add('external callback with another type is gated', () => post(`/ios-ota/udid/callback/${'ab'.repeat(32)}`, 'x', { ...EXT, 'Content-Type': 'text/plain' }));
  add('external history is gated', () => get('/api/sessions/s1/history', EXT));
  add('external delete is gated', () => del('/api/sessions/s1/messages/m3', EXT));
  add('external context-level is gated', () => get('/api/sessions/s1/context-level', EXT));
  // ── chat history reads ────────────────────────────────────────────────────
  add('history default page', () => get('/api/sessions/s1/history'));
  add('HEAD history', () => head('/api/sessions/s1/history'));
  add('history with a limit', () => get('/api/sessions/s1/history?limit=3'));
  add('history before a message', () => get('/api/sessions/s1/history?before=m8&limit=2'));
  add('history around a message', () => get('/api/sessions/s1/history?around=m6&limit=3'));
  add('history around an unknown message', () => get('/api/sessions/s1/history?around=zzz'));
  add('history archive scope', () => get('/api/sessions/s1/history?historyScope=archive&limit=20'));
  add('history unknown scope', () => get('/api/sessions/s1/history?historyScope=other'));
  add('history with a bad limit', () => get('/api/sessions/s1/history?limit=abc'));
  add('history with a zero limit', () => get('/api/sessions/s1/history?limit=0'));
  add('history with a negative limit', () => get('/api/sessions/s1/history?limit=-4'));
  add('history with a repeated limit', () => get('/api/sessions/s1/history?limit=1&limit=2'));
  add('history with an empty limit', () => get('/api/sessions/s1/history?limit='));
  add('history of an empty session', () => get('/api/sessions/empty/history'));
  add('history of an unknown session', () => get('/api/sessions/ghost/history'));
  add('history of an internal slot', () => get('/api/sessions/internal1/history'));
  add('history with an encoded slash in the id', () => get('/api/sessions/a%2Fb/history'));
  add('history with a bad escape in the id', () => get('/api/sessions/%E0%A4%A/history'));
  add('history with a trailing slash', () => get('/api/sessions/s1/history/'));
  add('history with mixed case', () => get('/api/Sessions/s1/History'));
  add('history of an unreadable transcript', () => get('/api/sessions/bad/history'));
  // ── context level ─────────────────────────────────────────────────────────
  add('context-level of a claude session', () => get('/api/sessions/s1/context-level'));
  add('HEAD context-level', () => head('/api/sessions/s1/context-level'));
  add('context-level with a plan', () => get('/api/sessions/s1/context-level?plan=1'));
  add('context-level with a true plan', () => get('/api/sessions/s1/context-level?plan=true'));
  add('context-level with a false plan', () => get('/api/sessions/s1/context-level?plan=0'));
  add('context-level of a session without a transcript', () => get('/api/sessions/empty/context-level?plan=1'));
  add('context-level of a codex session', () => get('/api/sessions/s2/context-level'));
  add('context-level of an opencode session', () => get('/api/sessions/oc1/context-level'));
  add('context-level of an unknown session', () => get('/api/sessions/ghost/context-level'));
  add('context-level of an internal slot', () => get('/api/sessions/internal1/context-level'));
  add('context-level with a bad escape in the id', () => get('/api/sessions/%E0%A4%A/context-level'));
  // ── message delete (a real write) ─────────────────────────────────────────
  add('history before the delete', () => get('/api/sessions/s1/history?limit=20'));
  add('delete a message', () => del('/api/sessions/s1/messages/m12'));
  add('history after the delete', () => get('/api/sessions/s1/history?limit=20'));
  add('delete the same message again', () => del('/api/sessions/s1/messages/m12'));
  add('delete from an unknown session', () => del('/api/sessions/ghost/messages/m1'));
  add('delete from an internal slot', () => del('/api/sessions/internal1/messages/m1'));
  add('delete with a bad escape in the message id', () => del('/api/sessions/s1/messages/%E0%A4%A'));
  add('delete a message by an encoded id', () => del('/api/sessions/s1/messages/m%31%30'));
  add('delete an unknown message', () => del('/api/sessions/s1/messages/nope'));
  add('delete with a trailing slash', () => del('/api/sessions/s1/messages/m9/'));
  add('delete from an unreadable transcript', () => del('/api/sessions/bad/messages/m1'));
  add('delete by GET is not a route', () => get('/api/sessions/s1/messages/m1'));
  add('history after every delete', () => get('/api/sessions/s1/history?limit=20&historyScope=archive'));
  add('history by DELETE is not a route', () => del('/api/sessions/s1/history'));
  // ── the root ──────────────────────────────────────────────────────────────
  add('root redirects to air', () => get('/'));
  add('HEAD root', () => head('/'));
  add('root with the aux shorthand', () => get('/?id=__aux__'));
  add('root with an empty id', () => get('/?id='));
  add('root with an unrelated query', () => get('/?x=1'));
  add('root with a session id falls through', () => get('/?id=s1'));
  add('HEAD root with a session id falls through', () => head('/?id=s1'));
  add('root with a new id falls through', () => get('/?newid=abc'));
  add('root with a cwd falls through', () => get('/?cwd=%2Ftmp'));
  add('root with a repeated id falls through', () => get('/?id=__aux__&id=x'));
  add('root with an array id falls through', () => get('/?id[]=a'));
  add('root with the aux shorthand and a cwd', () => get('/?id=__aux__&cwd=%2Ftmp'));
  add('external root redirects', () => get('/', EXT));
  // ── OPTIONS ───────────────────────────────────────────────────────────────
  for (const [name, url] of [
    ['apk-info', '/api/apk-info'], ['ios-ota-info', '/api/ios-ota-info'], ['manifest', '/ios-ota/manifest.plist'],
    ['profile', '/ios-ota/udid.mobileconfig'], ['result', '/ios-ota/udid/result/abc'],
    ['delete', '/api/sessions/s1/messages/m1'], ['history', '/api/sessions/s1/history'],
    ['context-level', '/api/sessions/s1/context-level'], ['apk download', '/multicc.apk'],
  ]) add(`OPTIONS ${name}`, () => options(url));
  add('OPTIONS history of an internal slot', () => options('/api/sessions/internal1/history'));
  add('OPTIONS delete of an internal slot', () => options('/api/sessions/internal1/messages/m1'));
  add('OPTIONS history with a bad escape', () => options('/api/sessions/%E0%A4%A/history'));
  // ── the one documented difference: the front door cannot reach its host ───
  const down = {
    node: view => view.status === 200,
    rust: view => view.status === 503 && view.body.includes('rust_backend_unavailable'),
  };
  add('apk-info with the host unreachable', () => get('/api/apk-info?down=1'), { expectedDifference: down });
  add('history with the host unreachable', () => get('/api/sessions/s1/history?down=1'), { expectedDifference: down });
  // ── last: fill the token table so the 429 branch is reached ───────────────
  add('profile once the token table is full', {}, {
    async send(side) {
      const { send } = require('./lib');
      let last = null;
      for (let index = 0; index < 200; index++) {
        last = await send(side.port, { method: 'GET', url: '/ios-ota/udid.mobileconfig', headers: HTTPS });
        if (last.status === 429) return last;
      }
      return last;
    },
  });
  return pending;
}

function normalizeView(view) {
  const next = { ...view, headers: { ...view.headers } };
  let scrubbed = false;
  for (const name of ['location']) {
    if (next.headers[name] !== undefined) {
      const text = scrub(next.headers[name]);
      scrubbed = scrubbed || text !== next.headers[name];
      next.headers[name] = text;
    }
  }
  if (/<HEX64>|<UUID>/.test(next.body)) scrubbed = true;
  // The ETag of a body that carried a random value keeps its length part.
  if (scrubbed && typeof next.headers.etag === 'string') {
    next.headers.etag = next.headers.etag.replace(/^(W\/"[0-9a-f]+-)[^"]+"$/, '$1<HASH>"');
  }
  return next;
}

// ── verdict ─────────────────────────────────────────────────────────────────

function treeOf(root) {
  const out = new Map();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch (_) { text = `<unreadable mode ${(fs.statSync(full).mode & 0o777).toString(8)}>`; }
        out.set(path.relative(root, full), text);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function finalize({ views, nodeData, gwData, work }) {
  const byName = new Map(views.map(view => [view.name, view]));
  fs.writeFileSync(path.join(work, 'views.json'), JSON.stringify(views, null, 2));
  const both = (name, fn) => {
    const view = byName.get(name);
    if (!view) { problems.push(`${name}: missing from the corpus`); return; }
    for (const side of ['node', 'rust']) fn(view[side], side, name);
  };
  const expect = (name, status, needle) => both(name, (answer, side) => {
    if (answer.status !== status) problems.push(`${name}: ${side} answered ${answer.status}, expected ${status} (${answer.body.slice(0, 160)})`);
    if (needle && !answer.body.includes(needle)) problems.push(`${name}: ${side} body lacks ${needle} (${answer.body.slice(0, 160)})`);
  });
  const header = (name, key, wanted) => both(name, (answer, side) => {
    const got = answer.headers[key];
    const ok = wanted instanceof RegExp ? wanted.test(got || '') : got === wanted;
    if (!ok) problems.push(`${name}: ${side} header ${key} is ${got}, expected ${wanted}`);
  });

  // A silently failing world would let both sides fail identically.
  for (const view of views) {
    for (const side of ['node', 'rust']) {
      if (/unexpected |is not a function|Cannot read|TypeError|ReferenceError|harness/.test(view[side].body)) {
        problems.push(`${view.name}: ${side} hit a harness error (${view[side].body.slice(0, 200)})`);
      }
    }
  }

  // The load-bearing answers, pinned so a world that failed the same way on
  // both sides cannot pass.
  expect('apk-info without a local file', 200, '"source":null');
  expect('apk-info with a local file', 200, '"source":"local"');
  expect('multicc.apk without a local file', 404);
  expect('multicc.apk with a local file is streamed', 200, 'APK-BYTES-0123456789');
  header('multicc.apk with a local file is streamed', 'content-disposition', 'attachment; filename="multicc.apk"');
  header('multicc.apk with a local file is streamed', 'cache-control', 'no-store, no-cache, must-revalidate');
  header('multicc.apk with a local file is streamed', 'accept-ranges', 'bytes');
  expect('HEAD multicc.apk with a local file', 200, '');
  expect('multicc.apk range', 206, 'K-BY');
  header('multicc.apk range', 'content-range', 'bytes 2-5/20');
  expect('multicc.apk multi range is a plain 200', 200, 'APK-BYTES-0123456789');
  expect('multicc.apk conditional', 304);
  expect('multicc.apk precondition failure', 412);
  expect('multicc.apk unsatisfiable range', 416);
  header('multicc.apk unsatisfiable range', 'content-range', 'bytes */20');
  expect('MULTICC.APK with a local file hits the binary guard', 404, '');
  header('MULTICC.APK with a local file hits the binary guard', 'cache-control', 'no-store');
  expect('HEAD MULTICC.APK with a local file hits the binary guard', 404, '');
  expect('multicc.apk with a trailing slash and a local file falls through', 599, 'forwarded:GET /multicc.apk/');
  expect('ios-ota-info without an ipa', 200, '"exists":false');
  expect('ios-ota-info with a full sidecar', 200, '"installable":true');
  expect('manifest without an ipa', 404);
  expect('manifest through https', 200, 'https://ota.example.com/multicc-ios.ipa');
  expect('manifest over plain http', 200, 'http://localhost/multicc-ios.ipa');
  expect('manifest with an unknown forwarded proto', 200, 'https://ota.example.com/multicc-ios.ipa');
  expect('profile over plain http', 400, 'HTTPS');
  expect('profile from a cross-site fetch', 403, 'Forbidden');
  expect('profile over https', 200, '/ios-ota/udid/callback/<HEX64>');
  expect('result with an unknown token', 410, '设备信息已过期');
  expect('callback with an unknown token', 410);
  expect('callback with a challenge mismatch', 400, '设备信息校验失败');
  expect('callback retried after the mismatch succeeds', 301);
  expect('callback replayed after success', 410);
  expect('result after a successful callback', 200, UDID);
  expect('callback with a pkcs7 content type and a 40-hex udid', 301);
  expect('result of the 40-hex udid', 200, OLD_UDID);
  expect('callback with a plain text content type', 301);
  expect('callback with an invalid udid', 400, '无法读取设备信息');
  expect('callback the verifier refuses', 400, '无法读取设备信息');
  expect('callback with openssl missing', 503, 'OpenSSL');
  expect('callback with an empty body', 400);
  expect('callback body with no framing at all', 400);
  expect('callback with a json body', 400);
  expect('callback with a malformed json body', 400, '"code":"request_error"');
  expect('callback with an oversize declared length', 413, '超过大小限制');
  expect('callback with an oversize chunked body', 413, '超过大小限制');
  expect('callback with an exactly-at-limit body', 400, '无法读取设备信息');
  expect('callback with a content encoding', 400, '设备信息格式无效');
  expect('callback with an identity content encoding', 301);
  expect('callback with a chunked body', 301);
  expect('profile once the token table is full', 429, '获取请求过多');
  expect('history default page', 200, '"hasMore":true');
  expect('history around a message', 200, '"found":true');
  expect('history around an unknown message', 200, '"found":false');
  expect('history of an unknown session', 404, '"error":"session not found"');
  expect('history with a bad escape in the id', 400, '"code":"request_error"');
  expect('history of an unreadable transcript', 500, 'internal_error');
  expect('context-level of a claude session', 200, '"cli":"claude"');
  expect('context-level with a plan', 200, '"plan"');
  expect('context-level of a codex session', 200, 'cli-not-claude');
  expect('context-level of an opencode session', 200, '"cli":"opencode"');
  expect('context-level of an unknown session', 404, '"error":"session not found"');
  expect('history before the delete', 200, '"id":"m12"');
  expect('delete a message', 200, '{"ok":true}');
  expect('delete the same message again', 200, '{"ok":true}');
  expect('delete from an unknown session', 404, 'session not found');
  expect('delete an unknown message', 404, 'message not found');
  expect('delete with a bad escape in the message id', 400, '"code":"request_error"');
  expect('delete a message by an encoded id', 200, '{"ok":true}');
  expect('delete from an unreadable transcript', 500, 'internal_error');
  expect('root redirects to air', 302);
  expect('root with the aux shorthand', 302);
  expect('root with a session id falls through', 599, 'forwarded:GET /?id=s1');

  // Delete side effect: the message left the page, the two history trees (the
  // transcript and its sidecars) are byte-identical and moved off the seed, and
  // both sides announced the same broadcasts.
  both('history after the delete', (answer, side) => {
    if (answer.body.includes('"id":"m12"')) problems.push(`delete: ${side} still lists m12 after deleting it`);
    if (!answer.body.includes('"id":"m11"')) problems.push(`delete: ${side} lost m11 with m12`);
  });
  // A delete is display-only: the archive scope still lists the message while
  // the default page does not.
  both('history after every delete', (answer, side) => {
    for (const kept of ['"id":"m12"', '"id":"m10"']) {
      if (!answer.body.includes(kept)) problems.push(`delete: ${side} archive lost ${kept} (a delete only hides it)`);
    }
  });
  both('history after the delete', (answer, side) => {
    if (!answer.body.includes('"id":"m10"')) problems.push(`delete: ${side} hid m10 before it was deleted`);
  });
  const historyRoot = rootDir => path.relative(rootDir, require(path.join(REPO(), 'src/paths')).createPaths({ dataDir: rootDir }).chatHistoryDir);
  const nodeTree = treeOf(path.join(nodeData, historyRoot(nodeData)));
  const rustTree = treeOf(path.join(gwData, historyRoot(gwData)));
  if (!nodeTree.size) problems.push('delete: the oracle history tree is empty');
  if (JSON.stringify([...nodeTree]) !== JSON.stringify([...rustTree])) {
    problems.push('delete: the two history trees differ after the corpus');
    for (const key of new Set([...nodeTree.keys(), ...rustTree.keys()])) {
      if (nodeTree.get(key) !== rustTree.get(key)) problems.push(`delete: ${key} differs (node ${String(nodeTree.get(key)).length} bytes, rust ${String(rustTree.get(key)).length} bytes)`);
    }
  }
  const changed = [...nodeTree].some(([key, text]) => initialHistory.get(key) !== text);
  if (!changed) problems.push('delete: the oracle history tree never moved off its seed, so the delete had no side effect to compare');
  const broadcasts = side => {
    try { return fs.readFileSync(path.join(work, `${side}-broadcast.jsonl`), 'utf8'); } catch (_) { return null; }
  };
  const nodeCasts = broadcasts('node');
  const rustCasts = broadcasts('rust');
  if (!nodeCasts || !nodeCasts.includes('"chat_msg_deleted"')) problems.push('delete: the oracle never broadcast chat_msg_deleted');
  if (nodeCasts !== rustCasts) problems.push(`delete: broadcasts differ: oracle ${nodeCasts} vs rust ${rustCasts}`);
  if (nodeCasts && (nodeCasts.match(/chat_msg_deleted/g) || []).length < 3) problems.push('delete: expected at least three chat_msg_deleted broadcasts');

  // The internal execution slot: the same 404 as a missing session, before the handler and before OPTIONS.
  for (const name of ['history of an internal slot', 'context-level of an internal slot', 'delete from an internal slot',
    'OPTIONS history of an internal slot', 'OPTIONS delete of an internal slot']) {
    expect(name, 404, '{"error":"session not found"}');
  }

  // The binary-ish response headers (not plain JSON).
  header('profile over https', 'content-type', 'application/x-apple-aspen-config; charset=utf-8');
  header('profile over https', 'content-disposition', 'attachment; filename="multicc-udid.mobileconfig"');
  header('profile over https', 'cache-control', 'no-store');
  header('manifest through https', 'content-type', 'text/xml; charset=utf-8');
  header('manifest through https', 'cache-control', 'no-store, no-cache, must-revalidate');
  header('result after a successful callback', 'content-type', 'text/html; charset=utf-8');
  header('callback retried after the mismatch succeeds', 'location', 'https://ota.example.com/ios-ota/udid/result/<HEX64>');
  for (const name of ['callback retried after the mismatch succeeds']) {
    both(name, (answer, side) => {
      if (answer.body !== '') problems.push(`${name}: ${side} 301 is not bodyless (${answer.body.slice(0, 80)})`);
      if (answer.headers['content-type'] !== undefined) problems.push(`${name}: ${side} 301 carries a content-type`);
    });
  }

  // Authentication exemptions: public routes answer their own status; gated
  // ones are refused before any handler.
  const gated = status => status === 401 || status === 403 || status === 302;
  for (const [name, status] of [
    ['external manifest is public', 200], ['external result is public', 410],
    ['external callback with the apple type is public', 410], ['external callback with the pkcs7 type is public', 410],
    ['external root redirects', 302],
  ]) expect(name, status);
  for (const name of ['external apk-info is gated', 'external ios-ota-info is gated', 'external profile is gated',
    'external callback with another type is gated', 'external history is gated', 'external delete is gated',
    'external context-level is gated']) {
    both(name, (answer, side) => {
      if (!gated(answer.status)) problems.push(`${name}: ${side} answered ${answer.status}, expected the login gate`);
      if (answer.status === 410) problems.push(`${name}: ${side} reached the handler`);
    });
  }

  // rawBody: the buffer, error (413 and 400), none and parsed states each hit a distinct answer.
  for (const name of ['callback with an oversize declared length', 'callback with an oversize chunked body']) expect(name, 413);
  for (const name of ['callback with a content encoding', 'callback with a malformed json body',
    'callback body with no framing at all', 'callback with a json body', 'callback with an empty body']) expect(name, 400);

  // HEAD: a body-less 200 on every read route that has one.
  for (const name of ['HEAD apk-info', 'HEAD ios-ota-info', 'HEAD manifest', 'HEAD history', 'HEAD context-level', 'HEAD root']) {
    expect(name, name === 'HEAD root' ? 302 : 200);
    both(name, (answer, side) => {
      if (answer.body !== '') problems.push(`${name}: ${side} answered a body to HEAD`);
    });
  }
  expect('HEAD profile', 200);
  expect('HEAD result with an unknown token', 410);
  expect('HEAD result after a successful callback', 200);
  expect('HEAD root with a session id falls through', 599);

  // Express's automatic OPTIONS answers.
  for (const [name, allow] of [
    ['OPTIONS apk-info', 'GET,HEAD'], ['OPTIONS ios-ota-info', 'GET,HEAD'], ['OPTIONS manifest', 'GET,HEAD'],
    ['OPTIONS profile', 'GET,HEAD'], ['OPTIONS result', 'GET,HEAD'], ['OPTIONS callback', 'POST'],
    ['OPTIONS delete', 'DELETE'], ['OPTIONS history', 'GET,HEAD'], ['OPTIONS context-level', 'GET,HEAD'],
  ]) {
    both(name, (answer, side) => {
      if (answer.status !== 200 || answer.headers.allow !== allow) problems.push(`${name}: ${side} answered ${answer.status} Allow ${answer.headers.allow}, expected ${allow}`);
    });
  }

  // The documented difference: only the Rust side may 503.
  for (const name of ['apk-info with the host unreachable', 'history with the host unreachable']) {
    const view = byName.get(name);
    if (!view || view.node.status !== 200 || view.rust.status !== 503 || !view.rust.body.includes('rust_backend_unavailable')) {
      problems.push(`coverage: the 503 branch (${name}) was not exercised`);
    }
  }

  // Coverage: the GET / forms.
  const rootForms = [
    ['root redirects to air', /^\/air$/], ['root with the aux shorthand', /^\/air\?view=aux$/],
  ];
  for (const [name, wanted] of rootForms) header(name, 'location', wanted);
  const covered = views.filter(view => view.rust.status === 599 && /^forwarded:GET \/\?/.test(view.rust.body));
  if (covered.length < 5) problems.push(`coverage: only ${covered.length} root fall-through cases`);

  // Random-value hygiene: the profile bodies must have carried values to scrub.
  for (const name of ['profile over https', 'callback retried after the mismatch succeeds']) {
    both(name, (answer, side) => {
      if (!/<HEX64>/.test(answer.body) && !/<HEX64>/.test(answer.headers.location || '')) problems.push(`${name}: ${side} carried no random token to scrub`);
    });
  }
  both('profile over https', (answer, side) => {
    if (!answer.body.includes('<UUID>')) problems.push(`profile over https: ${side} PayloadUUID is not a v4 UUID`);
  });

  if (!problems.length) {
    console.log(`[release-history-routes] ${views.length} cases compared; history trees and ${(nodeCasts.match(/\n/g) || []).length} broadcasts identical; coverage guards hold`);
  }
  for (const problem of problems) console.log(`[release-history-routes] ${problem}`);
  if (problems.length) {
    const file = path.join(work, 'coverage-problems.json');
    fs.writeFileSync(file, JSON.stringify(problems, null, 2));
    return { ok: false, details: file };
  }
  return { ok: true, details: path.join(work, 'result.json') };
}

let REPO_PATH = '';
function REPO() { return REPO_PATH; }

function main() {
  const { main: runMain } = require('./lib');
  const argv = process.argv.slice(2);
  REPO_PATH = path.resolve(argv[0] || '.');
  const repo = REPO_PATH;
  runMain({
    name: 'release-history-routes',
    seed(dir) {
      // The conversation-history trees of both sides start from the same bytes;
      // HOME moves into the work dir so the transcript reader never sees (or
      // writes) the real ~/.claude.
      const work = path.dirname(dir);
      process.env.HOME = path.join(work, 'home');
      const history = historyRepository(repo, dir);
      history.write('s1', messages());
      fs.mkdirSync(path.dirname(history.fileFor('bad')), { recursive: true });
      // A display-state path that is a directory: reading or writing the
      // visibility sidecar fails, and the old handlers answered through
      // next(error) -> safeErrorHandler.
      history.write('bad', messages().slice(0, 2));
      fs.mkdirSync(history.visibilityFileFor('bad'), { recursive: true });
      const proj = projectDir(work);
      fs.mkdirSync(proj, { recursive: true });
      const { claudeProjectDir } = require(path.join(repo, 'tests/helpers/frozen-file-batch8/transcript-prune'));
      const transcriptDir = claudeProjectDir(proj);
      fs.mkdirSync(transcriptDir, { recursive: true });
      const lines = Array.from({ length: 6 }, (_, index) => JSON.stringify(index % 2 === 0
        ? { type: 'user', uuid: `u${index}`, message: { role: 'user', content: `question ${index}` } }
        : { type: 'assistant', uuid: `a${index}`, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${index}` }], usage: { input_tokens: 100 + index, output_tokens: 20 } } }));
      fs.writeFileSync(path.join(transcriptDir, 'cli-s1.jsonl'), `${lines.join('\n')}\n`);
      if (!initialHistory.size) initialHistory = treeOf(path.join(dir, path.relative(dir, history.root)));
    },
    mount(app, { repo: repoPath, work, dataRoot, express }) {
      workPath = work;
      nodeRoot = path.join(work, 'node-root');
      gwRoot = path.join(work, 'gw');
      ensureRoot(nodeRoot);
      ensureRoot(gwRoot);
      const R = rel => require(path.join(repoPath, rel));
      const legacy = R('tests/helpers/legacy-release-history-routes');
      const system = R('tests/helpers/frozen-file-batch17/system');
      const world = buildWorld({
        repo: repoPath, dataRoot, rootDir: nodeRoot, work, side: 'node',
        createChatHistoryRuntime: legacy.chatHistory().createChatHistoryRuntime,
        createIosUdid: legacy.iosUdid().createIosUdid,
      });
      const { createPublicSessionAccessGuard } = R('tests/helpers/legacy-public-session-access');
      // server.js mounts the public-session guard long before express.json.
      app.use('/api/sessions/:id', createPublicSessionAccessGuard({ records: world.persistedSessions }));
      // The frozen mountSystemRoutes builds its own createIosUdid() (the real
      // openssl decoder), so the same four mounts are written out here in its
      // order, with the UDID runtime that carries the shared decode stand-in.
      const deps = { apkDistribution: world.apk, iosOta: world.ota };
      app.get('/api/apk-info', system.createApkInfoHandler(deps));
      app.get('/multicc.apk', world.apk.downloadHandler);
      app.get('/api/ios-ota-info', system.createIosOtaInfoHandler(deps));
      app.get('/ios-ota/manifest.plist', world.ota.manifestHandler);
      legacy.system(); // keep the frozen module loaded for its route handlers above
      world.udid.mountRoutes(app);
      world.chat.mountRoutes(app);
      // `GET /multicc.apk` with a usable local file was a `next()` into the
      // retired `express.static` mount, so the oracle has to carry that mount
      // for real; the front door serves the same file through
      // static_web_root.rs. `writeAsset` pins both sides' mtime, so the stat
      // ETag and Last-Modified are identical by construction. The redirect
      // families this module also registered are another cluster's differential
      // (static-assets-routes.js); only `GET /` is in scope here.
      const only = {
        get: (route, ...handlers) => { if (route === '/') app.get(route, ...handlers); },
        use: (...args) => app.use(...args),
      };
      legacy.staticAssets().createStaticAssetsRoutes({
        express, fs, path, publicDir: path.join(nodeRoot, 'public'),
      }).mountRoutes(only);
      app.use((req, res, next) => (req.method === 'OPTIONS' ? next() : res.status(599).send(`forwarded:${req.method} ${req.url}`)));
      upstreamText = upstream(repoPath, gwRoot, work);
    },
    get upstream() { return upstreamText; },
    gatewayEnv: () => ({
      MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
      MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    }),
    // `/healthz` is the gateway's own; the claimed routes here need the Node
    // child's host port, which comes up later. `/api/apk-info` is public,
    // read-only and host-backed, so it doubles as the readiness probe.
    async ready(port) {
      const { send } = require('./lib');
      for (let i = 0; i < 200; i++) {
        try {
          const res = await send(port, { method: 'GET', url: '/api/apk-info', headers: { Host: 'localhost' } }, 2_000);
          if (res.status !== 503) return;
        } catch (_) { /* the child is not listening yet */ }
        await new Promise(r => setTimeout(r, 25));
      }
      throw new Error('gateway host port did not come up');
    },
    normalize: scrub,
    normalizeView,
    // The streamed `/multicc.apk` lives on these.
    headers: ['accept-ranges', 'last-modified', 'content-range', 'pragma', 'expires'],
    corpus,
    finalize,
  });
}

module.exports = { buildWorld, decodeStub, scrub };
if (require.main === module) main();
