// Frozen at 92f9dbae; module paths point back into the host under test.
'use strict';

const fs = require('fs');
const path = require('path');
const stateStore = require('../frozen-batch10').frozen('state/store');
const {
  RustRoleTokenTracker, roleLedgerUpdate, emptyRoleTokenBucket: emptyBucket,
  roleBucketHasUsage, accumulateRoleBucket,
} = require('../../../src/native/binding').getNative();
const { validateUsageObserved } = require('../frozen-da8f52ee/usage-observed');

// Use V8's '+' coercion for legacy strings and caller-owned objects.
const jsAdd = (left, right) => left + right;
function hasUsage(bucket) { return roleBucketHasUsage(bucket); }
function addUsage(bucket, usage) { accumulateRoleBucket(bucket, usage, jsAdd); }

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
  // The native owner retains the counters. The anchor keeps host references
  // GC-visible, including object-valued keys and legacy JS addition.
  const anchor = { add: jsAdd, persist };
  const owner = new RustRoleTokenTracker(anchor);
  Object.defineProperty(owner, Symbol('role token host values'), { value: anchor });

  function persist(info, role, usage) {
    try {
      const ledger = readLedger(filePath, fsImpl);
      roleLedgerUpdate(ledger, localDayKey(now()), role, info, usage, anchor.add);
      writeLedger(filePath, ledger, fsImpl);
    } catch (error) {
      onError(error);
    }
  }

  function accumulateObserved(value) {
    const event = validateUsageObserved(value);
    if (owner.seen(event.eventId)) return false;
    const info = usageObservedToRoleTokenInfo(event);
    if (!info || !owner.accumulate(info)) return false;
    owner.remember(event.eventId);
    return true;
  }

  return {
    accumulate: info => owner.accumulate(info),
    accumulateObserved,
    snapshot: sessionId => owner.snapshot(sessionId),
    reset: sessionId => owner.reset(sessionId),
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
