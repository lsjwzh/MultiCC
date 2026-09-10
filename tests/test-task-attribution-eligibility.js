'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAttribution } = require('../src/task-routing/eligibility');

function facts() {
  return {
    proposal: { id:'p1', state:'pending', runId:'r1', attemptId:'a1', sourceTaskId:'A', targetTaskId:'B',
      directoryId:'d1', expectedCursorVersion:2, expectedInputSequence:3, expectedCodeRevision:'code1' },
    run: { id:'r1', attemptId:'a1', taskId:'A', outcome:'succeeded', attemptOutcome:'succeeded', finalized:true,
      evidencePersisted:true, pendingInput:false, superseded:false, workspaceId:'w1', repoId:'repo1', baseRef:'main', endCodeRevision:'code1' },
    context: { sourceDirectoryId:'d1', targetDirectoryId:'d1', authorized:true, targetValid:true,
      cursorVersion:2, inputSequence:3, currentTaskId:'A', latestRunId:'r1' },
    source: { workspaceId:'w1', repoId:'repo1', version:4, dirty:false, unmergedCommits:0,
      untransferredFiles:0, gitOperation:false, supported:true },
    guard: { held:true, writersStopped:true, workspaceId:'w1', workspaceVersion:4, token:'guard1' },
    integration: { id:'i1', outcome:'integrated', verified:true, revoked:false, runId:'r1', attemptId:'a1',
      workspaceId:'w1', repoId:'repo1', coveredCodeRevision:'code1', sourceHead:'head1', integrationHead:'merge1', baseRef:'main' },
    baseline: { receiptId:'i1', repoId:'repo1', baseRef:'main', verified:true, head:'merge1', containsIntegration:true, effectValid:true },
  };
}

test('R2 successful integrated stable turn becomes a decision, not mutation authority', () => {
  const input = facts(); const before = structuredClone(input);
  assert.deepEqual(evaluateAttribution(input), {state:'ready', eligible:true, blockers:[], requiresAtomicRecheck:true});
  assert.deepEqual(input, before);
});

const rejectedCases = [
  ['success without merge', x => { delete x.integration; }, 'integration_unverified'],
  ['merged but failed', x => { x.run.outcome = 'error'; }, 'run_not_succeeded'],
  ['completed slot is not success', x => { x.run.outcome = 'completed'; }, 'run_not_succeeded'],
  ['cancelled attempt', x => { x.run.attemptOutcome = 'cancelled'; }, 'run_not_succeeded'],
  ['superseded attempt', x => { x.run.superseded = true; }, 'run_not_succeeded'],
  ['waiting question', x => { x.run.pendingInput = true; }, 'run_not_succeeded'],
  ['history not durable', x => { x.run.evidencePersisted = false; }, 'run_not_finalized'],
  ['receipt from other run', x => { x.integration.runId = 'other'; }, 'integration_unverified'],
  ['receipt from other attempt', x => { x.integration.attemptId = 'other'; }, 'integration_unverified'],
  ['receipt covers older code', x => { x.integration.coveredCodeRevision = 'old'; }, 'integration_unverified'],
  ['new dirty content after merge', x => { x.source.dirty = true; }, 'source_dirty_or_unknown'],
  ['unintegrated commits', x => { x.source.unmergedCommits = 1; }, 'source_unmerged_or_unknown'],
  ['ignored business files', x => { x.source.untransferredFiles = 1; }, 'source_files_unaccounted'],
  ['unknown dirty status', x => { delete x.source.dirty; }, 'source_dirty_or_unknown'],
  ['unknown writer after last comparison', x => { x.guard.writersStopped = false; }, 'source_guard_unverified'],
  ['guard stale after new source version', x => { x.source.version++; }, 'source_guard_unverified'],
  ['guard from another workspace', x => { x.guard.workspaceId = 'w2'; }, 'source_guard_unverified'],
  ['reverted integration still reachable', x => { x.baseline.effectValid = false; }, 'baseline_unverified'],
  ['wrong baseline receipt', x => { x.baseline.receiptId = 'other'; }, 'baseline_unverified'],
  ['wrong target branch', x => { x.integration.baseRef = 'release'; }, 'integration_unverified'],
  ['different directory', x => { x.context.targetDirectoryId = 'd2'; }, 'directory_mismatch'],
  ['permission revoked', x => { x.context.authorized = false; }, 'target_unavailable'],
  ['missing view versions', x => { delete x.context.cursorVersion; }, 'view_version_missing'],
  ['string false is unknown', x => { x.source.dirty = 'false'; }, 'source_dirty_or_unknown'],
  ['conflicting provisional and final target', x => { x.proposal.provisionalTargetId = 'new1'; }, 'target_identity_invalid'],
];
for (const [name, mutate, reason] of rejectedCases) test(name, () => {
  const input = facts(); mutate(input); const result = evaluateAttribution(input);
  assert.equal(result.eligible, false); assert.equal(result.state, 'pending'); assert.ok(result.blockers.includes(reason));
});

test('new accepted input and navigation independently expire the candidate', () => {
  for (const mutate of [x=>x.context.inputSequence++, x=>x.context.cursorVersion++,
    x=>{x.context.latestRunId='r2';}, x=>{x.context.currentTaskId='C';}]) {
    const input=facts(); mutate(input); assert.equal(evaluateAttribution(input).state,'stale');
  }
});
test('unknown or absent facts never accidentally satisfy the gate', () => {
  for (const input of [undefined, {}, {proposal:{state:'pending'},run:{},context:{}}]) assert.equal(evaluateAttribution(input).eligible,false);
});
test('target busy or dirty is a separate readiness check after source attribution', () => {
  const input=facts(); input.context.targetBusy=true; input.context.targetDirty=true;
  assert.equal(evaluateAttribution(input).state,'ready');
});
test('normal sync-back HEAD and later base advancement do not require a second merge', () => {
  const input=facts(); input.source.head='merge1'; input.baseline.head='later-main';
  assert.equal(evaluateAttribution(input).state,'ready');
});
test('verified no-code mode bypasses only code delivery, never run success or navigation', () => {
  const input=facts(); input.run.workspaceId=null;
  input.noCode={kind:'isolated-discussion',verified:true,runId:'r1',attemptId:'a1',repositoryAccess:false,
    workspaceDependencies:false,untransferredArtifacts:false};
  delete input.source; delete input.guard; delete input.integration; delete input.baseline;
  assert.equal(evaluateAttribution(input).state,'ready');
  input.noCode.workspaceDependencies=true;
  assert.ok(evaluateAttribution(input).blockers.includes('no_code_exemption_unverified'));
  input.noCode.workspaceDependencies=false; input.run.outcome='error';
  assert.equal(evaluateAttribution(input).eligible,false);
});
test('declaring discussion cannot exempt a real workspace run', () => {
  const input=facts(); input.noCode={kind:'isolated-discussion',verified:true,runId:'r1',attemptId:'a1',
    repositoryAccess:false,workspaceDependencies:false,untransferredArtifacts:false};
  assert.equal(evaluateAttribution(input).eligible,false);
});
test('terminal proposal replay cannot apply it again', () => {
  for (const state of ['applied','rejected','stale']) {
    const input=facts();input.proposal.state=state;const r=evaluateAttribution(input);
    assert.equal(r.state,state);assert.equal(r.eligible,false);
  }
});
