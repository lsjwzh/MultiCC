'use strict';
const { createHash } = require('node:crypto');
// Auxiliary classification is a proposal, never a writer/integration receipt.
// Keep the source IDs immutable and do not allocate task B at proposal time.
function createCandidateStore(store) {
  function propose(sessionId, receiptId, attribution) {
    const receipt = store.get('receipt', receiptId), source = receipt && store.get('task', receipt.taskId);
    if (!source || source.sessionId !== sessionId || !attribution.turnId) return { ok: false, code: 'candidate_source_unverified' };
    if (attribution.taskId === source.id) return { ok: true, changed: false };
    const shell = store.get('shell', receipt.shellId);
    const stale = shell?.cursorReceiptId !== receipt.id || shell?.currentTaskId !== source.id || shell?.cursorVersion !== receipt.cursorVersion;
    const target = store.get('task', attribution.taskId);
    if (target && target.dirId !== source.dirId) return { ok: false, code: 'project_mismatch' };
    const id = 'candidate_' + createHash('sha256').update(receiptId + '\0' + attribution.turnId).digest('hex').slice(0, 32);
    return store.transaction(() => {
      const old = store.get('attribution-candidate', id);
      if (old) return { ok: true, pending: true, candidate: old };
      const candidate = { id, sessionId, receiptId, sourceTaskId: source.id, directoryId: source.dirId,
        turnId: attribution.turnId, anchorMessageId: attribution.anchorMessageId || null,
        targetTaskId: target?.id || null, provisionalTargetId: target ? null : attribution.taskId,
        title: String(attribution.taskName || '').slice(0, 120), expectedCursorVersion: receipt.cursorVersion,
        state: stale ? 'stale' : 'pending', blockers: stale ? ['view_changed'] : ['final_run_result_required', 'integration_receipt_required', 'source_writer_barrier_required'], createdAt: Date.now() };
      store.set('attribution-candidate', id, candidate);
      return { ok: true, pending: true, candidate };
    });
  }
  function latest(taskId) {
    const candidate = store.list('attribution-candidate').filter(c => c.sourceTaskId === taskId).at(-1);
    if (!candidate) return null;
    const receipt = store.get('receipt', candidate.receiptId), shell = receipt && store.get('shell', receipt.shellId);
    if (!shell || shell.cursorReceiptId !== candidate.receiptId || shell.cursorVersion !== candidate.expectedCursorVersion) return { ...candidate, state: 'stale', blockers: ['view_changed'] };
    return candidate;
  }
  return { propose, latest };
}
module.exports = { createCandidateStore };
