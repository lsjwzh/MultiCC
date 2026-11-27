'use strict';
// Differential run for the one cross-CLI route retired from
// src/cli/switch-runtime.js:
//
//   POST /api/sessions/:id/switch-cli
//
// now answered by native/gateway/src/app/cli_switch.rs (entry policy in
// multicc_core::cli_switch_runtime::plan("manualGate", …)).
//
//   node docs/rust-migration/differential/cli-switch.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen retired handler
// (tests/helpers/legacy-cli-switch-routes.js) over the deterministic world in
// the same helper (createCliSwitchWorld). The Rust front door calls its host
// port (/api/__host/cli-switch); the stub Node child here is the real
// src/cli/switch-runtime.js composition over the same world, so both sides see
// one set of facts and the comparison covers the split itself: what stayed in
// Node (session object identity, the preparations Map, the signature/TOCTOU
// comparison across awaits, persistence transactions, broadcasts) must feed
// the front door exactly what the retired handler used.
//
// Nothing touches real git, the filesystem, the clock or the network. Every
// case gets its own session id, so the preparations Map and the session table
// never leak between cases.
//
// Also compared: the side effects each side recorded per case (mutate sources,
// broadcasts, appendMessage/Event, cancel/kill/attempt bookkeeping) and the
// host operations the Rust side issued (facts / noop / switch). The four
// manualGate refusals must issue `facts` and nothing else.
//
// Documented difference (front-door-only condition, no Node oracle): when the
// Node child is unreachable the front door answers 503
// {error:"CLI 切换接口尚未就绪，请更新原生模块",code:"rust_backend_unavailable"}.
// The retired route had no such state (a dead Node served nothing at all); it is
// covered by native/gateway/tests/cli_switch.rs and is not part of this corpus.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const HOST_PATH = '/api/__host/cli-switch';
const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

let worldPath = '';
let effectsPath = '';
let hostCallsPath = '';
let readyPath = '';
let nodeWorld = null;
let current = null;
let upstreamText = '';
const nodeCases = new Map();
const cases = [];
let counter = 0;
const REFUSALS = new Set();
const INTERNAL = new Set();

function readWorld(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

// `/healthz` is answered by the front door itself, so the lib's readiness
// probe does not prove the Node child is listening yet. The stub writes a
// marker after its internal listener binds; the Rust side's first request
// waits for it (a host call made before the child listens is a legitimate 503).
async function waitForStub() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyPath)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('stub node child never signalled ready');
}

// ── scenarios ───────────────────────────────────────────────────────────────

function chatSession(tag, extra = {}) {
  return {
    id: tag, dirId: 'd1', kind: 'chat', type: 'chat', cli: 'claude', label: `Label ${tag}`,
    branch: `multicc/${tag}`, cliSessionId: 'claude-native', model: 'claude-model',
    effort: 'high', provider: 'claude-provider', subagent: null, agent: 'reviewer',
    ...extra,
  };
}

function scenario(tag, session, extra = {}) {
  return { case: tag, session, ...extra };
}

/**
 * name, buildRequest(tag), buildScenario(tag), hooks
 */
function add(name, buildRequest, buildScenario, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  if (extra.refusal) REFUSALS.add(tag);
  if (extra.internal) INTERNAL.add(tag);
  const scenarioFor = () => buildScenario(tag);
  const hooks = {
    async before(side) {
      if (side.name === 'rust') await waitForStub();
      // A body-parser rejection never reaches the world middleware, so its
      // effects array would still hold the previous case's entries.
      if (nodeWorld) nodeWorld.effects.length = 0;
      fs.writeFileSync(worldPath, JSON.stringify(scenarioFor()));
    },
    capture(response, side) {
      if (side.name !== 'node') return;
      const effects = nodeWorld.effects.slice();
      const { session, chat } = nodeWorld.state.scenario;
      if (chat?.streamReplay) {
        effects.push({ replaySize: nodeWorld.state.chatSessions.get(session.id).streamReplay.length });
      }
      nodeCases.set(tag, effects);
    },
  };
  if (extra.expectedDifference) hooks.expectedDifference = extra.expectedDifference;
  cases.push([name, () => buildRequest(tag), hooks]);
}

