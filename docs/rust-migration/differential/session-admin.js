'use strict';
// Differential run for the thirteen session-admin routes retired from
// src/routes/session-admin.js:
//
//   GET  /api/v1/sessions
//   GET  /api/v1/sessions/:id
//   GET  /api/v1/directories/:id/workspace
//   GET  /api/sessions
//   POST /api/sessions/:id/reclassify
//   POST /api/sessions/:id/mark-task-done
//   POST /api/sessions/:id/mark-goal-achieved
//   POST /api/reclassify-all
//   GET  /api/directories/:id/sessions
//   GET  /api/directories/:id/workspace
//   GET  /api/sessions/:id
//   POST /api/debug/classify/:id
//   GET  /api/debug/classify-test-cases
//
// now answered by native/gateway/src/app/session_admin.rs (rules in
// native/core/src/session_admin.rs).
//
//   node docs/rust-migration/differential/session-admin.js \
//     <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-session-admin-routes.js) over the scripted world in
// tests/helpers/session-admin-scripted-world.js, behind the same public-session
// access guard server.js mounts on those paths (src/session/
// public-session-access.js). The Rust front door calls its host port
// (/api/__host/session-admin); the stub Node child here is the real
// src/routes/session-admin.js host composition (createSessionAdminRuntime →
// mountSessionAdminHostRoute) over the same world, so both sides read one set
// of facts and the comparison covers the split itself: what stayed in Node
// (records/directories Maps, classify task state, chat runtimes, transcripts,
// aux queue, dispatchStateAction/setTaskState writes) must feed the front door
// exactly the facts the retired handlers used.
//
// Nothing touches the clock, the filesystem or the network. Every corpus case
// gets its own session identity so the worlds cannot bleed across cases.
//
// Side effects are compared too: enqueueClassification (runClassifyNow),
// dispatchStateAction and setTaskState calls are recorded by the oracle
// in-process and by the stub in an NDJSON file, then compared per case in
// finalize(). A route that answers the same bytes but forgets the write (or
// writes twice) fails.
//
// No corpus case is expected to differ. Two things are worth calling out:
//
//   * OPTIONS Allow on the two shared paths (/api/sessions/:id and
//     /api/directories/:id/sessions) is the union over the whole app — the peer
//     PATCH/DELETE/POST handlers live in other Node modules. The front door
//     hardcodes that union; the Node side here registers the same methods (the
//     handler bodies are never called) so both sides answer the production
//     Allow list instead of the oracle-only one.
//   * A host outage makes the front door answer 503 rust_backend_unavailable
//     where the retired handler answered 500. That path cannot be reached from
//     this harness (the stub child is always up) and is covered by
//     native/gateway/tests/session_admin.rs.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const HOST_PATH = '/api/__host/session-admin';
const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const DIR = { id: 'd1', path: '/repo', name: 'Repo', label: 'Repo Label', baseBranch: 'main' };
const T0 = 1700000000000;

let worldPath = '';
let effectsPath = '';
let bag = null;
let legacy = null;
let upstreamText = '';
const nodeEffects = new Map();

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ── the scripted world ──────────────────────────────────────────────────────

function baseWorld(tag) {
  return {
    case: tag,
    records: [],
    directories: [{ ...DIR }],
    terminalSessions: {},
    chatSessions: {},
    taskStates: {},
    histories: {},
    historyThrows: [],
    stateTargets: {},
    chatLastActivity: {},
    mergeStates: {},
    cliStates: {},
    handoffs: {},
    cliAvailability: [],
    providerBaseUrls: {},
    invalidSessions: {},
    workspaceStatus: {},
    sessionSummaries: {},
    pendingNotes: {},
    aux: undefined,
  };
}

function rec(id, extra = {}) {
  return {
    id,
    dirId: 'd1',
    cli: 'claude',
    kind: 'chat',
    label: `Label ${id}`,
    cwd: `/repo/wt/${id}`,
    createdAt: T0,
    ...extra,
  };
}

function termRec(id, extra = {}) {
  return rec(id, { kind: 'terminal', ...extra });
}

function chatWorld(tag, extra, mutate) {
  const world = baseWorld(tag);
  world.records = [rec(tag, extra)];
  world.chatSessions[tag] = { clients: 1 };
  if (mutate) mutate(world, tag);
  return world;
}

function text(n, ch = 'x') {
  return ch.repeat(n);
}

