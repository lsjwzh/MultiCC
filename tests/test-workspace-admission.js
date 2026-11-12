'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTaskShellStore } = require('../src/task-shell/store');
const { createWorkspaceRegistry } = require('../src/workspace/registry');
const { createWorkspaceAdmission } = require('../src/workspace/admission');
function fixture(t, limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-admission-'));
  const file = path.join(dir, 'db.sqlite'), store = createTaskShellStore(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const registry = createWorkspaceRegistry(store, { executionLimit: 2, residentLimit: 3, restoreLimit: 1, ...limits });
  const add = (id, residency = 'planned') => registry.register({ ownerId: id, dirId: 'd', path: path.join(dir, id), branch: id, residency });
  return { dir, file, store, registry, add };
}
test('two SQLite connections cannot reserve the same physical workspace', t => {
  const f = fixture(t), w = f.add('a'); f.registry.bind('alias', w.id);
  const other = createTaskShellStore(f.file); t.after(() => other.close());
  const second = createWorkspaceRegistry(other);
  const lease = f.registry.acquire(w.id, 'a', 'message');
  assert.throws(() => second.acquire(w.id, 'alias', 'another'), error => (
    error.code === 'workspace_busy' && error.backpressure === true
  ));
  assert.throws(() => f.registry.acquire(w.id, 'a', 'message'), error => (
    error.code === 'workspace_launch_unresolved' && error.backpressure === false
  ));
  f.registry.release(lease, { stopped: true });
  assert.equal(second.acquire(w.id, 'alias', 'another').state, 'reserved');
});
test('creation consumes no execution or residency budget; restoration has an atomic reservation', t => {
  const f = fixture(t); const a = f.add('a'), b = f.add('b');
  for (let i = 0; i < 100; i++) f.add('plan' + i);
  assert.equal(f.registry.snapshot().leases.length, 0);
  const lease = f.registry.acquire(a.id, 'a', 'm');
  assert.throws(() => f.registry.acquire(b.id, 'b', 'm'), { code: 'workspace_restore_capacity' });
  f.registry.resident(lease, { head: 'abc', commonDir: f.dir });
  assert.equal(f.registry.acquire(b.id, 'b', 'm').state, 'reserved');
});
test('execution and resident limits independently retain queued work', t => {
  const f = fixture(t, { executionLimit: 1, residentLimit: 1 }), a = f.add('a', 'resident'), b = f.add('b');
  const l = f.registry.acquire(a.id, 'a', 'm');
  assert.equal(f.registry.available(b.id), 'workspace_execution_capacity');
  f.registry.release(l, { stopped: true });
  assert.equal(f.registry.available(b.id), 'workspace_resident_capacity');
});
test('resident limit is per directory while execution and restore limits stay global', t => {
  const f = fixture(t, { executionLimit: 4, residentLimit: 1, restoreLimit: 2 });
  assert.equal(f.registry.snapshot().budgets.residentLimitScope, 'directory');
  const residentA = f.add('resident-a', 'resident');
  const plannedA = f.add('planned-a');
  const plannedB = f.registry.register({ ownerId: 'planned-b', dirId: 'other',
    path: path.join(f.dir, 'planned-b'), branch: 'planned-b', residency: 'planned' });
  assert.equal(f.registry.available(plannedA.id), 'workspace_resident_capacity');
  assert.equal(f.registry.available(plannedB.id), null,
    'a full directory must not consume another directory resident budget');

  const restoringB = f.registry.acquire(plannedB.id, 'planned-b', 'restore-b');
  const anotherB = f.registry.register({ ownerId: 'another-b', dirId: 'other',
    path: path.join(f.dir, 'another-b'), branch: 'another-b', residency: 'planned' });
  assert.equal(f.registry.available(anotherB.id), 'workspace_resident_capacity',
    'a materializing reservation consumes capacity only in its own directory');
  assert.equal(f.registry.available(residentA.id), null, 'resident workspaces do not need another resident slot');
  f.registry.release(restoringB, { stopped: true });
});
test('unknown stop and restart never steal a writer lease', t => {
  const f = fixture(t), w = f.add('a', 'resident'), l = f.registry.acquire(w.id, 'a', 'm');
  f.registry.transition(l, 'starting'); f.registry.release(l, { stopped: false });
  assert.equal(f.registry.lease(w.id).state, 'uncertain');
  const other = createTaskShellStore(f.file); t.after(() => other.close());
  const reopened = createWorkspaceRegistry(other); reopened.recover(() => 'unknown');
  assert.equal(reopened.lease(w.id).state, 'uncertain');
  assert.throws(() => reopened.acquire(w.id, 'a', 'm'), { code: 'workspace_launch_unresolved' });
  assert.throws(() => f.registry.transition(l, 'running'), { code: 'workspace_lease_stale' });
});

test('an external writer survives host recovery and prevents reclaim until it exits', t => {
  const f = fixture(t), w = f.add('writer-recovery', 'resident');
  const lease = f.registry.acquire(w.id, 'writer-recovery', 'm');
  const other = createTaskShellStore(f.file); t.after(() => other.close());
  const input = { workspaceId: w.id, leaseId: lease.id, sessionId: lease.sessionId,
    epoch: lease.epoch, generation: lease.generation, writerId: 'external-writer', writerKind: 'background' };
  other.writerLeaseAcquire(input);
  assert.throws(() => f.registry.release(lease, { stopped: true }), { code: 'workspace_writer_active' });
  const recovered = createWorkspaceRegistry(f.store);
  recovered.recover(() => 'stopped');
  const current = recovered.lease(w.id);
  assert.equal(current.state, 'uncertain');
  assert.throws(() => recovered.release(current, { stopped: true }), { code: 'workspace_writer_active' });
  other.writerLeaseRelease(input);
  assert.equal(recovered.release(current, { stopped: true }).state, 'released');
  assert.equal(recovered.acquire(w.id, 'writer-recovery', 'next').state, 'reserved');
});
test('late completion cannot release the next generation', t => {
  const f = fixture(t), w = f.add('a', 'resident'), first = f.registry.acquire(w.id, 'a', 'm');
  f.registry.release(first, { stopped: true });
  const second = f.registry.acquire(w.id, 'a', 'n');
  assert.throws(() => f.registry.release(first, { stopped: true }), { code: 'workspace_lease_stale' });
  assert.equal(f.registry.lease(w.id).id, second.id);
});
test('identity conflicts and missing validation roll back without changing residency', t => {
  const f = fixture(t), w = f.add('a');
  assert.throws(() => f.registry.register({ ...w, branch: 'other' }), { code: 'workspace_identity_conflict' });
  const l = f.registry.acquire(w.id, 'a', 'm');
  assert.throws(() => f.registry.resident(l, {}), { code: 'workspace_validation_required' });
  assert.equal(f.registry.workspace(w.id).residency, 'planned');
});
async function hostFixture(t, options = {}) {
  const f = fixture(t, options.limits), repo = path.join(f.dir, 'repo'); fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']); git(['commit', '--allow-empty', '-m', 'base']);
  const record = { id: 'task-test', kind: 'chat', cli: 'codex', dirId: 'd', branch: 'multicc/task-test', worktreePath: path.join(repo, '.multicc-worktrees/task-test'), workspaceState: 'planned' };
  const records = new Map([[record.id, record]]), state = {}, flags = { background: false, stream: false, closes: 0, creates: 0, pendingInput: null };
  const hibernationRuntime = {
    ensureAwake: async () => ({ ok: true }),
    reclaimForCapacity: options.reclaimForCapacity,
  };
  const deps = { file: f.file, records, directories: new Map([['d', { id: 'd', path: repo, baseBranch: 'main' }]]),
    persistence: { mutate: (_source, fn) => fn(records) }, getState: () => state,
    ensureDir: async () => ({ ok: true }), addWorktree: async () => { flags.creates++; git(['worktree', 'add', '-b', record.branch, record.worktreePath, 'main']); return { worktreePath: record.worktreePath, branch: record.branch }; },
    validate: async () => ({ ok: true }), hibernation: () => hibernationRuntime,
    budgets: options.limits,
    captureCodeRevision: options.captureCodeRevision,
    hasBackground: () => flags.background, streamBusy: () => flags.stream, pendingInput: () => flags.pendingInput,
    closePersistent: async () => { flags.closes++; return { closed: true }; }, updateCwd: () => {}, log: () => {} };
  const host = createWorkspaceAdmission(deps); t.after(() => host.close()); host.initialize();
  const descriptor = id => ({ sessionId: record.id, item: { id }, opts: { deliveryId: id } });
  return { ...f, host, record, descriptor, flags, state, deps, hibernationRuntime };
}
test('admission releases the turn lease while fencing and reusing its resident child', { timeout: 10000 }, async t => {
  const f = await hostFixture(t);
  f.record.cli = 'codex-exp';
  const app = require('../src/chat/codex-app-stream').createCodexAppStream();
  const stream = require('../src/chat/stream-router').createStreamRouter(app, app, app);
  const bin = require('./helpers/fake-codex-app-server').writeFakeAppServer(f.dir);
  Object.assign(f.deps, {
    streamBusy: id => !!stream.status(id)?.busy,
    closePersistent: id => stream.closeAndWait(id),
    parkPersistent: (id, w) => stream.parkWorkspace(id, w),
    claimPersistent: (id, w, opts) => stream.claimWorkspace(id, w, opts),
  });
  const id = f.record.id;
  let pid;
  try {
    for (let i = 1; i <= 2; i++) {
      const d = f.descriptor(`message-${i}`), guard = await f.host.beforeDeliver(d);
      f.host.bindTurn(id, d.opts, `turn-${i}`); f.host.starting(id, d.opts);
      stream.ensure(id, { cmd: process.execPath, cwd: f.record.worktreePath, streamBackend: 'app-server',
        baseArgs: [path.resolve(__dirname, '../src/cli-adapters/codex-app-server-bridge.cjs'), '--codex-bin', bin, '--resident'],
        env: { PATH: process.env.PATH, FAKE_CODEX_LOG: path.join(f.dir, 'requests.jsonl') } });
      await stream.send(id, 'hello', () => {});
      const currentPid = stream.status(id).pid;
      if (pid) assert.equal(currentPid, pid, 'the real bridge PID survives workspace finalization');
      pid = currentPid;
      f.host.spawned(id, { pid }); await guard.complete({ accepted: true });
      f.flags.background = true;
      f.host.settled(id, { status: 'succeeded' });
      await new Promise(setImmediate);
      assert.equal(f.host.hasActiveLease(id), true, 'background writers still hold the execution lease');
      f.flags.background = false;
      for (let n = 0; n < 200 && f.host.occupied(id); n++) await new Promise(r => setTimeout(r,5));
      assert.equal(f.host.hasActiveLease(id), false);
      assert.equal(stream.status(id).alive, true);
      await assert.rejects(stream.send(id, 'without a permit', () => {}), { code: 'workspace_busy' });
    }
    await stream.claimWorkspace('next-owner', f.host.identify(id));
    assert.equal(stream.status(id), null, 'a different writer joins the parked process first');
  } finally { await stream.closeAndWait(id); await stream.closeAndWait('next-owner'); }
});
test('first dispatch materializes once, rejects forged permits, and holds claim through background work', async t => {
  const f = await hostFixture(t); assert.equal(fs.existsSync(f.record.worktreePath), false);
  assert.throws(() => f.host.assertPermit(f.record.id, { workspacePermit: {} }), { code: 'workspace_admission_required' });
  assert.throws(() => f.host.recordWriterActivity(f.record.id, 'stream'), { code: 'workspace_admission_required' });
  const d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  assert.equal(fs.existsSync(f.record.worktreePath), true); assert.equal(f.record.workspaceState, 'awake');
  f.host.assertPermit(f.record.id, d.opts); f.host.bindTurn(f.record.id, d.opts, 't');
  assert.throws(() => f.host.optionsForTurn(f.record.id, { turnId: 'old' }), { code: 'workspace_turn_mismatch' });
  f.host.starting(f.record.id, d.opts); f.host.spawned(f.record.id, { pid: 123 }); await guard.complete({ accepted: true });
  f.flags.background = true; f.host.settled(f.record.id, { status: 'succeeded' });
  assert.equal(f.host.occupied(f.record.id), true); assert.equal(f.flags.closes, 0);
  f.flags.background = false; f.host.occupied(f.record.id); await new Promise(setImmediate);
  assert.equal(f.host.occupied(f.record.id), false); assert.equal(f.flags.closes, 1);
  const next = f.descriptor('n'); await f.host.beforeDeliver(next); assert.equal(f.flags.creates, 1);
});
test('a resident refusing to park retains its lease without being killed', async t => {
  const f = await hostFixture(t);
  f.deps.parkPersistent = () => ({ parked: false });
  const d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 't'); f.host.starting(f.record.id, d.opts);
  await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'succeeded' });
  await new Promise(setImmediate);
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.flags.closes, 0);
  f.deps.parkPersistent = () => ({ parked: true });
  f.host.occupied(f.record.id); await new Promise(setImmediate);
  assert.equal(f.host.hasActiveLease(f.record.id), false);
});
test('accepted duplicate without launch and failed materialization both release only their reservation', async t => {
  const f = await hostFixture(t); const d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  await guard.complete({ accepted: true }); assert.equal(f.host.occupied(f.record.id), false);
  f.deps.validate = async () => ({ ok: false });
  await assert.rejects(f.host.beforeDeliver(f.descriptor('bad')), { code: 'workspace_materialization_unverified' });
  assert.equal(fs.existsSync(f.record.worktreePath), true);
  assert.equal(f.host.snapshot().workspaces[0].residency, 'retained');
  assert.equal(f.host.snapshot().leases.length, 0);
  f.deps.validate = async () => ({ ok: true });
  const retry = f.descriptor('retry'), retryGuard = await f.host.beforeDeliver(retry);
  assert.equal(f.host.snapshot().workspaces[0].residency, 'resident');
  assert.deepEqual(f.host.snapshot().workspaces[0].pins, [], 'successful validation clears the transient failure pin');
  await retryGuard.complete({ accepted: false });
});
test('post-materialization role failure releases the lease without pinning a healthy worktree', async t => {
  const f = await hostFixture(t), d = f.descriptor('role-failure');
  f.store.set('receipt', 'bad-role', { id: 'bad-role', taskId: 'missing-task', roleSnapshotId: 'missing-snapshot' });
  d.opts.taskShellReceiptId = 'bad-role';
  await assert.rejects(f.host.beforeDeliver(d), { code: 'role_snapshot_unverified' });
  const workspace = f.host.snapshot().workspaces[0];
  assert.equal(workspace.residency, 'resident');
  assert.deepEqual(workspace.pins, []);
  assert.equal(f.host.snapshot().leases.length, 0);
});
test('resident pressure enters directory-scoped hibernation, reconciles immediately and retries admission', async t => {
  let victimPath;
  const reliefCalls = [];
  const f = await hostFixture(t, {
    limits: { executionLimit: 2, residentLimit: 1, restoreLimit: 1 },
    reclaimForCapacity: async input => {
      reliefCalls.push(input);
      fs.rmSync(victimPath, { recursive: true, force: true });
      return { ok: true, considered: 1, hibernated: 1 };
    },
  });
  victimPath = path.join(f.dir, 'old-resident');
  fs.mkdirSync(victimPath);
  const victim = f.registry.register({ ownerId: 'old-resident', dirId: 'd', path: victimPath,
    branch: 'old-resident', residency: 'resident' });

  assert.equal(f.host.occupied(f.record.id), false,
    'resident pressure must reach asynchronous relief instead of wedging in the busy probe');
  const descriptor = f.descriptor('capacity-relief');
  const guard = await f.host.beforeDeliver(descriptor);
  assert.deepEqual(reliefCalls, [{ dirId: 'd', excludeSessionIds: [f.record.id], count: 1 }]);
  const snapshot = f.host.snapshot();
  assert.equal(snapshot.workspaces.find(w => w.id === victim.id).residency, 'hibernated');
  assert.equal(snapshot.workspaces.find(w => w.ownerId === f.record.id).residency, 'resident');
  await guard.complete({ accepted: false, durable: false });
});
test('a resident conflicted checkout is admitted in place instead of blocking its conversation', async t => {
  const f = await hostFixture(t);
  const first = f.descriptor('first'), firstGuard = await f.host.beforeDeliver(first);
  await firstGuard.complete({ accepted: false, durable: false });
  const warnings = [];
  f.deps.log = (event, fields) => warnings.push({ event, fields });
  f.deps.validate = async () => ({
    ok: false,
    code: 'WORKTREE_BRANCH_MISMATCH',
    pathExists: true,
    branchExists: true,
  });
  const next = f.descriptor('during-conflict');
  const guard = await f.host.beforeDeliver(next);
  assert.ok(next.opts.workspacePermit, 'the runner receives its normal workspace permit');
  assert.equal(warnings.at(-1)?.event, 'workspace_git_state_degraded_continuing');
  await guard.complete({ accepted: false, durable: false });
});
test('broken workspace identity uses bounded delivery retries, not infinite backpressure', async t => {
  const f = await hostFixture(t);
  f.deps.directories.delete('d');
  await assert.rejects(
    f.host.beforeDeliver(f.descriptor('missing-directory')),
    error => error.code === 'workspace_directory_missing' && error.backpressure === false,
  );
});
test('response loss after launch pins the original operation', async t => {
  const f = await hostFixture(t), d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  f.host.starting(f.record.id, d.opts); await guard.complete({ accepted: false });
  assert.equal(f.host.snapshot().leases[0].state, 'uncertain');
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  await assert.rejects(f.host.beforeDeliver(d), { code: 'workspace_launch_unresolved' });
});
test('delivery cannot acquire while hibernation owns the transition window', async t => {
  const f = await hostFixture(t);
  f.record.workspaceState = 'hibernating';
  await assert.rejects(f.host.beforeDeliver(f.descriptor('racing-delivery')), { code: 'workspace_busy' });
  assert.equal(f.host.snapshot().leases.length, 0);
});
test('terminal callback before runner cleanup releases after the finalizer boundary', async t => {
  const f = await hostFixture(t), d = f.descriptor('m');
  const guard = await f.host.beforeDeliver(d); f.host.starting(f.record.id, d.opts); f.host.spawned(f.record.id, { pid: 1 }); await guard.complete({ accepted: true });
  f.state._activeRunner = { id: 'current' };
  f.host.settled(f.record.id, { status: 'succeeded' });
  assert.equal(f.host.snapshot().leases.length, 1);
  f.state._activeRunner = null;
  await new Promise(setImmediate);
  assert.equal(f.host.snapshot().leases.length, 0, 'release requires neither a new queued message nor a UI read');
});