const post = (url, body) => ({
  method: 'POST', url,
  headers: { ...L, 'Content-Type': 'application/json' },
  body: JSON.stringify(body === undefined ? {} : body),
});

function corpus() {
  const switchUrl = tag => `/api/sessions/${tag}/switch-cli`;

  // OPTIONS: Express's automatic answer for the single registered method.
  add('OPTIONS allows POST',
    tag => ({ method: 'OPTIONS', url: switchUrl(tag), headers: L }),
    tag => scenario(tag, chatSession(tag)));

  // publicSessionAccessGuard: an internal execution slot is invisible.
  add('OPTIONS on an internal slot is a 404',
    tag => ({ method: 'OPTIONS', url: switchUrl(tag), headers: L }),
    tag => scenario(tag, chatSession(tag, { taskExecutionSlot: true })), { internal: true });
  add('POST on an internal slot is a 404',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag, { taskExecutionSlot: true })), { internal: true });

  // The four manualGate refusals (facts only, no side effect).
  add('missing session is a 404',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, null), { refusal: true });
  add('an aux system session is a 400',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag, { type: 'aux' })), { refusal: true });
  add('a gateway system session is a 400',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag, { type: 'gateway' })), { refusal: true });
  add('a non-chat session is a 400',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag, { kind: 'terminal' })), { refusal: true });
  add('an unsupported cli is a 400',
    tag => post(switchUrl(tag), { cli: 'unknown' }),
    tag => scenario(tag, chatSession(tag)), { refusal: true });
  add('an empty body is an unsupported cli 400',
    tag => post(switchUrl(tag), {}),
    tag => scenario(tag, chatSession(tag)), { refusal: true });

  // noop: the same target CLI.
  add('same cli is a noop',
    tag => post(switchUrl(tag), { cli: 'claude' }),
    tag => scenario(tag, chatSession(tag), { chat: { streamReplay: [{ type: 'stream_event' }] } }));
  add('noop ignores the already-set pending handoff',
    tag => post(switchUrl(tag), { cli: 'claude' }),
    tag => scenario(tag, chatSession(tag, { pendingCliHandoff: { id: 'handoff_old', fromCli: 'codex' } })));

  // switch: the whole post-gate handler stays in one Node round trip.
  add('switch claude to codex',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag)));
  add('switch trims and lower-cases the cli',
    tag => post(switchUrl(tag), { cli: '  CODEX  ' }),
    tag => scenario(tag, chatSession(tag)));
  add('switch fresh=1 is truthy',
    tag => post(switchUrl(tag), { cli: 'codex', fresh: '1' }),
    tag => scenario(tag, chatSession(tag)));
  add('switch with an unavailable target is a 400',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag), {
      availability: { claude: { available: true }, codex: { available: false } },
    }));
  add('a pending configuration queues the switch',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag, {
      pendingConfiguration: {
        cli: 'opencode', fresh: false,
        profile: { model: 'pending-model', effort: 'xhigh', provider: 'opencode-default', subagent: null },
      },
    })));
  add('a session changed during preparation is a 409',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag), { conflict: true }));
  add('a persistence failure is a 500',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag), { persistThrows: 'http.switch-cli' }));
  // The host port answers ok:false; the front door replays safeErrorHandler, so
  // the thrown error's own code survives while its message does not.
  add('a coded persistence failure keeps the error code',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag), {
      persistThrows: 'http.switch-cli', persistThrowShape: 'coded',
    }));

  // The body parser and the Express route's own path rules.
  add('an invalid JSON body is a 400',
    tag => ({ method: 'POST', url: switchUrl(tag), headers: { ...L, 'Content-Type': 'application/json' }, body: '{' }),
    tag => scenario(tag, chatSession(tag)), { refusal: true });
  add('the :id is URI-decoded',
    () => post('/api/sessions/s%201/switch-cli', { cli: 'claude' }),
    tag => scenario(tag, chatSession('s 1')));
  add('path literals and trailing slash match case-insensitively',
    tag => post(`/api/SESSIONS/${tag}/Switch-CLI/`, { cli: 'claude' }),
    tag => scenario(tag, chatSession(tag)));

  // Side-effect bookkeeping that must match the retired handler exactly.
  add('switch cancels classify and clears the auto-provider reservation',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag, { autoProviderLastRoute: 'codex' }), {
      chat: {
        cli: 'claude', isStreaming: false, claudeProc: null, _activeRunner: null,
        streamReplay: [{ type: 'stream_event' }],
      },
    }));
  add('a busy background task defers instead of switching',
    tag => post(switchUrl(tag), { cli: 'codex' }),
    tag => scenario(tag, chatSession(tag), { backgroundActive: true }));

  return cases;
}

