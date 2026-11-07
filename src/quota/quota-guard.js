'use strict';

// Transitional host adapter: Rust owns quota policy, file/config caching and
// refresh throttling. Node retains access to the existing provider cache,
// logger and refresh callback until those host lifecycles move to Rust.
const { getNative } = require('../native/runtime');
const request = (op, input) => getNative().quotaGuardRequestValue(op, input);
const DEFAULTS = Object.freeze(request('defaults', null));
const envConfig = (env = process.env) => request('envConfig', env);
const normalizeConfig = raw => Object.freeze(request('normalizeConfig', raw));
const readingAgeOf = value => request('readingAgeOf', value);
const windowKind = value => request('windowKind', value);
const thresholdFor = (kind, config) => request('thresholdFor', { kind, config });
const liveWindows = entry => request('liveWindows', entry);
const guardVerdict = (entry, { config = DEFAULTS, now = Date.now() } = {}) =>
  Object.freeze(request('guardVerdict', { entry, config, now }));
const clean = value => value == null ? '' : String(value).trim();

function createQuotaGuard({
  cache, configFile = null, env = process.env, now = Date.now, logger = null,
  onStale = null,
} = {}) {
  const native = new (getNative().RustQuotaGuard)(configFile || undefined);
  let staleRefresher = typeof onStale === 'function' ? onStale : null;
  const config = () => Object.freeze(native.config(env, now()));
  const appliesTo = providerId => request('appliesTo', { providerId, config: config() });

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
      if (native.shouldRefresh(id, stamp)) {
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
  DEFAULTS, createQuotaGuard, envConfig, guardVerdict, liveWindows,
  normalizeConfig, readingAgeOf, thresholdFor, windowKind,
};