test('final runner evidence is captured before releasing the workspace for the next turn', async t => {
  const f = await hostFixture(t), d = f.descriptor('m');
  const guard = await f.host.beforeDeliver(d); f.host.bindTurn(f.record.id, d.opts, 'turn-final', 'task-final');
  f.host.starting(f.record.id, d.opts, 'attempt-final'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'completed' });
  f.host.finalized({ sessionName: f.record.id, turn: { turnId: 'turn-final', resultDurable: true }, usageDurable: true,
    runner: { providerAttempt: { routeAttemptId: 'attempt-final' } } },
  { effects: [{ type: 'classify-turn-end', classification: 'succeeded' }], facts: { completion: { state: 'completed' } } });
  assert.equal(f.host.snapshot().leases.length, 1);
  for (let i = 0; i < 100 && f.host.snapshot().leases.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.host.snapshot().leases.length, 0);
  const result = f.host.deliveryEvidence(f.record.id).run;
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.attemptId, 'attempt-final'); assert.ok(result.endCodeRevision);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier.writersStopped, true);
});

test('stopped-writer capture is shared by the result and barrier, while next admission observes fresh bytes', async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  const calls = [];
  let hold, release;
  const f = await hostFixture(t, { captureCodeRevision: async cwd => {
    calls.push(cwd);
    if (hold) await hold;
    return captureCodeRevision(cwd);
  } });
  const releases = [];
  f.deps.log = (event, fields) => { if (event === 'workspace_release_completed') releases.push(fields); };
  const d = f.descriptor('one'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'shared-scan', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.flags.background = true;
  f.host.settled(f.record.id, { status: 'completed' });
  f.host.finalized({ sessionName: f.record.id, turn: { turnId: 'shared-scan', resultDurable: true }, usageDurable: true,
    runner: { providerAttempt: { routeAttemptId: 'attempt' } } },
  { effects: [{ type: 'classify-turn-end', classification: 'succeeded' }], facts: {} });
  await new Promise(setImmediate);
  assert.equal(calls.length, 0, 'no end snapshot is taken while a writer is live');
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  fs.writeFileSync(path.join(f.record.worktreePath, 'last-write'), 'background completed');
  hold = new Promise(resolve => { release = resolve; });
  f.flags.background = false;
  f.host.occupied(f.record.id);
  for (let i = 0; i < 10 && calls.length < 1; i++) await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(f.host.hasActiveLease(f.record.id), true, 'capture must finish before lease release');
  await assert.rejects(f.host.beforeDeliver(f.descriptor('blocked')), { code: 'workspace_busy' });
  release(); hold = null;
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(calls.length, 1, 'the stopped-writer capture is the only scan: no ordinary-round start bridge');
  assert.equal(releases.length, 1);
  for (const key of ['terminalWaitMs', 'stopMs', 'evidenceMs', 'totalMs', 'observationQueueMs', 'observationMs']) {
    assert.ok(Number.isInteger(releases[0][key]) && releases[0][key] >= 0, key);
  }
  const { run, barrier } = f.host.deliveryEvidence(f.record.id);
  assert.equal(run.endCodeRevision, barrier.codeRevision);
  assert.equal(barrier.dirty, true);
  fs.writeFileSync(path.join(f.record.worktreePath, 'last-write'), 'external edit after release');
  const next = f.descriptor('next'), nextGuard = await f.host.beforeDeliver(next);
  f.host.bindTurn(f.record.id, next.opts, 'next-turn', 'task');
  const binding = f.store.get('delivery:run', 'next-turn').binding;
  // The ordinary-round start scan is deleted: the next admission carries the
  // fence-verified drain observation as its start evidence, so bytes written
  // after the release (outside any lease) no longer trigger a rescan.
  assert.equal(binding.startCodeRevision, run.endCodeRevision, 'start evidence is the carried drain observation');
  assert.equal(calls.length, 1);
  await nextGuard.complete({ accepted: false });
});

