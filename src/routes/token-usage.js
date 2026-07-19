'use strict';

const { projectHistoryUsage } = require('../codex-usage');

const EMPTY_ROLE_SNAPSHOT = Object.freeze({
  main: null,
  sub: null,
  subByProvider: Object.freeze([]),
});

const PUBLIC_USAGE_ERROR = 'Token usage is temporarily unavailable';
// Preserve every finite safe upstream count. Long Codex sessions and their
// subagents can legitimately report very large cumulative cache reads, so
// large-but-valid values are diagnosed rather than silently discarded.
const MAX_EVENT_TOKENS = Number.MAX_SAFE_INTEGER;
const LARGE_EVENT_TOKEN_THRESHOLD = 100_000_000;

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`token usage dependency missing: ${name}`);
  }
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('token usage dependencies are required');
  }
  if (!deps.fs || typeof deps.fs.readFileSync !== 'function') {
    throw new TypeError('token usage dependency missing: fs.readFileSync');
  }
  assertFunction(deps.atomicWriteJson, 'atomicWriteJson');
  assertFunction(deps.getGlobalUsage, 'getGlobalUsage');
  assertFunction(deps.readProviderWindows, 'readProviderWindows');
  assertFunction(deps.getProviderSummary, 'getProviderSummary');
  assertFunction(deps.getEffectiveSessionModel, 'getEffectiveSessionModel');
  assertFunction(deps.broadcast, 'broadcast');
  if (!deps.persistedSessions || typeof deps.persistedSessions.get !== 'function') {
    throw new TypeError('token usage dependency missing: persistedSessions');
  }
  if (!deps.chatHistoryRepository
      || typeof deps.chatHistoryRepository.listSessionIds !== 'function'
      || typeof deps.chatHistoryRepository.readStrict !== 'function') {
    throw new TypeError('token usage dependency missing: chatHistoryRepository');
  }
  const trackerMethods = ['accumulate', 'accumulateObserved', 'snapshot', 'reset', 'readLedger'];
  for (const name of trackerMethods) {
    if (!deps.roleTokenTracker || typeof deps.roleTokenTracker[name] !== 'function') {
      throw new TypeError(`token usage dependency missing: roleTokenTracker.${name}`);
    }
  }
  if (typeof deps.tokenUsageFile !== 'string' || !deps.tokenUsageFile) {
    throw new TypeError('token usage dependency missing: tokenUsageFile');
  }
  if (typeof deps.tokenDailyFile !== 'string' || !deps.tokenDailyFile) {
    throw new TypeError('token usage dependency missing: tokenDailyFile');
  }
  return deps;
}

function tokenCount(value, max = Number.MAX_SAFE_INTEGER) {
  let numeric = value;
  if (typeof numeric === 'string' && /^\d+$/.test(numeric.trim())) {
    numeric = Number(numeric.trim());
  }
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > max) return 0;
  return numeric;
}

function eventTokenCount(value) {
  return tokenCount(value, MAX_EVENT_TOKENS);
}

function usageComponents(usage) {
  const value = usage || {};
  const freshInputTokens = eventTokenCount(value.input_tokens);
  const cacheReadTokens = eventTokenCount(value.cache_read_input_tokens);
  const cacheWriteTokens = eventTokenCount(value.cache_creation_input_tokens);
  return {
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    consumedInputTokens: freshInputTokens + cacheReadTokens + cacheWriteTokens,
    outputTokens: eventTokenCount(value.output_tokens),
  };
}

