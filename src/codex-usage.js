'use strict';

const crypto = require('node:crypto');

const PRIVATE_USAGE_FIELDS = Object.freeze(['usageCumulative', 'usageEpoch']);

function tokenCount(value) {
  let numeric = value;
  if (typeof numeric === 'string' && /^\d+$/.test(numeric.trim())) numeric = Number(numeric.trim());
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function looksLikeCodexUsage(value) {
  return !!value && typeof value === 'object' && (
    Object.prototype.hasOwnProperty.call(value, 'cached_input_tokens')
    || Object.prototype.hasOwnProperty.call(value, 'reasoning_output_tokens')
  );
}

// MultiCC's Codex adapter exposes input_tokens as fresh input and keeps cached
// input in its own bucket. Older history can lack cache_read_input_tokens, in
// which case Codex's native input_tokens still includes the cached subset.
function normalizeCodexCumulative(value) {
  if (!value || typeof value !== 'object') return null;
  const cached = tokenCount(value.cache_read_input_tokens == null
    ? value.cached_input_tokens
    : value.cache_read_input_tokens);
  const input = tokenCount(value.input_tokens);
  const fresh = value.cache_read_input_tokens == null ? Math.max(0, input - cached) : input;
  return Object.freeze({
    fresh,
    cached,
    cacheWrite: tokenCount(value.cache_creation_input_tokens),
    output: tokenCount(value.output_tokens),
    reasoning: tokenCount(value.reasoning_output_tokens),
  });
}

function usageEpochForSessionId(cliSessionId) {
  const value = String(cliSessionId || '');
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function usageFromVector(vector, source = {}) {
  const usage = {
    ...source,
    input_tokens: vector.fresh,
    cached_input_tokens: vector.cached,
    cache_read_input_tokens: vector.cached,
    cache_creation_input_tokens: vector.cacheWrite,
    output_tokens: vector.output,
    reasoning_output_tokens: vector.reasoning,
    total_tokens: vector.fresh + vector.cached + vector.output,
  };
  return usage;
}

function monotonic(current, previous) {
  return current.fresh >= previous.fresh
    && current.cached >= previous.cached
    && current.cacheWrite >= previous.cacheWrite
    && current.output >= previous.output;
}

function subtract(current, previous) {
  return Object.freeze({
    fresh: current.fresh - previous.fresh,
    cached: current.cached - previous.cached,
    cacheWrite: current.cacheWrite - previous.cacheWrite,
    output: current.output - previous.output,
    // Reasoning is a subset of output. Some Codex releases reclassify it, so
    // its regression must not invalidate otherwise monotonic billable buckets.
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
  });
}

function lastCumulativeBaseline(history, epoch) {
  if (!Array.isArray(history)) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message || message.role !== 'assistant') continue;
    if (message.usageCumulative) {
      if (epoch && message.usageEpoch && message.usageEpoch !== epoch) continue;
      const usage = normalizeCodexCumulative(message.usageCumulative);
      if (usage) return usage;
      continue;
    }
    // Compatibility with history written before per-turn delta accounting.
    // The Codex-only keys avoid mistaking a Claude usage block for a baseline.
    if (looksLikeCodexUsage(message.usage)) return normalizeCodexCumulative(message.usage);
  }
  return null;
}

function normalizeCodexTurnUsage({ usage, history, cliSessionId } = {}) {
  const current = normalizeCodexCumulative(usage);
  if (!current) {
    return Object.freeze({ usage: {}, cumulativeUsage: null, usageEpoch: null, code: 'invalid' });
  }
  const usageEpoch = usageEpochForSessionId(cliSessionId);
  const previous = lastCumulativeBaseline(history, usageEpoch);
  if (!previous) {
    return Object.freeze({
      usage: usageFromVector(current, usage),
      cumulativeUsage: usageFromVector(current),
      usageEpoch,
      code: 'initial',
    });
  }
  if (!monotonic(current, previous)) {
    // A lower snapshot from the same native thread is stale/corrupt. Counting
    // it from zero would recreate the inflation bug, so retain the accepted
    // high-water and fail closed for this turn.
    const zero = subtract(previous, previous);
    return Object.freeze({
      usage: usageFromVector(zero, usage),
      cumulativeUsage: usageFromVector(previous),
      usageEpoch,
      code: 'regression',
    });
  }
  return Object.freeze({
    usage: usageFromVector(subtract(current, previous), usage),
    cumulativeUsage: usageFromVector(current),
    usageEpoch,
    code: 'delta',
  });
}

