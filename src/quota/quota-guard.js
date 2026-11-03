'use strict';

// Quota guard — an account-protection gate, not a scheduler.
//
// The provider-limit cache already knows how full each subscription window is:
// the 5h window arrives passively from the anthropic-ratelimit-* headers on
// every official-OAuth turn, the weekly/monthly windows from the usage sweepers
// and the turn-end scrape. Until now that knowledge only STEERED routing (see
// auto-provider-policy NEAR_LIMIT_PERCENT): a candidate at 90% yields to a
// roomier one when a new route is being chosen, but a route already in use is
// never evicted, so a subscription can be driven to exactly 100% of its window.
// Those last requests are the ones that come back 429, and a window pinned at
// 100% for days is the shape upstream anti-abuse reads as an API pool rather
// than a person.
//
// This module answers one question, for one provider: is any live window at or
// above the configured share, with a reset still ahead? If so the caller must
// not send more requests to that account until the window resets.
//
// Why a stale reading may still hold the gate, but only for a while: inside
// one window `usedPercent` only increases for CONSUMPTION — rolling windows
// never give quota back before their reset — so an old reading is a lower
// bound on what was spent. The denominator is another matter: a plan upgrade,
// a top-up or an account change shrinks usedPercent mid-window, and the cache
// cannot learn any of that while the gate holds every turn, because the quota
// refresh rides on completed turns — a hard block on a stale reading is a
// deadlock that only a manual cache edit used to break. So a blocking reading
// older than maxReadingAgeMs RELEASES the gate (`stale_reading`): one turn is
// let through and a re-read is kicked off, after which a genuinely exhausted
// account re-parks on the fresh reading or the real 429. A failed re-read
// stamps lastAttemptAt, which re-arms the staleness clock — an unreachable
// upstream is probed at most once per maxReadingAgeMs, never hammered.
// A window that publishes no reset time never blocks: there would be no honest
// moment to lift the gate.
//
// Configuration is the file merged under the environment, with defaults for
// anything neither sets — so an env var always wins over quota-guard.json:
//
//   <data root>/quota-guard.json
//     { "enabled": true,
//       "fiveHourPercent": 98,
//       "weeklyPercent": 98,
//       "monthlyPercent": 98,
//       "scope": "official",
//       "maxReadingAgeMs": 1800000 }
//
//   MULTICC_QUOTA_GUARD=0|1                 master switch
//   MULTICC_QUOTA_GUARD_PERCENT=98          every window at once
//   MULTICC_QUOTA_GUARD_5H_PERCENT=98       current session window
//   MULTICC_QUOTA_GUARD_WEEKLY_PERCENT=98   seven-day window
//   MULTICC_QUOTA_GUARD_MONTHLY_PERCENT=98  thirty-day window
//   MULTICC_QUOTA_GUARD_SCOPE=official|all  which providers the gate may hold
//   MULTICC_QUOTA_GUARD_MAX_READING_AGE_MS=1800000  how old a blocking reading
//                                           may get before the gate releases
//                                           for revalidation instead
//
// `scope: 'official'` is the default because only an official subscription has
// a window that is actually consumed to zero; a third-party relay reporting 98%
// usually means something else entirely.

const fs = require('node:fs');

const DEFAULTS = Object.freeze({
  enabled: true,
  fiveHourPercent: 98,
  weeklyPercent: 98,
  monthlyPercent: 98,
  scope: 'official',
  // A blocking reading this old has outlived the evidence behind it (see the
  // header): the gate releases for one revalidated turn instead of holding
  // the account — and the refresh path — hostage until the window resets.
  maxReadingAgeMs: 30 * 60 * 1000,
});

// A re-read offer per provider at most this often; check() runs per candidate
// per turn, and without the throttle a stale gate would re-kick the refresh
// on every one of them.
const STALE_NOTIFY_MIN_INTERVAL_MS = 60 * 1000;

// Settings are re-read at most this often, so editing quota-guard.json (or the
// environment of a restart) takes effect without a per-request stat/parse.
const CONFIG_CACHE_MS = 5_000;

