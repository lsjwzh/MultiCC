'use strict';

// The thirteen public session-admin routes are answered by the Rust front door
// (native/gateway/src/app/session_admin.rs, rules in
// native/core/src/session_admin.rs). What is left in Node is the loopback host
// port the front door queries for process-local facts and effects. This suite
// covers that contract; the route semantics themselves are covered by
// native/gateway/tests/session_admin.rs and
// docs/rust-migration/differential/session-admin.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createErrorDto, requestContext, withApiMeta } = require('../src/api-contract');
const { GOAL_STATES } = require('../src/classify/vocab');
const {
  assistantText,
  latestAssistant,
  latestStringAssistant,
  createSessionAdminRuntime,
} = require('../src/routes/session-admin');
const { HOST_PATH } = require('../src/routes/session-admin-host');

function createFakeApp() {
  const routes = new Map();
  const register = method => (route, handler) => {
    const key = `${method} ${route}`;
    assert.equal(routes.has(key), false, `route is registered once: ${key}`);
    routes.set(key, handler);
  };
  return { routes, get: register('GET'), post: register('POST') };
}

/** The retired public routes; none of them may be registered in Node again. */
const RETIRED = [
  'GET /api/v1/sessions',
  'GET /api/v1/sessions/:id',
  'GET /api/v1/directories/:id/workspace',
  'GET /api/sessions',
  'POST /api/sessions/:id/reclassify',
  'POST /api/sessions/:id/mark-task-done',
  'POST /api/sessions/:id/mark-goal-achieved',
  'POST /api/reclassify-all',
  'GET /api/directories/:id/sessions',
  'GET /api/directories/:id/workspace',
  'GET /api/sessions/:id',
  'POST /api/debug/classify/:id',
  'GET /api/debug/classify-test-cases',
];

