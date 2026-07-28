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

function fixture({ chat, persisted, workHost = true, streamStatus, closeThrows = false } = {}) {
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
  createSessionLifecycleRuntime({
    sessions: new Map(), chatSessions, persistedSessions,
    directories: new Map([['d1', { id: 'd1', path: '/tmp/d1' }]]),
    invalidSessions: new Map(),
    sessionPersistence: { mutate: (_reason, fn) => fn(persistedSessions) },
    getChatStream: () => chatStream,
    getSessionWorkHost: () => (workHost ? sessionWorkHost : null),
    asyncHandler: handler => handler,
    destroySessionCascade: async () => ({ ok: true }),
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
  }).mountRoutes(app);

  const handler = app.routes.get('POST /api/sessions/:id/restart-spawn');
  assert.ok(handler, 'restart-spawn route is mounted');
  return { handler, calls, events, chatSessions };
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
