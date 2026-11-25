'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  API_VERSION,
  createErrorDto,
  createWsEnvelope,
  toDispatchResultDto,
  toProviderDto,
  toWaitDto,
  withApiMeta,
} = require('../src/api-contract');
const {
  assertBackwardCompatible,
  loadSchemaRegistry,
  validate,
  validateOpenApiDocument,
  validateSchemaDocument,
} = require('./helpers/contract-validator');
const { toSessionDto } = require('../src/session-dto');
const { gatewayDto } = require('../src/voice/gateway');

const ROOT = path.join(__dirname, '..');
const CONTRACT_DIR = path.join(ROOT, 'contracts', API_VERSION);
const SCHEMA_DIR = path.join(CONTRACT_DIR, 'schemas');
const registry = loadSchemaRegistry(SCHEMA_DIR);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function schema(name) {
  const value = registry.get(name);
  assert.ok(value, `schema is registered: ${name}`);
  return value;
}

function assertValid(name, value) {
  const result = validate(schema(name), value, { registry });
  assert.deepEqual(result.errors, [], `${name}: ${result.errors.join('; ')}`);
  assert.equal(result.valid, true);
}

function serialized(value) {
  return JSON.stringify(value);
}

test('all v1 schemas and OpenAPI references are self-contained and valid', () => {
  const schemaFiles = fs.readdirSync(SCHEMA_DIR).filter(name => name.endsWith('.schema.json')).sort();
  assert.ok(schemaFiles.length >= 10);
  for (const name of schemaFiles) {
    const result = validateSchemaDocument(schema(name), name);
    assert.deepEqual(result.errors, [], `${name}: ${result.errors.join('; ')}`);
  }

  const openapi = readJson(path.join(CONTRACT_DIR, 'openapi.json'));
  const result = validateOpenApiDocument(openapi, registry);
  assert.deepEqual(result.errors, []);
  for (const endpoint of [
    '/api/v1/sessions',
    '/api/v1/sessions/{id}',
    '/api/v1/directories/{id}/workspace',
    '/api/v1/providers',
    '/api/v1/sessions/{id}/waits',
    '/api/v1/sessions/{id}/dispatch',
    '/api/v1/voice-gateways',
    '/api/v1/directories/{id}/voice-gateway',
    '/api/v1/voice-runtime',
    '/api/v1/voice-runtime/install',
    '/api/v1/directories/{id}/voice-gateway/runtime',
    '/api/v1/directories/{id}/voice-gateway/restart',
  ]) assert.ok(openapi.paths[endpoint], `OpenAPI path exists: ${endpoint}`);
});

test('golden API and WebSocket examples conform to versioned schemas', () => {
  const golden = readJson(path.join(CONTRACT_DIR, 'golden', 'examples.json'));
  assert.ok(golden.examples.length >= 8);
  for (const example of golden.examples) assertValid(example.schema, example.value);
});

test('session DTO is canonical, schema-valid, and excludes process or filesystem details', () => {
  const dto = toSessionDto({
    id: 'session-contract',
    dirId: 'directory-contract',
    cli: 'codex',
    kind: 'chat',
    label: 'Contract test',
    model: 'gpt-test',
    effectiveModel: 'gpt-effective',
    effort: 'high',
    effectiveEffort: 'high',
    provider: 'provider-safe-id',
    providerSelection: {
      version: 1,
      mode: 'auto',
      protocol: 'openai_responses',
      candidates: [
        { providerId: 'official', model: null, priority: 1, enabled: true },
        { providerId: 'provider-safe-id', model: 'gpt-test', priority: 2, enabled: true },
      ],
      maxAttempts: 2,
      sticky: true,
      allowCrossTrust: true,
      presetId: 'preset-contract',
    },
    subagent: { providerId: 'sub-safe-id', model: 'sub-model', effectiveModel: 'sub-effective' },
    autoCommit: true,
    createdAt: 1784332800000,
    lastActivity: '2026-07-18T01:00:00.000Z',
    clients: 2,
    active: true,
    mergeState: { ahead: 2, behind: 1, dirty: true, mergeReady: false, rebaseInProgress: false },
    cwd: '/private/repository',
    worktreePath: '/private/worktree',
    cliSessionId: 'native-session-secret',
    rolePrompt: 'hidden prompt',
    accessToken: 'secret-token',
    stack: 'Error at /private/repository/server.js',
  });

  assertValid('session.schema.json', dto);
  assert.equal(dto.providerSelection.allowCrossTrust, true,
    'session DTO preserves explicit cross-trust authorization');
  assert.equal(dto.providerSelection.presetId, 'preset-contract',
    'session DTO carries the cosmetic preset provenance');
  const wire = serialized(dto);
  for (const forbidden of ['/private/', 'native-session-secret', 'hidden prompt', 'secret-token', 'Error at']) {
    assert.equal(wire.includes(forbidden), false, `DTO excludes ${forbidden}`);
  }

  const response = withApiMeta({ session: dto }, { requestId: 'req-session', correlationId: 'corr-session' });
  assertValid('session-response.schema.json', response);
});

test('provider and wait adapters expose status without credentials, commands, URLs, paths, or stacks', () => {
  const provider = toProviderDto({
    id: 'provider-1', appType: 'claude', protocol: 'anthropic', wireApi: 'messages',
    name: 'Provider', source: 'local', model: 'model-1', modelOptions: ['model-1', 'model-1'],
    compatibleClis: ['claude', 'codex-exp', 'malicious-cli'],
    hasToken: true, token: 'provider-secret', tokenMask: 'sk-****', baseUrl: 'https://private.example/v1',
    cwd: '/private/provider', stack: 'private stack',
  });
  assertValid('provider.schema.json', provider);
  assert.equal(provider.hasCredentials, true);
  assert.deepEqual(provider.compatibleClis, ['claude', 'codex-exp']);

  const wait = toWaitDto({
    id: 'w_safe', session: 'session-contract', mode: 'poll', checks: 1,
    maxChecks: 40, intervalSec: 15, createdAt: 1784332800000,
    token: 'callback-secret', pollCmd: 'cat /private/result', pollUrl: 'https://private.example',
    untilContains: 'secret marker', cwd: '/private/repository', stack: 'private stack',
  });
  assertValid('wait.schema.json', wait);
  assert.equal(toWaitDto({
    id: 'w_delay',
    session: 'session-contract',
    mode: 'delay',
    createdAt: 1784332800000,
  }).mode, 'delay');

  const wire = serialized({ provider, wait });
  for (const forbidden of ['provider-secret', 'sk-****', 'private.example', '/private/', 'secret marker', 'private stack']) {
    assert.equal(wire.includes(forbidden), false, `adapters exclude ${forbidden}`);
  }
});

