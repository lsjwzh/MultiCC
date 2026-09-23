'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./helpers/task-shell');
const { gitWorktreeAdd } = require('../src/git/service');
const { createSeparationTransfer } = require('../src/workspace/separation-transfer');
const { createTaskShellRuntime } = require('../src/task-shell/runtime');
const { parseTaskAttribution, buildTaskAttributionSystemPrompt } = require('../src/classify/task-attribution');
const { mountTaskShellRoutes } = require('../src/task-shell/routes');
const express = require('express');
async function setup(t, extra = {}) {
  const f = fixture(t, extra);
  const source = f.runtime.adopt(f.a.id, 'a');
  f.histories.set('a', [{ id: 'u0', role: 'user', content: 'Old goal', taskId: source.id }]);
  const sent = await f.runtime.send(f.a.id, { text: 'Unrelated goal', clientMsgId: 'new-goal' });
  f.histories.get('a').push({ id: 'u1', role: 'user', content: 'Unrelated goal', turnId: 'turn-1', clientMsgId: sent.receiptId, taskId: source.id },
    { id: 'a1', role: 'assistant', content: 'New result', turnId: 'turn-1', taskId: source.id });
  f.statuses.set('a', { busy: false });
  const input = { turnId: 'turn-1', anchorMessageId: 'a1', separation: { title: 'Independent goal', reason: 'Different output' } };
  return { ...f, source, sent, input, propose: () => f.runtime.separation.propose('a', sent.receiptId, input) };
}
test('only explicit low relevance with a title produces a suggestion; locked identity still judges relevance', () => {
  for (const contextRelevance of [undefined, null, 'medium', 'high', 0, 'LOW']) {
    assert.equal(parseTaskAttribution(JSON.stringify({ contextRelevance, splitTaskName: 'Goal' })).separation, undefined);
  }
  assert.deepEqual(parseTaskAttribution('{"contextRelevance":"low","splitTaskName":"New goal","relevanceReason":"Separate"}').separation,
    { title: 'New goal', reason: 'Separate' });
  assert.equal(parseTaskAttribution('{"contextRelevance":"low"}').separation, undefined);
  assert.match(buildTaskAttributionSystemPrompt({ identityLocked: true }), /即使任务身份锁定，也必须判断关联度/);
  // 判定标准刻意放宽:同一仓库/同一产品内的不同功能也算不同交付目标,
  // 否则同产品迭代永远拿不到 low,「任务另起」建议形同虚设。
  assert.match(buildTaskAttributionSystemPrompt({}), /同一仓库、同一产品内的不同功能或问题也算不同交付目标/);
});
test('proposing splits the task identity immediately but makes no execution, cursor or history changes', async t => {
  const f = await setup(t), shell = f.runtime.view(f.a.id);
  const p = f.propose(); assert.equal(p.state, 'pending');
  assert.deepEqual(f.propose(), p);
  const task = f.store.get('task', p.taskId);
  assert.ok(task, 'the task id is allocated with the suggestion');
  assert.equal(task.ready, false, 'shares the conversation execution until a separate decision');
  assert.equal(task.ownerShellId, f.a.id);
  assert.equal(task.separatedFromTaskId, f.source.id);
  assert.equal(task.sessionId, `task-${p.taskId.slice(4)}`);
  assert.ok(f.store.get('link', `${f.a.id}:${task.id}`), 'stays linked to the conversation');
  const after = f.runtime.view(f.a.id);
  assert.equal(after.currentTaskId, shell.currentTaskId);
  assert.equal(after.cursorVersion, shell.cursorVersion);
  assert.equal(after.cursorReceiptId, shell.cursorReceiptId);
  assert.equal(f.creations.length, 0);
  assert.equal(f.store.list('task').length, 2);
  assert.deepEqual(f.histories.get('a').map(m => m.taskId), [f.source.id, f.source.id, f.source.id]);
  assert.deepEqual(createTaskShellRuntime(f.ports).separation.latest('a'), p);
});
test('a repeated verdict for the same new task reuses the open suggestion instead of minting a twin', async t => {
  const f = await setup(t), p = f.propose();
  const sent2 = await f.runtime.send(f.a.id, { text: 'More of the new goal', clientMsgId: 'new-goal-2' });
  f.histories.get('a').push({ id: 'u2', role: 'user', content: 'More of the new goal', turnId: 'turn-2', clientMsgId: sent2.receiptId, taskId: f.source.id },
    { id: 'a2', role: 'assistant', content: 'More result', turnId: 'turn-2', taskId: f.source.id });
  const p2 = f.runtime.separation.propose('a', sent2.receiptId, { turnId: 'turn-2', anchorMessageId: 'a2',
    separation: { title: 'Independent goal', reason: 'Same new task' } });
  assert.equal(p2.id, p.id);
  assert.equal(f.store.list('task').length, 2);
});
test('opening an embedded task is read-only and a kept verdict reuses its identity', async t => {
  const f = await setup(t), p = f.propose();
  const entry = await f.runtime.bindPlannedTask(p.taskId);
  assert.equal(entry.task.id, p.taskId);
  assert.equal(entry.sessionId, 'a', 'the embedded task still reads from the shared conversation');
  assert.equal(f.creations.length, 0, 'opening task detail cannot create its reserved execution');
  await f.runtime.separation.decide('a', p.id, 'keep');
  const sent2 = await f.runtime.send(f.a.id, { text: 'Continue related goal', clientMsgId: 'related-2' });
  f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Continue related goal', turnId: 'turn-2', clientMsgId: sent2.receiptId },
    { id: 'a2', role: 'assistant', content: 'Done', turnId: 'turn-2' });
  const again = f.runtime.separation.propose('a', sent2.receiptId, { turnId: 'turn-2', anchorMessageId: 'a2',
    separation: { title: 'Independent goal', reason: 'Same goal after keep' } });
  assert.equal(again.id, p.id);
  assert.equal(again.state, 'kept');
  assert.equal(again.taskId, p.taskId);
  assert.equal(f.store.list('task').length, 2);
});
test('first exchange, stale anchor and forged execution cannot propose separation', async t => {
  const f = await setup(t);
  f.histories.get('a').shift(); assert.equal(f.propose(), null);
  f.histories.get('a').unshift({ id: 'u0', role: 'user', content: 'Old goal' });
  assert.equal(f.runtime.separation.propose('a', f.sent.receiptId, { ...f.input, anchorMessageId: 'missing' }), null);
  assert.throws(() => f.runtime.separation.propose('b', f.sent.receiptId, f.input), { code: 'separation_not_found' });
});
test('keep is durable and idempotent while the related task remains detachable later', async t => {
  const f = await setup(t), p = f.propose();
  assert.deepEqual(await f.runtime.separation.decide('a', p.id, 'keep'), { ok: true, decision: 'keep' });
  const restarted = createTaskShellRuntime(f.ports);
  assert.equal(restarted.separation.latest('a'), null);
  assert.equal((await restarted.separation.decide('a', p.id, 'keep')).ok, true);
  const result = await restarted.separation.decide('a', p.id, 'separate');
  assert.equal(result.taskId, p.taskId);
  assert.equal(f.store.list('task').length, 2);
});
test('defer keeps the already split task detachable across restarts and later turns', async t => {
  const f = await setup(t), p = f.propose();
  assert.deepEqual(await f.runtime.separation.decide('a', p.id, 'defer'),
    { ok: true, decision: 'defer', id: p.id, deferred: true });
  // Deferral is only a shell decision: the related task identity already exists.
  assert.equal(f.store.list('task').length, 2);
  const restarted = createTaskShellRuntime(f.ports).separation.latest('a');
  assert.equal(restarted.id, p.id);
  assert.equal(restarted.deferred, true);
  assert.equal(restarted.stale, false);
  // Once the conversation moves on the task stays detachable: its anchored
  // exchange, not the current chat tail, is the handoff boundary.
  f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Next goal', turnId: 'turn-2', taskId: f.source.id });
  const stale = createTaskShellRuntime(f.ports).separation.latest('a');
  assert.equal(stale.deferred, true);
  assert.equal(stale.stale, false);
  const result = await createTaskShellRuntime(f.ports).separation.decide('a', p.id, 'separate');
  assert.equal(result.taskId, p.taskId);
});
test('confirmed separation creates one independent task and imports only this exchange with provenance', async t => {
  const f = await setup(t);
  f.runtime.roles.update(f.source.id, { expectedVersion: 0, clientMsgId: 'roles-1',
    bindings: [{ name: 'reviewer', prompt: 'Preserve the task boundary.' }] });
  const p = f.propose(), before = JSON.stringify(f.histories.get('a'));
  const results = await Promise.all([1,2].map(() => f.runtime.separation.decide('a', p.id, 'separate')));
  assert.deepEqual(results[0], results[1]);
  const task = f.store.get('task', results[0].taskId);
  assert.equal(task.separatedFromTaskId, f.source.id); assert.equal(task.parentTaskId, undefined);
  assert.equal(task.forkBaseline.commit, 'a'.repeat(40));
  assert.equal(f.runtime.view(f.a.id).currentTaskId, f.source.id);
  assert.equal(f.store.get('shell', task.ownerShellId).standalone, true);
  assert.deepEqual(f.runtime.roles.current(task.id).bindings, [{ name: 'reviewer', prompt: 'Preserve the task boundary.' }]);
  assert.equal(f.barriers.length, 1); assert.equal(f.applications.length, 1);
  assert.equal(f.creations.length, 1); assert.equal(f.sends.length, 1, 'confirmation must not send work to a model');
  assert.equal(JSON.stringify(f.histories.get('a')), before);
  const entry = await f.runtime.taskEntry(task.id);
  assert.deepEqual(entry.messages.map(m => m.content), ['Unrelated goal', 'New result']);
  assert.ok(entry.messages.every(m => m.sourceSessionId === 'a' && m.inherited));
  assert.equal(f.store.list('task').length, 2);
  assert.deepEqual(await createTaskShellRuntime(f.ports).separation.decide('a', p.id, 'separate'), results[0]);
});
test('a newer turn does not invalidate a task identity that was already split', async t => {
  const f = await setup(t), p = f.propose();
  f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Next input' });
  assert.equal(f.runtime.separation.latest('a').id, p.id);
  const result = await f.runtime.separation.decide('a', p.id, 'separate');
  assert.equal(result.taskId, p.taskId);
  assert.equal(f.creations.length, 1);
});
test('a stable source snapshot can separate a failed, waiting or unobserved turn', async t => {
  for (const run of [
    { id: 'turn-1', outcome: 'failed', pendingInput: false, endCodeRevision: 'revision-1' },
    { id: 'turn-1', outcome: 'succeeded', pendingInput: true, endCodeRevision: 'revision-1' },
    { id: 'turn-1', outcome: 'succeeded', pendingInput: false, endCodeRevision: null },
  ]) {
    const f = await setup(t, { deliveryEvidence: () => ({ run, integration: null }) }), p = f.propose();
    const result = await f.runtime.separation.decide('a', p.id, 'separate');
    assert.equal(result.ok, true);
    assert.equal(f.store.get('task-separation', p.id).deliveryKind, 'workspace_snapshot');
  }
});
test('a clean source snapshot does not require a merge receipt', async t => {
  const changed = { id: 'turn-1', outcome: 'succeeded', pendingInput: false,
    startCodeRevision: 'revision-0', endCodeRevision: 'revision-1' };
  const missing = await setup(t, { deliveryEvidence: () => ({ run: changed, integration: null }) });
  const result = await missing.runtime.separation.decide('a', missing.propose().id, 'separate');
  assert.equal(result.ok, true);
  assert.equal(missing.store.get('task', result.taskId).forkBaseline.commit, 'a'.repeat(40));
  const stale = await setup(t, { deliveryEvidence: () => ({ run: changed, integration: { id: 'integration-1', integrationHead: 'abc' } }),
    verifyDeliveryBaseline: async () => ({ effectValid: false }) });
  assert.equal((await stale.runtime.separation.decide('a', stale.propose().id, 'separate')).ok, true);
});
test('busy sources keep the suggestion while a dirty source moves its checkout into the new task', async t => {
  const f = await setup(t), p = f.propose();
  f.ports.withSeparationBarrier = async (input, work) => {
    if (f.statuses.get('a')?.busy) throw Object.assign(new Error('busy'), { code: 'fork_source_busy' });
    return work({ barrier: { id: `barrier-${input.separationId}` },
      code: { revision: 'revision-9', head: 'a'.repeat(40), repoId: 'repo-1', dirty: true } });
  };
  f.statuses.set('a', { busy: true });
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'fork_source_busy' });
  f.statuses.set('a', { busy: false });
  // A dirty checkout is no longer a refusal: it is exactly what the new task
  // takes over, and the source keeps nothing but its branch.
  const result = await f.runtime.separation.decide('a', p.id, 'separate');
  assert.equal(result.ok, true);
  assert.equal(f.transfers.length, 1);
  assert.deepEqual(f.transfers[0], { separationId: p.id, turnId: 'turn-1', barrierId: `barrier-${p.id}`,
    sourceSessionId: 'a', sourceTaskId: p.sourceTaskId, targetTaskId: p.taskId,
    targetSessionId: p.taskId.replace(/^tsk_/, 'task-'), baseCommit: 'a'.repeat(40) });
  assert.equal(f.records.get(result.sessionId).workspaceState, 'awake');
  assert.equal(f.store.get('task-separation', p.id).lastError, null);
  assert.equal(f.store.list('task').length, 2);
});
test('a failed checkout transfer stays retryable and never records an application', async t => {
  const f = await setup(t), p = f.propose(), transfer = f.ports.transferWorkspace;
  f.ports.transferWorkspace = async input => { f.transfers.push(input); return { ok: false, code: 'split_off_failed', error: 'carry patch does not apply' }; };
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'split_off_failed' });
  const saved = f.store.get('task-separation', p.id);
  assert.equal(saved.phase, 'blocked');
  assert.deepEqual(saved.lastError, { code: 'split_off_failed' });
  assert.equal(f.applications.length, 0, 'no application receipt without a moved checkout');
  assert.equal(f.runtime.separation.latest('a').id, p.id);
  f.ports.transferWorkspace = transfer;
  const retried = await createTaskShellRuntime(f.ports).separation.decide('a', p.id, 'separate');
  assert.equal(retried.ok, true);
  assert.equal(f.transfers.length, 2, 'the retry moves the checkout instead of reusing a partial one');
  assert.equal(f.creations.length, 1, 'the new execution is not created twice');
  assert.equal(f.applications.length, 1);
});
test('a host that cannot move the checkout refuses to split the task', async t => {
  const f = await setup(t, { transferWorkspace: undefined }), p = f.propose();
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'separation_transfer_unavailable' });
  assert.equal(f.store.get('task-separation', p.id).phase, 'blocked');
  assert.equal(f.applications.length, 0);
  assert.equal(f.store.list('task').length, 2);
});
test('a real separation moves the checkout, keeps the branch and rebuilds the source on demand', async t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-split-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const worktrees = path.join(repo, '.multicc-worktrees'), source = 'shell-a', target = 'task-b';
  const sourceDir = path.join(worktrees, source), targetDir = path.join(worktrees, target);
  git(repo, 'worktree', 'add', '-b', `multicc/${source}`, sourceDir);
  // The judged turn already committed work; more of it is still uncommitted.
  fs.writeFileSync(path.join(sourceDir, 'committed.txt'), 'landed\n');
  git(sourceDir, 'add', '.'); git(sourceDir, 'commit', '-m', 'turn work');
  const tip = git(sourceDir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(sourceDir, 'base.txt'), 'edited\n');
  fs.writeFileSync(path.join(sourceDir, 'new-file.txt'), 'untracked\n');
  const records = new Map([
    [source, { id: source, dirId: 'd', kind: 'chat', taskBoundTaskId: 'tsk_a', worktreePath: sourceDir,
      branch: `multicc/${source}`, workspaceState: 'awake' }],
    [target, { id: target, dirId: 'd', kind: 'chat', taskBoundTaskId: 'tsk_b', worktreePath: targetDir,
      branch: `multicc/${target}`, workspaceState: 'planned' }],
  ]);
  const directories = new Map([['d', { id: 'd', path: repo, baseBranch: 'main' }]]);
  const transfer = createSeparationTransfer({ records, directories, persistence: { mutate: (id, fn) => fn(records) },
    log: { warn() {} } });
  const moved = await transfer({ sourceSessionId: source, targetSessionId: target, baseCommit: tip });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(git(targetDir, 'rev-parse', 'HEAD'), tip);
  assert.equal(fs.readFileSync(path.join(targetDir, 'base.txt'), 'utf8'), 'edited\n');
  assert.equal(fs.readFileSync(path.join(targetDir, 'new-file.txt'), 'utf8'), 'untracked\n');
  assert.equal(fs.readFileSync(path.join(targetDir, 'committed.txt'), 'utf8'), 'landed\n');
  assert.equal(git(targetDir, 'status', '--porcelain').split('\n').filter(Boolean).length, 2,
    'the moved work is still uncommitted in the new task');
  assert.equal(fs.existsSync(sourceDir), false, 'the source checkout is gone');
  assert.equal(git(repo, 'rev-parse', `refs/heads/multicc/${source}`), tip, 'the source branch is kept at its own tip');
  assert.equal(records.get(source).workspaceState, 'hibernated');
  assert.equal(records.get(target).workspaceState, 'awake');
  // The very next message on the source rebuilds its checkout — without the work
  // that just moved to the new task.
  const rebuilt = await gitWorktreeAdd(repo, source, null, { sessionId: source, requireExistingBranch: true });
  assert.equal(rebuilt.ok, true);
  assert.equal(git(sourceDir, 'rev-parse', 'HEAD'), tip);
  assert.equal(fs.readFileSync(path.join(sourceDir, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(sourceDir, 'new-file.txt')), false);
});
test('a checkout holding non-regenerable ignored files is retained instead of deleted', async t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-split-kept-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.env\n');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const worktrees = path.join(repo, '.multicc-worktrees'), source = 'shell-a', target = 'task-b';
  const sourceDir = path.join(worktrees, source), targetDir = path.join(worktrees, target);
  git(repo, 'worktree', 'add', '-b', `multicc/${source}`, sourceDir);
  fs.writeFileSync(path.join(sourceDir, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(sourceDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'node_modules/dep.js'), '// regenerable\n');
  const records = new Map([
    [source, { id: source, dirId: 'd', kind: 'chat', worktreePath: sourceDir, branch: `multicc/${source}`, workspaceState: 'awake' }],
    [target, { id: target, dirId: 'd', kind: 'chat', worktreePath: targetDir, branch: `multicc/${target}`, workspaceState: 'planned' }],
  ]);
  const directories = new Map([['d', { id: 'd', path: repo, baseBranch: 'main' }]]);
  const transfer = createSeparationTransfer({ records, directories, persistence: { mutate: (id, fn) => fn(records) },
    log: { warn() {} } });
  const moved = await transfer({ sourceSessionId: source, targetSessionId: target });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual(moved.sourceRetained, { reason: 'ignored_files', count: 1 });
  assert.equal(fs.existsSync(targetDir), true, 'the new task still gets the checkout');
  assert.equal(fs.existsSync(path.join(sourceDir, '.env')), true, 'user files git cannot regenerate are never deleted');
  assert.equal(records.get(source).workspaceState, 'awake', 'a retained checkout stays the source workspace');
  assert.equal(records.get(target).workspaceState, 'awake');
});
test('a transiently blocked suggestion stays retryable after the conversation advances', async t => {
  const f = await setup(t), p = f.propose();
  f.ports.withSeparationBarrier = async (input, work) => {
    if (f.statuses.get('a')?.busy) throw Object.assign(new Error('busy'), { code: 'fork_source_busy' });
    return work({ barrier: { id: `barrier-${input.separationId}` },
      code: { revision: 'revision-1', head: 'a'.repeat(40), repoId: 'repo-1', dirty: false } });
  };
  f.statuses.set('a', { busy: true });
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'fork_source_busy' });
  f.statuses.set('a', { busy: false });
  // The user retried only after the next turn landed: the tail-anchor check has
  // expired, but a blocked suggestion must not vanish — its error told the user
  // to retry once the task finished.
  f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Follow-up', turnId: 'turn-2', taskId: f.source.id },
    { id: 'a2', role: 'assistant', content: 'Follow-up result', turnId: 'turn-2', taskId: f.source.id });
  const latest = createTaskShellRuntime(f.ports).separation.latest('a');
  assert.equal(latest.id, p.id);
  assert.equal(latest.deferred, true);
  assert.equal(latest.stale, false, 'blocked-but-anchored suggestion stays acceptable');
  const result = await createTaskShellRuntime(f.ports).separation.decide('a', p.id, 'separate');
  assert.equal(result.ok, true);
  assert.equal(f.creations.length, 1);
});
test('blocked separation persists only a bounded safe error code', async t => {
  const f = await setup(t, { withSeparationBarrier: async () => {
    throw Object.assign(new Error('secret /Users/example/token'), { code: 'bad code /Users/example/token' });
  } }), p = f.propose();
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'));
  const saved = f.store.get('task-separation', p.id);
  assert.deepEqual(saved.lastError, { code: 'separation_failed' });
  assert.doesNotMatch(JSON.stringify(saved), /Users|secret|token/);
});
test('an anchor changed during code capture prevents shell checkout', async t => {
  const f = await setup(t);
  f.ports.withSeparationBarrier = async (input, work) => {
    f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Race' });
    return work({ barrier: { id: `barrier-${input.separationId}` },
      code: { revision: 'revision-1', head: 'a'.repeat(40), repoId: 'repo-1', dirty: false } });
  };
  const p = f.propose();
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'separation_stale' });
  assert.equal(f.store.list('task').length, 2, 'the identity survives a failed shell checkout');
});
test('partial creation resumes the frozen, already confirmed task after restart without duplicating it', async t => {
  const f = await setup(t), p = f.propose();
  const index = f.ports.indexTask;
  f.ports.indexTask = () => ({ ok: false });
  const broken = createTaskShellRuntime(f.ports);
  await assert.rejects(broken.separation.decide('a', p.id, 'separate'), { code: 'task_index_failed' });
  f.ports.indexTask = index;
  const recovered = createTaskShellRuntime(f.ports);
  await assert.rejects(recovered.separation.decide('a', p.id, 'keep'), { code: 'separation_already_confirmed' });
  const result = await recovered.separation.decide('a', p.id, 'separate');
  assert.equal(result.ok, true); assert.equal(f.store.list('task').length, 2); assert.equal(f.creations.length, 1);
});
test('a failed execution checkout cannot be mislabeled as kept in the shared shell', async t => {
  const f = await setup(t), p = f.propose(), create = f.ports.createExecution;
  f.ports.createExecution = async () => ({ ok: false, code: 'execution_create_failed' });
  const broken = createTaskShellRuntime(f.ports);
  await assert.rejects(broken.separation.decide('a', p.id, 'separate'), { code: 'execution_create_failed' });
  const task = f.store.get('task', p.taskId);
  assert.equal(task.embedded, false);
  assert.equal(f.store.get('shell', task.ownerShellId).standalone, true);
  await assert.rejects(broken.separation.decide('a', p.id, 'keep'), { code: 'separation_already_confirmed' });
  f.ports.createExecution = create;
  const result = await createTaskShellRuntime(f.ports).separation.decide('a', p.id, 'separate');
  assert.equal(result.ok, true);
});
test('HTTP confirmation binds session and suggestion, validates decisions and keeps errors structured', async t => {
  const f = await setup(t), p = f.propose(), app = express(); app.use(express.json());
  mountTaskShellRoutes(app, { getRuntime: () => f.runtime });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/sessions`;
  const get = await fetch(`${base}/a/task-separation`); assert.equal((await get.json()).suggestion.id, p.id);
  for (const [session, decision, code] of [['b','separate','separation_not_found'], ['a','yes','invalid_input'], ['a','keep',null]]) {
    const res = await fetch(`${base}/${session}/task-separation/${p.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
    const body = await res.json(); assert.equal(body.code || null, code); assert.equal(body.ok, !code);
  }
});
test('confirmed separation seeds the full judged turn into the new transcript and moves its open question', async t => {
  const f = await setup(t);
  const appended = [], hidden = [], moves = [];
  f.ports.appendHistory = (id, message) => {
    appended.push({ id, message });
    f.histories.set(id, [...(f.histories.get(id) || []), message]);
    return true;
  };
  f.ports.movePendingUserInput = async (sourceId, targetId, opts) => {
    moves.push({ sourceId, targetId, opts });
    return { ok: true, requestId: 'usrq-1' };
  };
  f.ports.hideHistory = (sourceId, ids) => { hidden.push({ sourceId, ids }); return ids.length; };
  const before = JSON.stringify(f.histories.get('a'));
  const p = f.propose();
  const result = await f.runtime.separation.decide('a', p.id, 'separate');
  const task = f.store.get('task', result.taskId);
  // Only the judged turn (turn-1) is seeded — the older exchange stays behind,
  // content is the full history text, not the context snapshot's excerpt.
  assert.equal(result.seededMessages, 2);
  assert.deepEqual(appended.map(a => a.message.content), ['Unrelated goal', 'New result']);
  assert.ok(appended.every(a => a.id === task.sessionId
    && a.message.taskId === task.id
    && a.message.sourceSessionId === 'a'
    && a.message.importedBy === p.id
    && typeof a.message.importedAt === 'number'));
  assert.deepEqual(appended.map(a => a.message.sourceMessageId), ['u1', 'a1']);
  assert.deepEqual(appended.map(a => a.message.contextMessageId), ['a:u1', 'a:a1']);
  assert.equal(JSON.stringify(f.histories.get('a')), before, 'canonical source transcript is retained for audit');
  assert.deepEqual(hidden, [{ sourceId: 'a', ids: ['u1', 'a1'] }], 'moved messages leave the source display');
  // The judged turn's open wait_user question moves to the new task.
  assert.deepEqual(moves, [{ sourceId: 'a', targetId: task.sessionId, opts: { turnId: 'turn-1', taskId: task.id } }]);
  assert.equal(result.movedUserInput, 'usrq-1');
  // A repeated decide returns the stored result without re-seeding or re-moving.
  const replay = await f.runtime.separation.decide('a', p.id, 'separate');
  assert.deepEqual(replay, result);
  assert.equal(appended.length, 2);
  assert.equal(moves.length, 1);
});
test('restart healing hides an already-seeded transcript and retries the pending question move', async t => {
  const f = await setup(t), appended = [], hidden = [], moves = [];
  f.ports.appendHistory = (id, message) => {
    appended.push({ id, message });
    f.histories.set(id, [...(f.histories.get(id) || []), message]);
    return true;
  };
  f.ports.hideHistory = (sourceId, ids) => { hidden.push({ sourceId, ids }); return ids.length; };
  f.ports.movePendingUserInput = async (...args) => { moves.push(args); return { ok: true, requestId: 'usrq-healed' }; };
  const p = f.propose(), result = await f.runtime.separation.decide('a', p.id, 'separate');
  assert.equal(appended.length, 2);
  hidden.length = 0; moves.length = 0;
  const healed = await createTaskShellRuntime(f.ports).separation.heal();
  assert.equal(healed.healed, 1);
  assert.equal(appended.length, 2, 'existing target messages are not duplicated');
  assert.deepEqual(hidden, [{ sourceId: 'a', ids: ['u1', 'a1'] }], 'source hiding is repaired independently');
  assert.deepEqual(moves, [['a', result.sessionId, { turnId: 'turn-1', taskId: result.taskId }]]);
});
test('separation succeeds without the handoff ports and reports zero seeded messages', async t => {
  const f = await setup(t), p = f.propose();
  const result = await f.runtime.separation.decide('a', p.id, 'separate');
  assert.equal(result.ok, true);
  assert.equal(result.seededMessages, 0);
  assert.equal(result.movedUserInput, null);
});
