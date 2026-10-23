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

test('explicit imports inject once and history reads do not create extra links or imports', async t => {
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
  f.histories.set('other', [{ id: 'foreign-a', role: 'assistant', taskId: 'foreign', content: 'other project evidence' }]);
  const foreign = f.runtime.refillContext(child.sessionId, { task_id: 'foreign' });
  assert.equal(foreign.page.messages[0].content, 'other project evidence');
  assert.equal(f.store.get('link', `${f.a.id}:foreign`), null);
  assert.deepEqual(f.store.get('task', child.taskId).snapshotIds, task.snapshotIds);
});

test('explicit reads reach unrelated projects and tasks while default context stays in the shell', async t => {
  const f = fixture(t), current = await delivery(f, 'current task');
  f.store.set('task', 'same-project', { id: 'same-project', dirId: 'd1', sessionId: 'b', title: 'Same project' });
  f.store.set('task', 'foreign', { id: 'foreign', dirId: 'd2', sessionId: 'other', title: 'Other project' });
  f.histories.set('b', [{ id: 'same-a', role: 'assistant', taskId: 'same-project', content: 'unrelated same project' }]);
  f.histories.set('other', [
    { id: 'foreign-a', role: 'assistant', taskId: 'foreign', content: 'unrelated other project' },
    { id: 'another-a', role: 'assistant', taskId: 'different-task', content: 'different task in the same transcript' },
  ]);
  const before = { shell: f.store.get('shell', f.a.id), links: f.store.list('link'), tasks: f.store.list('task') };
  const same = f.runtime.refillContext(current.sessionId, { task_id: 'same-project' });
  assert.deepEqual(same.page.messages.map(m => m.id), ['same-a']);
  const foreign = f.runtime.refillContext(current.sessionId, { task_id: 'foreign' });
  assert.deepEqual(foreign.page.messages.map(m => m.id), ['foreign-a']);
  assert.equal(foreign.page.messages[0].sourceSessionId, 'other');
  assert.equal(foreign.page.messages[0].contextMessageId, 'other:foreign-a');
  const defaults = f.runtime.refillContext(current.sessionId);
  assert.doesNotMatch(defaults.context, /unrelated (same|other) project/);
  const shellPage = f.runtime.refillContext(current.sessionId, { limit: 50 });
  assert.ok(!shellPage.page.messages.some(m => ['b', 'other'].includes(m.sourceSessionId)));
  assert.deepEqual(f.store.get('shell', f.a.id), before.shell);
  assert.deepEqual(f.store.list('link'), before.links);
  assert.deepEqual(f.store.list('task'), before.tasks);
});

test('explicit reads reject unknown and deleted tasks without borrowing another task history', async t => {
  const f = fixture(t, { isDeletedTask: id => id === 'deleted' }), current = await delivery(f, 'current task');
  f.store.set('task', 'deleted', { id: 'deleted', dirId: 'd2', sessionId: 'other' });
  f.histories.set('other', [{ id: 'old', role: 'assistant', taskId: 'deleted', content: 'deleted task history' }]);
  for (const task_id of ['unknown', 'deleted']) {
    assert.throws(() => f.runtime.refillContext(current.sessionId, { task_id }), { code: 'task_not_found', status: 404 });
  }
});

