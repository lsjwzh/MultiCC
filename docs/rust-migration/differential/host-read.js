'use strict';
// Differential run for the ten read-only host routes retired from
// src/routes/host-read.js:
//
//   GET|HEAD|OPTIONS /api/push/vapid-key
//   GET|HEAD|OPTIONS /api/push/health
//   GET|HEAD|OPTIONS /api/settings/notify
//   GET|HEAD|OPTIONS /api/settings/tunnel
//   GET|HEAD|OPTIONS /api/tunnel/funnel
//   GET|HEAD|OPTIONS /api/tunnel/ipv6
//   GET|HEAD|OPTIONS /api/tunnel/sakurafrp
//   GET|HEAD|OPTIONS /api/settings/access-token
//   GET|HEAD|OPTIONS /api/settings/power
//   GET|HEAD|OPTIONS /api/host/battery
//
// now answered by native/gateway/src/app/host_read.rs.
//
//   node docs/rust-migration/differential/host-read.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-host-read-routes.js) with an in-process scripted deps
// object. The Rust front door asks its host port (/api/__host/host-read); the
// stub Node child here answers from the same JSON scenario (written to
// work/host-read-script.json before each case), so both sides read one world.
//
// Determinism: the scripted push Maps, tunnel clients, macOS power service and
// battery probe never touch the network, a real CLI or /usr/bin/pmset. The
// power op is the one place an answer still depends on the request: Rust sends
// the locality decision it made (`canEdit`) to the host port, the oracle calls
// the real isLocalRequest(req) from src/request-locality, so a byte-identical
// power body proves the two locality decisions agree.
//
// Route-table note for OPTIONS: in production the five paths
// /api/settings/notify, /api/settings/tunnel, /api/tunnel/funnel,
// /api/settings/access-token and /api/settings/power also carry POST handlers
// (src/routes/host-write.js and src/routes/host-power.js), so Express answers
// their automatic OPTIONS with GET,HEAD,POST; the other five answer GET,HEAD.
// The oracle only mounts the frozen read module, so this script registers a
// pass-through POST on exactly those five paths. The pass-through calls next(),
// which keeps POST itself a 404 in the oracle (the real POST route is not
// mounted) while making the automatic OPTIONS Allow list match the production
// composition and the front door. That 404 is the documented POST difference
// below.
//
// Documented differences, registered apart from the byte-for-byte cases:
//   * `GET /API/...` (uppercase prefix): Express routing is case-insensitive so
//     the oracle answers 200, the front door only claims an exact `/api/`
//     prefix and forwards the request.
//   * any method other than GET/HEAD/OPTIONS on a claimed path: the oracle
//     answers Express's 404 (its POST route is deliberately not mounted), the
//     front door forwards.
//   * an extra path segment: oracle 404, front door forwards.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const HOST_PATH = '/api/__host/host-read';

// The five paths whose production route table also registers POST.
const POST_PATHS = [
  '/api/settings/notify',
  '/api/settings/tunnel',
  '/api/tunnel/funnel',
  '/api/settings/access-token',
  '/api/settings/power',
];

let scriptPath = '';
let legacy = null;
let deps = null;
let realIsLocalRequest = null;
let currentScenario = null;
let upstreamText = '';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── the scripted world ──────────────────────────────────────────────────────

