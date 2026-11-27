'use strict';

// The three quota-bar routes (GET /api/quota/bars/idle, GET /api/quota/bars/state
// and POST /api/quota/bars/refresh) are the Rust front door's now: the request
// reading, the TTL/readiness decision, the `{ result, bar, cached }` envelope,
// the status→HTTP map and `{status:'unavailable'}` on a failed fetch all live
// in native/core/src/quota_routes.rs + native/gateway/src/app/quota_routes.rs.
//
// What stayed in Node is the host port (src/routes/quota-host.js): the nine
// vendor fetchers, the on-disk quota-bar cache, the vendor recorders, and the
// Claude usage queue with its 60s floor. These tests pin that half — including
// the one invariant the port itself must keep: reading a bar never spends a
// 30-40s browser drive, only `force` does.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createQuotaRuntime } = require('../src/routes/quota-host');
const { createQuotaBarCache } = require('../src/native/binding').quotaBarCache;
const Queue = require('../src/native/binding').claudeUsageQueue;
const BarState = require('../src/native/binding').claudeBarState;

function tmpCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-quota-bar-cache-test-'));
  return createQuotaBarCache({ file: path.join(dir, 'quota-bar-cache.json'), now: () => 1700000000000 });
}

function bar(kind) {
  return { text: `${kind} 50%`, color: '#58a6ff', title: `${kind} title`, action: null };
}

const SELECTOR = { kind: 'opencode', session: '', baseUrl: '', host: '', force: false };

function hostHandler(deps) {
  const registered = [];
  createQuotaRuntime(deps).mount({ post: (routePath, handler) => registered.push({ routePath, handler }) });
  assert.equal(registered.length, 1);
  return registered[0].handler;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('a fetched reading is stored by the commit the front door sends after rendering', async () => {
  const cache = tmpCache();
  const calls = [];
  const runtime = createQuotaRuntime({
    quotaBarCache: cache,
    now: () => 1700000000000,
    fetchOpenCodeUsage: async () => {
      calls.push('opencode');
      return { status: 'ok', fetchedAt: 123, usage: { rolling: { usagePercent: 50 } } };
    },
  });

  const fetched = await runtime.handle({ op: 'bars.fetch', kind: 'opencode' });
  assert.deepEqual(calls, ['opencode']);
  assert.equal(fetched.result.status, 'ok');

  // The bar is rendered by the front door (the shared kernel); the port only
  // stores it, and answers with what the cache now holds for that selector.
  const committed = await runtime.handle({
    op: 'bars.commit',
    kind: 'opencode',
    record: true,
    result: fetched.result,
    bar: bar('opencode'),
    selector: SELECTOR,
  });
  assert.equal(committed.cached.bar.text, 'opencode 50%');
  assert.equal(cache.get('opencode').bar.text, 'opencode 50%');

  // `record: false` is the not-cacheable branch (a miss, a needs_login): the
  // reading is answered but nothing lands in the shared cache.
  const skipped = await runtime.handle({
    op: 'bars.commit',
    kind: 'qoder',
    record: false,
    result: { status: 'needs_login' },
    bar: bar('qoder'),
    selector: { ...SELECTOR, kind: 'qoder' },
  });
  assert.equal(skipped.cached, null);
});

test('a vendor fetch records the provider-scoped result the front door asked for', async () => {
  const recorded = [];
  const runtime = createQuotaRuntime({
    now: () => 1700000000000,
    fetchKimiUsage: async (host) => ({ status: 'ok', fetchedAt: 456, host }),
    recordVendor: (entry) => recorded.push(entry),
  });

  const fetched = await runtime.handle({ op: 'bars.fetch', kind: 'kimi', host: 'moonshot.cn' });
  assert.equal(fetched.result.host, 'moonshot.cn');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'kimi');
  assert.equal(recorded[0].host, 'moonshot.cn');

  // A throwing fetcher is a value, not a refusal: each vendor route has its own
  // fixed catch body, so the front door learns `threw` and renders it.
  const throwing = createQuotaRuntime({
    now: () => 1700000000000,
    fetchArkUsage: async () => { throw new Error('boom'); },
    recordVendor: (entry) => recorded.push(entry),
  });
  const caught = await throwing.handle({ op: 'bars.fetch', kind: 'ark', baseUrl: 'https://ark.test' });
  assert.deepEqual(caught, { threw: true });
  // The bar refresh has no per-kind catch body: the throw is the whole answer,
  // and nothing is recorded (the refresh route's own `unavailable` envelope is
  // the front door's).
  assert.equal(recorded.length, 1, 'a throwing fetch records nothing');
});

