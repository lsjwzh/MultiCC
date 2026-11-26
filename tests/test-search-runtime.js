'use strict';

// The message index as a running service (src/search/runtime.js).
//
// scripts/search-index.js covers the index itself; what is asserted here is the
// part that only exists once a server owns it:
//   1. the first sweep yields instead of blocking — a cold corpus is seconds of
//      CPU, and the server is listening while it happens;
//   2. one turn's worth of new text becomes searchable on the turn that produced
//      it, and re-syncing an unchanged session costs nothing;
//   3. every failure mode (no FTS5, a closed database, a throwing index) degrades
//      to "no results" — this port sits on the turn-end path and behind an HTTP
//      route, and neither may fail because a derived index did.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createSearchRuntime,
  getSharedSearchRuntime,
  resetSharedSearchRuntimes,
  DEFAULT_HITS,
} = require('../src/search/runtime');
const { createChatHistoryFileRepository } = require('./helpers/native-chat-history-repository');
const { createSliceRunner } = require('../src/search/slice-runner');

const { rerankSearchHits: rerank } = require('../src/native/binding');

const logger = { warn() {}, log() {}, info() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-search-runtime-'));
}

// The first sweep is sliced across event-loop turns on purpose, so a test that
// wants to watch it happen has to own the deferral: collect the callbacks and run
// them by hand, one slice at a time.
function manualImmediate() {
  const queue = [];
  const delays = [];
  return {
    // The runner asks for (fn, delayMs): 0 is "next turn", positive is the pause that
    // keeps the duty cycle down. Recorded so a test can check what was asked for.
    setImmediateImpl(fn, delayMs) { queue.push(fn); delays.push(delayMs); },
    delays,
    pending: () => queue.length,
    runOne() { queue.shift()(); },
    drain() {
      let guard = 0;
      while (queue.length) {
        if ((guard += 1) > 10_000) throw new Error('the staged sweep never finished');
        queue.shift()();
      }
    },
  };
}

function turn(id, text, role = 'user') {
  return { id, role, content: text };
}

