'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTaskShellStore } = require('../src/task-shell/store');
const { createDeliveryEvidence } = require('../src/task-routing/evidence');
const { captureCodeRevision } = require('../src/task-routing/code-revision');
const { gitMergeBack } = require('../src/git/service');
const { deliveryView } = require('../src/task-routing/delivery-view');

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-evidence-'));
  const repo = path.join(root, 'repo'), wt = path.join(root, 'worktree'); fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(repo, 'worktree', 'add', '-b', 'multicc/test', wt);
  const file = path.join(root, 'facts.sqlite'), stores = [];
  const open = () => { const s = createTaskShellStore(file); stores.push(s); return s; };
  const store = open(), evidence = createDeliveryEvidence(store, extra);
  t.after(() => { for (const s of stores) s.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const dir = { id: 'd', path: repo, baseBranch: 'main' }, session = { id: 's', branch: 'multicc/test', worktreePath: wt };
  const begin = (id = 'turn1', binding = {}) => {
    evidence.begin({ sessionId: 's', turnId: id, taskId: 'A', receiptId: 'receipt1', workspaceId: 'w', workspacePath: wt, baseRef: 'main', ...binding });
    evidence.attempt(id, 'attempt1');
  };
  const finish = (id = 'turn1', result = {}) => evidence.finalize(id, { attemptId: 'attempt1', outcome: 'succeeded', resultDurable: true, usageDurable: true, pendingInput: false, ...result });
  const merge = opts => gitMergeBack(dir, session, { evidence: evidence.hooks('s'), ...opts });
  const admission = { deliveryEvidence: (id, turnId) => evidence.summary(id, turnId), verifyBaseline: evidence.verifyBaseline };
  return { root, repo, wt, git, store, open, evidence, begin, finish, merge, admission };
}

test('code observations preserve partial staging, HEAD, binary/untracked names and symlinks', async t => {
  const f = fixture(t), target = path.join(f.wt, 'base.txt');
  fs.writeFileSync(target, 'staged\n'); f.git(f.wt, 'add', 'base.txt'); fs.writeFileSync(target, 'unstaged\n');
  fs.writeFileSync(path.join(f.wt, ' leading\nname.bin'), Buffer.from([0, 1, 255]));
  fs.symlinkSync('missing-target', path.join(f.wt, 'link'));
  const index = f.git(f.wt, 'rev-parse', '--git-path', 'index'), before = fs.readFileSync(index), head = f.git(f.wt, 'rev-parse', 'HEAD');
  const first = await captureCodeRevision(f.wt);
  assert.equal(first.dirty, true); assert.equal(first.writersStopped, false);
  assert.deepEqual(fs.readFileSync(index), before); assert.equal(f.git(f.wt, 'rev-parse', 'HEAD'), head);
  f.git(f.wt, 'add', '-A'); f.git(f.wt, 'commit', '-m', 'all');
  assert.equal((await captureCodeRevision(f.wt)).revision, first.revision);
  fs.writeFileSync(target, 'later\n'); assert.notEqual((await captureCodeRevision(f.wt)).revision, first.revision);
});

test('a removed tracked directory is included as deletion without changing the real index', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.wt, 'gone')); fs.writeFileSync(path.join(f.wt, 'gone/file'), 'x');
  f.git(f.wt, 'add', '.'); f.git(f.wt, 'commit', '-m', 'nested'); fs.rmSync(path.join(f.wt, 'gone'), { recursive: true });
  const before = await captureCodeRevision(f.wt); f.git(f.wt, 'add', '-A'); f.git(f.wt, 'commit', '-m', 'removed');
  assert.equal((await captureCodeRevision(f.wt)).revision, before.revision);
});

test('hidden tracked changes under assume-unchanged or skip-worktree never mint a code version', async t => {
  const f = fixture(t);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    f.git(f.wt, 'update-index', '--' + flag, 'base.txt');
    await assert.rejects(captureCodeRevision(f.wt), /code_index_unsupported/);
    f.git(f.wt, 'update-index', '--no-' + flag, 'base.txt');
  }
});