function createFixture(overrides = {}) {
  const records = new Map([
    ['s1', {
      id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', label: 'Chat',
      createdAt: 100, model: 'model-1', provider: 'provider-1',
      experimentalMode: 'tui-chat-mirror',
      rolePrompt: 'legacy-only prompt', cwd: '/private/worktree',
      rolePresetId: 'testing__testing-engineer',
      // A saved Auto pool: the canonical providerSelectionDto projects it back
      // with the defaults it fills in (enabled/preferMaxQuota/allowCrossTrust).
      providerSelection: {
        version: 1, mode: 'auto', protocol: 'anthropic',
        candidates: [
          { providerId: 'provider-1', model: 'model-1', priority: 1 },
          { providerId: 'provider-2', model: 'model-2', priority: 2 },
        ],
        maxAttempts: 2, sticky: true,
      },
      taskState: { classifyState: 'D', goal: 'done goal', phase: 'done' },
      cliSessionId: 'native-secret', worktreePath: '/private/worktree',
    }],
    ['t1', {
      id: 't1', dirId: 'd1', cli: 'codex', kind: 'terminal', label: 'Terminal',
      createdAt: 200, cwd: '/private/terminal', branch: 'feature',
      taskState: { classifyState: 'C', goal: '[auto] continue', phase: 'implementation' },
    }],
    ['__aux__', {
      id: '__aux__', type: 'aux', kind: 'chat', cwd: '/private/aux',
      createdAt: 50, label: 'AI Assistant',
    }],
  ]);
  const terminalSessions = new Map([
    ['t1', { cwd: '/runtime/terminal', createdAt: 210, lastActivity: 220, clients: new Set([{}]) }],
  ]);
  const chatSessions = new Map([
    ['s1', { clients: new Set([{}]), isStreaming: false, currentAssistantText: '' }],
  ]);
  const directories = new Map([
    ['d1', { id: 'd1', name: 'Directory', path: '/private/repository' }],
  ]);
  const history = new Map([
    ['s1', [
      { role: 'assistant', content: 'older assistant response that is long enough', ts: 1000 },
      { role: 'assistant', content: [{ type: 'text', text: 'newest structured assistant response long enough' }], ts: 2000 },
    ]],
    ['t1', [{ role: 'assistant', content: 'terminal assistant response long enough to classify', ts: 1500 }]],
  ]);
  const effects = { dispatched: [], writes: [], classified: [], warned: [], failed: [] };
  const queue = {
    clients: new Set([{}]),
    processing: false,
    lastTaskTime: 1234,
    getStatus: () => ({ state: 'idle' }),
  };
  const deps = {
    records,
    resolveStateTarget: overrides.resolveStateTarget,
    terminalSessions,
    chatSessions,
    directories,
    logger: {
      warn: (message, detail) => effects.warned.push({ message, detail }),
      error: (message, op) => effects.failed.push({ message, op }),
    },
    cwdForSession: record => `/session/${record.id}`,
    chatLastActivity: () => new Date(3000),
    effectiveSessionModel: record => record.model || 'effective-model',
    effectiveSessionEffort: () => 'high',
    serializeSubagent: value => value || null,
    mergeStateCached: () => ({ ahead: 0, behind: 0, dirty: false }),
    cliStateSummary: () => ({ claude: { available: true } }),
    cliHandoffSummary: () => null,
    cliAvailabilitySummary: () => ({ claude: true, codex: true }),
    sessionProviderBaseUrl: record => record?.provider ? `https://${record.provider}.example.com` : null,
    getInvalidSession: id => id === 't1' ? 'test-invalid' : null,
    getWorkspaceStatus: id => id === 's1'
      ? { status: 'running', lastActivity: 3000, runStartedAt: 2500, runEndedAt: null }
      : null,
    getSessionSummary: id => id === 's1' ? { summary: 'summary', ts: 2800 } : null,
    getTaskState: record => record?.taskState || {},
    setTaskState: (id, patch) => {
      const record = records.get(id);
      record.taskState = { ...(record.taskState || {}), ...patch };
      effects.writes.push({ id, patch });
      return record.taskState;
    },
    pendingNotesFor: id => id === 's1' ? [{ id: 'note' }] : [],
    getAuxRuntime: () => ({ id: '__aux__', queue }),
    loadChatHistory: overrides.loadChatHistory || (id => history.get(id) || []),
    viewChatHistory: overrides.viewChatHistory,
    isInjectedOrJunkGoal: goal => String(goal || '').startsWith('[auto]'),
    buildClassifySystemPrompt: goal => `system:${goal}`,
    buildClassifyConversation: (id, reply) => `conversation:${id}:${reply}`,
    parseClassifyResult: text => ({ state: text.endsWith('C') ? 'continue' : 'waiting' }),
    dispatchStateAction: (action, context) => effects.dispatched.push({ action, context }),
    runClassifyNow: (chat, id, options) => {
      effects.classified.push({
        id,
        manual: !!(options && options.manual === true),
        text: chat?.currentAssistantText ?? null,
      });
    },
    createErrorDto,
    requestContext,
    withApiMeta,
  };
  const runtime = createSessionAdminRuntime(deps);
  const app = createFakeApp();
  runtime.mountRoutes(app);
  return { app, runtime, deps, records, chatSessions, directory: directories.get('d1'), effects };
}

/** Calls the host route the way the front door does: loopback peer, JSON body. */
function callHost(app, body, options = {}) {
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function', 'host port is mounted');
  const remoteAddress = options.remoteAddress || '127.0.0.1';
  const req = {
    body,
    headers: { host: options.host || 'localhost' },
    socket: { remoteAddress },
    connection: { remoteAddress },
  };
  let settle;
  const answered = new Promise(resolve => { settle = resolve; });
  const res = {
    statusCode: 200,
    status(code) { res.statusCode = code; return res; },
    json(value) { settle({ status: res.statusCode, body: value }); return res; },
  };
  handler(req, res);
  return answered;
}

test('assistant extraction preserves string and structured legacy history', () => {
  assert.equal(assistantText({ role: 'user', content: 'ignored' }), '');
  assert.equal(assistantText({ role: 'assistant', content: 'plain' }), 'plain');
  assert.equal(assistantText({
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'visible' }],
  }), 'visible');
  assert.deepEqual(latestAssistant([
    { role: 'assistant', content: 'long enough first response', ts: 1 },
    { role: 'assistant', content: 'short', ts: 2 },
  ], 20), { text: 'long enough first response', ts: 1 });
  assert.deepEqual(latestAssistant([
    { role: 'assistant', content: 'supported older response', ts: 1 },
    { role: 'assistant', content: { unsupported: true }, ts: 2 },
  ], 0), { text: 'supported older response', ts: 1 });
  assert.equal(latestStringAssistant([
    { role: 'assistant', content: [{ type: 'text', text: 'structured is ignored' }] },
    { role: 'assistant', content: 'plain response long enough' },
  ]), 'plain response long enough');
});