test('the state op answers the cache snapshot, and an empty envelope without a cache', async () => {
  const cache = tmpCache();
  cache.record('codex', { status: 'ok', fetchedAt: 789 }, bar('codex'), { session: '', baseUrl: '', host: '' });
  const runtime = createQuotaRuntime({ quotaBarCache: cache, now: () => 1700000000000 });

  const snapshot = await runtime.handle({ op: 'bars.state', selector: { kind: 'codex', session: '', baseUrl: '', host: '', force: false } });
  assert.equal(snapshot.snapshot.bars.codex.bar.text, 'codex 50%');

  // server.js always passes the cache; a deployment without one must still
  // answer the front door instead of throwing.
  const bare = createQuotaRuntime({ now: () => 1700000000000 });
  const empty = await bare.handle({ op: 'bars.state', selector: {} });
  assert.deepEqual(empty.snapshot, { status: 'ok', bars: {}, updatedAt: 0 });
  const commitless = await bare.handle({ op: 'bars.commit', kind: 'codex', record: true, selector: {} });
  assert.deepEqual(commitless, { cached: null });
});

test('a bar kind this port cannot fetch is an unknown operation, not a 500', async () => {
  const handler = hostHandler({ isLocal: () => true, now: () => 1700000000000 });
  const res = fakeRes();
  await handler({ body: { op: 'bars.fetch', kind: 'not-a-kind' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'unknown host operation' });
});

// ── The one expensive kind: claude's read is a 30-40s browser drive ─────────
// Every other kind's fetch is a cheap query, so a bar asking for it costs
// nothing. Claude's is the exception, and `force` is how a caller says "a human
// pressed the ⟳" — without it the front door must get the account's cache.
test('the claude bar only scrapes when the front door says force', async () => {
  Queue.resetClaudeUsageQueue();
  BarState.resetClaudeBarState();
  const scrapes = [];
  Queue.configureClaudeUsageQueue({
    now: () => 1_700_000_000_000,
    fetchUsage: async () => {
      scrapes.push('scrape');
      return { status: 'ok', fetchedAt: 1_700_000_000_000, summary: [{ window: '1wk', usedPercent: 6 }] };
    },
  });
  // The queue is process-local: production injects its accessors through
  // defaultDeps(); a test that owns the queue must inject the same ones.
  const runtime = createQuotaRuntime({
    now: () => 1_700_000_000_000,
    claudeUsageKey: Queue.claudeUsageKey,
    readClaudeUsage: Queue.readClaudeUsage,
    enqueueClaudeUsage: Queue.enqueueClaudeUsage,
    readClaudeLive: BarState.readClaudeLive,
  });
  try {
    // A page loading asks for the bar without `force`: answered from the queue,
    // and an account nobody has read yet is idle — not a reason to open a
    // browser.
    let state = await runtime.handle({ op: 'claude.quota', session: 's1', force: false });
    assert.deepEqual(scrapes, [], 'a read never scrapes');
    assert.equal(state.entry, null);
    assert.equal(state.usage, undefined);

    // The user's own refresh is the one thing allowed to start the scrape.
    state = await runtime.handle({ op: 'claude.quota', session: 's1', force: true });
    assert.deepEqual(scrapes, ['scrape']);
    assert.equal(state.result.status, 'ok');
    assert.equal(state.entry.result.status, 'ok');
    assert.equal(state.usage.status, 'ok');

    // A second ask inside the minute is answered from that reading: the queue's
    // floor is what stops two sessions — or two taps — racing two browsers.
    state = await runtime.handle({ op: 'claude.quota', session: 's1', force: true });
    assert.deepEqual(scrapes, ['scrape'], 'the minute holds');
    assert.equal(state.result.status, 'ok');

    // The live 5h window is a process-local map; the port is where the front
    // door can read it, at the same instant the reading is stamped.
    assert.equal(state.live, null);
    assert.equal(state.nowMs, 1_700_000_000_000);
    const { normalizeWindowEvent } = require('../src/native/binding').getQuotaBarView();
    BarState.rememberClaudeLive('s1', normalizeWindowEvent({
      rateLimitType: 'five_hour',
      status: 'allowed',
      utilization: 0.42,
      resetsAt: 4_102_444_800,
      windows: [{ window: '5h', usedPercent: 42, resetMs: 4_102_444_800_000 }],
    }, 1_700_000_000_000));
    const withLive = await runtime.handle({ op: 'claude.quota', session: 's1', force: false });
    assert.equal(withLive.live.usedPercentage, 42);
  } finally {
    Queue.resetClaudeUsageQueue();
    BarState.resetClaudeBarState();
  }
});

test('配额条缓存恢复失败时记录警告并使用空快照', () => {
  const warnings = [];
  const cache = createQuotaBarCache({ file: 'unused', logger: { warn: (...args) => warnings.push(args) },
    storeFactory: () => ({ loadOrRecover: () => ({ present: true, data: {
      entries: { old: {} }, updatedAt: { valueOf: 0, toString: 0 },
    } }) }),
  });
  assert.deepEqual(cache.snapshot(), { entries: {}, updatedAt: 0 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /load failed/);
});