test('errors carry both ids and redact credentials and absolute paths', () => {
  const body = createErrorDto({
    message: 'Bearer abcdefghijklmnop failed at /Users/example/private/server.js with sk-test_abcdefghijklmnop',
    code: 'dispatch_failed',
    requestId: 'req-error',
    correlationId: 'corr-error',
    upstreamRequestId: 'upstream-error',
  });
  assertValid('error.schema.json', body);
  assert.equal(body.apiVersion, API_VERSION);
  assert.equal(body.requestId, 'req-error');
  assert.equal(body.correlationId, 'corr-error');
  assert.equal(body.upstreamRequestId, 'upstream-error');
  assert.equal(body.error.includes('abcdefghijklmnop'), false);
  assert.equal(body.error.includes('/Users/'), false);
});

test('WebSocket envelope is additive and dispatch result uses the same metadata contract', () => {
  const envelope = createWsEnvelope(
    { type: 'snapshot', sessionId: 'session-contract', revision: 9 },
    { requestId: 'req-ws', correlationId: 'corr-ws' },
  );
  assertValid('ws-envelope.schema.json', envelope);
  assert.equal(envelope.sessionId, 'session-contract');
  assert.equal(envelope.revision, 9);

  const dispatch = withApiMeta(toDispatchResultDto({
    ok: true, target: 'session-target', chatId: 'chat-1', note: 'accepted',
  }), { requestId: 'req-dispatch', correlationId: 'corr-dispatch' });
  assertValid('dispatch-response.schema.json', dispatch);
});

test('voice gateway contract exposes only the Fleet binding and never launch credentials or paths', () => {
  const gatewayRecord = {
    id: '__voice_gateway__contract',
    dirId: 'directory-1',
    type: 'gateway',
    kind: 'voice',
    gatewayKind: 'qwen-audio',
    enabled: true,
    commanderSessionId: 'commander-1',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:01:00.000Z',
    command: '/private/node',
    accessToken: 'secret',
  };
  const records = new Map([['commander-1', {
    id: 'commander-1',
    dirId: 'directory-1',
    type: 'commander',
    kind: 'chat',
    label: 'Commander',
  }], [gatewayRecord.id, gatewayRecord]]);
  const gateway = gatewayDto(records, gatewayRecord);
  assertValid('voice-gateway.schema.json', gateway);
  const response = withApiMeta(
    { ok: true, gateway },
    { requestId: 'req-voice', correlationId: 'corr-voice' },
  );
  assertValid('voice-gateway-response.schema.json', response);
  assert.equal(serialized(response).includes('/private/'), false);
  assert.equal(serialized(response).includes('secret'), false);
});

