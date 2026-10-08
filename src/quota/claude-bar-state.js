'use strict';

// The Claude bar is the only one built from two sources that arrive on
// different paths, at different rates, for different reasons:
//
//   · the 5h rolling window — a passive rate_limit_event, read off response
//     headers on every official-OAuth turn, seconds old, per session;
//   · the weekly windows — a 30-40s CDP scrape of claude.ai/settings/usage,
//     minutes to hours old, account-wide, only when someone clicks 刷新.
//
// Merging them used to be each client's job, which is why the app never did it
// at all. Holding both here lets either arrival re-render the whole bar
// server-side, so the web and the app receive the merged result rather than the
// ingredients.
//
// Scope is deliberate: the scrape is account-wide, so one copy; the live window
// is per session, so keyed by session. Everything is in-process and lost on
// restart — a stale quota reading is worse than no reading, and the first turn
// or click after a restart refills it.

const { claudeBar } = require('./quota-bar-view');

let lastScrape = null;
const liveBySession = new Map();

// The live window ages out on its own clock: a 5h window observed 5h ago tells
// you nothing, and showing it would be worse than showing the placeholder.
const LIVE_TTL_MS = 5 * 60 * 60 * 1000;
// Bounded so a long-lived server with many sessions does not accumulate windows
// for sessions that ended. Oldest observation is evicted first.
const MAX_LIVE_SESSIONS = 200;

function rememberClaudeScrape(result) {
  if (result && typeof result === 'object') lastScrape = result;
  return lastScrape;
}

function rememberClaudeLive(sessionName, normalized) {
  if (!sessionName || !normalized || normalized.provider !== 'claude') return;
  liveBySession.set(sessionName, normalized);
  if (liveBySession.size > MAX_LIVE_SESSIONS) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, v] of liveBySession) {
      const at = Number(v && v.observedAtMs) || 0;
      if (at < oldestAt) { oldestAt = at; oldestKey = key; }
    }
    if (oldestKey !== null) liveBySession.delete(oldestKey);
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
function liveFor(sessionName, nowMs) {
  const live = liveBySession.get(sessionName);
  if (!live) return null;
  const observed = Number(live.observedAtMs) || 0;
  const reset = Number(live.resetsAtMs);
  const windowClosed = Number.isFinite(reset) && reset > 0 && reset <= nowMs;
  if (windowClosed || nowMs - observed > LIVE_TTL_MS) {
    liveBySession.delete(sessionName);
    return null;
  }
  return live;
}

/**
 * The Claude bar as of right now, for one session: the newest scrape merged
 * with that session's newest live 5h window.
 */
function renderClaudeBar(sessionName, nowMs = Date.now()) {
  return claudeBar(lastScrape, sessionName ? liveFor(sessionName, nowMs) : null);
}

// Test seam: the module holds process-wide state, so a test that asserts on one
// arrival order must not inherit another test's.
function resetClaudeBarState() {
  lastScrape = null;
  liveBySession.clear();
}

module.exports = {
  rememberClaudeScrape,
  rememberClaudeLive,
  renderClaudeBar,
  resetClaudeBarState,
};