function assistant(body, ts = '2024-01-02T03:04:05.000Z') {
  return { role: 'assistant', content: body, ts };
}

// ── corpus plumbing ─────────────────────────────────────────────────────────

let counter = 0;
const pending = [];

function useScenario(scenario) {
  return {
    before() {
      bag.apply(scenario);
      fs.writeFileSync(worldPath, JSON.stringify(scenario));
    },
    capture(response, side) {
      if (side.name !== 'node') return;
      nodeEffects.set(scenario.case, clone({
        classified: bag.effects.classified,
        dispatched: bag.effects.dispatched,
        writes: bag.effects.writes,
      }));
      bag.effects.classified.length = 0;
      bag.effects.dispatched.length = 0;
      bag.effects.writes.length = 0;
    },
  };
}

function add(name, buildRequest, buildWorld, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  const scenario = buildWorld ? buildWorld(tag) : baseWorld(tag);
  scenario.case = tag;
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) {
    if (hook === 'before') {
      const wrapped = hooks.before;
      hooks.before = async (side) => { await fn(side); wrapped(); };
    } else if (hook === 'capture') {
      const wrapped = hooks.capture;
      hooks.capture = (response, side) => { wrapped(response, side); fn(response, side); };
    } else {
      hooks[hook] = fn;
    }
  }
  pending.push([name, () => buildRequest(tag), hooks]);
}

