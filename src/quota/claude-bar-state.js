'use strict';

// The Claude bar is the only one built from two sources that arrive on
// different paths, at different rates, for different reasons:
//
//   · the 5h rolling window — a passive rate_limit_event, read off response
//     headers on every official-OAuth turn, seconds old;
//   · the weekly and monthly windows — the usage cache, whose readings come
//     from claude.ai/settings/usage or the OAuth control plane, minutes to hours
//     old, only on a user refresh or at a task boundary (see
//     ./claude-usage-queue.js, which owns both the cache and that policy).
//
// Merging them used to be each client's job, which is why the app never did it
// at all. Holding both here lets either arrival re-render the whole bar
// server-side, so the web and the app receive the merged result rather than the
// ingredients.
//
// Both are keyed by PROVIDER (claudeUsageKey), not by session: a rolling window
// and a usage reading describe the ACCOUNT, so two sessions on one account
// genuinely share them, and two accounts must never share either. Everything is
// in-process and lost on restart — a stale quota reading is worse than no
// reading, and the first turn end or click after a restart refills it. (The
// durable copy the clients restore from is the provider-limit cache, written
// per account by limit-cache-recorder.)

const { claudeBar } = require('./quota-bar-view');
const { claudeUsageKey, readClaudeUsage } = require('./claude-usage-queue');

const liveByKey = new Map();

// The live window ages out on its own clock: a 5h window observed 5h ago tells
// you nothing, and showing it would be worse than showing the placeholder.
const LIVE_TTL_MS = 5 * 60 * 60 * 1000;
// Bounded so a long-lived server switching between many accounts does not
// accumulate windows for accounts nobody is on. Oldest observation evicted
// first.
const MAX_LIVE_KEYS = 50;

function rememberClaudeLive(sessionName, normalized) {
  if (!sessionName || !normalized || normalized.provider !== 'claude') return;
  const key = claudeUsageKey(sessionName);
  liveByKey.set(key, normalized);
  if (liveByKey.size > MAX_LIVE_KEYS) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [name, value] of liveByKey) {
      const at = Number(value && value.observedAtMs) || 0;
      if (at < oldestAt) { oldestAt = at; oldestKey = name; }
    }
    if (oldestKey !== null) liveByKey.delete(oldestKey);
  }
}

// The live window is only live while its own deadline is ahead of us. The
// header event names the window it was read in; once that window's reset has
// passed, the event describes a window that no longer exists — its percentage
// belongs to the window that just ended and its deadline is already gone. The
// TTL alone does not catch this: an event observed an hour before its window
// ended is well inside the five hours and still prints as current.
//
// Keeping it is not harmless. The merge below prefers the live window over the
// scrape's 5h row, so a closed event overrides the account-wide reading that is
// actually current (the OAuth endpoint reports utilization 0 and no reset time
// while no window is running) and the bar reads `5h 44% 已重置` — a stale number
// next to a word with no time in it. Auto's limit policy already refuses to let
// a window whose reset has passed bind anything (see usedPercentOf in
// ../chat/auto-provider-policy.js); the bar is the only place that still showed
// one. Drop it and the scrape's own 5h row answers instead.
function liveFor(key, nowMs) {
  const live = liveByKey.get(key);
  if (!live) return null;
  const observed = Number(live.observedAtMs) || 0;
  const reset = Number(live.resetsAtMs);
  const windowClosed = Number.isFinite(reset) && reset > 0 && reset <= nowMs;
  if (windowClosed || nowMs - observed > LIVE_TTL_MS) {
    liveByKey.delete(key);
    return null;
  }
  return live;
}

/**
 * The Claude bar as of right now, for one session: that session's account's
 * newest usage reading, merged with the same account's newest live 5h window.
 */
function renderClaudeBar(sessionName, nowMs = Date.now()) {
  const key = claudeUsageKey(sessionName);
  const entry = readClaudeUsage(key);
  return claudeBar(entry && entry.result, liveFor(key, nowMs));
}

// Test seam: the module holds process-wide state, so a test that asserts on one
// arrival order must not inherit another test's.
function resetClaudeBarState() {
  liveByKey.clear();
}

module.exports = {
  rememberClaudeLive,
  renderClaudeBar,
  resetClaudeBarState,
};
