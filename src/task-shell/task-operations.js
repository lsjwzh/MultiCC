'use strict';

const { hash } = require('./context');

const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });
const MAX_TURNS_PER_OPERATION = 50;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function entryKey(sessionId, turnId) { return `${sessionId}:${turnId}`; }
function opKey(shellId, clientMsgId) { return `op_${hash([shellId, clientMsgId]).slice(0, 40)}`; }

// Effective attribution lives in an overlay next to the canonical history. The
// transcript keeps saying what actually ran; the overlay says which logical task
// a turn currently answers to, and it can be reverted without rewriting (and
// therefore racing) message storage.
function createAttributionOverlay(store) {
  function get(sessionId, turnId) {
    if (!sessionId || !turnId) return null;
    const entry = store.get('turn-attr', entryKey(sessionId, turnId));
    return entry && typeof entry.taskId === 'string' ? entry : null;
  }
  function apply(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map(message => {
      if (!message || typeof message !== 'object') return message;
      const entry = get(message.sourceSessionId || message.sessionId, message.turnId);
      if (!entry) return message;
      return { ...message, taskId: entry.taskId, taskName: entry.taskName ?? message.taskName,
        attributionOperationId: entry.operationId || null, attributionOverridden: true };
    });
  }
  return { get, apply };
}

