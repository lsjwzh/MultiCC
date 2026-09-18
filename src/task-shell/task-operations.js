'use strict';

const { hash } = require('./context');

const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });
const MAX_TURNS_PER_OPERATION = 50;
// A server-expanded range selects one visible segment, which is routinely
// longer than a hand-picked list. It gets its own bound so "select up to here"
// never fails with a message about invalid turn references.
const MAX_RANGE_TURNS = 500;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// A queued re-attribution waits for the turn it touches to finish. The wait is
// bounded so a request that can never be satisfied stops looking pending.
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUEUE_INTERVAL_MS = 5000;
// Terminal rows nobody can act on any more; the retention sweep may drop them.
const EXPIRABLE_STATUS = new Set(['reverted', 'cancelled', 'queued_expired', 'failed']);

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

function createTaskOperations({ store, revisionOf, isTurnBusy, resolveTarget, taskTitle, effectiveTaskOf, turnOrderOf,
  scopeOf, notify, now = () => Date.now() }) {
  const overlay = createAttributionOverlay(store);
  const flights = new Map();
  let queueTimer = null;

  function normalizeTurns(turns, max = MAX_TURNS_PER_OPERATION) {
    if (!Array.isArray(turns) || turns.length === 0 || turns.length > max) {
      throw fail('invalid_turns', `turns must contain 1-${max} entries`, 400);
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

  // Effective attribution is indexed globally by sessionId:turnId, so a write is
  // only legitimate for conversations that belong to the shell asking for it.
  // `chatScope` already computes that scope and already refuses to cross it;
  // failing closed here is what keeps one shell from re-attributing another
  // conversation's turns.
  function scopedSessions(scope) {
    const ids = Array.isArray(scope?.sessionIds) ? scope.sessionIds.filter(id => typeof id === 'string' && id) : [];
    if (!ids.length) throw fail('scope_incomplete', 'This conversation is not scoped to a task shell', 409);
    return new Set(ids);
  }

  function assertInScope(scope, turns) {
    const allowed = scopedSessions(scope);
    const outside = turns.filter(turn => !allowed.has(turn.sessionId))
      .map(turn => ({ sessionId: turn.sessionId, turnId: turn.turnId, reason: 'outside_conversation' }));
    if (outside.length) {
      throw Object.assign(fail('task_not_linked', 'Turns outside this conversation cannot be re-attributed', 403),
        { conflicts: outside });
    }
    return turns;
  }

  // 批量整理：一次选一整段（含两端）。区间在服务端按会话内轮次顺序解析，
  // 客户端不需要先把没加载的历史拉到页面上，也无法伪造不存在的轮次。
  function expandRange(range, scope) {
    const sessionId = typeof range?.sessionId === 'string' ? range.sessionId.trim() : '';
    const from = typeof range?.fromTurnId === 'string' ? range.fromTurnId.trim() : '';
    const to = typeof range?.toTurnId === 'string' ? range.toTurnId.trim() : '';
    if (!sessionId || !from || !to || typeof turnOrderOf !== 'function') throw fail('invalid_range', 'a session and both turn ends are required', 400);
    if (!scopedSessions(scope).has(sessionId)) {
      throw Object.assign(fail('task_not_linked', 'Turns outside this conversation cannot be re-attributed', 403),
        { conflicts: [{ sessionId, turnId: to, reason: 'outside_conversation' }] });
    }
    const ordered = (turnOrderOf(sessionId) || []).filter(turnId => typeof turnId === 'string' && turnId);
    const start = ordered.indexOf(from), end = ordered.indexOf(to);
    if (start < 0 || end < 0) throw fail('range_not_found', 'A selected turn is no longer part of this conversation', 409);
    const turns = ordered.slice(Math.min(start, end), Math.max(start, end) + 1).map(turnId => ({ sessionId, turnId }));
    if (turns.length > MAX_RANGE_TURNS) {
      throw Object.assign(fail('range_too_large', 'This range is too long to change in one step', 409),
        { detail: { turns: turns.length, max: MAX_RANGE_TURNS } });
    }
    return turns;
  }

  // Both entry points resolve their targets the same way: an explicit list is
  // bounded as user input, a server-expanded range is bounded as a segment, and
  // neither may address a conversation this shell does not own.
  function resolveTurns(scope, { range, turns } = {}) {
    return assertInScope(scope, range ? expandRange(range, scope) : normalizeTurns(turns));
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

  function preview({ scope, turns, target, range }) {
    const normalizedTurns = resolveTurns(scope, { range, turns }), normalizedTarget = normalizeTarget(target);
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
      clientMsgId: record.clientMsgId, targetTaskId: record.targetTaskId, previous: record.previous || null,
      // A queued row has no effects yet: it says what it is waiting for instead.
      turns: record.turns || null, blocked: record.blocked || [],
      effects: record.effects || null, createdAt: record.createdAt, appliedAt: record.appliedAt || null,
      queuedAt: record.queuedAt || null, resolvedAt: record.resolvedAt || null,
      undoneAt: record.undoneAt || null, lastError: record.lastError || null };
  }

  // 「这一轮还在跑」不该让用户的申请白白丢掉（点一次被拒一次）。显式排队时先落
  // 一行 pending，轮次结束后由服务端重验再应用：页面关掉、断网、重启都不影响。
  function enqueue({ scope, key, clientMsgId, fingerprint, existing, turns, target, blocked }) {
    if (existing?.status === 'queued') return publicOperation(existing);
    const record = { id: existing?.id || key, shellId: scope.shellId, kind: 'assign', status: 'queued',
      clientMsgId, fingerprint, targetTaskId: target.taskId, turns, blocked,
      createdAt: existing?.createdAt || now(), queuedAt: now() };
    store.set('task-op', key, record);
    return publicOperation(record);
  }

  async function apply({ scope, clientMsgId, previewToken, turns: rawTurns, target, expectedRevision, operationId, range, queue }) {
    if (typeof clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(clientMsgId)) throw fail('invalid_input', 'invalid clientMsgId', 400);
    const normalizedTurns = resolveTurns(scope, { range, turns: rawTurns }), normalizedTarget = normalizeTarget(target);
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
      if (blocked.length) {
        if (queue === true) return enqueue({ scope, key, clientMsgId, fingerprint, existing,
          turns: normalizedTurns, target: normalizedTarget, blocked });
        throw fail('turn_busy', 'Wait for the running turn to finish before changing its attribution', 409);
      }
      const missing = missingTurns(normalizedTurns);
      if (missing.length) throw fail('turn_not_found', 'A referenced turn does not exist in this conversation', 404);
      if (previewToken) {
        const expected = hash({ shellId: scope.shellId, revision, turns: normalizedTurns, target: normalizedTarget });
        if (previewToken !== expected) throw fail('preview_stale', 'The preview is no longer current; preview again', 409);
      }
      await resolveTarget?.(scope, normalizedTarget.taskId);
      const effects = effectsOf(normalizedTurns, normalizedTarget);
      const previous = effects.map(effect => ({ sessionId: effect.sessionId, turnId: effect.turnId,
        taskId: effect.fromTaskId ?? null,
        taskName: effect.fromTaskId ? taskTitle?.(effect.fromTaskId) || null : null }));
      const record = { id: operationId || key, shellId: scope.shellId, kind: 'assign', status: 'applied',
        clientMsgId, fingerprint, targetTaskId: normalizedTarget.taskId, previous, effects,
        // A row that waited in the queue keeps its request time: "when did you
        // ask for this" must survive the wait.
        createdAt: existing?.createdAt || now(), queuedAt: existing?.queuedAt || null, appliedAt: now() };
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

  // Queued rows are advanced by the server, not by the page that created them:
  // the tab may be gone before the turn ends. Every attempt re-runs the same
  // `apply` path, so the busy gate, the scope check and the preview of what
  // actually changes are all re-derived at write time.
  async function drain({ limit = 25 } = {}) {
    let applied = 0, expired = 0, failed = 0, waiting = 0;
    const queued = store.list('task-op').filter(record => record.status === 'queued')
      .sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0)).slice(0, limit);
    for (const record of queued) {
      const key = record.id;
      if ((now() - (record.queuedAt || 0)) > QUEUE_TTL_MS) {
        store.set('task-op', key, { ...record, status: 'queued_expired', resolvedAt: now(), lastError: 'queued_expired' });
        expired += 1;
        continue;
      }
      if (flights.has(key)) { waiting += 1; continue; }
      let missing;
      try {
        missing = missingTurns(record.turns || []);
        if (!missing.length && typeof scopeOf === 'function') {
          // `apply` registers itself in `flights` before its first await, so two
          // drain passes can never write the same row twice.
          await apply({ scope: scopeOf(record.shellId), clientMsgId: record.clientMsgId,
            turns: record.turns, target: { taskId: record.targetTaskId } });
          applied += 1;
          // The page that asked for this may still be open — and its history is
          // now stale. Announce it on the same channel as every other applied
          // re-attribution, so it repaints instead of waiting for a reload.
          for (const sessionId of new Set((store.get('task-op', key)?.effects || [])
            .map(effect => effect.sessionId).filter(Boolean))) {
            try { notify?.(sessionId, { operationId: key, kind: 'applied', queued: true }); }
            catch (_) {}
          }
          continue;
        }
      } catch (error) {
        // Still busy, or the turn started again between the gate and the write:
        // that is "not yet", not a failure of what the user asked for.
        if (error?.code === 'turn_busy' || error?.code === 'task_switching') { waiting += 1; continue; }
        store.set('task-op', key, { ...(store.get('task-op', key) || record), status: 'failed',
          resolvedAt: now(), lastError: String(error?.code || 'failed') });
        console.warn('[task-attribution] queued change failed', error?.code || error?.message);
        failed += 1;
        continue;
      }
      store.set('task-op', key, { ...record, status: 'failed', resolvedAt: now(),
        lastError: missing.length ? 'turn_not_found' : 'queue_unavailable' });
      failed += 1;
    }
    return { applied, expired, failed, waiting };
  }

  // The first pass runs at mount, so a row queued just before a restart is
  // picked up immediately instead of waiting a full interval.
  function start(intervalMs = DEFAULT_QUEUE_INTERVAL_MS) {
    const first = drain().catch(() => {});
    if (queueTimer) return first;
    queueTimer = setInterval(() => { void drain().catch(() => {}); },
      Math.max(1000, Number(intervalMs) || DEFAULT_QUEUE_INTERVAL_MS));
    if (typeof queueTimer.unref === 'function') queueTimer.unref();
    return first;
  }
  function stop() { if (queueTimer) clearInterval(queueTimer); queueTimer = null; }

  // Cancelling is how a user takes a queued request back; an applied one is
  // reverted with `undo` instead, so this refuses to touch it.
  function cancel({ operationId, clientMsgId }) {
    const record = store.list('task-op').find(value => value.id === operationId);
    if (!record) throw fail('operation_not_found', 'Change not found', 404);
    if (record.status === 'cancelled') return publicOperation(record);
    if (record.status !== 'queued') throw fail('operation_not_queued', 'Only a queued change can be cancelled', 409);
    if (clientMsgId != null && !/^[\w.:-]{1,160}$/.test(String(clientMsgId))) throw fail('invalid_input', 'invalid clientMsgId', 400);
    const next = { ...record, status: 'cancelled', resolvedAt: now(), cancelClientMsgId: clientMsgId || null };
    store.set('task-op', opKey(record.shellId, record.clientMsgId), next);
    return publicOperation(next);
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
          // Restoring the title too: an earlier attribution keeps its name even
          // if the task has since been renamed or removed from the board.
          store.set('turn-attr', key, { sessionId: previous.sessionId, turnId: previous.turnId,
            taskId: previous.taskId, taskName: previous.taskName || taskTitle?.(previous.taskId) || null,
            operationId: `undo:${record.id}`, updatedAt: now() });
        }
      }
      store.set('task-op', opKey(record.shellId, record.clientMsgId),
        { ...record, status: 'reverted', undoneAt: now(), undoClientMsgId: clientMsgId });
    });
    return get(operationId);
  }

  // Dropping a conversation drops the journal rows that conversation owns, and
  // the overlay rows those operations wrote. Overlay rows are matched by
  // operation id, so a session another shell still reads keeps overlays that
  // are not ours.
  function purgeShell(shellId) {
    const records = store.list('task-op').filter(record => record.shellId === shellId);
    let overlays = 0;
    store.transaction(() => {
      for (const record of records) {
        store.remove('task-op', opKey(record.shellId, record.clientMsgId));
        for (const previous of record.previous || []) {
          const key = entryKey(previous.sessionId, previous.turnId);
          if (store.get('turn-attr', key)?.operationId === record.id) { store.remove('turn-attr', key); overlays += 1; }
        }
      }
    });
    return { operations: records.length, overlays };
  }

  return { preview, apply, get, undo, cancel, drain, start, stop, overlay, purgeShell,
    list: shellId => store.list('task-op').filter(record => !shellId || record.shellId === shellId).map(publicOperation),
    expireOlderThan: cutoff => {
      const limit = cutoff || now() - WINDOW_MS;
      let removed = 0;
      for (const record of store.list('task-op')) {
        if (!EXPIRABLE_STATUS.has(record.status)) continue;
        const at = record.status === 'reverted' ? record.undoneAt : (record.resolvedAt || record.queuedAt);
        if (at && at < limit) { store.remove('task-op', opKey(record.shellId, record.clientMsgId)); removed += 1; }
      }
      return removed;
    } };
}

module.exports = { createAttributionOverlay, createTaskOperations, MAX_TURNS_PER_OPERATION, MAX_RANGE_TURNS };