test('gitlinks (submodule pointers) are observed, not rejected, and nested repo edits change the revision', async t => {
  const f = fixture(t), sub = path.join(f.root, 'sub'); fs.mkdirSync(sub);
  f.git(sub, 'init', '-b', 'main'); f.git(sub, 'config', 'user.name', 'Test'); f.git(sub, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(sub, 'inner.txt'), 'inner\n'); f.git(sub, 'add', '.'); f.git(sub, 'commit', '-m', 'inner');
  const oid = f.git(sub, 'rev-parse', 'HEAD');
  f.git(f.wt, 'update-index', '--add', '--cacheinfo', `160000,${oid},vendor/sub`); f.git(f.wt, 'commit', '-m', 'gitlink');
  // A fresh worktree never checks the gitlink out: the path is absent.
  const absent = await captureCodeRevision(f.wt);
  assert.equal((await captureCodeRevision(f.wt)).revision, absent.revision);
  fs.mkdirSync(path.join(f.wt, 'vendor/sub'), { recursive: true });
  const empty = await captureCodeRevision(f.wt); assert.notEqual(empty.revision, absent.revision);
  fs.rmSync(path.join(f.wt, 'vendor/sub'), { recursive: true });
  f.git(path.join(f.wt, 'vendor'), 'clone', '-q', sub, 'sub');
  const cloned = await captureCodeRevision(f.wt);
  fs.writeFileSync(path.join(f.wt, 'vendor/sub/inner.txt'), 'edited\n');
  assert.notEqual((await captureCodeRevision(f.wt)).revision, cloned.revision);
  fs.rmSync(path.join(f.wt, 'vendor/sub'), { recursive: true }); fs.mkdirSync(path.join(f.wt, 'vendor/sub'));
  fs.writeFileSync(path.join(f.wt, 'vendor/sub/plain.txt'), 'not a repository\n');
  await assert.rejects(captureCodeRevision(f.wt), /code_index_unsupported/);
});

test('dirty final code can be integrated later, with matching immutable receipt after reopen', async t => {
  const f = fixture(t); f.begin(); fs.writeFileSync(path.join(f.wt, 'delivery.txt'), 'result');
  const run = await f.finish(); assert.equal(run.outcome, 'succeeded'); assert.equal(run.endDirty, true);
  assert.equal(f.evidence.summary('s').integration, null);
  const merged = await f.merge(); assert.equal(merged.ok, true); assert.equal(merged.deliveryEvidence.state, 'published');
  const reopened = createDeliveryEvidence(f.open()), receipt = reopened.summary('s').integration;
  assert.equal(receipt.coveredCodeRevision, run.endCodeRevision); assert.equal(receipt.attemptId, 'attempt1');
  assert.equal(receipt.integrationHead, f.git(f.repo, 'rev-parse', 'main'));
  assert.equal((await reopened.verifyBaseline(receipt, f.repo)).effectValid, true);
});

test('merge during a run is correlated after finalization, including base changes synced back', async t => {
  const f = fixture(t); f.begin(); fs.writeFileSync(path.join(f.repo, 'other.txt'), 'other');
  f.git(f.repo, 'add', '.'); f.git(f.repo, 'commit', '-m', 'other delivery');
  fs.writeFileSync(path.join(f.wt, 'own.txt'), 'own'); await f.merge();
  const run = await f.finish(), receipt = f.evidence.summary('s').integration;
  assert.ok(receipt); assert.equal(receipt.coveredCodeRevision, run.endCodeRevision);
});

test('explicit merge verification of unchanged code produces a receipt without a new commit', async t => {
  const f = fixture(t); f.begin(); await f.finish(); const head = f.git(f.repo, 'rev-parse', 'HEAD');
  const result = await f.merge(); assert.equal(result.merged, false); assert.equal(result.deliveryEvidence.state, 'published');
  assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), head); assert.ok(f.evidence.summary('s').integration);
});

test('changes after a merge cannot reuse that earlier integration receipt', async t => {
  const f = fixture(t); f.begin(); fs.writeFileSync(path.join(f.wt, 'own.txt'), 'first'); await f.merge();
  fs.writeFileSync(path.join(f.wt, 'own.txt'), 'second'); await f.finish();
  assert.equal(f.evidence.summary('s').integration, null);
});

