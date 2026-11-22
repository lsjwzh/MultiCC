'use strict';

// /api/agy/models is owned by the Rust front door (agy_catalog.rs); this file
// pins the Node-side pieces: the `agy models` parser the Auto Provider peek
// reads, the signed-out backoff, and the fact that an agy native line carries
// those ids as model options.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agy = require('../src/routes/agy-models');
const { nativeVendorModels, syntheticVendorProvider } = require('../src/providers/native-vendor');

const REAL = [
  'Fetching available models...',
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
  'claude-sonnet-5-5\tClaude Sonnet 5.5',
  '  ',
  'not a row without a tab',
  '- \tinvalid id',
  'gemini-4-neon-high\tduplicate row',
].join('\n');

const ENV = process.env.AGY_CMD;

function fakeCli(stdout) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-models-')), 'agy');
  fs.writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const list = (opts) => new Promise((resolve) => agy.listAgyModels((err, models, source) => {
  assert.equal(err, null);
  resolve({ models, source });
}, opts));

test.afterEach(() => {
  agy._resetCacheForTest();
  if (ENV === undefined) delete process.env.AGY_CMD; else process.env.AGY_CMD = ENV;
});

test('parses the tab-separated model rows and drops everything else', () => {
  const models = agy.parseAgyModels(REAL);
  assert.deepEqual(models.map(m => m.model), [
    'gemini-4-neon-high',
    'gemini-4-neon-medium',
    'claude-sonnet-5-5',
  ]);
  assert.equal(models[2].label, 'Claude Sonnet 5.5');
  assert.equal(models[0].label, 'Gemini 4 Neon (High)');
});

test('a label-less row keeps its id as the label and the list is capped', () => {
  const rows = Array.from({ length: 150 }, (_, i) => `model-${i}\tModel ${i}`);
  assert.equal(agy.parseAgyModels(rows.join('\n')).length, 100);
  assert.deepEqual(agy.parseAgyModels('gemini-4-neon-high\t\n'), [
    { model: 'gemini-4-neon-high', label: 'gemini-4-neon-high' },
  ]);
});

test('a signed-out CLI answers unavailable and backs off without respawning', async () => {
  const bin = fakeCli('You are not authenticated.');
  process.env.AGY_CMD = bin;
  assert.deepEqual(await list(), { models: [], source: 'unavailable' });
  // Second call within RETRY_MS must not spawn again: remove the binary and it
  // still answers [] from the failed mark instead of throwing.
  fs.rmSync(bin);
  assert.deepEqual(await list(), { models: [], source: 'unavailable' });
});

test('a successful probe is cached and feeds the agy native line', async () => {
  process.env.AGY_CMD = fakeCli(REAL);
  const first = await list();
  assert.equal(first.source, 'cli');
  assert.equal(first.models.length, 3);
  const second = await list();
  assert.equal(second.source, 'cache');
  assert.deepEqual(nativeVendorModels('agy'), [
    'gemini-4-neon-high',
    'gemini-4-neon-medium',
    'claude-sonnet-5-5',
  ]);
  const line = syntheticVendorProvider('agy');
  assert.equal(line.id, 'agy-native:agy');
  assert.equal(line.model, 'gemini-4-neon-high');
});

test('a cold peek starts a background warm and answers [] without blocking', () => {
  process.env.AGY_CMD = fakeCli(REAL);
  assert.deepEqual(agy.peekAgyModels(), []);
});