test('forced cancellation without a finalizer still drains with one stopped-writer observation', async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  let captures = 0;
  const f = await hostFixture(t, { captureCodeRevision: cwd => { captures++; return captureCodeRevision(cwd); } });
  const d = f.descriptor('cancel'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'cancelled-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'cancelled' });
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(captures, 1);
  assert.equal(f.host.deliveryEvidence(f.record.id).run.outcome, 'cancelled');
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier.writersStopped, true);
});

test('a writer becoming live during observation retains the lease and requires a fresh capture', async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  let captures = 0, entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const f = await hostFixture(t, { captureCodeRevision: async cwd => {
    if (++captures === 1) { entered(); await held; }
    return captureCodeRevision(cwd);
  } });
  const d = f.descriptor('race'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'racing-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'cancelled' });
  await waiting;
  f.flags.background = true; finish();
  await d.opts.workspacePermit.drainPromise;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  f.flags.background = false;
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(captures, 2);
});

for (const kind of ['session', 'stream']) test(`${kind} reactivation during observation retains the lease and writes no evidence`, async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  let captures = 0, entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const f = await hostFixture(t, { captureCodeRevision: async cwd => {
    if (++captures === 1) { entered(); await held; }
    return captureCodeRevision(cwd);
  } });
  const d = f.descriptor(`race-${kind}`), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, `racing-${kind}`, 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'cancelled' });
  await waiting;
  if (kind === 'session') f.state.isStreaming = true; else f.flags.stream = true;
  finish(); await d.opts.workspacePermit.drainPromise;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier, null);
  if (kind === 'session') f.state.isStreaming = false; else f.flags.stream = false;
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(captures, 2);
});

