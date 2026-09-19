'use strict';
// Tests for src/secrets-vault.js — the local sensitive-value vault.
// Store-level (upsert/list/reveal/remove/validation) plus route-level through
// a fake express app, all against an isolated MULTICC_DATA_DIR so the real
// secrets.json is never touched (paths.assertTestDir rules are honoured).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
process.env.MULTICC_DATA_DIR = tmp;
const vault = require('../src/secrets-vault');
const { assertTestDir } = require('../src/paths');
assertTestDir(tmp);

function reset() { vault._resetForTests(); }

function fakeApp() {
  const handlers = [];
  return {
    handlers,
    get: (p, h) => handlers.push({ method: 'GET', p, h }),
    post: (p, h) => handlers.push({ method: 'POST', p, h }),
    delete: (p, h) => handlers.push({ method: 'DELETE', p, h }),
  };
}

function findHandler(app, method, p) {
  const hit = app.handlers.find(h => h.method === method && h.p === p);
  assert.ok(hit, `handler ${method} ${p} mounted`);
  return hit.h;
}

function invoke(handler, { body, params } = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
  };
  handler({ body: body || {}, params: params || {} }, res);
  return res;
}

test('upsert creates, lists metadata only, and updates keep createdAt', () => {
  reset();
  const r1 = vault.upsert({ name: 'OPENAI_API_KEY', value: 'sk-test-1', description: '主账号' });
  assert.equal(r1.created, true);
  const list = vault.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'OPENAI_API_KEY');
  assert.equal(list[0].description, '主账号');
  assert.ok(!('value' in list[0]), 'list must never expose values');
  const r2 = vault.upsert({ name: 'OPENAI_API_KEY', value: 'sk-test-2' });
  assert.equal(r2.created, false);
  const after = vault.reveal('OPENAI_API_KEY');
  assert.equal(after.entry.value, 'sk-test-2');
  assert.equal(after.entry.createdAt, r1.entry.createdAt);
});

test('name and value validation', () => {
  reset();
  assert.ok(vault.upsert({ name: 'bad name!', value: 'x' }).error);
  assert.ok(vault.upsert({ name: '', value: 'x' }).error);
  assert.ok(vault.upsert({ name: 'ok', value: '' }).error);
  assert.ok(vault.upsert({ name: 'ok' }).error);
  assert.ok(vault.upsert({ name: 'ok', value: 'x'.repeat(64 * 1024 + 1) }).error);
  assert.equal(vault.upsert({ name: 'a.b-c_9', value: 'x' }).created, true);
});

test('remove and reveal on missing entries', () => {
  reset();
  vault.upsert({ name: 'github_token', value: 'ghp_x' });
  assert.equal(vault.remove('github_token').ok, true);
  assert.equal(vault.reveal('github_token').status, 404);
  assert.equal(vault.remove('github_token').status, 404);
  assert.equal(vault.has('github_token'), false);
});

test('routes: POST/GET/DELETE/value without leaking values in lists', () => {
  reset();
  const app = fakeApp();
  vault.mount(app);
  const created = invoke(findHandler(app, 'POST', '/api/secrets'), {
    body: { name: 'DS_KEY', value: 'sk-secret', description: 'deepseek' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.ok, true);
  assert.ok(!('value' in created.body.entry));

  const listed = invoke(findHandler(app, 'GET', '/api/secrets'));
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].name, 'DS_KEY');
  assert.ok(!('value' in listed.body[0]));

  const revealed = invoke(findHandler(app, 'GET', '/api/secrets/:name/value'), {
    params: { name: 'DS_KEY' },
  });
  assert.equal(revealed.statusCode, 200);
  assert.equal(revealed.body.value, 'sk-secret');

  const missing = invoke(findHandler(app, 'GET', '/api/secrets/:name/value'), {
    params: { name: 'nope' },
  });
  assert.equal(missing.statusCode, 404);

  const bad = invoke(findHandler(app, 'POST', '/api/secrets'), {
    body: { name: '../etc/passwd', value: 'x' },
  });
  assert.equal(bad.statusCode, 400);

  const removed = invoke(findHandler(app, 'DELETE', '/api/secrets/:name'), {
    params: { name: 'DS_KEY' },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(invoke(findHandler(app, 'GET', '/api/secrets')).body.length, 0);
});

test('agent-sourced posts are labelled and persistence round-trips', () => {
  reset();
  vault.upsert({ name: 'FROM_AGENT', value: 'v1', source: 'agent', sessionId: 'chat-1' });
  const list = vault.list();
  assert.equal(list[0].source, 'agent');
  assert.equal(list[0].updatedBy, 'chat-1');
  // Round-trip through the real file (save + reload via a fresh require is
  // covered implicitly by the singleton; here verify the file content).
  const raw = JSON.parse(fs.readFileSync(vault.STORE, 'utf8'));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].name, 'FROM_AGENT');
  assert.equal(raw[0].value, 'v1');
  // File must be owner-private.
  const mode = fs.statSync(vault.STORE).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('envOverlay injects clean names and skips routing namespaces', () => {
  reset();
  vault.upsert({ name: 'MY_TOKEN', value: 'tok-1' });
  vault.upsert({ name: 'github_token', value: 'ghp-1' }); // lowercase stays injectable
  vault.upsert({ name: 'ANTHROPIC_API_KEY', value: 'must-not-inject' });
  vault.upsert({ name: 'CLAUDE_CODE_FABLE_MODEL', value: 'must-not-inject' });
  vault.upsert({ name: 'OPENAI_API_KEY', value: 'must-not-inject' });
  vault.upsert({ name: 'CODEX_HOME', value: '/must-not-inject' });
  vault.upsert({ name: 'MULTICC_SESSION_ID', value: 'must-not-inject' });
  vault.upsert({ name: 'has.dots-and-dashes', value: 'not-an-env-name' });
  const overlay = vault.envOverlay();
  assert.deepEqual(Object.keys(overlay).sort(), ['MY_TOKEN', 'github_token']);
  assert.equal(overlay.MY_TOKEN, 'tok-1');
  assert.equal(overlay.github_token, 'ghp-1');
});

test('applyEnvOverlay is set-if-absent so provider routing stays authoritative', () => {
  reset();
  vault.upsert({ name: 'MY_TOKEN', value: 'tok-2' });
  vault.upsert({ name: 'PINNED', value: 'vault-value' });
  const env = { MY_TOKEN: 'provider-set', PINNED: '' };
  vault.applyEnvOverlay(env);
  assert.equal(env.MY_TOKEN, 'provider-set', 'existing keys are never overridden');
  // Empty-string pins count as present (claude terminal blanks routing keys
  // with '' — those must not be resurrected from the vault either).
  assert.equal(env.PINNED, '');
  assert.equal(vault.applyEnvOverlay(null), null, 'degrades without throwing');
});