test('board task reads normalize bound legacy records and preserve pagination, status and source', async t => {
  const boardTask = { id: 'board-only', dirId: 'd2', chatSessionId: 'other', historySessionIds: ['legacy', 'missing'] };
  const f = fixture(t, {
    getTask: id => id === boardTask.id ? boardTask : null,
    getLiveState: id => ({ isStreaming: id === 'other' }),
  }), current = await delivery(f, 'current task');
  f.records.set('other', { ...f.records.get('other'), taskBoundTaskId: boardTask.id });
  f.records.set('legacy', { id: 'legacy', dirId: 'd2', taskBoundTaskId: boardTask.id });
  f.histories.set('legacy', [
    { id: 'old-a', role: 'assistant', content: 'legacy bound answer', ts: 1, cancelled: true },
    { id: 'unrelated-a', role: 'assistant', taskId: 'another-task', content: 'do not relabel explicit ownership', ts: 2 },
  ]);
  const long = 'long evidence '.repeat(2500) + '\ud800'; // preserve legacy malformed UTF-16 too
  f.histories.set('other', [
    { id: 'live-u', role: 'user', content: 'live request', ts: 3 },
    { id: 'live-a', role: 'assistant', content: long, ts: 4, partial: true, error: true },
  ]);
  const latest = f.runtime.refillContext(current.sessionId, { task_id: boardTask.id, limit: 1 }).page;
  assert.equal(latest.messages[0].id, 'live-a');
  assert.equal(latest.messages[0].taskId, boardTask.id);
  assert.equal(latest.messages[0].sourceSessionId, 'other');
  assert.equal(latest.messages[0].sourceMessageId, 'live-a');
  assert.equal(latest.messages[0].contextMessageId, 'other:live-a');
  assert.equal(latest.messages[0].partial, true);
  assert.equal(latest.messages[0].error, true);
  assert.equal(latest.messages[0].inProgress, true);
  assert.equal(latest.hasMore, true);
  const older = f.runtime.refillContext(current.sessionId, { task_id: boardTask.id, before: latest.before, limit: 5 }).page;
  assert.deepEqual(older.messages.map(m => m.id), ['old-a', 'live-u']);
  assert.equal(older.messages[0].cancelled, true);
  assert.equal(older.messages[1].inProgress, true);
  let offset = 0, restored = '';
  do {
    const chunk = f.runtime.refillContext(current.sessionId, { task_id: boardTask.id, message_id: 'other:live-a', offset }).page;
    assert.equal(chunk.found, true);
    assert.equal(chunk.message.partial, true);
    restored += chunk.message.evidenceExcerpt;
    offset = chunk.message.nextOffset;
  } while (offset !== null);
  assert.equal(JSON.parse(restored).content, long);
  assert.equal(f.runtime.refillContext(current.sessionId, {
    task_id: boardTask.id, message_id: 'legacy:unrelated-a',
  }).page.found, false);
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

test('separation injects only the imported exchange but explicit reads reach the source archive', async t => {
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
  assert.deepEqual(expanded.page.messages.map(m => m.id), ['u-old', 'a-old', 'u-new', 'a-new']);
  assert.equal(expanded.page.messages[3].partial, true);
  const original = f.runtime.refillContext(child.sessionId, { task_id: source.taskId, message_id: `${source.sessionId}:a-old` });
  assert.equal(original.page.found, true);
  assert.equal(JSON.parse(original.page.message.evidenceExcerpt).content, 'PRIVATE old answer');
  assert.equal(f.store.get('link', `${f.a.id}:${source.taskId}`), null);
  assert.deepEqual(f.store.get('task', child.taskId).snapshotIds, [snapshot.hash]);
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

test('ascii terms match whole words and long queries need proportional overlap', () => {
  const { relevance, minRelevance } = require('../src/context/selection');
  assert.equal(relevance('ok', 'token hook'), 0);
  assert.equal(relevance('ok', 'it is ok now'), 1);
  assert.equal(relevance('db-tune', 'run db-tune.'), 1);
  assert.equal(minRelevance('ok'), 1);
  assert.ok(minRelevance('另外我每次会话不是会经常自动裁剪上下文吗这个难道没有正向作用吗') >= 4);
});

test('continuations send only facts the turn points at, not the rest of a MEMORY.md index', async t => {
  const f = fixture(t), memory = memoryFor(f), first = await delivery(f, 'index');
  f.records.get(first.sessionId).cli = 'codex';
  prepare(f, first, memory, { isFirstTurn: true }); commit(f, first);
  fs.appendFileSync(path.join(memory.sharedDir('d1'), 'MEMORY.md'), '\n§\n园艺经验：番茄要搭架。\n§\n数据库性能 cache 命中率目标 95%。\n');
  const next = await delivery(f, 'next');
  const plan = prepare(f, next, memory);
  assert.match(plan.text, /命中率目标/);
  assert.doesNotMatch(plan.text, /番茄/);
});

test('vault rule is injected only for lanes without the host system prompt', async t => {
  const { SYSTEM_PROMPT_SECRET_RULE_CLIS } = require('../src/memory/retrieval');
  const f = fixture(t), memory = memoryFor(f), d = await delivery(f, 'vault');
  const record = { ...f.records.get(d.sessionId), taskBoundTaskId: d.taskId };
  const ids = cli => memory.retrieve({ ...record, cli }, 'x').candidates.map(s => s.id);
  assert.ok(!ids('claude').includes('builtin:secret-vault'));
  assert.ok(!ids('claude').includes('builtin:shared-files'));
  assert.ok(ids('opencode').includes('builtin:secret-vault'));
  assert.ok(ids('opencode').includes('builtin:shared-files'));
  assert.ok(ids('claude').includes('builtin:docs-registry'));
  for (const cli of SYSTEM_PROMPT_SECRET_RULE_CLIS) {
    const source = fs.readFileSync(path.join(__dirname, '../src/cli-adapters', `${cli}.js`), 'utf8');
    assert.match(source, /systemPrompt|multiccImgHint/, `${cli} must actually carry the host system prompt`);
  }
});

test('seeded rule paragraphs (current and legacy wording) never resurface as ordinary memory', async t => {
  const { SECRET_VAULT_RULE, SHARED_FILES_RULE } = require('../src/memory/builtin-rules');
  const f = fixture(t), memory = memoryFor(f), d = await delivery(f, 'rules');
  const record = { ...f.records.get(d.sessionId), cli: 'claude', taskBoundTaskId: d.taskId };
  const file = path.join(memory.sharedDir('d1'), 'MEMORY.md');
  fs.appendFileSync(file, '\n§\n[规则][敏感信息保险箱·强制]\n\n旧版续段：先调用 list_secrets 检查。\n§\n普通事实：发布前跑 smoke。\n');
  memory.retrieve(record, 'x');
  const excerpts = memory.retrieve(record, 'list_secrets smoke').candidates
    .filter(s => s.scope !== 'builtin').map(s => s.excerpt).join('\n');
  for (const rule of [SECRET_VAULT_RULE, SHARED_FILES_RULE]) {
    for (const paragraph of rule.split(/\n\s*\n/).slice(1)) assert.ok(!excerpts.includes(paragraph.trim()), paragraph.slice(0, 40));
  }
  assert.doesNotMatch(excerpts, /旧版续段/);
  assert.match(excerpts, /普通事实/);
});

test('machine facts join only on a match and vague query hits are capped', async t => {
  const f = fixture(t), memory = memoryFor(f), d = await delivery(f, 'machine');
  const record = { ...f.records.get(d.sessionId), cli: 'claude', taskBoundTaskId: d.taskId };
  fs.mkdirSync(memory.machineDir(), { recursive: true });
  fs.writeFileSync(path.join(memory.machineDir(), 'MEMORY.md'), '本机 codex 平台包缺失');
  assert.ok(!memory.retrieve(record, '部署').candidates.some(s => s.scope === 'machine'));
  assert.ok(memory.retrieve(record, 'codex 平台包').candidates.some(s => s.scope === 'machine'));
  const shared = memory.sharedDir('d1');
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(shared, `note${i}.md`), `继续 第 ${i} 条笔记`);
  const hits = memory.retrieve(record, '继续').candidates.filter(s => s.reason === 'query');
  assert.equal(hits.length, 8);
});

test('task title steers only the cold start, not every continuation', async t => {
  const f = fixture(t), memory = memoryFor(f), first = await delivery(f, 'title');
  f.records.get(first.sessionId).cli = 'codex';
  const queries = [];
  const spy = { ...memory, retrieve: (record, query) => { queries.push(query); return memory.retrieve(record, query); } };
  prepare(f, first, spy, { isFirstTurn: true }); commit(f, first);
  const next = await delivery(f, 'next');
  prepare(f, next, spy);
  const title = f.store.get('task', first.taskId)?.title || '';
  assert.ok(queries[0].endsWith('\n' + title), 'cold start includes the title');
  assert.equal(queries[1], '数据库性能 cache', 'continuation queries only the turn text');
});
