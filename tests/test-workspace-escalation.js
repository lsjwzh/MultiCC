'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTaskShellStore } = require('../src/task-shell/store');
const { createWorkspaceAdmission } = require('../src/workspace/admission');
const { createWriterEscalation } = require('../src/workspace/writer-escalation');

// A process table the fake signals actually mutate, so "did it exit" is a real
// question for waitGone() rather than a constant.
function fakeTree() {
  const rows = [
    { pid: 100, ppid: 1, born: 'a', command: 'claude' },
    { pid: 101, ppid: 100, born: 'a', command: 'zsh -c wrapper' },
    { pid: 102, ppid: 101, born: 'a', command: 'npm run test:deterministic' },
    { pid: 103, ppid: 102, born: 'a', command: 'node --test tests/x.js' },
    { pid: 200, ppid: 1, born: 'b', command: 'unrelated' },
  ];
  const alive = new Set(rows.map(r => r.pid));
  const signals = [];
  const stubborn = new Set();
  return {
    rows, alive, signals, stubborn,
    table: () => rows.filter(row => alive.has(row.pid)),
    signal: (record, name) => {
      signals.push(`${record.pid}:${name}`);
      if (name === 'SIGTERM' && stubborn.has(record.pid)) return true;
      alive.delete(record.pid);
      return true;
    },
  };
}

test('descendants stop deepest first and the pinned writer is left to the managed close', async () => {
  const tree = fakeTree();
  const writers = createWriterEscalation({ table: tree.table, signal: tree.signal, log: () => {}, termGraceMs: 300, killGraceMs: 300 });
  const stopped = await writers.stopDescendants(100, { reason: 'test' });
  assert.equal(stopped.ok, true);
  assert.deepEqual(tree.signals, ['103:SIGTERM', '102:SIGTERM', '101:SIGTERM'],
    'the hung grandchild is signalled before its parents, and the writer itself is untouched');
  assert.equal(stopped.killed, 3);
  assert.equal(tree.alive.has(100), true);
  assert.equal(tree.alive.has(200), true, 'an unrelated process is never in the tree');
  const alone = await writers.stopDescendants(100, { reason: 'test' });
  assert.equal(alone.code, 'writer_has_no_descendants');
});

