'use strict';
// Differential run for the fifteen events & triggers routes retired from three
// Node modules:
//
//   GET|HEAD /api/events/catalog        GET|HEAD /api/events/recent
//   GET|HEAD /api/event-triggers        GET|HEAD /api/event-rules
//   POST     /api/event-rules           PUT      /api/event-rules/:id
//   DELETE   /api/event-rules/:id       POST     /api/events/test
//   GET|HEAD /api/sessions/:id/triggers POST     /api/sessions/:id/triggers
//   PUT      /api/sessions/:id/triggers/:tid
//   DELETE   /api/sessions/:id/triggers/:tid
//   POST     /api/sessions/:id/triggers/:tid/test
//   GET|HEAD /api/annotation-live       POST     /api/annotation-live
//
// now answered by native/gateway/src/app/event_routes.rs (rules in
// native/core/src/event_routes.rs and native/core/src/events.rs).
//
//   node docs/rust-migration/differential/event-routes.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-event-routes.js: the three modules as they were before
// deletion, only their require paths rewritten) over the scripted world in
// tests/helpers/event-scripted-world.js, behind the same public-session access
// guard server.js mounts on `/api/sessions/:id`. The Rust front door calls its
// host port (/api/__host/events, plus the session-admin guard port); the stub
// Node child here is the real src/routes/events-host.js composition over the
// same world. So the comparison covers the split itself: the hub and rule
// engine, session records and their persistence, fireTrigger/reconcileSession,
// appendEvent, the cron parser, the plugin channel registry and the
// annotation-live config/regex/webhook relay must feed the front door exactly
// the facts the retired handlers used.
//
// Side effects are compared per case: every hub.emit, rule-table persist,
// channel-recipient check, cron validation, session-persistence mutation,
// appendEvent, chat broadcast and chat:run is recorded by the oracle in-process
// and by the stub in an NDJSON file, then compared. A route that answers the
// same bytes but asks Node for the wrong thing — or twice — fails.
//
// The one dynamic piece is the annotation relay target: a local HTTP server
// stands in for the configured webhook and echoes the payload it received back
// as `text`, so the response pins the normalized DTO on both sides. The two
// process-local config paths differ (node-data vs gw-data) and are normalized.
//
// No corpus case is expected to differ. The host port being down (503
// rust_backend_unavailable) has no Node-side twin; it is covered by
// native/gateway/tests/event_routes.rs and docs/gateway.md §9.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { main, waitForFixture } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const T0 = 1700000000000;
const ISO = new Date(T0).toISOString();

let worldPath = '';
let effectsPath = '';
let annotation = { node: '', rust: '' };
let bag = null;
let legacy = null;
let upstreamText = '';
let relay = null;
let repoRoot = '';
const caseNames = new Map();
const nodeEffects = new Map();
const capturedEtags = new Map();
const priorByCase = new Map();
let lastCase = null;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ── the scripted worlds ────────────────────────────────────────────────────

function baseWorld(tag, extra = {}) {
  return {
    case: tag,
    now: T0,
    ids: [`id-${tag}-1`, `id-${tag}-2`, `id-${tag}-3`],
    store: { version: 1, rules: [], chains: [] },
    sessions: [],
    chats: {},
    channels: {},
    crons: {},
    cwd: '/work/project',
    ...extra,
  };
}

function rule(id, extra = {}) {
  return {
    id,
    type: 'event',
    scope: 'global',
    name: '',
    enabled: true,
    once: false,
    on: ['task.done'],
    filter: {},
    action: { kind: 'inject-prompt', prompt: 'p' },
    then: [],
    cooldownMs: 60_000,
    mode: 'inject',
    createdAt: ISO,
    ...extra,
  };
}

function trigger(id, extra = {}) {
  return {
    id,
    type: 'post-turn',
    enabled: true,
    prompt: 'hello',
    cooldownMs: 30_000,
    mode: 'inject',
    createdAt: ISO,
    ...extra,
  };
}

function session(id, triggers, extra = {}) {
  return { id, dirId: `dir-${id}`, label: `label-${id}`, triggers, ...extra };
}

const EVENT_RULE_CHANNEL_OK = {
  kind: 'channel',
  plugin: 'wechat',
  target: 'user-1',
  message: 'ping',
};