// ── corpus ──────────────────────────────────────────────────────────────────

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const post = (url, body, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const options = (url) => ({ method: 'OPTIONS', url, headers: L });

  // ── OPTIONS: the Allow list of every migrated path ─────────────────────
  const optionPaths = [
    'v1 sessions', '/api/v1/sessions',
    'v1 session', '/api/v1/sessions/s1',
    'v1 workspace', '/api/v1/directories/d1/workspace',
    'sessions', '/api/sessions',
    'session', '/api/sessions/s1',
    'reclassify', '/api/sessions/s1/reclassify',
    'mark task done', '/api/sessions/s1/mark-task-done',
    'mark goal achieved', '/api/sessions/s1/mark-goal-achieved',
    'reclassify all', '/api/reclassify-all',
    'directory sessions', '/api/directories/d1/sessions',
    'directory workspace', '/api/directories/d1/workspace',
    'debug classify', '/api/debug/classify/s1',
    'debug cases', '/api/debug/classify-test-cases',
  ];
  for (let index = 0; index < optionPaths.length; index += 2) {
    add(`OPTIONS ${optionPaths[index]}`, () => options(optionPaths[index + 1]));
  }
  add('OPTIONS sessions with trailing slash', () => options('/api/sessions/'));
  add('OPTIONS session with trailing slash', () => options('/api/v1/sessions/s1/'));

  // ── GET /api/v1/sessions ───────────────────────────────────────────────
  add('v1 list projects every visible record',
    () => get('/api/v1/sessions'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [
        rec('a', { providerSelection: { mode: 'auto' } }),
        rec('b', {
          subagent: { providerId: 'p', model: 'm', effectiveModel: 'm2', inherited: true },
          unattended: { status: 'active', goal: 'ship', criteria: ['tests pass'], rounds: 2 },
          mergeState: undefined,
        }),
        termRec('t'),
        rec('hidden', { type: 'aux' }),
        rec('gw', { type: 'gateway' }),
        rec('bound', { taskBoundTaskId: 'task-1' }),
        rec('slot', { taskExecutionSlot: true }),
        rec('nostate', { workspaceState: 'hibernated', hibernatedAt: T0 }),
      ];
      world.chatSessions.a = { clients: 2, streaming: true };
      world.taskStates.b = { classifyState: 'D', goal: 'ship it' };
      world.mergeStates.b = { ahead: 2, behind: 1, dirty: true, mergeReady: false };
      return world;
    });
  add('v1 list of an empty table',
    () => get('/api/v1/sessions'),
    tag => baseWorld(tag));
  add('v1 list over 1KB negotiates gzip',
    () => get('/api/v1/sessions', { ...L, 'Accept-Encoding': 'gzip' }),
    (tag) => {
      const world = baseWorld(tag);
      for (let index = 0; index < 12; index += 1) {
        world.records.push(rec(`m${index}`, { label: `Multi ${index}`, model: 'claude-sonnet-4' }));
      }
      return world;
    });

  // ── GET /api/v1/sessions/:id ───────────────────────────────────────────
  add('v1 detail is the projected DTO',
    tag => get(`/api/v1/sessions/${tag}`),
    tag => chatWorld(tag, {
      providerSelection: { mode: 'pinned', providerId: 'openai' },
      subagent: { providerId: 'p', model: 'm' },
      effort: 'high',
      experimentalMode: 'beta',
    }, (world) => {
      world.chatSessions[tag] = { clients: 3, streaming: true };
      world.mergeStates[tag] = { ahead: 0, behind: 4, mergeReady: true };
    }));
  add('v1 detail addresses a task-bound session',
    tag => get(`/api/v1/sessions/${tag}`),
    tag => chatWorld(tag, { taskBoundTaskId: 'task-9' }));
  add('v1 detail addresses a hidden aux record',
    () => get('/api/v1/sessions/aux1'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('aux1', { type: 'aux', kind: 'chat' })];
      return world;
    });
  add('v1 detail missing session',
    () => get('/api/v1/sessions/nope'),
    tag => baseWorld(tag));
  add('v1 detail internal execution slot',
    () => get('/api/v1/sessions/slot'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('slot', { taskExecutionSlot: true })];
      return world;
    });
  add('v1 detail answers HEAD',
    tag => head(`/api/v1/sessions/${tag}`),
    tag => chatWorld(tag));

  // ── GET /api/v1/directories/:id/workspace ──────────────────────────────
  add('v1 workspace lifts the facts out of the session DTO',
    () => get('/api/v1/directories/d1/workspace'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('a'), rec('b', { workspaceState: 'hibernated' })];
      world.taskStates.a = { classifyState: 'D', goal: 'ship', taskId: 'tsk-1', phase: 'interact' };
      world.chatSessions.a = { clients: 1 };
      world.workspaceStatus.a = {
        status: 'running', lastActivity: T0, runStartedAt: T0 - 5000, currentFile: 'src/a.js',
      };
      world.sessionSummaries.a = { summary: 'did the thing', ts: T0 };
      world.pendingNotes.a = ['one', 'two'];
      world.invalidSessions.b = { reason: 'worktree missing' };
      return world;
    });
  add('v1 workspace skips hidden and task-bound records',
    () => get('/api/v1/directories/d1/workspace'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [
        rec('shown'),
        rec('hidden', { type: 'aux' }),
        rec('bound', { taskBoundTaskId: 't' }),
        rec('elsewhere', { dirId: 'd2' }),
      ];
      return world;
    });
  add('v1 workspace of an unknown directory',
    () => get('/api/v1/directories/nope/workspace'),
    tag => baseWorld(tag));

  // ── GET /api/sessions ──────────────────────────────────────────────────
  add('legacy list keeps the flat field order',
    () => get('/api/sessions'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [
        rec('a', { type: 'commander', providerSelection: { mode: 'auto' } }),
        termRec('t', { branch: 'multicc/t', worktreePath: '/repo/wt-t' }),
        rec('b'),
      ];
      world.chatSessions.a = { clients: 1 };
      world.terminalSessions.t = { clients: 2, lastActivity: T0 + 10 };
      world.chatLastActivity.a = T0 + 20;
      world.cliStates.a = [{ lane: 'claude', state: 'ready' }];
      world.handoffs.a = { lane: 'claude', phase: 'drain' };
      world.invalidSessions.b = { reason: 'gone' };
      return world;
    });
  add('legacy list prepends the aux runtime',
    () => get('/api/sessions'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('a'), rec('aux1', { type: 'aux', label: 'Helper' })];
      world.aux = { lastTaskTime: T0 + 5, clients: 2, processing: true, status: 'busy' };
      return world;
    });
  add('legacy list without an aux runtime',
    () => get('/api/sessions'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('a')];
      world.aux = 'none';
      return world;
    });
  add('legacy list with an idle aux runtime',
    () => get('/api/sessions'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('a'), rec('aux1', { type: 'aux' })];
      world.aux = { clients: 0, processing: false };
      return world;
    });

  // ── GET /api/sessions/:id ──────────────────────────────────────────────
  add('legacy detail keeps the flat field order',
    tag => get(`/api/sessions/${tag}`),
    tag => chatWorld(tag, {
      memory: 'remember this',
      provider: 'anthropic',
      providerSelection: { mode: 'pinned', providerId: 'anthropic' },
      cliAccounts: { claude: 'acc-1' },
      autoContinue: false,
      autoCommit: false,
      taskBoundTaskId: 'task-3',
    }, (world) => {
      world.providerBaseUrls[tag] = 'https://api.example.test';
      world.cliStates[tag] = [{ lane: 'claude', state: 'ready' }];
      world.cliAvailability = [{ cli: 'claude', available: true }];
      world.handoffs[tag] = { lane: 'claude', phase: 'idle' };
      world.chatSessions[tag] = { clients: 2 };
      world.chatLastActivity[tag] = T0 - 1000;
    }));
  add('legacy detail of a terminal session',
    () => get('/api/sessions/t1'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [termRec('t1', { cli: 'codex', kind: 'terminal' })];
      world.terminalSessions.t1 = { clients: 1, lastActivity: T0 + 7 };
      return world;
    });
  add('legacy detail of a hidden aux record',
    () => get('/api/sessions/aux1'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('aux1', { type: 'aux', kind: 'chat' })];
      return world;
    });
  add('legacy detail missing session',
    () => get('/api/sessions/nope'),
    tag => baseWorld(tag));
  add('legacy detail internal execution slot',
    () => get('/api/sessions/slot'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('slot', { taskExecutionSlot: true })];
      return world;
    });

  // ── the guard also fronts OPTIONS and the write verbs ──────────────────
  const slotWorld = (tag) => {
    const world = baseWorld(tag);
    world.records = [rec('slot', { taskExecutionSlot: true })];
    world.taskStates.slot = { classifyState: 'B', goal: 'g' };
    world.chatSessions.slot = { clients: 1 };
    world.histories.slot = [assistant(text(40))];
    return world;
  };
  add('OPTIONS session internal execution slot',
    () => options('/api/sessions/slot'),
    slotWorld);
  add('OPTIONS v1 session internal execution slot',
    () => options('/api/v1/sessions/slot'),
    slotWorld);
  add('reclassify internal execution slot',
    () => post('/api/sessions/slot/reclassify?force=true'),
    slotWorld);
  add('mark task done internal execution slot',
    () => post('/api/sessions/slot/mark-task-done'),
    slotWorld);

  // ── POST /api/sessions/:id/reclassify ──────────────────────────────────
  add('reclassify enqueues a fresh turn',
    tag => post(`/api/sessions/${tag}/reclassify`),
    tag => chatWorld(tag, {}, (world) => {
      world.histories[tag] = [assistant(text(30, 'a'))];
    }));
  add('reclassify skips a settled verdict',
    tag => post(`/api/sessions/${tag}/reclassify`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'D', goal: 'done' };
      world.histories[tag] = [assistant(text(30, 'a'))];
    }));
  add('reclassify force overrides a settled verdict',
    tag => post(`/api/sessions/${tag}/reclassify?force=true`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'D' };
      world.histories[tag] = [assistant(text(30, 'b'))];
    }));
  add('reclassify reads force case-insensitively',
    tag => post(`/api/sessions/${tag}/reclassify?force=TRUE`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'W' };
      world.histories[tag] = [assistant(text(30, 'c'))];
    }));
  add('reclassify rejects a short reply',
    tag => post(`/api/sessions/${tag}/reclassify`),
    tag => chatWorld(tag, {}, (world) => {
      world.histories[tag] = [assistant(text(9))];
    }));
  add('reclassify treats an unreadable transcript as empty',
    tag => post(`/api/sessions/${tag}/reclassify`),
    tag => chatWorld(tag, {}, (world) => {
      world.historyThrows = [tag];
    }));
  add('reclassify rejects an aux record',
    () => post('/api/sessions/aux1/reclassify'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('aux1', { type: 'aux' })];
      return world;
    });
  add('reclassify unknown session',
    () => post('/api/sessions/nope/reclassify'),
    tag => baseWorld(tag));
  add('reclassify enqueues a CJK reply',
    tag => post(`/api/sessions/${tag}/reclassify`),
    tag => chatWorld(tag, {}, (world) => {
      world.histories[tag] = [assistant(text(24, '中'))];
    }));

  // ── POST /api/sessions/:id/mark-task-done ──────────────────────────────
  add('mark task done is idempotent on a terminal verdict',
    tag => post(`/api/sessions/${tag}/mark-task-done`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'D', goal: 'g' };
    }));
  add('mark task done refuses a streaming session',
    tag => post(`/api/sessions/${tag}/mark-task-done`),
    tag => chatWorld(tag, {}, (world) => {
      world.chatSessions[tag] = { clients: 1, streaming: true };
      world.taskStates[tag] = { classifyState: 'W', goal: 'g' };
    }));
  add('mark task done dispatches the D transition',
    tag => post(`/api/sessions/${tag}/mark-task-done`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'W', goal: 'g', phase: 'work' };
    }));
  add('mark task done flags a terminal session',
    () => post('/api/sessions/t1/mark-task-done'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [termRec('t1')];
      world.taskStates.t1 = { classifyState: 'B' };
      return world;
    });
  add('mark task done unknown session',
    () => post('/api/sessions/nope/mark-task-done'),
    tag => baseWorld(tag));
  add('mark task done rejects an aux record',
    () => post('/api/sessions/aux1/mark-task-done'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('aux1', { type: 'aux' })];
      return world;
    });

  // ── POST /api/sessions/:id/mark-goal-achieved ──────────────────────────
  add('mark goal achieved without a state writer',
    tag => post(`/api/sessions/${tag}/mark-goal-achieved`),
    tag => chatWorld(tag, {}, (world) => {
      world.noSetTaskState = true;
      world.taskStates[tag] = { classifyState: 'D' };
    }));
  add('mark goal achieved requires a succeeded turn',
    tag => post(`/api/sessions/${tag}/mark-goal-achieved`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'W' };
    }));
  add('mark goal achieved is idempotent',
    tag => post(`/api/sessions/${tag}/mark-goal-achieved`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'D', goalState: 'achieved' };
    }));
  add('mark goal achieved writes the manual state',
    tag => post(`/api/sessions/${tag}/mark-goal-achieved`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'D', goalState: 'pending' };
    }));
  add('mark goal achieved unknown session',
    () => post('/api/sessions/nope/mark-goal-achieved'),
    tag => baseWorld(tag));

  // ── POST /api/reclassify-all ───────────────────────────────────────────
  add('reclassify all defaults to junk goals only',
    () => post('/api/reclassify-all'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [
        rec('junk', {}), rec('real'), rec('done'), rec('aux1', { type: 'aux' }),
        rec('gw', { type: 'gateway' }), rec('short'), rec('nochat'),
      ];
      world.taskStates.junk = { classifyState: 'B', goal: '<system>' };
      world.taskStates.real = { classifyState: 'B', goal: 'real goal' };
      world.taskStates.done = { classifyState: 'D', goal: '<system>' };
      world.histories.junk = [assistant(text(30))];
      world.histories.real = [assistant(text(30))];
      world.histories.done = [assistant(text(30))];
      world.histories.short = [assistant(text(5))];
      world.histories.nochat = [assistant(text(30))];
      world.chatSessions.junk = { clients: 1 };
      world.chatSessions.real = { clients: 1 };
      world.chatSessions.done = { clients: 1 };
      world.chatSessions.short = { clients: 1 };
      return world;
    });
  add('reclassify all with onlyJunk false sweeps everything unsettled',
    () => post('/api/reclassify-all', { onlyJunk: false }),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('junk'), rec('real')];
      world.taskStates.junk = { classifyState: 'B', goal: '<system>' };
      world.taskStates.real = { classifyState: 'B', goal: 'real goal' };
      world.histories.junk = [assistant(text(30))];
      world.histories.real = [assistant(text(30))];
      world.chatSessions.junk = { clients: 1 };
      world.chatSessions.real = { clients: 1 };
      return world;
    });
  add('reclassify all with onlyJunk true is explicit',
    () => post('/api/reclassify-all', { onlyJunk: true }),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('junk'), rec('real')];
      world.taskStates.junk = { classifyState: 'B', goal: '"<tag>"' };
      world.taskStates.real = { classifyState: 'B', goal: 'real' };
      world.histories.junk = [assistant(text(30))];
      world.histories.real = [assistant(text(30))];
      world.chatSessions.junk = { clients: 1 };
      world.chatSessions.real = { clients: 1 };
      return world;
    });
  add('reclassify all finds nothing to do',
    () => post('/api/reclassify-all', { onlyJunk: false }),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec('done')];
      world.taskStates.done = { classifyState: 'D' };
      world.histories.done = [assistant(text(30))];
      return world;
    });
  add('reclassify all without a parsed body',
    () => ({ method: 'POST', url: '/api/reclassify-all', headers: L, body: '' }),
    tag => baseWorld(tag));

  // ── GET /api/directories/:id/sessions ──────────────────────────────────
  add('directory sessions keep the raw record fields',
    () => get('/api/directories/d1/sessions'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [
        rec('a', { branch: 'multicc/a', worktreePath: '/repo/wt-a' }),
        termRec('t', { cli: 'codex' }),
        rec('hidden', { type: 'aux' }),
        rec('bound', { taskBoundTaskId: 'task-1' }),
        rec('slot', { taskExecutionSlot: true }),
        rec('elsewhere', { dirId: 'd2' }),
      ];
      world.chatSessions.a = { clients: 2 };
      world.chatLastActivity.a = T0 + 3;
      world.terminalSessions.t = { clients: 1, lastActivity: T0 + 4 };
      world.invalidSessions.a = { reason: 'worktree missing' };
      return world;
    });
  add('directory sessions of an unknown directory',
    () => get('/api/directories/nope/sessions'),
    tag => baseWorld(tag));

  // ── GET /api/directories/:id/workspace ─────────────────────────────────
  add('directory workspace keeps the legacy presenter order',
    () => get('/api/directories/d1/workspace'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [
        rec('a', { branch: 'multicc/a' }),
        termRec('t'),
        rec('hidden', { type: 'aux' }),
      ];
      world.taskStates.a = { classifyState: 'D', goal: 'ship', taskId: 'tsk-2', phase: 'work' };
      world.chatSessions.a = { clients: 1 };
      world.workspaceStatus.a = { status: 'running', lastActivity: T0, currentFile: 'a.js' };
      world.sessionSummaries.a = { summary: 'summary text', ts: T0 - 100 };
      world.pendingNotes.a = ['note'];
      world.terminalSessions.t = { clients: 2, lastActivity: T0 + 1 };
      return world;
    });
  add('directory workspace of an unknown directory',
    () => get('/api/directories/nope/workspace'),
    tag => baseWorld(tag));

  // ── POST /api/debug/classify/:id ───────────────────────────────────────
  add('debug classify runs the classifier',
    tag => post(`/api/debug/classify/${tag}`),
    tag => chatWorld(tag, {}, (world) => {
      world.histories[tag] = [assistant(text(60, 'k').replace(/k{10}/, 'kkkkkkkkk\n'))];
    }));
  add('debug classify force overrides a settled verdict',
    tag => post(`/api/debug/classify/${tag}?force=true`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'D' };
      world.histories[tag] = [assistant(text(40, 'f'))];
    }));
  add('debug classify refuses a settled session',
    tag => post(`/api/debug/classify/${tag}`),
    tag => chatWorld(tag, {}, (world) => {
      world.taskStates[tag] = { classifyState: 'D' };
      world.histories[tag] = [assistant(text(40, 's'))];
    }));
  add('debug classify requires an active chat',
    tag => post(`/api/debug/classify/${tag}`),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [rec(tag)];
      world.histories[tag] = [assistant(text(40, 'c'))];
      return world;
    });
  add('debug classify rejects a short reply',
    tag => post(`/api/debug/classify/${tag}`),
    tag => chatWorld(tag, {}, (world) => {
      world.histories[tag] = [assistant(text(9))];
    }));
  add('debug classify requires history',
    tag => post(`/api/debug/classify/${tag}`),
    tag => chatWorld(tag));
  add('debug classify unknown session',
    () => post('/api/debug/classify/nope'),
    tag => baseWorld(tag));

  // ── GET /api/debug/classify-test-cases ─────────────────────────────────
  add('debug cases filter and sort by the latest timestamp',
    () => get('/api/debug/classify-test-cases'),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [
        rec('older', { summary: 'old', lastActivity: T0 }),
        rec('newer', { summary: 'new' }),
        rec('term', { kind: 'terminal' }),
        rec('aux1', { type: 'aux' }),
        rec('short'),
        rec('nots'),
      ];
      world.taskStates.older = { classifyState: 'D', goal: 'old goal' };
      world.histories.older = [assistant(text(40, 'o'), '2024-01-01T00:00:00.000Z')];
      world.histories.newer = [assistant(text(50, 'n'), '2024-03-01T00:00:00.000Z')];
      world.histories.term = [assistant(text(40, 't'))];
      world.histories.aux1 = [assistant(text(40, 'a'))];
      world.histories.short = [assistant(text(39))];
      world.histories.nots = [{ role: 'assistant', content: text(45, 'z') }];
      return world;
    });
  add('debug cases on an empty table',
    () => get('/api/debug/classify-test-cases'),
    tag => baseWorld(tag));

  // ── malformed path ─────────────────────────────────────────────────────
  add('malformed percent escape is a request error',
    () => get('/api/sessions/%E0%A4%A'),
    tag => baseWorld(tag));

  return pending;
}

