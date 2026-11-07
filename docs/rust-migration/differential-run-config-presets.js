'use strict';
// Differential test used to retire src/routes/run-config-presets.js: the
// original Node pipeline (request ids, JSON gzip, the real auth runtime,
// express.json, the deleted route, safeErrorHandler) and the Rust front door
// answer the same raw requests; status, body, ETag, headers and the final
// store file must match byte for byte. A template for the next route groups.
//
//   git show <rev-before-removal>:src/routes/run-config-presets.js \
//     | sed "s|require('\.\./|require('<repo>/src/|g" > /tmp/original-route.js
//   node docs/rust-migration/differential-run-config-presets.js \
//     <repo> <multicc-gateway> <addon that still has the route's napi exports> /tmp/original-route.js
const [repo, gatewayBin, addon, originalRoute] = process.argv.slice(2);
process.env.MULTICC_RUST_ADDON = addon;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');
const express = require(require.resolve('express', { paths: [repo] }));
const R = (p) => require(path.join(repo, p));
const { requestIdMiddleware, safeErrorHandler } = R('src/http-errors');
const { jsonCompression } = R('src/http/json-compression');
const { createAuthSecurity, normalizeRedirect, escapeHtmlAttribute } = R('src/auth-security');
const { isLocalRequest, isPrivateRequestPeer } = R('src/request-locality');
const { createErrorDto } = R('src/api-contract');
const { createAuthRuntime } = R('src/routes/auth');
const { mountRunConfigPresetsRoutes } = require(path.resolve(originalRoute));
const { getNative } = R('src/native/runtime');

const TOKEN = 'secret-token-1';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-diff-'));
const nodeData = path.join(work, 'node-data');
const gwDir = path.join(work, 'gw');
fs.mkdirSync(nodeData, { recursive: true });
fs.mkdirSync(gwDir, { recursive: true });

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  }
  return cookies;
}

function nodeApp() {
  const app = express();
  const authSecurity = createAuthSecurity({ getSecret: () => TOKEN });
  const quiet = { warn() {}, info() {}, error(a, b) {} };
  app.use(requestIdMiddleware, jsonCompression);
  const root = nodeData;
  createAuthRuntime({
    express, authSecurity, isLocalRequest,
    isRequestPeerAllowed: req => isPrivateRequestPeer(req), // lanOnly: token installed, no HOST
    parseCookies, normalizeRedirect, escapeHtmlAttribute,
    metrics: { inc() {} }, logger: quiet, createErrorDto,
    getAccessToken: () => TOKEN, getShuttingDown: () => false,
    authorizeScopedRequest: req => {
      const credential = req.headers['x-multicc-machine-grant'];
      if (!credential) return false;
      try { return !!getNative().authorizeMachineRequest(root, credential, req.method, req.originalUrl); }
      catch (_) { return false; }
    },
  }).mountRoutes(app);
  app.use(express.json({ limit: '50mb' }));
  mountRunConfigPresetsRoutes(app, { file: path.join(nodeData, 'run-config-presets.json') });
  app.use(safeErrorHandler({ error(a, b) {} }));
  return { app, authSecurity };
}

function send(port, { method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body != null) req.end(body); else req.end();
  });
}

const preset = (id, savedAt, extra = {}) => ({
  id, name: id, protocol: 'anthropic', savedAt,
  candidates: [{ providerId: 'a', model: 'm' }, { providerId: 'b', model: 'm' }], ...extra,
});
const J = (v) => JSON.stringify(v);