test('Qwen Audio runtime contracts expose lifecycle state without paths, pids, logs, or credentials', () => {
  const shared = withApiMeta({
    ok: true,
    runtime: {
      state: 'ready',
      installed: true,
      supported: true,
      platform: 'darwin-arm64',
      package: { name: 'qwen-audio-agent', version: '1.1.1' },
      node: { version: '24.15.0', managed: true },
      progress: { stage: 'complete', detail: null },
      lastError: null,
    },
  }, { requestId: 'req-qwen', correlationId: 'corr-qwen' });
  assertValid('qwen-audio-runtime-response.schema.json', shared);

  const fleet = withApiMeta({
    ok: true,
    runtime: {
      directoryId: 'directory-1',
      desired: true,
      state: 'running',
      url: 'http://127.0.0.1:32123',
      installedVersion: '1.1.1',
      restartCount: 0,
      health: {
        voiceConfigured: true,
        backendReady: true,
        model: 'qwen-audio-3.0-realtime-plus',
      },
      lastError: null,
      lastExitAt: null,
    },
  }, { requestId: 'req-qwen-fleet', correlationId: 'corr-qwen-fleet' });
  assertValid('qwen-audio-fleet-runtime-response.schema.json', fleet);
  assert.doesNotMatch(serialized({ shared, fleet }), /api.?key|secret|pid|logs|\/private\//i);
});

test('v1 compatibility baseline catches required-field, property, enum, const, and ref breaks', () => {
  const baseline = readJson(path.join(CONTRACT_DIR, 'compatibility-baseline.json'));
  assert.deepEqual(assertBackwardCompatible(baseline, registry), { compatible: true, errors: [] });

  const brokenRegistry = new Map(registry);
  const brokenSession = structuredClone(schema('session.schema.json'));
  delete brokenSession.properties.model;
  brokenSession.properties.cli.enum = ['claude'];
  brokenSession.properties.type.const = 'job';
  brokenSession.required.push('futureRequiredField');
  brokenRegistry.set('session.schema.json', brokenSession);
  brokenRegistry.set(brokenSession.$id, brokenSession);

  const brokenWorkspaceEntry = structuredClone(schema('workspace-entry.schema.json'));
  brokenWorkspaceEntry.properties.session.$ref = 'provider.schema.json';
  brokenRegistry.set('workspace-entry.schema.json', brokenWorkspaceEntry);
  brokenRegistry.set(brokenWorkspaceEntry.$id, brokenWorkspaceEntry);
  const brokenWorkspace = structuredClone(schema('workspace.schema.json'));
  brokenWorkspace.properties.sessions.items.$ref = 'provider.schema.json';
  brokenRegistry.set('workspace.schema.json', brokenWorkspace);
  brokenRegistry.set(brokenWorkspace.$id, brokenWorkspace);
  const brokenWorkspaceResponse = structuredClone(schema('workspace-response.schema.json'));
  brokenWorkspaceResponse.properties.workspace.$ref = 'provider.schema.json';
  brokenRegistry.set('workspace-response.schema.json', brokenWorkspaceResponse);
  brokenRegistry.set(brokenWorkspaceResponse.$id, brokenWorkspaceResponse);

  const result = assertBackwardCompatible(baseline, brokenRegistry);
  assert.equal(result.compatible, false);
  assert.ok(result.errors.some(item => item.includes('required fields changed')));
  assert.ok(result.errors.some(item => item.includes('property removed: model')));
  assert.ok(result.errors.some(item => item.includes('enum value removed')));
  assert.ok(result.errors.some(item => item.includes('const changed')));
  assert.ok(result.errors.filter(item => item.includes('ref changed')).length >= 3);
});

test('orchestration and unattended routes: host port mounted once without public Node routes', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const count = (text, needle) => text.split(needle).length - 1;
  // The 23 migrated routes are answered by the Rust front door
  // (orchestration_routes.rs). The four retired modules register only on the
  // host port's capture app; the single real-app mount is the host endpoint.
  assert.equal(count(source, 'createOrchestrationHost({ express })'), 1);
  assert.equal(count(source, 'orchestrationHost.mountRoute(app)'), 1);
  assert.ok(source.includes('mountAuxGoalRoutes(orchestrationHost.app,'));
  assert.ok(source.includes('createAuxRunRoutes({ records: persistedSessions, getLog: () => auxRunLog }).mountRoutes(orchestrationHost.app)'));
  assert.ok(source.includes('orchestrationRoutes.mountHostRoutes(orchestrationHost.app)'));
  assert.equal(/mountAuxGoalRoutes\(app\b/.test(source), false);
  assert.equal(/createAuxRunRoutes\([^)]*\)\.mountRoutes\(app\)/.test(source), false);
  assert.equal(source.includes('orchestrationRoutes.mountHostRoutes(app)'), false);
  // The second batch took the wait-injector / detached set too, so the module
  // has no public mount left at all: every one of its sixteen routes is behind
  // the host port. A `mountRoutes` export reappearing here means a route went
  // back onto the real app, where it would answer alongside the front door.
  assert.equal(count(source, 'orchestrationRoutes.mountRoutes(app)'), 0);
  const orchestration = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'orchestration.js'), 'utf8');
  assert.equal(/function mountRoutes\s*\(/.test(orchestration), false,
    'orchestration.js must not grow a public mount back');
  assert.ok(orchestration.includes('return Object.freeze({ mountHostRoutes });'));
  const hostHalf = orchestration.slice(orchestration.indexOf('function mountHostRoutes(app)'));
  for (const route of [
    "app.post('/api/sessions/:id/wait'",
    "app.post('/api/wait/:wid/resolve'",
    "app.get('/api/sessions/:id/waits'",
    "app.delete('/api/wait/:wid'",
    "app.post('/api/sessions/:id/run-detached'",
    "app.get('/api/sessions/:id/detached'",
    "app.get('/api/detached/:taskId'",
    "app.get('/api/v1/sessions/:id/waits'",
  ]) {
    assert.ok(hostHalf.includes(route), `${route} must be captured by the host port`);
  }
  // Both waits listings are ours now, but they stay two routes with two DTOs.
  assert.ok(hostHalf.includes("app.get('/api/sessions/:id/waits'"));
  assert.ok(hostHalf.includes("app.get('/api/v1/sessions/:id/waits'"));
  for (const file of ['src/routes/aux-goal.js', 'src/routes/aux-runs.js', 'src/unattended/routes.js']) {
    assert.equal(/\bapp\s*=\s*express\(\)/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')), false);
  }
});

