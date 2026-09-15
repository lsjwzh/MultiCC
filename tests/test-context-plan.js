'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./helpers/task-shell');
const { createFolderMemoryService } = require('../src/memory/folder-service');
const { readMemoryFolder } = require('../src/memory-store');
const { estimateTokens } = require('../src/task-shell/context');
const { selectContext } = require('../src/context/selection');
const { prepareManagedContext, contextSent, contextCompleted } = require('../src/chat/managed-context');

function memoryFor(f) {
  return createFolderMemoryService({ fs, path, memoryStoreRoot: path.join(path.dirname(f.file), 'memory'),
    directories: new Map([['d1', {}]]), readMemoryFolder, getMemoryEntries: () => [] });
}
async function delivery(f, key, extra = {}) {
  f.statuses.clear();
  return f.runtime.send(f.a.id, { clientMsgId: key.replaceAll(' ', '-'), text: key, ...extra });
}
function prepare(f, d, memory, extra = {}) {
  return f.runtime.prepareContext(d.sessionId, { receiptId: d.receiptId, turnId: d.receiptId,
    text: '数据库性能 cache', memory, ...extra });
}
function commit(f, d, success = true) {
  f.runtime.contextSent(d.sessionId, d.receiptId, d.receiptId);
  f.runtime.contextComplete(d.sessionId, d.receiptId, d.receiptId, success);
}

test('ordinary first turn, continuation, queued memory update, failed send, CLI reset and task switch', async t => {
  const f = fixture(t, { taskGraphContext: () => ({ text: '', sources: [
    { id: 'graph:parent:p', mode: 'graph:parent', taskId: 'p', taskName: 'parent', kind: 'parent', excerpt: '数据库父任务结论' },
  ] }) });
  const memory = memoryFor(f), first = await delivery(f, 'start');
  f.records.get(first.sessionId).cli = 'codex';
  const file = path.join(memory.sharedDir('d1'), 'cache.md');
  fs.writeFileSync(file, '数据库性能 cache 上限为 100。');
  const plan = prepare(f, first, memory, { isFirstTurn: true });
  assert.equal(f.sends.at(-1).opts.taskContextSeed, '', 'queue admission does not inject');
  assert.match(plan.text, /100/); assert.match(plan.text, /数据库父任务结论/);
  assert.ok(plan.budget.used <= plan.budget.limit);
  assert.deepEqual(f.runtime.contextTrace(first.sessionId, first.receiptId).sources, [], 'prepared is not sent');
  commit(f, first);
  const summary = f.runtime.contextTrace(first.sessionId, first.receiptId);
  assert.ok(summary.sources.some(s => s.mode === 'memory:shared'));
  assert.ok(summary.sources.every(s => !s.excerpt && !s.dedupeText));
  const details = f.runtime.contextTrace(first.sessionId, first.receiptId, { includeMessages: true });
  assert.ok(details.sources.every(s => plan.text.includes(s.excerpt)));
  const second = await delivery(f, 'continue');
  const continuation = prepare(f, second, memory);
  assert.equal(continuation.text, '', 'unchanged context is not resent');
  assert.ok(continuation.retained.length > 0); commit(f, second);
  const queued = await delivery(f, 'queued');
  fs.writeFileSync(file, '数据库性能 cache 上限为 200。');
  const update = prepare(f, queued, memory);
  assert.match(update.text, /200/); assert.match(update.text, /替换旧版本/);
  commit(f, queued, false);
  const retry = await delivery(f, 'retry');
  assert.match(prepare(f, retry, memory).text, /200/, 'failure must not consume version'); commit(f, retry);
  fs.unlinkSync(file);
  const removed = await delivery(f, 'remove');
  assert.match(prepare(f, removed, memory).text, /已删除/); commit(f, removed);
  f.records.get(first.sessionId).cli = 'claude';
  const switched = await delivery(f, 'switch');
  assert.equal(prepare(f, switched, memory).initial, true);
  assert.match(prepare(f, switched, memory).text, /数据库父任务结论/); commit(f, switched);
  const next = await delivery(f, 'different task', { newTask: true });
  assert.equal(prepare(f, next, memory).initial, true);
});