const OFFICIAL_PROVIDER_RE = /^[a-z0-9]+-official(?:-|$)/i;

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function percentOf(value) {
  const number = Number(value);
  if (value == null || value === '' || !Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function boolOf(value, fallback) {
  if (value == null || value === '') return fallback;
  const text = clean(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

// Below a minute the gate would re-ask upstream on nearly every request, and
// above a week it is no release valve at all — both read as form mistakes.
function readingAgeOf(value) {
  const number = Number(value);
  if (value == null || value === '' || !Number.isFinite(number)) return null;
  if (number < 60_000 || number > 7 * 24 * 3600_000) return null;
  return Math.trunc(number);
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const scope = clean(source.scope).toLowerCase();
  return Object.freeze({
    enabled: source.enabled !== false,
    fiveHourPercent: percentOf(source.fiveHourPercent) ?? DEFAULTS.fiveHourPercent,
    weeklyPercent: percentOf(source.weeklyPercent) ?? DEFAULTS.weeklyPercent,
    monthlyPercent: percentOf(source.monthlyPercent) ?? DEFAULTS.monthlyPercent,
    scope: scope === 'all' ? 'all' : 'official',
    maxReadingAgeMs: readingAgeOf(source.maxReadingAgeMs) ?? DEFAULTS.maxReadingAgeMs,
  });
}

function envConfig(env = process.env) {
  if (!env || typeof env !== 'object') return {};
  const all = percentOf(env.MULTICC_QUOTA_GUARD_PERCENT);
  const patch = {};
  if (env.MULTICC_QUOTA_GUARD != null && env.MULTICC_QUOTA_GUARD !== '') {
    patch.enabled = boolOf(env.MULTICC_QUOTA_GUARD, DEFAULTS.enabled);
  }
  if (all != null) {
    patch.fiveHourPercent = all;
    patch.weeklyPercent = all;
    patch.monthlyPercent = all;
  }
  const fiveHour = percentOf(env.MULTICC_QUOTA_GUARD_5H_PERCENT);
  const weekly = percentOf(env.MULTICC_QUOTA_GUARD_WEEKLY_PERCENT);
  const monthly = percentOf(env.MULTICC_QUOTA_GUARD_MONTHLY_PERCENT);
  if (fiveHour != null) patch.fiveHourPercent = fiveHour;
  if (weekly != null) patch.weeklyPercent = weekly;
  if (monthly != null) patch.monthlyPercent = monthly;
  const scope = clean(env.MULTICC_QUOTA_GUARD_SCOPE).toLowerCase();
  if (scope === 'all' || scope === 'official') patch.scope = scope;
  const maxReadingAge = readingAgeOf(env.MULTICC_QUOTA_GUARD_MAX_READING_AGE_MS);
  if (maxReadingAge != null) patch.maxReadingAgeMs = maxReadingAge;
  return patch;
}

// One token per cycle, matching limit-cache-recorder's cycleToken(): every
// producer names the same window its own way and all of them resolve here.
function windowKind(window) {
  const token = clean(window).toLowerCase();
  if (['5h', 'five_hour', 'five-hour', 'session', '5-hour'].includes(token)) return 'five_hour';
  if (['7d', '1wk', 'weekly', 'week', '7-day', 'seven_day'].includes(token)) return 'weekly';
  if (['1m', '30d', 'monthly', 'month', '30-day'].includes(token)) return 'monthly';
  return null;
}

function thresholdFor(kind, config) {
  if (kind === 'five_hour') return config.fiveHourPercent;
  if (kind === 'weekly') return config.weeklyPercent;
  if (kind === 'monthly') return config.monthlyPercent;
  return null;
}

// The windows a cache entry describes, normalized to {kind, usedPercent,
// resetMs}. Both shapes the cache writes are read: the structured `windows`
// array (recorder / sweeper) and the single top-level pair (bar snapshots).
function liveWindows(entry) {
  const summary = entry && entry.summary && typeof entry.summary === 'object' ? entry.summary : {};
  if (summary.kind === 'availability' || summary.kind === 'balance') return [];
  const rows = [];
  if (Array.isArray(summary.windows)) {
    for (const w of summary.windows) {
      if (!w || w.usedPercent == null) continue;
      const used = percentOf(w.usedPercent);
      const kind = windowKind(w.window);
      if (used == null || !kind) continue;
      const reset = Number(w.resetMs);
      rows.push({ kind, window: clean(w.window) || kind, usedPercent: used,
        resetMs: Number.isFinite(reset) && reset > 0 ? reset : null });
    }
  }
  if (summary.usedPercentage != null) {
    const used = percentOf(summary.usedPercentage);
    const kind = windowKind(summary.window) || 'five_hour';
    if (used != null) {
      const reset = Number(summary.resetsAtMs);
      rows.push({ kind, window: clean(summary.window) || kind, usedPercent: used,
        resetMs: Number.isFinite(reset) && reset > 0 ? reset : null });
    }
  }
  return rows;
}

// The moment the entry last said something about the account: a successful
// read stamps fetchedAt, a failed refresh stamps lastAttemptAt. Taking the
// max means a failed re-read re-arms the staleness clock — while upstream
// cannot be asked at all, the gate keeps holding instead of releasing a probe
// turn on every check.
function readingTimestamp(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const stamps = [Number(entry.fetchedAt), Number(entry.lastAttemptAt)]
    .filter(value => Number.isFinite(value) && value > 0);
  return stamps.length ? Math.max(...stamps) : null;
}

// The verdict for one provider. `blocked` is the only thing a caller acts on;
// the rest is there to be logged and shown, so a held turn can say which window
// and until when. Ties break towards the fullest window, then the farthest reset.
function guardVerdict(entry, { config = DEFAULTS, now = Date.now() } = {}) {
  const settings = normalizeConfig(config);
  if (!settings.enabled) return Object.freeze({ blocked: false, reason: 'guard_disabled' });
  if (!entry || typeof entry !== 'object') return Object.freeze({ blocked: false, reason: 'no_reading' });
  const hits = [];
  for (const row of liveWindows(entry)) {
    const threshold = thresholdFor(row.kind, settings);
    if (threshold == null) continue;
    if (!(row.usedPercent >= threshold)) continue;
    // No published reset: the gate would have no honest moment to lift.
    if (!(row.resetMs > now)) continue;
    hits.push({ ...row, threshold });
  }
  if (!hits.length) return Object.freeze({ blocked: false, reason: 'below_threshold' });
  hits.sort((left, right) => (right.usedPercent - left.usedPercent)
    || (right.resetMs - left.resetMs));
  const top = hits[0];
  // A blocking reading older than maxReadingAgeMs releases the gate instead:
  // the account may have been upgraded or topped up since, and holding the
  // turns is exactly what starves the refresh path of a fresh reading. The
  // caller lets the turn through; check() turns this reason into a re-read.
  const readingAt = readingTimestamp(entry);
  if (readingAt != null && now - readingAt > settings.maxReadingAgeMs) {
    return Object.freeze({
      blocked: false,
      reason: 'stale_reading',
      window: top.window,
      kind: top.kind,
      usedPercent: top.usedPercent,
      threshold: top.threshold,
      resetsAtMs: top.resetMs,
      readingAtMs: readingAt,
    });
  }
  return Object.freeze({
    blocked: true,
    reason: `quota_guard_${top.kind}`,
    window: top.window,
    kind: top.kind,
    usedPercent: top.usedPercent,
    threshold: top.threshold,
    resetsAtMs: top.resetMs,
    blockedUntilMs: top.resetMs,
  });
}

function createQuotaGuard({
  cache, configFile = null, env = process.env, now = Date.now, logger = null,
  onStale = null,
} = {}) {
  let cached = null;
  let cachedAt = 0;
  // The re-read offered on a stale_reading release, (appType, providerId) =>
  // Promise. Wired after the balance routes exist, so a setter, not an option
  // the constructor's callers already had to have.
  let staleRefresher = typeof onStale === 'function' ? onStale : null;
  const staleNotifiedAt = new Map();

  function readFileConfig() {
    if (!configFile) return {};
    try {
      const stat = fs.statSync(configFile);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.raw;
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      cached = { mtimeMs: stat.mtimeMs, raw: raw && typeof raw === 'object' ? raw : {} };
      return cached.raw;
    } catch (_) {
      // A missing or unreadable file is simply "no file config"; the defaults
      // and the environment still decide, and nothing here may throw into a turn.
      return {};
    }
  }

  let cachedConfig = null;

  function config() {
    const stamp = now();
    if (cachedConfig && stamp - cachedAt < CONFIG_CACHE_MS) return cachedConfig;
    cachedConfig = normalizeConfig({ ...readFileConfig(), ...envConfig(env) });
    cachedAt = stamp;
    return cachedConfig;
  }

  function appliesTo(providerId) {
    const settings = config();
    const id = clean(providerId);
    if (!id) return false;
    if (settings.scope === 'all') return true;
    return OFFICIAL_PROVIDER_RE.test(id);
  }

  function check({ appType, providerId } = {}) {
    const id = clean(providerId);
    if (!appliesTo(id)) return Object.freeze({ blocked: false, reason: 'scope_mismatch' });
    const settings = config();
    if (!settings.enabled) return Object.freeze({ blocked: false, reason: 'guard_disabled' });
    if (!cache || typeof cache.get !== 'function') return Object.freeze({ blocked: false, reason: 'no_cache' });
    const type = clean(appType) || id.split('-')[0] || 'claude';
    let entry = null;
    try { entry = cache.get(type, id); } catch (_) { entry = null; }
    const verdict = guardVerdict(entry, { config: settings, now: now() });
    if (verdict.blocked && logger && typeof logger.warn === 'function') {
      logger.warn('quota_guard_hold', {
        providerId: id,
        window: verdict.window,
        usedPercent: verdict.usedPercent,
        threshold: verdict.threshold,
        resetsAt: new Date(verdict.resetsAtMs).toISOString(),
      });
    }
    if (verdict.reason === 'stale_reading') {
      const stamp = now();
      if (stamp - (staleNotifiedAt.get(id) || 0) >= STALE_NOTIFY_MIN_INTERVAL_MS) {
        staleNotifiedAt.set(id, stamp);
        if (logger && typeof logger.info === 'function') {
          logger.info('quota_guard_stale_release', {
            providerId: id,
            window: verdict.window,
            usedPercent: verdict.usedPercent,
            readingAt: new Date(verdict.readingAtMs).toISOString(),
          });
        }
        if (staleRefresher) {
          try { Promise.resolve(staleRefresher(type, id)).catch(() => {}); } catch (_) { /* a re-read must never break a turn */ }
        }
      }
    }
    return verdict;
  }

  function setStaleRefresher(fn) {
    staleRefresher = typeof fn === 'function' ? fn : null;
  }

  return Object.freeze({ check, config, appliesTo, setStaleRefresher });
}

module.exports = {
  DEFAULTS,
  createQuotaGuard,
  envConfig,
  guardVerdict,
  liveWindows,
  normalizeConfig,
  readingAgeOf,
  thresholdFor,
  windowKind,
};