for (const kind of ['session', 'background', 'stream']) test(`a transient ${kind} activity during capture invalidates the SQLite fence`, async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  let captures = 0, entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const f = await hostFixture(t, { captureCodeRevision: async cwd => {
    if (++captures === 1) { entered(); await held; }
    return captureCodeRevision(cwd);
  } });
  const d = f.descriptor(`transient-${kind}`), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, `transient-${kind}`, 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'cancelled' });
  await waiting;
  f.host.recordWriterActivity(f.record.id, kind);
  finish(); await d.opts.workspacePermit.drainPromise;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier, null);
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(captures, 2);
});

test('a separately registered writer blocks actual release before any background event arrives', async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  let captures = 0, entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const f = await hostFixture(t, { captureCodeRevision: async cwd => {
    if (++captures === 1) { entered(); await held; }
    return captureCodeRevision(cwd);
  } });
  const d = f.descriptor('cooperative-external'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'cooperative-external-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'cancelled' });
  await waiting;
  const other = createTaskShellStore(f.file); t.after(() => other.close());
  const lease = d.opts.workspacePermit.lease;
  const input = { workspaceId: lease.workspaceId, leaseId: lease.id, epoch: lease.epoch,
    generation: lease.generation, sessionId: f.record.id, writerId: 'external-writer', writerKind: 'background' };
  other.writerLeaseAcquire(input);
  fs.writeFileSync(path.join(f.record.worktreePath, 'external-write'), 'before any notification');
  finish(); await d.opts.workspacePermit.drainPromise;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier, null);
  other.writerLeaseRelease(input);
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(captures, 2);
});

