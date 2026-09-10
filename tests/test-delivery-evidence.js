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
  const begin = (id = 'turn1') => {
    evidence.begin({ sessionId: 's', turnId: id, taskId: 'A', receiptId: 'receipt1', workspaceId: 'w', workspacePath: wt, baseRef: 'main' });
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

test('Air exposes actual result/receipt but still requires a writer barrier and preserves stale candidate', async t => {
  const f = fixture(t); f.begin(); fs.writeFileSync(path.join(f.wt, 'own.txt'), 'own'); await f.finish(); await f.merge();
  const candidate = { turnId: 'turn1', state: 'stale', title: 'New task' };
  const view = await deliveryView({ sessionId: 's', candidate, admission: f.admission, cwd: f.repo });
  assert.equal(view.run.outcome, 'succeeded'); assert.equal(view.integration.baselineCurrent, true);
  assert.deepEqual(view.blockers, ['view_changed', 'source_writer_barrier_required']);
  assert.equal(view.mode, 'retained'); assert.equal(f.store.list('task').length, 0);
});
