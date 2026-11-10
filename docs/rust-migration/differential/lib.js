'use strict';
// Shared harness for retiring a Node route group into the Rust front door
// (docs/gateway.md §9). It builds the original Node pipeline around the
// group's (deleted) route code — request ids, /api JSON gzip, the real auth
// runtime, express.json, the route, safeErrorHandler — starts the release
// multicc-gateway next to it, sends both the same raw requests and compares
// status, body, ETag, content length and the listed headers, then the store
// files each side wrote.
//
// A group script supplies: mount(app, ctx), corpus(ctx), stores and
// optionally seed(dataRoot), auth(repo) (the auth modules as they were before
// the removal), gatewayEnv(work) and normalize(text, work).
// A corpus entry is [name, request | (side) => request, hooks?]: `side` is
// { name: 'node' | 'rust', state } so a request can use a value one side
// handed out (a ticket); hooks.capture(response, side) stores such values and
// hooks.normalize(view, side) blanks per-side randomness before comparing;
// hooks.before(side) runs just before that side's request (re-seeding state).
// See run-config-presets.js and download-link.js next to this file.
//
// Every request has a deadline and the whole run has a watchdog, so a stuck
// exchange fails with the step name instead of hanging; the gateway is always
// killed on exit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

const TOKEN = 'secret-token-1';
const REQUEST_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = Number(process.env.DIFF_RUN_TIMEOUT_MS) || 180_000;

const COMPARED = ['content-type', 'vary', 'location', 'allow', 'content-encoding',
  'x-multicc-api-version', 'x-multicc-request-id', 'x-correlation-id', 'x-powered-by',
  'cache-control', 'content-disposition'];

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  }
  return cookies;
}