test('the runtime mounts the host port and none of the retired public routes', () => {
  const { app } = createFixture();
  // Air 的「标记达成」也搬到 Rust 前门了（native/gateway/src/app/task_routes.rs），
  // unattended 的 GET/POST 也搬到 Rust 前门了（orchestration_routes.rs），公开 app 上
  // 只剩这一个宿主端口；无人值守处理器只挂在编排宿主端口的捕获应用上。
  assert.deepEqual([...app.routes.keys()].sort(), [`POST ${HOST_PATH}`].sort());
  for (const key of RETIRED) {
    assert.equal(app.routes.has(key), false, `${key} is answered by the front door, not Node`);
  }
});

test('unattended handlers are mounted only on the capture app handed in', () => {
  const { runtime } = createFixture();
  const app = createFakeApp();
  const capture = createFakeApp();
  runtime.mountRoutes(app, { unattendedApp: capture });
  assert.deepEqual([...app.routes.keys()], [`POST ${HOST_PATH}`]);
  assert.deepEqual([...capture.routes.keys()].sort(), [
    'GET /api/sessions/:id/unattended',
    'POST /api/sessions/:id/unattended',
  ]);
});

test('the host port only answers loopback callers', async () => {
  const { app } = createFixture();
  const remote = await callHost(app, { op: 'records' }, { remoteAddress: '203.0.113.9' });
  assert.equal(remote.status, 404);
  assert.deepEqual(remote.body, { error: 'not found' });
  const forwarded = await callHost(app, { op: 'records' }, { host: 'example.test' });
  assert.equal(forwarded.status, 404);
  const unknown = await callHost(app, { op: 'nope' });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body, { error: 'unknown host operation' });
});

test('a failing operation is logged and answered as a generic 500', async () => {
  const fixture = createFixture();
  const original = fixture.deps.getAuxRuntime;
  fixture.deps.getAuxRuntime = () => { throw new Error('queue exploded'); };
  try {
    const answer = await callHost(fixture.app, { op: 'aux-entry' });
    assert.equal(answer.status, 500);
    assert.deepEqual(answer.body, { error: 'host operation failed' });
  } finally {
    fixture.deps.getAuxRuntime = original;
  }
  assert.equal(fixture.effects.failed.length, 1);
  assert.equal(fixture.effects.failed[0].op, 'aux-entry');
});

test('records and directory lookups return the live process objects', async () => {
  const { app, records, directory } = createFixture();
  const roster = await callHost(app, { op: 'records' });
  assert.equal(roster.status, 200);
  assert.deepEqual(roster.body.map(([id]) => id), ['s1', 't1', '__aux__']);
  assert.equal(roster.body[0][1], records.get('s1'));
  assert.deepEqual((await callHost(app, { op: 'directory', id: 'd1' })).body, directory);
  assert.equal((await callHost(app, { op: 'directory', id: 'nope' })).body, null);
  assert.deepEqual((await callHost(app, { op: 'record', id: 't1' })).body, records.get('t1'));
  assert.equal((await callHost(app, { op: 'record', id: 'nope' })).body, null);
});

