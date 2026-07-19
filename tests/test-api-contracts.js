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
} = require('../src/contract-validator');
const { toSessionDto } = require('../src/session-dto');

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
    subagent: { providerId: 'sub-safe-id', model: 'sub-model', effectiveModel: 'sub-effective' },
    autoCommit: true,
    autoDispatch: false,
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
    hasToken: true, token: 'provider-secret', tokenMask: 'sk-****', baseUrl: 'https://private.example/v1',
    cwd: '/private/provider', stack: 'private stack',
  });
  assertValid('provider.schema.json', provider);
  assert.equal(provider.hasCredentials, true);

  const wait = toWaitDto({
    id: 'w_safe', session: 'session-contract', mode: 'poll', checks: 1,
    maxChecks: 40, intervalSec: 15, createdAt: 1784332800000,
    token: 'callback-secret', pollCmd: 'cat /private/result', pollUrl: 'https://private.example',
    untilContains: 'secret marker', cwd: '/private/repository', stack: 'private stack',
  });
  assertValid('wait.schema.json', wait);

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
  });
  assertValid('error.schema.json', body);
  assert.equal(body.apiVersion, API_VERSION);
  assert.equal(body.requestId, 'req-error');
  assert.equal(body.correlationId, 'corr-error');
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

test('server composition uses canonical adapters without replacing legacy endpoints', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const sessionAdmin = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'session-admin.js'), 'utf8');
  const orchestrationRoutes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'orchestration.js'), 'utf8');
  const workspaceRuntime = fs.readFileSync(path.join(ROOT, 'src', 'workspace', 'runtime.js'), 'utf8');
  assert.ok(source.includes("} = require('./src/session')"));
  assert.ok(source.includes("createWorkspaceRuntime } = require('./src/workspace/runtime')"));
  assert.ok(source.includes('const workspaceRuntime = createWorkspaceRuntime({'));
  assert.ok(workspaceRuntime.includes('const sessionState = createSessionStateService({'));
  assert.ok(source.includes("createSessionAdminRuntime } = require('./src/routes/session-admin')"));
  assert.ok(source.includes('const sessionAdmin = createSessionAdminRuntime({'));
  assert.ok(source.includes('sessionAdmin.mountRoutes(app)'));
  assert.ok(sessionAdmin.includes('const sessionQuery = createSessionQueryService({'));
  assert.ok(sessionAdmin.includes('const sessionWorkspace = createWorkspaceService({'));
  assert.ok(sessionAdmin.includes("app.get('/api/v1/sessions'"));
  assert.ok(sessionAdmin.includes("app.get('/api/sessions'"));
  assert.ok(source.includes("app.get('/api/v1/providers'"));
  assert.ok(sessionAdmin.includes("app.get('/api/v1/directories/:id/workspace'"));
  assert.ok(orchestrationRoutes.includes("app.get('/api/v1/sessions/:id/waits'"));
  assert.ok(source.includes("/^\\/api\\/wait\\/[^/]+\\/resolve$/"));
  assert.ok(source.includes("app.post('/api/v1/sessions/:id/dispatch', dispatchContractHandler)"));
  assert.ok(source.includes('JSON.stringify(createWsEnvelope(payload))'));
});
