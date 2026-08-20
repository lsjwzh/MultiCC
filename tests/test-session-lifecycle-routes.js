'use strict';

// POST /api/sessions/:id/restart-spawn — the chat counterpart to the
// terminal-only /restart. It exists because "refresh the session list" cannot
// fix a session whose CLI process and whose in-memory runtime state disagree:
// the list re-reads the same stale state and the session keeps refusing work.
//
// The invariant that matters most here is ORDER. The scheduler slot has to be
// released through the canonical cancel BEFORE the process is destroyed —
// cancel the other way round and the scheduler is left parked on a turn whose
// runner has already vanished, which is the stuck state this route is for.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createSessionLifecycleRuntime } = require('../src/routes/session-lifecycle');

function fakeApp() {
  const routes = new Map();
  const register = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, post: register('POST'), delete: register('DELETE') };
}

async function invoke(handler, { params = {}, body = {}, query = {} } = {}) {
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  await handler({ params, body, query }, res);
  return response;
}

function fixture({ chat, persisted, workHost = true, streamStatus, closeThrows = false, codexRolloutGuard, cascadeResult } = {}) {
  const calls = [];
  const events = [];
  const chatSessions = new Map();
  const persistedSessions = new Map();
  if (chat) chatSessions.set('s1', chat);
  if (persisted) persistedSessions.set('s1', persisted);

  const chatStream = {
    status: () => (streamStatus === undefined
      ? { alive: true, busy: true, queued: 2, started: true, pid: 4242 }
      : streamStatus),
    close: id => {
      calls.push(`close:${id}`);
      if (closeThrows) throw new Error('close boom');
    },
  };
  const sessionWorkHost = {
    cancelActiveTurn: async (id, opts) => {
      calls.push(`cancel:${id}:${opts.reason}`);
      return { ok: true, classifyState: 'E' };
    },
  };

  const app = fakeApp();
  const runtime = createSessionLifecycleRuntime({
    sessions: new Map(), chatSessions, persistedSessions,
    directories: new Map([['d1', { id: 'd1', path: '/tmp/d1' }]]),
    invalidSessions: new Map(),
    sessionPersistence: { mutate: (_reason, fn) => fn(persistedSessions) },
    getChatStream: () => chatStream,
    getSessionWorkHost: () => (workHost ? sessionWorkHost : null),
    asyncHandler: handler => handler,
    destroySessionCascade: async record => { calls.push(`cascade:${record.id}`); return cascadeResult || { ok: true }; },
    tmuxKillSession: async () => {},
    appendEvent: (...args) => events.push(args),
    ensureDirGitReady: async () => ({ ok: true }),
    gitRelocateWorktree: async () => ({ ok: true }),
    gitWorktreeAdd: async () => ({ worktreePath: '/tmp/wt', branch: 'b' }),
    fs: { existsSync: () => true },
    broadcastTo: () => {},
    stopOutputCapture: async () => {},
    assignKillReason: () => {},
    createSession: async () => {},
    cwdForSession: () => '/tmp/d1',
    cleanupPushMonitor: () => {},
    getSessionGitRuntime: () => ({}),
    codexRolloutGuard,
  });
  runtime.mountRoutes(app);

  const handler = app.routes.get('POST /api/sessions/:id/restart-spawn');
  assert.ok(handler, 'restart-spawn route is mounted');
  const deleteHandler = app.routes.get('DELETE /api/sessions/:id');
  assert.ok(deleteHandler, 'DELETE route is mounted');
  return { handler, deleteHandler, runtime, calls, events, chatSessions, persistedSessions };
}

function liveChatSession() {
  return {
    cli: 'claude',
    isStreaming: true,
    claudeProc: { kill() { this.killed = true; }, killed: false },
    streamReplay: [{ type: 'assistant' }],
    lineBuf: 'half a json line',
    currentAssistantText: 'partial reply',
    currentToolCalls: [{ name: 'Bash' }],
    _activeTurn: { turnId: 't1' },
    _activeRunner: { runnerId: 'r1' },
  };
}

test('restart-spawn 404s when the session is unknown', async () => {
  const { handler } = fixture({});
  const res = await invoke(handler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 404);
});

test('restart-spawn refuses terminal sessions and points at /restart', async () => {
  const { handler, calls } = fixture({ persisted: { id: 's1', kind: 'terminal', dirId: 'd1' } });
  const res = await invoke(handler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /\/restart/);
  assert.deepEqual(calls, [], 'a rejected request must not tear anything down');
});

test('restart-spawn releases the scheduler slot BEFORE destroying the process', async () => {
  const { handler, calls } = fixture({
    chat: liveChatSession(),
    persisted: { id: 's1', kind: 'chat', dirId: 'd1', label: 'chat-1', cli: 'claude' },
  });
  const res = await invoke(handler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['cancel:s1:restart_spawn', 'close:s1'],
    'cancel must precede close, or the scheduler parks on a runner that no longer exists');
});