// ── corpus plumbing ────────────────────────────────────────────────────────

let counter = 0;
const pending = [];

function writeAnnotationConfigs() {
  const targets = [{
    match: { session: '^match-' },
    url: `http://127.0.0.1:${relay.port}/annotation`,
  }];
  fs.writeFileSync(path.join(annotation.node, 'annotation-live.json'), JSON.stringify(targets));
  fs.writeFileSync(path.join(annotation.rust, 'annotation-live.json'), JSON.stringify(targets));
}

function useScenario(scenario) {
  return {
    async before(side) {
      await relayReady;
      writeAnnotationConfigs();
      if (side.name === 'node') bag.apply(scenario);
      else fs.writeFileSync(worldPath, JSON.stringify(scenario));
    },
    capture(response, side) {
      if (side.name !== 'node') return;
      nodeEffects.set(scenario.case, clone(bag.effects.calls));
      bag.effects.calls.length = 0;
      if (response.headers && response.headers.etag) {
        capturedEtags.set(scenario.case, response.headers.etag);
      }
    },
  };
}

function add(name, buildRequest, buildWorld, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  priorByCase.set(tag, lastCase);
  lastCase = tag;
  const scenario = buildWorld ? buildWorld(tag) : baseWorld(tag);
  scenario.case = tag;
  caseNames.set(tag, name);
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) hooks[hook] = fn;
  pending.push([name, () => buildRequest(tag), hooks]);
}