test('a session process is leased before it writes and remains leased until close', async t => {
  const { spawn } = require('node:child_process');
  let retained;
  const held = new Promise(resolve => { retained = resolve; });
  const f = await hostFixture(t), d = f.descriptor('process-writer');
  const guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'process-writer-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.deps.log = event => { if (event === 'workspace_release_retained') retained(); };
  const writer = f.host.acquireProcessWriter(f.record.id);
  const marker = path.join(f.record.worktreePath, 'written-before-notification');
  const child = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'written'); process.stdin.once('data', () => process.exit(0)); process.stdin.resume();", marker],
    { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
  const exited = new Promise(resolve => child.once('close', () => { f.host.finishProcessWriter(f.record.id, writer); resolve(); }));
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(marker), true);
  f.host.settled(f.record.id, { status: 'cancelled' });
  await held;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  child.stdin.end('stop'); await exited;
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
});

test('a writer registration failure refuses to create a process token', async t => {
  const f = await hostFixture(t), d = f.descriptor('writer-registration-failure');
  const guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'writer-registration-failure-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  const { databaseConstructor } = require('../src/sqlite/driver');
  const raw = new (databaseConstructor())(f.file); t.after(() => raw.close());
  raw.exec(`CREATE TRIGGER reject_writer BEFORE INSERT ON shell_records
    WHEN NEW.kind = 'workspace:writer-leases' BEGIN SELECT RAISE(ABORT, 'injected_writer_failure'); END;`);
  assert.throws(() => f.host.acquireProcessWriter(f.record.id), /injected_writer_failure/);
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
});

test('a failed process-lease release is retried before the workspace is freed', async t => {
  let retained;
  const held = new Promise(resolve => { retained = resolve; });
  const f = await hostFixture(t), d = f.descriptor('process-release-failure');
  const guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'process-release-failure-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  const writer = f.host.acquireProcessWriter(f.record.id);
  const { databaseConstructor } = require('../src/sqlite/driver');
  const raw = new (databaseConstructor())(f.file); t.after(() => raw.close());
  raw.exec(`CREATE TRIGGER reject_writer_release BEFORE UPDATE ON shell_records
    WHEN NEW.kind = 'workspace:writer-leases' BEGIN SELECT RAISE(ABORT, 'injected_writer_release_failure'); END;`);
  f.host.finishProcessWriter(f.record.id, writer);
  f.deps.log = event => { if (event === 'workspace_release_retained') retained(); };
  f.host.settled(f.record.id, { status: 'cancelled' });
  await held;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  raw.exec('DROP TRIGGER reject_writer_release');
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier.writersStopped, true);
});

test('a failed writer fence update retains the lease until the update is retried', async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  let captures = 0, entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const f = await hostFixture(t, { captureCodeRevision: async cwd => {
    if (++captures === 1) { entered(); await held; }
    return captureCodeRevision(cwd);
  } });
  const d = f.descriptor('fence-failure'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'fence-failure-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  const { databaseConstructor } = require('../src/sqlite/driver');
  const raw = new (databaseConstructor())(f.file); t.after(() => raw.close());
  f.host.settled(f.record.id, { status: 'cancelled' });
  await waiting;
  raw.exec(`CREATE TRIGGER reject_fence BEFORE UPDATE ON shell_records
    WHEN NEW.kind = 'workspace:writer-fence' BEGIN SELECT RAISE(ABORT, 'injected_fence_failure'); END;`);
  assert.throws(() => f.host.recordWriterActivity(f.record.id, 'background'), /injected_fence_failure/);
  finish(); await d.opts.workspacePermit.drainPromise;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  raw.exec('DROP TRIGGER reject_fence');
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(captures, 2);
});

test('a stopped writer without finalizer facts releases without manufacturing successful evidence', async t => {
  for (const status of ['succeeded', 'cancelled', undefined]) {
    const f = await hostFixture(t), d = f.descriptor('missing-finalizer');
    const guard = await f.host.beforeDeliver(d);
    f.host.bindTurn(f.record.id, d.opts, 'missing-finalizer-turn', 'task');
    f.host.starting(f.record.id, d.opts); await guard.complete({ accepted: true });
    f.host.settled(f.record.id, { status });
    for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(f.host.hasActiveLease(f.record.id), false);
    assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
    assert.equal(f.host.deliveryEvidence(f.record.id).barrier, null);
  }
});

test('a previously persisted result gains a barrier even when no new finalizer arrives', async t => {
  const f = await hostFixture(t), d = f.descriptor('persisted-result');
  const guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'persisted-result-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  const { createDeliveryEvidence } = require('../src/task-routing/evidence');
  const evidence = createDeliveryEvidence(f.store);
  const previous = await evidence.finalize('persisted-result-turn', {
    attemptId: 'attempt', outcome: 'succeeded', resultDurable: true, usageDurable: true, pendingInput: false,
  });
  f.host.settled(f.record.id, { status: 'succeeded' });
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  const actual = f.host.deliveryEvidence(f.record.id);
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.deepEqual(actual.run, previous);
  assert.equal(actual.barrier.codeRevision, previous.endCodeRevision);
});