test('one runtime read feeds the four DTO shapes', async () => {
  const { app, records, directory } = createFixture();
  const s1 = { id: 's1', record: records.get('s1') };
  const t1 = { id: 't1', record: records.get('t1') };

  const list = await callHost(app, { op: 'list-dto', items: [s1, t1] });
  assert.deepEqual(Object.keys(list.body[0]), [
    'runtime', 'providerSelection', 'cliStates', 'pendingCliHandoff',
  ]);
  assert.equal(list.body[0].runtime.sessionCwd, '/session/s1');
  assert.equal(list.body[0].runtime.createdAt, 100);
  assert.deepEqual(list.body[0].providerSelection, {
    version: 1, mode: 'auto', protocol: 'anthropic',
    candidates: [
      { providerId: 'provider-1', model: 'model-1', priority: 1, enabled: true },
      { providerId: 'provider-2', model: 'model-2', priority: 2, enabled: true },
    ],
    maxAttempts: 2, sticky: true, preferMaxQuota: true, allowCrossTrust: false,
  });
  assert.equal(list.body[1].runtime.terminalActive, true);
  assert.equal(list.body[1].runtime.clients, 1);
  assert.equal(list.body[1].runtime.subagent, null);

  const dir = await callHost(app, { op: 'dir-dto', items: [s1, t1] });
  assert.deepEqual(Object.keys(dir.body[0]), [
    'runtime', 'providerSelection', 'cliStates', 'pendingCliHandoff', 'invalid',
  ]);
  assert.equal(dir.body[0].invalid, null);
  assert.equal(dir.body[1].invalid, 'test-invalid');

  const detail = await callHost(app, { op: 'detail-dto', record: records.get('s1') });
  assert.deepEqual(Object.keys(detail.body), [
    'runtime', 'providerSelection', 'providerBaseUrl', 'cliStates',
    'cliAvailability', 'pendingCliHandoff',
  ]);
  assert.equal(detail.body.providerBaseUrl, 'https://provider-1.example.com');
  assert.deepEqual(detail.body.cliAvailability, { claude: true, codex: true });

  const v1 = await callHost(app, { op: 'v1-dto', items: [s1] });
  assert.deepEqual(Object.keys(v1.body[0]), ['runtime']);

  const workspace = await callHost(app, { op: 'workspace-dto', items: [s1, t1] });
  assert.deepEqual(Object.keys(workspace.body[0]), ['runtime', 'facts', 'invalid']);
  // D is a done verdict: the card status comes from the classify letter, not
  // from the raw workspace status the host port reported.
  assert.equal(workspace.body[0].facts.status, 'succeeded');
  assert.equal(workspace.body[0].facts.summary, 'summary');
  assert.equal(workspace.body[0].facts.pendingNotes, 1);
  assert.equal(workspace.body[1].invalid, 'test-invalid');
  assert.deepEqual((await callHost(app, { op: 'workspace-dto', items: [] })).body, []);
});

test('internal execution slots are flagged and denied by the front door', async () => {
  const fixture = createFixture();
  fixture.records.set('slot', { id: 'slot', dirId: 'd1', kind: 'chat', taskExecutionSlot: true });
  const plain = await callHost(fixture.app, { op: 'guard-record', id: 's1', method: 'GET' });
  assert.equal(plain.body.internal, false);
  assert.equal(plain.body.taskStateWritable, true);
  assert.equal(plain.body.record.id, 's1');
  // A task-bound chat session stays addressable; the marker rides along.
  fixture.records.set('bound', {
    id: 'bound', dirId: 'd1', kind: 'chat', taskBoundTaskId: 'task-9', label: '任务 · 修 bug',
  });
  const bound = await callHost(fixture.app, { op: 'guard-record', id: 'bound', method: 'GET' });
  assert.equal(bound.body.internal, false);
  assert.equal(bound.body.record.taskBoundTaskId, 'task-9');
  const missing = await callHost(fixture.app, { op: 'guard-record', id: 'nope', method: 'POST' });
  assert.equal(missing.body.record, null);
  assert.equal(missing.body.internal, false);

  const slot = await callHost(fixture.app, { op: 'guard-record', id: 'slot', method: 'OPTIONS' });
  assert.equal(slot.body.internal, true);
  assert.equal(slot.body.record.id, 'slot');
  assert.deepEqual(fixture.effects.warned, [{
    message: 'internal_execution_slot_public_access_denied',
    detail: { method: 'OPTIONS' },
  }]);

  const noWriter = createFixture();
  noWriter.deps.setTaskState = undefined;
  const answer = await callHost(noWriter.app, { op: 'guard-record', id: 's1', method: 'GET' });
  assert.equal(answer.body.taskStateWritable, false);
});

test('task state is projected with explicit nulls', async () => {
  const { app, records } = createFixture();
  const settled = await callHost(app, { op: 'task-state', id: 's1' });
  assert.deepEqual(settled.body, {
    classifyState: 'D', goal: 'done goal', phase: 'done', goalState: null,
  });
  records.get('s1').taskState = undefined;
  const empty = await callHost(app, { op: 'task-state', id: 's1' });
  assert.deepEqual(empty.body, { classifyState: null, goal: null, phase: null, goalState: null });
});