function priorEtag(tag) {
  return capturedEtags.get(priorByCase.get(tag)) || 'W/"none"';
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  const json = (method, url, body, headers = L) => ({
    method,
    url,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const post = (url, body, headers = L) => json('POST', url, body, headers);
  const put = (url, body, headers = L) => json('PUT', url, body, headers);

  // ── Express automatic OPTIONS: the Allow list of every retired path ─────
  const OPTIONS_ALLOW = [
    ['/api/events/catalog', 'GET,HEAD'],
    ['/api/events/recent', 'GET,HEAD'],
    ['/api/event-triggers', 'GET,HEAD'],
    ['/api/event-rules', 'GET,HEAD,POST'],
    ['/api/event-rules/r1', 'PUT,DELETE'],
    ['/api/events/test', 'POST'],
    ['/api/sessions/s1/triggers', 'GET,HEAD,POST'],
    ['/api/sessions/s1/triggers/t1', 'PUT,DELETE'],
    ['/api/sessions/s1/triggers/t1/test', 'POST'],
    ['/api/annotation-live', 'GET,HEAD,POST'],
  ];
  for (const [url] of OPTIONS_ALLOW) {
    add(`OPTIONS ${url}`, () => options(url));
  }
  add('OPTIONS internal execution slot',
    () => options('/api/sessions/slot/triggers'),
    tag => baseWorld(tag, { sessions: [session('slot', [], { taskExecutionSlot: true })] }));

  // ── catalog / recent ────────────────────────────────────────────────────
  add('catalog', () => get('/api/events/catalog'));
  add('HEAD catalog', () => head('/api/events/catalog'));
  add('catalog conditional', tag => get('/api/events/catalog', { ...L, 'If-None-Match': priorEtag(tag) }));

  const chains = (tag) => baseWorld(tag, {
    store: {
      version: 1,
      rules: [],
      chains: [{
        sessionId: 's1', ruleId: 'r1', owner: null, index: 1, since: T0,
        awaiting: 'turn', sawTrigger: false, sawOther: false, dryRun: false,
      }],
    },
  });
  add('recent default limit', () => get('/api/events/recent'), chains);
  add('recent clamps a big limit', () => get('/api/events/recent?limit=500'), chains);
  add('recent NaN limit falls back to 50', () => get('/api/events/recent?limit=abc'), chains);
  add('HEAD recent', () => head('/api/events/recent'), chains);

  // ── rule/trigger lists ──────────────────────────────────────────────────
  const listed = (tag) => baseWorld(tag, {
    store: { version: 1, rules: [rule('r1', { lastFiredAt: T0 - 1000 })], chains: [] },
    sessions: [session('s1', [rule('t1', { scope: 'session', type: 'event' })])],
  });
  add('GET event-triggers', () => get('/api/event-triggers'), listed);
  add('HEAD event-triggers', () => head('/api/event-triggers'), listed);
  add('GET event-rules', () => get('/api/event-rules'), listed);
  add('HEAD event-rules', () => head('/api/event-rules'), listed);

  // ── POST /api/event-rules ───────────────────────────────────────────────
  add('add inject-prompt rule',
    () => post('/api/event-rules', { on: ['task.done'], name: 'n', action: { kind: 'inject-prompt', prompt: 'go' } }),
    tag => baseWorld(tag));
  add('add notify rule',
    () => post('/api/event-rules', { on: ['task.failed'], action: { kind: 'notify', message: 'oops' } }),
    tag => baseWorld(tag));
  add('add chained rule with filter',
    () => post('/api/event-rules', {
      on: ['task.finished'],
      filter: { goalState: 'achieved', sessionIds: ['s1', 's2'], cancelled: false },
      action: { kind: 'webhook', url: 'https://example.test/hook', includeConclusion: true, secretName: 'HOOK_TOKEN' },
      then: [{ kind: 'inject-prompt', prompt: 'next' }],
      cooldownMs: 120000,
      once: true,
    }),
    tag => baseWorld(tag));
  add('add rule without patterns',
    () => post('/api/event-rules', {}),
    tag => baseWorld(tag));
  add('add rule with an unknown pattern',
    () => post('/api/event-rules', { on: ['bogus.event'], action: { kind: 'inject-prompt', prompt: 'go' } }),
    tag => baseWorld(tag));
  add('add rule when the table is full',
    () => post('/api/event-rules', { on: ['task.done'], action: { kind: 'inject-prompt', prompt: 'go' } }),
    (tag) => baseWorld(tag, {
      store: {
        version: 1,
        rules: Array.from({ length: 100 }, (_, index) => rule(`seed-${index}`)),
        chains: [],
      },
    }));
  add('add channel rule',
    () => post('/api/event-rules', { on: ['task.done'], action: EVENT_RULE_CHANNEL_OK }),
    tag => baseWorld(tag));
  add('add channel rule with a missing recipient',
    () => post('/api/event-rules', { on: ['task.done'], action: EVENT_RULE_CHANNEL_OK }),
    tag => baseWorld(tag, { channels: { 'wechat/user-1': 'channel recipient is not installed' } }));
  add('add rule with an invalid webhook url',
    () => post('/api/event-rules', { on: ['task.done'], action: { kind: 'webhook', url: 'file:///etc/passwd' } }),
    tag => baseWorld(tag));
  add('add rule with no body', () => post('/api/event-rules'));

  // ── PUT /api/event-rules/:id ────────────────────────────────────────────
  const storedRule = (tag) => baseWorld(tag, {
    store: {
      version: 1,
      rules: [rule('r1', {
        name: 'old',
        lastFiredAt: T0 - 5000,
        firedAt: T0 - 4000,
      })],
      chains: [],
    },
  });
  add('update rule name', () => put('/api/event-rules/r1', { name: 'new' }), storedRule);
  add('update rule appends a chain step',
    () => put('/api/event-rules/r1', { then: [{ kind: 'notify', message: 'done' }] }),
    storedRule);
  add('update missing rule',
    () => put('/api/event-rules/nope', { name: 'x' }), tag => baseWorld(tag));
  add('update rule to an invalid pattern',
    () => put('/api/event-rules/r1', { on: [] }), storedRule);
  add('update rule with an encoded id',
    () => put('/api/event-rules/r%201', { name: 'new' }),
    (tag) => baseWorld(tag, { store: { version: 1, rules: [rule('r 1')], chains: [] } }));
  add('update rule with a malformed escape',
    () => put('/api/event-rules/%E0%A4%A', { name: 'new' }), tag => baseWorld(tag));

  // ── DELETE /api/event-rules/:id ─────────────────────────────────────────
  add('delete rule', () => ({ method: 'DELETE', url: '/api/event-rules/r1', headers: L }), storedRule);
  add('delete missing rule',
    () => ({ method: 'DELETE', url: '/api/event-rules/nope', headers: L }), tag => baseWorld(tag));

  // ── POST /api/events/test ───────────────────────────────────────────────
  add('events test emits',
    () => post('/api/events/test', { type: 'task.achieved', sessionId: 's1', goal: 'g', goalState: 'achieved' }));
  add('events test refuses an alias',
    () => post('/api/events/test', { type: 'task.done' }));
  add('events test without a type', () => post('/api/events/test', {}));
  add('events test clips the goal',
    () => post('/api/events/test', { type: 'task.achieved', goal: 'x'.repeat(100) }));
  add('events test stringifies a numeric session id',
    () => post('/api/events/test', { type: 'task.finished', sessionId: 42 }));
  add('events test drops a falsy goal state',
    () => post('/api/events/test', { type: 'task.achieved', goalState: '' }));

  // ── GET /api/sessions/:id/triggers ──────────────────────────────────────
  const withTriggers = (tag) => baseWorld(tag, { sessions: [session('s1', [trigger('t1')])] });
  add('triggers list', () => get('/api/sessions/s1/triggers'), withTriggers);
  add('HEAD triggers list', () => head('/api/sessions/s1/triggers'), withTriggers);
  add('triggers list of a record without the array',
    () => get('/api/sessions/s1/triggers'),
    tag => baseWorld(tag, { sessions: [{ id: 's1', dirId: 'dir-s1', label: 'l' }] }));
  add('triggers list of a missing session',
    () => get('/api/sessions/nope/triggers'), tag => baseWorld(tag));
  add('triggers list of an internal execution slot',
    () => get('/api/sessions/slot/triggers'),
    tag => baseWorld(tag, { sessions: [session('slot', [], { taskExecutionSlot: true })] }));

  // ── POST /api/sessions/:id/triggers ─────────────────────────────────────
  add('add post-turn trigger',
    () => post('/api/sessions/s1/triggers', { type: 'post-turn', prompt: 'go' }),
    tag => baseWorld(tag, { sessions: [session('s1', [])] }));
  add('add file-change trigger with a string path',
    () => post('/api/sessions/s1/triggers', { type: 'file-change', paths: 'src/**', debounceMs: 1000 }),
    tag => baseWorld(tag, { sessions: [session('s1', [])] }));
  add('add file-change trigger without paths',
    () => post('/api/sessions/s1/triggers', { type: 'file-change' }),
    tag => baseWorld(tag, { sessions: [session('s1', [])] }));
  add('add schedule trigger',
    () => post('/api/sessions/s1/triggers', { type: 'schedule', cron: '0 9 * * *' }),
    tag => baseWorld(tag, { sessions: [session('s1', [])] }));
  add('add schedule trigger with a bad expression',
    () => post('/api/sessions/s1/triggers', { type: 'schedule', cron: 'nope' }),
    tag => baseWorld(tag, { sessions: [session('s1', [])], crons: { nope: false } }));
  add('add event trigger',
    () => post('/api/sessions/s1/triggers', { type: 'event', on: ['task.done'], action: { kind: 'inject-prompt', prompt: 'go' } }),
    tag => baseWorld(tag, { sessions: [session('s1', [])] }));
  add('add event trigger with a channel action',
    () => post('/api/sessions/s1/triggers', { type: 'event', on: ['task.done'], action: EVENT_RULE_CHANNEL_OK }),
    tag => baseWorld(tag, { sessions: [session('s1', [])] }));
  add('add event trigger with a missing channel recipient',
    () => post('/api/sessions/s1/triggers', { type: 'event', on: ['task.done'], action: EVENT_RULE_CHANNEL_OK }),
    tag => baseWorld(tag, {
      sessions: [session('s1', [])],
      channels: { 'wechat/user-1': 'no such channel' },
    }));
  add('add trigger with an invalid type',
    () => post('/api/sessions/s1/triggers', { type: 'bogus' }),
    tag => baseWorld(tag, { sessions: [session('s1', [])] }));
  add('add trigger to an internal execution slot',
    () => post('/api/sessions/slot/triggers', { type: 'post-turn' }),
    tag => baseWorld(tag, { sessions: [session('slot', [], { taskExecutionSlot: true })] }));
  add('add trigger to a missing session',
    () => post('/api/sessions/nope/triggers', { type: 'post-turn' }),
    tag => baseWorld(tag));

  // ── PUT/DELETE /api/sessions/:id/triggers/:tid ──────────────────────────
  const stamps = (tag) => baseWorld(tag, {
    sessions: [session('s1', [trigger('t1', { lastFiredAt: T0 - 2000, firedAt: T0 - 2000 })])],
  });
  add('update trigger prompt',
    () => put('/api/sessions/s1/triggers/t1', { prompt: 'new' }), stamps);
  add('update missing trigger',
    () => put('/api/sessions/s1/triggers/t9', { prompt: 'new' }), stamps);
  add('update trigger of a missing session',
    () => put('/api/sessions/nope/triggers/t1', { prompt: 'new' }), tag => baseWorld(tag));
  add('update trigger of a record without the array',
    () => put('/api/sessions/s1/triggers/t1', { prompt: 'new' }),
    tag => baseWorld(tag, { sessions: [{ id: 's1', dirId: 'dir-s1', label: 'l' }] }));
  add('update trigger of an internal execution slot',
    () => put('/api/sessions/slot/triggers/t1', { prompt: 'new' }),
    tag => baseWorld(tag, { sessions: [session('slot', [trigger('t1')], { taskExecutionSlot: true })] }));
  add('update trigger to an invalid type',
    () => put('/api/sessions/s1/triggers/t1', { type: 'bogus' }), stamps);
  add('delete trigger',
    () => ({ method: 'DELETE', url: '/api/sessions/s1/triggers/t1', headers: L }), stamps);
  add('delete missing trigger',
    () => ({ method: 'DELETE', url: '/api/sessions/s1/triggers/t9', headers: L }), stamps);
  add('delete trigger of a missing session',
    () => ({ method: 'DELETE', url: '/api/sessions/nope/triggers/t1', headers: L }),
    tag => baseWorld(tag));
  add('delete trigger of an internal execution slot',
    () => ({ method: 'DELETE', url: '/api/sessions/slot/triggers/t1', headers: L }),
    tag => baseWorld(tag, { sessions: [session('slot', [trigger('t1')], { taskExecutionSlot: true })] }));

  // ── POST /api/sessions/:id/triggers/:tid/test ───────────────────────────
  add('manual trigger test',
    () => post('/api/sessions/s1/triggers/t1/test'),
    tag => baseWorld(tag, { sessions: [session('s1', [trigger('t1', { enabled: false })])] }));
  add('manual trigger test of an event rule',
    () => post('/api/sessions/s1/triggers/t2/test'),
    tag => baseWorld(tag, { sessions: [session('s1', [rule('t2', { scope: 'session', type: 'event' })])] }));
  add('manual trigger test of a missing trigger',
    () => post('/api/sessions/s1/triggers/t9/test'),
    tag => baseWorld(tag, { sessions: [session('s1', [trigger('t1')])] }));
  add('manual trigger test of an internal execution slot',
    () => post('/api/sessions/slot/triggers/t1/test'),
    tag => baseWorld(tag, { sessions: [session('slot', [trigger('t1')], { taskExecutionSlot: true })] }));

  // ── annotation-live ─────────────────────────────────────────────────────
  // The config path is per-side (node-data vs gw-data): the body is normalized,
  // but the ETag and content length derive from the raw bytes, so blank them.
  const configHeaders = {
    normalize(view) {
      delete view.headers.etag;
      delete view.headers['content-length'];
      return view;
    },
  };
  add('annotation config', () => get('/api/annotation-live'), undefined, configHeaders);
  add('HEAD annotation config', () => head('/api/annotation-live'), undefined, configHeaders);
  add('annotation relay hits a target',
    () => post('/api/annotation-live', {
      sessionId: 'match-1', src: 'demo-shot.png', width: 640, height: 480,
      kind: 'box', a: { x: 1, y: 2 }, b: { x: 3, y: 4 },
    }));
  add('annotation relay with no matching target',
    () => post('/api/annotation-live', {
      sessionId: 'other-1', src: 'demo-shot.png', kind: 'point', a: { x: 1, y: 2 },
    }));
  add('annotation relay normalizes the payload',
    () => post('/api/annotation-live', {
      sessionId: 'match-2', src: 'demo-shot.png', width: '1e999', height: '12.5',
      kind: 'arrow', a: 0, b: false,
    }));

  return pending;
}

// ── the stub Node child ────────────────────────────────────────────────────

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
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const world = require(path.join(REPO, 'tests/helpers/event-scripted-world'));
const { createEventsRuntime } = require(path.join(REPO, 'src/routes/events-host'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return { case: null }; }
}

const bag = world.buildDeps({ case: 'initial' });
const app = express();
app.get('/__health', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.use('/api', express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  bag.apply(readWorld());
  res.on('finish', () => {
    const calls = bag.effects.calls.splice(0);
    if (calls.length) {
      fs.appendFileSync(effectsPath, JSON.stringify({ case: bag.world().case || null, calls }) + '\\n');
    }
  });
  next();
});

// The session-admin guard port the front door asks before every
// /api/sessions/:id/... trigger route (native/gateway/src/app/session_admin.rs).
app.post('/api/__host/session-admin', (req, res) => {
  const body = req.body || {};
  const record = bag.deps.persistedSessions.get(String(body.id == null ? '' : body.id)) || null;
  res.json({
    record,
    internal: !!(record && record.taskExecutionSlot === true),
    taskStateWritable: false,
  });
});

createEventsRuntime(bag.deps).mount(app);

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

// ── run ────────────────────────────────────────────────────────────────────

// The relay target the annotation cases point at. It stands in for the
// webhook configured in annotation-live.json and echoes the received payload
// back as `text`, so the compared response pins the normalized DTO on both
// sides. It starts before the run so its port is known when the first case
// writes the configs.
relay = { port: 0 };
const relayReady = new Promise(resolve => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
      const text = [
        payload.sessionId, payload.kind, String(payload.width), String(payload.height),
        payload.a === null ? 'null-a' : 'a', payload.b === null ? 'null-b' : 'b',
      ].join('|');
      const body = JSON.stringify({ ok: true, refresh: true, text });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    relay.port = server.address().port;
    // Keep serving cases, but never hold the process open after finalize.
    server.unref();
    resolve();
  });
  process.on('exit', () => server.close());
});