test('memory query finds later documents, linked neighbors and skill facts without crossing private/symlink scopes', async t => {
  const f = fixture(t), memory = memoryFor(f), d = await delivery(f, 'query');
  const record = { ...f.records.get(d.sessionId), cli: 'codex', taskBoundTaskId: d.taskId };
  const shared = memory.sharedDir('d1');
  fs.writeFileSync(path.join(shared, 'cache.md'), '数据库索引见 [[latency]]。');
  fs.writeFileSync(path.join(shared, 'latency.md'), 'p99 = 40ms');
  fs.writeFileSync(path.join(shared, 'unrelated.md'), '园艺经验');
  const secret = memory.sessionDir({ dirId: 'd1', id: 'sibling' }); fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(secret, 'MEMORY.md'), '数据库 SECRET');
  fs.symlinkSync(path.join(secret, 'MEMORY.md'), path.join(shared, 'leak.md'));
  const skill = memory.skillDir('d1', 'db-tune'); fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'MEMORY.md'), 'db-tune 执行经验');
  const got = memory.retrieve(record, '数据库 db-tune');
  assert.ok(got.candidates.some(s => s.reason === 'wikilink' && s.excerpt === 'p99 = 40ms'));
  assert.ok(got.candidates.some(s => s.scope === 'skill'));
  assert.ok(!JSON.stringify(got).includes('SECRET'));
  assert.ok(!got.candidates.some(s => s.excerpt.includes('园艺')));
  assert.equal(memory.resolveRolePrompt({ ...record, rolePrompt: 'role' }, { managed: true }), 'role');
});

test('strict budget includes metadata, clips text honestly, never slices atomic snapshot JSON, and deduplicates facts', () => {
  for (const limit of [0, 1, 10, 80, 300]) {
    const plan = selectContext([
      { id: 's', excerpt: JSON.stringify({ content: '大'.repeat(1000) }), atomic: true, priority: 100 },
      { id: 'a', excerpt: '资料'.repeat(300), label: 'a', priority: 50 },
      { id: 'b', excerpt: '资料'.repeat(300), label: 'b', priority: 10 },
    ], { budget: limit, header: '头\n', footer: '尾\n' });
    assert.ok(estimateTokens(plan.text) <= limit);
    assert.ok(plan.sources.every(s => plan.text.includes(s.excerpt)));
    assert.ok(!plan.sources.some(s => s.id === 's'));
    assert.ok(plan.sources.length <= 1);
    if (plan.sources.length) assert.equal(plan.sources[0].truncated, true);
  }
});

test('explicit imports inject once, remain available for authorized expansion, and cannot expose unrelated project', async t => {
  const f = fixture(t), a = await delivery(f, 'parent');
  f.histories.set(a.sessionId, [{ id: 'u', role: 'user', taskId: a.taskId, content: 'requirement' },
    { id: 'a', role: 'assistant', taskId: a.taskId, content: 'verified imported history' }]);
  const child = await delivery(f, 'child', { newTask: true, contextTaskIds: [a.taskId] });
  const task = f.store.get('task', child.taskId);
  f.store.remove('link', `${f.a.id}:${a.taskId}`); // source is outside the child's shell
  const plan = prepare(f, child, null, { isFirstTurn: true });
  assert.match(plan.text, /verified imported history/); commit(f, child);
  const next = await delivery(f, 'child continuation');
  assert.doesNotMatch(prepare(f, next).text, /verified imported history/);
  const page = f.runtime.refillContext(child.sessionId, { receiptId: next.receiptId, task_id: a.taskId });
  assert.equal(page.page.messages.length, 2);
  assert.equal(f.store.get('link', `${f.a.id}:${a.taskId}`), null);
  f.store.set('task', 'foreign', { id: 'foreign', dirId: 'd2', sessionId: 'other' });
  assert.throws(() => f.runtime.refillContext(child.sessionId, { task_id: 'foreign' }), { code: 'project_mismatch' });
  assert.deepEqual(f.store.get('task', child.taskId).snapshotIds, task.snapshotIds);
});

