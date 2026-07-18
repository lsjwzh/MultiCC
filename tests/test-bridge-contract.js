'use strict';
// Contract tests for the five IM bridges — verify that each adapter still
// exports the same public shape and REST-route inventory it always did.
//
// The bridge adapters can't be end-to-end tested without real SDK connections
// (Slack Socket Mode, Feishu ws long connection, Telegram polling, Discord
// gateway, WeChat iLink). What we CAN check deterministically:
//
//   • module.exports shape is exactly { router, init, loadConfig, startBridge, stopBridge }
//   • init() wires the shared plumbing without side-effects on unrelated bridges
//   • Router has all the routes server.js's manage UI hits: /status, /config,
//     /gateway (GET/PUT/DELETE), /gateway/reset, /start, /stop, /send, /log,
//     /events (+ WeChat: /qrcode, /login-status, /logout)
//   • Two independent bridges get two independent log stores, echo stores,
//     and gateway lifecycle bindings (i.e. no cross-talk via gateway-core).
//
// Everything else — the platform SDKs — is a mocked hole. If startBridge()
// errors on missing SDK config we treat that as "reached the SDK layer" and
// move on; that's the correct behaviour and confirms init() didn't accidentally
// commit a side effect.

const path = require('path');
const os = require('os');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}

const EXPECTED_MODULE_KEYS = ['router', 'init', 'loadConfig', 'startBridge', 'stopBridge'];
// (method, path) tuples that server.js's manage UI expects each bridge to
// serve. Paths listed here are relative to the bridge's mount point (e.g.
// /api/feishu), which is added by server.js. The router.stack objects hold
// them without the mount prefix, so we compare bare paths.
const COMMON_ROUTES = [
  ['GET', '/status'],
  ['GET', '/config'], ['POST', '/config'],
  ['GET', '/gateway'], ['PUT', '/gateway'], ['DELETE', '/gateway'],
  ['POST', '/gateway/reset'],
  ['POST', '/start'], ['POST', '/stop'],
  ['POST', '/send'],
  ['GET', '/log'], ['GET', '/events'],
];
const WECHAT_EXTRA_ROUTES = [
  ['GET', '/qrcode'], ['GET', '/login-status'], ['POST', '/logout'],
];

function collectRoutes(router) {
  const out = [];
  for (const layer of (router?.stack || [])) {
    if (!layer?.route) continue;
    const path = layer.route.path;
    for (const method of Object.keys(layer.route.methods || {})) {
      out.push([method.toUpperCase(), path]);
    }
  }
  return out;
}

function containsAll(actual, expected) {
  const set = new Set(actual.map(([m, p]) => `${m} ${p}`));
  for (const [m, p] of expected) if (!set.has(`${m} ${p}`)) return `${m} ${p}`;
  return null;
}

// The five adapters, tagged with their extra routes. Anywhere we say "5" in
// the report, count these entries.
const bridges = [
  { name: 'discord', path: '../plugins/bridges/discord-bridge', extras: [] },
  { name: 'feishu', path: '../plugins/bridges/feishu-bridge', extras: [] },
  { name: 'slack', path: '../plugins/bridges/slack-bridge', extras: [] },
  { name: 'telegram', path: '../plugins/bridges/telegram-bridge', extras: [] },
  { name: 'wechat', path: '../plugins/bridges/wechat-ilink', extras: WECHAT_EXTRA_ROUTES },
];

// Point every bridge at a hermetic data dir BEFORE requiring any of them —
// secure-config reads MULTICC_DATA_DIR at module load time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-contract-'));
process.env.MULTICC_DATA_DIR = tmp;

// Preload the bridges so require caches are fresh with the tmp config dir.
const modules = bridges.map(b => require(b.path));

// ── 1. Public module shape ────────────────────────────────────────────
for (let i = 0; i < bridges.length; i++) {
  const mod = modules[i];
  const missing = EXPECTED_MODULE_KEYS.find(k => typeof mod[k] === 'undefined');
  ok(!missing, `${bridges[i].name}: exports include ${EXPECTED_MODULE_KEYS.join(', ')}`);
  ok(typeof mod.router === 'function' || typeof mod.router?.use === 'function',
    `${bridges[i].name}: router is an Express router`);
}

// ── 2. Route inventory ────────────────────────────────────────────────
for (let i = 0; i < bridges.length; i++) {
  const mod = modules[i];
  const routes = collectRoutes(mod.router);
  const missing = containsAll(routes, [...COMMON_ROUTES, ...bridges[i].extras]);
  ok(!missing, `${bridges[i].name}: exposes ${COMMON_ROUTES.length + bridges[i].extras.length} required routes` + (missing ? ` (missing ${missing})` : ''));
}

// ── 3. init() wiring is side-effect-free across bridges ───────────────
// After init() each bridge should have its own log store; pushing to bridge A
// must not surface on bridge B's /log. We drive that through the shared
// gateway-core APIs via the adapters' public /log JSON endpoint.
const persistedSessions = new Map();
const chatSessions = new Map();
const persisted = [];
const savePersistedSessions = () => { persisted.push('save'); };

