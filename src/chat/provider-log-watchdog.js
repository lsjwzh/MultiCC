'use strict';

// Provider-log error watchdog.
//
// Some CLIs (opencode) swallow provider stream errors: the quota/auth/billing
// failure is written only to the CLI's own log file — no stdout JSON event,
// empty stderr, and the process never exits. The turn then sits in `starting`
// forever because multicc only learns about errors from the stdout event path.
//
// Authoritative-source investigation (2026-08-14 incident, ses_018ecb7d…):
//  • opencode.db (SQLite message/part/event tables) never records the error.
//  • stderr is empty; the stdout `error` event decode path never fires.
//  • ~/.local/share/opencode/log/opencode.log carries `level=ERROR` lines with
//    both `session.id=<native session>` and the full error text.
// So a narrow, session/run-correlated tail scan of that log is the narrowest
// regressable source. Naive global tailing is forbidden by design: every hit
// must match THIS session's native session id (or, on a first turn where the
// native id is not allocated yet, the run id of an instance created from this
// session's cwd inside the current turn window).
//
// On a correlated ERROR the watchdog surfaces one sanitized chat error event
// and ends the turn through the same cancel machinery the stop button uses,
// which kills the wedged child and releases the scheduler slot.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeMessage } = require('./api-error-policy');

const DEFAULT_INTERVAL_MS = 10_000;
// A scan only starts after the turn has been this silent — but silence alone
// never triggers an action; a correlated ERROR line is the sole trigger.
const DEFAULT_MIN_SILENCE_MS = 20_000;
const DEFAULT_TAIL_BYTES = 512 * 1024;
// Log timestamps come from the CLI's own clock; tolerate a small skew when
// matching lines to the current turn window.
const CLOCK_SKEW_MS = 5_000;
// First-turn directory correlation only counts instance creations inside
// [turnStart - 10s, now].
const DIR_MATCH_PRE_MS = 10_000;

const DEFAULT_LOG_PATH = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'opencode', 'log', 'opencode.log',
);

// Long-token redaction in sanitizeMessage would mangle the action URL inside
// quota messages ("…wrk_01KWCDPN…/go" reads as an id). Preserve URLs verbatim:
// they are the provider's own safe action links and the user needs them.
const URL_RE = /https?:\/\/[^\s"']+/g;

function sanitizeWithUrls(rawMessage) {
  const raw = String(rawMessage || '').trim();
  if (!raw) return '';
  const urls = [];
  const masked = raw.replace(URL_RE, match => {
    urls.push(match);
    return `\u0000URL${urls.length - 1}\u0000`;
  });
  let sanitized = sanitizeMessage(masked, '');
  sanitized = sanitized.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] || '');
  return sanitized.trim();
}

function parseLine(line) {
  if (!line || line.indexOf('timestamp=') !== 0) return null;
  const tsMatch = /^timestamp=(\S+)/.exec(line);
  const timestamp = Date.parse(tsMatch ? tsMatch[1] : '');
  const levelMatch = /level=(\S+)/.exec(line);
  return {
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    level: levelMatch ? levelMatch[1] : '',
    run: (/ run=(\S+)/.exec(line) || [])[1] || '',
    sessionId: (/ session\.id=(\S+)/.exec(line) || [])[1] || '',
    directory: (/ directory=("[^"]*"|\S+)/.exec(line) || [])[1]?.replace(/^"|"$/g, '') || '',
    message: (/ message=("[^"]*"|\S+)/.exec(line) || [])[1]?.replace(/^"|"$/g, '') || '',
    line,
  };
}

// Extract the provider error text from an ERROR line. Quoted values may embed
// escaped quotes; unquoted values run to the next space.
function extractErrorText(line) {
  const quoted = / error\.error="((?:[^"\\]|\\.)*)"/.exec(line);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const plain = / error\.error=(\S+)/.exec(line);
  if (plain) return plain[1];
  return '';
}