test('retry finality is bound to the final attempt; stale completion cannot overwrite it', async t => {
  const f = fixture(t); f.begin(); f.evidence.attempt('turn1', 'attempt2');
  await assert.rejects(f.finish(), { code: 'final_attempt_mismatch' });
  const final = await f.finish('turn1', { attemptId: 'attempt2' }); assert.equal(final.attemptId, 'attempt2');
  assert.deepEqual(await f.finish('turn1', { attemptId: 'attempt2' }), final);
  assert.equal(f.store.list('delivery:attempt').find(a => a.attemptId === 'attempt1').outcome, 'superseded');
});

test('scheduler completed, failed, cancelled, waiting or nondurable results never imply succeeded', async t => {
  const f = fixture(t);
  const cases = [{ outcome: 'completed' }, { outcome: 'failed' }, { outcome: 'cancelled' }, { outcome: 'waiting', pendingInput: true }, { resultDurable: false }, { usageDurable: false }];
  for (let i = 0; i < cases.length; i++) { f.begin('turn' + i); const result = await f.finish('turn' + i, cases[i]); assert.notEqual(result.outcome, 'succeeded'); }
});

test('observation failure records a result without inventing a code version', async t => {
  const f = fixture(t, { capture: async () => { throw new Error('code_observation_limit'); } }); f.begin();
  const run = await f.finish(); assert.equal(run.outcome, 'succeeded'); assert.equal(run.endCodeRevision, null);
  assert.equal(run.observationError, 'code_observation_limit'); assert.equal(f.evidence.summary('s').integration, null);
});

test('prepublish journal failure prevents publishing main and retains the source commit', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.wt, 'own.txt'), 'own'); const before = f.git(f.repo, 'rev-parse', 'HEAD');
  const result = await f.merge({ evidence: { prepared: async () => { throw new Error('disk unavailable'); } } });
  assert.equal(result.ok, false); assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(f.wt, 'own.txt'), 'utf8'), 'own');
});

test('publish followed by receipt loss recovers with no second merge or rewritten run', async t => {
  const f = fixture(t); f.begin(); fs.writeFileSync(path.join(f.wt, 'own.txt'), 'own'); await f.finish();
  const hooks = f.evidence.hooks('s');
  const result = await f.merge({ evidence: { ...hooks, published: async () => { throw new Error('connection lost'); } } });
  assert.equal(result.ok, true); assert.equal(result.deliveryEvidence.state, 'unverified');
  const head = f.git(f.repo, 'rev-parse', 'HEAD'), run = f.evidence.summary('s').run;
  const reopened = createDeliveryEvidence(f.open()); assert.equal((await reopened.recover('s'))[0].state, 'published');
  assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), head); assert.deepEqual(reopened.summary('s').run, run);
  assert.ok(reopened.summary('s').integration); assert.deepEqual(await reopened.recover('s'), []);
});

test('a revert/advanced baseline cannot be validated merely by ancestor membership', async t => {
  const f = fixture(t); f.begin(); fs.writeFileSync(path.join(f.wt, 'own.txt'), 'own'); await f.finish(); await f.merge();
  const receipt = f.evidence.summary('s').integration;
  f.git(f.repo, 'revert', '-m', '1', '--no-edit', receipt.integrationHead);
  f.git(f.repo, 'merge-base', '--is-ancestor', receipt.integrationHead, 'main');
  assert.equal((await f.evidence.verifyBaseline(receipt, f.repo)).effectValid, false);
});

test('a cloned repository with the same commit is not the receipt repository identity', async t => {
  const f = fixture(t); f.begin(); await f.finish(); await f.merge();
  const receipt = f.evidence.summary('s').integration, clone = path.join(f.root, 'clone');
  f.git(f.root, 'clone', f.repo, clone);
  assert.equal(f.git(clone, 'rev-parse', 'HEAD'), receipt.integrationHead);
  assert.equal((await f.evidence.verifyBaseline(receipt, clone)).effectValid, false);
});

test('Air projects actual result, integration and writer barrier as independent steps', async t => {
  const f = fixture(t); f.begin(); fs.writeFileSync(path.join(f.wt, 'own.txt'), 'own'); await f.finish(); await f.merge();
  const code = await captureCodeRevision(f.wt);
  f.evidence.recordWriterBarrier({ sessionId: 's', turnId: 'turn1', workspaceId: 'w',
    leaseId: 'lease-1', generation: 1, code });
  const candidate = { turnId: 'turn1', state: 'stale', title: 'New task' };
  const view = await deliveryView({ sessionId: 's', candidate, admission: f.admission, cwd: f.repo });
  assert.equal(view.run.outcome, 'succeeded'); assert.equal(view.integration.baselineCurrent, true);
  assert.deepEqual(view.blockers, ['view_changed']);
  assert.deepEqual(view.steps.map(step => step.status), ['done', 'done', 'done', 'pending']);
  assert.equal(view.mode, 'legacy_candidate'); assert.equal(f.store.list('task').length, 0);
});