test('server composition uses canonical adapters and retires legacy dispatch endpoints', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const sessionAdmin = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'session-admin.js'), 'utf8');
  const orchestrationRoutes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'orchestration.js'), 'utf8');
  const workspaceRuntime = fs.readFileSync(path.join(ROOT, 'src', 'workspace', 'runtime.js'), 'utf8');
  const authRoutes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'auth.js'), 'utf8');
  const voiceHost = fs.readFileSync(path.join(ROOT, 'src', 'voice', 'host.js'), 'utf8');
  assert.ok(source.includes('getNative().chatHistoryFileRepositoryCreate({ root: MULTICC_PATHS.chatHistoryDir'));
  assert.ok(source.includes("createWorkspaceRuntime } = require('./src/workspace/runtime')"));
  assert.ok(source.includes('const workspaceRuntime = createWorkspaceRuntime({'));
  assert.ok(workspaceRuntime.includes('getNative().RustWorkspaceState'));
  assert.ok(!workspaceRuntime.includes('const status = new Map()'));
  assert.ok(source.includes("createSessionAdminRuntime } = require('./src/routes/session-admin')"));
  assert.ok(source.includes('const sessionAdmin = createSessionAdminRuntime({'));
  assert.ok(source.includes('sessionAdmin.mountRoutes(app, { unattendedApp: orchestrationHost.app })'));
  assert.ok(sessionAdmin.includes('const sessionQuery = createSessionQueryService({'));
  assert.ok(sessionAdmin.includes('const sessionWorkspace = createWorkspaceService({'));
  // The thirteen public session-admin routes are owned by the Rust front door
  // (native/gateway/src/app/session_admin.rs); Node may only expose the loopback
  // host port, never the public paths themselves.
  assert.ok(sessionAdmin.includes('mountSessionAdminHostRoute(app, {'));
  assert.equal(sessionAdmin.includes("app.get('/api/v1/sessions'"), false);
  assert.equal(sessionAdmin.includes("app.get('/api/sessions'"), false);
  // Unattended mode owns the per-session goal loop (docs/unattended-mode.md); its
  // GET/POST are answered by the Rust front door (orchestration_routes.rs), so
  // they are mounted only on the orchestration host port's capture app, never on
  // the public app.
  assert.ok(sessionAdmin.includes("mountUnattendedRoutes(unattendedApp, deps)"));
  assert.equal(sessionAdmin.includes("mountUnattendedRoutes(app, deps)"), false);
  // /api/v1/providers is owned by the Rust front door (providers.rs); Node must
  // not register the same path a second time.
  assert.doesNotMatch(source, /app\.get\(['"]\/api\/v1\/providers['"]/);
  assert.equal(sessionAdmin.includes("app.get('/api/v1/directories/:id/workspace'"), false);
  // The v1 waits projection is one of the nine orchestration routes the front door
  // answers (mountHostRoutes, captured by the host port), and after the second
  // batch so is every wait/detached route: mountHostRoutes is the only mount.
  assert.ok(orchestrationRoutes.includes("app.get('/api/v1/sessions/:id/waits'"));
  assert.ok(orchestrationRoutes.includes("app.get('/api/sessions/:id/waits'"));
  assert.ok(orchestrationRoutes.includes('function mountHostRoutes(app)'));
  assert.equal(/function mountRoutes\s*\(/.test(orchestrationRoutes), false);
  // The auth surface (shutdown gate, login/logout, gate middleware, exchange,
  // ws-ticket) is composed from src/routes/auth.js. The gate delegates to Rust;
  // real wait-resolve method/path authorization is covered by auth-routes.
  assert.ok(source.includes("createAuthRuntime } = require('./src/routes/auth')"));
  assert.ok(source.includes('authRuntime.mountRoutes(app)'));
  assert.ok(authRoutes.includes('const native = getNative()'));
  assert.ok(authRoutes.includes('native.httpEntryGate(stage, req, res, next, entryPort)'));
  assert.ok(authRoutes.includes("app.use(gate('auth'))"));
  assert.doesNotMatch(source, /app\.post\(['"]\/api\/(?:v1\/)?sessions\/:id\/dispatch/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'routes', 'dispatch-contract.js')), false);
  assert.ok(source.includes("createVoiceHost } = require('./src/voice/host')"));
  assert.ok(source.includes('getBaseUrl: () => `http://127.0.0.1:${PORT}`'));
  assert.doesNotMatch(source, /getBaseUrl:\s*\(\)\s*=>[^\n]*\bgetPort\(\)/);
  assert.ok(voiceHost.includes("createVoiceGatewayHost } = require('../routes/voice-gateway-host')"));
  // The public global voice gateway / voice runtime routes are owned by the Rust
  // front door; Node keeps only the internal host port it calls back into.
  assert.ok(voiceHost.includes("createVoiceRuntimeHost } = require('../routes/voice-runtime-host')"));
  assert.doesNotMatch(voiceHost, /routes\/voice-gateway-global|routes\/qwen-audio-runtime/);
  assert.ok(source.includes('JSON.stringify(createWsEnvelope(payload))'));
  // The outward task short-code registry must be the persisted one — without
  // this wiring the singleton silently degrades to in-memory and every code
  // remints on restart, breaking the uniqueness-across-time guarantee.
  assert.ok(source.includes('initTaskShortCodeRegistry({ file: MULTICC_PATHS.taskShortCodesFile })'));
  // Every task_state producer must carry the outward short code. The connect-time
  // seed in turn-engine once omitted it, so a freshly opened chat showed the bare
  // goal until the next classify event — pin the field on the wire. The payload
  // now lives in one shared native builder: the seed and
  // the task-state store's live broadcast must send the SAME frame,
  // because they once drifted and a reopened page lost the last API error (the
  // seed omitted apiError, and api_error_policy events are never replayed).
  // The builder moved to multicc_core::chat_task_state_frame, so the fields are
  // pinned there now — on the kernel and on the frozen corpus rather than on a
  // JavaScript source line, which is what keeps the two producers honest.
  const frameHost = fs.readFileSync(path.join(ROOT, 'native/addon/src/chat_connect_frames.rs'), 'utf8');
  const runtime = fs.readFileSync(path.join(ROOT, 'src/native/runtime.js'), 'utf8');
  assert.ok(runtime.includes("require('./task-domain').taskShortCode, auxVerdictStaleness"));
  assert.ok(runtime.includes('getNative().chatTaskStateFrame(task, seedOnly'));
  assert.ok(frameHost.includes('chat_task_state_payload(encode(envelope)?)'));
  const kernel = fs.readFileSync(
    path.join(ROOT, 'native', 'core', 'src', 'chat_task_state_frame.rs'), 'utf8');
  for (const field of ['taskShortCode', 'apiError', 'cancelledAt', 'cancelReason',
    'classifyState', 'goalState', 'auxUnhealthy', 'auxUnhealthySince']) {
    assert.ok(kernel.includes(`"${field}"`), `the kernel must carry ${field} on the wire`);
  }
  // The two regressions these fields exist for, asserted as behaviour on the
  // frozen corpus rather than as text: a persisted error alone still seeds,
  // and a cancellation reason never outlives its timestamp.
  const taskStateCorpus = require(
    '../docs/rust-migration/differential/chat-task-state-frame-corpus.json');
  const errorOnly = taskStateCorpus.cases.find(entry => entry.sweep === 'gate'
    && entry.name === 'goal=absent phase=absent apiError=envelope');
  assert.ok(errorOnly && errorOnly.expected.seeds === true,
    'a persisted error envelope alone must still seed the frame');
  assert.ok(errorOnly.expected.seed.apiError,
    'the seeded frame must carry the error a reopened page re-renders the bar from');
  const reasonWithoutStamp = taskStateCorpus.cases.find(entry => entry.sweep === 'cancel'
    && entry.name === 'cancelledAt=absent cancelReason=string');
  assert.equal(reasonWithoutStamp.expected.payload.cancelReason, null,
    'a cancel reason with no timestamp must be dropped');
  assert.ok(runtime.includes('taskStateSeed = task => taskStateFrame(task, true)'));
  assert.ok(runtime.includes('taskStatePayload = task => taskStateFrame(task, false)'));
  assert.ok(frameHost.includes('seed_only && !chat_task_state_should_seed'));
  const turnEngine = fs.readFileSync(path.join(ROOT, 'src', 'chat', 'turn-engine.js'), 'utf8');
  assert.ok(turnEngine.includes("taskStateSeed } = require('../native/runtime')"));
  // The connect sequence is the kernel's plan now, so the step is what gets
  // pinned, not an inline `if`.
  assert.ok(turnEngine.includes("step.op === 'taskStateSeed'"),
    'the connect path must send the seed when the plan emits it');
  assert.ok(turnEngine.includes('chatConnectReplayPlan') && !turnEngine.includes('hasTaskStateSeed:'),
    'the connect plan must schedule seed resolution without eagerly building the frame');
  // The live broadcast is the task-state store's: server.js builds it and
  // keeps no inline copy, so the cancel-flow tests run the production code.
  assert.ok(source.includes("require('./src/routes/task-state-store')"),
    'server.js must build its task state from the one store');
  assert.ok(source.includes('createTaskStateStore({'));
  assert.doesNotMatch(source, /TASK_STATE_DEFAULTS|taskStatePayload\(/,
    'no second getTaskState/setTaskState may grow back inside server.js');
  const taskStateStore = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'task-state-store.js'), 'utf8');
  assert.ok(taskStateStore.includes('taskStatePayload'),
    'the store must share the payload contract');
  assert.ok(taskStateStore.includes('sessionRecordsOwner'),
    'merge and write must stay in the one native record owner');
  assert.ok(taskStateStore.includes('busEmit'),
    'the event hub derives task.* events from every write');
  const recordOwner = fs.readFileSync(path.join(ROOT, 'native', 'addon', 'src', 'session_records.rs'), 'utf8');
  assert.ok(recordOwner.includes('task:state-changed'),
    'the native owner emits the bus event before saving');
});

test('chat worktree guidance treats sync API as manual and permits safe Agent self-sync', () => {
  const { multiccImgHint } = require('../src/native/runtime').getHostPrompts().createHostPrompts({});
  assert.ok(multiccImgHint.includes('The /sync endpoint is mainly for manual sync by the user/UI'));
  assert.ok(multiccImgHint.includes('Self-sync: align with the local base branch directly with Git inside your own worktree'));
  assert.ok(multiccImgHint.includes('it is not the required path for an agent to sync itself'));
  assert.ok(multiccImgHint.includes('never discard commits that cannot be proven to be in the baseline'));
  assert.ok(multiccImgHint.includes('the behind count of `HEAD...main` must be 0; only `0 0` means fully aligned'));
  assert.doesNotMatch(multiccImgHint, /先由派活方直接调用目标会话的 sync 接口/);
  assert.doesNotMatch(multiccImgHint, /只有未同步时才调用自己的 sync/);
  assert.match(multiccImgHint, /Commit and merge under AutoCommit .* are performed by MultiCC after a successful turn/);
  assert.match(multiccImgHint, /Only when the user explicitly asks for commit\/merge in the task/);
  assert.doesNotMatch(multiccImgHint, /目标完成后仍须 commit|都只在自己当前 worktree 里改并 commit/);
  // Sub-agent steering is per-session, never part of the global host hint.
  assert.doesNotMatch(multiccImgHint, /Sub-agent provider configured/);
  const { buildSubagentProviderHint } = require('../src/native/runtime').getHostPrompts();
  assert.strictEqual(buildSubagentProviderHint(null), '');
  assert.match(buildSubagentProviderHint({ providerId: 'p', model: 'm' }), /Sub-agent provider configured.*p \/ m/);
});

test('Pi sessions retain their CLI identity through the public contract', () => {
  const dto = toSessionDto({ id: 'pi-contract', dirId: 'directory-contract', cli: 'pi', kind: 'chat',
    model: 'provider/model', effort: 'off', cliSessionId: 'private-native-id' });
  assert.equal(dto.cli, 'pi');
  assertValid('session.schema.json', dto);
  assert.equal(serialized(dto).includes('private-native-id'), false);
});

test('session DTO exposes the wall-clock unattended shape and drops the legacy round budget', () => {
  const dto = toSessionDto({
    id: 'session-unattended', dirId: 'directory-contract', cli: 'claude', kind: 'chat',
    unattended: {
      status: 'active', goal: 'ship it', criteria: ['tests pass'], maxRounds: 30,
      maxDurationMinutes: 90, rounds: 7, startedAt: 1784332800000, deadlineAt: 1784338200000,
      updatedAt: 1784332800000, lastVerdict: null, history: [], stall: {}, evaluating: false, pausedBy: null,
    },
  });
  assertValid('session.schema.json', dto);
  assert.equal(dto.unattended.maxDurationMinutes, 90);
  assert.equal(dto.unattended.deadlineAt, 1784338200000);
  assert.equal('maxRounds' in dto.unattended, false, 'the legacy round budget is not on the wire');

  // Out-of-range durations are clamped by the DTO, never rejected.
  const clamped = toSessionDto({
    id: 'session-unattended-clamped', cli: 'claude', kind: 'chat',
    unattended: { status: 'active', maxDurationMinutes: 5000, rounds: 0, startedAt: 1, deadlineAt: 2 },
  });
  assertValid('session.schema.json', clamped);
  assert.equal(clamped.unattended.maxDurationMinutes, 1440);
});

test('/api pricing and vendor-quota routes are owned by the Rust front door; Node keeps one host port', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'quota-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/routes/quota-host')"), 'server.js requires the host port');
  assert.ok(source.includes('mountQuotaHostRoute(app,'), 'server.js still wires it');
  // The 22 public routes live in native/gateway/src/app/quota_routes.rs. Two
  // Node modules went away with them, and the seven that remain keep only the
  // fetchers the host port calls: if one starts registering routes again the
  // front door and Node would disagree about status codes, ETags and the
  // `{ ok: true, status }` envelopes.
  for (const retired of ['pricing', 'quota-bars']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'routes', `${retired}.js`)), false,
      `src/routes/${retired}.js must not come back`);
  }
  for (const file of [
    'opencode-quota', 'qoder-quota', 'codex-quota', 'ark-quota', 'kimi-quota',
    'claude-usage-quota', 'aliyun-quota',
  ]) {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'routes', `${file}.js`), 'utf8');
    assert.equal(/app\.(get|post|put|delete)\(/.test(text), false, `${file}.js must not register routes`);
  }
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path stays in the runtime');
  assert.ok(host.includes("'/api/__host/quota'"), 'and it is not a public path');
});

