'use strict';

const fs = require('fs');
const path = require('path');
const stateStore = require('./state-store');
const { validateUsageObserved } = require('./usage-observed');

function emptyBucket() {
  return { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0 };
}

function hasUsage(bucket) {
  return !!bucket && (
    bucket.inputTokens || bucket.outputTokens || bucket.cacheWrite || bucket.cacheRead
  ) > 0;
}

function addUsage(bucket, usage) {
  bucket.inputTokens += usage.inputTokens || 0;
  bucket.outputTokens += usage.outputTokens || 0;
  bucket.cacheWrite += usage.cacheWrite || 0;
  bucket.cacheRead += usage.cacheRead || 0;
}

function readLedger(filePath, fsImpl = fs) {
  try {
    const data = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}

function writeLedger(filePath, data, fsImpl = fs) {
  if (fsImpl === fs) {
    stateStore.writeTextAtomic(filePath, JSON.stringify(data, null, 2), { mode: 0o600, dirMode: 0o700 });
    return;
  }
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fsImpl.renameSync(tmp, filePath);
  } finally {
    try { fsImpl.unlinkSync(tmp); } catch (_) {}
  }
}

function localDayKey(date) {
  return date.getFullYear() + '-'
    + String(date.getMonth() + 1).padStart(2, '0') + '-'
    + String(date.getDate()).padStart(2, '0');
}

function usageObservedToRoleTokenInfo(value) {
  const event = validateUsageObserved(value);
  if (event.coverage !== 'observed' || !event.tokens) return null;
  return Object.freeze({
    sessionId: event.sessionId,
    role: event.roleKind,
    providerId: event.providerId,
    providerName: event.providerName,
    model: event.model,
    usage: Object.freeze({
      inputTokens: event.tokens.input,
      outputTokens: event.tokens.output,
      cacheWrite: event.tokens.cacheWrite,
      cacheRead: event.tokens.cacheRead,
    }),
  });
}

function createRoleTokenTracker({
  filePath,
  now = () => new Date(),
  fsImpl = fs,
  onError = (error) => console.error(`[multicc] role token tracker: ${error.message}`),
} = {}) {
  if (!filePath) throw new Error('role token tracker requires filePath');
  const runtime = new Map();
  const observedEventIds = new Set();

  function accumulate(info) {
    if (!info || !info.sessionId || !info.usage || !hasUsage(info.usage)) return false;
    const role = info.role === 'sub' ? 'sub' : (info.role === 'aux' ? 'aux' : 'main');
    const usage = info.usage;

    // Runtime snapshots drive a chat session's 主/辅 display. Aux has no chat
    // turn and belongs only in the persistent ledger.
    if (role !== 'aux') {
      let turn = runtime.get(info.sessionId);
      if (!turn) {
        turn = { main: emptyBucket(), sub: emptyBucket(), byProviderSub: {} };
        runtime.set(info.sessionId, turn);
      }
      addUsage(turn[role], usage);
      if (role === 'sub') {
        const providerId = info.providerId || '_unknown_';
        const provider = turn.byProviderSub[providerId] || (turn.byProviderSub[providerId] = {
          name: info.providerName || providerId,
          model: info.model || '',
          ...emptyBucket(),
        });
        addUsage(provider, usage);
        if (info.providerName) provider.name = info.providerName;
        if (info.model) provider.model = info.model;
      }
    }

    try {
      const ledger = readLedger(filePath, fsImpl);
      const dayKey = localDayKey(now());
      const day = ledger[dayKey] || (ledger[dayKey] = {});
      const roleLedger = day[role] || (day[role] = {});
      const providerId = info.providerId || '_default_';
      const provider = roleLedger[providerId] || (roleLedger[providerId] = {
        name: info.providerName || info.providerId || '',
        inputTokens: 0,
        outputTokens: 0,
        cacheWrite: 0,
        cacheRead: 0,
        turns: 0,
      });
      addUsage(provider, usage);
      provider.turns += 1;
      if (info.providerName) provider.name = info.providerName;
      writeLedger(filePath, ledger, fsImpl);
    } catch (error) {
      onError(error);
    }
    return true;
  }

  function snapshot(sessionId) {
    const turn = runtime.get(sessionId);
    if (!turn) return null;
    const sub = hasUsage(turn.sub) ? { ...turn.sub } : null;
    return {
      main: { ...turn.main },
      sub,
      subByProvider: sub
        ? Object.entries(turn.byProviderSub).map(([providerId, bucket]) => ({
          providerId,
          name: bucket.name,
          model: bucket.model,
          inputTokens: bucket.inputTokens,
          outputTokens: bucket.outputTokens,
          cacheWrite: bucket.cacheWrite,
          cacheRead: bucket.cacheRead,
        }))
        : [],
    };
  }

  function accumulateObserved(value) {
    const event = validateUsageObserved(value);
    if (observedEventIds.has(event.eventId)) return false;
    const info = usageObservedToRoleTokenInfo(event);
    if (!info || !accumulate(info)) return false;
    observedEventIds.add(event.eventId);
    if (observedEventIds.size > 50_000) {
      observedEventIds.delete(observedEventIds.values().next().value);
    }
    return true;
  }

  function reset(sessionId) {
    runtime.delete(sessionId);
  }

  return {
    accumulate,
    accumulateObserved,
    snapshot,
    reset,
    readLedger: () => readLedger(filePath, fsImpl),
  };
}

module.exports = {
  createRoleTokenTracker,
  emptyBucket,
  hasUsage,
  addUsage,
  localDayKey,
  usageObservedToRoleTokenInfo,
};
