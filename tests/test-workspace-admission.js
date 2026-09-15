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
async function hostFixture(t) {
  const f = fixture(t), repo = path.join(f.dir, 'repo'); fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']); git(['commit', '--allow-empty', '-m', 'base']);
  const record = { id: 'task-test', kind: 'chat', cli: 'codex', dirId: 'd', branch: 'multicc/task-test', worktreePath: path.join(repo, '.multicc-worktrees/task-test'), workspaceState: 'planned' };
  const records = new Map([[record.id, record]]), state = {}, flags = { background: false, closes: 0, creates: 0 };
  const deps = { file: f.file, records, directories: new Map([['d', { id: 'd', path: repo, baseBranch: 'main' }]]),
    persistence: { mutate: (_source, fn) => fn(records) }, getState: () => state,
    ensureDir: async () => ({ ok: true }), addWorktree: async () => { flags.creates++; git(['worktree', 'add', '-b', record.branch, record.worktreePath, 'main']); return { worktreePath: record.worktreePath, branch: record.branch }; },
    validate: async () => ({ ok: true }), hibernation: () => ({ ensureAwake: async () => ({ ok: true }) }),
    hasBackground: () => flags.background, streamBusy: () => false, closePersistent: async () => { flags.closes++; return { closed: true }; }, updateCwd: () => {}, log: () => {} };
  const host = createWorkspaceAdmission(deps); t.after(() => host.close()); host.initialize();
  const descriptor = id => ({ sessionId: record.id, item: { id }, opts: { deliveryId: id } });
  return { ...f, host, record, descriptor, flags, state, deps };
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
  f.host.starting(f.record.id, d.opts); await guard.complete({ accepted: false });
  assert.equal(f.host.snapshot().leases[0].state, 'uncertain');
  await assert.rejects(f.host.beforeDeliver(d), { code: 'workspace_launch_unresolved' });
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