test('/api/air public routes are owned by the Rust front door; Node keeps only the host port', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const mount = fs.readFileSync(path.join(ROOT, 'src', 'workspace', 'air-routes.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'workspace', 'air-routes-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/workspace/air-routes').mountAirRoutes(app,"),
    'server.js still wires the air mount point');
  // The 15 public routes live in native/gateway/src/app/air_routes.rs. If Node
  // starts registering them again the front door and Node would disagree about
  // status codes, ETag/304 and the `{ ok: … }` envelope.
  for (const retired of [
    "app.get('/api/air'", "app.post('/api/air/worktrees/reclaim'", "app.get('/api/air/resolve'",
    "app.post('/api/air/tasks'", "app.get('/api/air/tasks/:id'", "app.get('/api/air/pins'",
    "app.post('/api/air/pins'", "app.get('/api/air/todos'", "app.post('/api/air/todos'",
  ]) assert.equal(mount.includes(retired), false, `Node must not register ${retired}`);
  assert.ok(mount.includes('runtime.mount(app)'), 'the mount point still wires the host port');
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path stays in the runtime');
});

test('/api events, triggers and annotation-live routes are owned by the Rust front door', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const triggers = fs.readFileSync(path.join(ROOT, 'src', 'triggers', 'index.js'), 'utf8');
  const annotation = fs.readFileSync(path.join(ROOT, 'src', 'annotation-live.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'events-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/routes/events-host').createEventsRuntime({"),
    'server.js still wires the events host port');
  assert.ok(source.includes('}).mount(app);'), 'and mounts it once');
  // The 15 public routes live in native/gateway/src/app/event_routes.rs; the
  // retired src/events/routes.js must not come back and the two remaining files
  // must keep only their process-local runtime.
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'events', 'routes.js')), false,
    'src/events/routes.js must not come back');
  assert.equal(source.includes('triggerRuntime.mountRoutes(app)'), false,
    'the trigger runtime no longer mounts public routes');
  for (const file of ['triggers/index.js', 'annotation-live.js']) {
    const text = file.startsWith('triggers')
      ? triggers
      : annotation;
    assert.equal(/app\.(get|post|put|delete)\(/.test(text), false, `${file} must not register routes`);
  }
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path stays in the runtime');
  assert.ok(host.includes("'/api/__host/events'"), 'and it is not a public path');
});

