'use strict';

// PATCH /api/sessions/:id — provider/model save semantics for provider-less
// OpenCode sessions ("default provider" = the CLI's native config, e.g. the
// OpenCode Go subscription provider in ~/.config/opencode/opencode.json).
//
// Regression: the AI-config dialog always submits provider+model together.
// For an opencode session saving provider='' with a native `opencodego/<model>`
// pick, the provider branch used to validate the model against the legacy
// claude pool (appTypeForCli('opencode') === 'claude') and wipe it back to
// null — every save landed on "Default | Default" and OpenCode Go models
// were unselectable. Provider-less OpenCode/ZCode sessions must keep their
// native model ids untouched; managed-provider saves keep the old
// compatibility enforcement.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-go-'));
process.env.MULTICC_DATA_DIR = path.join(tmpRoot, 'data');
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const providers = require('../src/providers.js');
const { createSessionPolicy } = require('../src/cli/session-policy.js');
const { createSessionProfileRoutes } = require('../src/routes/session-profile.js');

const MANAGED = {
  id: 'prov-1', appType: 'claude', name: 'Zhipu GLM',
  model: 'glm-5', modelOptions: ['glm-5'], aliasOnly: false,
  baseUrl: 'https://open.example.test/v1', hasToken: true, isOfficial: false,
};

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
  const persistedSessions = new Map([['s1', session]]);
  const providerRouterRuntime = {
    getProviderSummary: (_type, id) => (id === 'prov-1' ? MANAGED : null),
  };
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
    getChatState: () => null,
    hasLiveBackgroundTasks: () => false,
    validProviderId: (_cli, id) => (id === '' || id === 'prov-1'
      ? { ok: true, value: id || null }
      : { ok: false }),
    asyncHandler: handler => handler,
    appendEvent: () => {},
    workspaceBroadcast: () => {},
    chatBroadcast: () => {},
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
  return { session, handler: app.routes.get('PATCH /api/sessions/:id') };
}

test('opencode session keeps its native OpenCode Go model when saving the default provider', () => {
  const { session, handler } = fixture({
    id: 's1', dirId: 'd1', cli: 'opencode', kind: 'chat', provider: null, model: null,
  });
  const res = invoke(handler, {
    params: { id: 's1' },
    body: { provider: '', model: 'opencodego/glm-5.2', effort: '', agent: null },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(session.model, 'opencodego/glm-5.2');
  assert.equal(res.body.effectiveModel, 'opencodego/glm-5.2');
});

test('opencode session saving default provider with empty model clears to CLI default', () => {
  const { session, handler } = fixture({
    id: 's1', dirId: 'd1', cli: 'opencode', kind: 'chat', provider: null, model: 'opencodego/glm-5.2',
  });
  const res = invoke(handler, { params: { id: 's1' }, body: { provider: '', model: '' } });
  assert.equal(res.statusCode, 200);
  assert.equal(session.model, null);
});

test('opencode provider-only PATCH back to default still resets the model', () => {
  const { session, handler } = fixture({
    id: 's1', dirId: 'd1', cli: 'opencode', kind: 'chat', provider: 'prov-1', model: 'glm-5',
  });
  const res = invoke(handler, { params: { id: 's1' }, body: { provider: '' } });
  assert.equal(res.statusCode, 200);
  assert.equal(session.provider, null);
  assert.equal(session.model, null);
});

test('claude session on the default login still rejects non-claude wire models', () => {
  const { session, handler } = fixture({
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', provider: null, model: null,
  });
  const res = invoke(handler, { params: { id: 's1' }, body: { provider: '', model: 'gpt-5' } });
  assert.equal(res.statusCode, 200);
  assert.notEqual(session.model, 'gpt-5');
});

test('opencode session bound to a managed provider keeps model compatibility enforcement', () => {
  const kept = fixture({
    id: 's1', dirId: 'd1', cli: 'opencode', kind: 'chat', provider: null, model: null,
  });
  const okRes = invoke(kept.handler, {
    params: { id: 's1' }, body: { provider: 'prov-1', model: 'glm-5' },
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(kept.session.model, 'glm-5');

  const stale = fixture({
    id: 's1', dirId: 'd1', cli: 'opencode', kind: 'chat', provider: null, model: null,
  });
  const staleRes = invoke(stale.handler, {
    params: { id: 's1' }, body: { provider: 'prov-1', model: 'not-served-here' },
  });
  assert.equal(staleRes.statusCode, 200);
  assert.equal(stale.session.model, 'glm-5'); // replaced with the provider's primary
});