test('managed execution helper prepares at actual turn, commits only successful finalization and refreshes a cold retry', async t => {
  const f = fixture(t), d = await delivery(f, 'first'), memory = memoryFor(f);
  const host = { prepareTaskContext: f.runtime.prepareContext, taskContextSent: f.runtime.contextSent, taskContextComplete: f.runtime.contextComplete };
  const turn = { turnId: 'real-turn' };
  const managed = prepareManagedContext({ host, memory, sessionName: d.sessionId, persisted: f.records.get(d.sessionId), turn,
    opts: { taskShellReceiptId: d.receiptId }, text: 'first', isFirstTurn: true });
  assert.ok(managed.seed); contextSent(turn);
  contextCompleted({ turn, terminalBlocked: true }, { effects: [{ type: 'classify-turn-end', classification: 'succeeded' }] });
  assert.equal(f.store.get('task', d.taskId).contextLedger, undefined);
  contextCompleted({ turn }, { effects: [{ type: 'classify-turn-end', classification: 'succeeded' }] });
  assert.ok(f.store.get('task', d.taskId).contextLedger);
  const next = await delivery(f, 'next');
  const warm = prepareManagedContext({ host, memory, sessionName: d.sessionId, persisted: f.records.get(d.sessionId), turn: { turnId: 'next' },
    opts: { taskShellReceiptId: next.receiptId }, text: 'next', isFirstTurn: false });
  assert.equal(warm.seed, '');
  const retry = warm.attempt({ contextLayers: [], userText: 'next', suffix: '' }, { firstTurn: true, bareText: 'next' });
  assert.match(retry.bareText, /本轮托管上下文/);
});

test('separation expands only the imported exchange, with no full archive grant or extra links', async t => {
  const { handoffSnapshot } = require('../src/task-shell/history-context');
  const f = fixture(t), source = await delivery(f, 'source');
  f.histories.set(source.sessionId, [
    { id: 'u-old', role: 'user', taskId: source.taskId, turnId: 'old', content: 'PRIVATE old task requirement' },
    { id: 'a-old', role: 'assistant', taskId: source.taskId, turnId: 'old', content: 'PRIVATE old answer' },
    { id: 'u-new', role: 'user', taskId: source.taskId, turnId: 'new', content: 'new independent requirement' },
    { id: 'a-new', role: 'assistant', taskId: source.taskId, turnId: 'new', content: 'new partial evidence', partial: true },
  ]);
  const child = await delivery(f, 'separated', { newTask: true });
  const snapshot = handoffSnapshot(child.taskId, f.histories.get(source.sessionId), {
    turnId: 'new', anchorMessageId: 'a-new', sessionId: source.sessionId, receipt: { payload: { text: 'new independent requirement' } },
  });
  f.store.set('snapshot', snapshot.hash, snapshot);
  f.store.set('task', child.taskId, { ...f.store.get('task', child.taskId), separatedFromTaskId: source.taskId, snapshotIds: [snapshot.hash] });
  f.store.remove('link', `${f.a.id}:${source.taskId}`);
  const context = prepare(f, child, null, { isFirstTurn: true });
  assert.match(context.text, /new partial evidence/); assert.doesNotMatch(context.text, /PRIVATE/); commit(f, child);
  const expanded = f.runtime.refillContext(child.sessionId, { receiptId: child.receiptId, task_id: source.taskId });
  assert.deepEqual(expanded.page.messages.map(m => m.id), ['u-new', 'a-new']);
  assert.equal(expanded.page.messages[1].partial, true);
  const denied = f.runtime.refillContext(child.sessionId, { task_id: source.taskId, message_id: `${source.sessionId}:a-old` });
  assert.equal(denied.page.found, false);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, child.taskId);
});

