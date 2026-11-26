'use strict';

// Server-owned projection for the Air delivery card. A fixed task is already
// attributed at admission; low-relevance work uses the user-confirmed
// task-separation saga. Clients render these independent facts and never infer
// a fourth stage from the CLI type or from a clean Git status.
async function deliveryView({ sessionId, taskId, candidate, separation, admission, cwd }) {
  const evidenceSessionId = separation?.sessionId || sessionId;
  const turnId = separation?.turnId || candidate?.turnId || null;
  const evidence = admission.deliveryEvidence(evidenceSessionId, turnId);
  const { run, integration, barrier, application } = evidence;
  let baseline = null;
  if (integration && cwd) {
    try { baseline = await admission.verifyBaseline(integration, cwd); } catch (_) {}
  }
  const runSucceeded = run?.outcome === 'succeeded' && !run.pendingInput;
  const codeObserved = !!run?.endCodeRevision;
  const codeChanged = codeObserved && run.startCodeRevision
    ? run.startCodeRevision !== run.endCodeRevision : null;
  const noCodeChange = codeChanged === false;
  // A confirmed task separation moves the source checkout — committed state
  // and uncommitted work alike — into the new task. It is deliberately not a
  // request to integrate source code into main, so showing “code has not been
  // merged” here is both misleading and a false blocker for a perfectly usable
  // new task.
  const workspaceSnapshot = separation?.deliveryKind === 'workspace_snapshot';
  const integrationCurrent = !!integration && baseline?.effectValid === true;
  const codeDelivered = workspaceSnapshot
    ? !!barrier && barrier.writersStopped === true
    : codeObserved && (noCodeChange || integrationCurrent);
  // A workspace-snapshot barrier freezes whatever the checkout holds *now*: the
  // revision that finished turn recorded is diagnostics there, because
  // AutoCommit and sibling sync move it in between. Delivery barriers keep the
  // strict revision equality.
  const barrierCurrent = !!barrier && barrier.turnId === run?.id && barrier.writersStopped === true
    && (workspaceSnapshot || barrier.codeRevision === run?.endCodeRevision);
  const separationApplied = separation?.state === 'separated' && !!application
    && application.separationId === separation.id && application.targetTaskId === separation.taskId;
  const fixedAttribution = !separation && !candidate && !!run && (!taskId || run.taskId === taskId);
  const kept = separation?.state === 'kept';

  const blockers = [];
  if (!separation && candidate?.state === 'stale') blockers.push('view_changed');
  if (!workspaceSnapshot) {
    if (!run) blockers.push('final_run_result_required');
    else {
      if (!runSucceeded) blockers.push('run_not_succeeded');
      if (!codeObserved) blockers.push('code_observation_required');
    }
    if (codeObserved && !noCodeChange) {
      if (!integration) blockers.push('integration_receipt_required');
      else if (!integrationCurrent) blockers.push('baseline_revalidation_required');
    }
  }
  if (!barrierCurrent) blockers.push('source_writer_barrier_required');
  if (separation && !kept && !separationApplied) blockers.push('separation_application_required');
  if (separation?.lastError?.code && !blockers.includes(separation.lastError.code)) blockers.push(separation.lastError.code);

  const step = (key, label, done, evidenceId = null, state = null) => ({
    key, label, status: done ? 'done' : state || 'pending', evidenceId,
  });
  const steps = [
    step('run', workspaceSnapshot ? '源会话已停写' : '本轮成功', workspaceSnapshot ? barrierCurrent : runSucceeded,
      workspaceSnapshot ? barrier?.id || null : run?.id || null,
      workspaceSnapshot ? (barrierCurrent ? null : 'blocked') : run && !runSucceeded ? 'blocked' : null),
    step('delivery', workspaceSnapshot ? '隔离基线已冻结' : '代码交付', codeDelivered,
      workspaceSnapshot ? barrier?.id || null : noCodeChange ? run?.id : integration?.id || null,
      workspaceSnapshot ? (codeDelivered ? null : 'blocked') : runSucceeded && !codeDelivered ? 'blocked' : null),
    step('barrier', '源现场稳定', barrierCurrent, barrier?.id || null,
      codeDelivered && !barrierCurrent ? 'blocked' : null),
    step('attribution', separation ? '分离生效' : '任务归属', separationApplied || fixedAttribution,
      application?.id || run?.receiptId || null, kept ? 'skipped' : null),
  ];

  return {
    mode: separation ? (kept ? 'kept' : separationApplied ? 'separated' : 'separation_pending')
      : candidate ? 'legacy_candidate' : 'fixed',
    candidate: candidate ? { ...candidate, blockers } : null,
    separation: separation ? { id: separation.id, state: separation.state, phase: separation.phase || null,
      sourceTaskId: separation.sourceTaskId, sourceTitle: separation.sourceTitle,
      targetTaskId: separation.taskId || null, targetTitle: separation.title,
      reason: separation.reason || '', deliveryKind: separation.deliveryKind || null,
      lastError: separation.lastError?.code ? { code: String(separation.lastError.code).slice(0, 100) } : null,
      result: separation.result || null } : null,
    blockers, steps,
    run: run ? { id: run.id, taskId: run.taskId, attemptId: run.attemptId, outcome: run.outcome,
      pendingInput: run.pendingInput, finishedAt: run.finishedAt, endDirty: run.endDirty,
      codeObserved, codeChanged, noCodeChange } : null,
    integration: integration ? { id: integration.id, operationId: integration.operationId,
      integrationHead: integration.integrationHead, baseRef: integration.baseRef,
      baselineCurrent: integrationCurrent } : null,
    barrier: barrierCurrent ? { id: barrier.id, verifiedAt: barrier.verifiedAt, dirty: barrier.dirty } : null,
    application: separationApplied ? { id: application.id, targetTaskId: application.targetTaskId,
      targetSessionId: application.targetSessionId, appliedAt: application.appliedAt } : null,
  };
}
module.exports = { deliveryView };
