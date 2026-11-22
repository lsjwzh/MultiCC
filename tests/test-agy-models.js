'use strict';

// The Node agy catalog is a mirror of native/gateway/src/app/agy_catalog.rs:
// spawn `agy acp`, `initialize` + `session/new`, take the `model` config option,
// success cached 10 minutes / failure backed off 30 seconds. These tests pin
// that contract and the fact that the Auto Provider agy line reads it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agy = require('../src/routes/agy-models');
const { nativeVendorModels, syntheticVendorProvider } = require('../src/providers/native-vendor');

const ENV = process.env.AGY_CMD;

const SESSION = {
  sessionId: 'agy-s1',
  configOptions: [
    { id: 'thought_level', category: 'thought_level', options: [{ value: 'high' }] },
    {
      id: 'model',
      category: 'model',
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: '  ', name: 'blank' },
        { value: 'claude-sonnet-5-5' },
        { value: 'x'.repeat(101), name: 'too long' },
      ],
    },
  ],
};

// A fake `agy acp`: answers initialize and session/new on stdin, ignores the
// `acp` argument the real binary receives.
function fakeAgy(session, { spawnsFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-'));
  const file = path.join(dir, 'agy');
  const marker = spawnsFile ? `\nfs.appendFileSync(${JSON.stringify(spawnsFile)}, 'x');` : '';
  const reply = session === null ? 'reply(msg.id, {});' : `reply(msg.id, ${JSON.stringify(session)});`;
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');${marker}
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === 'session/new') return ${reply}
});
`);
  fs.chmodSync(file, 0o755);
  return { file, dir };
}

const list = (opts) => new Promise((resolve) => agy.listAgyModels((err, models, source) => {
  assert.equal(err, null);
  resolve({ models, source });
}, opts));

test.afterEach(() => {
  agy._resetCacheForTest();
  if (ENV === undefined) delete process.env.AGY_CMD; else process.env.AGY_CMD = ENV;
});

test('model option extraction mirrors the Rust rules', () => {
  const models = agy._modelOptionsForTest(SESSION);
  assert.deepEqual(models.map((m) => m.model), ['gemini-4-neon', 'claude-sonnet-5-5']);
  assert.equal(models[0].label, 'Gemini 4 Neon');
  assert.equal(models[1].label, 'claude-sonnet-5-5');
  assert.deepEqual(agy._modelOptionsForTest({ configOptions: [] }), []);
  assert.deepEqual(agy._modelOptionsForTest({}), []);
  assert.deepEqual(agy._modelOptionsForTest(null), []);
});

test('a live ACP session answers the catalog and is cached', async () => {
  process.env.AGY_CMD = fakeAgy(SESSION).file;
  const first = await list();
  assert.equal(first.source, 'cli');
  assert.deepEqual(first.models.map((m) => m.model), ['gemini-4-neon', 'claude-sonnet-5-5']);
  const second = await list();
  assert.equal(second.source, 'cache');
  assert.deepEqual(nativeVendorModels('agy'), ['gemini-4-neon', 'claude-sonnet-5-5']);
  const line = syntheticVendorProvider('agy');
  assert.equal(line.id, 'agy-native:agy');
  assert.equal(line.model, 'gemini-4-neon');
});

test('a session without a model option fails and backs off for 30 seconds', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mark-')), 'spawns');
  fs.writeFileSync(marker, '');
  const { file } = fakeAgy(null, { spawnsFile: marker });
  process.env.AGY_CMD = file;
  assert.deepEqual(await list(), { models: [], source: 'unavailable' });
  const spawned = fs.readFileSync(marker, 'utf8').length;
  // Remove the binary: a fresh failure must answer without spawning again.
  fs.rmSync(file);
  assert.deepEqual(await list(), { models: [], source: 'unavailable' });
  assert.equal(fs.readFileSync(marker, 'utf8').length, spawned);
});

test('refresh skips the cache and a cold peek warms in the background', async () => {
  process.env.AGY_CMD = fakeAgy(SESSION).file;
  await list();
  const refreshed = await list({ refresh: true });
  assert.equal(refreshed.source, 'cli');
  agy._resetCacheForTest();
  assert.deepEqual(agy.peekAgyModels(), []);
  // The warm runs unawaited; poll until the catalog lands.
  for (let i = 0; i < 100 && nativeVendorModels('agy').length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(nativeVendorModels('agy'), ['gemini-4-neon', 'claude-sonnet-5-5']);
});