// ── side-effect and host-op accounting ──────────────────────────────────────

function normalize(text) {
  return text.replace(ISO, '"<iso>"');
}

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/native/binding')).authSecurity;
const { connectAuthControl } = require(path.join(REPO, 'src/native/binding')).gatewayChild;
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const { createCliSwitchWorld } = require(path.join(REPO, 'tests/helpers/legacy-cli-switch-routes'));
const { createCliSwitchRuntime } = require(path.join(REPO, 'src/cli/switch-runtime'));
const { createWsHost, createChatReplayHub } = require(path.join(REPO, 'src/native/binding')).wsHost;
const { asyncHandler } = require(path.join(REPO, 'src/http-errors'));
const { mountPublicSessionAccessGuard } = require(path.join(REPO, 'src/native/binding')).getNative().sessionPublicAccessApi();

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;
const hostCallsPath = process.env.STUB_HOST_CALLS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return {}; }
}

const world = createCliSwitchWorld();
const replay = createChatReplayHub({ host: createWsHost() });
const runtime = createCliSwitchRuntime({ ...world.deps, clearReplay: replay.clear });
let activeCase;
const app = express();
app.use((req, res, next) => {
  const scenario = readWorld();
  const frames = scenario.chat?.streamReplay;
  if (frames) {
    delete scenario.chat.streamReplay;
    if (activeCase !== scenario.case) {
      for (const frame of frames) {
        if (!replay.push(scenario.session.id, frame)) throw new Error('无法初始化差分用例的回放缓冲');
      }
    }
  }
  activeCase = scenario.case;
  world.apply(scenario);
  res.on('finish', () => {
    const effects = world.effects.splice(0);
    if (frames && (req.body?.op === 'noop' || req.body?.op === 'switch')) {
      effects.push({ replaySize: replay.size(scenario.session.id) });
    }
    if (effects.length) {
      fs.appendFileSync(effectsPath,
        JSON.stringify({ case: world.state.scenario.case || null, effects }) + '\\n');
    }
  });
  next();
});
mountPublicSessionAccessGuard(app, { records: world.records });
app.use(express.json({ limit: '50mb' }));
// After the body parser, so the op is on the record without consuming the
// stream body-parser still needs. Account every host operation: entry
// refusals must issue facts and nothing else.
app.use('/api/__host/cli-switch', (req, _res, next) => {
  fs.appendFileSync(hostCallsPath,
    JSON.stringify({ case: world.state.scenario.case || null, op: req.body && req.body.op }) + '\\n');
  next();
});
runtime.mountRoutes(app, asyncHandler);

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
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1', () => {
  if (process.env.STUB_READY) fs.writeFileSync(process.env.STUB_READY, 'ready');
});
`;
}

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'cli-switch',
  mount(app, { repo, work }) {
    worldPath = path.join(work, 'cli-switch-world.json');
    effectsPath = path.join(work, 'cli-switch-effects.ndjson');
    hostCallsPath = path.join(work, 'cli-switch-host-calls.ndjson');
    readyPath = path.join(work, 'cli-switch-stub-ready');
    try { fs.unlinkSync(readyPath); } catch (_) { /* absent */ }
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(hostCallsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify({ case: 'initial', session: null }));
    const helper = require(path.join(repo, 'tests/helpers/legacy-cli-switch-routes'));
    const { asyncHandler } = require(path.join(repo, 'src/http-errors'));
    const { mountPublicSessionAccessGuard } = require(path.join(repo, 'tests/helpers/legacy-public-session-access'));
    nodeWorld = helper.createCliSwitchWorld();
    app.use((req, _res, next) => {
      nodeWorld.apply(readWorld(worldPath));
      next();
    });
    mountPublicSessionAccessGuard(app, { records: nodeWorld.records });
    current = helper.createLegacyCliSwitchRoutes({
      app, asyncHandler, options: nodeWorld.deps,
    });
    upstreamText = upstreamSource(repo);
  },
  get upstream() { return upstreamText; },
  gatewayEnv: () => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
    STUB_HOST_CALLS: hostCallsPath,
    STUB_READY: readyPath,
  }),
  normalize,
  // A queued switch stamps `updatedAt` with the real clock, so the two sides
  // hash different raw bodies into their ETag even though the normalized
  // bodies agree. The ETag is a pure function of the body, so it carries no
  // extra information here; drop it only for those views.
  normalizeView(view) {
    if (view.body.includes('"<iso>"')) delete view.headers.etag;
    return view;
  },
  corpus,
  finalize({ work }) {
    // 1. side effects, per case
    const rustEffects = new Map();
    for (const line of fs.readFileSync(effectsPath, 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!entry.case) continue;
      if (!rustEffects.has(entry.case)) rustEffects.set(entry.case, []);
      rustEffects.get(entry.case).push(...entry.effects);
    }
    const mismatches = [];
    for (const [tag, node] of nodeCases) {
      const rust = rustEffects.get(tag) || [];
      if (JSON.stringify(node) !== JSON.stringify(rust)) mismatches.push({ tag, node, rust });
    }
    fs.writeFileSync(path.join(work, 'effect-mismatches.json'), JSON.stringify(mismatches, null, 2));

    // 2. host operations, per case
    const ops = new Map();
    for (const line of fs.readFileSync(hostCallsPath, 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!entry.case) continue;
      if (!ops.has(entry.case)) ops.set(entry.case, []);
      ops.get(entry.case).push(entry.op);
    }
    const counts = { facts: 0, noop: 0, switch: 0, other: 0 };
    for (const list of ops.values()) {
      for (const op of list) counts[op] === undefined ? counts.other += 1 : counts[op] += 1;
    }
    const refusals = [...REFUSALS].map(tag => {
      const list = ops.get(tag) || [];
      return { tag, factsOnly: list.length > 0 && list.every(op => op === 'facts'), ops: list };
    });
    const internal = [...INTERNAL].map(tag => {
      const list = ops.get(tag) || [];
      return { tag, factsOnly: list.length > 0 && list.every(op => op === 'facts'), ops: list };
    });
    const badRefusals = refusals.filter(item => !item.factsOnly);
    const badInternal = internal.filter(item => !item.factsOnly);

    fs.writeFileSync(path.join(work, 'host-ops.json'),
      JSON.stringify({ counts, refusals, internal }, null, 2));
    for (const item of mismatches) console.log(JSON.stringify(item));
    if (badRefusals.length) console.log(JSON.stringify({ refusals: badRefusals }));
    if (badInternal.length) console.log(JSON.stringify({ internal: badInternal }));
    console.log(`[cli-switch] host ops facts ${counts.facts}, noop ${counts.noop}, switch ${counts.switch}`
      + `; entry refusals facts-only ${refusals.length - badRefusals.length}/${refusals.length}`
      + `; internal slots facts-only ${internal.length - badInternal.length}/${internal.length}`);
    console.log(`[cli-switch] side effects identical in ${nodeCases.size - mismatches.length}/${nodeCases.size} case(s)`);
    const ok = mismatches.length === 0 && badRefusals.length === 0 && badInternal.length === 0;
    return { ok, details: path.join(work, 'host-ops.json') };
  },
});
