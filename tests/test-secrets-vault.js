'use strict';
// Tests for src/secrets-vault.js — the local sensitive-value vault.
//
// The HTTP surface moved to the Rust front door + src/routes/secrets-vault-host.js,
// so this file only exercises the module API directly: upsert/remove/rename/
// reveal/list/has, naming rules, capacity, trimming, legacy names, metadata
// projection, and the env overlay/digest. All of it runs against an isolated
// MULTICC_DATA_DIR so the real secrets.json is never touched
// (paths.assertTestDir rules are honoured).
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
  assert.equal(vault.upsert({ name: 'a_b_c9', value: 'x' }).created, true);
});

test('create rejects names that cannot be injected as env vars', () => {
  reset();
  for (const bad of ['ark-seedance-key', 'has.dots', '9LEADING_DIGIT', 'with space', '../etc/passwd', 'A'.repeat(65)]) {
    const r = vault.upsert({ name: bad, value: 'x' });
    assert.equal(r.status, 400, bad);
    assert.match(r.error, /env var identifier/);
  }
  assert.equal(vault.upsert({ name: '_LEADING_UNDERSCORE', value: 'x' }).created, true);
  assert.equal(vault.list().length, 1, 'rejected names never reach the store');
});

test('upsert trims name/description/source and slices the long fields', () => {
  reset();
  const result = vault.upsert({
    name: '  TRIM_KEY  ',
    value: 'v',
    description: `  ${'d'.repeat(600)}  `,
    source: `  ${'agent'.repeat(20)}  `,
  });
  assert.equal(result.entry.name, 'TRIM_KEY');
  assert.equal(result.entry.description.length, 500);
  assert.equal(result.entry.description, 'd'.repeat(500));
  assert.equal(result.entry.source.length, 64);
  assert.match(result.entry.source, /^agent/);
  assert.equal(vault.has('  TRIM_KEY  '), true, 'lookups trim too');
});

test('list sorts by name and projects metadata without values', () => {
  reset();
  vault.upsert({ name: 'B_KEY', value: 'b' });
  vault.upsert({ name: 'A_KEY', value: 'a', sessionId: 'chat-9' });
  vault.upsert({ name: 'C_KEY', value: 'c' });
  const list = vault.list();
  assert.deepEqual(list.map(entry => entry.name), ['A_KEY', 'B_KEY', 'C_KEY']);
  assert.deepEqual(Object.keys(list[0]), ['name', 'description', 'source', 'createdAt', 'updatedAt', 'updatedBy']);
  assert.deepEqual(Object.keys(list[1]), ['name', 'description', 'source', 'createdAt', 'updatedAt']);
  assert.ok(list.every(entry => !('value' in entry)), 'list must never expose values');
});

test('capacity: a new entry is refused at MAX_ENTRIES, existing updates still work', () => {
  reset();
  const seed = Array.from({ length: 500 }, (_, index) => ({ name: `K_${index}`, value: 'v' }));
  fs.writeFileSync(vault.STORE, JSON.stringify(seed));
  vault._loadForTests();
  assert.equal(vault.list().length, 500);
  const full = vault.upsert({ name: 'ONE_MORE', value: 'x' });
  assert.equal(full.status, 409);
  assert.equal(full.error, 'vault is full');
  assert.equal(vault.upsert({ name: 'K_0', value: 'updated' }).created, false);
  assert.equal(vault.reveal('K_0').entry.value, 'updated');
});