function corpus(cookie) {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const RH = { Host: 'box.example.com', 'X-Request-Id': 'diff-req-1' };
  const json = { 'Content-Type': 'application/json' };
  const many = Array.from({ length: 20 }, (_, i) => preset(`preset-${i}`, 100 + i));
  return [
    ['GET local empty', { method: 'GET', url: '/api/run-config/presets', headers: L }],
    ['GET remote no auth', { method: 'GET', url: '/api/run-config/presets', headers: RH }],
    ['GET remote html', { method: 'GET', url: '/api/run-config/presets?a=1&b=/c', headers: { ...RH, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } }],
    ['GET remote text/plain accept html', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, Accept: 'text/plain, text/html' } }],
    ['GET remote json accept with text/html', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, Accept: 'application/json, text/html;q=0' } }],
    ['GET remote token ok', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, 'X-Access-Token': TOKEN } }],
    ['GET remote token bad', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, 'X-Access-Token': 'nope' } }],
    ['GET remote cookie ok', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, Cookie: `a=1; multicc_auth=${cookie}` } }],
    ['GET remote cookie bad', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, Cookie: 'multicc_auth=x.y' } }],
    ['GET local forwarded', { method: 'GET', url: '/api/run-config/presets', headers: { ...L, 'X-Forwarded-For': '1.2.3.4' } }],
    ['GET local ts.net host', { method: 'GET', url: '/api/run-config/presets', headers: { Host: 'mac.tail1.ts.net', 'X-Request-Id': 'diff-req-1' } }],
    ['GET machine grant bogus + token', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, 'X-Access-Token': TOKEN, 'X-Multicc-Machine-Grant': 'mcg_' + 'a'.repeat(48) } }],
    ['GET no request id', { method: 'GET', url: '/api/run-config/presets', headers: { Host: 'localhost', 'X-Request-Id': 'bad id!', 'X-Correlation-Id': 'corr-1' } }],
    ['PUT text/plain', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'text/plain' }, body: '{}' }],
    ['PUT malformed', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '{"presets":' }],
    ['PUT json string', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '"text"' }],
    ['PUT empty body', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '' }],
    ['PUT {}', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '{}' }],
    ['PUT []', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '[]' }],
    ['PUT presets not array', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '{"presets":{}}' }],
    ['PUT 101', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: J({ presets: Array.from({ length: 101 }, (_, i) => preset(`p${i}`, i)) }) }],
    ['PUT mixed validity', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: J({ presets: [preset('ok', 5), { id: 'few', name: 'Few', protocol: 'anthropic', candidates: [{ providerId: 'p' }] }, preset('weird', 1e400 === Infinity ? 3 : 3, { extra: '\ud834' })] }).replace('"extra":"\\ud834"', '"extra":"\\ud834","n":1e400') }],
    ['GET after PUT', { method: 'GET', url: '/api/run-config/presets', headers: L }],
    ['GET trailing slash mixed case', { method: 'GET', url: '/api/Run-Config/Presets/', headers: L }],
    ['HEAD', { method: 'HEAD', url: '/api/run-config/presets', headers: L }],
    ['POST merge', { method: 'POST', url: '/api/run-config/presets/merge', headers: { ...L, ...json }, body: J({ presets: [preset('two', 9), preset('ok', 1)] }) }],
    ['POST merge gzip body', { method: 'POST', url: '/api/run-config/presets/merge', headers: { ...L, ...json, 'Content-Encoding': 'gzip' }, body: zlib.gzipSync(J({ presets: [preset('three', 10)] })) }],
    ['PUT 20 for gzip', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: J({ presets: many }) }],
    ['GET gzip', { method: 'GET', url: '/api/run-config/presets', headers: { ...L, 'Accept-Encoding': 'gzip, deflate' } }],
    ['GET x-gzip word', { method: 'GET', url: '/api/run-config/presets', headers: { ...L, 'Accept-Encoding': 'x-gzip' } }],
    ['OPTIONS presets', { method: 'OPTIONS', url: '/api/run-config/presets', headers: L }],
    ['OPTIONS merge', { method: 'OPTIONS', url: '/api/run-config/presets/merge', headers: L }],
    ['PUT utf-16 charset', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset=utf-16' }, body: '{}' }],
    ['PUT utf-16le valid', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset=UTF-16LE' }, body: Buffer.from(J({ presets: [preset('u16le', 30)] }), 'utf16le') }],
    ['PUT utf-16 BOM BE valid', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset="utf-16"' }, body: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(J({ presets: [preset('u16be', 31)] }), 'utf16le').swap16()]) }],
    ['PUT utf-16 no BOM heuristic LE', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset=utf-16' }, body: Buffer.from(J({ presets: [preset('u16auto', 32)] }), 'utf16le') }],
    ['GET after utf-16', { method: 'GET', url: '/api/run-config/presets', headers: L }],
    ['PUT latin1 charset', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset=latin1' }, body: '{}' }],
    ['PUT br encoding', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json, 'Content-Encoding': 'br' }, body: '{}' }],
  ];
}

const COMPARED = ['content-type', 'vary', 'location', 'allow', 'content-encoding', 'x-multicc-api-version', 'x-multicc-request-id', 'x-correlation-id', 'x-powered-by', 'cache-control'];

function view(res, withEtag) {
  let body = res.body;
  if (res.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
  let text = body.toString('utf8');
  // A generated request id is random on both sides.
  text = text.replace(/"requestId":"[0-9a-f]{8}","correlationId":"[0-9a-f]{8}"/, '"requestId":"<rand>","correlationId":"<rand>"');
  const headers = {};
  for (const name of COMPARED) {
    let v = res.headers[name];
    if (name === 'x-multicc-request-id' && /^[0-9a-f]{8}$/.test(v || '')) v = '<rand>';
    if (name === 'x-correlation-id' && /^[0-9a-f]{8}$/.test(v || '')) v = '<rand>';
    if (v !== undefined) headers[name] = v;
  }
  if (withEtag && res.headers.etag !== undefined) headers.etag = res.headers.etag;
  if (res.headers['content-length'] !== undefined && res.headers['content-encoding'] !== 'gzip') headers['content-length'] = res.headers['content-length'];
  return { status: res.status, headers, body: text };
}

async function waitFor(port) {
  for (let i = 0; i < 300; i++) {
    try { await send(port, { method: 'GET', url: '/healthz', headers: { Host: 'localhost' } }); return; }
    catch (_) { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('gateway did not come up');
}

(async () => {
  const { app, authSecurity } = nodeApp();
  const nodeServer = http.createServer(app);
  await new Promise(r => nodeServer.listen(0, '127.0.0.1', r));
  const nodePort = nodeServer.address().port;

  fs.writeFileSync(path.join(gwDir, 'server.js'),
    "require('http').createServer((q,s)=>{s.end('node')}).listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT),'127.0.0.1');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));");
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const gwPort = probe.address().port; await new Promise(r => probe.close(r));
  const gw = spawn(gatewayBin, ['serve', '--cwd', gwDir, '--node', process.execPath, 'server.js'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(gwPort), ACCESS_TOKEN: TOKEN },
    stdio: ['ignore', 'ignore', fs.openSync(path.join(work, 'gw.log'), 'w')],
  });
  try {
    await waitFor(gwPort);
    const cookie = authSecurity.createCookie();
    let same = 0; const diffs = [];
    for (const [name, req] of corpus(cookie)) {
      const a = view(await send(nodePort, req), true);
      const b = view(await send(gwPort, req), true);
      if (J(a) === J(b)) same++;
      else diffs.push({ name, node: a, rust: b });
    }
    // The two stores must end up byte-identical too.
    const fileA = fs.readFileSync(path.join(nodeData, 'run-config-presets.json'), 'utf8');
    const fileB = fs.readFileSync(path.join(gwDir, 'run-config-presets.json'), 'utf8');
    const modeA = fs.statSync(path.join(nodeData, 'run-config-presets.json')).mode & 0o777;
    const modeB = fs.statSync(path.join(gwDir, 'run-config-presets.json')).mode & 0o777;
    const result = { total: same + diffs.length, same, diffs, fileSame: fileA === fileB, modes: [modeA.toString(8), modeB.toString(8)] };
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(result, null, 2));
    for (const diff of diffs) console.log(JSON.stringify(diff));
    console.log(`same ${same}/${same + diffs.length}, store identical: ${fileA === fileB}, modes ${result.modes}`);
  } finally {
    gw.kill('SIGTERM');
    nodeServer.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
