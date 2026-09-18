'use strict';

const { hash } = require('./context');
const { planAttributionAction } = require('../task-routing/attribution-mode');

const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });
// A queued apply is a durable request, not a retry loop: it waits for the turn
// that made it busy to end, and gives up (visibly) instead of holding a row
// forever if that never happens.
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUEUE_INTERVAL_MS = 5000;

// Durable journal for what the automatic classifier wanted, and what the host
// was allowed to do about it.
//
// The journal is the whole point of the ladder: `shadow` and `suggest` rows look
// exactly like `auto` ones, so "the model asked for this" and "the host did this"
// stay separable and measurable. A row only ever moves a turn; it never merges
// identities, moves code, or re-routes a turn that is still running.
function createAttributionDecisions(deps) {
  const { store, operations } = deps;
  const now = deps.now || (() => Date.now());
  const flights = new Map();
  let timer = null;

  function idOf(shellId, receiptId, turnId) {
    return `dec_${hash([shellId, receiptId, turnId || '']).slice(0, 32)}`;
  }

  function publicDecision(record) {
    if (!record) return null;
    return { id: record.id, shellId: record.shellId, sessionId: record.sessionId, turnId: record.turnId,
      receiptId: record.receiptId, fromTaskId: record.fromTaskId, fromTaskTitle: deps.taskTitle?.(record.fromTaskId) || null,
      toTaskId: record.toTaskId, toTaskTitle: deps.taskTitle?.(record.toTaskId) || record.taskName || null,
      taskName: record.taskName || null, relation: record.relation, mode: record.mode, action: record.action,
      path: record.path, state: record.state, hidden: record.hidden === true, reason: record.reason,
      createdAt: record.createdAt, updatedAt: record.updatedAt || null, revisions: Number(record.revisions) || 0,
      resolvedAt: record.resolvedAt || null, deferredAt: record.deferredAt || null,
      queuedAt: record.queuedAt || null, queueAttempts: Number(record.queueAttempts) || 0,
      apply: record.apply || null, lastError: record.lastError || null };
  }

  // The detail is what lets another page tell "the card I am showing was just
  // resolved" apart from "an applied change moved a turn's task", without a
  // second read and without guessing.
  function notify(sessionId, detail) {
    try { deps.onAttributionChanged?.(sessionId, detail || {}); } catch (error) {
      console.warn('[task-attribution] notification failed', error.message);
    }
  }

  // A suggestion is still actionable after the user postponed it: `deferred`
  // is a durable "later", not a rejection, so accept/dismiss must still work.
  // `queued` is the same kind of open state: the user already accepted it, the
  // host is only waiting for the turn to close, and dismissing/deferring it is
  // how that waiting request is withdrawn.
  function isOpen(row) {
    return row.state === 'pending' || row.state === 'unclassified'
      || row.state === 'deferred' || row.state === 'queued';
  }

  // Recording is idempotent per (conversation, turn): re-running the same Aux
  // verdict must not pile up rows or apply itself twice. A *pending* row is the
  // one exception: a fresh verdict for the same turn refreshes it in place, so a
  // late (or corrected) judgement replaces the suggestion instead of creating a
  // second prompt. Rows the user or `auto` already resolved stay final.
  async function record(sessionId, receiptId, input = {}) {
    const receipt = store.get('receipt', receiptId);
    const source = receipt && store.get('task', receipt.taskId);
    if (!receipt || !source || source.sessionId !== sessionId) return { action: 'none', decision: null };
    const plan = planAttributionAction({ mode: input.mode, relation: input.relation,
      targetTaskId: input.taskId || null, currentTaskId: input.currentTaskId || source.id });
    const id = idOf(receipt.shellId, receiptId, input.turnId);
    const existing = store.get('attr-decision', id);
    // An unusable verdict (no JSON, model unavailable, unreadable target) is
    // still a fact about the turn. It is recorded as `unclassified` — visible
    // and dismissible, but never a silent permanent "same" and never an applied
    // identity change, because it carries no address to apply.
    if (input.unclassified === true) {
      if (existing && existing.state !== 'failed' && existing.state !== 'unclassified') {
        return { action: 'none', decision: publicDecision(existing) };
      }
      const row = { id, shellId: receipt.shellId, sessionId, receiptId, turnId: input.turnId || null,
        fromTaskId: source.id, toTaskId: null, taskName: input.taskName || null, relatedTaskId: null,
        relation: null, path: 'none', mode: plan.mode, action: 'suggest', reason: input.reason || 'verdict_unavailable',
        hidden: false, state: 'unclassified', createdAt: existing?.createdAt || now(),
        updatedAt: now(), revisions: Number(existing?.revisions) || 0,
        runId: input.runId || null, anchorMessageId: input.anchorMessageId || null };
      store.set('attr-decision', id, row);
      notify(sessionId, { decisionId: row.id, state: row.state, kind: 'recorded' });
      return { action: 'none', decision: publicDecision(row) };
    }
    if (plan.action === 'none') return { action: 'none', decision: null };
    if (existing && existing.state !== 'failed' && existing.state !== 'pending') {
      return { action: existing.action, decision: publicDecision(existing) };
    }
    const next = { id, shellId: receipt.shellId, sessionId, receiptId, turnId: input.turnId || null,
      fromTaskId: source.id, toTaskId: plan.targetTaskId, taskName: input.taskName || null,
      relatedTaskId: input.relatedTaskId || null, relation: input.relation === 'new' ? 'new' : 'same',
      // A new identity is created through the shell cursor; naming an existing
      // task only re-attributes this turn.
      path: input.relation === 'new' ? 'identity' : 'overlay',
      mode: plan.mode, action: plan.action, reason: plan.reason,
      hidden: plan.action === 'record', state: 'pending', createdAt: now(), runId: input.runId || null,
      anchorMessageId: input.anchorMessageId || null };
    const row = existing
      ? { ...next, createdAt: existing.createdAt || next.createdAt, updatedAt: now(),
        revisions: (Number(existing.revisions) || 0) + 1 }
      : next;
    store.set('attr-decision', id, row);
    if (row.action !== 'apply') {
      notify(sessionId, { decisionId: row.id, state: row.state, kind: 'recorded' });
      return { action: row.action, decision: publicDecision(row) };
    }
    // `auto` applies here, inside the runtime that owns the write, so the caller
    // never has to repeat a transaction whose end it cannot see.
    const applied = await applyRow(row, { clientMsgId: `auto_${row.id}` });
    return { action: 'apply', decision: publicDecision(applied) };
  }

  async function applyRow(row, { clientMsgId }) {
    try {
      if (row.path === 'identity') {
        const result = deps.settleAttribution(row.sessionId, row.receiptId, {
          taskId: row.toTaskId, taskName: row.taskName, relatedTaskId: row.relatedTaskId,
        });
        if (!result?.ok) throw fail(result?.code || 'attribution_not_applied', result?.code || 'attribution_not_applied', 409);
        const settled = await store.transaction(() => {
          store.set('attr-decision', row.id, { ...row, state: 'applied', resolvedAt: now(),
            apply: { kind: 'identity', taskId: result.taskId, clientMsgId } });
          return store.get('attr-decision', row.id);
        });
        notify(row.sessionId, { decisionId: settled.id, state: settled.state, kind: 'applied',
          toTaskId: settled.toTaskId, fromTaskId: settled.fromTaskId });
        return settled;
      }
      const scope = deps.scopeOf?.(row.shellId);
      if (!scope) throw fail('task_shell_not_found', 'Task shell not found', 404);
      const operation = await operations.apply({ scope, clientMsgId,
        turns: [{ sessionId: row.sessionId, turnId: row.turnId }], target: { taskId: row.toTaskId } });
      const settled = await store.transaction(() => {
        store.set('attr-decision', row.id, { ...row, state: operation.status === 'applied' ? 'applied' : 'reverted',
          resolvedAt: now(), apply: { kind: 'overlay', operationId: operation.id, clientMsgId } });
        return store.get('attr-decision', row.id);
      });
      notify(row.sessionId, { decisionId: settled.id, state: settled.state, kind: 'applied',
        toTaskId: settled.toTaskId, fromTaskId: settled.fromTaskId });
      return settled;
    } catch (error) {
      store.set('attr-decision', row.id, { ...row, state: 'failed', lastError: String(error.message).slice(0, 200) });
      notify(row.sessionId, { decisionId: row.id, state: 'failed', kind: 'failed' });
      throw error;
    }
  }

  function list(shellId, { includeHidden = false } = {}) {
    return store.list('attr-decision')
      .filter(row => row.shellId === shellId && (includeHidden || row.hidden !== true))
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
      .map(publicDecision);
  }

  function get(shellId, decisionId) {
    const row = store.get('attr-decision', decisionId);
    if (!row || row.shellId !== shellId) throw fail('attribution_decision_not_found', 'Suggestion not found', 404);
    return row;
  }

  // The user (or `auto`) accepts the *recorded* verdict, never a fresh one: a
  // suggestion that the conversation has outgrown fails closed instead of
  // guessing what it would have meant.
  async function accept(shellId, decisionId, { clientMsgId } = {}) {
    const row = get(shellId, decisionId);
    if (row.state === 'applied') return publicDecision(row);
    // Fail closed instead of "applying" a row that has no address: accepting an
    // unclassified verdict would otherwise look like a successful change while
    // moving nothing (and an overlay row without a turn cannot be written).
    // `unclassified` is unresolved but unusable, so it reports its own reason
    // instead of the misleading "already resolved".
    if (!isOpen(row)) {
      throw fail('attribution_decision_resolved', 'This suggestion is already resolved', 409);
    }
    if (row.path === 'none' || !row.toTaskId) {
      throw fail('attribution_verdict_unavailable', 'This verdict has no target; classify the turn again', 409);
    }
    if (typeof clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(clientMsgId)) throw fail('invalid_input', 'invalid clientMsgId', 400);
    const pending = flights.get(row.id);
    if (pending) { await pending; return publicDecision(get(shellId, decisionId)); }
    const run = (async () => {
      if (deps.isTurnBusy?.(row.sessionId, row.turnId) === true) {
        // Not an error: the user already decided, and the only thing missing is
        // that the turn has not closed yet. Recording the request durably is
        // what makes the card non-blocking — the page can be closed, another
        // message can be sent, and the change still lands once it is safe.
        return publicDecision(queueRow(row, clientMsgId));
      }
      const shell = store.get('shell', shellId);
      const existing = store.get('task', row.toTaskId);
      if (existing?.dirId && shell?.dirId && existing.dirId !== shell.dirId) throw fail('project_mismatch');
      return publicDecision(await applyRow(row, { clientMsgId }));
    })();
    flights.set(row.id, run);
    try { return await run; } finally { flights.delete(row.id); }
  }

  // The accepted-but-not-yet-applied state. It keeps the client's operation id
  // so the eventual write stays idempotent with the click that asked for it.
  function queueRow(row, clientMsgId, note = 'queued') {
    const queued = store.transaction(() => {
      store.set('attr-decision', row.id, { ...row, state: 'queued', queuedAt: row.queuedAt || now(),
        updatedAt: now(), queueAttempts: Number(row.queueAttempts) || 0,
        queueClientMsgId: row.queueClientMsgId || clientMsgId || `queued_${row.id}` });
      return store.get('attr-decision', row.id);
    });
    notify(row.sessionId, { decisionId: queued.id, state: queued.state, kind: note });
    return queued;
  }

  // Retrying a queued row re-reads the busy gate and the cursor CAS inside
  // `applyRow`, so "the turn closed" is a re-validation, never a blind write.
  // Only the row this request queued is retried; a row that failed for any
  // other reason stays failed instead of being resurrected.
  async function drain() {
    let applied = 0, expired = 0;
    for (const row of store.list('attr-decision').filter(value => value.state === 'queued')) {
      if ((now() - (row.queuedAt || 0)) > QUEUE_TTL_MS) {
        store.set('attr-decision', row.id, { ...row, state: 'failed', resolvedAt: now(),
          lastError: 'queued_expired' });
        notify(row.sessionId, { decisionId: row.id, state: 'failed', kind: 'failed' });
        expired += 1;
        continue;
      }
      if (flights.has(row.id)) continue;
      if (deps.isTurnBusy?.(row.sessionId, row.turnId) === true) continue;
      const run = (async () => applyRow(row, { clientMsgId: row.queueClientMsgId || `queued_${row.id}` }))();
      flights.set(row.id, run);
      try {
        await run;
        applied += 1;
      } catch (error) {
        // A turn that started again between the gate and the write is "still
        // not yet", not a failure of what the user asked for.
        if (error?.code === 'turn_busy' || error?.code === 'task_switching') {
          const current = store.get('attr-decision', row.id);
          if (current?.state === 'failed') {
            store.set('attr-decision', row.id, { ...current, state: 'queued', lastError: null,
              queueAttempts: (Number(current.queueAttempts) || 0) + 1 });
          }
        } else {
          console.warn('[task-attribution] queued apply failed', error.code || error.message);
        }
      } finally {
        flights.delete(row.id);
      }
    }
    return { applied, expired };
  }

  // The queue is advanced by the server, not by the page that created it: the
  // user may have closed the tab (or the whole browser) before the turn ended.
  // The first pass runs immediately, so a row queued just before a restart is
  // picked up at mount instead of waiting a full interval.
  function start(intervalMs = DEFAULT_QUEUE_INTERVAL_MS) {
    const first = drain().catch(() => {});
    if (timer) return first;
    timer = setInterval(() => { void drain().catch(() => {}); }, Math.max(1000, Number(intervalMs) || DEFAULT_QUEUE_INTERVAL_MS));
    if (typeof timer.unref === 'function') timer.unref();
    return first;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  function dismiss(shellId, decisionId) {
    const row = get(shellId, decisionId);
    if (row.state === 'dismissed') return publicDecision(row);
    // `unclassified` is dismissible: it is the one action that verdict can
    // offer, and dropping it is how the user clears the notice.
    if (!isOpen(row)) {
      throw fail('attribution_decision_resolved', 'This suggestion is already resolved', 409);
    }
    store.set('attr-decision', row.id, { ...row, state: 'dismissed', resolvedAt: now() });
    notify(row.sessionId, { decisionId: row.id, state: 'dismissed', kind: 'dismissed' });
    return publicDecision(store.get('attr-decision', row.id));
  }

  // "Later" is a durable postponement, not a rejection: the row stays
  // unresolved, keeps counting as pending work, and survives a refresh or
  // another device, so only an explicit accept/dismiss clears it.
  function defer(shellId, decisionId) {
    const row = get(shellId, decisionId);
    if (row.state === 'deferred') return publicDecision(row);
    if (!isOpen(row)) {
      throw fail('attribution_decision_resolved', 'This suggestion is already resolved', 409);
    }
    store.set('attr-decision', row.id, { ...row, state: 'deferred', deferredAt: now() });
    notify(row.sessionId, { decisionId: row.id, state: 'deferred', kind: 'deferred' });
    return publicDecision(store.get('attr-decision', row.id));
  }

  // Undo restores the attribution the decision replaced. The identity path also
  // puts the shell cursor back, and refuses if the conversation moved on.
  function undo(shellId, decisionId) {
    const row = get(shellId, decisionId);
    if (row.state === 'reverted') return publicDecision(row);
    if (row.state !== 'applied' || !row.apply) throw fail('attribution_decision_not_applied', 'Nothing to undo', 409);
    if (row.apply.kind === 'overlay') {
      const operation = operations.get(row.apply.operationId);
      if (operation.status !== 'reverted') operations.undo({ operationId: operation.id, clientMsgId: `undo_${row.id}` });
    } else {
      const restored = deps.restoreSettledCursor?.(shellId, { fromTaskId: row.fromTaskId, toTaskId: row.toTaskId });
      if (restored?.ok !== true) {
        throw fail(restored?.code || 'attribution_undo_conflict', 'The conversation moved on; this change cannot be undone', 409);
      }
    }
    store.set('attr-decision', row.id, { ...row, state: 'reverted', resolvedAt: now() });
    notify(row.sessionId, { decisionId: row.id, state: 'reverted', kind: 'reverted' });
    return publicDecision(store.get('attr-decision', row.id));
  }

  return { record, list, publicDecision, accept, dismiss, defer, undo, drain, start, stop };
}

module.exports = { createAttributionDecisions, QUEUE_TTL_MS };
