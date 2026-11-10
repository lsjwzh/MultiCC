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

const providers = require('../src/providers/core.js');
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

function fixture(session, {
  chatState = null,
  backgroundActive = false,
  synchronizeCodexSessionRoute = () => ({ synchronized: false }),
  validProviderId = (_cli, id) => ({ ok: true, value: id || null }),
  createSessionRecord = async () => ({ ok: false, error: 'unused' }),
  extraSessions = [],
  loadChatHistory = () => [],
  mergeHistory = () => {},
} = {}) {
  const workspace = [];
  const chat = [];
  const effects = [];
  const persistedSessions = new Map([['s1', session], ...extraSessions.map(record => [record.id, record])]);
  const providerRouterRuntime = { getProviderSummary: () => null };
  const sessionPolicy = createSessionPolicy({
    providerRouter: providerRouterRuntime,
    providers: { appTypeForCli: providers.appTypeForCli },
    env: {},
    homeDir: () => process.env.HOME,
  });
  const app = fakeApp();
  const mounted = createSessionProfileRoutes({
    persistedSessions,
    directories: new Map([['d1', { id: 'd1', path: '/tmp/d1' }]]),
    sessionPersistence: {
      begin: () => {
        effects.push('persistence-begin');
        return { commit() {}, rollback() {} };
      },
      mutate: (_reason, fn) => fn(),
    },
    sessionPolicy,
    providers: {
      appTypeForCli: providers.appTypeForCli,
      modelValidForProvider: providers.modelValidForProvider,
      codexProviderProxyable: providers.codexProviderProxyable,
      synchronizeCodexSessionRoute,
      CODEX_HOMES_DIR: providers.CODEX_HOMES_DIR,
    },
    providerRouterRuntime,
    getChatStream: () => ({ close: id => effects.push(`stream-close:${id}`) }),
    getChatState: () => chatState,
    hasLiveBackgroundTasks: () => backgroundActive,
    validProviderId,
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
    createSessionRecord,
    loadChatHistory,
    newChatMsgId: () => 'm1',
    mergeHistory: (id, messages, options) => mergeHistory(id, messages, options),
    getFolderMemory: () => ({ sessionDir: () => path.join(tmpRoot, 'mem') }),
    getCliSwitchGitSnapshot: () => async () => ({}),
  }).mountRoutes(app);
  return { session, handler: app.routes.get('PATCH /api/sessions/:id'), workspace, chat, effects,
    forkHandler: app.routes.get('POST /api/sessions/:id/fork'),
    applySessionPatch: mounted.applySessionPatch };
}

async function forkFixture(source, { current = null, body = {}, validProviderId, ...options } = {}) {
  const attempts = [], histories = [];
  const before = structuredClone(source);
  const history = [{ id: 'old-message', role: 'assistant', content: 'historical answer', provider: 'removed-provider', taskId: 'old-task' }];
  const { forkHandler } = fixture(source, {
    extraSessions: current ? [current] : [],
    loadChatHistory: () => history,
    mergeHistory: (id, messages) => histories.push({ id, messages }),
    validProviderId: validProviderId || ((_cli, id) => id === 'removed-provider' ? { ok: false } : { ok: true, value: id || null }),
    createSessionRecord: async input => {
      attempts.push(input);
      assert.notEqual(input.provider, 'removed-provider');
      return { ok: true, id: 'new-session', session: { ...input, id: 'new-session' } };
    },
    ...options,
  });
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await forkHandler({ params: { id: 's1' }, body: { atMessageId: 'old-message', includeMemory: false, ...body } }, response);
  assert.deepEqual(source, before, 'fork must not mutate historical execution settings');
  return { response, attempts, histories };
}

const forkSource = () => ({ id: 's1', dirId: 'd1', cli: 'codex', kind: 'chat', provider: 'removed-provider', model: 'old-model' });

test('fork copies history with a deleted provider using defaults for the new idle session', async () => {
  const { response, attempts, histories } = await forkFixture(forkSource());
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].provider, undefined);
  assert.equal(attempts[0].model, null);
  assert.equal(attempts[0].providerSelection, null);
  assert.match(histories[0].messages[0].content, /reset to defaults/);
  const inherited = histories[0].messages[1];
  assert.equal(inherited.content, 'historical answer');
  assert.equal(inherited.provider, 'removed-provider', 'historical metadata is preserved, never validated as a live route');
  assert.equal(inherited.inheritedFrom.sessionId, 's1');
  assert.equal(inherited.inheritedFrom.taskId, 'old-task');
  assert.equal(inherited.taskId, undefined);
});

