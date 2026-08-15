'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FALLBACK_LIMIT,
  createOpencodeModelLimitResolver,
  resolveOpenCodeModelLimit,
} = require('../src/providers/opencode-model-limits');

function writeFixture(root, catalog) {
  const file = path.join(root, 'models.json');
  fs.writeFileSync(file, JSON.stringify(catalog));
  return file;
}

test('resolveOpenCodeModelLimit matches exact ids and takes the conservative minimum', () => {
  const catalog = {
    deepseek: { models: { 'deepseek-v4-flash': { limit: { context: 1000000, output: 384000 } } } },
    relay: { models: { 'deepseek-v4-flash': { limit: { context: 512000, output: 16000 } } } },
    'partial-host': { models: { 'ctx-only': { limit: { context: 200000 } } } },
    'junk-host': { models: { 'bad': { limit: { context: -5, output: 'x' } } } },
  };
  assert.deepEqual(
    resolveOpenCodeModelLimit(catalog, 'deepseek-v4-flash'),
    { context: 512000, output: 16000, source: 'models.dev', matched: 2 },
  );
  // A catalog entry with only a context limit still yields a usable limit; the
  // missing output falls back rather than fabricating a large value.
  assert.deepEqual(
    resolveOpenCodeModelLimit(catalog, 'ctx-only'),
    { context: 200000, output: FALLBACK_LIMIT.output, source: 'models.dev', matched: 1 },
  );
  // Non-positive/non-integer entries are ignored entirely.
  assert.equal(resolveOpenCodeModelLimit(catalog, 'bad').source, 'fallback');
  // Unknown model / empty id / missing catalog degrade to the understated pair.
  for (const input of ['nope', '', null, undefined]) {
    assert.deepEqual(
      resolveOpenCodeModelLimit(catalog, input),
      { context: FALLBACK_LIMIT.context, output: FALLBACK_LIMIT.output, source: 'fallback', matched: 0 },
    );
  }
  assert.equal(resolveOpenCodeModelLimit(null, 'deepseek-v4-flash').source, 'fallback');
});

test('resolver reads the cache lazily, reloads on mtime change, and survives corrupt files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-opencode-limits-'));
  const cacheFile = writeFixture(root, {
    host: { models: { 'm-1': { limit: { context: 300000, output: 9000 } } } },
  });
  const resolver = createOpencodeModelLimitResolver({ cachePath: cacheFile });
  assert.deepEqual(resolver.resolve('m-1'), { context: 300000, output: 9000, source: 'models.dev', matched: 1 });
  assert.deepEqual(resolver.resolveLimit('m-1'), { context: 300000, output: 9000 });
  assert.deepEqual(resolver.resolveLimit('unknown-m'), { context: FALLBACK_LIMIT.context, output: FALLBACK_LIMIT.output });
  // Fallback limit must be frozen — callers embed it into generated config.
  assert.ok(Object.isFrozen(resolver.resolveLimit('unknown-m')));

  // Corrupt cache keeps the last good value instead of degrading silently.
  fs.writeFileSync(cacheFile, '{not json');
  assert.equal(resolver.resolve('m-1').context, 300000);

  // A rewritten (new mtime) cache is picked up on the next call.
  writeFixture(root, { host: { models: { 'm-1': { limit: { context: 400000, output: 9000 } } } } });
  assert.equal(resolver.resolve('m-1').context, 400000);

  // Missing cache path degrades safely.
  const missing = createOpencodeModelLimitResolver({ cachePath: path.join(root, 'absent.json') });
  assert.equal(missing.resolve('m-1').source, 'fallback');
  fs.rmSync(root, { recursive: true, force: true });
});
