'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mountQuotaBarRoutes, createQuotaBarRuntime, statusCodeFor } = require('../src/routes/quota-bars');
const { createQuotaBarCache } = require('../src/quota/quota-bar-cache');
const Queue = require('../src/quota/claude-usage-queue');
const BarState = require('../src/quota/claude-bar-state');

function appHarness() {
  const handlers = new Map();
  return {
    app: {
      get(route, handler) { handlers.set(`GET ${route}`, handler); },
      post(route, handler) { handlers.set(`POST ${route}`, handler); },
    },
    async invoke(method, route, req = {}) {
      const handler = handlers.get(`${method} ${route}`);
      assert.equal(typeof handler, 'function', `missing ${method} ${route}`);
      const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await handler({ body: {}, query: {}, ...req }, res);
      return res;
    },
  };
}

function tmpCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-quota-bar-cache-test-'));
  return createQuotaBarCache({ file: path.join(dir, 'quota-bar-cache.json'), now: () => 1700000000000 });
}

function bar(kind) {
  return { text: `${kind} 50%`, color: '#58a6ff', title: `${kind} title`, action: null };
}

test('unified quota refresh fetches, renders and stores a server-side bar', async () => {
  const cache = tmpCache();
  const calls = [];
  const runtime = createQuotaBarRuntime({
    quotaBarCache: cache,
    fetchOpenCodeUsage: async () => {
      calls.push('opencode');
      return { status: 'ok', fetchedAt: 123, usage: { rolling: { usagePercent: 50 } } };
    },
    renderQuotaBar: (kind, value) => ({ ...bar(kind), title: String(value.fetchedAt) }),
  });

  const result = await runtime.refresh({ kind: 'opencode' });
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(calls, ['opencode']);
  assert.equal(result.body.bar.text, 'opencode 50%');
  assert.equal(result.body.cached.bar.text, 'opencode 50%');
  assert.equal(cache.get('opencode').bar.text, 'opencode 50%');
});

test('unified quota refresh records provider-scoped vendor results when identity exists', async () => {
  const recorded = [];
  const runtime = createQuotaBarRuntime({
    fetchKimiUsage: async (host) => ({ status: 'ok', fetchedAt: 456, host }),
    renderQuotaBar: (kind) => bar(kind),
    recordVendor: (entry) => recorded.push(entry),
  });

  const result = await runtime.refresh({ kind: 'kimi', host: 'moonshot.cn' });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.bar.text, 'kimi 50%');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'kimi');
  assert.equal(recorded[0].host, 'moonshot.cn');
});

test('quota bar routes expose idle, state and refresh without vendor URLs in the client contract', async () => {
  const cache = tmpCache();
  const h = appHarness();
  mountQuotaBarRoutes(h.app, {
    quotaBarCache: cache,
    fetchCodexUsage: async () => ({ status: 'ok', fetchedAt: 789 }),
    renderQuotaBar: (kind) => bar(kind),
  });

  let res = await h.invoke('GET', '/api/quota/bars/idle');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.bars.codex);

  res = await h.invoke('POST', '/api/quota/bars/refresh', { body: { kind: 'codex' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bar.text, 'codex 50%');

  res = await h.invoke('GET', '/api/quota/bars/state');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bars.codex.bar.text, 'codex 50%');
});

// ── The one expensive kind: claude's refresh is a 30-40s browser drive ──────
// Every other kind's refresh is a cheap query, so a bar asking for it costs
// nothing. Claude's is the exception, and `force` is how a caller says "a human
// pressed the ⟳" — without it this route must report the account's cache.
test('the claude bar only scrapes when the caller asks it to', async () => {
  const cache = tmpCache();
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
  const recorded = [];
  const runtime = createQuotaBarRuntime({
    quotaBarCache: cache,
    recordClaude: (session, result, text) => recorded.push({ session, status: result.status, text }),
  });
  try {
    // A page loading asks for the bar without `force`: it is answered from the
    // cache, and an account nobody has read yet is `idle` — not an error, and
    // emphatically not a reason to open a browser.
    let result = await runtime.refresh({ kind: 'claude', session: 's1' });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.status, 'idle');
    assert.deepEqual(scrapes, [], 'a read never scrapes');
    // A miss is not a reading: caching one would park a healthy provider in the
    // shared cache, and recording one would overwrite the last known bar.
    assert.equal(result.body.cached, null);
    assert.deepEqual(recorded, []);

    // The user's own refresh is the one thing allowed to start the scrape.
    result = await runtime.refresh({ kind: 'claude', session: 's1', force: true });
    assert.deepEqual(scrapes, ['scrape']);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.status, 'ok');
    assert.match(result.body.bar.text, /1wk 94%/);
    assert.equal(result.body.cached.bar.text, result.body.bar.text, 'a real reading is stored');
    assert.deepEqual(recorded.map(r => r.status), ['ok']);

    // A second ask inside the minute is answered from that reading: the queue's
    // floor is what stops two sessions — or two taps — racing two browsers.
    result = await runtime.refresh({ kind: 'claude', session: 's1', force: true });
    assert.deepEqual(scrapes, ['scrape'], 'the minute holds');
    assert.equal(result.body.status, 'ok');
  } finally {
    Queue.resetClaudeUsageQueue();
    BarState.resetClaudeBarState();
  }
});

test('idle is a state of the claude cache, not a failed request', () => {
  assert.equal(statusCodeFor('idle'), 200);
  assert.equal(statusCodeFor('ok'), 200);
  assert.equal(statusCodeFor('needs_login'), 401);
  assert.equal(statusCodeFor('chrome_unavailable'), 503);
});