test('fork uses current composer settings even when the selected message belongs to an old execution', async () => {
  const current = { ...forkSource(), id: 'current', cli: 'claude', provider: 'selected-provider', model: 'selected-model', subagent: null };
  const { response, attempts, histories } = await forkFixture(forkSource(), { current, body: { configurationSessionId: current.id } });
  assert.equal(response.statusCode, 200);
  assert.equal(attempts[0].provider, 'selected-provider');
  assert.equal(attempts[0].model, 'selected-model');
  assert.equal(attempts[0].cli, 'claude');
  assert.equal(response.body.forkedFrom.sessionId, 's1');
  assert.equal(histories[0].messages[1].provider, 'removed-provider');
});

test('fork honors saved next-turn CLI/provider/model/subagent settings', async () => {
  const source = forkSource();
  source.subagent = { providerId: 'removed-provider', model: 'old-model' };
  source.pendingConfiguration = { cli: 'claude', profile: {
    provider: 'next-provider', model: 'next-model', subagent: null, providerSelection: null,
  } };
  const { response, attempts } = await forkFixture(source);
  assert.equal(response.statusCode, 200);
  assert.equal(attempts[0].provider, 'next-provider');
  assert.equal(attempts[0].model, 'next-model');
  assert.equal(attempts[0].cli, 'claude');
  assert.equal(response.body.session.subagent, null, 'must not restore the historical subagent after creation');
});

test('fork rejects missing and cross-directory configuration sessions before creating anything', async () => {
  for (const current of [null, { ...forkSource(), id: 'other', dirId: 'other-directory' }]) {
    const { response, attempts, histories } = await forkFixture(forkSource(), { current, body: { configurationSessionId: 'other' } });
    assert.equal(response.statusCode, 400);
    assert.equal(attempts.length, 0);
    assert.equal(histories.length, 0);
  }
});

test('fork drops an unavailable subagent without losing the valid main route', async () => {
  const source = { ...forkSource(), provider: 'valid-provider', subagent: { providerId: 'removed-provider', model: 'old-model' } };
  const { response, attempts } = await forkFixture(source);
  assert.equal(response.statusCode, 200);
  assert.equal(attempts[0].provider, 'valid-provider');
  assert.equal(attempts[0].subagent, null);
});

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

test('non-label PATCHes emit no session_updated — route changes speak their own event', () => {
  const { workspace, chat, handler } = fixture({
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', provider: null, model: null,
  });
  invoke(handler, { params: { id: 's1' }, body: { provider: '' } });
  assert.equal(workspace.filter(e => e.payload.type === 'session_updated').length, 0);
  assert.equal(chat.filter(e => e.payload.type === 'session_updated').length, 0);
});

test('an immediately-applied provider switch broadcasts session_configuration_applied on both planes', () => {
  const session = {
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat',
    provider: 'claude-official', model: 'opus',
  };
  const { handler, workspace, chat } = fixture(session);
  const res = invoke(handler, { params: { id: 's1' }, body: { provider: 'relay-b' } });
  assert.equal(res.statusCode, 200);
  assert.equal(session.provider, 'relay-b');
  // Regression: the Air task page saves AI 配置 from the parent page, so the
  // embedded chat iframe only learns a provider changed through this push.
  // Without it the iframe's quota bar kept rendering the OLD provider (e.g.
  // 官方 → 借道 with no visible switch) until a full page reload.
  assert.deepEqual(chat.filter(e => e.payload.type === 'session_configuration_applied'),
    [{ sessionId: 's1', payload: { type: 'session_configuration_applied', sessionId: 's1' } }]);
  assert.deepEqual(workspace.filter(e => e.payload.type === 'session_configuration_applied'),
    [{ dirId: 'd1', payload: { type: 'session_configuration_applied', sessionId: 's1' } }]);
});

test('a label-only PATCH stays silent about configuration — no spurious applied event', () => {
  const { workspace, chat, handler } = fixture({
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', label: null,
  });
  invoke(handler, { params: { id: 's1' }, body: { label: '改名' } });
  assert.equal(workspace.filter(e => e.payload.type === 'session_configuration_applied').length, 0);
  assert.equal(chat.filter(e => e.payload.type === 'session_configuration_applied').length, 0);
});

test('an active provider-bound turn defers the route mutation to next turn', () => {
  const session = {
    id: 's1', dirId: 'd1', cli: 'codex', kind: 'chat',
    provider: 'provider-a', model: 'model-a', cliSessionId: 'native-a',
  };
  const { handler, chat } = fixture(session, {
    chatState: { _activeRunner: { providerAttempt: { routeAttemptId: 'attempt-a' } } },
  });

  const res = invoke(handler, { params: { id: 's1' }, body: { provider: 'provider-b' } });

  // Busy sessions no longer reject with 409 — the same validation runs on a
  // detached desired-state draft and is staged as pendingConfiguration
  // (200 + deferred:true, appliesOn next_turn). The live record must stay
  // untouched while the turn is still running on the old route.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deferred, true);
  assert.equal(res.body.appliesOn, 'next_turn');
  assert.equal(session.provider, 'provider-a');
  assert.equal(session.model, 'model-a');
  assert.ok(chat.some(e => e.payload.type === 'session_configuration_pending'));
});