function fixture({ sessions = {}, ...options } = {}) {
  const dir = tempDir();
  const history = createChatHistoryFileRepository({ dataDir: dir });
  for (const [sessionId, messages] of Object.entries(sessions)) history.write(sessionId, messages);
  // quietMs 0: the fixture writes a file and syncs it in the same millisecond, which
  // the production default would (rightly) treat as a session still being written.
  const runtime = createSearchRuntime({ dataDir: dir, logger, intervalMs: 0, quietMs: 0, ...options });
  return {
    dir,
    history,
    runtime,
    cleanup: () => { runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('the staged first sweep yields between slices and prunes only once it is done', () => {
  const scheduler = manualImmediate();
  const { runtime, cleanup } = fixture({
    sessions: {
      a1: [turn('m1', '第一段会话正文，讲的是全文检索的排序。')],
      a2: [turn('m2', '第二段会话正文，讲的是缓存层重构。')],
      a3: [turn('m3', '第三段会话正文，讲的是任务关联候选。')],
    },
    setImmediateImpl: scheduler.setImmediateImpl,
  });
  try {
    runtime.start();
    assert.equal(runtime.status().started, true);
    assert.equal(runtime.status().warming, true, 'the corpus is not searchable while it is still being walked');
    assert.equal(scheduler.pending(), 1, 'start() defers the first slice rather than sweeping inline');
    assert.equal(runtime.stats().scopes.length, 0, 'nothing is indexed before the first slice runs');
    // A sweep landing mid-warm must not prune against a half-built ref list.
    assert.deepEqual(runtime.sweep(), { skipped: 'warming' });

    scheduler.drain();
    assert.equal(scheduler.pending(), 0);
    assert.equal(runtime.status().warming, false);
    assert.equal(runtime.status().sweeps, 1, 'the plain sweep at the end is the one that prunes');
    assert.equal(runtime.status().lastSweep.sessions, 3);
    assert.equal(runtime.stats().scopes[0].refs, 3, 'every live session ends up with a ref');

    const found = runtime.findMessages({ text: '全文检索' });
    assert.equal(found.length, 1);
    assert.equal(found[0].sessionId, 'a1');
    assert.ok(found[0].snippet.text.includes('全文检索'));
  } finally {
    cleanup();
  }
});

// A conversation big enough that its file spans many blocks.
function fat(id, count, mark = '') {
  return Array.from({ length: count }, (_, i) => turn(`${id}-${i}`,
    `会话${id}第${i}条 zxq${id}n${i}vv ${mark}`.padEnd(900, `补位文字${id}${i}`), i % 2 ? 'assistant' : 'user'));
}

test('the background sweep is paced: bounded slices, duty-cycle pauses, only what was appended', async () => {
  const scheduler = manualImmediate();
  const dir = tempDir();
  const repo = createChatHistoryFileRepository({ dataDir: dir });
  // The clock moves 5ms per positional read, so the slice budget bites the way it
  // does on a real multi-megabyte transcript.
  let clock = 1_000_000;
  let bytes = 0;
  const countingFs = {
    ...fs,
    readSync(...args) { const n = fs.readSync(...args); bytes += n; clock += 5; return n; },
  };
  for (const id of ['s1', 's2', 's3']) repo.write(id, fat(id, 200));
  const total = ['s1', 's2', 's3'].reduce((sum, id) => sum + fs.statSync(repo.fileFor(id)).size, 0);
  const runtime = createSearchRuntime({
    dataDir: dir, logger, intervalMs: 0, history: repo, now: () => clock, fsImpl: countingFs,
    blockBytes: 64 * 1024, quietMs: 0, sliceMs: 8, duty: 0.1, setImmediateImpl: scheduler.setImmediateImpl,
  });
  try {
    runtime.sweep();
    assert.equal(runtime.stats().scopes[0].refs, 3);
    const baseline = runtime.status().sweeps;

    await sleep(5);
    for (const id of ['s1', 's2', 's3']) repo.write(id, [...fat(id, 200), turn(`${id}-new`, `追加的一轮 zxq${id}newvv`, 'user')]);
    await sleep(5);
    bytes = 0;

    assert.equal(runtime.sweepInBackground(), true);
    assert.equal(runtime.sweepInBackground(), false, 'a tick that lands while a sweep is queued is dropped, not stacked');
    assert.equal(scheduler.pending(), 1, 'nothing runs inline: the first slice is deferred');
    assert.equal(bytes, 0);

    let slices = 0;
    while (scheduler.pending()) {
      const before = clock;
      scheduler.runOne();
      slices += 1;
      assert.ok(slices < 200, 'the sweep must finish');
      if (scheduler.pending()) {
        const worked = clock - before;
        const pause = scheduler.delays[scheduler.delays.length - 1];
        assert.ok(pause >= Math.min(500, Math.ceil(worked * 9)), `${worked}ms of work earns a pause of at least ${Math.min(500, Math.ceil(worked * 9))}ms (got ${pause})`);
      }
    }
    assert.ok(slices >= 3, `the sweep is spread over several slices (took ${slices})`);
    assert.ok(bytes < total / 3, `only the appended tails are read, not whole files (read ${bytes} of ${total})`);
    assert.equal(runtime.status().sweeps, baseline + 1);
    assert.equal(runtime.status().lastSweep.synced, 3);
    for (const id of ['s1', 's2', 's3']) {
      assert.equal(runtime.findMessages({ text: `zxq${id}newvv` }).length, 1, `${id}'s new turn is searchable`);
    }

    // Nothing changed since: the next pass reads nothing at all.
    await sleep(5);
    bytes = 0;
    assert.equal(runtime.sweepInBackground(), true, 'the next tick is accepted once the previous sweep is done');
    scheduler.drain();
    assert.equal(bytes, 0, 'an idle sweep does not touch a single file');
    assert.equal(runtime.status().lastSweep.synced, 0);
  } finally {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the sweep prunes deleted sessions and leaves sessions that are still being written', async () => {
  const scheduler = manualImmediate();
  const { history, runtime, cleanup } = fixture({
    sessions: {
      keep: [turn('k1', '这一段会一直留在索引里，讲的是缓存层。')],
      gone: [turn('g1', '这一段随后会被删除，讲的是排序。')],
    },
    setImmediateImpl: scheduler.setImmediateImpl,
  });
  try {
    runtime.sweep();
    assert.equal(runtime.stats().scopes[0].refs, 2);
    history.deleteSession('gone');
    history.write('live', [turn('l1', '这一段刚刚写完，讲的是流式输出。')]);

    // A production-style quiet window: `live` was written a moment ago.
    const quiet = createSearchRuntime({
      dataDir: runtime.dataDir, logger, intervalMs: 0, quietMs: 60_000, setImmediateImpl: scheduler.setImmediateImpl,
    });
    try {
      assert.equal(quiet.sweepInBackground(), true);
      scheduler.drain();
      const swept = quiet.status().lastSweep;
      assert.equal(swept.removedRefs, 1, 'the deleted session is pruned at the end');
      assert.equal(swept.hot, 1, 'the session still being written is counted, and skipped');
      assert.deepEqual(quiet.findMessages({ text: '流式输出' }), [], 'and not indexed yet');
      // The turn-end nudge is not subject to the quiet window.
      assert.equal(quiet.syncSession('live').sessionSkipped, false);
      assert.equal(quiet.findMessages({ text: '流式输出' }).length, 1);
    } finally { quiet.close(); }
  } finally {
    cleanup();
  }
});

test('a turn-end nudge with too much to catch up on is queued, not done inline', async () => {
  const scheduler = manualImmediate();
  const { runtime, cleanup } = fixture({
    sessions: { big: fat('big', 40) },
    setImmediateImpl: scheduler.setImmediateImpl,
    inlineMaxBytes: 1024,
  });
  try {
    const first = runtime.syncSession('big');
    assert.equal(first.deferred, true);
    assert.equal(first.sessionSkipped, true);
    assert.equal(scheduler.pending(), 1);
    assert.equal(runtime.status().queued, 1);
    runtime.syncSession('big');
    assert.equal(runtime.status().queued, 1, 'asking again does not queue it twice');
    assert.deepEqual(runtime.findMessages({ text: 'zxqbign7vv' }), [], 'nothing was read on the caller\'s turn');

    scheduler.drain();
    assert.equal(runtime.status().queued, 0);
    assert.equal(runtime.findMessages({ text: 'zxqbign7vv' }).length, 1);
    await sleep(5);
    assert.equal(runtime.syncSession('big').sessionSkipped, true, 'and the next nudge has nothing to do');
  } finally {
    cleanup();
  }
});

test('the slice runner holds each slice to its budget and sleeps in proportion to the work', () => {
  let clock = 0;
  const delays = [];
  const waiting = [];
  const runner = createSliceRunner({
    now: () => clock, sliceMs: 8, duty: 0.1,
    defer: (fn, delay) => { delays.push(delay); waiting.push(fn); },
  });
  let steps = 0;
  const job = (function* () { for (let i = 0; i < 7; i += 1) { clock += 3; steps += 1; yield; } return 'done'; }());
  let result = null;
  runner.enqueue(job, { onDone: value => { result = value; } });
  assert.deepEqual(delays, [0], 'the first slice is deferred, not run inline');
  let slices = 0;
  while (waiting.length) { waiting.shift()(); slices += 1; }
  assert.equal(steps, 7);
  assert.equal(result, 'done');
  // 3ms steps against an 8ms budget: 3 steps (9ms) per slice, then a pause of 9 * 9 = 81ms.
  assert.equal(slices, 3);
  assert.deepEqual(delays.slice(1), [81, 81], 'duty 0.1 means 90% of every cycle is spent off');
});

test('a front job runs at the next yield and the job it interrupted carries on afterwards', () => {
  const order = [];
  const waiting = [];
  const runner = createSliceRunner({ now: () => 0, defer: fn => waiting.push(fn) });
  const labelled = (label, count) => (function* () { for (let i = 0; i < count; i += 1) { order.push(`${label}${i}`); yield; } }());
  runner.enqueue(labelled('sweep', 3));
  waiting.shift()();
  assert.deepEqual(order, ['sweep0', 'sweep1', 'sweep2'], 'a zero-cost clock lets the first job run whole');

  // Now with a budget that stops after every step, the interruption is observable.
  order.length = 0;
  let clock = 0;
  const slow = [];
  const paced = createSliceRunner({ now: () => clock, sliceMs: 1, defer: fn => slow.push(fn) });
  const stepper = (label, count) => (function* () { for (let i = 0; i < count; i += 1) { clock += 2; order.push(`${label}${i}`); yield; } }());
  paced.enqueue(stepper('sweep', 4));
  slow.shift()();
  paced.enqueue(stepper('turn', 2), { front: true });
  while (slow.length) slow.shift()();
  assert.deepEqual(order, ['sweep0', 'turn0', 'turn1', 'sweep1', 'sweep2', 'sweep3']);
});

test('a job that throws is reported and does not stop the queue; stop() ends all work', () => {
  const waiting = [];
  const runner = createSliceRunner({ now: () => 0, defer: fn => waiting.push(fn) });
  const errors = [];
  const done = [];
  runner.enqueue((function* () { yield; throw new Error('boom'); }()), { onError: error => errors.push(error.message) });
  runner.enqueue((function* () { yield; return 'second'; }()), { onDone: value => done.push(value) });
  while (waiting.length) waiting.shift()();
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(done, ['second']);

  let ran = false;
  runner.enqueue((function* () { ran = true; yield; }()));
  runner.stop();
  while (waiting.length) waiting.shift()();
  assert.equal(ran, false, 'a stopped runner never runs what was already queued');
  assert.equal(runner.pending(), 0);
});

test('a finished turn is searchable immediately, and an unchanged session is not re-parsed', async () => {
  const { history, runtime, cleanup } = fixture({
    sessions: { a1: [turn('m1', '先写一段关于缓存层的正文。')] },
  });
  try {
    runtime.sweep();
    assert.equal(runtime.findMessages({ text: '缓存层' }).length, 1);

    // The turn-end nudge: the session that just spoke, with no sweep in between.
    history.write('a1', [
      turn('m1', '先写一段关于缓存层的正文。'),
      turn('m2', '追加一轮：这次讲的是全文检索的任务关联。'),
    ]);
    await sleep(5);
    const synced = runtime.syncSession('a1');
    assert.equal(synced.sessionSkipped, false, 'the file moved, so this turn re-reads it');
    assert.equal(synced.inserted, 1, 'only the new chunk is written');
    assert.equal(runtime.findMessages({ text: '任务关联' }).length, 1,
      'the turn is searchable now, not at the next sweep');
    assert.equal(runtime.status().sweeps, 1, 'a per-turn sync is not a sweep');

    // Second nudge with nothing new: the mtime fast path answers without parsing.
    assert.equal(runtime.syncSession('a1').sessionSkipped, true);

    // A sweep is what drops a session history no longer has.
    history.deleteSession('a1');
    assert.equal(runtime.sweep().removedRefs, 1);
    assert.deepEqual(runtime.findMessages({ text: '全文检索' }), []);
  } finally {
    cleanup();
  }
});

test('message hits are reported as sessions, and the caller can exclude its own', () => {
  // Two sessions hit, three do not. The controls are not decoration: bm25's idf is
  // log((N-n+0.5)/(n+0.5)), which is exactly 0 whenever the term is in half the
  // corpus — a two-document fixture scores 0 for *any* query and would make the
  // score assertion below vacuous.
  const controls = Object.fromEntries(Array.from({ length: 3 }, (_, i) =>
    [`ctl-${i}`, [turn(`c${i}`, '这一段讲的是缓存层重构，和检索的排序无关。')]]));
  const { runtime, cleanup } = fixture({
    sessions: {
      mine: [turn('m1', '这一轮在讨论全文检索的实现细节。')],
      other: [turn('m2', '上一轮也在讨论全文检索，是另一个会话。')],
      ...controls,
    },
  });
  try {
    runtime.sweep();
    const all = runtime.findMessages({ text: '全文检索' });
    assert.deepEqual(all.map(hit => hit.sessionId).sort(), ['mine', 'other']);
    // The turn being judged is inside its own history, so self-retrieval is not
    // evidence — the classify path passes its own session id here.
    const withoutSelf = runtime.findMessages({ text: '全文检索', excludeRefIds: ['mine'] });
    assert.deepEqual(withoutSelf.map(hit => hit.sessionId), ['other']);
    assert.equal(withoutSelf[0].kind, 'user');
    assert.ok(withoutSelf[0].score > 0, 'bm25 is flipped so bigger is better');
    assert.equal(DEFAULT_HITS, 10, 'the port advertises a page of chunks by default');
    assert.equal(runtime.findMessages({ text: '全文检索', limit: 1 }).length, 1);
    assert.deepEqual(runtime.findMessages({ text: '' }), []);
    assert.deepEqual(runtime.findMessages({ text: '哎' }), [], 'a one-character query is weak, not a syntax error');
  } finally {
    cleanup();
  }
});

test('an index that is unavailable degrades the whole port instead of throwing', () => {
  const dir = tempDir();
  const runtime = createSearchRuntime({
    dataDir: dir,
    logger,
    intervalMs: 0,
    index: { available: false, reason: 'FTS5 不可用', dbFile: path.join(dir, 'search-index.sqlite'), close() {} },
  });
  try {
    assert.equal(runtime.available, false);
    assert.equal(runtime.reason, 'FTS5 不可用');
    assert.equal(runtime.start().status().available, false, 'start() on an unusable index is a no-op, not a crash');
    assert.equal(runtime.sweep(), null);
    assert.equal(runtime.syncSession('a1'), null);
    assert.deepEqual(runtime.findMessages({ text: '检索' }), []);
    assert.equal(runtime.status().warming, false);
    assert.equal(runtime.stats().available, false);
  } finally {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing index is contained and counted, not propagated to the caller', () => {
  const boom = new Error('database is closed');
  const broken = {
    available: true,
    reason: '',
    dbFile: ':memory:',
    listRefs: () => [],
    readMarker: () => null,
    writeMarker: () => {},
    listMarkers: () => [],
    dropMarkers: () => 0,
    pruneRef: () => 0,
    upsert: () => { throw boom; },
    search: () => { throw boom; },
    stats: () => { throw boom; },
    close() {},
  };
  const { runtime, cleanup } = fixture({
    sessions: { a1: [turn('m1', '一轮正文，足够长到会被分块。')] },
    index: broken,
  });
  try {
    assert.equal(runtime.syncSession('a1'), null, 'a failing turn-end sync is not a failed turn');
    assert.deepEqual(runtime.findMessages({ text: '检索' }), []);
    assert.equal(runtime.search({ text: '检索' }).mode, 'error');
    assert.equal(runtime.stats().available, false);
    assert.ok(runtime.status().failures >= 3, 'failures are counted where a health check can see them');
  } finally {
    cleanup();
  }
});

test('the shared runtime is one instance per data directory, and can be reset', () => {
  const dir = tempDir();
  const other = tempDir();
  try {
    const first = getSharedSearchRuntime({ dataDir: dir, logger, intervalMs: 0 });
    assert.equal(getSharedSearchRuntime({ dataDir: dir, logger, intervalMs: 0 }), first,
      'two consumers in one process must not open two handles on the same file');
    assert.notEqual(getSharedSearchRuntime({ dataDir: other, logger, intervalMs: 0 }), first);
    assert.equal(first.status().started, true, 'a shared instance starts sweeping the moment it is handed out');
    assert.equal(first.dataDir, dir, 'the data directory is resolved once, at creation');

    resetSharedSearchRuntimes();
    const second = getSharedSearchRuntime({ dataDir: dir, logger, intervalMs: 0 });
    assert.notEqual(second, first, 'a reset memo is refilled with a fresh handle');
    resetSharedSearchRuntimes();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('search diversity preserves frozen ranking, original hits and host errors', () => {
  const crypto = require('node:crypto');
  const { createRequire } = require('node:module');
  const { compileFunction } = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-search-diversity.js'));
  const blob = crypto.createHash('sha1').update('blob ' + source.length + '\0').update(source).digest('hex');
  assert.equal(blob, '37f8e334c937c92cc0227a0bb8ea588be6d1f74e');
  const filename = path.resolve(__dirname, '../src/search/diversity.js');
  const frozen = { exports: {} };
  compileFunction(source.toString(), ['module', 'require'], { filename })(frozen, createRequire(filename));
  const old = frozen.exports.rerank;
  const hits = Object.freeze(Array.from({ length: 21 }, (_, i) => Object.freeze({
    refId: 'r' + i % 5, sessionId: i % 3 ? 's' + i % 4 : '', contentHash: 'h' + i % 6,
    score: i % 3 ? String(i % 4) : -2, updatedAt: 100 - i % 7,
    taskId: ['T'], dirId: 4n, snippet: { i },
  })));
  for (const limit of [undefined, null, -2.1, 0, 2n, 3.7, '6', NaN, Infinity]) {
    for (const perRefQuota of [undefined, null, 0, -1, 1, 2.5, 20]) {
      for (const dedupeContentHash of [true, false]) {
        const opts = { limit, perRefQuota, dedupeContentHash };
        const expected = old(hits, opts);
        const actual = rerank(hits, opts);
        assert.equal(actual.length, expected.length);
        for (let i = 0; i < actual.length; i++) assert.strictEqual(actual[i], expected[i]);
      }
    }
  }

  function trace(fn, scenario) {
    const reads = [];
    const sentinel = new Error('candidate field');
    const hit = new Proxy({ sessionId: '', refId: 1n, contentHash: Symbol('h'), score: true, updatedAt: '4' }, {
      get(target, key) {
        reads.push(key);
        if (scenario === key) throw sentinel;
        return Reflect.get(target, key);
      },
    });
    let list = [hit];
    let opts;
    switch (scenario) {
      case 'empty': list = []; opts = { limit: Symbol() }; break;
      case 'non-array': list = {}; opts = { limit: Symbol() }; break;
      case 'zero': opts = { limit: 0 }; break;
      case 'symbol-limit': opts = { limit: Symbol('limit') }; break;
      case 'lone': list = [{ dirId: '\ud800' }]; break;
      case 'bad-score': list = [{ score: Infinity }]; break;
      case 'null-hit': list = [null]; break;
      case 'hole': list = new Array(2); break;
      case 'null-options': opts = null; break;
      case 'toJSON': opts = { perRefQuota: { toJSON(key) { reads.push(key); return 1; } } }; break;
      case 'bigint': opts = { perRefQuota: 1n }; break;
      case 'invalid-flag': opts = { dedupeContentHash: 'yes' }; break;
      case 'shrink': opts = { perRefQuota: { toJSON() { list.pop(); return 1; } } }; break;
      case 'getters': opts = new Proxy({}, { get(o, k) { reads.push(k); return undefined; } }); break;
    }
    let result;
    try { result = fn(list, opts); }
    catch (e) { return [reads, e === sentinel, e.name, e.code, e.message]; }
    return [reads, result.map(item => {
      const i = list.indexOf(item);
      assert.notEqual(i, -1, 'ranked hit must be an original object');
      return i;
    })];
  }
  for (const key of ['empty', 'non-array', 'zero', 'symbol-limit', 'lone', 'bad-score', 'null-hit', 'hole',
    'null-options', 'toJSON', 'bigint', 'invalid-flag', 'shrink', 'getters',
    'sessionId', 'refId', 'contentHash', 'score', 'updatedAt', 'taskId', 'dirId']) {
    assert.deepEqual(trace(rerank, key), trace(old, key), key);
  }
});

test('findMessages counts rank failures and returns the original relevance order', () => {
  const warnings = [];
  const { runtime, cleanup } = fixture({
    sessions: { rank: [turn('m1', 'test ranking fallback')] },
    logger: { warn: message => warnings.push(message) },
  });
  try {
    runtime.syncSession('rank');
    const before = runtime.status().failures;
    const actual = runtime.findMessages({ text: 'ranking', perRefQuota: 1n });
    assert.deepEqual(actual.map(hit => hit.messageId), ['m1']);
    assert.equal(runtime.status().failures, before + 1);
    assert.ok(warnings.some(message => message.startsWith('search_index_rerank_failed:')));
  } finally { cleanup(); }
});
