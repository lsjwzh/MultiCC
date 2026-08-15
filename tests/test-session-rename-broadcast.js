'use strict';

// PATCH /api/sessions/:id {label} — rename must not be write-only.
//
// Regression: the label branch persisted + appended a directory audit event
// but told no socket, so every client (web header, App header, fleet lists)
// kept showing the old title until its next full REST reload. The contract
// now pushes {type:'session_updated', sessionId, label} on both planes:
// workspaceBroadcast(dirId) for fleet lists/dashboards and chatBroadcast(id)
// for the open chat's own socket. Old servers simply don't send it — clients
// treat absence as "no change" and keep polling, so the extension is
// backward-compatible by omission.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-broadcast-'));
process.env.MULTICC_DATA_DIR = path.join(tmpRoot, 'data');
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const providers = require('../src/providers.js');
const { createSessionPolicy } = require('../src/cli/session-policy.js');
const { createSessionProfileRoutes } = require('../src/routes/session-profile.js');

function fakeApp() {
  const routes = new Map();
  const register = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, patch: register('PATCH'), post: register('POST') };
}

function invoke(handler, { params = {}, body = {} } = {}) {
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  handler({ params, body }, res);
  return response;
}

function fixture(session) {
  const workspace = [];
  const chat = [];
  const persistedSessions = new Map([['s1', session]]);
  const providerRouterRuntime = { getProviderSummary: () => null };
  const sessionPolicy = createSessionPolicy({
    providerRouter: providerRouterRuntime,
    providers: { appTypeForCli: providers.appTypeForCli },
    env: {},
    homeDir: () => process.env.HOME,
  });
  const app = fakeApp();
  createSessionProfileRoutes({
    persistedSessions,
    directories: new Map([['d1', { id: 'd1', path: '/tmp/d1' }]]),
    sessionPersistence: {
      begin: () => ({ commit() {}, rollback() {} }),
      mutate: (_reason, fn) => fn(),
    },
    sessionPolicy,
    providers: {
      appTypeForCli: providers.appTypeForCli,
      modelValidForProvider: providers.modelValidForProvider,
      codexProviderProxyable: providers.codexProviderProxyable,
      CODEX_HOMES_DIR: providers.CODEX_HOMES_DIR,
    },
    providerRouterRuntime,
    getChatStream: () => ({ close() {} }),
    validProviderId: () => ({ ok: true, value: null }),
    asyncHandler: handler => handler,
    appendEvent: () => {},
    workspaceBroadcast: (dirId, payload) => workspace.push({ dirId, payload }),
    chatBroadcast: (sessionId, payload) => chat.push({ sessionId, payload }),
    getTaskState: () => null,
    rememberActiveCliState: () => {},
    buildHandoffCheckpoint: () => ({ createdAt: 0 }),
    cliStateSummary: () => ({}),
    cliAvailabilitySummary: () => ({}),
    cliHandoffSummary: () => null,
    createSessionRecord: async () => ({ ok: false, error: 'unused' }),
    loadChatHistory: () => [],
    newChatMsgId: () => 'm1',
    getChatHistoryService: () => ({ replace() {} }),
    getFolderMemory: () => ({ sessionDir: () => path.join(tmpRoot, 'mem') }),
    getCliSwitchGitSnapshot: () => async () => ({}),
  }).mountRoutes(app);
  return { session, handler: app.routes.get('PATCH /api/sessions/:id'), workspace, chat };
}

test('label PATCH broadcasts session_updated on both workspace and chat planes', () => {
  const { session, handler, workspace, chat } = fixture({
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', label: null,
  });
  const res = invoke(handler, { params: { id: 's1' }, body: { label: '指挥' } });
  assert.equal(res.statusCode, 200);
  assert.equal(session.label, '指挥');

  assert.equal(workspace.length, 1);
  assert.deepEqual(workspace[0], {
    dirId: 'd1',
    payload: { type: 'session_updated', sessionId: 's1', label: '指挥' },
  });
  assert.equal(chat.length, 1);
  assert.deepEqual(chat[0], {
    sessionId: 's1',
    payload: { type: 'session_updated', sessionId: 's1', label: '指挥' },
  });
});

test('clearing the label broadcasts null, not the stale title', () => {
  const { handler, workspace } = fixture({
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', label: '旧标题',
  });
  const res = invoke(handler, { params: { id: 's1' }, body: { label: '' } });
  assert.equal(res.statusCode, 200);
  assert.equal(workspace.length, 1);
  // null = "fall back to session id" — the client must not keep rendering the
  // previous label after an explicit clear.
  assert.equal(workspace[0].payload.label, null);
});

test('non-label PATCHes stay silent — no spurious session_updated', () => {
  const { workspace, chat } = fixture({
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', provider: null, model: null, label: 'x',
  });
  const { handler } = fixture({
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', provider: null, model: null,
  });
  invoke(handler, { params: { id: 's1' }, body: { provider: '' } });
  assert.equal(workspace.length, 0);
  assert.equal(chat.length, 0);
});