function aggregateBucket(value) {
  const bucket = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const inputTokens = tokenCount(bucket.consumedInputTokens == null
    ? bucket.inputTokens
    : bucket.consumedInputTokens);
  const hasBreakdown = typeof bucket.breakdownKnown === 'boolean'
    ? bucket.breakdownKnown
    : ['freshInputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .some(key => Object.prototype.hasOwnProperty.call(bucket, key));
  return {
    ...bucket,
    inputTokens,
    consumedInputTokens: inputTokens,
    freshInputTokens: tokenCount(bucket.freshInputTokens),
    cacheReadTokens: tokenCount(bucket.cacheReadTokens),
    cacheWriteTokens: tokenCount(bucket.cacheWriteTokens),
    breakdownKnown: hasBreakdown,
    outputTokens: tokenCount(bucket.outputTokens),
    turnCount: tokenCount(bucket.turnCount),
  };
}

function normalizeUsageLedger(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [sessionId, bucket] of Object.entries(source)) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    normalized[sessionId] = aggregateBucket(bucket);
  }
  return normalized;
}

function normalizeWindowBucket(value) {
  const bucket = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = { ...bucket };
  for (const key of [
    'inputTokens', 'consumedInputTokens', 'freshInputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'turnCount',
  ]) {
    if (Object.prototype.hasOwnProperty.call(bucket, key)) normalized[key] = tokenCount(bucket[key]);
  }
  if (normalized.consumedInputTokens == null && normalized.inputTokens != null) {
    normalized.consumedInputTokens = normalized.inputTokens;
  }
  if (normalized.inputTokens == null && normalized.consumedInputTokens != null) {
    normalized.inputTokens = normalized.consumedInputTokens;
  }
  return normalized;
}

function consumedInput(usage) {
  return usageComponents(usage).consumedInputTokens;
}

function hasLegacyUsage(usage) {
  return !!usage && consumedInput(usage) + eventTokenCount(usage.output_tokens) > 0;
}

function localDateKey(date) {
  return date.getFullYear() + '-'
    + String(date.getMonth() + 1).padStart(2, '0') + '-'
    + String(date.getDate()).padStart(2, '0');
}

function errorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN';
}