test('restart-spawn clears the runtime state the stream module does not own', async () => {
  const chat = liveChatSession();
  const proc = chat.claudeProc;
  const { handler } = fixture({
    chat, persisted: { id: 's1', kind: 'chat', dirId: 'd1', cli: 'claude' },
  });
  await invoke(handler, { params: { id: 's1' } });

  assert.equal(chat.isStreaming, false, 'a stale isStreaming keeps rejecting delivery as session-busy');
  assert.equal(chat.claudeProc, null);
  assert.equal(proc.killed, true, 'the non-stream child process is signalled too');
  assert.deepEqual(chat.streamReplay, []);
  assert.equal(chat.lineBuf, '');
  assert.equal(chat.currentAssistantText, '');
  assert.deepEqual(chat.currentToolCalls, []);
  assert.equal(chat._activeTurn, null);
  assert.equal(chat._activeRunner, null);
});

test('restart-spawn reports what it actually found, not just success', async () => {
  const { handler, events } = fixture({
    chat: liveChatSession(),
    persisted: { id: 's1', kind: 'chat', dirId: 'd1', label: 'chat-1', cli: 'claude' },
  });
  const res = await invoke(handler, { params: { id: 's1' } });
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.before,
    { alive: true, busy: true, queued: 2, pid: 4242, isStreaming: true });
  assert.equal(res.body.cancelled.classifyState, 'E');
  assert.equal(res.body.cli, 'claude');
  assert.equal(events.length, 1, 'the teardown is recorded on the directory timeline');
  assert.equal(events[0][1], 'session_spawn_restarted');
});

test('restart-spawn works on a session with no live stream entry', async () => {
  // The common stuck case: the process already died, so status() is null. The
  // route must still run the cancel and clear the runtime rather than bail.
  const chat = liveChatSession();
  const { handler, calls } = fixture({
    chat, streamStatus: null,
    persisted: { id: 's1', kind: 'chat', dirId: 'd1', cli: 'claude' },
  });
  const res = await invoke(handler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.before,
    { alive: false, busy: false, queued: 0, pid: null, isStreaming: true });
  assert.deepEqual(calls, ['cancel:s1:restart_spawn', 'close:s1']);
  assert.equal(chat.isStreaming, false);
});

test('restart-spawn still tears down when the work host is absent', async () => {
  const chat = liveChatSession();
  const { handler, calls } = fixture({
    chat, workHost: false,
    persisted: { id: 's1', kind: 'chat', dirId: 'd1', cli: 'claude' },
  });
  const res = await invoke(handler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelled, null);
  assert.deepEqual(calls, ['close:s1']);
  assert.equal(chat.isStreaming, false);
});