test('fixed task attribution and no-code delivery complete all four steps without a merge receipt', async t => {
  const f = fixture(t), start = await captureCodeRevision(f.wt);
  f.begin('turn1', { startCodeRevision: start.revision, startHead: start.head, startDirty: start.dirty });
  await f.finish();
  const code = await captureCodeRevision(f.wt);
  f.evidence.recordWriterBarrier({ sessionId: 's', turnId: 'turn1', workspaceId: 'w',
    leaseId: 'lease-fixed', generation: 1, code });
  const view = await deliveryView({ sessionId: 's', taskId: 'A', admission: f.admission, cwd: f.repo });
  assert.equal(view.run.noCodeChange, true);
  assert.equal(view.integration, null);
  assert.deepEqual(view.blockers, []);
  assert.deepEqual(view.steps.map(step => [step.label, step.status]), [
    ['本轮成功', 'done'], ['代码交付', 'done'], ['源现场稳定', 'done'], ['任务归属', 'done'],
  ]);
});

test('a separation application receipt is required before the fourth step can complete', async t => {
  let clock = 100;
  const f = fixture(t, { now: () => clock++ }), start = await captureCodeRevision(f.wt);
  f.begin('turn1', { startCodeRevision: start.revision, startHead: start.head, startDirty: start.dirty });
  await f.finish();
  const code = await captureCodeRevision(f.wt);
  const barrierInput = { sessionId: 's', turnId: 'turn1', separationId: 'sep-1',
    workspaceId: 'w', leaseId: 'lease-separate', generation: 2, code };
  const barrier = f.evidence.recordWriterBarrier(barrierInput);
  assert.deepEqual(f.evidence.recordWriterBarrier(barrierInput), barrier,
    'a repeated stop confirmation must reuse its immutable writer barrier');
  assert.equal(f.store.list('task-first:writer-barrier').length, 1);
  const separation = { id: 'sep-1', sessionId: 's', turnId: 'turn1', sourceTaskId: 'A',
    sourceTitle: 'Source', taskId: 'B', title: 'Independent', state: 'pending', phase: 'indexing_task' };
  const pending = await deliveryView({ sessionId: 's', taskId: 'A', separation, admission: f.admission, cwd: f.repo });
  assert.deepEqual(pending.steps.map(step => step.status), ['done', 'done', 'done', 'pending']);
  assert.ok(pending.blockers.includes('separation_application_required'));
  const applicationInput = { separationId: 'sep-1', sourceSessionId: 's', sourceTaskId: 'A',
    targetTaskId: 'B', targetSessionId: 'task-b', targetShellId: 'shell-b', turnId: 'turn1', barrierId: barrier.id };
  assert.throws(() => f.evidence.recordSeparationApplication(applicationInput), { code: 'separation_application_unverified' });
  f.store.set('task', 'B', { id: 'B', sessionId: 'task-b', ownerShellId: 'shell-b',
    separatedFromTaskId: 'A', ready: true });
  f.store.set('shell', 'shell-b', { id: 'shell-b', sourceSessionId: 'task-b', currentTaskId: 'B',
    defaultTaskId: 'B', standalone: true });
  f.store.set('link', 'shell-b:B', { shellId: 'shell-b', taskId: 'B' });
  const application = f.evidence.recordSeparationApplication(applicationInput);
  assert.deepEqual(f.evidence.recordSeparationApplication(applicationInput), application,
    'a crash after the immutable application write must be safely retryable');
  assert.equal(f.store.list('task-first:separation-application').length, 1);
  const applied = await deliveryView({ sessionId: 's', taskId: 'A',
    separation: { ...separation, state: 'separated', phase: 'applied' }, admission: f.admission, cwd: f.repo });
  assert.equal(applied.mode, 'separated'); assert.deepEqual(applied.blockers, []);
  assert.deepEqual(applied.steps.map(step => step.status), ['done', 'done', 'done', 'done']);
  assert.equal(applied.application.targetTaskId, 'B');
});

