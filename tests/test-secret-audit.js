'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-secret-audit-test-'));
process.env.MULTICC_DATA_DIR = root;
const audit = require('../src/secret-audit');
const vault = require('../src/secrets-vault');
const { createSecretTools } = require('../src/secret-tools');
const { createRouterToolRuntime } = require('../src/router-tool-runtime');
const file = path.join(root, 'logs', 'secret-audit.jsonl');
const value = 'test-only-vault-value-M42-audit';
const rows = () => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('vault management, panel reads and missing entries all leave durable private records', () => {
  vault.upsert({ name: 'AUDIT_KEY', value, description: 'description-must-not-be-logged' });
  vault.list();
  assert.equal(vault.reveal('AUDIT_KEY').entry.value, value);
  assert.equal(vault.reveal('ABSENT_KEY').status, 404);
  vault.rename('AUDIT_KEY', 'AUDIT_RENAMED');
  vault.remove('AUDIT_RENAMED');
  const completed = rows().filter(r => r.phase === 'completed');
  assert.deepEqual(completed.map(r => r.operation), ['upsert', 'list', 'reveal', 'reveal', 'rename', 'remove']);
  assert.equal(completed[3].outcome, 'failed');
  assert.equal(completed[3].status, 404);
  assert.ok(completed.every(r => r.timestamp && Number.isInteger(r.durationMs)));
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(value));
  assert.ok(!raw.includes('description-must-not-be-logged'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('environment auditing records only entries actually issued and never audits digest polling', () => {
  vault._resetForTests();
  vault.upsert({ name: 'INJECTED', value });
  vault.upsert({ name: 'PINNED', value: 'vault-pinned' });
  vault.upsert({ name: 'OPENAI_API_KEY', value: 'excluded-routing' });
  vault.upsert({ name: 'error', value: 'not-an-operation-error' });
  vault.upsert({ name: 'signal', value: 'not-a-process-signal' });
  const env = { MULTICC_SESSION_ID: 'env-session', PINNED: 'provider-pinned' };
  vault.applyEnvOverlay(env, { turnId: 'env-turn' });
  const event = rows().findLast(r => r.operation === 'env_inject' && r.phase === 'completed');
  assert.deepEqual(event.names, ['INJECTED', 'error', 'signal']);
  assert.equal(event.outcome, 'succeeded', 'env variable names cannot impersonate result metadata');
  assert.equal(event.sessionId, 'env-session');
  assert.equal(event.turnId, 'env-turn');
  assert.equal(env.INJECTED, value);
  assert.equal(env.PINNED, 'provider-pinned');
  assert.equal(env.OPENAI_API_KEY, undefined);
  const before = rows().length;
  vault.envDigest(env);
  assert.equal(rows().length, before, 'digest polling does not issue secrets');
});

test('router/tool/vault bridge correlates one call, results and secret names without request text', async () => {
  vault.upsert({ name: 'HTTP_KEY', value });
  const secretTools = createSecretTools({
    vault, resolveSessionCwd: () => root,
    fetchImpl: async () => new Response('response-must-not-be-logged', { status: 403 }),
  });
  const runtime = createRouterToolRuntime({
    records: new Map([['audit-session', { id: 'audit-session', kind: 'chat', dirId: 'dir-a' }]]),
    secretTools, listSecrets: () => vault.list(),
    recordUserInput: async () => ({ ok: true }),
    dispatchToSession: async () => { throw new Error('unexpected dispatch'); },
    operations: { get() {}, list() { return []; } },
    completeDispatch: async () => {},
    registerExternalWait: async () => {}, getExternalWait: async () => null,
    listExternalWaits: async () => [], cancelExternalWait: async () => {},
  });
  const token = runtime.issueContext({ sessionId: 'audit-session', turnId: 'audit-turn', taskId: 'audit-task' });
  await runtime.execute(token, 'http_request_with_secret', {
    url: 'https://example.invalid/path-must-not-be-logged?k={{secret:HTTP_KEY}}',
    headers: { Authorization: 'Bearer {{secret:HTTP_KEY}}' },
  });
  await runtime.execute(token, 'run_with_secrets', { secrets: ['HTTP_KEY'], command: 'exit 7' });
  await assert.rejects(runtime.execute(token, 'run_with_secrets', { secrets: ['MISSING'], command: 'true' }), { code: 'unknown_secret' });
  await assert.rejects(runtime.execute(token, 'list_secrets', { unexpected: value }), { code: 'invalid_arguments' });
  await assert.rejects(runtime.execute(token, 'request_secret_input', { name: 'bad-name', question: value }), { code: 'invalid_arguments' });
  await runtime.execute(token, 'list_secrets', {});
  await runtime.execute(token, 'request_secret_input', { name: 'NEW_KEY', question: 'question-must-not-be-logged' });
  const events = rows().filter(r => r.sessionId === 'audit-session');
  const http = events.filter(r => r.operation === 'http_request_with_secret');
  assert.equal(http.length, 2, 'router + tool share one audit pair');
  assert.deepEqual(http[0].names, ['HTTP_KEY']);
  assert.equal(http[0].callId, http[1].callId);
  assert.equal(http[1].outcome, 'failed');
  assert.equal(http[1].status, 403);
  assert.ok(events.every(r => r.turnId === 'audit-turn' && r.taskId === 'audit-task'));
  const reveal = events.find(r => r.operation === 'reveal' && r.names.includes('HTTP_KEY'));
  assert.equal(reveal.parentCallId, http[0].callId);
  const completed = events.filter(r => r.phase === 'completed');
  assert.ok(completed.some(r => r.operation === 'run_with_secrets' && r.exitCode === 7 && r.outcome === 'failed'));
  assert.ok(completed.some(r => r.code === 'unknown_secret' && r.outcome === 'failed'));
  assert.ok(completed.some(r => r.operation === 'request_secret_input' && r.outcome === 'succeeded'));
  const raw = fs.readFileSync(file, 'utf8');
  for (const forbidden of [value, 'exit 7', 'path-must-not-be-logged', 'response-must-not-be-logged', 'question-must-not-be-logged']) {
    assert.ok(!raw.includes(forbidden), forbidden);
  }
});

test('shell timeout, signal termination and network failure produce failed terminal outcomes', async () => {
  const tools = createSecretTools({
    vault, resolveSessionCwd: () => root,
    fetchImpl: async () => { throw new Error(value); },
  });
  const context = { sessionId: 'failure-session' };
  await tools.runWithSecrets(context, { secrets: ['HTTP_KEY'], command: 'sleep 30', timeout_seconds: 1 });
  await tools.runWithSecrets(context, { secrets: ['HTTP_KEY'], command: 'kill -TERM $$' });
  const controller = new AbortController();
  controller.abort();
  await tools.runWithSecrets(context, { secrets: ['HTTP_KEY'], command: 'sleep 30' }, { signal: controller.signal });
  await assert.rejects(tools.httpRequestWithSecret(context, {
    url: 'https://example.invalid/', headers: { Authorization: '{{secret:HTTP_KEY}}' },
  }), { code: 'http_request_failed' });
  const outcomes = rows().filter(r => r.sessionId === context.sessionId && r.phase === 'completed' && r.operation !== 'reveal');
  assert.deepEqual(outcomes.map(r => r.outcome), ['timed_out', 'failed', 'aborted', 'failed']);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(value));
});

test('concurrent asynchronous calls retain the right parent, session and turn', async () => {
  await Promise.all(['a', 'b'].map(id => audit.call('run_with_secrets', {
    source: 'mcp', sessionId: `concurrent-${id}`, turnId: `turn-${id}`,
  }, ['HTTP_KEY'], async () => {
    await new Promise(resolve => setImmediate(resolve));
    return vault.reveal('HTTP_KEY');
  })));
  for (const id of ['a', 'b']) {
    const events = rows().filter(r => r.sessionId === `concurrent-${id}`);
    assert.equal(events.length, 4);
    assert.ok(events.every(r => r.turnId === `turn-${id}`));
    const parent = events.find(r => r.operation === 'run_with_secrets');
    assert.ok(events.filter(r => r.operation === 'reveal').every(r => r.parentCallId === parent.callId));
  }
});

test('audit failure blocks use before any command, request or reveal action can run', async () => {
  const blocked = fs.mkdtempSync(path.join(root, 'blocked-'));
  fs.writeFileSync(path.join(blocked, 'logs'), 'not a directory');
  process.env.MULTICC_DATA_DIR = blocked;
  let ran = false;
  try {
    assert.throws(() => audit.call('reveal', {}, ['HTTP_KEY'], () => { ran = true; }), { code: 'secret_audit_unavailable' });
    const tools = createSecretTools({ vault, resolveSessionCwd: () => root, fetchImpl: async () => { ran = true; } });
    await assert.rejects(async () => tools.httpRequestWithSecret({}, { url: 'https://example.invalid/?k={{secret:HTTP_KEY}}' }), { code: 'secret_audit_unavailable' });
    assert.equal(ran, false);
  } finally { process.env.MULTICC_DATA_DIR = root; }
});
