'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./helpers/task-shell');
const { createTaskShellRuntime } = require('../src/task-shell/runtime');
const { mountTaskShellRoutes } = require('../src/task-shell/routes');
const { createShellWorkspaceHost, sharedWorkspace } = require('../src/task-shell/workspace');
const { verifySnapshot } = require('../src/task-shell/context');

const input = (id, more = {}) => ({ text: id, clientMsgId: id, ...more });
test('late delivery cannot undo an explicit newer task or redirect its followup', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { send: async (_id, text) => { if (text === 'old') { started(); await gate; } return { ok: true }; } });
  f.runtime.adopt(f.a.id, 'a');
  const old = f.runtime.send(f.a.id, input('old')); await entered;
  const next = await f.runtime.send(f.a.id, input('new', { newTask: true }));
  release(); await old;
  assert.equal(f.runtime.view(f.a.id).currentTaskId, next.taskId);
  assert.equal((await f.runtime.send(f.a.id, input('continue'))).sessionId, next.sessionId);
});

test('stale browser focus and stale cursor version cannot reserve work', async t => {
  const f = fixture(t); const owner = f.runtime.adopt(f.a.id, 'a');
  const first = await f.runtime.send(f.a.id, input('first'));
  const version = f.runtime.view(f.a.id).cursorVersion;
  f.runtime.settleAttribution('a', first.receiptId, { taskId: 'tsk_next' });
  const count = f.store.list('receipt').length;
  await assert.rejects(f.runtime.send(f.a.id, input('stale', { taskId: owner.id })), { code: 'stale_shell_cursor' });
  await assert.rejects(f.runtime.send(f.a.id, input('old-version', { expectedCursorVersion: version })), { code: 'stale_shell_cursor' });
  assert.equal(f.store.list('receipt').length, count);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, 'tsk_next');
});

test('board reads do not move the cursor; all execution controls reject conversation tasks', async t => {
  const f = fixture(t); const task = f.runtime.adopt(f.a.id, 'a');
  f.histories.set('a', [{ id: 'u', taskId: task.id, role: 'user', content: 'original' }]);
  const cursor = f.runtime.view(f.a.id).currentTaskId;
  const app = express(); app.use(express.json()); mountTaskShellRoutes(app, { getRuntime: () => f.runtime });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/task-shell-tasks/${task.id}`;
  const entry = await (await fetch(base)).json();
  assert.equal(entry.readOnly, true); assert.equal(entry.messages.length, 1);
  for (const intent of ['work', 'answer', 'steer', 'cancel']) {
    const response = await fetch(`${base}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(intent, { intent })) });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'task_board_read_only');
  }
  assert.equal(f.runtime.view(f.a.id).currentTaskId, cursor); assert.equal(f.sends.length, 0);
});

test('manual fork is durable, idempotent, independent and preserves the original task', async t => {
  let captures = 0;
  const f = fixture(t, { captureForkBaseline: async () => { captures++; return { commit: 'a'.repeat(40) }; } });
  const task = f.runtime.adopt(f.a.id, 'a');
  f.histories.set('a', [{ id: 'u', taskId: task.id, role: 'user', content: 'do it' }, { id: 'a', taskId: task.id, role: 'assistant', content: 'saved', partial: true }]);
  const [a, b] = await Promise.all([f.runtime.forkTask(task.id, input('fork')), f.runtime.forkTask(task.id, input('fork'))]);
  assert.deepEqual(a, b); assert.equal(captures, 1); assert.equal(f.creations.length, 1); assert.equal(f.sends.length, 0);
  assert.notEqual(a.taskId, task.id); assert.notEqual(a.shellId, f.a.id);
  assert.equal(f.runtime.taskAccess(task.id).readOnly, true); assert.equal(f.runtime.taskAccess(a.taskId).readOnly, false);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, task.id);
  assert.throws(() => f.runtime.resolveTask(a.shellId, { taskId: 'tsk_wrong' }), { code: 'standalone_task_identity_locked' });
  const forked = f.store.get('task', a.taskId), snapshot = f.store.get('snapshot', forked.snapshotIds[0]);
  assert.equal(forked.forkedFromTaskId, task.id); assert.equal(verifySnapshot(snapshot, snapshot.hash), true);
  assert.equal(snapshot.messages.at(-1).partial, true);
  const restarted = createTaskShellRuntime(f.ports);
  assert.deepEqual(await restarted.forkTask(task.id, input('fork')), a);
  const sent = await restarted.sendExplicit(a.shellId, input('continue'), { taskId: a.taskId });
  assert.equal(sent.taskId, a.taskId); assert.equal(f.sends.at(-1).opts.taskShellAutoClassify, false);
  assert.throws(() => restarted.assertBoardWritable(task.id), { code: 'task_board_read_only' });
  assert.equal(restarted.remove(f.a.id).archived, true);
  assert.equal(restarted.taskAccess(task.id).ownerShellId, f.a.id);
});

test('fork creation failure retains the same task and snapshot on retry', async t => {
  let fail = true;
  const f = fixture(t, { captureForkBaseline: async () => ({ commit: 'b'.repeat(40) }), createExecution: async () => {
    if (fail) throw new Error('disk full'); return { ok: true, baseline: { commit: 'b'.repeat(40) } };
  } });
  const source = f.runtime.adopt(f.a.id, 'a');
  await assert.rejects(f.runtime.forkTask(source.id, input('key')), /disk full/);
  const pending = f.store.list('fork')[0]; assert.equal(pending.status, 'failed');
  fail = false;
  const result = await createTaskShellRuntime(f.ports).forkTask(source.id, input('key'));
  assert.equal(result.taskId, pending.taskId); assert.equal(f.store.list('task').length, 2);
});

test('real worktree baseline refuses dirty files and shared siblings block writes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shell-workspace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); fs.writeFileSync(path.join(dir, 'file'), 'original'); git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-m', 'initial');
  const root = { id: 'root', dirId: 'd', worktreePath: dir, branch: 'main' };
  const records = new Map([['root', root], ['member', { ...root, id: 'member', workspaceOwnerSessionId: 'root' }]]);
  const states = new Map();
  const host = createShellWorkspaceHost({ records, getChatState: id => states.get(id), getWorkHost: () => ({ isRunActive: () => false }) });
  assert.deepEqual(sharedWorkspace(records, 'root', 'd'), { worktreePath: dir, branch: 'main' });
  const baseline = await host.captureForkBaseline({ sessionId: 'root' }, { sourceSessionId: 'root' });
  assert.equal(baseline.commit, git('rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(dir, 'untracked'), 'keep');
  await assert.rejects(host.captureForkBaseline({ sessionId: 'root' }, { sourceSessionId: 'root' }), { code: 'fork_source_dirty' });
  states.set('member', { isStreaming: true }); assert.equal(host.busy('root'), true);
  await assert.rejects(host.captureForkBaseline({ sessionId: 'root' }, { sourceSessionId: 'root' }), { code: 'fork_source_busy' });
});
