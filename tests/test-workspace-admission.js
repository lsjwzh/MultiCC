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
  const records = new Map([[record.id, record]]), state = {}, flags = { background: false, closes: 0, creates: 0 };
  const hibernationRuntime = {
    ensureAwake: async () => ({ ok: true }),
    reclaimForCapacity: options.reclaimForCapacity,
  };
  const deps = { file: f.file, records, directories: new Map([['d', { id: 'd', path: repo, baseBranch: 'main' }]]),
    persistence: { mutate: (_source, fn) => fn(records) }, getState: () => state,
    ensureDir: async () => ({ ok: true }), addWorktree: async () => { flags.creates++; git(['worktree', 'add', '-b', record.branch, record.worktreePath, 'main']); return { worktreePath: record.worktreePath, branch: record.branch }; },
    validate: async () => ({ ok: true }), hibernation: () => hibernationRuntime,
    budgets: options.limits,
    hasBackground: () => flags.background, streamBusy: () => false, closePersistent: async () => { flags.closes++; return { closed: true }; }, updateCwd: () => {}, log: () => {} };
  const host = createWorkspaceAdmission(deps); t.after(() => host.close()); host.initialize();
  const descriptor = id => ({ sessionId: record.id, item: { id }, opts: { deliveryId: id } });
  return { ...f, host, record, descriptor, flags, state, deps, hibernationRuntime };
}
test('first dispatch materializes once, rejects forged permits, and holds claim through background work', async t => {
  const f = await hostFixture(t); assert.equal(fs.existsSync(f.record.worktreePath), false);
  assert.throws(() => f.host.assertPermit(f.record.id, { workspacePermit: {} }), { code: 'workspace_admission_required' });
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
test('accepted duplicate without launch and failed materialization both release only their reservation', async t => {
  const f = await hostFixture(t); const d = f.descriptor('m'), guard = await f.host.beforeDeliver(d);
  await guard.complete({ accepted: true }); assert.equal(f.host.occupied(f.record.id), false);
  f.deps.validate = async () => ({ ok: false });
  await assert.rejects(f.host.beforeDeliver(f.descriptor('bad')), { code: 'workspace_materialization_unverified' });
  assert.equal(fs.existsSync(f.record.worktreePath), true);
  assert.equal(f.host.snapshot().workspaces[0].residency, 'retained');
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
