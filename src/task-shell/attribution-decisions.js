'use strict';

const { hash } = require('./context');
const { planAttributionAction } = require('../task-routing/attribution-mode');

const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });

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
      createdAt: record.createdAt, resolvedAt: record.resolvedAt || null, apply: record.apply || null,
      lastError: record.lastError || null };
  }

  function notify(sessionId) {
    try { deps.onAttributionChanged?.(sessionId); } catch (error) {
      console.warn('[task-attribution] notification failed', error.message);
    }
  }

  // Recording is idempotent per (conversation, turn): re-running the same Aux
  // verdict must not pile up rows or apply itself twice.
  async function record(sessionId, receiptId, input = {}) {
    const receipt = store.get('receipt', receiptId);
    const source = receipt && store.get('task', receipt.taskId);
    if (!receipt || !source || source.sessionId !== sessionId) return { action: 'none', decision: null };
    const plan = planAttributionAction({ mode: input.mode, relation: input.relation,
      targetTaskId: input.taskId || null, currentTaskId: input.currentTaskId || source.id });
    if (plan.action === 'none') return { action: 'none', decision: null };
    const id = idOf(receipt.shellId, receiptId, input.turnId);
    const existing = store.get('attr-decision', id);
    if (existing && existing.state !== 'failed') return { action: existing.action, decision: publicDecision(existing) };
    if (existing) store.remove('attr-decision', id);
    const row = { id, shellId: receipt.shellId, sessionId, receiptId, turnId: input.turnId || null,
      fromTaskId: source.id, toTaskId: plan.targetTaskId, taskName: input.taskName || null,
      relatedTaskId: input.relatedTaskId || null, relation: input.relation === 'new' ? 'new' : 'same',
      // A new identity is created through the shell cursor; naming an existing
      // task only re-attributes this turn.
      path: input.relation === 'new' ? 'identity' : 'overlay',
      mode: plan.mode, action: plan.action, reason: plan.reason,
      hidden: plan.action === 'record', state: 'pending', createdAt: now(), runId: input.runId || null,
      anchorMessageId: input.anchorMessageId || null };
    store.set('attr-decision', id, row);
    notify(sessionId);
    if (plan.action !== 'apply') return { action: plan.action, decision: publicDecision(row) };
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
        return store.transaction(() => {
          store.set('attr-decision', row.id, { ...row, state: 'applied', resolvedAt: now(),
            apply: { kind: 'identity', taskId: result.taskId, clientMsgId } });
          return store.get('attr-decision', row.id);
        });
      }
      const scope = deps.scopeOf?.(row.shellId);
      if (!scope) throw fail('task_shell_not_found', 'Task shell not found', 404);
      const operation = await operations.apply({ scope, clientMsgId,
        turns: [{ sessionId: row.sessionId, turnId: row.turnId }], target: { taskId: row.toTaskId } });
      return store.transaction(() => {
        store.set('attr-decision', row.id, { ...row, state: operation.status === 'applied' ? 'applied' : 'reverted',
          resolvedAt: now(), apply: { kind: 'overlay', operationId: operation.id, clientMsgId } });
        return store.get('attr-decision', row.id);
      });
    } catch (error) {
      store.set('attr-decision', row.id, { ...row, state: 'failed', lastError: String(error.message).slice(0, 200) });
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
    if (row.state !== 'pending') throw fail('attribution_decision_resolved', 'This suggestion is already resolved', 409);
    if (typeof clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(clientMsgId)) throw fail('invalid_input', 'invalid clientMsgId', 400);
    const pending = flights.get(row.id);
    if (pending) { await pending; return publicDecision(get(shellId, decisionId)); }
    const run = (async () => {
      if (deps.isTurnBusy?.(row.sessionId, row.turnId) === true) {
        throw fail('turn_busy', 'Wait for the running turn to finish before changing its attribution', 409);
      }
      const shell = store.get('shell', shellId);
      const existing = store.get('task', row.toTaskId);
      if (existing?.dirId && shell?.dirId && existing.dirId !== shell.dirId) throw fail('project_mismatch');
      return publicDecision(await applyRow(row, { clientMsgId }));
    })();
    flights.set(row.id, run);
    try { return await run; } finally { flights.delete(row.id); }
  }

  function dismiss(shellId, decisionId) {
    const row = get(shellId, decisionId);
    if (row.state === 'dismissed') return publicDecision(row);
    if (row.state !== 'pending') throw fail('attribution_decision_resolved', 'This suggestion is already resolved', 409);
    store.set('attr-decision', row.id, { ...row, state: 'dismissed', resolvedAt: now() });
    notify(row.sessionId);
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
    notify(row.sessionId);
    return publicDecision(store.get('attr-decision', row.id));
  }

  return { record, list, publicDecision, accept, dismiss, undo };
}

module.exports = { createAttributionDecisions };