test('the aux roster entry reports presence, availability and the queue shape', async () => {
  const fixture = createFixture();
  const present = await callHost(fixture.app, { op: 'aux-entry' });
  assert.equal(present.body.available, true);
  assert.equal(present.body.present, true);
  assert.deepEqual(Object.keys(present.body.entry), [
    'id', 'cwd', 'createdAt', 'lastActivity', 'clients', 'active', 'type', 'label', 'auxStatus',
  ]);
  assert.equal(present.body.entry.clients, 1);
  assert.equal(present.body.entry.active, false);
  assert.deepEqual(present.body.entry.auxStatus, { state: 'idle' });
  assert.ok(present.body.entry.lastActivity instanceof Date);

  fixture.records.delete('__aux__');
  const absent = await callHost(fixture.app, { op: 'aux-entry' });
  assert.deepEqual(absent.body, { available: true, present: false });

  fixture.deps.getAuxRuntime = () => null;
  const unavailable = await callHost(fixture.app, { op: 'aux-entry' });
  assert.deepEqual(unavailable.body, { available: false });
});

test('transcript failures degrade to flags instead of throwing', async () => {
  const state = { throws: false };
  const fixture = createFixture({
    viewChatHistory: (id) => {
      if (state.throws) throw new Error('transcript unavailable');
      return id === 's1' ? [{ role: 'assistant', content: 'reply long enough to classify' }] : [];
    },
  });
  const ok = await callHost(fixture.app, { op: 'history', id: 's1' });
  assert.equal(ok.body.failed, false);
  assert.equal(ok.body.history.length, 1);
  const empty = await callHost(fixture.app, { op: 'history', id: 'nope' });
  assert.deepEqual(empty.body, { failed: false, history: [] });
  state.throws = true;
  const failed = await callHost(fixture.app, { op: 'history', id: 's1' });
  assert.deepEqual(failed.body, { failed: true });
  // classificationReply treats an unreadable transcript as an empty one, so a
  // single unreadable session cannot abort a bulk reclassify pass.
  const reply = await callHost(fixture.app, { op: 'reply', id: 's1' });
  assert.equal(reply.body, '');
  state.throws = false;
  const text = await callHost(fixture.app, { op: 'reply', id: 's1' });
  assert.equal(text.body, 'reply long enough to classify');
});

test('the host port performs the three write effects through injected deps', async () => {
  const fixture = createFixture();
  const chat = fixture.chatSessions.get('s1');
  chat.currentAssistantText = 'previous';

  const flag = await callHost(fixture.app, { op: 'chat-flag', id: 's1' });
  assert.deepEqual(flag.body, { exists: true, streaming: false });
  assert.deepEqual((await callHost(fixture.app, { op: 'chat-flag', id: 'nope' })).body,
    { exists: false, streaming: false });

  // enqueue: manual replay, and the assistant text is restored afterwards.
  const enqueued = await callHost(fixture.app, { op: 'enqueue', id: 's1', reply: 'fresh reply' });
  assert.equal(enqueued.body, null);
  assert.deepEqual(fixture.effects.classified, [
    { id: 's1', manual: true, text: 'fresh reply' },
  ]);
  assert.equal(chat.currentAssistantText, 'previous');
  const noChat = await callHost(fixture.app, { op: 'enqueue', id: 'nope', reply: 'x' });
  assert.equal(noChat.body, null);
  assert.equal(fixture.effects.classified.length, 1);

  // dispatch: the D letter, the goal/phase passthrough and the terminal flag.
  await callHost(fixture.app, { op: 'dispatch-state', id: 's1', goal: 'g', phase: 'work' });
  await callHost(fixture.app, { op: 'dispatch-state', id: 't1', goal: '', phase: '', isTerminal: true });
  assert.equal(fixture.effects.dispatched.length, 2);
  assert.deepEqual(fixture.effects.dispatched[0].action, { state: 'D', goal: 'g', phase: 'work' });
  assert.equal(fixture.effects.dispatched[0].context.sessionName, 's1');
  assert.equal(fixture.effects.dispatched[0].context.sessionId, 's1');
  assert.equal(fixture.effects.dispatched[0].context.cs, fixture.chatSessions.get('s1'));
  assert.equal(fixture.effects.dispatched[0].context.isTerminal, false);
  assert.deepEqual(fixture.effects.dispatched[1].action, { state: 'D', goal: '', phase: '' });
  assert.equal(fixture.effects.dispatched[1].context.cs, null);
  assert.equal(fixture.effects.dispatched[1].context.isTerminal, true);

  // set-goal-achieved: the only state writer, with the manual stamp.
  await callHost(fixture.app, { op: 'set-goal-achieved', id: 's1' });
  assert.equal(fixture.effects.writes.length, 1);
  assert.equal(fixture.effects.writes[0].id, 's1');
  assert.equal(fixture.effects.writes[0].patch.goalState, GOAL_STATES.achieved);
  assert.equal(typeof fixture.effects.writes[0].patch.goalStateManualAt, 'number');

  // run-classify: the debug route seeds the text and leaves it in place.
  const classified = await callHost(fixture.app, { op: 'run-classify', id: 's1', text: 'debug text' });
  assert.equal(classified.body, null);
  assert.equal(chat.currentAssistantText, 'debug text');
  assert.deepEqual(fixture.effects.classified[1], { id: 's1', manual: false, text: 'debug text' });
  assert.equal((await callHost(fixture.app, { op: 'run-classify', id: 'nope', text: 'x' })).body, null);
});

