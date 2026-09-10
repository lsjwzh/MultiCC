'use strict';

const { createHash } = require('node:crypto');
const { createTaskFactsRepository } = require('./facts');
const { observeCodeRevision, captureCodeRevision } = require('./code-revision');
const { defaultRepoActor } = require('../repo-actor');
const fail = code => Object.assign(new Error(code), { code });
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

// Host-only journal. There is deliberately no HTTP write port for these facts.
function createDeliveryEvidence(store, { capture = captureCodeRevision, now = Date.now } = {}) {
  const facts = createTaskFactsRepository(store);
  const get = (kind, id) => store.get('delivery:' + kind, id);
  const put = (kind, id, value) => store.set('delivery:' + kind, id, value);
  function begin({ sessionId, turnId, taskId, receiptId = null, roleSnapshotId = null, workspaceId, workspacePath, baseRef }) {
    if (![sessionId, turnId, taskId, workspaceId, workspacePath, baseRef].every(x => typeof x === 'string' && x)) throw fail('run_identity_required');
    const binding = { sessionId, turnId, taskId, receiptId, roleSnapshotId, workspaceId, workspacePath, baseRef };
    return store.transaction(() => {
      const old = get('run', turnId);
      if (old) {
        if (JSON.stringify(old.binding) !== JSON.stringify(binding)) throw fail('run_binding_conflict');
        return old;
      }
      const run = { id: turnId, binding, state: 'running', attemptId: null, createdAt: now() };
      put('run', turnId, run); put('latest', sessionId, { runId: turnId }); return run;
    });
  }
  function attempt(turnId, attemptId) {
    return store.transaction(() => {
      const run = get('run', turnId);
      if (!run || run.state !== 'running' || !attemptId) throw fail('run_not_active');
      if (run.attemptId && run.attemptId !== attemptId) put('attempt', key(turnId, run.attemptId), { runId: turnId, attemptId: run.attemptId, outcome: 'superseded' });
      put('run', turnId, { ...run, attemptId });
    });
  }
  async function finalize(turnId, result) {
    const run = get('run', turnId); if (!run) return null;
    const prior = facts.getFact('run-result', turnId); if (prior) return prior;
    if (run.attemptId !== result.attemptId) throw fail('final_attempt_mismatch');
    let code = null, observationError = null;
    try { code = await capture(run.binding.workspacePath); }
    catch (error) { observationError = /^code_[a-z_]+$/.test(error.message) ? error.message : 'code_observation_failed'; }
    return store.transaction(() => {
      const current = get('run', turnId);
      if (current.attemptId !== result.attemptId || get('latest', run.binding.sessionId)?.runId !== turnId) throw fail('final_attempt_mismatch');
      const existing = facts.getFact('run-result', turnId); if (existing) return existing;
      const outcome = result.outcome === 'succeeded' && result.resultDurable === true && result.usageDurable === true && result.pendingInput === false
        ? 'succeeded' : ['failed', 'cancelled', 'waiting'].includes(result.outcome) ? result.outcome : 'unknown';
      const fact = { id: turnId, ...run.binding, attemptId: current.attemptId, outcome, attemptOutcome: outcome,
        finalized: true, evidencePersisted: true, superseded: false, pendingInput: result.pendingInput !== false,
        endCodeRevision: code?.revision || null, endHead: code?.head || null, repoId: code?.repoId || null,
        endDirty: code?.dirty ?? null, observationError, finishedAt: now() };
      facts.appendFact('run-result', fact);
      put('run', turnId, { ...current, state: 'finalized' });
      put('attempt', key(turnId, current.attemptId), { runId: turnId, attemptId: current.attemptId, outcome });
      correlate(fact); return fact;
    });
  }
  function correlate(run) {
    if (!run.endCodeRevision || !run.repoId) return null;
    const journals = store.list('delivery:merge').filter(j => j.state === 'published' && j.sessionId === run.sessionId
      && j.repoId === run.repoId && j.baseRef === run.baseRef
      && [j.sourceRevision, j.publishedRevision].includes(run.endCodeRevision));
    const journal = journals.at(-1); if (!journal) return null;
    const fact = { id: 'integration_' + key(run.id, run.attemptId, journal.id), operationId: journal.id,
      runId: run.id, attemptId: run.attemptId, workspaceId: run.workspaceId, repoId: run.repoId,
      coveredCodeRevision: run.endCodeRevision, sourceHead: journal.sourceHead, integrationHead: journal.integrationHead,
      baseRef: journal.baseRef, outcome: 'integrated', verified: true, revoked: false };
    return facts.appendFact('integration', fact);
  }
  function hooks(sessionId) {
    return {
      async prepared(input, execGit) {
        let code = null;
        try { code = await observeCodeRevision(input.worktreePath, execGit); } catch (_) {}
        if (code && (code.dirty || code.head !== input.sourceHead)) throw fail('merge_source_changed');
        const journal = { ...input, id: input.operationId, sessionId, repoId: code?.repoId || null,
          sourceRevision: code?.revision || null, publishedRevision: null, state: 'prepared', createdAt: now() };
        // Persist BEFORE publishing the base ref. Failure aborts the publish.
        store.transaction(() => {
          if (get('merge', journal.id)) throw fail('merge_operation_conflict');
          put('merge', journal.id, journal);
        });
      },
      async published(operationId, execGit) {
        const journal = get('merge', operationId); if (!journal) throw fail('merge_journal_missing');
        const base = await execGit(journal.dirPath, ['rev-parse', journal.baseRef]);
        if (base !== journal.integrationHead) throw fail('merge_publication_changed');
        const code = await observeCodeRevision(journal.dirPath, execGit);
        if (code.dirty || code.head !== journal.integrationHead || (journal.repoId && code.repoId !== journal.repoId)) throw fail('merge_publication_changed');
        return store.transaction(() => {
          const completed = { ...journal, repoId: code.repoId, publishedRevision: code.revision, state: 'published', publishedAt: now() };
          put('merge', operationId, completed);
          const latest = get('latest', sessionId);
          const run = latest && facts.getFact('run-result', latest.runId); if (run) correlate(run);
          return { operationId, state: 'published' };
        });
      },
    };
  }
  async function recover(sessionId) {
    const outcomes = [];
    for (const journal of store.list('delivery:merge').filter(j => j.sessionId === sessionId && j.state === 'prepared')) {
      const result = await defaultRepoActor.run(journal.dirPath, 'integration-reconcile', async ({ execGit }) => {
        try { return await hooks(sessionId).published(journal.id, execGit); }
        catch (_) { return { operationId: journal.id, state: 'unverified' }; }
      });
      outcomes.push(result);
    }
    return outcomes;
  }
  function summary(sessionId, turnId = null) {
    const id = turnId || get('latest', sessionId)?.runId;
    const run = id && facts.getFact('run-result', id);
    if (!run || run.sessionId !== sessionId) return { run: null, integration: null };
    const integration = store.list('task-first:integration').filter(i => i.runId === id && i.attemptId === run.attemptId).at(-1) || null;
    return { run, integration };
  }
  async function verifyBaseline(integration, cwd) {
    if (!integration) return null;
    return defaultRepoActor.run(cwd, 'integration-baseline', async ({ execGit }) => {
      const head = await execGit(cwd, ['rev-parse', integration.baseRef]);
      const common = require('node:fs').realpathSync(require('node:path').resolve(cwd, await execGit(cwd, ['rev-parse', '--git-common-dir'])));
      const repoId = 'repo_' + createHash('sha256').update(common).digest('hex').slice(0, 32);
      const valid = head === integration.integrationHead && repoId === integration.repoId;
      // A descendant may contain a revert. Equality is conservative until
      // effect validation exists; ancestry alone must never restore eligibility.
      return { receiptId: integration.id, repoId, baseRef: integration.baseRef,
        head, verified: valid, containsIntegration: valid, effectValid: valid };
    });
  }
  return { begin, attempt, finalize, hooks, recover, summary, verifyBaseline,
    deliveryFinalized: id => !!facts.getFact('run-result', id) };
}
module.exports = { createDeliveryEvidence };