function baseWorld() {
  return {
    vapidKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    token: '0123456789',
    push: {
      // Second endpoint is deliberately 12 digits tall: its fingerprint must be
      // the sha256 of the exact string, never a number round-trip.
      endpoints: [
        'https://push.example.com/device/123456789012',
        'https://push.example.com/device/alpha',
      ],
      // One classified failure (HTTP status) and one timeout; the first entry
      // also proves a negative counter is zeroed.
      health: [
        {
          successCount: 12,
          failCount: 3,
          lastSuccessTime: 1700000000000,
          lastFailTime: -5,
          lastFailReason: 'HTTP status: 404',
          consecutiveFails: 2,
        },
        {
          successCount: 2,
          failCount: 5,
          lastSuccessTime: 1700000000000,
          lastFailTime: 1700000001000,
          lastFailReason: 'request timed out',
          consecutiveFails: 5,
        },
      ],
      globalStats: {
        totalSent: 19,
        totalSuccess: 14,
        totalFail: 5,
        lastPushTime: 1700000001000,
        lastPushType: ' waiting ',
      },
      barkUrl: '',
      webhookUrl: '',
      hasBark: false,
      barkHealth: { lastSendTime: 0, lastSuccess: false, lastError: '' },
      webhookHealth: { lastSendTime: 0, lastSuccess: false, lastError: 'HTTP 503' },
      barkDevices: null,
    },
    // The tunnel bodies are >1024 bytes so the two gzip cases really compress.
    tunnel: {
      status: {
        provider: 'cloudflare',
        running: true,
        publicUrl: 'https://tunnel.example.com',
        note: 'x'.repeat(1400),
      },
      funnel: {
        active: true,
        url: 'https://funnel.example.com',
        note: 'y'.repeat(1400),
      },
      ipv6: { enabled: true, address: '2001:db8::1', supports: true },
      sakura: { ok: true, tunnels: [{ id: 1, name: 'tokyo', type: 'https' }], user: { name: 'ops' } },
    },
    power: {
      available: true,
      lidMode: { enabled: true, source: 'pmset', lidSleep: 'on' },
      unlock: { available: true, hasPassword: true },
      preferences: true,
      authorization: { state: 'authorized' },
      batteryGuard: { active: true, percent: 55 },
    },
    battery: { available: true, percent: 87, charging: false, pluggedIn: true, remainingMinutes: null },
    failures: {},
    hostDown: false,
  };
}

function baseScenario() {
  return baseWorld();
}

function scenarioWith(mutate) {
  const world = baseWorld();
  mutate(world);
  return world;
}

function failureScenario(op, failure) {
  return scenarioWith((world) => { world.failures = { [op]: failure }; });
}

function hostDownScenario() {
  return scenarioWith((world) => { world.hostDown = true; });
}

function tokenScenario(token) {
  return scenarioWith((world) => { world.token = token; });
}

// Real destination with userinfo and a non-default port, plus an unparsable
// webhook URL: the mask must keep only `https://bark.example.com:8443`.
function notifyScenario() {
  return scenarioWith((world) => {
    world.push.barkUrl = 'https://User:Secret@BARK.example.com:8443/device-key-abc';
    world.push.webhookUrl = 'not a url';
    world.push.hasBark = true;
    world.push.barkDevices = [{ name: 'phone', key: 'dev-1' }, { name: 'pad', key: 'dev-2' }];
  });
}

// ── oracle side: scripted deps ──────────────────────────────────────────────

function errorFor(spec) {
  const message = spec.safeMessage != null ? spec.safeMessage : (spec.detail || 'host read operation failed');
  const error = new Error(message);
  if (Number.isInteger(spec.status)) error.status = spec.status;
  if (spec.code != null) error.code = spec.code;
  if (spec.safeMessage != null) error.safe = true;
  return error;
}

function makePush(world, guard) {
  const push = world.push;
  const subscriptions = new Map();
  const healthStats = new Map();
  push.endpoints.forEach((endpoint, index) => {
    subscriptions.set(endpoint, { endpoint });
    const health = push.health[index];
    if (health != null) healthStats.set(endpoint, clone(health));
  });
  return {
    get subscriptions() { guard('push-health'); return subscriptions; },
    get healthStats() { return healthStats; },
    globalStats: clone(push.globalStats),
    get cfg() {
      guard('notify');
      return { BARK_URL: push.barkUrl, WEBHOOK_URL: push.webhookUrl };
    },
    hasBarkDevices: () => push.hasBark,
    barkHealth: clone(push.barkHealth),
    webhookHealth: clone(push.webhookHealth),
    barkDevices: push.barkDevices ? { list: () => clone(push.barkDevices) } : undefined,
  };
}

function makeTunnel(world, guard) {
  return {
    getStatus: () => { guard('tunnel'); return clone(world.tunnel.status); },
    funnelStatus: async () => { guard('funnel'); return clone(world.tunnel.funnel); },
    ipv6Status: async () => { guard('ipv6'); return clone(world.tunnel.ipv6); },
    sakuraAccess: async () => { guard('sakurafrp'); return clone(world.tunnel.sakura); },
  };
}

