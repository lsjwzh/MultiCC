'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createErrorDto, requestContext, withApiMeta } = require('../src/api-contract');
const { isTerminalLetter } = require('../src/classify/vocab');
const {
  assistantText,
  latestAssistant,
  latestStringAssistant,
  createSessionAdminRuntime,
} = require('../src/routes/session-admin');

function createFakeApp() {
  const routes = new Map();
  const register = method => (route, handler) => {
    const key = `${method} ${route}`;
    assert.equal(routes.has(key), false, `route is registered once: ${key}`);
    routes.set(key, handler);
  };
  return { routes, get: register('GET'), post: register('POST') };
}

function invoke(handler, { params = {}, query = {}, body = {} } = {}) {
  const req = { params, query, body, id: 'req-test', correlationId: 'corr-test' };
  const response = { statusCode: 200, body: undefined };
  const res = {
    locals: {},
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  handler(req, res);
  return response;
}

function createFixture(overrides = {}) {
  const records = new Map([
    ['s1', {
      id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', label: 'Chat',
      createdAt: 100, model: 'model-1', provider: 'provider-1',
      experimentalMode: 'tui-chat-mirror',
      rolePrompt: 'legacy-only prompt', cwd: '/private/worktree',
      rolePresetId: 'testing__testing-engineer',
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
  const enqueued = [];
  const dispatched = [];
  let classifyNow = 0;
  let mergeStateReads = 0;
  const queue = {
    clients: new Set([{}]),
    processing: false,
    lastTaskTime: 1234,
    unhealthy: false,
    getStatus: () => ({ state: 'idle' }),
    isUnhealthy() { return this.unhealthy; },
    enqueue(task) { enqueued.push(task); return Promise.resolve({ text: 'goal\n实现中\nC' }); },
  };
  const runtime = createSessionAdminRuntime({
    records,
    terminalSessions,
    chatSessions,
    directories,
    cwdForSession: record => `/session/${record.id}`,
    chatLastActivity: () => new Date(3000),
    effectiveSessionModel: record => record.model || 'effective-model',
    effectiveSessionEffort: () => 'high',
    serializeSubagent: value => value || null,
    mergeStateCached: overrides.mergeStateCached || (() => {
      mergeStateReads += 1;
      return { ahead: 0, behind: 0, dirty: false };
    }),
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
    pendingNotesFor: id => id === 's1' ? [{ id: 'note' }] : [],
    getAuxRuntime: () => ({ id: '__aux__', queue }),
    loadChatHistory: overrides.loadChatHistory || (id => history.get(id) || []),
    isInjectedOrJunkGoal: goal => String(goal || '').startsWith('[auto]'),
    buildClassifySystemPrompt: goal => `system:${goal}`,
    buildClassifyConversation: (id, reply) => `conversation:${id}:${reply}`,
    parseClassifyResult: text => ({ state: text.endsWith('C') ? 'continue' : 'waiting' }),
    dispatchStateAction: (result, context) => dispatched.push({ result, context }),
    runClassifyNow: () => { classifyNow += 1; },
    createErrorDto,
    requestContext,
    withApiMeta,
  });
  const app = createFakeApp();
  runtime.mountRoutes(app);
  return {
    app, runtime, records, chatSessions, queue, history,
    enqueued, dispatched, getClassifyNow: () => classifyNow,
    getMergeStateReads: () => mergeStateReads,
  };
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

test('session admin mounts the complete bounded route set once', () => {
  const { app } = createFixture();
  const expected = [
    'GET /api/v1/sessions',
    'GET /api/v1/sessions/:id',
    'GET /api/v1/directories/:id/workspace',
    'GET /api/sessions',
    'GET /api/dashboard/sessions',
    'GET /api/dashboard/stats',
    'POST /api/sessions/:id/reclassify',
    'POST /api/sessions/:id/mark-task-done',
    'POST /api/reclassify-all',
    'GET /api/directories/:id/sessions',
    'GET /api/directories/:id/workspace',
    'GET /api/sessions/:id',
    'POST /api/debug/classify/:id',
    'GET /api/debug/classify-test-cases',
  ];
  assert.deepEqual([...app.routes.keys()].sort(), expected.sort());
});

test('dashboard polling does not start merge-state Git work', () => {
  const fixture = createFixture();
  invoke(fixture.app.routes.get('GET /api/dashboard/sessions'));
  invoke(fixture.app.routes.get('GET /api/dashboard/stats'));
  assert.equal(fixture.getMergeStateReads(), 0);

  invoke(fixture.app.routes.get('GET /api/sessions'));
  assert.ok(fixture.getMergeStateReads() > 0,
    'the compatibility list retains its explicitly exposed mergeState field');
});

test('v1 responses stay bounded while legacy and dashboard fields remain compatible', () => {
  const { app } = createFixture();
  const v1 = invoke(app.routes.get('GET /api/v1/sessions'));
  assert.equal(v1.body.count, 2);
  const wire = JSON.stringify(v1.body);
  for (const secret of ['/private/', 'native-secret', 'legacy-only prompt']) {
    assert.equal(wire.includes(secret), false, `v1 excludes ${secret}`);
  }

  const legacy = invoke(app.routes.get('GET /api/sessions'));
  assert.equal(legacy.body[0].id, '__aux__');
  assert.equal(legacy.body.find(item => item.id === 's1').cwd, '/session/s1');
  assert.equal(legacy.body.find(item => item.id === 's1').rolePresetId, 'testing__testing-engineer');
  assert.equal(legacy.body.find(item => item.id === 's1').experimentalMode, 'tui-chat-mirror');
  assert.equal(legacy.body.find(item => item.id === 't1').active, true);

  const directorySessions = invoke(app.routes.get('GET /api/directories/:id/sessions'), {
    params: { id: 'd1' },
  });
  assert.equal(directorySessions.body.sessions.find(item => item.id === 's1').rolePresetId,
    'testing__testing-engineer');
  assert.equal(directorySessions.body.sessions.find(item => item.id === 's1').experimentalMode,
    'tui-chat-mirror');

  const detail = invoke(app.routes.get('GET /api/sessions/:id'), { params: { id: 's1' } });
  assert.equal(detail.body.rolePresetId, 'testing__testing-engineer');
  assert.equal(detail.body.experimentalMode, 'tui-chat-mirror');

  const dashboard = invoke(app.routes.get('GET /api/dashboard/stats'));
  assert.deepEqual(dashboard.body, {
    total: 2,
    active: 2,
    byCli: { claude: 1, codex: 1 },
    byKind: { chat: 1, terminal: 1 },
  });

  const workspace = invoke(app.routes.get('GET /api/directories/:id/workspace'), {
    params: { id: 'd1' },
  });
  assert.equal(workspace.body.sessions.length, 2);
  assert.equal(workspace.body.sessions.find(item => item.id === 's1').pendingNotes, 1);
  assert.equal(workspace.body.sessions.find(item => item.id === 't1').invalid, 'test-invalid');
});

test('manual reclassify keeps D/W guard and fire-and-forget completion semantics', async () => {
  const fixture = createFixture();
  const handler = fixture.app.routes.get('POST /api/sessions/:id/reclassify');
  const skipped = invoke(handler, { params: { id: 's1' } });
  assert.equal(skipped.statusCode, 200);
  assert.equal(skipped.body.skipped, true);
  assert.equal(fixture.enqueued.length, 0);

  const forced = invoke(handler, { params: { id: 's1' }, query: { force: 'true' } });
  assert.equal(forced.statusCode, 200);
  assert.equal(fixture.getClassifyNow(), 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.dispatched.length, 0, 'manual replay cannot write turn state');

  fixture.queue.unhealthy = true;
  const unavailable = invoke(handler, { params: { id: 't1' } });
  assert.equal(unavailable.statusCode, 503);
});

test('manual mark-task-done compatibility route flips only the waiting turn outcome', () => {
  const fixture = createFixture();
  const handler = fixture.app.routes.get('POST /api/sessions/:id/mark-task-done');

  const missing = invoke(handler, { params: { id: 'nope' } });
  assert.equal(missing.statusCode, 404);

  const aux = invoke(handler, { params: { id: '__aux__' } });
  assert.equal(aux.statusCode, 400);

  // s1 starts as D -> already succeeded, no dispatch side effect
  const done = invoke(handler, { params: { id: 's1' } });
  assert.equal(done.statusCode, 200);
  assert.equal(done.body.alreadyDone, true);
  assert.equal(done.body.alreadySucceeded, true);
  assert.equal(done.body.turnOutcome, 'succeeded');
  assert.equal(fixture.dispatched.length, 0);

  // waiting chat session -> succeeded turn dispatch, non-terminal session kind
  fixture.records.get('s1').taskState = { classifyState: 'W', goal: 'wait goal', phase: 'verifying' };
  const ok = invoke(handler, { params: { id: 's1' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.classifyState, 'D');
  assert.equal(ok.body.turnOutcome, 'succeeded');
  assert.equal(fixture.dispatched.length, 1);
  // The LETTER, and a terminal one: dispatchStateAction routes on letters, and
  // anything non-terminal here would be re-judged by the 60s scan, quietly
  // undoing the manual turn verdict the user just asked for.
  assert.equal(fixture.dispatched[0].result.state, 'D');
  assert.equal(isTerminalLetter(fixture.dispatched[0].result.state), true);
  assert.equal(fixture.dispatched[0].result.state, ok.body.classifyState);
  assert.equal(fixture.dispatched[0].result.goal, 'wait goal');
  assert.equal(fixture.dispatched[0].context.sessionName, 's1');
  assert.equal(fixture.dispatched[0].context.isTerminal, false);

  // streaming session -> 409, no extra dispatch
  fixture.chatSessions.get('s1').isStreaming = true;
  const busy = invoke(handler, { params: { id: 's1' } });
  assert.equal(busy.statusCode, 409);
  assert.equal(fixture.dispatched.length, 1);
  fixture.chatSessions.get('s1').isStreaming = false;

  // terminal-kind session -> isTerminal true
  fixture.records.get('t1').taskState = { classifyState: 'W', goal: 'tg', phase: 'tp' };
  const term = invoke(handler, { params: { id: 't1' } });
  assert.equal(term.statusCode, 200);
  assert.equal(fixture.dispatched[1].context.isTerminal, true);
});

test('history read failures degrade per session and never abort bulk reclassify', () => {
  const fixture = createFixture({
    loadChatHistory: id => {
      if (id === 's1') throw new Error('corrupt history');
      return [{ role: 'assistant', content: 'terminal assistant response long enough to classify' }];
    },
  });
  fixture.records.get('s1').taskState = { classifyState: 'C', goal: '[auto] broken' };
  const single = invoke(fixture.app.routes.get('POST /api/sessions/:id/reclassify'), {
    params: { id: 's1' },
  });
  assert.equal(single.statusCode, 400);
  assert.equal(single.body.error, 'no assistant reply to classify against');

  const bulk = invoke(fixture.app.routes.get('POST /api/reclassify-all'), {
    body: { onlyJunk: false },
  });
  assert.equal(bulk.statusCode, 200);
  assert.deepEqual(bulk.body.ids, ['t1']);
});

test('debug classify and test-case routes preserve guards, structured text, and sorting', () => {
  const fixture = createFixture();
  const classify = fixture.app.routes.get('POST /api/debug/classify/:id');
  const guarded = invoke(classify, { params: { id: 's1' } });
  assert.equal(guarded.statusCode, 409);
  assert.equal(fixture.getClassifyNow(), 0);

  const forced = invoke(classify, { params: { id: 's1' }, query: { force: 'true' } });
  assert.equal(forced.body.triggered, true);
  assert.equal(fixture.getClassifyNow(), 1);
  assert.match(fixture.chatSessions.get('s1').currentAssistantText, /structured assistant/);

  const cases = invoke(fixture.app.routes.get('GET /api/debug/classify-test-cases'));
  assert.equal(cases.body.count, 1);
  assert.equal(cases.body.cases[0].sessionId, 's1');
  assert.equal(cases.body.cases[0].lastTs, new Date(2000).toISOString());
});

test('server delegates session-admin routes and retains only the shared v1 error helper', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const moduleSource = fs.readFileSync(path.join(root, 'src', 'routes', 'session-admin.js'), 'utf8');
  assert.match(server, /const sessionAdmin = createSessionAdminRuntime\(\{/);
  assert.match(server, /sessionAdmin\.mountRoutes\(app\);/);
  assert.doesNotMatch(server, /const sessionQuery = createSessionQueryService/);
  assert.doesNotMatch(server, /app\.get\('\/api\/dashboard\/sessions'/);
  for (const [method, route] of [
    ['get', '/api/v1/sessions'],
    ['get', '/api/dashboard/sessions'],
    ['post', '/api/reclassify-all'],
    ['get', '/api/debug/classify-test-cases'],
    ['get', '/api/directories/:id/workspace'],
  ]) {
    const registration = `app.${method}('${route}'`;
    assert.equal(
      moduleSource.split(registration).length - 1,
      1,
      `${method.toUpperCase()} ${route} is registered once in module`,
    );
  }
});

test('legacy session detail exposes the task-bound marker for direct addressing (P3)', () => {
  const { app, records } = createFixture();
  records.set('b1', {
    id: 'b1', dirId: 'd1', cli: 'codex', kind: 'chat',
    label: '任务 · 修 bug', createdAt: 400, taskBoundTaskId: 'task-9',
  });
  const detail = invoke(app.routes.get('GET /api/sessions/:id'), { params: { id: 'b1' } });
  assert.equal(detail.statusCode, 200);
  // The App gates its hidden-session open on this exact marker (aux/gateway
  // and slots must never resolve through the fleet-miss path).
  assert.equal(detail.body.taskBoundTaskId, 'task-9');
  assert.equal(detail.body.dirId, 'd1');
  assert.equal(detail.body.label, '任务 · 修 bug');
  // Ordinary records carry a null marker, never an accidental truthy.
  const plain = invoke(app.routes.get('GET /api/sessions/:id'), { params: { id: 's1' } });
  assert.equal(plain.body.taskBoundTaskId, null);
});