test('/api docs, memory, memo and directory-event routes are owned by the Rust front door', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const docs = fs.readFileSync(path.join(ROOT, 'src', 'docs-registry.js'), 'utf8');
  const memory = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'memory-browser.js'), 'utf8');
  const notes = fs.readFileSync(path.join(ROOT, 'src', 'notes-store.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'docs-memory-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/routes/docs-memory-host')"),
    'server.js requires the docs-memory host port');
  assert.ok(source.includes('createDocsMemoryHost({'), 'and mounts it once');
  assert.ok(source.includes('memo: memoModule.controller'),
    'the memo controller is the host dependency (the router is gone)');
  // The 16 public routes live in native/gateway/src/app/docs_memory_routes.rs;
  // the retired mount points must not come back.
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'memo', 'router.js')), false,
    'src/memo/router.js must not come back');
  assert.equal(source.includes('notesStore.mountRoutes(app)'), false,
    'the notes store no longer mounts public routes');
  assert.equal(source.includes('memoModule.router'), false,
    'the memo module no longer exposes a router');
  assert.equal(source.includes('memoryBrowser.mountRoutes(app)'), false,
    'the memory browser no longer mounts public routes');
  for (const [file, text] of [
    ['src/docs-registry.js', docs],
    ['src/routes/memory-browser.js', memory],
    ['src/notes-store.js', notes],
  ]) {
    assert.equal(/app\.(get|post|put|patch|delete)\(/.test(text), false,
      `${file} must not register routes`);
  }
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path stays in the runtime');
  assert.ok(host.includes("'/api/__host/docs-memory'"), 'and it is not a public path');
  // The store file keeps its historical underscore spelling: the kernel and the
  // host agree on `docs_registry.json`, not `docs-registry.json`.
  assert.ok(source.includes('docsRegistry'), 'the registry runtime is still the host dependency');
});

