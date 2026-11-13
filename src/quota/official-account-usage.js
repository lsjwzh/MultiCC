'use strict';
// Keeps per-account official usage fresh in the provider-limit cache.
//
// Only Codex is swept. Claude was swept here too (the same vendor poll every ten
// minutes, plus a first tick right after boot), and that is deliberately gone: a
// Claude reading now comes from the passive rate-limit event of a live turn, or
// from the user's own ⟳ (see quota/claude-usage-queue.js) — never from a poll the
// user did not ask for. Nothing in this file queries the Claude usage endpoint.
//
// Codex accounts are still swept because each is its own provider
// (`codex-official-<accountId>`, see providers/official-catalog.js) and an Auto
// pool may hold several of them. The passive rate-limit header only describes
// the account that is serving the turn, so without a sweep the idle accounts
// never have usage data and Auto cannot tell which one has headroom. It runs
// only when a vendor has two or more signed-in accounts — one account has
// nothing to choose between. The poll is the same weekly-window read the
// turn-end poller runs, but against the account's own auth.json.

const { pollCodexUsage } = require('../usage-limit-poller');
const { accountProviderId } = require('../providers/official-catalog');

const DEFAULT_INTERVAL_MS = 10 * 60_000;
// The Claude OAuth body → window rows map. The sweeper no longer uses it; it
// stays here because the manual per-account read (routes/claude-accounts.js,
// wired in server.js) records what the user asked for under the same shape.
const CLAUDE_WINDOWS = Object.freeze([
  { key: 'five_hour', window: '5h', label: 'Current session' },
  { key: 'seven_day', window: '7d', label: 'Weekly' },
]);

function claudeUsageWindows(usage) {
  if (!usage || typeof usage !== 'object') return [];
  const rows = [];
  for (const spec of CLAUDE_WINDOWS) {
    const w = usage[spec.key];
    if (!w || w.utilization == null) continue;
    const pct = Number(w.utilization);
    if (!Number.isFinite(pct)) continue;
    const reset = w.resets_at ? Date.parse(w.resets_at) : NaN;
    rows.push({
      window: spec.window,
      label: spec.label,
      usedPercent: Math.max(0, Math.min(100, pct)),
      resetMs: Number.isFinite(reset) ? reset : null,
    });
  }
  return rows;
}

function codexDtoWindows(dto) {
  if (!dto || typeof dto !== 'object' || !Number.isFinite(Number(dto.utilization))) return [];
  // The usage read reports every cycle (5h and week on most plans); keep them all.
  if (Array.isArray(dto.windows) && dto.windows.length) {
    return dto.windows.filter(w => w && Number.isFinite(Number(w.usedPercent))).map(w => ({
      window: w.window === '1wk' ? '7d' : w.window,
      label: w.window === '5h' ? 'Current session' : w.window === '1wk' ? 'Weekly' : 'Monthly',
      usedPercent: Math.max(0, Math.min(100, Number(w.usedPercent))),
      resetMs: Number.isFinite(Number(w.resetMs)) && w.resetMs != null ? Number(w.resetMs) : null,
    }));
  }
  const reset = Number(dto.resetsAt);
  return [{
    window: '7d',
    label: 'Weekly',
    usedPercent: Math.max(0, Math.min(100, Number(dto.utilization) * 100)),
    resetMs: Number.isFinite(reset) ? (reset < 1e12 ? reset * 1000 : reset) : null,
  }];
}

function createOfficialAccountUsageSweeper({
  accounts, recorder, logger = console,
  intervalMs = DEFAULT_INTERVAL_MS, now = Date.now, pollCodex = pollCodexUsage,
} = {}) {
  if (!accounts || !recorder) throw new TypeError('[official-account-usage] requires { accounts, recorder }');
  // accountKey → epoch ms before which this account must not be polled (429 /
  // revoked credential backoff), so a throttled account is not hammered.
  const blockedUntil = new Map();
  let timer = null;
  let running = null;

  const signedIn = list => (Array.isArray(list) ? list : []).filter(a => a && a.loggedIn);

  async function sweepCodex(account) {
    if (typeof accounts.codexDir !== 'function') return false;
    const path = require('node:path');
    const dto = await pollCodex({ authFile: path.join(accounts.codexDir(account.id), 'auth.json') }, now());
    const windows = codexDtoWindows(dto);
    if (!windows.length) return false;
    await recorder.recordOfficialWindows('codex', accountProviderId('codex', account.id), { windows, fetchedAt: now() });
    return true;
  }

  async function sweepOnce({ force = false } = {}) {
    const list = typeof accounts.listCodexAccounts === 'function' ? signedIn(accounts.listCodexAccounts()) : [];
    if (!force && list.length < 2) return 0;
    let recorded = 0;
    for (const account of list) {
      const key = `codex:${account.id}`;
      if ((blockedUntil.get(key) || 0) > now()) continue;
      try {
        if (await sweepCodex(account)) recorded++;
      } catch (error) {
        const status = error && error.status;
        const backoff = status === 429 ? Math.max(Number(error.retryAfterMs) || 0, intervalMs)
          : status === 401 ? 6 * intervalMs : 0;
        if (backoff) blockedUntil.set(key, now() + backoff);
        logger.warn && logger.warn(`[official-account-usage] codex ${account.id} poll failed: ${(error && error.message) || error}`);
      }
    }
    return recorded;
  }

  function tick() {
    if (running) return running;
    running = sweepOnce().catch(() => 0).finally(() => { running = null; });
    return running;
  }

  return Object.freeze({
    sweepOnce,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
      setTimeout(tick, 30_000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  });
}

module.exports = { createOfficialAccountUsageSweeper, claudeUsageWindows, codexDtoWindows };
