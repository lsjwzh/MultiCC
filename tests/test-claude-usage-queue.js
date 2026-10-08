'use strict';

// The Claude subscription-usage cache and the only door a claude.ai scrape may
// be opened from (src/quota/claude-usage-queue.js). The rules under test are the
// ones the queue exists for:
//
//   · a plain read never drives a browser — looking at a bar is not a reason;
//   · one scrape per ACCOUNT per minute, and an open scrape is joined rather
//     than duplicated, so "one session already pulled it" really does mean the
//     other session does not;
//   · two accounts never share a reading, and two sessions on one account do;
//   · only a successful, fetch-produced reading holds that minute open — a
//     needs_login is exactly what a user's own ⟳ is meant to retry.

const assert = require('node:assert/strict');
const test = require('node:test');

const Queue = require('../src/quota/claude-usage-queue');

const NOW = 1_700_000_000_000;
const OK = (extra = {}) => ({ status: 'ok', fetchedAt: NOW, summary: [{ window: '5h', usedPercent: 3 }], ...extra });

// Every test drives the module's process-wide state, so each one starts and ends
// with a clean slate — including the injected clock, fetcher and key resolver.
function withQueue({ keyResolver, results = [], now = () => NOW } = {}) {
  const calls = [];
  Queue.resetClaudeUsageQueue();
  Queue.configureClaudeUsageQueue({
    now,
    fetchUsage: async (opts) => {
      calls.push(opts === undefined ? {} : opts);
      const next = results.length > 1 ? results.shift() : results[0];
      if (typeof next === 'function') return next(opts);
      if (next instanceof Error) throw next;
      return next === undefined ? OK() : next;
    },
  });
  if (keyResolver) Queue.configureClaudeKeyResolver(keyResolver);
  return { calls, done: () => Queue.resetClaudeUsageQueue() };
}

test('a read is not a reason to fetch: the cache answers, the browser does not', async () => {
  const q = withQueue();
  try {
    assert.equal(Queue.readClaudeUsage(Queue.DEFAULT_KEY), null, 'nothing cached yet');
    assert.equal(q.calls.length, 0, 'and nothing was fetched by looking');
    assert.equal(Queue.readClaudeUsage('claude:someone'), null, 'still nothing, still no fetch');
    assert.equal(q.calls.length, 0);
  } finally { q.done(); }
});

test('one scrape per account per minute, however many times it is asked for', async () => {
  let clock = NOW;
  const q = withQueue({ now: () => clock });
  try {
    await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(q.calls.length, 1);
    // The same session tapping again straight away is answered from the cache.
    await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(q.calls.length, 1, 'inside the minute the reading is reused');
    // 59s later still, 61s later no longer: the floor is on the scrape, not on
    // the reading's usefulness.
    clock = NOW + Queue.MIN_INTERVAL_MS - 1000;
    await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(q.calls.length, 1);
    clock = NOW + Queue.MIN_INTERVAL_MS + 1000;
    await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(q.calls.length, 2, 'a minute on, a new scrape is allowed');
  } finally { q.done(); }
});

test('two sessions on one account share a scrape; two accounts never do', async () => {
  const accounts = { s1: 'claude:aaa', s2: 'claude:aaa', s3: 'claude:bbb' };
  const q = withQueue({ keyResolver: (name) => accounts[name] || '' });
  try {
    assert.equal(Queue.claudeUsageKey('s1'), 'claude:aaa');
    assert.equal(Queue.claudeUsageKey('s2'), 'claude:aaa');
    assert.equal(Queue.claudeUsageKey('s3'), 'claude:bbb');
    await Queue.enqueueClaudeUsage(Queue.claudeUsageKey('s1'));
    await Queue.enqueueClaudeUsage(Queue.claudeUsageKey('s2'));
    assert.equal(q.calls.length, 1, 'the second session of the account reuses the first scrape');
    assert.deepEqual(q.calls[0], { accountId: 'aaa' }, 'and asks the scrape for that account');
    // A different account is a different reading: no sharing in either
    // direction, and each scrape is told which account it is for.
    await Queue.enqueueClaudeUsage(Queue.claudeUsageKey('s3'));
    assert.equal(q.calls.length, 2);
    assert.deepEqual(q.calls[1], { accountId: 'bbb' });
    assert.notEqual(Queue.readClaudeUsage('claude:aaa'), Queue.readClaudeUsage('claude:bbb'));
  } finally { q.done(); }
});

test('a session the resolver cannot place shares the default reading', async () => {
  const q = withQueue({ keyResolver: () => '' });
  try {
    assert.equal(Queue.claudeProviderKey('s1'), '', 'the resolver says this session has no account');
    assert.equal(Queue.claudeUsageKey('s1'), Queue.DEFAULT_KEY, 'but the bar still needs a key');
    await Queue.enqueueClaudeUsage(Queue.claudeUsageKey('s1'));
    assert.deepEqual(q.calls[0], {}, 'the shared CLI login is scraped with no account preference');
    assert.ok(Queue.readClaudeUsage(Queue.DEFAULT_KEY), 'and lands under the default key');
  } finally { q.done(); }
});

test('concurrent asks share one scrape instead of racing two browsers', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const q = withQueue({ results: [async () => { await gate; return OK(); }] });
  try {
    const first = Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    const second = Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(first, second, 'the second caller is handed the same promise');
    assert.equal(q.calls.length, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(q.calls.length, 1);
  } finally { q.done(); }
});

test('a failed scrape does not hold the minute open', async () => {
  let clock = NOW;
  const q = withQueue({
    now: () => clock,
    results: [{ status: 'needs_login' }, OK()],
  });
  try {
    const failed = await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(failed.result.status, 'needs_login');
    assert.equal(q.calls.length, 1);
    // Seconds later — well inside the minute — the user's own refresh (or the
    // login they just finished) must be allowed to try again: the failure
    // produced no reading to reuse.
    clock = NOW + 5_000;
    const retried = await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(q.calls.length, 2, 'a failure is retried right away');
    assert.equal(retried.result.status, 'ok');
    // Now that it succeeded, the minute is in force again.
    clock = NOW + 10_000;
    await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(q.calls.length, 2);
  } finally { q.done(); }
});

test('a scrape that throws is stored as a reading, not a rejected promise', async () => {
  const q = withQueue({ results: [new Error('chrome died')] });
  try {
    const entry = await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY);
    assert.equal(entry.result.status, 'unavailable');
    assert.match(entry.result.error, /chrome died/);
    assert.equal(Queue.readClaudeUsage(Queue.DEFAULT_KEY).result.status, 'unavailable');
  } finally { q.done(); }
});

test('with no fetcher wired the queue reports the cache instead of hanging', async () => {
  Queue.resetClaudeUsageQueue();
  try {
    assert.equal(await Queue.enqueueClaudeUsage(Queue.DEFAULT_KEY), null);
  } finally { Queue.resetClaudeUsageQueue(); }
});