test('legacy illegal-name entries survive reload, stay deletable, and can be renamed', () => {
  reset();
  fs.writeFileSync(vault.STORE, JSON.stringify([
    { name: 'ark-seedance-key', value: 'legacy-secret', description: '宠物视频', source: 'user', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' },
    { name: 'GOOD_KEY', value: 'good' },
  ]));
  vault._loadForTests();
  assert.deepEqual(vault.list().map(e => e.name), ['ark-seedance-key', 'GOOD_KEY']);
  assert.deepEqual(Object.keys(vault.envOverlay()), ['GOOD_KEY'], 'legacy name is never injected');
  assert.equal(vault.upsert({ name: 'ark-seedance-key', value: 'new' }).status, 400, 'cannot write under a legacy name');

  const moved = vault.rename('ark-seedance-key', 'ARK_SEEDANCE_KEY');
  assert.equal(moved.entry.name, 'ARK_SEEDANCE_KEY');
  assert.equal(moved.entry.description, '宠物视频');
  assert.equal(moved.entry.createdAt, '2026-10-15T00:00:00.000Z', 'createdAt survives a rename');
  assert.equal(vault.reveal('ARK_SEEDANCE_KEY').entry.value, 'legacy-secret', 'value is carried over unchanged');
  assert.equal(vault.has('ark-seedance-key'), false);
  assert.equal(vault.envOverlay().ARK_SEEDANCE_KEY, 'legacy-secret');

  vault._loadForTests();
  assert.deepEqual(vault.list().map(e => e.name), ['ARK_SEEDANCE_KEY', 'GOOD_KEY'], 'rename persisted to disk');
});

test('rename validates source, target and collisions', () => {
  reset();
  vault.upsert({ name: 'A_KEY', value: 'a' });
  vault.upsert({ name: 'B_KEY', value: 'b' });
  assert.equal(vault.rename('NOPE', 'C_KEY').status, 404);
  assert.equal(vault.rename('A_KEY', 'bad-name').status, 400);
  assert.equal(vault.rename('A_KEY', 'B_KEY').status, 409);
  assert.equal(vault.reveal('A_KEY').entry.value, 'a', 'failed renames change nothing');
  assert.equal(vault.rename('A_KEY', 'A_KEY').unchanged, true);
  // 成功改名只回元数据（值留在进程内，绝不随结果返回）。
  vault.upsert({ name: 'OLD_NAME', value: 'sk-route-secret' });
  const moved = vault.rename('OLD_NAME', 'NEW_NAME');
  assert.equal(moved.entry.name, 'NEW_NAME');
  assert.equal(moved.entry.value, 'sk-route-secret', 'the entry itself keeps its value');
  const projected = vault.list().find(entry => entry.name === 'NEW_NAME');
  assert.ok(!JSON.stringify(projected).includes('sk-route-secret'), 'metadata projection strips values');
});

test('envDigest tracks added, changed and removed entries without exposing values', () => {
  reset();
  assert.equal(vault.envDigest({}), '', 'empty vault → empty digest');
  vault.upsert({ name: 'TOKEN_A', value: 'v1' });
  // 真实用法：spawn 当时存下摘要，之后每轮拿「新建的 env」去比。
  const spawned = vault.envDigest(vault.applyEnvOverlay({}));
  assert.match(spawned, /^[0-9a-f]{64}$/);
  assert.ok(!spawned.includes('v1'), 'digest is a hash, never the value');
  const now = () => vault.envDigest(vault.applyEnvOverlay({}));
  assert.equal(now(), spawned, 'stable while nothing changes');

  vault.upsert({ name: 'TOKEN_B', value: 'v2' });
  assert.notEqual(now(), spawned, 'added entry → running process is stale');

  const afterAdd = now();
  vault.upsert({ name: 'TOKEN_A', value: 'v1-new' });
  assert.notEqual(now(), afterAdd, 'changed value → stale');

  const afterChange = now();
  vault.remove('TOKEN_B');
  assert.notEqual(now(), afterChange, 'removed entry → stale');
});

test('remove and reveal on missing entries', () => {
  reset();
  vault.upsert({ name: 'github_token', value: 'ghp_x' });
  assert.equal(vault.remove('github_token').ok, true);
  assert.equal(vault.reveal('github_token').status, 404);
  assert.equal(vault.remove('github_token').status, 404);
  assert.equal(vault.has('github_token'), false);
});

test('agent-sourced writes are labelled and persistence round-trips', () => {
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
  // 旧版本留下的非法名条目只能来自磁盘；新建已被 upsert 拒绝。
  fs.writeFileSync(vault.STORE, JSON.stringify([...vault.list().map(e => vault.reveal(e.name).entry), { name: 'has.dots-and-dashes', value: 'not-an-env-name' }]));
  vault._loadForTests();
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