test('a live background task defers the mutation without persistence or stream teardown', () => {
  const session = {
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat',
    provider: 'provider-a', model: 'model-a',
  };
  const { handler, effects } = fixture(session, { backgroundActive: true });

  const res = invoke(handler, { params: { id: 's1' }, body: { model: 'model-b' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deferred, true);
  assert.equal(session.model, 'model-a');
  assert.deepEqual(effects, [], 'deferred route mutation must not begin persistence or close the warm stream');
});

test('idle Codex route changes synchronize the exact native rollout before authority changes', () => {
  for (const [fromProviderId, requested, toProviderId] of [
    ['managed-a', '', null],
    [null, 'managed-b', 'managed-b'],
  ]) {
    const session = {
      id: 's1', dirId: 'd1', cli: 'codex', kind: 'chat',
      provider: fromProviderId, model: 'model-a', cliSessionId: 'native-a',
    };
    const calls = [];
    const { handler } = fixture(session, {
      synchronizeCodexSessionRoute: input => {
        calls.push({ ...input, providerAtCall: session.provider });
        return { synchronized: true };
      },
    });

    const res = invoke(handler, { params: { id: 's1' }, body: { provider: requested } });

    assert.equal(res.statusCode, 200);
    assert.equal(session.provider, toProviderId);
    assert.deepEqual(calls, [{
      logicalSessionId: 's1', nativeSessionId: 'native-a',
      fromProviderId, toProviderId, providerAtCall: fromProviderId,
    }]);
  }
});

test('server composition gives profile routes the live chat-state reader', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('createSessionProfileRoutes({');
  const end = source.indexOf('}).mountRoutes(app);', start);
  assert.ok(start >= 0 && end > start);
  const composition = source.slice(start, end);
  assert.match(composition, /getChatStream: \(\) => chatStream, getChatState: id => chatSessions\.get\(id\),/);
  assert.match(composition, /hasLiveBackgroundTasks: id => backgroundTaskRuntime\?\.hasProcessBackgroundTasks\(id\) === true/);
});

test('in-process applySessionPatch (provider force-delete) runs the same PATCH path', () => {
  const idle = fixture({ id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', provider: 'p1', subagent: null });
  const applied = idle.applySessionPatch('s1', { provider: null });
  assert.equal(applied.status, 200);
  assert.equal(idle.session.provider, null);
  assert.equal(applied.body.deferred, undefined);

  const busy = fixture({ id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', provider: 'p1' }, { backgroundActive: true });
  const staged = busy.applySessionPatch('s1', { provider: null });
  assert.equal(staged.status, 200);
  assert.equal(staged.body.deferred, true);
  assert.equal(busy.session.provider, 'p1', 'a running turn keeps its route until the next turn');
  assert.equal(busy.session.pendingConfiguration.profile.provider, null);

  assert.equal(idle.applySessionPatch('missing', { provider: null }).status, 404);
});

function stickyAutoSession() {
  return {
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', provider: 'relay-b',
    providerSelection: { mode: 'auto', protocol: 'anthropic', candidates: [
      { providerId: 'relay-a' }, { providerId: 'relay-b' },
    ] },
    autoProviderLastRoute: { providerId: 'relay-b', model: 'model-b' },
  };
}

test('保存语义相同的自动池保留当前线路，修改池或退出自动才清理', () => {
  const h = fixture(stickyAutoSession());
  const lastRoute = h.session.autoProviderLastRoute;
  const cloned = JSON.parse(JSON.stringify(h.session.providerSelection));
  const same = h.applySessionPatch('s1', { providerSelection: cloned });
  assert.equal(same.status, 200);
  assert.equal(h.session.autoProviderLastRoute, lastRoute);
  const changed = h.applySessionPatch('s1', { providerSelection: {
    ...cloned, candidates: [{ providerId: 'relay-c' }, { providerId: 'relay-b' }],
  } });
  assert.equal(changed.status, 200);
  assert.equal(h.session.autoProviderLastRoute, undefined);

  for (const patch of [{ provider: 'manual-provider' }, { providerSelection: null }]) {
    const manual = fixture(stickyAutoSession());
    assert.equal(manual.applySessionPatch('s1', patch).status, 200);
    assert.equal(manual.session.providerSelection, null);
    assert.equal(manual.session.autoProviderLastRoute, undefined);
  }
});

test('运行中修改自动配置只保存待生效设置，不提前清理活跃线路', () => {
  const h = fixture(stickyAutoSession(), { backgroundActive: true });
  const lastRoute = h.session.autoProviderLastRoute;
  const changed = h.applySessionPatch('s1', { provider: 'manual-provider' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.deferred, true);
  assert.equal(h.session.autoProviderLastRoute, lastRoute);
  assert.equal(h.session.providerSelection.mode, 'auto');
  assert.equal(h.session.pendingConfiguration.profile.providerSelection, null);
});