main({
  name: 'event-routes',
  ready: waitForFixture,
  seed(dataRoot) {
    // The two annotation config dirs are written per case (the relay port is
    // only known once the server listens); nothing else is seeded on disk.
    fs.mkdirSync(dataRoot, { recursive: true });
  },
  mount(app, { repo, work, dataRoot }) {
    repoRoot = repo;
    worldPath = path.join(work, 'events-world.json');
    effectsPath = path.join(work, 'events-effects.ndjson');
    annotation = {
      node: dataRoot,
      rust: path.join(work, 'gw-data'),
    };
    fs.mkdirSync(annotation.rust, { recursive: true });
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify(baseWorld('initial')));
    // The frozen annotation module computes its config path at require time
    // from MULTICC_DATA_DIR (node-data on this side, gw-data in the child).
    process.env.MULTICC_DATA_DIR = dataRoot;
    legacy = require(path.join(repo, 'tests/helpers/legacy-event-routes'));
    const helper = require(path.join(repo, 'tests/helpers/event-scripted-world'));
    bag = helper.buildDeps(baseWorld('initial'));

    // server.js guards these paths before the routers run; the front door has
    // to reproduce the same 404, so the Node side mounts the real guard.
    const { createErrorDto, requestContext } = require(path.join(repo, 'tests/helpers/frozen-file-batch20/api-contract'));
    const { mountPublicSessionAccessGuard } =
      require(path.join(repo, 'tests/helpers/legacy-public-session-access'));
    mountPublicSessionAccessGuard(app, {
      records: bag.deps.persistedSessions,
      v1NotFound: (req, res) => res.status(404).json(createErrorDto({
        ...requestContext(req, res), message: 'session not found', code: 'session_not_found',
      })),
    });
    // Registration order is the retired server.js order.
    legacy.createSessionTriggers(bag.deps).mountRoutes(app);
    legacy.mountEventRoutes(app, { hub: bag.deps.hub, engine: bag.deps.engine });
    legacy.mountAnnotationLive(app);
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    STUB_WORLD: path.join(work, 'events-world.json'),
    STUB_EFFECTS: path.join(work, 'events-effects.ndjson'),
  }),
  normalize(text, work) {
    return text
      .split(path.join(work, 'node-data')).join('<data>')
      .split(path.join(work, 'gw-data')).join('<data>');
  },
  corpus,
  finalize({ work, views }) {
    fs.writeFileSync(path.join(work, 'views.json'), JSON.stringify(views, null, 2));
    const problems = [];
    const byName = new Map(views.map(view => [view.name, view]));

    // ── coverage guards ─────────────────────────────────────────────────
    const statuses = new Set(views.map(view => view.node.status));
    for (const wanted of [200, 304, 400, 404]) {
      if (!statuses.has(wanted)) problems.push(`no corpus case answered ${wanted}`);
    }
    const OPTIONS_ALLOW = {
      '/api/events/catalog': 'GET,HEAD',
      '/api/events/recent': 'GET,HEAD',
      '/api/event-triggers': 'GET,HEAD',
      '/api/event-rules': 'GET,HEAD,POST',
      '/api/event-rules/r1': 'PUT,DELETE',
      '/api/events/test': 'POST',
      '/api/sessions/s1/triggers': 'GET,HEAD,POST',
      '/api/sessions/s1/triggers/t1': 'PUT,DELETE',
      '/api/sessions/s1/triggers/t1/test': 'POST',
      '/api/annotation-live': 'GET,HEAD,POST',
    };
    const allowSeen = new Set();
    for (const [url, allow] of Object.entries(OPTIONS_ALLOW)) {
      const view = byName.get(`OPTIONS ${url}`);
      if (!view) { problems.push(`missing OPTIONS case for ${url}`); continue; }
      if (view.node.headers.allow !== allow || view.rust.headers.allow !== allow) {
        problems.push(`OPTIONS ${url}: Allow expected ${allow}, got node ${view.node.headers.allow} / rust ${view.rust.headers.allow}`);
      }
      allowSeen.add(allow);
    }
    for (const allow of ['GET,HEAD', 'GET,HEAD,POST', 'PUT,DELETE', 'POST']) {
      if (!allowSeen.has(allow)) problems.push(`no path exercised the ${allow} Allow list`);
    }

    // The branches the brief calls out, pinned case by case.
    const pins = [
      ['catalog', 200, '"clis"'],
      ['HEAD catalog', 200, ''],
      ['catalog conditional', 304, ''],
      ['add inject-prompt rule', 200, '"cooldownMs":60000'],
      ['add rule without patterns', 400, 'on requires 1-10 event patterns'],
      ['add rule when the table is full', 400, 'too many global rules'],
      ['add channel rule with a missing recipient', 400, 'channel recipient is not installed'],
      ['update missing rule', 404, '"error":"not found"'],
      ['update rule with an encoded id', 200, '"name":"new"'],
      ['delete missing rule', 404, '"error":"not found"'],
      ['events test emits', 200, '"ok":true'],
      ['events test refuses an alias', 400, 'unknown event type'],
      ['events test clips the goal', 200, '"ok":true'],
      ['triggers list of an internal execution slot', 404, ''],
      ['triggers list of a missing session', 404, 'session not found'],
      ['add trigger to an internal execution slot', 404, 'session not found'],
      ['add trigger to a missing session', 404, 'session not found'],
      ['add schedule trigger', 200, '"cron":"0 9 * * *"'],
      ['add schedule trigger with a bad expression', 400, 'invalid cron expression'],
      ['add event trigger with a missing channel recipient', 400, 'no such channel'],
      ['update trigger of an internal execution slot', 404, 'session not found'],
      ['update trigger of a missing session', 404, 'not found'],
      ['update trigger of a record without the array', 404, 'not found'],
      ['delete trigger of an internal execution slot', 404, 'session not found'],
      ['manual trigger test', 200, '"ok":true'],
      ['manual trigger test of an event rule', 400, 'use POST /api/events/test for event rules'],
      ['manual trigger test of a missing trigger', 404, 'trigger not found'],
      ['manual trigger test of an internal execution slot', 404, 'session not found'],
      ['annotation config', 200, '<data>'],
      ['annotation relay hits a target', 200, '"relayed":1'],
      ['annotation relay with no matching target', 200, '"relayed":0'],
      ['annotation relay normalizes the payload', 200, 'match-2|arrow|null|12.5'],
    ];
    // The public-session access guard must answer every trigger path with the
    // same 404 a missing session gets, including /test and the automatic
    // OPTIONS, so the guard itself never becomes an enumeration oracle.
    for (const name of [
      'OPTIONS internal execution slot',
      'triggers list of an internal execution slot',
      'add trigger to an internal execution slot',
      'update trigger of an internal execution slot',
      'delete trigger of an internal execution slot',
      'manual trigger test of an internal execution slot',
    ]) {
      const view = byName.get(name);
      if (!view) { problems.push(`missing case ${name}`); continue; }
      for (const side of ['node', 'rust']) {
        if (view[side].status !== 404) problems.push(`${name}: ${side} answered ${view[side].status}, expected 404`);
        if (!view[side].body.includes('session not found')) problems.push(`${name}: ${side} body is missing session not found`);
      }
    }
    for (const [name, status, needle] of pins) {
      if (name === 'triggers list of an internal execution slot') continue;
      for (const side of ['node', 'rust']) {
        const view = byName.get(name);
        if (!view) { problems.push(`missing case ${name}`); continue; }
        if (view[side].status !== status) problems.push(`${name}: ${side} answered ${view[side].status}, expected ${status}`);
        if (needle && !view[side].body.includes(needle)) {
          problems.push(`${name}: ${side} body is missing ${needle}`);
        }
      }
    }

    // ── side effects ─────────────────────────────────────────────────────
    const rustEffects = new Map();
    for (const line of fs.readFileSync(effectsPath, 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!entry.case) continue;
      if (!rustEffects.has(entry.case)) rustEffects.set(entry.case, []);
      rustEffects.get(entry.case).push(...entry.calls);
    }
    // The unreachable-host 503 has no Node-side twin (the retired handler had
    // no transport of its own); it must be pinned by the gateway's own suite.
    const rustTests = path.join(repoRoot, 'native/gateway/tests/event_routes.rs');
    if (!fs.existsSync(rustTests)
        || !fs.readFileSync(rustTests, 'utf8').includes('an_unreachable_host_is_the_documented_503')) {
      problems.push('503 rust_backend_unavailable is not covered by native/gateway/tests/event_routes.rs');
    }
    const mismatches = [];
    for (const [tag, calls] of nodeEffects) {
      const rust = rustEffects.get(tag) || [];
      if (JSON.stringify(calls) !== JSON.stringify(rust)) {
        mismatches.push({ case: caseNames.get(tag) || tag, node: calls, rust });
      }
    }
    const details = path.join(work, 'effect-mismatches.json');
    fs.writeFileSync(details, JSON.stringify(mismatches, null, 2));
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
    }

    // Read/validation cases must not touch anything, and the two side-effect
    // carriers must have actually produced their effects.
    const silent = [
      'catalog', 'HEAD catalog', 'recent default limit', 'GET event-triggers',
      'GET event-rules', 'add rule without patterns', 'add rule with an unknown pattern',
      'add rule when the table is full',
      'update missing rule', 'events test refuses an alias', 'events test without a type',
      'triggers list of a missing session', 'add trigger to a missing session',
      'delete missing trigger', 'manual trigger test of an event rule',
      'manual trigger test of a missing trigger', 'annotation relay with no matching target',
    ];
    for (const name of silent) {
      const tag = [...caseNames.entries()].find(([, value]) => value === name)?.[0];
      if (!tag) { problems.push(`missing silent case ${name}`); continue; }
      const node = nodeEffects.get(tag) || [];
      const rust = rustEffects.get(tag) || [];
      if (node.length || rust.length) problems.push(`side effects on a read/refusal case: ${name}`);
    }
    const effectful = [
      ['add inject-prompt rule', 'persist'],
      ['add channel rule', 'check-channel'],
      ['add schedule trigger', 'mutate'],
      ['manual trigger test', 'bus-emit'],
      ['events test emits', 'hub-emit'],
    ];
    for (const [name, op] of effectful) {
      const tag = [...caseNames.entries()].find(([, value]) => value === name)?.[0];
      if (!tag) { problems.push(`missing effectful case ${name}`); continue; }
      const rust = rustEffects.get(tag) || [];
      if (!rust.some(call => call.op === op)) {
        problems.push(`${name}: rust side never recorded a ${op} effect`);
      }
    }

    if (problems.length) {
      for (const problem of problems) console.log(`[event-routes] ${problem}`);
      const problemFile = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(problemFile, JSON.stringify(problems, null, 2));
      return { ok: false, details: problemFile };
    }
    if (mismatches.length) {
      console.log(`[event-routes] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[event-routes] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
