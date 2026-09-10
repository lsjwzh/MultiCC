'use strict';

// R2 policy over trusted, correlated host observations. This is a decision,
// never a filesystem lease or permission to mutate attribution. The eventual
// apply transaction must repeat the version checks while holding its guard.
const text = value => typeof value === 'string' && value.length > 0;
const version = value => Number.isSafeInteger(value) && value >= 0;
const same = (left, right) => text(left) && left === right;

function evaluateAttribution({ proposal, run, context, source, guard, integration, baseline, noCode } = {}) {
  const blockers = [];
  let stale = false;
  const requireFact = (condition, reason) => { if (!condition) blockers.push(reason); };
  const result = state => ({ state, eligible: state === 'ready', blockers: [...new Set(blockers)], requiresAtomicRecheck: true });
  if (!proposal || !run || !context) { blockers.push('facts_missing'); return result('pending'); }
  if (!['pending', 'ready'].includes(proposal.state)) {
    blockers.push('proposal_not_pending');
    return result(['applied', 'rejected', 'stale'].includes(proposal.state) ? proposal.state : 'pending');
  }
  requireFact(text(proposal.id) && text(proposal.sourceTaskId), 'proposal_identity_missing');
  requireFact(same(proposal.runId, run.id) && same(proposal.attemptId, run.attemptId)
    && same(proposal.sourceTaskId, run.taskId), 'run_identity_mismatch');
  requireFact(text(proposal.targetTaskId) !== text(proposal.provisionalTargetId), 'target_identity_invalid');
  requireFact(!text(proposal.targetTaskId) || proposal.targetTaskId !== proposal.sourceTaskId, 'target_is_source');
  requireFact(same(proposal.directoryId, context.sourceDirectoryId)
    && same(proposal.directoryId, context.targetDirectoryId), 'directory_mismatch');
  requireFact(context.authorized === true && context.targetValid === true, 'target_unavailable');
  requireFact(run.finalized === true && run.evidencePersisted === true, 'run_not_finalized');
  requireFact(run.outcome === 'succeeded' && run.attemptOutcome === 'succeeded'
    && run.pendingInput === false && run.superseded === false, 'run_not_succeeded');

  for (const key of ['cursorVersion', 'inputSequence']) {
    const expected = proposal['expected' + key[0].toUpperCase() + key.slice(1)];
    if (!version(expected) || !version(context[key])) blockers.push('view_version_missing');
    else if (expected !== context[key]) { stale = true; blockers.push('view_changed'); }
  }
  if (!same(context.currentTaskId, proposal.sourceTaskId) || !same(context.latestRunId, run.id)) {
    stale = true;
    blockers.push('source_advanced');
  }

  if (noCode?.kind === 'isolated-discussion') {
    requireFact(noCode.verified === true && same(noCode.runId, run.id)
      && same(noCode.attemptId, run.attemptId) && run.workspaceId === null
      && noCode.repositoryAccess === false && noCode.workspaceDependencies === false
      && noCode.untransferredArtifacts === false, 'no_code_exemption_unverified');
  } else {
    requireFact(text(run.workspaceId) && text(run.repoId) && text(run.baseRef)
      && same(proposal.expectedCodeRevision, run.endCodeRevision), 'code_identity_mismatch');
    requireFact(source && same(source.workspaceId, run.workspaceId)
      && same(source.repoId, run.repoId), 'source_identity_mismatch');
    requireFact(source?.dirty === false, 'source_dirty_or_unknown');
    requireFact(source?.unmergedCommits === 0, 'source_unmerged_or_unknown');
    requireFact(source?.untransferredFiles === 0, 'source_files_unaccounted');
    requireFact(source?.gitOperation === false && source?.supported === true, 'source_state_unsupported');
    requireFact(guard?.held === true && guard?.writersStopped === true
      && same(guard?.workspaceId, run.workspaceId) && text(guard?.token)
      && version(source?.version) && source.version === guard?.workspaceVersion, 'source_guard_unverified');
    requireFact(integration?.outcome === 'integrated' && integration?.verified === true
      && integration?.revoked === false && text(integration?.id)
      && text(integration?.sourceHead) && text(integration?.integrationHead)
      && same(integration?.runId, run.id) && same(integration?.attemptId, run.attemptId)
      && same(integration?.workspaceId, run.workspaceId) && same(integration?.repoId, run.repoId)
      && same(integration?.coveredCodeRevision, run.endCodeRevision)
      && same(integration?.baseRef, run.baseRef), 'integration_unverified');
    requireFact(baseline?.verified === true && baseline?.containsIntegration === true
      && baseline?.effectValid === true && same(baseline?.receiptId, integration?.id)
      && same(baseline?.repoId, run.repoId) && same(baseline?.baseRef, run.baseRef)
      && text(baseline?.head), 'baseline_unverified');
  }
  return result(stale ? 'stale' : blockers.length ? 'pending' : 'ready');
}

module.exports = { evaluateAttribution };
