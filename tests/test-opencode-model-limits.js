'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const frozen = require('./helpers/frozen-opencode-model-limits');
const {
  FALLBACK_LIMIT,
  createOpencodeModelLimitResolver,
  resolveOpenCodeModelLimit,
} = require('../src/native/binding').openCodeModelLimits;

test('catalog lookup keeps exact ids, individual getter reads and inherited entries', () => {
  for (const context of [0, null, 1, 65536, 1.5, 1e21, '7']) {
    for (const output of [-1, 0, 3, 8192, 1.8]) {
      const catalog = { a: { models: { m: { limit: { context, output } } } },
        b: { models: { 'a/m': { limit: { output } }, m: { limit: { output: 5 } } } } };
      for (const id of ['m', 'a/m', ' a/m ', 'other/m', 'missing', '', null]) {
        assert.deepEqual(resolveOpenCodeModelLimit(catalog, id), frozen.resolveOpenCodeModelLimit(catalog, id));
      }
    }
  }
  function run(resolve, second) {
    const trace = [], sentinel = new Error('field failure');
    let reads = 0;
    const limit = {
      get context() { trace.push('context'); return ++reads === 3 ? second : 6; },
      get output() { trace.push('output'); return 7; },
    };
    const first = { get models() { trace.push('models'); return Object.create({ m: { limit } }); } };
    const catalog = { get first() { trace.push('provider1'); return first; },
      get second() { trace.push('provider2'); return { models: { m: { limit: {
        get context() { if (second === 'throw') throw sentinel; return 2; },
      } } } }; } };
    const id = { toString() { trace.push('id'); return ' m '; } };
    try { return { result: resolve(catalog, id), trace }; }
    catch (e) { return { error: e.name, message: e.message, same: e === sentinel, trace }; }
  }
  for (const value of [null, undefined, NaN, '11', 1n, Symbol('bad'), 'throw']) {
    assert.deepEqual(run(resolveOpenCodeModelLimit, value), run(frozen.resolveOpenCodeModelLimit, value));
  }
  for (const entry of [null, false, { models: [] }, { models: { '\ud800': { limit: { output: 23 } } } }]) {
    assert.deepEqual(resolveOpenCodeModelLimit([entry], '\ud800'), frozen.resolveOpenCodeModelLimit([entry], '\ud800'));
  }
});

test('cache refresh, reentrant reset and failed stat retain the frozen file and coercion order', () => {
  function run(create) {
    const trace = [], results = [];
    let time = 1, missing = false, failRead = false, raw = '{"p":{"models":{"m":{"limit":{"output":4}}}}}';
    const resolver = create({ cachePath: 'fixture', fsImpl: {
      statSync(file) { trace.push(['stat', file]); if (missing) throw new Error('gone'); return { mtimeMs: time }; },
      readFileSync(file, enc) { trace.push(['read', file, enc]); if (failRead) throw new Error('read'); return raw; },
    } });
    const take = (id = 'm') => results.push(resolver.resolve(id));
    take();
    resolver.resolve('m').output = 99;
    take(); time++; raw = '{'; take(); missing = true; take(); missing = false; take();
    time++; failRead = true; take(); failRead = false;
    take({ toString() { trace.push('reset'); resolver.resetCache(); return 'm'; } });
    take(); raw = 'null'; time++; take(); raw = '[{"models":{"m":{"limit":{"context":19}}}}]'; time++; take();
    const pair = resolver.resolveLimit.call({ resolve: () => ({ context: 1, output: 2 }) }, 'm');
    return { results, trace, pair, frozenPair: Object.isFrozen(pair) };
  }
  assert.deepEqual(run(createOpencodeModelLimitResolver), run(frozen.createOpencodeModelLimitResolver));
});

test('warm file answers are independent and retain live inherited or injected JSON fields', () => {
  function exercise(create) {
    let raw = '{"p":{"models":{"m":{"limit":{"context":19}}}}}';
    const resolver = create({ cachePath: 'fixture', fsImpl: {
      statSync() { return { mtimeMs: 1 }; },
      readFileSync() { return raw; },
    } });
    const first = resolver.resolve('m');
    first.context = -5;
    const warm = resolver.resolve('m');
    let inherited;
    const priorOutput = Object.getOwnPropertyDescriptor(Object.prototype, 'output');
    try {
      Object.defineProperty(Object.prototype, 'output', { configurable: true, get() { return 37; } });
      inherited = resolver.resolve('m');
    } finally {
      if (priorOutput) Object.defineProperty(Object.prototype, 'output', priorOutput);
      else delete Object.prototype.output;
    }
    for (let i = 0; i < 270; i++) resolver.resolve('unknown-' + i);
    const afterMisses = resolver.resolve('m');
    const mutable = { p: { models: { m: { limit: { context: 41 } } } } };
    const parse = JSON.parse;
    try {
      JSON.parse = () => mutable;
      resolver.resetCache();
      raw = 'fixture handled by the injected parser';
      resolver.resolve('m');
    } finally { JSON.parse = parse; }
    mutable.p.models.m.limit.context = 53;
    return { warm, inherited, afterMisses, live: resolver.resolve('m'), independent: first !== warm };
  }
  assert.deepEqual(exercise(createOpencodeModelLimitResolver), exercise(frozen.createOpencodeModelLimitResolver));
});

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
