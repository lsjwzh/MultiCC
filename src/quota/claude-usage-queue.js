'use strict';

const { getNative } = require('../native/binding');
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_KEY = 'claude:default';

let fetchUsage = null;
let now = () => Date.now();
let keyResolver = null;
let cache;
const entries = new Map(), inflight = new Map();

function owner() {
  return cache ??= getNative().claudeUsageCache({
    entries, inflight, now: () => now(), before: (at, other) => at < other,
    fresh: entry => now() - entry.at < MIN_INTERVAL_MS,
    get configured() { return typeof fetchUsage === 'function'; },
    resolved: value => Promise.resolve(value), account: name => name.slice('claude:'.length),
    async fetch(name, accountId) {
      let result;
      try { result = await (accountId ? fetchUsage({ accountId }) : fetchUsage()); }
      catch (err) { result = { status: 'unavailable', error: String((err && err.message) || err) }; }
      return owner().finish(name, result);
    },
  });
}

function configureClaudeUsageQueue(inject = {}) {
  if (inject && typeof inject.fetchUsage === 'function') fetchUsage = inject.fetchUsage;
  if (inject && typeof inject.now === 'function') now = inject.now;
}
function configureClaudeKeyResolver(fn) { keyResolver = typeof fn === 'function' ? fn : null; }
function claudeProviderKey(sessionName) {
  if (!keyResolver) return '';
  try { return String(keyResolver(sessionName) || ''); } catch (_) { return ''; }
}
function claudeUsageKey(sessionName) { return claudeProviderKey(sessionName) || DEFAULT_KEY; }
function readClaudeUsage(key) { return owner().read(key); }
function enqueueClaudeUsage(key) { return owner().enqueue(key); }
function resetClaudeUsageQueue() {
  entries.clear();
  inflight.clear();
  fetchUsage = null;
  now = () => Date.now();
  keyResolver = null;
}
module.exports = {
  MIN_INTERVAL_MS, DEFAULT_KEY, configureClaudeUsageQueue, configureClaudeKeyResolver,
  claudeProviderKey, claudeUsageKey, readClaudeUsage, enqueueClaudeUsage, resetClaudeUsageQueue,
};
