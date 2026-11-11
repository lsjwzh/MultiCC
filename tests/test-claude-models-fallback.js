'use strict';

// Node side of GET /api/claude/models: the static fallback list and the
// synchronous reader for the gateway's cross-process cache file.
//
// The route itself (bundle scan, curation, TTL and bundle-key invalidation)
// moved to the Rust front door; native/gateway/tests/claude_models.rs and
// docs/rust-migration/differential/claude-models.js cover it. Here we pin the
// two things Node still owns:
//   1. CLAUDE_MODELS_FALLBACK must equal native/gateway/tests/fixtures/claude-models.json
//      (`fallback`), which the Rust side also answers with — drift fails both suites.
//   2. listClaudeModelsSync() reads `<data root>/claude-models-cache.json` and
//      otherwise falls back to the static list. It runs on the spawn/list hot
//      path, so it must never scan or throw.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = require('../native/gateway/tests/fixtures/claude-models.json');
const {
  CLAUDE_MODELS_FALLBACK,
  CACHE_FILE_NAME,
  listClaudeModelsSync,
  _resetCacheForTest,
} = require('../src/claude-models');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-claude-models-fallback-'));
const firstData = path.join(root, 'data-a');
const secondData = path.join(root, 'data-b');
const original = process.env.MULTICC_DATA_DIR;

function useData(dir) {
  process.env.MULTICC_DATA_DIR = dir;
  fs.mkdirSync(dir, { recursive: true });
  _resetCacheForTest();
}

function staticIds() {
  return CLAUDE_MODELS_FALLBACK.map((entry) => entry.model);
}

function writeCache(dir, value) {
  fs.writeFileSync(path.join(dir, CACHE_FILE_NAME), typeof value === 'string' ? value : JSON.stringify(value));
}

test.after(() => {
  if (original === undefined) delete process.env.MULTICC_DATA_DIR;
  else process.env.MULTICC_DATA_DIR = original;
  _resetCacheForTest();
  fs.rmSync(root, { recursive: true, force: true });
});

test('the fallback list mirrors the shared gateway fixture', () => {
  assert.deepEqual(
    CLAUDE_MODELS_FALLBACK.map((entry) => ({ ...entry })),
    fixture.fallback,
    'src/claude-models.js drifted from native/gateway/tests/fixtures/claude-models.json',
  );
  assert.equal(CACHE_FILE_NAME, 'claude-models-cache.json');
  const fromFixture = fixture.fallback.map((entry) => entry.model);
  assert.deepEqual(staticIds(), fromFixture);
});

test('no cache file falls back to the static ids without creating one', () => {
  useData(firstData);
  assert.deepEqual(listClaudeModelsSync(), staticIds());
  assert.equal(fs.existsSync(path.join(firstData, CACHE_FILE_NAME)), false);
});

test('a gateway cache file supplies the ids in insertion order', () => {
  useData(firstData);
  writeCache(firstData, {
    at: Date.now(),
    bundleKey: '/home/x/.local/share/claude/versions/2.1.300:1:2',
    models: [
      { model: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
      { model: 'claude-sonnet-5', label: 'Sonnet 5' },
    ],
  });
  assert.deepEqual(listClaudeModelsSync(), ['claude-opus-5[1m]', 'claude-sonnet-5']);
});

test('entries without a non-empty string model are dropped', () => {
  useData(firstData);
  writeCache(firstData, {
    at: 1,
    bundleKey: '',
    models: [
      { model: 'claude-opus-5', label: 'Opus 5' },
      { model: '', label: 'empty' },
      { label: 'missing' },
      { model: 7, label: 'number' },
      null,
      'claude-sonnet-5',
    ],
  });
  assert.deepEqual(listClaudeModelsSync(), ['claude-opus-5']);
});

test('the reader is memoized on mtime and size', () => {
  useData(firstData);
  const file = path.join(firstData, CACHE_FILE_NAME);
  fs.writeFileSync(file, JSON.stringify({ models: [{ model: 'claude-opus-5' }] }));
  // Pin the mtime through the same API used to restore it below, so the memo
  // key is exactly reproducible (writeFile's ns-precision mtime is not).
  const pinned = new Date(1_700_000_000_000);
  fs.utimesSync(file, pinned, pinned);
  assert.deepEqual(listClaudeModelsSync(), ['claude-opus-5']);
  const stat = fs.statSync(file);

  // Same size, same mtime: the memo answers without re-reading the file.
  fs.writeFileSync(file, JSON.stringify({ models: [{ model: 'claude-opus-4' }] }));
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal(fs.statSync(file).size, stat.size);
  assert.deepEqual(listClaudeModelsSync(), ['claude-opus-5']);

  // A different size (a real gateway rewrite) is re-read.
  writeCache(firstData, { models: [{ model: 'claude-fable-5', label: 'Fable 5' }] });
  assert.deepEqual(listClaudeModelsSync(), ['claude-fable-5']);
});

test('corrupt, empty and malformed cache files fall back to the static list', () => {
  useData(firstData);
  for (const value of ['', 'not json', 'null', '[]', '{"models":null}', '{"models":[]}', '{"models":"x"}']) {
    writeCache(firstData, value);
    assert.deepEqual(listClaudeModelsSync(), staticIds(), `cache content ${JSON.stringify(value)}`);
  }
  // A directory in the cache file's place is unreadable, not fatal.
  fs.rmSync(path.join(firstData, CACHE_FILE_NAME), { force: true });
  const asDirectory = path.join(firstData, CACHE_FILE_NAME);
  fs.mkdirSync(asDirectory);
  assert.deepEqual(listClaudeModelsSync(), staticIds());
  fs.rmdirSync(asDirectory);
});

test('switching MULTICC_DATA_DIR drops the previous root and memo', () => {
  useData(firstData);
  writeCache(firstData, { models: [{ model: 'claude-opus-5' }] });
  assert.deepEqual(listClaudeModelsSync(), ['claude-opus-5']);

  useData(secondData);
  writeCache(secondData, { models: [{ model: 'claude-haiku-4-5' }] });
  assert.deepEqual(listClaudeModelsSync(), ['claude-haiku-4-5']);

  useData(firstData);
  assert.deepEqual(listClaudeModelsSync(), ['claude-opus-5']);
});