// `createBatteryHandler` reads `deps.readBattery` once, at mount, so this has
// to be one stable function that consults the scenario current at call time.
function readBatteryAnswer() {
  const world = currentScenario;
  if (world.hostDown) return Promise.reject(new Error('host port unavailable'));
  const spec = world.failures && world.failures.battery;
  if (spec) return Promise.reject(errorFor(spec));
  return Promise.resolve(clone(world.battery));
}

// Rebuilds every scripted service around `scenario`. The retired handlers close
// over `deps` and read it per request (the battery reader above excepted), so
// replacing its fields is enough; nothing else is cached.
function installOracle(scenario) {
  currentScenario = scenario;
  const world = scenario;
  const guard = (op) => {
    if (world.hostDown) throw new Error('host port unavailable');
    const spec = world.failures && world.failures[op];
    if (spec) throw errorFor(spec);
  };
  deps.getVapidPublicKey = () => { guard('vapid-key'); return world.vapidKey; };
  deps.getAccessToken = () => { guard('access-token'); return world.token; };
  deps.isLocalRequest = realIsLocalRequest;
  deps.push = makePush(world, guard);
  deps.tunnel = makeTunnel(world, guard);
  deps.unlockPassword = {
    isAvailable: () => world.power.unlock.available,
    hasPassword: async () => world.power.unlock.hasPassword,
  };
  deps.powerPreferences = { read: () => world.power.preferences };
  deps.unlockProbe = { desktopPermissions: async () => clone(world.power.authorization) };
  deps.batteryGuard = world.power.batteryGuard
    ? { getStatus: () => clone(world.power.batteryGuard) }
    : undefined;
  deps.macosPower = {
    isAvailable: () => world.power.available,
    getLidModeSettings: async () => { guard('power'); return clone(world.power.lidMode); },
  };
}

// ── stub Node child: the host port, scripted ────────────────────────────────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

