'use strict';

// The Claude subscription-usage cache — keyed by the ACCOUNT a session's
// provider borrows — and the only door a claude.ai scrape may be started from.
//
// The reading behind the Claude bar (its weekly/monthly windows; the 5h one
// arrives passively on rate_limit_event) comes from claude.ai/settings/usage,
// which costs a 30-40s CDP drive whenever the OAuth control plane cannot
// answer. Two things were wrong with how it was fetched:
//
//   · every request re-ran it. Loading a page, switching a session and tapping
//     the bar all drove a browser for a number that had not moved;
//   · the result then sat in ONE process-wide slot with no account identity, so
//     two signed-in official accounts printed each other's numbers and a
//     restart threw the reading away.
//
// So the cache is keyed (see claudeUsageKey below), every session of one account
// reads the same entry, and a plain read NEVER fetches: looking at a bar is not
// a reason to drive a browser. Exactly two things enqueue a scrape — an explicit
// user refresh (the clients' ⟳ / tap sends `force=1`) and a task boundary (a
// turn ending; see ../chat/usage-limit-wiring.js).
//
// The queue itself is the answer to "one session already pulled it, so the other
// must not": a scrape is rate-limited to one per key per minute, and a scrape
// already in flight is joined instead of duplicated. A FAILED scrape does not
// hold that minute open — it produced no reading to reuse, and needs_login /
// chrome_unavailable are precisely the states a user's own refresh is meant to
// retry.

// One reading per account per minute, and one entry per account on screen. The
// bound is for a long-lived server that switched between many accounts; the
// oldest reading is evicted first.
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_KEY = 'claude:default';
const MAX_KEYS = 50;

// Injected by src/routes/claude-usage-quota.js at load — it owns the scrape —
// and replaceable by tests.
let fetchUsage = null;
let now = () => Date.now();
// Session name → cache key. Configured once by the chat wiring, the only place
// that can resolve a session to the provider (and that provider to the account)
// it runs on; see configureClaudeKeyResolver. With no resolver every session
// shares the default key, which is what the bar did before it was keyed at all.
let keyResolver = null;

// key → { result, at } — at being when the scrape produced it (server clock),
// which is what the one-minute floor is measured from.
const entries = new Map();
// key → promise of the scrape in flight, so N sessions asking at once share one
// browser instead of racing two of them.
const inflight = new Map();

function configureClaudeUsageQueue(inject = {}) {
  if (inject && typeof inject.fetchUsage === 'function') fetchUsage = inject.fetchUsage;
  if (inject && typeof inject.now === 'function') now = inject.now;
}

function configureClaudeKeyResolver(fn) {
  keyResolver = typeof fn === 'function' ? fn : null;
}

// The key a session's reading belongs to: `claude:<accountId>` for a session
// whose provider borrows a signed-in official account, DEFAULT_KEY for the
// shared CLI login, and '' — no Claude reading at all — for a session whose
// Claude traffic does not go to the subscription (another CLI, or a provider
// routed to some other vendor).
function claudeProviderKey(sessionName) {
  if (!keyResolver) return '';
  try { return String(keyResolver(sessionName) || ''); } catch (_) { return ''; }
}

// The key to look a bar up by. Never empty: a session we cannot resolve still
// has a bar, and it shares the default one.
function claudeUsageKey(sessionName) {
  return claudeProviderKey(sessionName) || DEFAULT_KEY;
}

function readClaudeUsage(key) {
  return entries.get(key || DEFAULT_KEY) || null;
}

function rememberClaudeUsage(key, result) {
  const name = key || DEFAULT_KEY;
  const entry = {
    result: result && typeof result === 'object' ? result : null,
    at: now(),
  };
  entries.set(name, entry);
  if (entries.size > MAX_KEYS) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [other, value] of entries) {
      if (value.at < oldestAt) { oldestAt = value.at; oldestKey = other; }
    }
    if (oldestKey !== null) entries.delete(oldestKey);
  }
  return entry;
}

// A reading worth NOT re-fetching: it came off a browser inside the last minute
// and it actually had numbers in it. A failure is deliberately not protected —
// it produced nothing to reuse, and it is exactly what a user's own refresh is
// meant to retry (see the header).
function isFreshReading(entry) {
  return !!entry && !!entry.result && entry.result.status === 'ok'
    && now() - entry.at < MIN_INTERVAL_MS;
}

/**
 * Ask for this account's Claude reading, starting a scrape only if the cache
 * cannot answer: a reading fetched less than a minute ago is returned as-is, and
 * a scrape already open for the same key is joined.
 *
 * Never rejects — a scrape that blows up is stored as an `unavailable` reading,
 * so the bar can say so instead of the chat flow seeing a throw.
 */
function enqueueClaudeUsage(key) {
  const name = key || DEFAULT_KEY;
  const open = inflight.get(name);
  if (open) return open;
  const cached = entries.get(name);
  if (isFreshReading(cached)) return Promise.resolve(cached);
  if (typeof fetchUsage !== 'function') return Promise.resolve(cached || null);
  // An official account provider borrows a specific account id; asking for it
  // first is what keeps two accounts from printing each other's numbers.
  const accountId = name === DEFAULT_KEY ? '' : name.slice('claude:'.length);
  const promise = (async () => {
    let result = null;
    try {
      result = await (accountId ? fetchUsage({ accountId }) : fetchUsage());
    } catch (err) {
      result = { status: 'unavailable', error: String((err && err.message) || err) };
    }
    inflight.delete(name);
    return rememberClaudeUsage(name, result);
  })();
  inflight.set(name, promise);
  return promise;
}

// Test seam: the module holds process-wide state, so a test that asserts on one
// arrival order must not inherit another test's — nor another test's injected
// fetcher, clock or key resolver.
function resetClaudeUsageQueue() {
  entries.clear();
  inflight.clear();
  fetchUsage = null;
  now = () => Date.now();
  keyResolver = null;
}

module.exports = {
  MIN_INTERVAL_MS,
  DEFAULT_KEY,
  configureClaudeUsageQueue,
  configureClaudeKeyResolver,
  claudeProviderKey,
  claudeUsageKey,
  readClaudeUsage,
  enqueueClaudeUsage,
  resetClaudeUsageQueue,
};
