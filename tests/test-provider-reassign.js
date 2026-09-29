'use strict';

// Batch provider reassignment — POST /api/providers/:appType/:id/reassign-sessions.
//
// The contract under test:
//   · a dry run lists the bound sessions and ONLY the targets those sessions can
//     actually use, and writes nothing (no session mutation, no stream teardown);
//   · every moved session goes through the same in-process session PATCH the AI
//     dialog uses, so a stale model the target does not serve is replaced by the
//     target's default model — and the dry run reports that reset per session so
//     the dialog can show it before the user confirms;
//   · a CLI that cannot speak the target route is skipped and reported, never
//     pointed at it;
//   · a busy session is deferred (applies next turn), not interrupted;
//   · Auto-selection / system sessions are skipped and reported, and sub-agent /
//     CLI-default references are counted but never rewritten.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-reassign-'));
process.env.MULTICC_DATA_DIR = path.join(tmpRoot, 'data');
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const providers = require('../src/providers/core.js');
const { createSessionPolicy } = require('../src/cli/session-policy.js');
const { createSessionProfileRoutes } = require('../src/routes/session-profile.js');
const { createProviderRoutes } = require('../src/routes/providers.js');
const { findProviderReferences } = require('../src/providers/references.js');
const { reassignProviderSessions } = require('../src/provider-reassign.js');

// ── Pure module: the planner, with no route or session runtime in the way ────

function moduleHarness(overrides = {}) {
  const sessions = new Map();
  for (const session of overrides.sessions || []) sessions.set(session.id, session);
  const patched = [];
  const previewed = [];
  const respond = overrides.respond || ((sessionId, body) => (
    { status: 200, body: { id: sessionId, model: 'target-model', provider: body.provider } }));
  return {
    sessions,
    patched,
    previewed,
    listProviders: () => overrides.providerList || [],
    validProviderId: overrides.validProviderId || ((_cli, id) => ({ ok: !!id, value: id || null })),
    applySessionPatch: (sessionId, body) => {
      patched.push({ sessionId, body });
      return respond(sessionId, body);
    },
    previewSessionPatch: (sessionId, body) => {
      previewed.push({ sessionId, body });
      return respond(sessionId, body);
    },
    findProviderReferences,
  };
}