test('oversized imported history remains parseable, verifiable and expandable with honest truncation', () => {
  const { historySnapshot } = require('../src/task-shell/history-context');
  const { boundedSnapshot } = require('../src/task-shell/context-snapshot');
  const { verifySnapshot } = require('../src/task-shell/context');
  const original = historySnapshot('task', [
    { id: 'u', role: 'user', content: '需求'.repeat(9000), contextMessageId: 's:u' },
    { id: 'a', role: 'assistant', content: '证据'.repeat(9000), partial: true, contextMessageId: 's:a' },
  ]);
  const bounded = boundedSnapshot(original);
  assert.equal(bounded.truncated, true);
  assert.ok(estimateTokens(bounded.text) <= 2000);
  const snapshot = JSON.parse(bounded.text.split('\n')[1])[0];
  assert.equal(verifySnapshot(snapshot, snapshot.hash), true);
  assert.equal(snapshot.messages[1].partial, true);
  assert.equal(snapshot.messages[1].contextMessageId, 's:a');
  assert.equal(snapshot.messages[1].truncated, true);
});

test('CLI handoff is bounded, traced and preserves the same cold-retry seed across multiple retries', async t => {
  const f = fixture(t), first = await delivery(f, 'before');
  const memory = memoryFor(f); prepare(f, first, memory); commit(f, first);
  const record = f.records.get(first.sessionId);
  record.pendingCliHandoff = { id: 'handoff-test', checkpoint: { fromCli: 'codex', toCli: 'claude', task: { goal: 'goal' }, transcript: [
    { role: 'assistant', text: '交接资料'.repeat(4000) },
  ] } };
  const next = await delivery(f, 'after');
  const host = { prepareTaskContext: f.runtime.prepareContext, taskContextSent: f.runtime.contextSent, taskContextComplete: f.runtime.contextComplete };
  const managed = prepareManagedContext({ host, memory, sessionName: next.sessionId, persisted: record, turn: { turnId: 'retry' },
    opts: { taskShellReceiptId: next.receiptId }, text: 'after', isFirstTurn: false });
  const plan = f.store.get('receipt', next.receiptId).contextPlan;
  const handoff = plan.sources.find(s => s.reason === 'cli_switch');
  assert.equal(handoff.truncated, true); assert.ok(plan.budget.used <= 8000);
  const env = { contextLayers: [], userText: 'after', suffix: '' };
  const retry1 = managed.attempt(env, { firstTurn: true, bareText: 'after' });
  const retry2 = managed.attempt(env, { firstTurn: true, bareText: 'after' });
  assert.equal(retry1.bareText, retry2.bareText);
  assert.match(retry2.bareText, /本轮托管上下文/);
});

test('retained source detail reads the originally injected version, not the mutable file', async t => {
  const f = fixture(t), memory = memoryFor(f), first = await delivery(f, 'trace');
  const file = path.join(memory.sharedDir('d1'), 'cache.md'); fs.writeFileSync(file, '数据库 cache 原始资料');
  prepare(f, first, memory); commit(f, first);
  const next = await delivery(f, 'trace-next'); prepare(f, next, memory); commit(f, next);
  fs.writeFileSync(file, '数据库 cache 后来修改');
  const trace = f.runtime.contextTrace(next.sessionId, next.receiptId, { includeMessages: true });
  const source = trace.sources.find(s => s.path?.endsWith('cache.md'));
  assert.equal(source.retained, true);
  assert.equal(source.excerpt, '数据库 cache 原始资料');
});

test('duplicate facts in two memory scopes are not reintroduced on a later turn', async t => {
  const f = fixture(t), memory = memoryFor(f), first = await delivery(f, 'dedupe');
  const record = f.records.get(first.sessionId); memory.ensureDirs(record);
  const fact = '数据库 cache 相同事实';
  fs.writeFileSync(path.join(memory.sharedDir('d1'), 'cache.md'), fact);
  fs.writeFileSync(path.join(memory.sessionDir(record), 'cache.md'), fact);
  const initial = prepare(f, first, memory);
  assert.equal(initial.sources.filter(s => s.excerpt === fact).length, 1); commit(f, first);
  const next = await delivery(f, 'dedupe-next');
  const plan = prepare(f, next, memory);
  assert.doesNotMatch(plan.text, /相同事实/);
  assert.ok(plan.omitted.some(s => s.reason === 'duplicate_in_native'));
});