test('failed run-result persistence keeps the lease and retries with a fresh stopped-writer capture', async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  let captures = 0, failed;
  const retained = new Promise(resolve => { failed = resolve; });
  const f = await hostFixture(t, { captureCodeRevision: cwd => { captures++; return captureCodeRevision(cwd); } });
  const { databaseConstructor } = require('../src/sqlite/driver');
  const raw = new (databaseConstructor())(f.file);
  t.after(() => raw.close());
  raw.exec(`CREATE TRIGGER reject_result BEFORE INSERT ON shell_records
    WHEN NEW.kind = 'task-first:run-result' BEGIN SELECT RAISE(ABORT, 'injected_write_failure'); END;`);
  f.deps.log = event => { if (event === 'workspace_release_retained') failed(); };
  const d = f.descriptor('write-failure'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'write-failure-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'cancelled' });
  await retained;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier, null);
  assert.equal(f.store.get('delivery:run', 'write-failure-turn').state, 'running');
  assert.equal(captures, 1);
  raw.exec('DROP TRIGGER reject_result');
  fs.writeFileSync(path.join(f.record.worktreePath, 'retry-content'), 'fresh after write failure');
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(captures, 2);
  const { run, barrier } = f.host.deliveryEvidence(f.record.id);
  assert.equal(run.outcome, 'cancelled');
  assert.equal(run.endCodeRevision, barrier.codeRevision);
  assert.equal(barrier.dirty, true);
});

test('a barrier write failure rolls back the result and keeps the real workspace lease', async t => {
  let failed;
  const retained = new Promise(resolve => { failed = resolve; });
  const f = await hostFixture(t);
  const { databaseConstructor } = require('../src/sqlite/driver');
  const raw = new (databaseConstructor())(f.file);
  t.after(() => raw.close());
  raw.exec(`CREATE TRIGGER reject_barrier BEFORE INSERT ON shell_records
    WHEN NEW.kind = 'task-first:writer-barrier' BEGIN SELECT RAISE(ABORT, 'injected_barrier_failure'); END;`);
  f.deps.log = event => { if (event === 'workspace_release_retained') failed(); };
  const d = f.descriptor('barrier-failure'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'barrier-failure-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'cancelled' });
  await retained;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier, null);
  assert.equal(f.store.get('delivery:run', 'barrier-failure-turn').state, 'running');
  raw.exec('DROP TRIGGER reject_barrier');
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier.writersStopped, true);
});