test('a TERM-ignoring tree is escalated to SIGKILL and a survivor is reported, never assumed stopped', async () => {
  const tree = fakeTree();
  tree.stubborn.add(102);
  const writers = createWriterEscalation({ table: tree.table, signal: tree.signal, log: () => {}, termGraceMs: 300, killGraceMs: 300 });
  const stopped = await writers.stopDescendants(100, { reason: 'test' });
  assert.equal(stopped.ok, true);
  assert.ok(tree.signals.includes('102:SIGKILL'));
  assert.equal(tree.alive.has(102), false);

  const unkillable = fakeTree();
  unkillable.stubborn.add(102); unkillable.stubborn.add('SIGKILL');
  unkillable.signal = (record, name) => { unkillable.signals.push(`${record.pid}:${name}`); return true; };
  const blind = createWriterEscalation({ table: unkillable.table, signal: unkillable.signal, log: () => {}, termGraceMs: 300, killGraceMs: 300 });
  const failed = await blind.stopDescendants(100, { reason: 'test' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'writer_descendants_survived');
  assert.deepEqual(failed.survivors, [103, 102, 101]);
});

test('escalation never signals the server process or a writer that already exited', async () => {
  const tree = fakeTree();
  const writers = createWriterEscalation({ table: tree.table, signal: tree.signal, log: () => {}, termGraceMs: 100, killGraceMs: 100 });
  const self = await writers.stopWriter(process.pid, { reason: 'test' });
  assert.equal(self.code, 'writer_pid_unusable');
  assert.deepEqual(tree.signals, []);
  const gone = await writers.stopWriter(999, { reason: 'test' });
  assert.deepEqual({ ok: gone.ok, code: gone.code, killed: gone.killed }, { ok: true, code: 'writer_already_gone', killed: 0 });
  const whole = await writers.stopWriter(100, { reason: 'test' });
  assert.equal(whole.ok, true);
  assert.deepEqual(tree.signals.slice(-4), ['103:SIGTERM', '102:SIGTERM', '101:SIGTERM', '100:SIGTERM']);
});

async function hostFixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-escalation-'));
  const file = path.join(dir, 'db.sqlite'), store = createTaskShellStore(file), repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['commit', '--allow-empty', '-m', 'base']);
  const record = { id: 'task-test', kind: 'chat', cli: 'claude', dirId: 'd', branch: 'multicc/task-test',
    worktreePath: path.join(repo, '.multicc-worktrees/task-test'), workspaceState: 'planned' };
  const records = new Map([[record.id, record]]), state = {};
  const flags = { background: false, silence: 0, reaps: 0, closes: 0, stops: 0, kills: 0, stubborn: false };
  const deps = { file, records, directories: new Map([['d', { id: 'd', path: repo, baseBranch: 'main' }]]),
    persistence: { mutate: (_source, fn) => fn(records) }, getState: () => state,
    ensureDir: async () => ({ ok: true }),
    addWorktree: async () => { git(['worktree', 'add', '-b', record.branch, record.worktreePath, 'main']); return { worktreePath: record.worktreePath, branch: record.branch }; },
    validate: async () => ({ ok: true }), hibernation: () => ({ ensureAwake: async () => ({ ok: true }) }),
    budgets: { stuckBlockedMs: 60000, stuckSilenceMs: 60000 },
    hasBackground: () => flags.background, streamBusy: () => false, pendingInput: () => null,
    // A stubborn writer is one the managed close cannot confirm and the reap
    // cannot silence — exactly the case escalation must report as incomplete.
    closePersistent: async () => { flags.closes += 1; return flags.stubborn ? { closed: false } : { closed: true }; },
    updateCwd: () => {}, log: () => {},
    reapBackground: () => { flags.reaps += 1; if (!flags.stubborn) flags.background = false; return flags.stubborn ? 0 : 2; },
    backgroundSilence: () => flags.silence,
    // Real process signals are never sent from a test: the escalation is the
    // unit under test, not /bin/kill.
    writerEscalation: {
      stopDescendants: async () => { flags.stops += 1;
        return flags.stubborn ? { ok: false, code: 'writer_descendants_survived', killed: 1, survivors: [73305] }
          : { ok: true, code: 'writer_descendants_stopped', killed: 2, survivors: [] }; },
      stopWriter: async () => { flags.kills += 1;
        return flags.stubborn ? { ok: false, code: 'writer_survived', killed: 1, survivors: [73305] }
          : { ok: true, code: 'writer_stopped', killed: 1, survivors: [] }; },
    },
    ...options.deps };
  const host = createWorkspaceAdmission(deps);
  t.after(() => host.close());
  host.initialize();
  const descriptor = id => ({ sessionId: record.id, item: { id }, opts: { deliveryId: id } });
  // Materialize, bind a running turn, then settle it: this is exactly the state
  // a wedged session is in — the turn is over, its lease is not.
  const pinned = async id => {
    const d = descriptor(id), guard = await host.beforeDeliver(d);
    host.starting(record.id, d.opts); host.spawned(record.id, { pid: 4242 });
    await guard.complete({ accepted: true });
    return d;
  };
  return { dir, store, host, record, records, state, flags, descriptor, pinned, deps };
}

test('a pinned lease is escalated only for a delivery that is really waiting', async t => {
  const f = await hostFixture(t);
  await f.pinned('m');
  f.flags.background = true;
  f.host.settled(f.record.id, { status: 'succeeded' });
  await new Promise(setImmediate);
  assert.equal(f.host.occupied(f.record.id), true, 'live background work holds the workspace');

  const idleProbe = await f.host.escalate(f.record.id, { source: 'test' });
  assert.deepEqual(idleProbe, { ok: false, escalated: false, released: false, code: 'no_blocked_delivery' });
  assert.equal(f.flags.stops, 0, 'nothing is killed while nobody is waiting on the workspace');

  f.host.noteBlockedDelivery(f.record.id);
  const outcome = await f.host.escalate(f.record.id, { source: 'test', reason: 'blocked_delivery' });
  assert.deepEqual({ ok: outcome.ok, escalated: outcome.escalated, released: outcome.released, killed: outcome.killed, reaped: outcome.reaped },
    { ok: true, escalated: true, released: true, killed: 2, reaped: 2 });
  assert.equal(f.flags.stops, 1);
  assert.equal(f.flags.closes >= 1, true, 'the writer is closed through the managed path, not only signalled');
  assert.equal(f.host.snapshot().leases.length, 0);
  assert.equal(f.host.occupied(f.record.id), false);
  // The next delivery gets the workspace back.
  const next = f.descriptor('n');
  await f.host.beforeDeliver(next);
  assert.equal(f.host.snapshot().leases.length, 1);
});