function createTaskOperations({ store, revisionOf, isTurnBusy, resolveTarget, taskTitle, effectiveTaskOf, now = () => Date.now() }) {
  const overlay = createAttributionOverlay(store);
  const flights = new Map();

  function normalizeTurns(turns) {
    if (!Array.isArray(turns) || turns.length === 0 || turns.length > MAX_TURNS_PER_OPERATION) {
      throw fail('invalid_turns', `turns must contain 1-${MAX_TURNS_PER_OPERATION} entries`, 400);
    }
    const seen = new Set();
    return turns.map(raw => {
      const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId.trim() : '';
      const turnId = typeof raw?.turnId === 'string' ? raw.turnId.trim() : '';
      if (!sessionId || !turnId || sessionId.length > 200 || turnId.length > 200) throw fail('invalid_turns', 'invalid turn reference', 400);
      const key = entryKey(sessionId, turnId);
      if (seen.has(key)) throw fail('invalid_turns', 'duplicate turn reference', 400);
      seen.add(key);
      return { sessionId, turnId };
    });
  }

  function normalizeTarget(target) {
    const taskId = typeof target?.taskId === 'string' ? target.taskId.trim() : '';
    if (!taskId || taskId.length > 200) throw fail('invalid_target', 'a linked target task is required', 400);
    return { taskId };
  }

  // Effects are computed from the same overlay the read layer uses, so the
  // preview cannot disagree with what the write would produce.
  // `from` is the effective attribution (manual override or transcript), so a
  // preview can say what actually changes rather than only what it will write.
  function currentTaskOf(sessionId, turnId) {
    if (typeof effectiveTaskOf === 'function') {
      const value = effectiveTaskOf(sessionId, turnId);
      if (value !== undefined) return value;
    }
    return overlay.get(sessionId, turnId)?.taskId || null;
  }
  function missingTurns(turns) {
    if (typeof effectiveTaskOf !== 'function') return [];
    return turns.filter(({ sessionId, turnId }) => currentTaskOf(sessionId, turnId) === null)
      .map(({ sessionId, turnId }) => ({ sessionId, turnId, reason: 'turn_not_found' }));
  }
  function effectsOf(turns, target) {
    return turns.map(({ sessionId, turnId }) => {
      const fromTaskId = currentTaskOf(sessionId, turnId);
      return { sessionId, turnId, fromTaskId, toTaskId: target.taskId, changed: fromTaskId !== target.taskId };
    });
  }

  function blockedTurns(turns) {
    return turns.filter(({ sessionId, turnId }) => isTurnBusy?.(sessionId, turnId) === true)
      .map(({ sessionId, turnId }) => ({ sessionId, turnId, reason: 'turn_busy' }));
  }

  function preview({ scope, turns, target }) {
    const normalizedTurns = normalizeTurns(turns), normalizedTarget = normalizeTarget(target);
    const revision = revisionOf(scope);
    const blocked = [...missingTurns(normalizedTurns), ...blockedTurns(normalizedTurns)];
    const effects = effectsOf(normalizedTurns, normalizedTarget);
    return {
      previewToken: hash({ shellId: scope.shellId, revision, turns: normalizedTurns, target: normalizedTarget }),
      shellId: scope.shellId, scopeRevision: revision, target: normalizedTarget,
      effects, blocked, changed: effects.filter(effect => effect.changed).length,
      capabilities: { applicable: blocked.length === 0 },
    };
  }

  function recordOf(key) { return store.get('task-op', key); }
  function publicOperation(record) {
    if (!record) return null;
    return { id: record.id, kind: record.kind, shellId: record.shellId, status: record.status,
      clientMsgId: record.clientMsgId, targetTaskId: record.targetTaskId, previous: record.previous,
      effects: record.effects, createdAt: record.createdAt, appliedAt: record.appliedAt || null,
      undoneAt: record.undoneAt || null, lastError: record.lastError || null };
  }

  async function apply({ scope, clientMsgId, previewToken, turns, target, expectedRevision, operationId }) {
    if (typeof clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(clientMsgId)) throw fail('invalid_input', 'invalid clientMsgId', 400);
    const normalizedTurns = normalizeTurns(turns), normalizedTarget = normalizeTarget(target);
    const key = opKey(scope.shellId, clientMsgId);
    const fingerprint = hash({ turns: normalizedTurns, target: normalizedTarget });
    const inFlight = flights.get(key);
    if (inFlight) { await inFlight; return publicOperation(recordOf(key)); }
    const existing = recordOf(key);
    if (existing && existing.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This operation id was used for a different change', 409);
    if (existing?.status === 'applied') return publicOperation(existing);
    if (existing?.status === 'reverted') return publicOperation(existing);

    const run = (async () => {
      const revision = revisionOf(scope);
      if (expectedRevision && expectedRevision !== revision) {
        throw fail('scope_revision_conflict', 'The conversation changed since this change was previewed', 409);
      }
      const blocked = blockedTurns(normalizedTurns);
      if (blocked.length) throw fail('turn_busy', 'Wait for the running turn to finish before changing its attribution', 409);
      const missing = missingTurns(normalizedTurns);
      if (missing.length) throw fail('turn_not_found', 'A referenced turn does not exist in this conversation', 404);
      if (previewToken) {
        const expected = hash({ shellId: scope.shellId, revision, turns: normalizedTurns, target: normalizedTarget });
        if (previewToken !== expected) throw fail('preview_stale', 'The preview is no longer current; preview again', 409);
      }
      await resolveTarget?.(scope, normalizedTarget.taskId);
      const effects = effectsOf(normalizedTurns, normalizedTarget);
      const previous = effects.map(effect => ({ sessionId: effect.sessionId, turnId: effect.turnId,
        taskId: effect.fromTaskId ?? null }));
      const record = { id: operationId || key, shellId: scope.shellId, kind: 'assign', status: 'applied',
        clientMsgId, fingerprint, targetTaskId: normalizedTarget.taskId, previous, effects,
        createdAt: existing?.createdAt || now(), appliedAt: now() };
      // One transaction covers the overlay writes and the audit record, so a
      // crash can never leave half a re-attribution behind.
      store.transaction(() => {
        for (const effect of effects) {
          store.set('turn-attr', entryKey(effect.sessionId, effect.turnId), {
            sessionId: effect.sessionId, turnId: effect.turnId, taskId: normalizedTarget.taskId,
            taskName: taskTitle?.(normalizedTarget.taskId) || null, operationId: record.id, updatedAt: now(),
          });
        }
        store.set('task-op', key, record);
      });
      return publicOperation(record);
    })();
    flights.set(key, run);
    try { return await run; } finally { flights.delete(key); }
  }

  function get(operationId) {
    const record = store.list('task-op').find(value => value.id === operationId);
    if (!record) throw fail('operation_not_found', 'Change not found', 404);
    return publicOperation(record);
  }

  // Reverting restores exactly the attribution captured before the operation.
  // Reverting an earlier change cannot resurrect a turn someone else moved
  // afterwards: those turns are reported as conflicts instead of overwritten.
  function undo({ operationId, clientMsgId }) {
    const record = store.list('task-op').find(value => value.id === operationId);
    if (!record) throw fail('operation_not_found', 'Change not found', 404);
    if (record.status !== 'applied') throw fail('operation_not_applied', 'This change is not applied', 409);
    if (!/^[\w.:-]{1,160}$/.test(String(clientMsgId || ''))) throw fail('invalid_input', 'invalid clientMsgId', 400);
    const conflict = record.previous.filter(previous => {
      const current = store.get('turn-attr', entryKey(previous.sessionId, previous.turnId));
      if ((current?.operationId || null) === record.id) return false;
      return !(previous.taskId == null && !current);
    }).map(previous => ({ sessionId: previous.sessionId, turnId: previous.turnId, reason: 'changed_after_operation' }));
    if (conflict.length) throw Object.assign(fail('undo_conflict', 'These turns changed after this operation', 409), { conflicts: conflict });
    store.transaction(() => {
      for (const previous of record.previous) {
        const key = entryKey(previous.sessionId, previous.turnId);
        if (previous.taskId == null) {
          // The turn had no overlay before: dropping ours restores the transcript.
          const current = store.get('turn-attr', key);
          if (current?.operationId === record.id) store.remove('turn-attr', key);
        } else {
          store.set('turn-attr', key, { sessionId: previous.sessionId, turnId: previous.turnId,
            taskId: previous.taskId, taskName: null, operationId: `undo:${record.id}`, updatedAt: now() });
        }
      }
      store.set('task-op', opKey(record.shellId, record.clientMsgId),
        { ...record, status: 'reverted', undoneAt: now(), undoClientMsgId: clientMsgId });
    });
    return get(operationId);
  }

  return { preview, apply, get, undo, overlay,
    list: shellId => store.list('task-op').filter(record => !shellId || record.shellId === shellId).map(publicOperation),
    expireOlderThan: cutoff => {
      const limit = cutoff || now() - WINDOW_MS;
      let removed = 0;
      for (const record of store.list('task-op')) {
        if (record.status === 'reverted' && record.undoneAt && record.undoneAt < limit) { store.remove('task-op', opKey(record.shellId, record.clientMsgId)); removed += 1; }
      }
      return removed;
    } };
}

module.exports = { createAttributionOverlay, createTaskOperations, MAX_TURNS_PER_OPERATION };