// ── the stub Node child ─────────────────────────────────────────────────────

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
const { buildDeps } = require(path.join(REPO, 'tests/helpers/session-admin-scripted-world'));
const { createSessionAdminRuntime } = require(path.join(REPO, 'src/routes/session-admin'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return {}; }
}

const bag = buildDeps({});
const runtime = createSessionAdminRuntime(bag.deps);
const app = express();
app.use((req, res, next) => {
  bag.apply(readWorld());
  res.on('finish', () => {
    const recorded = {
      classified: bag.effects.classified.splice(0),
      dispatched: bag.effects.dispatched.splice(0),
      writes: bag.effects.writes.splice(0),
    };
    if (recorded.classified.length || recorded.dispatched.length || recorded.writes.length) {
      fs.appendFileSync(effectsPath,
        JSON.stringify({ case: bag.world().case || null, recorded }) + '\\n');
    }
  });
  next();
});
app.use(express.json({ limit: '50mb' }));
runtime.mountRoutes(app);

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

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'session-admin',
  mount(app, { repo, work }) {
    worldPath = path.join(work, 'session-admin-world.json');
    effectsPath = path.join(work, 'session-admin-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify(baseWorld('initial')));
    legacy = require(path.join(repo, 'tests/helpers/legacy-session-admin-routes'));
    const world = require(path.join(repo, 'tests/helpers/session-admin-scripted-world'));
    bag = world.buildDeps(baseWorld('initial'));
    // server.js guards these paths before the routers run; the front door has
    // to reproduce both 404 shapes, so the Node side mounts the real guard.
    const { createErrorDto, requestContext } = require(path.join(repo, 'src/api-contract'));
    const { mountPublicSessionAccessGuard } =
      require(path.join(repo, 'src/session/public-session-access'));
    mountPublicSessionAccessGuard(app, {
      records: bag.deps.records,
      v1NotFound: (req, res) => res.status(404).json(createErrorDto({
        ...requestContext(req, res), message: 'session not found', code: 'session_not_found',
      })),
    });
    legacy.createSessionAdminRuntime(bag.deps).mountRoutes(app);
    // Methods the rest of server.js registers on the two shared paths; the
    // front door's Allow list covers the whole app, so the Node side has to as
    // well (their handlers are never called by this corpus).
    const present = (req, res) => res.status(204).end();
    app.patch('/api/sessions/:id', present);
    app.delete('/api/sessions/:id', present);
    app.post('/api/directories/:id/sessions', present);
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: () => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
  }),
  corpus,
  finalize({ work, views }) {
    fs.writeFileSync(path.join(work, 'views.json'), JSON.stringify(views, null, 2));
    const rustEffects = new Map();
    const text = fs.readFileSync(effectsPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!entry.case) continue;
      if (!rustEffects.has(entry.case)) {
        rustEffects.set(entry.case, { classified: [], dispatched: [], writes: [] });
      }
      const target = rustEffects.get(entry.case);
      target.classified.push(...entry.recorded.classified);
      target.dispatched.push(...entry.recorded.dispatched);
      target.writes.push(...entry.recorded.writes);
    }
    const mismatches = [];
    for (const [tag, node] of nodeEffects) {
      const rust = rustEffects.get(tag) || { classified: [], dispatched: [], writes: [] };
      if (JSON.stringify(node) !== JSON.stringify(rust)) {
        mismatches.push({ tag, node, rust });
      }
    }
    const details = path.join(work, 'effect-mismatches.json');
    fs.writeFileSync(details, JSON.stringify(mismatches, null, 2));
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
      console.log(`[session-admin] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[session-admin] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