test('a lease release write failure rolls back the result and barrier', async t => {
  let failed;
  const retained = new Promise(resolve => { failed = resolve; });
  const f = await hostFixture(t);
  const { databaseConstructor } = require('../src/sqlite/driver');
  const raw = new (databaseConstructor())(f.file);
  t.after(() => raw.close());
  f.deps.log = event => { if (event === 'workspace_release_retained') failed(); };
  const d = f.descriptor('release-write-failure'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'release-write-failure-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  raw.exec(`CREATE TRIGGER reject_operation BEFORE UPDATE ON shell_records
    WHEN NEW.kind = 'workspace:operation' BEGIN SELECT RAISE(ABORT, 'injected_release_failure'); END;`);
  f.host.settled(f.record.id, { status: 'cancelled' });
  await retained;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier, null);
  assert.equal(f.store.get('delivery:run', 'release-write-failure-turn').state, 'running');
  raw.exec('DROP TRIGGER reject_operation');
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier.writersStopped, true);
});

test('a writer detected after result preparation rolls back evidence and release', async t => {
  const { captureCodeRevision } = require('../src/task-routing/code-revision');
  let calls = 0, captures = 0, f, retained;
  const stopped = new Promise(resolve => { retained = resolve; });
  f = await hostFixture(t, { captureCodeRevision: async cwd => {
    const code = await captureCodeRevision(cwd);
    if (++captures === 1) f.deps.hasBackground = () => ++calls >= 2;
    return code;
  } });
  f.deps.log = event => { if (event === 'workspace_release_retained') retained(); };
  const d = f.descriptor('late-liveness'), guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'late-liveness-turn', 'task');
  f.host.starting(f.record.id, d.opts, 'attempt'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'cancelled' });
  await stopped;
  assert.equal(f.host.hasActiveLease(f.record.id), true);
  assert.equal(f.host.deliveryEvidence(f.record.id).run, null);
  assert.equal(f.host.deliveryEvidence(f.record.id).barrier, null);
  f.deps.hasBackground = () => false;
  for (let i = 0; i < 100 && f.host.hasActiveLease(f.record.id); i++) {
    f.host.occupied(f.record.id); await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.host.hasActiveLease(f.record.id), false);
  assert.equal(captures, 2);
});

test('separation barrier holds the workspace, rechecks the frozen revision and records application', async t => {
  const f = await hostFixture(t), d = f.descriptor('source-run');
  const guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'turn-separate', 'task-source');
  f.host.starting(f.record.id, d.opts, 'attempt-separate'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'completed' });
  f.host.finalized({ sessionName: f.record.id, turn: { turnId: 'turn-separate', resultDurable: true }, usageDurable: true,
    runner: { providerAttempt: { routeAttemptId: 'attempt-separate' } } },
  { effects: [{ type: 'classify-turn-end', classification: 'succeeded' }], facts: { completion: { state: 'completed' } } });
  for (let i = 0; i < 100 && f.host.snapshot().leases.length; i++) await new Promise(r => setTimeout(r, 20));
  let captured;
  await f.host.withSeparationBarrier({ sessionId: f.record.id, turnId: 'turn-separate', separationId: 'sep-test' }, async value => {
    captured = value;
    await assert.rejects(f.host.beforeDeliver(f.descriptor('late-input')), { code: 'workspace_busy' });
  });
  assert.equal(captured.barrier.separationId, 'sep-test'); assert.equal(captured.code.dirty, false);
  f.store.set('task', 'task-target', { id: 'task-target', sessionId: 'task-target-session',
    ownerShellId: 'task-target-shell', separatedFromTaskId: 'task-source', ready: true });
  f.store.set('shell', 'task-target-shell', { id: 'task-target-shell', sourceSessionId: 'task-target-session',
    currentTaskId: 'task-target', defaultTaskId: 'task-target', standalone: true });
  f.store.set('link', 'task-target-shell:task-target', { shellId: 'task-target-shell', taskId: 'task-target' });
  const application = f.host.recordSeparationApplication({ separationId: 'sep-test', sourceSessionId: f.record.id,
    sourceTaskId: 'task-source', targetTaskId: 'task-target', targetSessionId: 'task-target-session',
    targetShellId: 'task-target-shell', turnId: 'turn-separate', barrierId: captured.barrier.id });
  assert.equal(f.host.deliveryEvidence(f.record.id, 'turn-separate').application.id, application.id);
  const next = f.descriptor('after-barrier'), nextGuard = await f.host.beforeDeliver(next);
  await nextGuard.complete({ accepted: false, durable: false });
});

test('a separation barrier accepts the checkout AutoCommit moved after the turn ended', async t => {
  const f = await hostFixture(t), d = f.descriptor('drift-run');
  const guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'turn-drift', 'task-source');
  f.host.starting(f.record.id, d.opts, 'attempt-drift'); await guard.complete({ accepted: true });
  f.host.settled(f.record.id, { status: 'completed' });
  f.host.finalized({ sessionName: f.record.id, turn: { turnId: 'turn-drift', resultDurable: true }, usageDurable: true,
    runner: { providerAttempt: { routeAttemptId: 'attempt-drift' } } },
  { effects: [{ type: 'classify-turn-end', classification: 'succeeded' }], facts: { completion: { state: 'completed' } } });
  for (let i = 0; i < 100 && f.host.snapshot().leases.length; i++) await new Promise(r => setTimeout(r, 20));
  const finished = f.host.deliveryEvidence(f.record.id, 'turn-drift').run;
  assert.ok(finished.endCodeRevision);
  assert.equal(f.host.deliveryEvidence(f.record.id, 'turn-drift').barrier.codeRevision, finished.endCodeRevision);
  // The reported production race: AutoCommit lands right after the turn closed,
  // so the revision the finished turn recorded is no longer the checkout.
  fs.writeFileSync(path.join(f.record.worktreePath, 'autocommit.txt'), 'landed after the turn\n');
  let captured;
  await f.host.withSeparationBarrier({ sessionId: f.record.id, turnId: 'turn-drift', separationId: 'sep-drift' },
    async value => { captured = value; });
  assert.equal(captured.barrier.revisionDrifted, true, 'the drift is recorded, not refused');
  assert.equal(captured.barrier.runEndRevision, finished.endCodeRevision);
  assert.equal(captured.code.dirty, true, 'uncommitted work is exactly what the new task takes over');
  const view = f.host.deliveryEvidence(f.record.id, 'turn-drift');
  assert.equal(view.barrier.id, captured.barrier.id, 'the card shows the barrier that was actually taken');
  assert.equal(view.barrier.writersStopped, true);
});
test('separation drains a terminal wait-for-user lease before taking its snapshot', async t => {
  const f = await hostFixture(t), d = f.descriptor('waiting-source');
  const guard = await f.host.beforeDeliver(d);
  f.host.bindTurn(f.record.id, d.opts, 'turn-waiting', 'task-source');
  f.host.starting(f.record.id, d.opts, 'attempt-waiting'); await guard.complete({ accepted: true });
  f.flags.pendingInput = { requestId: 'usrq-waiting' };
  f.host.settled(f.record.id, { status: 'waiting' });
  f.host.finalized({ sessionName: f.record.id, turn: { turnId: 'turn-waiting', resultDurable: true }, usageDurable: true,
    runner: { providerAttempt: { routeAttemptId: 'attempt-waiting' } } },
  { effects: [], facts: { completion: { state: 'completed' } } });
  let captured;
  await f.host.withSeparationBarrier({ sessionId: f.record.id, turnId: 'turn-waiting', separationId: 'sep-waiting' }, async value => {
    captured = value;
  });
  assert.equal(f.host.deliveryEvidence(f.record.id, 'turn-waiting').run.outcome, 'waiting');
  assert.equal(captured.barrier.separationId, 'sep-waiting');
  assert.equal(captured.code.dirty, false);
});

test('an uncertain lease whose writer pid is provably dead is reclaimed without waiting out the threshold', async t => {
  const f = await hostFixture(t), d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  f.host.starting(f.record.id, d.opts); f.host.spawned(f.record.id, { pid: 99999999 });
  await guard.complete({ accepted: false });
  assert.equal(f.host.snapshot().leases[0].state, 'uncertain');
  for (let i = 0; i < 50 && f.host.snapshot().leases.length; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(f.host.snapshot().leases.length, 0, 'a crashed writer must not wedge its workspace forever');
});

test('an uncertain lease with a live writer pid survives below the staleness threshold', async t => {
  const f = await hostFixture(t), d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  f.host.starting(f.record.id, d.opts); f.host.spawned(f.record.id, { pid: process.pid });
  await guard.complete({ accepted: false });
  assert.equal(f.host.snapshot().leases[0].state, 'uncertain');
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(f.host.snapshot().leases.length, 1, 'a possibly-live writer keeps its lease');
});

test('an uncertain lease with no writer pid is reclaimed once past the staleness threshold', async t => {
  const f = await hostFixture(t), d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  f.host.starting(f.record.id, d.opts);
  await guard.complete({ accepted: false });
  assert.equal(f.host.snapshot().leases[0].state, 'uncertain');
  assert.equal(f.host.snapshot().leases[0].pid ?? null, null);
  f.deps.budgets = { staleUncertainMs: 0 };
  for (let i = 0; i < 50 && f.host.snapshot().leases.length; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(f.host.snapshot().leases.length, 0);
});

test('a relocated owner rebinds to its new path instead of failing forever', t => {
  const f = fixture(t);
  const before = f.registry.register({ ownerId: 'a', dirId: 'd1', path: path.join(f.dir, 'old'), branch: 'a' });
  // Same owner, another directory: the id is the path, so the move changes it.
  const after = f.registry.register({ ownerId: 'a', dirId: 'd2', path: path.join(f.dir, 'new'), branch: 'a' });
  assert.notEqual(after.id, before.id);
  assert.equal(f.registry.binding('a').workspaceId, after.id);
  assert.equal(f.registry.workspace(before.id).residency, 'planned', 'the workspace it left is still recorded');
});

test('a live writer on the workspace being left refuses the rebind', t => {
  const f = fixture(t);
  const before = f.registry.register({ ownerId: 'a', dirId: 'd1', path: path.join(f.dir, 'old'), branch: 'a' });
  f.registry.acquire(before.id, 'a', 'm');
  assert.throws(
    () => f.registry.register({ ownerId: 'a', dirId: 'd2', path: path.join(f.dir, 'new'), branch: 'a' }),
    { code: 'workspace_binding_conflict' },
  );
  assert.equal(f.registry.binding('a').workspaceId, before.id);
});

test('a relocated worktree never reads as a busy workspace', async t => {
  const f = await hostFixture(t), d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  await guard.complete({ accepted: true });
  assert.equal(f.host.occupied(f.record.id), false);
  const repo = path.join(f.dir, 'repo2'); fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']); git(['commit', '--allow-empty', '-m', 'base']);
  const left = f.registry.binding(f.record.id).workspaceId;
  f.deps.directories.set('d2', { id: 'd2', path: repo, baseBranch: 'main' });
  f.record.dirId = 'd2'; f.record.worktreePath = path.join(repo, '.multicc-worktrees/task-test');
  assert.equal(f.host.occupied(f.record.id), false, 'the workspace it left must not be reported as busy');
  assert.notEqual(f.registry.binding(f.record.id).workspaceId, left, 'and the binding follows the owner');
});

test('an unidentifiable workspace names its failure instead of reading as busy', async t => {
  const f = await hostFixture(t);
  f.deps.directories.delete('d');
  assert.throws(() => f.host.occupied(f.record.id), { code: 'workspace_directory_missing' });
});

test('reclaim demotes a workspace whose directory is gone and keeps the rest', t => {
  const f = fixture(t);
  const gone = f.add('gone', 'resident'), retained = f.add('retained', 'retained'), kept = f.add('kept', 'resident');
  assert.deepEqual(f.registry.reclaim(record => ([gone.id, retained.id].includes(record.id) ? 'gone' : 'present')),
    [gone.id, retained.id]);
  assert.equal(f.registry.workspace(gone.id).residency, 'hibernated');
  assert.equal(f.registry.workspace(retained.id).residency, 'hibernated');
  assert.equal(f.registry.workspace(kept.id).residency, 'resident');
  assert.equal(f.registry.workspace(gone.id).path, gone.path, 'the record keeps its identity');
});

test('reclaim never takes a workspace that holds a live lease', t => {
  const f = fixture(t);
  const busy = f.add('busy', 'resident');
  f.registry.acquire(busy.id, 'busy', 'm');
  assert.deepEqual(f.registry.reclaim(() => 'gone'), []);
  assert.equal(f.registry.workspace(busy.id).residency, 'resident');
});

test('a refused directory names its reason, its fix and whether retrying can help', async t => {
  const f = await hostFixture(t);
  // The same wiring server.js installs: the directory vocabulary (prose, fix
  // code, permanence) stays in src/directories.js.
  const { friendlyDirReason, dirReasonFix, isPermanentDirReason } = require('../src/directories');
  f.deps.describeDirFailure = reason => ({
    detail: friendlyDirReason(reason),
    fix: dirReasonFix(reason),
    permanent: isPermanentDirReason(reason),
  });
  const logged = [];
  f.deps.log = (event, data) => logged.push({ event, data });
  const cases = [
    { reason: 'unsuitable: 该目录体积过大（超过 2GB），不适合作为 session 目录，请选择具体的项目目录',
      says: '体积过大', fix: null, permanent: true },
    { reason: 'permission-denied: /Users/someone/Downloads/working',
      says: '访问或写入该目录时被拒绝', fix: 'open-disk-access', permanent: true },
    { reason: 'home-or-above',
      says: '$HOME', fix: null, permanent: true },
    { reason: 'git-error: fatal: not a git repository',
      says: '无法将目录初始化为 git 仓库', fix: null, permanent: false },
  ];
  for (const [index, expected] of cases.entries()) {
    f.deps.ensureDir = async () => ({ ok: false, reason: expected.reason });
    f.record.workspaceState = 'planned';
    const error = await f.host.beforeDeliver(f.descriptor(`refused-${index}`))
      .then(() => null, cause => cause);
    assert.equal(error.code, 'workspace_repository_not_ready');
    assert.equal(error.reason, expected.reason, 'the raw verdict stays on the error for the log');
    assert.ok(error.message.includes(expected.says), `lastError becomes readable prose: ${error.message}`);
    assert.equal(error.fix, expected.fix);
    assert.equal(error.retryable, !expected.permanent,
      'a verdict only a human can change must not spend the outbox retry budget');
  }
  assert.deepEqual(logged.map(line => line.event), cases.map(() => 'workspace_directory_not_ready'));
  assert.equal(logged[0].data.reason, cases[0].reason);
  assert.equal(logged[1].data.fix, 'open-disk-access');
  assert.equal(logged[3].data.permanent, false);
});

test('without a directory vocabulary the refusal keeps its old bare shape', async t => {
  const f = await hostFixture(t);
  f.deps.ensureDir = async () => ({ ok: false, reason: 'unsuitable: anything' });
  const error = await f.host.beforeDeliver(f.descriptor('bare')).then(() => null, cause => cause);
  assert.equal(error.code, 'workspace_repository_not_ready');
  assert.equal(error.retryable, undefined, 'the default retry path is unchanged for other hosts');
});

test('a worktree that disappears stops spending the resident budget', async t => {
  const f = await hostFixture(t), d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  await guard.complete({ accepted: true });
  const workspaceId = f.registry.binding(f.record.id).workspaceId;
  assert.equal(f.registry.workspace(workspaceId).residency, 'resident');
  // relocate/hibernate detach the directory; nothing tells the registry.
  fs.rmSync(f.record.worktreePath, { recursive: true, force: true });
  f.deps.budgets = { residencyReclaimMs: 0 };
  for (let i = 0; i < 50 && f.registry.workspace(workspaceId).residency === 'resident'; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(f.registry.workspace(workspaceId).residency, 'hibernated');
});