/** One raw exchange; settles exactly once, whatever the socket does. */
function send(port, { method, url, headers = {}, body }, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('aborted', () => done(reject, new Error('response aborted')));
      res.on('error', error => done(reject, error));
      res.on('close', () => done(reject, new Error('response closed before end')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs}ms`)));
    req.on('error', error => done(reject, error));
    if (body != null) req.end(body); else req.end();
  });
}

function view(res) {
  let body = res.body;
  if (res.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
  // A generated request id is random on both sides.
  const text = body.toString('utf8')
    .replace(/"requestId":"[0-9a-f]{8}","correlationId":"[0-9a-f]{8}"/, '"requestId":"<rand>","correlationId":"<rand>"');
  const headers = {};
  for (const name of COMPARED) {
    let v = res.headers[name];
    if ((name === 'x-multicc-request-id' || name === 'x-correlation-id') && /^[0-9a-f]{8}$/.test(v || '')) v = '<rand>';
    if (v !== undefined) headers[name] = v;
  }
  if (res.headers.etag !== undefined) headers.etag = res.headers.etag;
  if (res.headers['content-length'] !== undefined && res.headers['content-encoding'] !== 'gzip') {
    headers['content-length'] = res.headers['content-length'];
  }
  return { status: res.status, headers, body: text };
}

function nodePipeline(repo, dataRoot, spec, ctx) {
  const { mount } = spec;
  const express = require(require.resolve('express', { paths: [repo] }));
  const R = p => require(path.join(repo, p));
  const { requestIdMiddleware, safeErrorHandler } = R('src/http-errors');
  const { jsonCompression } = R('src/http/json-compression');
  const legacy = spec.auth ? spec.auth(repo) : {};
  const { normalizeRedirect, escapeHtmlAttribute } = R('src/auth-security');
  const createAuthSecurity = legacy.createAuthSecurity || R('src/auth-security').createAuthSecurity;
  const { isLocalRequest, isPrivateRequestPeer } = R('src/request-locality');
  const { createErrorDto } = R('src/api-contract');
  const createAuthRuntime = legacy.createAuthRuntime || R('src/routes/auth').createAuthRuntime;
  const { getNative } = R('src/native/runtime');
  const app = express();
  const authSecurity = createAuthSecurity({ getSecret: () => TOKEN });
  const quiet = { warn() {}, info() {}, error() {} };
  app.use(requestIdMiddleware, jsonCompression);
  createAuthRuntime({
    express, authSecurity, isLocalRequest,
    // lanOnly: a token is installed and no HOST is configured.
    isRequestPeerAllowed: req => isPrivateRequestPeer(req),
    parseCookies, normalizeRedirect, escapeHtmlAttribute,
    metrics: { inc() {} }, logger: quiet, createErrorDto,
    getAccessToken: () => TOKEN, getShuttingDown: () => false,
    authorizeScopedRequest: (req) => {
      const credential = req.headers['x-multicc-machine-grant'];
      if (!credential) return false;
      try { return !!getNative().authorizeMachineRequest(dataRoot, credential, req.method, req.originalUrl); }
      catch (_) { return false; }
    },
  }).mountRoutes(app);
  app.use(express.json({ limit: '50mb' }));
  mount(app, { ...ctx, dataRoot, express });
  app.use(safeErrorHandler(quiet));
  return { app, authSecurity };
}

async function waitFor(port) {
  for (let i = 0; i < 300; i++) {
    try { await send(port, { method: 'GET', url: '/healthz', headers: { Host: 'localhost' } }, 2_000); return; }
    catch (_) { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('gateway did not come up');
}

async function freePort() {
  const probe = http.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise(r => probe.close(r));
  return port;
}

/**
 * spec: { name, mount(app, ctx), corpus(ctx) -> [[name, request]], stores: [relative file],
 *         seed?(dataRoot), gatewayEnv?: {} }
 * argv: <repo> <multicc-gateway> <addon with the route's napi exports, if any>
 */
async function run(spec, argv = process.argv.slice(2)) {
  const [repoArg, gatewayBin, addon] = argv;
  if (!repoArg || !gatewayBin) throw new Error('usage: <repo> <multicc-gateway> [addon]');
  const repo = path.resolve(repoArg);
  if (addon) process.env.MULTICC_RUST_ADDON = path.resolve(addon);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `${spec.name}-diff-`));
  const nodeData = path.join(work, 'node-data');
  const gwData = path.join(work, 'gw-data');
  const gwDir = path.join(work, 'gw');
  for (const dir of [nodeData, gwData, gwDir]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [nodeData, gwData]) if (spec.seed) spec.seed(dir);

  let step = 'start';
  let gw = null;
  const killGateway = () => { if (gw && gw.exitCode === null && gw.signalCode === null) gw.kill('SIGKILL'); };
  process.on('exit', killGateway);
  const watchdog = setTimeout(() => {
    console.error(`[${spec.name}] watchdog: no result after ${RUN_TIMEOUT_MS}ms, stuck at: ${step}`);
    killGateway();
    process.exit(2);
  }, RUN_TIMEOUT_MS);

  const ctx = { token: TOKEN, repo, work };
  const { app, authSecurity } = nodePipeline(repo, nodeData, spec, ctx);
  const nodeServer = http.createServer(app);
  await new Promise(r => nodeServer.listen(0, '127.0.0.1', r));
  const nodePort = nodeServer.address().port;

  // The gateway's Node child is a stub: every request in the corpus must be
  // answered by Rust; a forwarded one shows up as the stub's answer. A spec
  // that compares forwarding itself supplies its own script (it has to parse
  // the PROXY v1 line, like the real child).
  fs.writeFileSync(path.join(gwDir, 'server.js'), spec.upstream || (
    "require('http').createServer((q,s)=>{s.end('forwarded')}).listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT),'127.0.0.1');"
    + "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"));
  const gwPort = await freePort();
  gw = spawn(gatewayBin, ['serve', '--cwd', gwDir, '--node', process.execPath, 'server.js'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(gwPort), ACCESS_TOKEN: TOKEN,
      MULTICC_DATA_DIR: gwData,
      ...(typeof spec.gatewayEnv === 'function' ? spec.gatewayEnv(work) : spec.gatewayEnv || {}) },
    stdio: ['ignore', 'ignore', fs.openSync(path.join(work, 'gw.log'), 'w')],
  });
  try {
    step = 'waiting for the gateway';
    await waitFor(gwPort);
    ctx.cookie = authSecurity.createCookie();
    let same = 0;
    const diffs = [];
    const views = [];
    const sides = { node: { name: 'node', state: {}, port: nodePort }, rust: { name: 'rust', state: {}, port: gwPort } };
    const normalizeText = spec.normalize || (text => text);
    for (const [name, request, hooks = {}] of spec.corpus(ctx)) {
      const seen = {};
      for (const side of [sides.node, sides.rust]) {
        step = `${side.name}: ${name}`;
        // A hook may seed state through the async native kernels (one group
        // migrates a route whose store is written by the Rust addon).
        if (hooks.before) await hooks.before(side);
        let raw;
        try {
          raw = await send(side.port, typeof request === 'function' ? request(side) : request);
        } catch (error) {
          throw new Error(`${step}: ${error.message}`);
        }
        if (hooks.capture) hooks.capture(raw, side);
        let v = view(raw);
        v.body = normalizeText(v.body, work);
        if (hooks.normalize) v = hooks.normalize(v, side) || v;
        seen[side.name] = v;
      }
      if (JSON.stringify(seen.node) === JSON.stringify(seen.rust)) same++;
      else diffs.push({ name, node: seen.node, rust: seen.rust });
      views.push({ name, node: seen.node, rust: seen.rust });
    }
    step = 'comparing stores';
    const stores = (spec.stores || []).map((file) => {
      const read = root => {
        const full = path.join(root, file);
        if (!fs.existsSync(full)) return { exists: false };
        return { exists: true, mode: (fs.statSync(full).mode & 0o777).toString(8), text: fs.readFileSync(full, 'utf8') };
      };
      const a = read(nodeData);
      const b = read(gwData);
      return { file, same: JSON.stringify(a) === JSON.stringify(b), node: a, rust: b };
    });
    // A group with a binary store (SQLite) or a baseline dump diffs it itself
    // and returns { ok, details }; it may also mute store entries it already
    // folded into its own comparison by returning same:true.
    const extra = typeof spec.finalize === 'function'
      ? await spec.finalize({ views, nodeData, gwData, work, sides })
      : null;
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify({ same, diffs, stores, extra }, null, 2));
    for (const diff of diffs) console.log(JSON.stringify(diff));
    for (const store of stores.filter(s => !s.same)) console.log(JSON.stringify(store));
    const storeText = stores.map(s => `${s.file}: ${s.same ? `identical (mode ${s.node.mode || 'absent'})` : 'DIFFERENT'}`).join(', ');
    console.log(`[${spec.name}] same ${same}/${same + diffs.length}; ${storeText || 'no stores'}; details ${work}/result.json`);
    return diffs.length === 0 && stores.every(s => s.same) && (!extra || extra.ok !== false);
  } finally {
    clearTimeout(watchdog);
    killGateway();
    nodeServer.closeAllConnections?.();
    nodeServer.close();
  }
}

/**
 * Loads a route module as it was at `rev` (the parent of the commit that
 * deleted it), with its relative requires pointed at the current tree.
 */
function loadDeleted(repo, rev, file) {
  const source = execFileSync('git', ['-C', repo, 'show', `${rev}:${file}`], { encoding: 'utf8' });
  const dir = path.join(repo, path.dirname(file));
  const rewritten = source.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_, __, rel) => `require(${JSON.stringify(path.resolve(dir, rel))})`);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-route-')), path.basename(file));
  fs.writeFileSync(out, rewritten);
  return require(out);
}

function main(spec) {
  run(spec).then(ok => { process.exitCode = ok ? 0 : 1; }, (error) => { console.error(error); process.exit(1); });
}

module.exports = { run, main, loadDeleted, send, view, TOKEN };
