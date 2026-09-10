'use strict';

// A projection of host evidence. Reading it never applies attribution, creates
// a target task, or manufactures a writer barrier from a clean Git status.
async function deliveryView({ sessionId, candidate, admission, cwd }) {
  const evidence = admission.deliveryEvidence(sessionId, candidate?.turnId);
  const { run, integration } = evidence;
  let baseline = null;
  if (integration && cwd) {
    try { baseline = await admission.verifyBaseline(integration, cwd); } catch (_) {}
  }
  const blockers = [];
  if (candidate?.state === 'stale') blockers.push('view_changed');
  if (!run) blockers.push('final_run_result_required');
  else {
    if (run.outcome !== 'succeeded' || run.pendingInput) blockers.push('run_not_succeeded');
    if (!run.endCodeRevision) blockers.push('code_observation_required');
  }
  if (!integration) blockers.push('integration_receipt_required');
  else if (baseline?.effectValid !== true) blockers.push('baseline_revalidation_required');
  blockers.push('source_writer_barrier_required');
  return { mode: 'retained', candidate: candidate ? { ...candidate, blockers } : null, blockers,
    run: run ? { id: run.id, attemptId: run.attemptId, outcome: run.outcome, pendingInput: run.pendingInput,
      finishedAt: run.finishedAt, endDirty: run.endDirty, codeObserved: !!run.endCodeRevision } : null,
    integration: integration ? { id: integration.id, operationId: integration.operationId,
      integrationHead: integration.integrationHead, baseRef: integration.baseRef,
      baselineCurrent: baseline?.effectValid === true } : null };
}
module.exports = { deliveryView };