const legacy = require(path.join(REPO, 'tests/helpers/legacy-host-read-routes'));
const HOST_PATH = ${JSON.stringify(HOST_PATH)};
const scriptPath = process.env.STUB_SCRIPT;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function scenario() {
  try { return JSON.parse(fs.readFileSync(scriptPath, 'utf8')); } catch (_) { return {}; }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// The same deterministic services the oracle injects, rebuilt from the file.
function powerDeps(power, canEdit) {
  power = power || {};
  const unlock = power.unlock || {};
  return {
    macosPower: {
      isAvailable: () => power.available,
      getLidModeSettings: async () => clone(power.lidMode || {}),
    },
    batteryGuard: power.batteryGuard ? { getStatus: () => clone(power.batteryGuard) } : undefined,
    unlockPassword: {
      isAvailable: () => unlock.available,
      hasPassword: async () => unlock.hasPassword,
    },
    powerPreferences: { read: () => power.preferences },
    unlockProbe: { desktopPermissions: async () => clone(power.authorization || {}) },
    isLocalRequest: () => canEdit === true,
  };
}

async function answer(script, input) {
  const op = typeof input.op === 'string' ? input.op : '';
  const failures = script.failures || {};
  if (hasOwn(failures, op)) {
    const failure = failures[op];
    return {
      ok: false,
      status: Number.isInteger(failure.status) ? failure.status : 500,
      code: failure.code != null ? failure.code : null,
      safeMessage: failure.safeMessage != null ? failure.safeMessage : null,
      detail: failure.detail || 'host read operation failed',
    };
  }
  const push = script.push || {};
  if (op === 'vapid-key') return { ok: true, payload: script.vapidKey };
  if (op === 'push-health') {
    const endpoints = push.endpoints || [];
    return {
      ok: true,
      payload: {
        endpoints,
        health: push.health || [],
        size: endpoints.length,
        globalStats: push.globalStats,
        barkConfigured: push.hasBark,
        barkHealth: push.barkHealth,
        webhookConfigured: !!push.webhookUrl,
        webhookHealth: push.webhookHealth,
      },
    };
  }
  if (op === 'notify') {
    const payload = {
      barkUrl: push.barkUrl,
      webhookUrl: push.webhookUrl,
      hasBark: push.hasBark,
    };
    if (push.barkDevices) payload.barkDevices = push.barkDevices;
    return { ok: true, payload };
  }
  if (op === 'tunnel') return { ok: true, payload: (script.tunnel || {}).status };
  if (op === 'funnel') return { ok: true, payload: (script.tunnel || {}).funnel };
  if (op === 'ipv6') return { ok: true, payload: (script.tunnel || {}).ipv6 };
  if (op === 'sakurafrp') return { ok: true, payload: (script.tunnel || {}).sakura };
  if (op === 'access-token') return { ok: true, payload: { token: script.token || '' } };
  if (op === 'power') {
    return { ok: true, payload: await legacy.readPowerSettings(powerDeps(script.power, input.canEdit), {}) };
  }
  if (op === 'battery') return { ok: true, payload: script.battery };
  return { ok: false };
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === HOST_PATH) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const script = scenario();
      if (script.hostDown === true) { req.socket.destroy(); return; }
      let input = {};
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
      let out;
      try {
        out = await answer(script, input);
      } catch (error) {
        out = { ok: false, status: 500, code: null, safeMessage: null,
          detail: String((error && error.message) || error) };
      }
      const text = JSON.stringify(out);
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

// ── corpus ──────────────────────────────────────────────────────────────────

function useScenario(scenario, extra = {}) {
  return {
    before() {
      installOracle(scenario);
      // The stub child is a separate process; it reads the same scenario from
      // this file at host-call time (written for both sides, idempotent).
      fs.writeFileSync(scriptPath, JSON.stringify(scenario));
    },
    ...extra,
  };
}

const forwarded = view => view.status === 599
  && String(view.body || '').startsWith('gateway-forwarded:');

function corpus(ctx) {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = url => ({ method: 'HEAD', url, headers: L });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  // A remote-looking client: keeping Host localhost and adding a forwarding
  // header is what the auth gate accepts without a login redirect, and it is
  // the same request-locality rule Rust applies (`http_gate::is_local_request`).
  const remote = {
    ...L,
    'X-Forwarded-For': '203.0.113.9',
    Cookie: 'multicc_auth=' + ctx.cookie,
  };
  const cases = [];
  const add = (name, request, scenario = baseScenario(), extra = {}) =>
    cases.push([name, request, useScenario(scenario, extra)]);

  // ── the ten GETs ─────────────────────────────────────────────────────────
  add('GET vapid key', get('/api/push/vapid-key'));
  add('GET push health two subscriptions', get('/api/push/health'));
  add('GET notify empty urls', get('/api/settings/notify'));
  add('GET tunnel status', get('/api/settings/tunnel'));
  add('GET tunnel funnel', get('/api/tunnel/funnel'));
  add('GET tunnel ipv6', get('/api/tunnel/ipv6'));
  add('GET tunnel sakurafrp', get('/api/tunnel/sakurafrp'));
  add('GET access token ten chars', get('/api/settings/access-token'));
  add('GET power canEdit true', get('/api/settings/power'));
  add('GET battery', get('/api/host/battery'));
  add('HEAD push health', head('/api/push/health'));

  // ── automatic OPTIONS on all ten (Allow + body compared) ───────────────
  for (const [name, url] of [
    ['OPTIONS vapid key', '/api/push/vapid-key'],
    ['OPTIONS push health', '/api/push/health'],
    ['OPTIONS notify', '/api/settings/notify'],
    ['OPTIONS tunnel status', '/api/settings/tunnel'],
    ['OPTIONS tunnel funnel', '/api/tunnel/funnel'],
    ['OPTIONS tunnel ipv6', '/api/tunnel/ipv6'],
    ['OPTIONS tunnel sakurafrp', '/api/tunnel/sakurafrp'],
    ['OPTIONS access token', '/api/settings/access-token'],
    ['OPTIONS power', '/api/settings/power'],
    ['OPTIONS battery', '/api/host/battery'],
  ]) add(name, options(url));

  // ── response compression (both bodies are >1024 bytes) ──────────────────
  add('GET tunnel status gzip', get('/api/settings/tunnel', { ...L, 'Accept-Encoding': 'gzip, deflate' }));
  add('GET tunnel funnel gzip', get('/api/tunnel/funnel', { ...L, 'Accept-Encoding': 'gzip' }));

  // ── path spelling ────────────────────────────────────────────────────────
  add('GET vapid key mixed case', get('/api/Push/Vapid-Key'));
  add('GET battery trailing slash', get('/api/host/battery/'));

  // ── notification masking: userinfo, non-default port, invalid URL ──────
  add('GET notify userinfo port invalid webhook', get('/api/settings/notify'), notifyScenario());

  // ── access token masking boundaries ─────────────────────────────────────
  add('GET access token two chars', get('/api/settings/access-token'), tokenScenario('ab'));
  add('GET access token empty', get('/api/settings/access-token'), tokenScenario(null));

  // ── canEdit locality (both directions) ──────────────────────────────────
  add('GET access token remote canEdit false', get('/api/settings/access-token', remote));
  add('GET power remote canEdit false', get('/api/settings/power', remote));

  // ── host-port failures, mapped by the front door like safeErrorHandler ──
  add('GET vapid key host failure', get('/api/push/vapid-key'),
    failureScenario('vapid-key', { status: 500, code: 'EBOOM', detail: 'vapid exploded' }));
  add('GET notify host failure', get('/api/settings/notify'),
    failureScenario('notify', { status: 500, code: 'ENOTIFY', detail: 'notify config exploded' }));
  add('GET tunnel funnel host failure safe 4xx', get('/api/tunnel/funnel'),
    failureScenario('funnel', {
      status: 409, code: 'EUNAVAIL', safeMessage: 'funnel unavailable', detail: 'funnel unavailable',
    }));
  add('GET battery host failure', get('/api/host/battery'),
    failureScenario('battery', { status: 500, code: 'EBATTERY', detail: 'battery probe exploded' }));
  add('GET push health host down', get('/api/push/health'), hostDownScenario());

  // ── documented differences ──────────────────────────────────────────────
  const shape = (node, rust = forwarded) => ({ node, rust });
  add('GET uppercase API prefix', get('/API/push/vapid-key'),
    baseScenario(), { expectedDifference: shape(view => view.status === 200) });
  add('POST settings power', { method: 'POST', url: '/api/settings/power', headers: L },
    baseScenario(), { expectedDifference: shape(view => view.status === 404) });
  add('DELETE vapid key', { method: 'DELETE', url: '/api/push/vapid-key', headers: L },
    baseScenario(), { expectedDifference: shape(view => view.status === 404) });
  add('GET notify extra segment', get('/api/settings/notify/x'),
    baseScenario(), { expectedDifference: shape(view => view.status === 404) });

  return cases;
}

main({
  name: 'host-read',
  mount(app, { repo, work }) {
    scriptPath = path.join(work, 'host-read-script.json');
    legacy = require(path.join(repo, 'tests/helpers/legacy-host-read-routes'));
    realIsLocalRequest = require(path.join(repo, 'src/request-locality')).isLocalRequest;
    deps = {};
    // One stable reader: createBatteryHandler captures it at mount time.
    deps.readBattery = readBatteryAnswer;
    installOracle(baseScenario());
    fs.writeFileSync(scriptPath, JSON.stringify(currentScenario));
    legacy.mount(app, deps);
    // Express derives its automatic OPTIONS Allow list from the layers mounted
    // on the path. Production registers POST on these five (host-write.js /
    // host-power.js); a pass-through keeps that method visible to OPTIONS while
    // still ending in the 404 of an unmounted POST route.
    for (const routePath of POST_PATHS) app.post(routePath, (req, res, next) => next());
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  // The stub child loads the real auth-control bridge, which loads the native
  // addon, and reads its world from STUB_SCRIPT.
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    STUB_SCRIPT: path.join(work, 'host-read-script.json'),
  }),
  corpus,
});