test('/api task-board, search, task-graph, mark-achieved and task-attribution routes are owned by the Rust front door', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'task-routes-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/routes/task-routes-host').mountTaskRoutesHostRoute(app, {"),
    'server.js wires the task-routes host port');
  assert.ok(source.includes('ports: taskBoardRuntime.routePorts,'),
    'the retired task-board handlers are reached through routePorts');
  assert.ok(source.includes('taskGoal: sessionAdmin.taskGoalPorts,'),
    'mark-achieved keeps the one writer injected through session-admin');
  // The 16 public routes live in native/gateway/src/app/task_routes.rs. If a
  // retired module starts registering them again, the front door and Node
  // would disagree about status codes, ETags and the planning envelope.
  assert.equal(source.includes('taskBoardRuntime.mountRoutes(app)'), false,
    'the task-board runtime no longer mounts public routes');
  assert.equal(source.includes('taskSearchRuntime.mountRoutes(app)'), false,
    'the search runtime no longer mounts public routes');
  assert.equal(source.includes('mountTaskGoalRoutes'), false,
    'mark-achieved is no longer mounted by Node');
  for (const file of [
    'task-board', 'task-planning', 'task-search', 'task-goal', 'task-graph',
  ]) {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'routes', `${file}.js`), 'utf8');
    assert.equal(/app\.(get|post|put|patch|delete)\(/.test(text), false, `${file}.js must not register routes`);
  }
  const attribution = fs.readFileSync(path.join(ROOT, 'src', 'native', 'task-domain.js'), 'utf8');
  assert.equal(/app\.(get|post|put|patch|delete)\(/.test(attribution), false,
    'the task domain compatibility port must not register routes');
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path stays in the runtime');
  assert.ok(host.includes("'/api/__host/task-routes'"), 'and it is not a public path');
  assert.ok(host.includes("case 'mark-achieved-facts':"),
    'eligibility facts and the write stay separate host operations (Rust owns the ladder)');
});

test('/api push subscribe, notify, channel, fcm and bark routes are owned by the Rust front door', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'push-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/routes/push-host')"),
    'server.js requires the push host port');
  assert.ok(source.includes('mountPushHostRoute(app, { push, logger: console })'),
    'and mounts it once with the push service');
  // The 18 public routes live in native/gateway/src/app/push_routes.rs. If a
  // retired module starts registering them again, the front door and Node
  // would disagree about the gates, envelopes and error codes.
  assert.equal(source.includes('pushRuntime.mountRoutes(app)'), false,
    'the push runtime no longer mounts public routes');
  for (const file of [
    'src/push/runtime.js', 'src/push/channel-subscriptions.js',
    'src/push/fcm-devices.js', 'src/push/bark-devices.js',
  ]) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(/app\.(get|post|put|patch|delete)\(/.test(text), false,
      `${file} must not register routes`);
  }
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path stays in the runtime');
  assert.ok(host.includes("'/api/__host/push'"), 'and it is not a public path');
  assert.ok(host.includes("case 'bark-action':"),
    'the Bark action verbs stay one host operation (Rust owns the gate)');
  assert.ok(host.includes("case 'fcm-register':"),
    'FCM register keeps its reply object for Rust to render');
});

test('/api directories, fs browse, onboarding and ui-layout routes are owned by the Rust front door', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'src', 'directory', 'index.js'), 'utf8');
  const layout = fs.readFileSync(path.join(ROOT, 'src', 'directory', 'ui-layout.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'directory-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/directory')"),
    'server.js composes the directory module');
  assert.ok(source.includes('createDirectoryModule({'), 'and wires its runtime adapters once');
  assert.ok(source.includes('directoryModule.host.mount(app)'),
    'the host port is mounted for the Rust front door');
  // The 13 public routes live in native/gateway/src/app/directory_routes.rs;
  // the retired Node handlers must not come back and the remaining files must
  // keep only their process-local runtime.
  for (const gone of [
    ['src', 'directory', 'controller.js'],
    ['src', 'directory', 'service.js'],
    ['src', 'directory', 'ports.js'],
    ['src', 'ui-layout.js'],
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, ...gone)), false,
      `${gone.join('/')} must not come back`);
  }
  for (const [file, text] of [
    ['src/directory/index.js', index],
    ['src/directory/ui-layout.js', layout],
  ]) {
    assert.equal(/app\.(get|post|put|patch|delete)\(/.test(text), false,
      `${file} must not register routes`);
  }
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path lives in the runtime');
  assert.ok(host.includes("'/api/__host/directory'"), 'and it is not a public path');
  assert.ok(host.includes("case 'sample-ensure':"),
    'the onboarding sample workspace is created through the host port');
  assert.ok(host.includes("case 'tx-commit':"),
    'directory deletion persists through one cross-file transaction');
});

test('/api session memory, bundle, lifecycle, create, meta and profile routes are owned by the Rust front door', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'session-routes-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/routes/session-routes-host')"),
    'server.js requires the session-routes host port');
  assert.ok(source.includes('const sessionRoutesHost = createSessionRoutesHost();'),
    'and composes the capture app once');
  // The 18 public routes live in native/gateway/src/app/session_routes.rs. The
  // six modules still register their handlers, but only on the capture app
  // behind the internal host port; mounting any of them on the public app
  // would let Node and the front door disagree about status codes and ETags.
  for (const mount of [
    'mountSessionCreateRoutes(sessionRoutesHost.app,',
    'mountSessionMemoryRoutes(sessionRoutesHost.app,',
    '}).mountRoutes(sessionRoutesHost.app);',
  ]) {
    assert.ok(source.includes(mount), `${mount} stays on the capture app`);
  }
  assert.equal(/mountSessionCreateRoutes\(app\b/.test(source), false,
    'session creation no longer mounts public routes');
  assert.equal(/mountSessionMemoryRoutes\(app\b/.test(source), false,
    'session memory no longer mounts public routes');
  assert.ok(source.includes('sessionBundleRuntime.mountRoutes(sessionRoutesHost.app);'),
    'the encrypted handoff handlers register on the capture app');
  // The two binary transports (bundle.zip / import-zip) deliberately stay
  // public in Node: the front door relays their octet streams byte for byte.
  // `mountBinaryRoutes` is the zip-only public mount; using `mountRoutes` here
  // would republish the two migrated JSON transports as a silent Node fallback.
  assert.ok(source.includes('sessionBundleRuntime.mountBinaryRoutes(app);'),
    'the zip transports stay publicly served by Node');
  assert.ok(source.includes('sessionRoutesHost.mountRoute(app);'),
    'the host port is mounted for the Rust front door');
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path lives in the runtime');
  assert.ok(host.includes("'/api/__host/session-routes'"), 'and it is not a public path');
  assert.ok(host.includes('runHandler'), 'the host port returns {ok,value} envelopes');
  assert.ok(host.includes('thrownEnvelope('),
    'handler exceptions cross the port as structured envelopes');
});

