'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
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
test('suggestion is durable, deduplicated and makes no task, identity, cursor or execution changes', async t => {
  const f = await setup(t), before = JSON.stringify(f.store.list('task')), shell = f.runtime.view(f.a.id);
  const p = f.propose(); assert.equal(p.state, 'pending');
  assert.deepEqual(f.propose(), p);
  assert.equal(JSON.stringify(f.store.list('task')), before);
  assert.deepEqual(f.runtime.view(f.a.id), shell); assert.equal(f.creations.length, 0);
  assert.deepEqual(createTaskShellRuntime(f.ports).separation.latest('a'), p);
});
test('first exchange, stale anchor and forged execution cannot propose separation', async t => {
  const f = await setup(t);
  f.histories.get('a').shift(); assert.equal(f.propose(), null);
  f.histories.get('a').unshift({ id: 'u0', role: 'user', content: 'Old goal' });
  assert.equal(f.runtime.separation.propose('a', f.sent.receiptId, { ...f.input, anchorMessageId: 'missing' }), null);
  assert.throws(() => f.runtime.separation.propose('b', f.sent.receiptId, f.input), { code: 'separation_not_found' });
});
test('keep is durable and idempotent; another client cannot later separate the same suggestion', async t => {
  const f = await setup(t), p = f.propose();
  assert.deepEqual(await f.runtime.separation.decide('a', p.id, 'keep'), { ok: true, decision: 'keep' });
  const restarted = createTaskShellRuntime(f.ports);
  assert.equal(restarted.separation.latest('a'), null);
  assert.equal((await restarted.separation.decide('a', p.id, 'keep')).ok, true);
  await assert.rejects(restarted.separation.decide('a', p.id, 'separate'), { code: 'separation_already_resolved' });
  assert.equal(f.store.list('task').length, 1);
});
test('defer keeps the suggestion pending across restarts and only dismissible once stale', async t => {
  const f = await setup(t), p = f.propose();
  assert.deepEqual(await f.runtime.separation.decide('a', p.id, 'defer'),
    { ok: true, decision: 'defer', id: p.id, deferred: true });
  // Deferral is a state, not a decision: no task, identity or cursor change.
  assert.equal(f.store.list('task').length, 1);
  const restarted = createTaskShellRuntime(f.ports).separation.latest('a');
  assert.equal(restarted.id, p.id);
  assert.equal(restarted.deferred, true);
  assert.equal(restarted.stale, false);
  // Once the conversation moves on the deferred entry stays findable, but the
  // accept path still revalidates and refuses the stale source.
  f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Next goal', turnId: 'turn-2', taskId: f.source.id });
  const stale = createTaskShellRuntime(f.ports).separation.latest('a');
  assert.equal(stale.deferred, true);
  assert.equal(stale.stale, true);
  await assert.rejects(createTaskShellRuntime(f.ports).separation.decide('a', p.id, 'separate'), { code: 'separation_stale' });
  assert.deepEqual(await createTaskShellRuntime(f.ports).separation.decide('a', p.id, 'keep'), { ok: true, decision: 'keep' });
  assert.equal(createTaskShellRuntime(f.ports).separation.latest('a'), null);
});
test('confirmed separation creates one independent task and imports only this exchange with provenance', async t => {
  const f = await setup(t), p = f.propose(), before = JSON.stringify(f.histories.get('a'));
  f.runtime.roles.update(f.source.id, { expectedVersion: 0, clientMsgId: 'roles-1',
    bindings: [{ name: 'reviewer', prompt: 'Preserve the task boundary.' }] });
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
test('a newer turn invalidates the old popup even before its receipt has changed', async t => {
  const f = await setup(t), p = f.propose();
  f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Next input' });
  assert.equal(f.runtime.separation.latest('a'), null);
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'separation_stale' });
  assert.equal(f.creations.length, 0);
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
test('busy and dirty sources retain the suggestion and expose the original error', async t => {
  const f = await setup(t), p = f.propose();
  f.ports.withSeparationBarrier = async (input, work) => {
    if (f.statuses.get('a')?.busy) throw Object.assign(new Error('busy'), { code: 'fork_source_busy' });
    return work({ barrier: { id: `barrier-${input.separationId}` },
      code: { revision: 'revision-1', head: 'a'.repeat(40), repoId: 'repo-1', dirty: true } });
  };
  f.statuses.set('a', { busy: true });
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'fork_source_busy' });
  f.statuses.set('a', { busy: false });
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'fork_source_dirty' });
  assert.equal(f.runtime.separation.latest('a').id, p.id); assert.equal(f.store.list('task').length, 1);
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
test('an anchor changed during code capture prevents task creation', async t => {
  const f = await setup(t);
  f.ports.withSeparationBarrier = async (input, work) => {
    f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Race' });
    return work({ barrier: { id: `barrier-${input.separationId}` },
      code: { revision: 'revision-1', head: 'a'.repeat(40), repoId: 'repo-1', dirty: false } });
  };
  const p = f.propose();
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'separation_stale' });
  assert.equal(f.store.list('task').length, 1);
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
  const appended = [], moves = [];
  f.ports.appendHistory = (id, message) => {
    appended.push({ id, message });
    f.histories.set(id, [...(f.histories.get(id) || []), message]);
    return true;
  };
  f.ports.movePendingUserInput = async (sourceId, targetId, opts) => {
    moves.push({ sourceId, targetId, opts });
    return { ok: true, requestId: 'usrq-1' };
  };
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
  assert.equal(JSON.stringify(f.histories.get('a')), before, 'source transcript is canonical and untouched');
  // The judged turn's open wait_user question moves to the new task.
  assert.deepEqual(moves, [{ sourceId: 'a', targetId: task.sessionId, opts: { turnId: 'turn-1', taskId: task.id } }]);
  assert.equal(result.movedUserInput, 'usrq-1');
  // A repeated decide returns the stored result without re-seeding or re-moving.
  const replay = await f.runtime.separation.decide('a', p.id, 'separate');
  assert.deepEqual(replay, result);
  assert.equal(appended.length, 2);
  assert.equal(moves.length, 1);
});
test('separation succeeds without the handoff ports and reports zero seeded messages', async t => {
  const f = await setup(t), p = f.propose();
  const result = await f.runtime.separation.decide('a', p.id, 'separate');
  assert.equal(result.ok, true);
  assert.equal(result.seededMessages, 0);
  assert.equal(result.movedUserInput, null);
});