// Two bridges, side-by-side. Use feishu + slack: two ends of the space.
modules[1].init({ persistedSessions, chatSessions, savePersistedSessions, chatBroadcast: () => {}, port: 4001 });
modules[2].init({ persistedSessions, chatSessions, savePersistedSessions, chatBroadcast: () => {}, port: 4002 });

// The gateway record lives in the shared persistedSessions Map, keyed by the
// adapter's own session id. Creating a Feishu gateway must NOT also create a
// Slack gateway.
try {
  const putReq = { body: { cli: 'claude' }, query: {}, params: {} };
  const feishuPut = pickHandler(modules[1].router, 'PUT', '/gateway');
  const slackGet = pickHandler(modules[2].router, 'GET', '/gateway');

  const feishuRes = fakeRes();
  feishuPut(putReq, feishuRes);
  const feishuBody = feishuRes.body;
  ok(feishuBody && feishuBody.id === '__feishu_gateway__' && feishuBody.cli === 'claude',
    'init isolation: PUT /gateway on Feishu creates __feishu_gateway__ record');

  const slackRes = fakeRes();
  slackGet({ params: {}, query: {} }, slackRes);
  ok(slackRes.body === null, 'init isolation: Slack /gateway is still null after Feishu created its gateway');

  // Cleanup so the Map doesn't leak to later tests.
  const feishuDel = pickHandler(modules[1].router, 'DELETE', '/gateway');
  const delRes = fakeRes();
  feishuDel({ params: {}, query: {} }, delRes);
  ok(!persistedSessions.has('__feishu_gateway__'), 'init isolation: DELETE /gateway removes record');
} catch (e) {
  console.error('gateway isolation error:', e);
  fail++;
}

// ── 4. Log stores are per-bridge ──────────────────────────────────────
try {
  // Feishu log carries the "Feishu gateway created" + "Feishu gateway
  // destroyed" entries from the previous isolation section — those events
  // proved log() is bridge-local. Snapshot the current lengths as the
  // baseline; the next PUT will grow feishu only.
  const feishuLogHandler = pickHandler(modules[1].router, 'GET', '/log');
  const slackLogHandler = pickHandler(modules[2].router, 'GET', '/log');
  let r = fakeRes(); feishuLogHandler({ query: {} }, r);
  const feishuBaseline = r.body.length;
  r = fakeRes(); slackLogHandler({ query: {} }, r);
  const slackBaseline = r.body.length;
  ok(slackBaseline === 0, 'log isolation: slack log initially empty');

  // Drive a successful PUT that DOES log ("Feishu gateway created").
  const putReq = { body: { cli: 'claude' }, query: {}, params: {} };
  pickHandler(modules[1].router, 'PUT', '/gateway')(putReq, fakeRes());
  r = fakeRes(); feishuLogHandler({ query: {} }, r);
  ok(r.body.length > feishuBaseline && r.body[r.body.length - 1].text.includes('Feishu'),
    'log isolation: feishu logs its own events');
  r = fakeRes(); slackLogHandler({ query: {} }, r);
  ok(r.body.length === slackBaseline, 'log isolation: slack still empty after feishu event');
  ok(feishuBaseline >= 0, 'log isolation: baseline captured (sanity)');

  // Cleanup
  pickHandler(modules[1].router, 'DELETE', '/gateway')({ params: {}, query: {} }, fakeRes());
} catch (e) {
  console.error('log isolation error:', e);
  fail++;
}

// ── 5. loadConfig returns a fresh object (no shared reference) ───────
for (let i = 0; i < bridges.length; i++) {
  const a = modules[i].loadConfig();
  const b = modules[i].loadConfig();
  ok(a && b && a !== b, `${bridges[i].name}: loadConfig() returns a fresh object each call`);
}

// ── 6. startBridge() rejects when SDK config is absent ────────────────
// This proves the adapter reaches its own preflight checks (rather than
// hanging or corrupting persistedSessions). We drive each bridge with its
// current config file (which is empty in the tmp dir) and expect a rejection.
(async () => {
  for (let i = 0; i < bridges.length; i++) {
    let msg;
    try { await modules[i].startBridge(); msg = null; }
    catch (e) { msg = e.message; }
    ok(!!msg, `${bridges[i].name}: startBridge() with no config rejects (${(msg || '').slice(0, 60)}${msg ? '…' : ''})`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n== bridge contract: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// ── helpers ───────────────────────────────────────────────────────────
function pickHandler(router, method, path) {
  for (const layer of (router?.stack || [])) {
    if (!layer?.route) continue;
    if (layer.route.path !== path) continue;
    if (!(layer.route.methods && layer.route.methods[method.toLowerCase()])) continue;
    // The last stack entry in each route is the handler we want.
    const stack = layer.route.stack || [];
    return stack[stack.length - 1].handle;
  }
  throw new Error(`route not found: ${method} ${path}`);
}

function fakeRes() {
  return {
    body: null,
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    flushHeaders() {},
    write() {},
    end() {},
    locals: {},
  };
}