function readLogTail(logPath, tailBytes) {
  let stat;
  try { stat = fs.statSync(logPath); } catch (_) { return ''; }
  const size = Math.min(stat.size, tailBytes);
  const fd = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    const text = buffer.toString('utf8');
    // Drop the first (likely partial) line unless we read the whole file.
    return stat.size <= tailBytes ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function createProviderLogWatchdog(deps = {}) {
  for (const name of ['listRecords', 'getChatSession', 'broadcast', 'cancelTurn']) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`[provider-log-watchdog] ${name} must be a function`);
    }
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const intervalMs = Math.max(1000, Number(deps.intervalMs) || DEFAULT_INTERVAL_MS);
  const minSilenceMs = Math.max(0, Number(deps.minSilenceMs) || DEFAULT_MIN_SILENCE_MS);
  const tailBytes = Math.max(16 * 1024, Number(deps.tailBytes) || DEFAULT_TAIL_BYTES);
  const readTail = typeof deps.readLogTail === 'function'
    ? deps.readLogTail
    : (logPath, bytes) => readLogTail(logPath, bytes);
  const providers = Object.freeze({
    opencode: Object.freeze({
      label: 'OpenCode',
      logPath: () => process.env.MULTICC_OPENCODE_LOG_PATH || DEFAULT_LOG_PATH,
    }),
  });
  const logger = deps.logger || console;
  // sessionId -> { turnKey, message } of the error already surfaced this turn.
  const surfaced = new Map();
  let sweeping = false;

  function turnKeyOf(cs) {
    return (cs._activeTurn && cs._activeTurn.turnId) || String(cs.turnStartedAt || '');
  }

  function correlatedErrorFor(tail, { nativeSessionId, cwd, sinceMs, atMs }) {
    const lines = tail.split('\n');
    const dirRuns = new Set();
    let best = null;
    for (const raw of lines) {
      const entry = parseLine(raw);
      if (!entry || entry.timestamp < sinceMs - CLOCK_SKEW_MS || entry.timestamp > atMs + CLOCK_SKEW_MS) continue;
      if (entry.level !== 'ERROR') {
        // First-turn correlation: the native session id is only allocated by a
        // stdout event we never received, so fall back to the run that created
        // an instance from this session's cwd inside the turn window.
        if (!nativeSessionId && cwd && entry.directory === cwd
          && entry.timestamp >= sinceMs - DIR_MATCH_PRE_MS
          && (entry.message === 'creating instance' || entry.message === 'fromDirectory')) {
          if (entry.run) dirRuns.add(entry.run);
        }
        continue;
      }
      const text = extractErrorText(raw) || entry.message;
      if (!text) continue;
      const matches = nativeSessionId
        ? entry.sessionId === nativeSessionId
        : !!entry.run && dirRuns.has(entry.run);
      if (!matches) continue;
      if (!best || entry.timestamp >= best.timestamp) {
        best = { timestamp: entry.timestamp, text, run: entry.run, sessionId: entry.sessionId };
      }
    }
    return best;
  }

  async function inspect(sessionId, record, at) {
    const provider = providers[record.cli];
    if (!provider) return { sessionId, action: 'skip', reason: 'not_watched_cli' };
    const cs = deps.getChatSession(sessionId);
    if (!cs || !cs.isStreaming) return { sessionId, action: 'skip', reason: 'not_streaming' };
    // Own-turn dedup first: a repeat sweep of an already-surfaced turn stops
    // here even though _adapterError is now set.
    const turnKey = turnKeyOf(cs);
    const prior = surfaced.get(sessionId);
    if (prior && prior.turnKey === turnKey) {
      return { sessionId, action: 'skip', reason: 'already_surfaced' };
    }
    // The stdout error path already owns the display — never double-fire.
    if (cs._adapterError) return { sessionId, action: 'skip', reason: 'adapter_error_present' };
    const sinceMs = Number(cs.turnStartedAt || cs.lastStreamAt || 0);
    if (!sinceMs) return { sessionId, action: 'skip', reason: 'no_turn_baseline' };
    if (at - (Number(cs.lastStreamAt) || sinceMs) < minSilenceMs) {
      return { sessionId, action: 'skip', reason: 'active_stream' };
    }
    const nativeSessionId = record.cliSessionId || '';
    if (!nativeSessionId && !cs.cwd) {
      return { sessionId, action: 'skip', reason: 'no_correlation_key' };
    }
    const tail = readTail(provider.logPath(), tailBytes);
    if (!tail) return { sessionId, action: 'skip', reason: 'log_unavailable' };
    const hit = correlatedErrorFor(tail, { nativeSessionId, cwd: cs.cwd || '', sinceMs, atMs: at });
    if (!hit) return { sessionId, action: 'clean', reason: 'no_correlated_error' };

    const sanitized = sanitizeWithUrls(hit.text);
    if (!sanitized) return { sessionId, action: 'skip', reason: 'unusable_error_text' };
    surfaced.set(sessionId, { turnKey, message: sanitized });

    // Mirror the stdout error path's flags so close-time classification and
    // retry policy treat this exactly like a provider error event.
    cs._adapterError = sanitized;
    const runner = cs._activeRunner;
    if (runner) {
      runner.sawApiError = true;
      runner.adapterError = sanitized;
      runner.apiErrorRaw = {
        source: `${record.cli}_log`,
        provider: record.provider || record.cli,
        code: 'provider_log_error',
        message: hit.text,
      };
    }
    const evt = { type: 'error', error: `${provider.label} 出错：${sanitized}` };
    try {
      if (Array.isArray(cs.streamReplay)) {
        cs.streamReplay.push(evt);
        if (cs.streamReplay.length > 500) cs.streamReplay.shift();
      }
    } catch (_) {}
    deps.broadcast(sessionId, evt);
    logger.warn('provider_log_error_surfaced', {
      sessionId, provider: record.cli, run: hit.run || null,
      nativeSession: hit.sessionId || null, correlation: nativeSessionId ? 'session' : 'directory_run',
    });
    // End the turn deterministically: kill the wedged child, classify E,
    // release the scheduler slot. Same machinery as the UI stop button, which
    // is proven safe for scheduler-bypassed (cron) turns too.
    let cancel;
    try {
      cancel = await deps.cancelTurn(sessionId, {
        reason: 'provider_log_error',
        killReason: 'provider_log_error',
        source: `${record.cli}_log_watchdog`,
      });
    } catch (error) {
      logger.warn('provider_log_error_cancel_failed', { sessionId, error: error?.message || String(error) });
      return { sessionId, action: 'surfaced_cancel_failed', reason: 'cancel_error' };
    }
    return { sessionId, action: 'surfaced_and_cancelled', reason: 'correlated_error', cancel };
  }

  async function sweep() {
    if (sweeping) return { ok: false, code: 'sweep_in_progress', results: [] };
    sweeping = true;
    const at = now();
    const results = [];
    try {
      for (const [sessionId, record] of deps.listRecords()) {
        if (!record || record.kind !== 'chat' || record.type === 'aux' || record.type === 'gateway') continue;
        try {
          results.push(await inspect(sessionId, record, at));
        } catch (error) {
          logger.warn?.('provider_log_watchdog_session_failed', {
            sessionId, error: error?.message || String(error),
          });
          results.push({ sessionId, action: 'error', reason: 'inspection_failed' });
        }
      }
      return { ok: true, results };
    } finally {
      sweeping = false;
    }
  }

  return Object.freeze({ sweep, inspect, PROVIDER_LOG_WATCHDOG_INTERVAL_MS: intervalMs });
}

module.exports = {
  createProviderLogWatchdog,
  sanitizeWithUrls,
  extractErrorText,
  PROVIDER_LOG_WATCHDOG_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  PROVIDER_LOG_WATCHDOG_MIN_SILENCE_MS: DEFAULT_MIN_SILENCE_MS,
};
