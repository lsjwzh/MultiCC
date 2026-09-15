'use strict';
const { renderPrompt } = require('../message-composer');
function prepareManagedContext({ host, memory, sessionName, persisted, turn, opts, text, isFirstTurn }) {
  const input = { receiptId: opts.taskShellReceiptId, turnId: turn.turnId, text,
    isFirstTurn, fallback: opts.taskContextSeed, memory };
  if (!input.receiptId || !host?.prepareTaskContext) return null;
  let plan = host.prepareTaskContext(sessionName, input);
  if (!plan) return null;
  turn.managedContext = { receiptId: input.receiptId, sessionName, host };
  return {
    seed: plan.text,
    rolePrompt: record => memory.resolveRolePrompt(record, { managed: true }),
    attempt(envelope, options) {
      if (options.firstTurn === true) {
        if (!plan.initial) plan = host.prepareTaskContext(sessionName, { ...input, isFirstTurn: true, force: true });
        const updated = { ...envelope, contextLayers: envelope.contextLayers.filter(l => l.kind !== 'task-context') };
        if (plan.text) updated.contextLayers.push({ kind: 'task-context', order: 12, text: plan.text });
        return { ...options, bareText: renderPrompt(updated) };
      }
      return options;
    },
  };
}
function contextSent(turn) {
  const ref = turn.managedContext;
  if (ref) ref.host.taskContextSent(ref.sessionName, ref.receiptId, turn.turnId);
}
function contextCompleted(context, resolved) {
  const { turn } = context, ref = turn.managedContext;
  if (!ref) return;
  const success = !context.terminalBlocked && resolved.effects.some(e => e.type === 'classify-turn-end' && e.classification === 'succeeded');
  ref.host.taskContextComplete(ref.sessionName, ref.receiptId, turn.turnId, success);
}
module.exports = { prepareManagedContext, contextSent, contextCompleted };