test('a workspace-snapshot separation does not masquerade as an unmerged delivery', async t => {

  const f = fixture(t), start = await captureCodeRevision(f.wt);
  f.begin('turn-waiting', { startCodeRevision: start.revision, startHead: start.head, startDirty: start.dirty });
  fs.writeFileSync(path.join(f.wt, 'isolated.txt'), 'snapshot');
  const run = await f.finish('turn-waiting', { outcome: 'waiting', pendingInput: true });
  f.git(f.wt, 'add', '.'); f.git(f.wt, 'commit', '-m', 'source snapshot');
  const code = await captureCodeRevision(f.wt);
  const barrier = f.evidence.recordWriterBarrier({ sessionId: 's', turnId: 'turn-waiting', separationId: 'sep-snapshot',
    workspaceId: 'w', leaseId: 'lease-snapshot', generation: 1, code });
  const separation = { id: 'sep-snapshot', sessionId: 's', turnId: 'turn-waiting', sourceTaskId: 'A',
    sourceTitle: 'Source', taskId: 'B', title: 'Independent', state: 'pending', phase: 'indexing_task',
    deliveryKind: 'workspace_snapshot' };
  const view = await deliveryView({ sessionId: 's', taskId: 'A', separation, admission: f.admission, cwd: f.repo });
  assert.equal(run.outcome, 'waiting');
  assert.equal(view.integration, null);
  assert.deepEqual(view.blockers, ['separation_application_required']);
  assert.deepEqual(view.steps.map(step => [step.label, step.status]), [
    ['源会话已停写', 'done'], ['隔离基线已冻结', 'done'], ['源现场稳定', 'done'], ['分离生效', 'pending'],
  ]);
  assert.equal(barrier.dirty, false);
});

test('a separation barrier takes the checkout as it is now, not the revision the finished turn wrote down', async t => {
  const f = fixture(t), start = await captureCodeRevision(f.wt);
  f.begin('turn1', { startCodeRevision: start.revision, startHead: start.head, startDirty: start.dirty });
  const run = await f.finish();
  // AutoCommit / sibling sync moved the worktree on between the verdict and the
  // user's click — the exact production race that used to report
  // barrier_code_changed and park the suggestion as blocked.
  fs.writeFileSync(path.join(f.wt, 'later.txt'), 'later work\n');
  const code = await captureCodeRevision(f.wt);
  assert.notEqual(code.revision, run.endCodeRevision, 'the fixture must really drift');
  assert.equal(code.dirty, true);
  const barrier = f.evidence.recordWriterBarrier({ sessionId: 's', turnId: 'turn1', separationId: 'sep-drift',
    workspaceId: 'w', leaseId: 'lease-drift', generation: 1, code });
  assert.equal(barrier.codeRevision, code.revision);
  assert.equal(barrier.runEndRevision, run.endCodeRevision);
  assert.equal(barrier.revisionDrifted, true);
  assert.equal(barrier.dirty, true, 'the moved snapshot is allowed to be dirty');
  const separation = { id: 'sep-drift', sessionId: 's', turnId: 'turn1', sourceTaskId: 'A',
    sourceTitle: 'Source', taskId: 'B', title: 'Independent', state: 'pending', phase: 'indexing_task',
    deliveryKind: 'workspace_snapshot' };
  const view = await deliveryView({ sessionId: 's', taskId: 'A', separation, admission: f.admission, cwd: f.repo });
  assert.deepEqual(view.blockers, ['separation_application_required']);
  assert.equal(view.barrier.dirty, true);
  assert.deepEqual(view.steps.map(step => [step.label, step.status]), [
    ['源会话已停写', 'done'], ['隔离基线已冻结', 'done'], ['源现场稳定', 'done'], ['分离生效', 'pending'],
  ]);
  // The turn-end barrier keeps the strict equality: a writer that ran past the
  // drain must still be reported instead of silently accepted.
  assert.throws(() => f.evidence.recordWriterBarrier({ sessionId: 's', turnId: 'turn1',
    workspaceId: 'w', leaseId: 'lease-turn-end', generation: 1, code }), { code: 'barrier_code_changed' });
});