function createTokenUsageRoutes(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const fs = deps.fs;
  const logger = deps.logger || console;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();

  function logFailure(event, error) {
    const detail = { code: errorCode(error) };
    if (logger && typeof logger.error === 'function') logger.error(event, detail);
  }

  function diagnoseLargeEvent(sessionId, parts) {
    if (parts.consumedInputTokens <= LARGE_EVENT_TOKEN_THRESHOLD) return;
    const detail = {
      sessionId: String(sessionId).slice(0, 128),
      consumedInputTokens: parts.consumedInputTokens,
      freshInputTokens: parts.freshInputTokens,
      cacheReadTokens: parts.cacheReadTokens,
      cacheWriteTokens: parts.cacheWriteTokens,
    };
    if (logger && typeof logger.warn === 'function') logger.warn('token_usage_large_event', detail);
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return fallback;
    }
  }

  function readObject(file) {
    const value = readJson(file, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function getTokenUsage() {
    return normalizeUsageLedger(readJson(deps.tokenUsageFile, {}));
  }

  function accumulateTokenDaily(sessionId, usage) {
    const parts = usageComponents(usage);
    const inputTokens = parts.consumedInputTokens;
    const outputTokens = parts.outputTokens;
    if (inputTokens + outputTokens === 0) return true;

    const persisted = deps.persistedSessions.get(sessionId);
    const providerId = (persisted && persisted.provider) || '_default_';
    const date = now();
    const dateKey = localDateKey(date instanceof Date ? date : new Date(date));
    const daily = readObject(deps.tokenDailyFile);
    const storedDay = daily[dateKey];
    const day = storedDay && typeof storedDay === 'object' && !Array.isArray(storedDay)
      ? storedDay
      : {};
    const provider = aggregateBucket(day[providerId]);
    provider.inputTokens += inputTokens;
    provider.consumedInputTokens = provider.inputTokens;
    provider.freshInputTokens += parts.freshInputTokens;
    provider.cacheReadTokens += parts.cacheReadTokens;
    provider.cacheWriteTokens += parts.cacheWriteTokens;
    provider.breakdownKnown = true;
    provider.outputTokens += outputTokens;
    provider.turnCount += 1;
    day[providerId] = provider;
    daily[dateKey] = day;

    try {
      deps.atomicWriteJson(deps.tokenDailyFile, daily);
      return true;
    } catch (error) {
      logFailure('token_daily_write_failed', error);
      return false;
    }
  }

  function accumulateTokenUsage(sessionId, usage) {
    if (!hasLegacyUsage(usage)) return true;
    const parts = usageComponents(usage);
    diagnoseLargeEvent(sessionId, parts);
    const data = normalizeUsageLedger(readObject(deps.tokenUsageFile));
    const current = aggregateBucket(data[sessionId]);
    current.inputTokens += parts.consumedInputTokens;
    current.consumedInputTokens = current.inputTokens;
    current.freshInputTokens += parts.freshInputTokens;
    current.cacheReadTokens += parts.cacheReadTokens;
    current.cacheWriteTokens += parts.cacheWriteTokens;
    current.breakdownKnown = true;
    current.outputTokens += parts.outputTokens;
    current.turnCount += 1;
    const persisted = deps.persistedSessions.get(sessionId);
    const providerId = (persisted && persisted.provider) || '_default_';
    const byProvider = current.byProvider && typeof current.byProvider === 'object'
      && !Array.isArray(current.byProvider) ? current.byProvider : {};
    const provider = aggregateBucket(byProvider[providerId]);
    provider.inputTokens += parts.consumedInputTokens;
    provider.consumedInputTokens = provider.inputTokens;
    provider.freshInputTokens += parts.freshInputTokens;
    provider.cacheReadTokens += parts.cacheReadTokens;
    provider.cacheWriteTokens += parts.cacheWriteTokens;
    provider.breakdownKnown = true;
    provider.outputTokens += parts.outputTokens;
    provider.turnCount += 1;
    current.byProvider = { ...byProvider, [providerId]: provider };
    data[sessionId] = current;
    try {
      deps.atomicWriteJson(deps.tokenUsageFile, data);
    } catch (error) {
      logFailure('token_usage_write_failed', error);
      return false;
    }

    // The cumulative total is the durable commit. The derived day/provider
    // index deliberately remains best-effort, matching the established host
    // ordering used by chat result persistence.
    accumulateTokenDaily(sessionId, usage);
    return true;
  }

  function seedTokenUsageFromHistory() {
    const accumulated = readObject(deps.tokenUsageFile);
    let sessionIds;
    try {
      sessionIds = deps.chatHistoryRepository.listSessionIds();
    } catch (error) {
      logFailure('token_usage_seed_list_failed', error);
      return { seeded: 0, persisted: false };
    }

    let seeded = 0;
    for (const sessionId of sessionIds) {
      if (sessionId === '__aux__' || sessionId === '__gateway__' || accumulated[sessionId]) continue;
      try {
        const messages = projectHistoryUsage(deps.chatHistoryRepository.readStrict(sessionId));
        let inputTokens = 0;
        let outputTokens = 0;
        let turnCount = 0;
        for (const message of messages) {
          const usage = message && message.usage;
          if (!usage) continue;
          const hasInput = tokenCount(usage.input_tokens, MAX_EVENT_TOKENS)
            || usage.input_tokens === 0 || usage.input_tokens === '0';
          const hasOutput = tokenCount(usage.output_tokens, MAX_EVENT_TOKENS)
            || usage.output_tokens === 0 || usage.output_tokens === '0';
          if (!hasInput && !hasOutput) continue;
          // Historical seeding intentionally preserves the old input/output
          // DTO. Cache buckets were not retained consistently in old history,
          // so inferring consumed input here would inflate only some sessions.
          inputTokens += eventTokenCount(usage.input_tokens);
          outputTokens += eventTokenCount(usage.output_tokens);
          turnCount += 1;
        }
        if (turnCount > 0) {
          accumulated[sessionId] = { inputTokens, outputTokens, turnCount };
          seeded += 1;
        }
      } catch (_) {
        // One malformed history must not prevent the remaining sessions from
        // being migrated. No path or message content is emitted to logs.
      }
    }

    if (seeded === 0) return { seeded: 0, persisted: true };
    try {
      deps.atomicWriteJson(deps.tokenUsageFile, accumulated);
      if (logger && typeof logger.info === 'function') {
        logger.info('token_usage_history_seeded', { sessions: seeded });
      }
      return { seeded, persisted: true };
    } catch (error) {
      logFailure('token_usage_seed_write_failed', error);
      return { seeded, persisted: false };
    }
  }

  function providerTokenWindows(sessionId) {
    const persisted = deps.persistedSessions.get(sessionId);
    const providerId = (persisted && persisted.provider) || null;
    if (!providerId) return { providerId: null, windows: null };

    const allWindows = deps.readProviderWindows() || {};
    const windows = {
      today: (allWindows.today && allWindows.today[providerId])
        ? normalizeWindowBucket(allWindows.today[providerId]) : null,
      week: (allWindows.week && allWindows.week[providerId])
        ? normalizeWindowBucket(allWindows.week[providerId]) : null,
      month: (allWindows.month && allWindows.month[providerId])
        ? normalizeWindowBucket(allWindows.month[providerId]) : null,
      all: (allWindows.all && allWindows.all[providerId])
        ? normalizeWindowBucket(allWindows.all[providerId]) : null,
    };

    if (!windows.all) {
      const accumulated = getTokenUsage();
      let inputTokens = 0;
      let outputTokens = 0;
      let turnCount = 0;
      let freshInputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      for (const entry of Object.values(accumulated)) {
        const exact = entry && entry.byProvider && entry.byProvider[providerId];
        if (!exact) continue;
        const bucket = aggregateBucket(exact);
        inputTokens += bucket.inputTokens;
        freshInputTokens += bucket.freshInputTokens;
        cacheReadTokens += bucket.cacheReadTokens;
        cacheWriteTokens += bucket.cacheWriteTokens;
        outputTokens += bucket.outputTokens;
        turnCount += bucket.turnCount;
      }
      if (inputTokens + outputTokens > 0) {
        const unattributedInputTokens = Math.max(
          0,
          inputTokens - freshInputTokens - cacheReadTokens - cacheWriteTokens,
        );
        windows.all = {
          inputTokens,
          consumedInputTokens: inputTokens,
          freshInputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          unattributedInputTokens,
          breakdownKnown: unattributedInputTokens === 0,
          outputTokens,
          turnCount,
        };
      } else {
        const current = accumulated[sessionId];
        windows.attributionUnknown = !!(current
          && (tokenCount(current.inputTokens) + tokenCount(current.outputTokens) > 0));
      }
    }
    return { providerId, windows };
  }

  function broadcastProviderTokenStats(sessionId) {
    const result = providerTokenWindows(sessionId);
    deps.broadcast(sessionId, { type: 'provider_token_stats', windows: result.windows });
    return result.windows;
  }

  function broadcastRoleTokenStats(sessionId) {
    const role = deps.roleTokenTracker.snapshot(sessionId);
    if (!role) return null;
    deps.broadcast(sessionId, { type: 'role_token_stats', role });
    return role;
  }

  function recordRoleTokenUsage(info) {
    if (!deps.roleTokenTracker.accumulate(info)) return false;
    broadcastRoleTokenStats(info.sessionId);
    return true;
  }

  function recordUsageObserved(event) {
    if (!deps.roleTokenTracker.accumulateObserved(event)) return false;
    broadcastRoleTokenStats(event.sessionId);
    return true;
  }

  function reconcileCodexRoleUsage(sessionId, usage) {
    const persisted = deps.persistedSessions.get(sessionId);
    if (!persisted || persisted.cli !== 'codex' || !usage) return false;
    const cacheRead = eventTokenCount(
      usage.cache_read_input_tokens == null
        ? usage.cached_input_tokens
        : usage.cache_read_input_tokens,
    );
    const input = eventTokenCount(usage.input_tokens);
    const aggregate = {
      inputTokens: usage.cache_read_input_tokens == null ? Math.max(0, input - cacheRead) : input,
      outputTokens: eventTokenCount(usage.output_tokens),
      cacheWrite: eventTokenCount(usage.cache_creation_input_tokens),
      cacheRead,
    };
    const snapshot = deps.roleTokenTracker.snapshot(sessionId) || {};
    const main = snapshot.main || {};
    const sub = snapshot.sub || {};
    const missing = {
      inputTokens: Math.max(0, aggregate.inputTokens
        - tokenCount(main.inputTokens) - tokenCount(sub.inputTokens)),
      outputTokens: Math.max(0, aggregate.outputTokens
        - tokenCount(main.outputTokens) - tokenCount(sub.outputTokens)),
      cacheWrite: Math.max(0, aggregate.cacheWrite
        - tokenCount(main.cacheWrite) - tokenCount(sub.cacheWrite)),
      cacheRead: Math.max(0, aggregate.cacheRead
        - tokenCount(main.cacheRead) - tokenCount(sub.cacheRead)),
    };
    if (missing.inputTokens + missing.outputTokens + missing.cacheWrite + missing.cacheRead === 0) {
      return false;
    }

    const providerId = persisted.provider || '_default_';
    let summary = null;
    if (persisted.provider) {
      try { summary = deps.getProviderSummary('codex', persisted.provider); } catch (_) {}
    }
    return recordRoleTokenUsage({
      sessionId,
      role: 'main',
      providerId,
      providerName: (summary && summary.name)
        || (persisted.provider ? providerId : 'Default login'),
      model: deps.getEffectiveSessionModel(persisted) || '',
      usage: missing,
    });
  }

  function resetRoleTokenUsage(sessionId) {
    deps.roleTokenTracker.reset(sessionId);
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function') {
      throw new TypeError('Express app.get is required');
    }
    app.get('/api/token-usage/global', async (req, res) => {
      try {
        const data = await deps.getGlobalUsage({
          force: !!(req.query && req.query.refresh === '1'),
        });
        res.json(data);
      } catch (error) {
        logFailure('token_usage_global_read_failed', error);
        res.status(500).json({ error: PUBLIC_USAGE_ERROR });
      }
    });

    app.get('/api/token-usage/by-role', (req, res) => {
      try {
        if (req.query && req.query.session) {
          res.json(deps.roleTokenTracker.snapshot(req.query.session) || {
            main: EMPTY_ROLE_SNAPSHOT.main,
            sub: EMPTY_ROLE_SNAPSHOT.sub,
            subByProvider: [],
          });
          return;
        }
        res.json(deps.roleTokenTracker.readLedger());
      } catch (error) {
        logFailure('token_usage_role_read_failed', error);
        res.status(500).json({ error: PUBLIC_USAGE_ERROR });
      }
    });
  }

  return Object.freeze({
    mountRoutes,
    consumedInput,
    accumulateTokenUsage,
    accumulateTokenDaily,
    getTokenUsage,
    seedTokenUsageFromHistory,
    providerTokenWindows,
    broadcastProviderTokenStats,
    broadcastRoleTokenStats,
    recordRoleTokenUsage,
    recordUsageObserved,
    reconcileCodexRoleUsage,
    resetRoleTokenUsage,
  });
}

function mountTokenUsageRoutes(app, deps) {
  const runtime = createTokenUsageRoutes(deps);
  runtime.mountRoutes(app);
  return runtime;
}

module.exports = {
  EMPTY_ROLE_SNAPSHOT,
  MAX_EVENT_TOKENS,
  LARGE_EVENT_TOKEN_THRESHOLD,
  PUBLIC_USAGE_ERROR,
  aggregateBucket,
  consumedInput,
  eventTokenCount,
  localDateKey,
  normalizeUsageLedger,
  normalizeWindowBucket,
  tokenCount,
  usageComponents,
  createTokenUsageRoutes,
  mountTokenUsageRoutes,
};