test('a running turn is never escalated, and an unconfirmed stop releases nothing', async t => {
  const f = await hostFixture(t);
  await f.pinned('m');
  f.flags.background = true;
  f.host.noteBlockedDelivery(f.record.id);
  const running = await f.host.escalate(f.record.id, { source: 'test' });
  assert.equal(running.code, 'turn_still_running');
  assert.equal(f.flags.stops, 0, 'the turn still owns its writer');

  f.host.settled(f.record.id, { status: 'succeeded' });
  await new Promise(setImmediate);
  f.flags.stubborn = true;
  const failed = await f.host.escalate(f.record.id, { source: 'test' });
  assert.equal(failed.ok, false);
  assert.equal(failed.escalated, true);
  assert.equal(failed.released, false);
  assert.deepEqual(failed.survivors, [73305]);
  assert.equal(f.flags.kills, 1, 'the writer that refused the managed close is signalled too');
  assert.equal(f.host.snapshot().leases.length, 1, 'an unverified writer keeps its lease');
  assert.equal(f.host.occupied(f.record.id), true);
});

test('cancel or insert in a sibling cannot kill or release the actual workspace writer', async t => {
  const f = await hostFixture(t);
  await f.pinned('active-writer');
  f.deps.getState = id => id === f.record.id ? { isStreaming: true } : {};
  f.records.set('sibling', { ...f.record, id: 'sibling', workspaceOwnerSessionId: f.record.id });
  f.host.noteBlockedDelivery('sibling');
  for (const trusted of [false, true]) {
    const result = await f.host.escalate('sibling', { source: trusted ? 'insert_queued' : 'manual_cancel', trusted });
    assert.equal(result.code, 'workspace_owned_by_other_session');
    assert.equal(result.released, false);
  }
  assert.equal(f.flags.stops + f.flags.kills + f.flags.closes + f.flags.reaps, 0);
  assert.equal(f.host.snapshot().leases[0].sessionId, f.record.id);
});

test('a long-blocked delivery is reported as stuck once, and is never reclaimed on a timer', async t => {
  const events = [];
  const f = await hostFixture(t, { deps: { log: (event, data) => events.push({ event, data }),
    budgets: { stuckBlockedMs: 0, stuckSilenceMs: 60000 } } });
  await f.pinned('m');
  f.flags.background = true;
  f.flags.silence = 30000;
  f.host.settled(f.record.id, { status: 'succeeded' });
  f.host.noteBlockedDelivery(f.record.id);
  await new Promise(setImmediate);

  // Still reporting progress: not stuck, and not even named as stuck.
  f.host.noticeStuckBlocked();
  assert.deepEqual(events, [], 'work that is still reporting progress is never called stuck');
  assert.equal(f.host.stuckHint(f.record.id), null);

  f.flags.silence = 600000;
  assert.equal(f.host.stuckHint(f.record.id), 'workspace_stuck_background');
  f.host.noticeStuckBlocked();
  f.host.noticeStuckBlocked();
  const stuck = events.filter(e => e.event === 'workspace_delivery_stuck');
  assert.equal(stuck.length, 1, 'a wedge does not log every second while it lasts');
  assert.equal(stuck[0].data.hint, 'stop_the_writer_manually');
  assert.equal(stuck[0].data.silenceMs, 600000, 'the report carries what it measured');
  // The whole point: naming it changes nothing. The lease is still held, nothing
  // was signalled, and the queued delivery is still waiting.
  assert.equal(f.flags.stops, 0);
  assert.equal(f.flags.kills, 0);
  assert.equal(f.flags.reaps, 0);
  assert.equal(f.host.snapshot().leases.length, 1);
  assert.equal(f.host.occupied(f.record.id), true);

  // The user's own decision is what stops it.
  const outcome = await f.host.escalate(f.record.id, { source: 'manual_cancel' });
  assert.equal(outcome.released, true);
  assert.equal(f.flags.stops, 1);
  assert.equal(f.host.occupied(f.record.id), false);
  assert.equal(f.host.stuckHint(f.record.id), null, 'the report is withdrawn once the writer is stopped');
});

test('a lease whose writer is not live at all is escalation-free and simply drains', async t => {
  const f = await hostFixture(t);
  await f.pinned('m');
  f.host.settled(f.record.id, { status: 'succeeded' });
  await new Promise(setImmediate);
  f.host.noteBlockedDelivery(f.record.id);
  assert.equal(f.host.stuckHint(f.record.id), null, 'nothing live behind the block: never reported as stuck');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.host.snapshot().leases.length, 0);
  assert.equal(f.flags.stops, 0);
  // The window is disarmed by the drain, so the stopped session reports the
  // truth — nothing is left to force — instead of signalling a dead pid.
  f.host.noteBlockedDelivery(f.record.id);
  const after = await f.host.escalate(f.record.id, { source: 'test' });
  assert.equal(after.code, 'no_active_lease');
  assert.equal(after.escalated, false);
  assert.equal(f.flags.kills, 0);
});