test('/api account and login routes are owned by the Rust front door; Node keeps one host port', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'account-routes-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/routes/account-routes-host')"),
    'server.js requires the account routes host port');
  assert.ok(source.includes('createAccountRoutesHost()'), 'and builds the capture app once');
  assert.ok(source.includes('accountRoutesHost.mountRoute(app);'),
    'the host port is mounted for the Rust front door');
  // The 32 public routes (claude/codex accounts, zcode, kimi, cli accounts, the
  // three OAuth status/login pairs) live in
  // native/gateway/src/app/account_routes.rs. Each retired module may only
  // register on the capture app: mounting one on `app` again would republish the
  // migrated paths as a silent Node fallback with its own status codes and DTOs.
  for (const [file, mount] of [
    ['claude-accounts', 'mountClaudeAccountRoutes(accountRoutesHost.app'],
    ['codex-accounts', 'mountCodexAccountRoutes(accountRoutesHost.app'],
    ['cli-key-accounts', 'mountCliKeyAccountRoutes(accountRoutesHost.app'],
    ['commandcode-auth', 'mountCommandcodeAuthRoutes(accountRoutesHost.app'],
    ['codex-oauth', 'mountCodexOAuthRoutes(accountRoutesHost.app'],
    ['claude-oauth', 'claudeOAuthSurface.mountRoutes(accountRoutesHost.app)'],
    ['zcode-auth', 'mountZcodeAuthRoutes(accountRoutesHost.app)'],
    ['kimi-auth', 'mountKimiAuthRoutes(accountRoutesHost.app)'],
  ]) {
    assert.ok(source.includes(mount), `${file} registers on the host capture app`);
  }
  for (const fn of [
    'mountClaudeAccountRoutes', 'mountCodexAccountRoutes', 'mountCliKeyAccountRoutes',
    'mountCommandcodeAuthRoutes', 'mountCodexOAuthRoutes', 'mountZcodeAuthRoutes',
    'mountKimiAuthRoutes',
  ]) {
    assert.equal(source.includes(`${fn}(app`), false, `${fn} must not mount on the public app`);
  }
  // The two blocking logins (up to 5 minutes waiting for a child exit) stay
  // public in Node: they exceed the host port's 60 second budget, so the front
  // door forwards them whole, automatic OPTIONS included.
  assert.ok(source.includes('mountZcodeAuthLoginRoute(app);'), 'zcode login stays public');
  assert.ok(source.includes('mountKimiAuthLoginRoute(app);'), 'kimi login stays public');
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path stays in the runtime');
  assert.ok(host.includes("'/api/__host/account-routes'"), 'and it is not a public path');
  assert.ok(host.includes('runHandler'), 'the host port returns {ok,value} envelopes');
  assert.ok(host.includes('thrownEnvelope('),
    'handler exceptions cross the port as structured envelopes');
  assert.ok(host.includes("'zcode-auth-login'") === false,
    'the forwarded logins are not host operations');
  assert.equal((host.match(/^  '[a-z0-9-]+': \{ method:/gm) || []).length, 32,
    'the host port serves exactly the 32 migrated public routes');
});

test('/api share, machine and workspace routes are owned by the Rust front door; Node keeps one host port', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'share-machines-host.js'), 'utf8');
  assert.ok(source.includes("require('./src/routes/share-machines-host')"),
    'server.js requires the share/machines host port');
  assert.ok(source.includes('createShareMachinesHost({'), 'and builds the capture app once');
  assert.ok(source.includes('shareMachinesHost.mountRoute(app);'),
    'the host port is mounted for the Rust front door');
  // The 21 public routes (10 machines, 9 share, 2 workspaces) live in
  // native/gateway/src/app/share_machine_routes.rs. The three retired modules may
  // only register on the capture app: mounting any of them on `app` again would
  // republish the migrated paths as a silent Node fallback with its own status
  // codes, ETags and DTOs.
  assert.ok(source.includes('machines.mountProxy(app, express);'),
    'only the raw/SSE proxy half of src/machines.js stays on the public app');
  assert.equal(source.includes('machines.mount(app'), false,
    'the ten JSON machine routes must not mount on the public app');
  assert.equal(source.includes('mountShareRoutes(app'), false,
    'the nine share routes must not mount on the public app');
  assert.equal(source.includes('mountWorkspaceRoutes(app'), false,
    'the two workspace routes must not mount on the public app');
  assert.ok(host.includes('machines.mount(app, express);'),
    'src/machines.js registers its ten JSON routes on the capture app');
  assert.ok(host.includes("require('./share').mountShareRoutes(app, share);"),
    'src/routes/share.js registers on the capture app');
  assert.ok(host.includes("require('./workspaces').mountWorkspaceRoutes(app, workspaces);"),
    'src/routes/workspaces.js registers on the capture app');
  assert.ok(host.includes('HOST_PATH'), 'the internal host port path stays in the runtime');
  assert.ok(host.includes("'/api/__host/share-machines'"), 'and it is not a public path');
  assert.ok(host.includes('runHandler'), 'the host port returns {ok,value} envelopes');
  assert.ok(host.includes('thrownEnvelope('),
    'handler exceptions cross the port as structured envelopes');
  assert.doesNotMatch(host, /'share-page'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'native/gateway/src/app/share_machine_routes.rs'), 'utf8'),
    /HtmlPage::Share/, 'the gateway renders the share page and its empty 500 locally');
  assert.equal((host.match(/^  '[a-z0-9-]+': \{ method:/gm) || []).length, 20,
    'the other 20 routes use the host port');
});