// Historical Codex messages contain cumulative snapshots in `usage`. Project
// them to per-message deltas for API/WS display without rewriting production
// history. New messages carry a private cumulative baseline and already store
// their public per-turn delta in `usage`.
//
// The projection is read-mostly: only assistant messages carrying Codex usage
// change, and only in their small `usage` / private-baseline fields — message
// content is never touched. Isolating the output with a whole-transcript deep
// clone (JSON.parse(JSON.stringify(messages))) therefore serialized megabytes of
// content to rewrite kilobytes of counters, and it ran on every history read:
// one GET /api/sessions/:id/history over a large transcript blocked the event
// loop for seconds, stalling every other request behind it. Copy on write
// instead — untouched messages pass through by reference and a message we must
// change is shallow-copied first — so the persisted history is still never
// mutated (pinned by tests/test-codex-usage.js).
function projectHistoryUsage(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const projected = new Array(source.length);
  const baselines = new Map();
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    projected[index] = message;
    if (!message || message.role !== 'assistant') continue;
    const explicitEpoch = message.usageEpoch || 'legacy';
    if (message.usageCumulative) {
      const cumulative = normalizeCodexCumulative(message.usageCumulative);
      if (cumulative) baselines.set(explicitEpoch, cumulative);
      const stripped = { ...message };
      for (const key of PRIVATE_USAGE_FIELDS) delete stripped[key];
      projected[index] = stripped;
      continue;
    }
    if (!looksLikeCodexUsage(message.usage)) continue;
    const current = normalizeCodexCumulative(message.usage);
    const previous = baselines.get(explicitEpoch);
    // Legacy history cannot prove native epoch changes. A vector regression is
    // treated as a new epoch for display, matching an actual CLI reset while
    // avoiding cross-message accumulation inside each monotonic run.
    const delta = previous && monotonic(current, previous)
      ? subtract(current, previous)
      : current;
    // usageFromVector always returns a fresh object, so this never aliases the
    // source message's usage.
    projected[index] = { ...message, usage: usageFromVector(delta, message.usage) };
    baselines.set(explicitEpoch, current);
  }
  return projected;
}

function summarizeHistoryUsage(messages) {
  const projected = projectHistoryUsage(messages);
  const total = {
    inputTokens: 0,
    consumedInputTokens: 0,
    freshInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    breakdownKnown: true,
    outputTokens: 0,
    turnCount: 0,
  };
  for (const message of projected) {
    const usage = message && message.role === 'assistant' && message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const fresh = tokenCount(usage.input_tokens);
    const read = tokenCount(usage.cache_read_input_tokens == null
      ? usage.cached_input_tokens
      : usage.cache_read_input_tokens);
    const write = tokenCount(usage.cache_creation_input_tokens);
    const output = tokenCount(usage.output_tokens);
    if (fresh + read + write + output === 0) continue;
    total.freshInputTokens += fresh;
    total.cacheReadTokens += read;
    total.cacheWriteTokens += write;
    total.outputTokens += output;
    total.turnCount += 1;
  }
  total.inputTokens = total.freshInputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  total.consumedInputTokens = total.inputTokens;
  return total;
}

function createCodexUsageHost(deps = {}) {
  for (const name of [
    'loadHistory', 'reconcileRole', 'clearIncrementalSave', 'persistFinalAssistantResult',
    'recordDurableTurnUsage', 'recordResultEvent', 'setSessionStatus',
  ]) {
    if (typeof deps[name] !== 'function') throw new TypeError(`Codex usage host missing: ${name}`);
  }
  const logger = deps.logger || console;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;

  function complete({ evt, cs, persisted, sessionName, turn, runner, forward }) {
    if (typeof forward !== 'function') throw new TypeError('Codex usage host missing: forward');
    // Claude's result path already cancels this crash-safety timer. Codex must
    // do the same before persisting its final message, otherwise the stale
    // callback writes the cumulative answer again as `_interim` about 5s later.
    deps.clearIncrementalSave(sessionName);
    cs.currentCost = evt.cost == null ? null : evt.cost;
    const normalized = normalizeCodexTurnUsage({
      usage: evt.usage || {},
      history: deps.loadHistory(sessionName),
      cliSessionId: persisted.cliSessionId,
    });
    const usage = normalized.usage;
    if (normalized.code === 'regression' && logger && typeof logger.warn === 'function') {
      logger.warn('codex_usage_cumulative_regression', { sessionId: sessionName });
    }
    runner.pendingUsage = usage;
    deps.reconcileRole(sessionName, usage, runner.usageAttribution || {});
    if (cs.currentAssistantText || cs.currentToolCalls.length) {
      const durable = deps.persistFinalAssistantResult(sessionName, cs, turn, runner, {
        role: 'assistant',
        content: cs.currentAssistantText,
        tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
        cost: cs.currentCost,
        usage,
        ...(normalized.cumulativeUsage ? { usageCumulative: normalized.cumulativeUsage } : {}),
        ...(normalized.usageEpoch ? { usageEpoch: normalized.usageEpoch } : {}),
        ts: now(),
      }, { resultEvent: true });
      if (durable) {
        deps.recordDurableTurnUsage(sessionName, runner, usage);
        cs.chatTurnCount += 1;
      }
    } else {
      deps.recordResultEvent(turn, runner, { current: true, persisted: false });
    }
    forward({
      type: 'result',
      total_cost_usd: cs.currentCost,
      usage,
      durationMs: cs.turnStartedAt ? now() - cs.turnStartedAt : undefined,
      num_turns: cs.chatTurnCount,
    });
    deps.setSessionStatus(sessionName, {
      status: cs._resultSaved ? 'succeeded' : 'idle',
      currentFile: null,
    });
    return normalized;
  }

  return Object.freeze({ complete });
}

module.exports = {
  createCodexUsageHost,
  looksLikeCodexUsage,
  normalizeCodexCumulative,
  normalizeCodexTurnUsage,
  projectHistoryUsage,
  summarizeHistoryUsage,
  usageEpochForSessionId,
};