test('listing mode reports bound sessions, static skips and only usable targets', () => {
  const harness = moduleHarness({
    sessions: [
      { id: 'a', label: 'Alpha', cli: 'claude', provider: 'route-a', model: 'm-a' },
      { id: 'z', cli: 'zcode', provider: 'route-a' },
      { id: 'auto', cli: 'claude', provider: 'route-a', providerSelection: { mode: 'auto', candidates: [] } },
      { id: 'other', cli: 'claude', provider: 'route-b' },
    ],
    providerList: [
      { id: 'route-a', appType: 'claude', name: 'Route A' },
      { id: 'route-b', appType: 'claude', name: 'Route B' },
      { id: 'route-z', appType: 'codex', name: 'Route Z' },
    ],
    validProviderId: (cli, id) => ({ ok: id !== 'route-z' || cli === 'zcode' }),
  });
  const references = findProviderReferences({
    appType: 'claude', providerId: 'route-a', sessions: harness.sessions, defaults: {}, aux: null,
  });
  const result = reassignProviderSessions({
    appType: 'claude', providerId: 'route-a', dryRun: true, references, sessions: harness.sessions,
    sourceProvider: { name: 'Route A' },
    listProviders: harness.listProviders, validProviderId: harness.validProviderId,
    applySessionPatch: harness.applySessionPatch, previewSessionPatch: harness.previewSessionPatch,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.total, 3, 'only sessions whose MAIN route is route-a');
  assert.deepEqual(result.sessions.map(item => item.sessionId), ['a', 'z', 'auto']);
  assert.deepEqual(result.sessions.map(item => item.reason), [null, null, 'auto_selection']);
  // route-b is usable by both movable sessions (the Auto one stays behind, and
  // is counted as a skip rather than offered blind); route-z only by the zcode
  // session, so the claude session counts as a skip there.
  assert.deepEqual(result.targets.map(item => [item.id, item.compatibleSessions, item.skippedSessions]), [
    ['route-b', 2, 1],
    ['route-z', 1, 2],
  ]);
  assert.equal(result.switched, 0);
  assert.deepEqual(harness.previewed, [], 'listing must not preview');
  assert.deepEqual(harness.patched, [], 'listing must not patch');
});

test('a target nobody can use is not offered', () => {
  const harness = moduleHarness({
    sessions: [{ id: 'a', cli: 'claude', provider: 'route-a' }],
    providerList: [
      { id: 'route-a', appType: 'claude', name: 'Route A' },
      { id: 'route-z', appType: 'codex', name: 'Route Z' },
    ],
    validProviderId: () => ({ ok: false }),
  });
  const result = reassignProviderSessions({
    appType: 'claude', providerId: 'route-a',
    references: [{ kind: 'main', sessionId: 'a' }], sessions: harness.sessions,
    listProviders: harness.listProviders, validProviderId: harness.validProviderId,
    applySessionPatch: harness.applySessionPatch, previewSessionPatch: harness.previewSessionPatch,
  });
  assert.deepEqual(result.targets, []);
});

test('no sessions: empty plan, nothing patched, target list still computed over zero sessions', () => {
  const harness = moduleHarness({
    sessions: [{ id: 'other', cli: 'claude', provider: 'route-b' }],
    providerList: [{ id: 'route-b', appType: 'claude', name: 'Route B' }],
  });
  const listing = reassignProviderSessions({
    appType: 'claude', providerId: 'route-a', dryRun: true, references: [], sessions: harness.sessions,
    listProviders: harness.listProviders, validProviderId: harness.validProviderId,
    applySessionPatch: harness.applySessionPatch, previewSessionPatch: harness.previewSessionPatch,
  });
  assert.equal(listing.total, 0);
  assert.deepEqual(listing.sessions, []);
  assert.deepEqual(listing.targets, []);

  const applied = reassignProviderSessions({
    appType: 'claude', providerId: 'route-a', targetProviderId: 'route-b',
    references: [], sessions: harness.sessions,
    targetProvider: { id: 'route-b', name: 'Route B' },
    listProviders: harness.listProviders, validProviderId: harness.validProviderId,
    applySessionPatch: harness.applySessionPatch, previewSessionPatch: harness.previewSessionPatch,
  });
  assert.equal(applied.switched, 0);
  assert.equal(applied.skipped, 0);
  assert.deepEqual(applied.results, []);
  assert.deepEqual(harness.patched, []);
});

test('per-session outcomes: switched, deferred, cli-incompatible, system and patch rejection', () => {
  const harness = moduleHarness({
    sessions: [
      { id: 'a', cli: 'claude', provider: 'route-a', model: 'stale-model' },
      { id: 'busy', cli: 'claude', provider: 'route-a', pendingConfiguration: { cli: 'claude', profile: {} } },
      { id: 'z', cli: 'zcode', provider: 'route-a' },
      { id: 'sys', cli: 'claude', provider: 'route-a', type: 'aux' },
    ],
    validProviderId: (cli, id) => ({ ok: cli === 'claude' }),
  });
  const result = reassignProviderSessions({
    appType: 'claude', providerId: 'route-a', targetProviderId: 'route-b', dryRun: true,
    references: ['a', 'busy', 'z', 'sys'].map(sessionId => ({ kind: 'main', sessionId })),
    sessions: harness.sessions,
    targetProvider: { id: 'route-b', name: 'Route B' },
    listProviders: harness.listProviders, validProviderId: harness.validProviderId,
    applySessionPatch: harness.applySessionPatch, previewSessionPatch: harness.previewSessionPatch,
  });

  assert.deepEqual(result.results.map(item => [item.sessionId, item.status, item.reason || null]), [
    ['a', 'switched', null],
    ['busy', 'switched', null],
    ['z', 'skipped', 'cli_incompatible'],
    ['sys', 'skipped', 'system_session'],
  ]);
  assert.equal(result.switched, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.deferred, 1, 'a staged configuration is the one deferral knowable offline');
  assert.deepEqual(harness.previewed.map(item => item.body), [
    { provider: 'route-b' }, { provider: 'route-b' },
  ]);
  assert.deepEqual(harness.patched, [], 'dry run must never apply');
});

test('apply routes every session through applySessionPatch and reports a rejected patch', () => {
  const harness = moduleHarness({
    sessions: [
      { id: 'a', label: 'Alpha', cli: 'claude', provider: 'route-a', model: 'stale' },
      { id: 'b', cli: 'claude', provider: 'route-a' },
    ],
    respond: (sessionId, body) => (sessionId === 'b'
      ? { status: 400, body: { error: 'invalid model' } }
      : { status: 200, body: { id: sessionId, model: 'target-model', provider: body.provider } }),
  });
  const result = reassignProviderSessions({
    appType: 'claude', providerId: 'route-a', targetProviderId: 'route-b',
    references: [{ kind: 'main', sessionId: 'a' }, { kind: 'main', sessionId: 'b' }],
    sessions: harness.sessions,
    targetProvider: { id: 'route-b', name: 'Route B' },
    listProviders: harness.listProviders, validProviderId: harness.validProviderId,
    applySessionPatch: harness.applySessionPatch, previewSessionPatch: harness.previewSessionPatch,
  });

  assert.deepEqual(harness.patched.map(item => [item.sessionId, item.body]), [
    ['a', { provider: 'route-b' }], ['b', { provider: 'route-b' }],
  ]);
  assert.equal(result.switched, 1);
  assert.equal(result.results[0].modelBefore, 'stale');
  assert.equal(result.results[0].modelAfter, 'target-model');
  assert.equal(result.results[0].modelReset, true);
  assert.deepEqual([result.results[1].status, result.results[1].reason], ['skipped', 'patch_rejected']);
});

test('other reference kinds are counted, never rewritten', () => {
  const harness = moduleHarness({ sessions: [{ id: 'a', cli: 'claude', provider: 'route-a' }] });
  const result = reassignProviderSessions({
    appType: 'claude', providerId: 'route-a', targetProviderId: 'route-b',
    references: [
      { kind: 'main', sessionId: 'a' },
      { kind: 'auto_candidate', sessionId: 'a' },
      { kind: 'subagent', sessionId: 'a' },
      { kind: 'default', cli: 'claude' },
      { kind: 'aux', protocol: 'anthropic' },
    ],
    sessions: harness.sessions,
    listProviders: harness.listProviders, validProviderId: harness.validProviderId,
    applySessionPatch: harness.applySessionPatch, previewSessionPatch: harness.previewSessionPatch,
  });
  assert.deepEqual(result.otherReferences, { auto_candidate: 1, subagent: 1, default: 1, aux: 1 });
  assert.equal(result.total, 1);
  assert.deepEqual(harness.patched.map(item => item.body), [{ provider: 'route-b' }]);
});

// ── Route + real session PATCH: the wiring the dialog actually calls ─────────

function fakeApp() {
  const routes = new Map();
  const register = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return {
    routes, get: register('GET'), post: register('POST'),
    patch: register('PATCH'), put: register('PUT'), delete: register('DELETE'),
  };
}

async function invoke(app, key, request = {}) {
  const handler = app.routes.get(key);
  assert.equal(typeof handler, 'function', `missing route ${key}`);
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  await handler({ params: {}, body: {}, query: {}, ...request }, res);
  return response;
}

const SUMMARIES = {
  'claude:route-a': { id: 'route-a', appType: 'claude', name: 'Route A', apiFormat: 'anthropic', baseUrl: 'https://a.test', hasToken: true, model: 'old-model', modelOptions: ['old-model'] },
  'claude:route-b': { id: 'route-b', appType: 'claude', name: 'Route B', apiFormat: 'anthropic', baseUrl: 'https://b.test', hasToken: true, model: 'target-model', modelOptions: ['target-model'] },
  'codex:route-z': { id: 'route-z', appType: 'codex', name: 'Route Z', apiFormat: 'openai_responses', baseUrl: 'https://z.test', hasToken: true, model: 'gpt-target', modelOptions: ['gpt-target'] },
};

function harness({ sessions = [], chatState = null, backgroundActive = false } = {}) {
  const persistedSessions = new Map(sessions.map(session => [session.id, session]));
  const summaries = SUMMARIES;
  const providerRouterRuntime = {
    getProviderSummary(appType, id) {
      if (appType == null) return summaries[`claude:${id}`] || summaries[`codex:${id}`] || null;
      return summaries[`${appType}:${id}`] || null;
    },
  };
  const effects = [];
  const app = fakeApp();
  const sessionPolicy = createSessionPolicy({
    providerRouter: providerRouterRuntime,
    providers: { appTypeForCli: providers.appTypeForCli },
    env: {},
    homeDir: () => process.env.HOME,
  });
  const profile = createSessionProfileRoutes({
    persistedSessions,
    directories: new Map([['d1', { id: 'd1', path: '/tmp/d1' }]]),
    sessionPersistence: {
      begin: () => { effects.push('persistence-begin'); return { commit() {}, rollback() {} }; },
      mutate: (_reason, fn) => fn(),
    },
    sessionPolicy,
    providers: {
      appTypeForCli: providers.appTypeForCli,
      modelValidForProvider: providers.modelValidForProvider,
      codexProviderProxyable: providers.codexProviderProxyable,
      synchronizeCodexSessionRoute: () => ({ synchronized: false }),
      CODEX_HOMES_DIR: providers.CODEX_HOMES_DIR,
    },
    providerRouterRuntime,
    getChatStream: () => ({ close: id => effects.push(`stream-close:${id}`) }),
    getChatState: () => chatState,
    hasLiveBackgroundTasks: () => backgroundActive,
    validProviderId: (cli, id) => {
      const appType = providers.appTypeForCli(cli);
      const summary = providers.appTypesForCli(cli).length > 1
        ? providerRouterRuntime.getProviderSummary(undefined, id)
        : providerRouterRuntime.getProviderSummary(appType, id);
      if (!summary || !providers.providerSupportsCli(summary, cli)) return { ok: false };
      return { ok: true, value: String(id) };
    },
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
  const routes = createProviderRoutes({
    fs: { readFileSync() { throw new Error('no provider-defaults file'); } },
    providerDefaultsFile: path.join(tmpRoot, 'provider-defaults.json'),
    atomicWriteJson: () => {},
    providers: {
      ...providers,
      getProvider(appType, id) {
        const summary = appType == null
          ? (summaries[`claude:${id}`] || summaries[`codex:${id}`])
          : summaries[`${appType}:${id}`];
        return summary || null;
      },
      listProviders: () => Object.values(summaries),
    },
    providerRouterRuntime,
    findProviderReferences,
    persistedSessions,
    providerRelayShares: { create() {}, list: () => [], revoke: () => null, revokeProvider: () => 0 },
    getAuxConfig: () => ({ protocol: 'anthropic', providerId: null }),
    clearAuxProvider: () => {},
    applySessionPatch: profile.applySessionPatch,
    previewSessionPatch: profile.previewSessionPatch,
    claudeCmd: '/usr/local/bin/claude',
    getPort: () => 4321,
    getClaudeOfficialViaProxy: () => false,
    http: { request() { throw new Error('unexpected HTTP'); } },
    https: { request() { throw new Error('unexpected HTTP'); } },
    logger: { error() {} },
  });
  routes.mountCatalogRoutes(app);
  routes.mountManagementRoutes(app);
  return { app, persistedSessions, effects, sessions };
}

const ROUTE = 'POST /api/providers/:appType/:id/reassign-sessions';

test('the route is mounted next to the other provider management routes', async () => {
  const { app } = harness();
  assert.ok(app.routes.has(ROUTE));
});

test('route guards: unknown source/target, same target, missing target on apply', async () => {
  const { app } = harness({ sessions: [{ id: 'a', dirId: 'd1', cli: 'claude', provider: 'route-a' }] });

  let response = await invoke(app, ROUTE, { params: { appType: 'qoder', id: 'route-a' } });
  assert.equal(response.statusCode, 400);

  response = await invoke(app, ROUTE, { params: { appType: 'claude', id: 'nope' } });
  assert.equal(response.statusCode, 404);

  response = await invoke(app, ROUTE, {
    params: { appType: 'claude', id: 'route-a' }, body: { targetProviderId: 'route-a' },
  });
  assert.equal(response.statusCode, 400);

  response = await invoke(app, ROUTE, { params: { appType: 'claude', id: 'route-a' }, body: {} });
  assert.equal(response.statusCode, 400);

  response = await invoke(app, ROUTE, {
    params: { appType: 'claude', id: 'route-a' }, body: { targetProviderId: 'ghost' },
  });
  assert.equal(response.statusCode, 404);
});

test('dry run switch previews the model reset and writes nothing', async () => {
  const session = {
    id: 'a', dirId: 'd1', cli: 'claude', kind: 'chat', label: 'Alpha',
    provider: 'route-a', model: 'stale-relay-model',
  };
  const { app, effects } = harness({ sessions: [session] });

  const response = await invoke(app, ROUTE, {
    params: { appType: 'claude', id: 'route-a' },
    body: { targetProviderId: 'route-b', dryRun: true },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.dryRun, true);
  assert.equal(response.body.total, 1);
  assert.deepEqual(response.body.results, [{
    sessionId: 'a', label: 'Alpha', cli: 'claude', status: 'switched', deferred: false,
    modelBefore: 'stale-relay-model', modelAfter: 'target-model', modelReset: true,
  }]);
  assert.equal(session.provider, 'route-a', 'dry run must not move the session');
  assert.equal(session.model, 'stale-relay-model');
  assert.deepEqual(effects, [], 'dry run must not begin persistence or close the stream');
});

test('apply moves the sessions and replaces the model the target does not serve', async () => {
  const alpha = {
    id: 'a', dirId: 'd1', cli: 'claude', kind: 'chat', label: 'Alpha',
    provider: 'route-a', model: 'stale-relay-model',
  };
  const zulu = { id: 'z', dirId: 'd1', cli: 'zcode', kind: 'chat', provider: 'route-a', model: 'gpt-target' };
  const { app, effects } = harness({ sessions: [alpha, zulu] });

  const response = await invoke(app, ROUTE, {
    params: { appType: 'claude', id: 'route-a' },
    body: { targetProviderId: 'route-b' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.switched, 2);
  assert.equal(alpha.provider, 'route-b');
  assert.equal(alpha.model, 'target-model', 'the stale relay model is replaced, not carried over');
  assert.equal(zulu.provider, 'route-b');
  // A warm claude stream must be torn down so the next turn respawns on the new env.
  assert.deepEqual(effects.filter(entry => entry === 'stream-close:a'), ['stream-close:a']);

  // And the very path the dialog uses for one session agrees with the bulk move.
  assert.equal(providers.modelValidForProvider('claude', 'route-b', 'stale-relay-model', SUMMARIES['claude:route-b']), false);
  assert.equal(providers.modelValidForProvider('claude', 'route-b', 'target-model', SUMMARIES['claude:route-b']), true);
});

test('a session on the other CLI is skipped and reported, not pointed at the target', async () => {
  const alpha = { id: 'a', dirId: 'd1', cli: 'claude', provider: 'route-a', model: 'old-model' };
  const zulu = { id: 'z', dirId: 'd1', cli: 'zcode', provider: 'route-a', model: 'gpt-target' };
  const { app } = harness({ sessions: [alpha, zulu] });

  const response = await invoke(app, ROUTE, {
    params: { appType: 'claude', id: 'route-a' },
    body: { targetProviderId: 'route-z' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.results.map(item => [item.sessionId, item.status, item.reason || null]), [
    ['a', 'skipped', 'cli_incompatible'],
    ['z', 'switched', null],
  ]);
  assert.equal(alpha.provider, 'route-a', 'a skipped session keeps its route');
  assert.equal(zulu.provider, 'route-z');
});

test('an Auto-selection session is left in Auto and reported as skipped', async () => {
  const session = {
    id: 'a', dirId: 'd1', cli: 'claude', provider: 'route-a', model: 'old-model',
    providerSelection: { mode: 'auto', candidates: [{ providerId: 'route-a', enabled: true }] },
  };
  const { app } = harness({ sessions: [session] });

  const response = await invoke(app, ROUTE, {
    params: { appType: 'claude', id: 'route-a' },
    body: { targetProviderId: 'route-b' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual([response.body.results[0].status, response.body.results[0].reason],
    ['skipped', 'auto_selection']);
  assert.equal(session.provider, 'route-a');
  assert.equal(session.providerSelection.mode, 'auto', 'Auto must survive a bulk move');
});

test('a busy session is deferred to its next turn, never interrupted', async () => {
  const session = {
    id: 'a', dirId: 'd1', cli: 'claude', kind: 'chat',
    provider: 'route-a', model: 'old-model',
  };
  const { app } = harness({
    sessions: [session],
    chatState: { _activeRunner: { providerAttempt: { routeAttemptId: 'attempt-a' } } },
  });

  const response = await invoke(app, ROUTE, {
    params: { appType: 'claude', id: 'route-a' },
    body: { targetProviderId: 'route-b' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.switched, 1);
  assert.equal(response.body.deferred, 1);
  assert.equal(response.body.results[0].deferred, true);
  assert.equal(session.provider, 'route-a', 'the running turn keeps its route');
  assert.equal(session.pendingConfiguration.profile.provider, 'route-b');
});

test('listing mode is reachable without a target and reports zero sessions', async () => {
  const { app } = harness();
  const response = await invoke(app, ROUTE, {
    params: { appType: 'codex', id: 'route-z' }, body: { dryRun: true },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.dryRun, true);
  assert.equal(response.body.total, 0);
  assert.deepEqual(response.body.sessions, []);
  assert.deepEqual(response.body.targets, []);
});

// ── Cross-end: the two dialogs are one contract ─────────────────────────────
// The web panel (public/air-provider.js `openReassign`) and the App sheet
// (app/lib/widgets/provider_reassign_dialog.dart) are two renderings of the
// same three calls. Neither is exercised end to end here; what IS pinned is the
// part that drifts silently: the copy set the two sides must share, and the
// order in which `dryRun` is dropped. Losing `dryRun` on the listing or the
// preview would move sessions while the user is still reading what would
// happen — the preview would be a lie.

const repoRoot = path.resolve(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const reassignKeys = source =>
  new Set(source.match(/airProviderReassign[A-Za-z]+/g) || []);

// The web picker hangs the skip count on `<option title>`; Material's
// DropdownMenuItem has no tooltip, so this one key is web-only by design.
const WEB_ONLY_KEYS = ['airProviderReassignTargetSkip'];

test('web panel and App sheet read the same reassign copy set', () => {
  const web = reassignKeys(readSource('public/air-provider.js'));
  const app = reassignKeys([
    readSource('app/lib/widgets/provider_reassign_dialog.dart'),
    // The card action lives on the provider screen, not inside the dialog.
    readSource('app/lib/screens/provider_screen.dart'),
  ].join('\n'));

  assert.ok(web.size > 25, `expected the web dialog to use the copy set, saw ${web.size}`);
  assert.deepEqual(
    [...web].filter(key => !app.has(key)).sort(),
    WEB_ONLY_KEYS,
    'the only web-only key may be the <option title> tooltip',
  );
  assert.deepEqual([...app].filter(key => !web.has(key)), [], 'the App may not invent keys');

  const zh = JSON.parse(readSource('app/assets/i18n/zh.json'));
  const en = JSON.parse(readSource('app/assets/i18n/en.json'));
  for (const key of app) {
    assert.ok(zh[key], `zh.json is missing ${key}`);
    assert.ok(en[key], `en.json is missing ${key}`);
    // Same placeholders both sides, or one language drops the count.
    const holes = text => (text.match(/\{(\w+)\}/g) || []).sort();
    assert.deepEqual(holes(en[key]), holes(zh[key]), `${key} placeholders differ`);
  }
});

test('both dialogs list with a dry run and only the last call drops it', () => {
  const web = readSource('public/air-provider.js');
  assert.match(web, /context\.api\(path, \{ dryRun: true \}, 'POST'\)/,
    'the listing call must be a dry run');
  assert.match(web, /context\.api\(path, \{ targetProviderId: target, dryRun: true \}, 'POST'\)/,
    'picking a target must only preview');
  assert.match(web, /context\.api\(path, \{ targetProviderId: target \}, 'POST'\)/,
    'confirm is the one call that applies');

  const app = readSource('app/lib/widgets/provider_reassign_dialog.dart');
  const callSites = app.match(/reassignProviderSessions\([\s\S]{0,160}?\)/g) || [];
  assert.equal(callSites.length, 3, 'the App sheet makes exactly three calls');
  assert.match(callSites[0], /dryRun: true/, 'listing is a dry run');
  assert.match(callSites[1], /targetProviderId: _target,\s*dryRun: true,/,
    'picking a target only previews');
  assert.doesNotMatch(callSites[2], /dryRun/,
    'confirm must NOT carry dryRun — otherwise nothing moves');
  assert.match(callSites[2], /targetProviderId: _target/);
});