test('restart-spawn survives a failing stream close and still clears runtime', async () => {
  // A teardown that gives up halfway would leave the session in a worse state
  // than before — half-cancelled, still marked streaming, and no way back.
  const chat = liveChatSession();
  const { handler } = fixture({
    chat, closeThrows: true,
    persisted: { id: 's1', kind: 'chat', dirId: 'd1', cli: 'claude' },
  });
  const res = await invoke(handler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(chat.isStreaming, false);
});

test('restart-spawn force-archives the codex rollout and drops cliSessionId', async () => {
  // The restart-process button is the user's explicit "rebuild" action: the
  // native rollout must be archived even when it is UNDER the size budget, or
  // the lazy respawn resumes the same possibly-wedged history and the restart
  // visibly "does nothing" (the incident this guard was written for).
  const guardCalls = [];
  const archivedInfo = [{ file: '/h/.codex/sessions/rollout-t.jsonl', sizeBytes: 16, archivedTo: '/h/.codex/multicc-archived-rollouts/rollout-t.jsonl' }];
  const codexRolloutGuard = {
    enforce: (record, options) => {
      guardCalls.push([record.cli, options]);
      return { action: 'archived', cliSessionId: record.cliSessionId, archived: archivedInfo };
    },
  };
  const persisted = { id: 's1', kind: 'chat', dirId: 'd1', cli: 'codex', cliSessionId: 'thread-1' };
  const { handler, persistedSessions } = fixture({
    chat: { cli: 'codex', isStreaming: true }, persisted, codexRolloutGuard,
  });
  const res = await invoke(handler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(guardCalls, [['codex', { force: true }]]);
  assert.deepEqual(res.body.rolloutArchived, archivedInfo);
  assert.equal(persisted.cliSessionId, null, 'memory record cleared');
  assert.equal(persistedSessions.get('s1').cliSessionId, null, 'persisted store cleared via mutate');
});

test('DELETE refuses a task-bound session without force and tears nothing down', async () => {
  // A task-bound hidden session is the task's resume file. The fleet never
  // lists it, so a DELETE reaching this route is a sweep script, not a UI
  // click — default-refuse so bulk cleanup cannot orphan task chat history.
  const persisted = { id: 's1', kind: 'chat', dirId: 'd1', taskBoundTaskId: 't-1' };
  const { deleteHandler, calls, persistedSessions } = fixture({ persisted });
  const res = await invoke(deleteHandler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /task-bound/);
  assert.match(res.body.error, /force=1/);
  assert.deepEqual(calls, [], 'a refused delete must not cascade');
  assert.ok(persistedSessions.has('s1'), 'the record survives');
});

test('DELETE force=1 proceeds on a task-bound session (operator hard reset)', async () => {
  // force=1 is the deliberate escape hatch: the board re-creates the session
  // on next use and the cold-start seed re-walls it from the task ledger.
  const persisted = { id: 's1', kind: 'chat', dirId: 'd1', taskBoundTaskId: 't-1' };
  const { deleteHandler, calls, persistedSessions } = fixture({ persisted });
  const res = await invoke(deleteHandler, { params: { id: 's1' }, query: { force: '1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['cascade:s1']);
  assert.equal(persistedSessions.has('s1'), false, 'record removed');
});

test('DELETE still removes ordinary chat sessions without force', async () => {
  const persisted = { id: 's1', kind: 'chat', dirId: 'd1' };
  const { deleteHandler, calls, persistedSessions } = fixture({ persisted });
  const res = await invoke(deleteHandler, { params: { id: 's1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['cascade:s1']);
  assert.equal(persistedSessions.has('s1'), false);
});

test('restart-spawn leaves non-codex sessions and guard failures untouched', async () => {
  // claude: the guard skips, so classic --resume behavior is preserved.
  const claudePersisted = { id: 's1', kind: 'chat', dirId: 'd1', cli: 'claude', cliSessionId: 'uuid-1' };
  const claudeRes = await invoke(fixture({
    chat: liveChatSession(), persisted: claudePersisted,
    codexRolloutGuard: { enforce: () => ({ action: 'skipped' }) },
  }).handler, { params: { id: 's1' } });
  assert.equal(claudeRes.body.rolloutArchived, null);
  assert.equal(claudePersisted.cliSessionId, 'uuid-1');

  // codex with a failing guard: restart still succeeds (fail-open).
  const codexPersisted = { id: 's1', kind: 'chat', dirId: 'd1', cli: 'codex', cliSessionId: 'thread-1' };
  const failRes = await invoke(fixture({
    chat: { cli: 'codex', isStreaming: true }, persisted: codexPersisted,
    codexRolloutGuard: { enforce: () => ({ action: 'error', error: 'boom' }) },
  }).handler, { params: { id: 's1' } });
  assert.equal(failRes.statusCode, 200);
  assert.equal(failRes.body.rolloutArchived, null);
  assert.equal(codexPersisted.cliSessionId, 'thread-1', 'a guard failure never clears the session id');
});

/* ── releaseTaskBoundSession: the archive-time disposal primitive ── */

test('releaseTaskBoundSession disposes like the DELETE branch and reports', async () => {
  const persisted = { id: 's1', kind: 'chat', dirId: 'd1', taskBoundTaskId: 't-1', label: '任务 · X' };
  const { runtime, calls, events, persistedSessions } = fixture({ persisted });
  const result = await runtime.releaseTaskBoundSession('s1');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['cascade:s1'], 'full cascade teardown, exactly like a delete');
  assert.equal(persistedSessions.has('s1'), false, 'record removed durably');
  assert.equal(events.length, 1, 'the release is observable on the directory timeline');
  assert.equal(events[0][1], 'task_bound_session_released');
});

test('releaseTaskBoundSession refuses missing and non-bound sessions', async () => {
  const { runtime, calls } = fixture({ persisted: { id: 's1', kind: 'chat', dirId: 'd1' } });
  assert.deepEqual(await runtime.releaseTaskBoundSession('s1'), { ok: false, code: 'not_task_bound' });
  assert.deepEqual(await runtime.releaseTaskBoundSession('nope'), { ok: false, code: 'not_found' });
  assert.deepEqual(calls, [], 'a refused release tears nothing down');
});

test('releaseTaskBoundSession surfaces a blocked cascade without touching the record', async () => {
  // e.g. an active run or a dirty worktree: the DELETE branch refuses, so the
  // archive keeps the binding — a surviving session is never dangled.
  const persisted = { id: 's1', kind: 'chat', dirId: 'd1', taskBoundTaskId: 't-1' };
  const blocked = { ok: false, blocked: true, reasons: ['active'] };
  const { runtime, events, persistedSessions } = fixture({ persisted, cascadeResult: blocked });
  const result = await runtime.releaseTaskBoundSession('s1');
  assert.deepEqual(result, blocked);
  assert.ok(persistedSessions.has('s1'), 'record survives a blocked release');
  assert.equal(events.length, 0, 'no release event for a kept session');
});

test('mountRoutes returns the runtime itself — chainable host wiring', () => {
  // server.js wires `createSessionLifecycleRuntime({...}).mountRoutes(app)` and
  // reads `.releaseTaskBoundSession` off the result. When mountRoutes returned
  // undefined that read threw at module load and the server could not boot
  // (6a068f3). Pin the chain: same object back, port surface intact.
  const { runtime } = fixture();
  const chained = runtime.mountRoutes(fakeApp());
  assert.equal(chained, runtime, 'mountRoutes must return the runtime, not undefined');
  assert.equal(typeof chained.releaseTaskBoundSession, 'function');
});
