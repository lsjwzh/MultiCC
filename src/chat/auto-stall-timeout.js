'use strict';

// Auto Provider only fails over when a physical attempt ERRORS. A silently
// stalled upstream never errors: the CLI's own stream idle timeout is measured
// in hundreds of seconds and then re-dials the same stalled line, so the pool
// never gets a turn. The host therefore gives every AUTO inference route its own
// idle budget and retires the attempt when the upstream goes quiet.
//
// Non-Auto sessions keep today's behaviour exactly: the budget is 0 (off), so
// no watchdog is ever armed for them.
const DEFAULT_AUTO_STALL_TIMEOUT_MS = 120_000;
const MIN_AUTO_STALL_TIMEOUT_MS = 15_000;
const MAX_AUTO_STALL_TIMEOUT_MS = 600_000;

function parseAutoStallTimeoutMs(value, fallback = DEFAULT_AUTO_STALL_TIMEOUT_MS) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number)) return fallback;
  const ms = Math.trunc(number);
  // An explicit zero or negative budget disables the watchdog; anything else is
  // clamped so a typo cannot retire a healthy line in seconds or hold a dead one
  // for an hour.
  if (ms <= 0) return 0;
  return Math.min(MAX_AUTO_STALL_TIMEOUT_MS, Math.max(MIN_AUTO_STALL_TIMEOUT_MS, ms));
}

function autoStallTimeoutFromEnv(env = process.env) {
  return parseAutoStallTimeoutMs(env && env.MULTICC_AUTO_STALL_TIMEOUT_MS);
}

function isAutoProviderSession(session) {
  const selection = session && session.providerSelection;
  return !!(selection && selection.mode === 'auto');
}

function resolveAutoStallTimeoutMs(session, env = process.env) {
  return isAutoProviderSession(session) ? autoStallTimeoutFromEnv(env) : 0;
}

module.exports = {
  DEFAULT_AUTO_STALL_TIMEOUT_MS,
  MAX_AUTO_STALL_TIMEOUT_MS,
  MIN_AUTO_STALL_TIMEOUT_MS,
  autoStallTimeoutFromEnv,
  isAutoProviderSession,
  parseAutoStallTimeoutMs,
  resolveAutoStallTimeoutMs,
};