test('workspace facts read the shell cursor execution, not the historical source row', async () => {
  let executionSessionId = 'child';
  const fixture = createFixture({
    resolveStateTarget: id => ({
      sourceSessionId: id,
      shellId: id === 's1' ? 'shell-1' : null,
      executionSessionId: id === 's1' ? executionSessionId : id,
    }),
  });
  fixture.records.get('s1').taskState = { classifyState: 'E', goal: 'old failure' };
  fixture.records.set('child', {
    id: 'child', dirId: 'd1', kind: 'chat', taskBoundTaskId: 'task-new',
    taskState: { classifyState: 'W', goal: 'new question', phase: 'implementing' },
  });
  fixture.chatSessions.set('child', { clients: new Set(), isStreaming: true });
  for (const letter of ['P', 'W', 'D', 'E']) {
    fixture.records.get('child').taskState.classifyState = letter;
    const snapshot = fixture.runtime.workspaceSnapshot('d1').find(s => s.id === 's1');
    assert.equal(snapshot.classifyState, letter);
    assert.equal(snapshot.stateSource.executionSessionId, 'child');
    assert.equal(snapshot.goal, 'new question');
    // The front door resolves the roster through the same cursor; this is the
    // fact payload it lifts the roster fields from.
    const answer = await callHost(fixture.app, {
      op: 'workspace-dto', items: [{ id: 's1', record: fixture.records.get('s1') }],
    });
    assert.equal(answer.body[0].facts.classifyState, letter);
    assert.equal(answer.body[0].facts.goal, 'new question');
    assert.equal(fixture.records.get('s1').taskState.classifyState, 'E');
  }
  executionSessionId = 's1';
  assert.equal(fixture.runtime.sessionView('s1').goal, 'old failure');
});

test('server delegates to the runtime and the module registers no public route', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const moduleSource = fs.readFileSync(path.join(root, 'src', 'routes', 'session-admin.js'), 'utf8');
  const hostSource = fs.readFileSync(path.join(root, 'src', 'routes', 'session-admin-host.js'), 'utf8');
  assert.match(server, /const sessionAdmin = createSessionAdminRuntime\(\{/);
  assert.match(server, /sessionAdmin\.mountRoutes\(app, \{ unattendedApp: orchestrationHost\.app \}\);/);
  assert.doesNotMatch(server, /const sessionQuery = createSessionQueryService/);
  assert.doesNotMatch(server, /app\.get\('\/api\/dashboard\/sessions'/);
  for (const [method, route] of [
    ['get', '/api/v1/sessions'],
    ['post', '/api/reclassify-all'],
    ['get', '/api/debug/classify-test-cases'],
    ['get', '/api/directories/:id/workspace'],
  ]) {
    const registration = `app.${method}('${route}'`;
    assert.equal(moduleSource.includes(registration), false, `${route} is not registered in Node`);
  }
  assert.match(hostSource, /app\.post\(HOST_PATH/);
  assert.match(hostSource, /unknown host operation/);
  assert.match(hostSource, /if \(!isLocal\(req\)\) return res\.status\(404\)\.json\(\{ error: 'not found' \}\)/);
});