test('a separation barrier still records when the turn-end observation never produced a revision', async t => {
  // The production report came from a turn whose own revision capture failed
  // (AutoCommit writing during the observation). The run then records no
  // revision at all, and refusing the transfer for that would block separation
  // for a reason the user can neither see nor fix.
  const f = fixture(t, { capture: async () => { throw new Error('code_changed_during_observation'); } });
  f.begin();
  const run = await f.finish();
  assert.equal(run.endCodeRevision, null);
  assert.equal(run.repoId, null);
  const code = await captureCodeRevision(f.wt);
  const barrier = f.evidence.recordWriterBarrier({ sessionId: 's', turnId: 'turn1', separationId: 'sep-unobserved',
    workspaceId: 'w', leaseId: 'lease-unobserved', generation: 1, code });
  assert.equal(barrier.codeRevision, code.revision);
  assert.equal(barrier.runEndRevision, null);
  assert.equal(barrier.revisionDrifted, null, 'no recorded revision means there is nothing to drift from');
  assert.equal(barrier.writersStopped, true);
});


const legacyDeliveryView = require('./helpers/legacy-delivery-view').deliveryView;

test('delivery projection matches the frozen ec1dcd19 view across evidence and separation states', async t => {
  const r = { id: 'turn', taskId: 'task', outcome: 'succeeded', receiptId: 'receipt',
    startCodeRevision: 'a', endCodeRevision: 'b', pendingInput: false };
  const b = { id: 'barrier', turnId: 'turn', writersStopped: true, codeRevision: 'b' };
  const s = { id: 'sep', state: 'separated', taskId: 'target', result: { moved: true } };
  const app = { id: 'applied', separationId: 'sep', targetTaskId: 'target' };
  const candidate = { state: 'stale', detail: { source: 'legacy' } };
  let count = 0;
  for (const run of [null, r, { ...r, pendingInput: true }, { ...r, outcome: 'failed' },
    { ...r, endCodeRevision: 'a', id: 0 }, { ...r, startCodeRevision: null }, { ...r, endCodeRevision: '' }]) {
    for (const barrier of [undefined, b, { ...b, writersStopped: 1 }, { ...b, codeRevision: 'a' }, { ...b, turnId: 'old' }]) {
      for (const integration of [null, { id: 'merge' }]) {
        for (const effectValid of [false, true, 1]) {
          for (const separation of [null, s, { ...s, state: 'kept' }, { ...s, state: 'pending' },
            { ...s, deliveryKind: 'workspace_snapshot' }, { ...s, lastError: { code: 'source_writer_barrier_required' } }]) {
            for (const application of [null, app]) {
              for (const c of [undefined, candidate]) {
                const params = { sessionId: 's', taskId: 'task', candidate: c, separation, cwd: '.',
                  admission: { deliveryEvidence: () => ({ run, barrier, integration, application }), verifyBaseline: () => ({ effectValid }) } };
                const expected = await legacyDeliveryView(params);
                const actual = await deliveryView(params);
                assert.deepEqual(actual, expected);
                if (c) {
                  assert.equal(actual.candidate.blockers, actual.blockers);
                  assert.equal(actual.candidate.detail, c.detail);
                }
                if (separation) assert.equal(actual.separation.result, separation.result);
                count++;
              }
            }
          }
        }
      }
    }
  }
  t.diagnostic(`${count} delivery projections matched`);
});

