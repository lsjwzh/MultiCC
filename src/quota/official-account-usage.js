'use strict';
// Keeps per-account official usage fresh in the provider-limit cache.
//
// Every signed-in official account is its own provider
// (`<type>-official-<accountId>`, see providers/official-catalog.js), and an
// Auto pool may hold several of them. The passive rate-limit headers only
// describe the account that is serving the turn, so without a sweep the idle
// accounts never have usage data and Auto cannot tell which one has headroom.
// This sweeper polls each signed-in account at a slow cadence — only when a
// vendor has two or more accounts, since one account has nothing to choose
// between — and records the windows under that account's provider id.
//
// Claude: OAuth usage endpoint → { five_hour, seven_day } with a 0..100
// `utilization` (measured live, see routes/claude-usage-quota.js SCALE note).
// Codex: the same weekly-window poll the turn-end poller runs, but against the
// account's own auth.json.

const { fetchUsage } = require('../claude-auth/official-oauth');
const { pollCodexUsage } = require('../usage-limit-poller');
const { accountProviderId } = require('../providers/official-catalog');

const DEFAULT_INTERVAL_MS = 10 * 60_000;
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
  accounts, credentials, recorder, fetchImpl = globalThis.fetch, logger = console,
  intervalMs = DEFAULT_INTERVAL_MS, now = Date.now, pollCodex = pollCodexUsage, readClaudeUsage = fetchUsage,
} = {}) {
  if (!accounts || !recorder) throw new TypeError('[official-account-usage] requires { accounts, recorder }');
  // accountKey → epoch ms before which this account must not be polled (429 /
  // revoked credential backoff), so a throttled account is not hammered.
  const blockedUntil = new Map();
  let timer = null;
  let running = null;

  const signedIn = list => (Array.isArray(list) ? list : []).filter(a => a && a.loggedIn);

  async function sweepClaude(account) {
    if (!credentials || typeof credentials.readAccountToken !== 'function') return false;
    const cred = await credentials.readAccountToken(account.id);
    if (!cred || !cred.token) return false;
    const usage = await readClaudeUsage(fetchImpl, cred.token);
    const windows = claudeUsageWindows(usage);
    if (!windows.length) return false;
    recorder.recordOfficialWindows('claude', accountProviderId('claude', account.id), { windows, fetchedAt: now() });
    return true;
  }

  async function sweepCodex(account) {
    if (typeof accounts.codexDir !== 'function') return false;
    const path = require('node:path');
    const dto = await pollCodex({ authFile: path.join(accounts.codexDir(account.id), 'auth.json') }, now());
    const windows = codexDtoWindows(dto);
    if (!windows.length) return false;
    recorder.recordOfficialWindows('codex', accountProviderId('codex', account.id), { windows, fetchedAt: now() });
    return true;
  }

  async function sweepOnce({ force = false } = {}) {
    const jobs = [
      ['claude', typeof accounts.listClaudeAccounts === 'function' ? signedIn(accounts.listClaudeAccounts()) : [], sweepClaude],
      ['codex', typeof accounts.listCodexAccounts === 'function' ? signedIn(accounts.listCodexAccounts()) : [], sweepCodex],
    ];
    let recorded = 0;
    for (const [vendor, list, sweep] of jobs) {
      if (!force && list.length < 2) continue;
      for (const account of list) {
        const key = `${vendor}:${account.id}`;
        if ((blockedUntil.get(key) || 0) > now()) continue;
        try {
          if (await sweep(account)) recorded++;
        } catch (error) {
          const status = error && error.status;
          const backoff = status === 429 ? Math.max(Number(error.retryAfterMs) || 0, intervalMs)
            : status === 401 ? 6 * intervalMs : 0;
          if (backoff) blockedUntil.set(key, now() + backoff);
          logger.warn && logger.warn(`[official-account-usage] ${vendor} ${account.id} poll failed: ${(error && error.message) || error}`);
        }
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