test('view preserves evidence getter order, shallow spread traps and rejection identity', async t => {
  const failure = Object.freeze({ getter: 'failed' });
  async function observe(view, mask, failAt) {
    const trace = [];
    function event(label) {
      trace.push(label);
      if (trace.length === failAt) throw failure;
    }
    function watch(name, value) {
      return new Proxy(value, {
        get(target, key) { event(name + '.' + String(key)); return target[key]; },
        ownKeys(target) { event(name + ':keys'); return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) {
          event(name + ':descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    }
    const evidence = watch('evidence', {
      run: watch('run', { id: 'r', taskId: 't', outcome: 'succeeded', startCodeRevision: 'a', endCodeRevision: 'a' }),
      barrier: watch('barrier', { turnId: 'r', writersStopped: true, codeRevision: 'a' }),
      application: watch('application', { id: 'app', separationId: 'sep', targetTaskId: 'target' }),
      integration: watch('integration', { id: 'integration' }),
    });
    const candidate = mask & 1 ? watch('candidate', { state: 'stale', extra: true, [Symbol.for('extra')]: 3 }) : null;
    const separation = mask & 2 ? watch('separation', { id: 'sep', state: 'separated', taskId: 'target',
      deliveryKind: mask & 4 ? 'workspace_snapshot' : 'delivery', lastError: watch('lastError', { code: 'expired' }) }) : null;
    const admission = { deliveryEvidence: () => evidence, verifyBaseline: () => watch('baseline', { effectValid: true }) };
    let error;
    try { await view({ sessionId: 's', taskId: 't', cwd: '.', admission, candidate, separation }); }
    catch (err) { error = err; }
    // Promise assimilation reads .then inside the baseline verification try/catch.
    const propagated = failAt && trace[failAt - 1] !== 'baseline.then';
    assert.equal(error, propagated ? failure : undefined);
    return trace;
  }
  let count = 0;
  for (const mask of [0, 1, 2, 7]) {
    const baseline = await observe(legacyDeliveryView, mask, 0);
    assert.deepEqual(await observe(deliveryView, mask, 0), baseline);
    for (let i = 1; i <= baseline.length; i++) {
      assert.deepEqual(await observe(deliveryView, mask, i), await observe(legacyDeliveryView, mask, i));
      count++;
    }
  }
  t.diagnostic(`${count} getter/trap failure positions matched`);
});

test('delivery baseline verification keeps its await boundary and failure scope', async () => {
  const failure = new Error('baseline unavailable');
  async function timeline(view, verify) {
    const trace = [];
    const run = { outcome: 'failed', endCodeRevision: 'x' };
    const integration = {};
    const admission = {
      deliveryEvidence(sessionId, turnId) { trace.push(['evidence', sessionId, turnId]); return { run, integration }; },
      verifyBaseline(record, cwd) { assert.equal(record, integration); trace.push(['verify', cwd]); return verify(run); },
    };
    const promise = view({ sessionId: 's', candidate: { turnId: 'candidate' }, separation: { sessionId: 'sep', turnId: 'turn' }, admission, cwd: '.' });
    trace.push('returned'); queueMicrotask(() => trace.push('microtask'));
    const result = await promise.then(r => { trace.push('resolved'); return r; });
    return { trace, result };
  }
  for (const verify of [() => { throw failure; }, () => Promise.reject(failure), () => null,
    run => ({ then(resolve) { run.outcome = 'succeeded'; resolve({ effectValid: true }); } })]) {
    assert.deepEqual(await timeline(deliveryView, verify), await timeline(legacyDeliveryView, verify));
  }
  for (const view of [deliveryView, legacyDeliveryView]) {
    await assert.rejects(view({ admission: { deliveryEvidence() { throw failure; } } }), err => err === failure);
    let calls = 0;
    await view({ admission: { deliveryEvidence: () => ({ integration: null }), verifyBaseline() { calls++; } }, cwd: '.' });
    await view({ admission: { deliveryEvidence: () => ({ integration: {} }), verifyBaseline() { calls++; } }, cwd: '' });
    assert.equal(calls, 0);
  }
});

test('delivery view keeps falsey evidence IDs, live error values and UTF-16 truncation', async () => {
  const summary = { code: { toString() { return 'x'.repeat(99) + '😀'; } } };
  for (const view of [deliveryView, legacyDeliveryView]) {
    let stateReads = 0;
    const separation = { id: 'sep', taskId: 't', get state() { return ++stateReads === 1 ? 'separated' : 'kept'; }, lastError: summary };
    const result = await view({ separation, admission: { deliveryEvidence: () => ({
      run: { id: 0, outcome: 'succeeded', startCodeRevision: 'a', endCodeRevision: 'a' },
      application: { separationId: 'sep', targetTaskId: 't' },
    }) } });
    assert.equal(result.mode, 'kept');
    assert.equal(result.steps[1].evidenceId, 0);
    assert.equal(result.steps[3].status, 'done');
    assert.ok(result.application);
    assert.equal(result.blockers.at(-1), summary.code);
    assert.equal(result.separation.lastError.code, 'x'.repeat(99) + '\ud83d');
  }
});
