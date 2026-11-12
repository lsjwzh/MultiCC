'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createOutbox } = require('../src/outbox');
const { createOperationService } = require('../src/operation-service');
const { createWaitService } = require('../src/wait/service');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-receipts-'));
  const file = path.join(dir, 'orchestration.sqlite');
  const clock = { value: 1_800_000_000_000 };
  const store = createOrchestrationSqliteStore({ file, now: () => clock.value, ...options });
  t.after(async () => {
    await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, clock, file, dir };
}

test('终态只留小回执，完整正文、扩展字段和 UTF-16 仍可按需读取', async t => {
  const { store, file, dir } = fixture(t);
  const text = '结果😀'.repeat(40_000) + '\ud83d';
  const record = { id: 'finished', status: 'completed', updatedAt: 10, completedAt: 10,
    lastOutput: text, extension: { '\ude00': [text, null] }, result: { text, source: 'worker' } };
  await store.mutate(draft => { draft.tasks.finished = record; });
  const db = new Database(file);
  t.after(() => db.close());
  const hot = db.prepare('SELECT data_json FROM orchestration_tasks WHERE id=?').get('finished').data_json;
  const cold = db.prepare('SELECT data_json FROM orchestration_record_bodies WHERE collection=? AND record_key=?')
    .get('tasks', 'finished').data_json;
  assert.ok(Buffer.byteLength(hot) < 2048, `回执过大：${Buffer.byteLength(hot)}`);
  assert.deepEqual(JSON.parse(cold), record);
  assert.deepEqual(await store.read(state => state.tasks.finished), record);
  assert.equal(await store.read(state => state.tasks.finished.extension['\ude00'][0]), text);
  assert.deepEqual(await store.select('tasks', { where: { 'result.source': 'worker' },
    fields: ['id', 'lastOutput', 'extension'] }), [{ id: 'finished', lastOutput: text, extension: record.extension }]);
  assert.equal(await store.count('tasks', { lastOutput: text }), 1);

  // 故意破坏隔离库正文，验证轻量状态读不会尝试解析正文。
  db.prepare('UPDATE orchestration_record_bodies SET data_json=? WHERE collection=? AND record_key=?')
    .run('invalid-json', 'tasks', 'finished');
  assert.equal(await store.read(state => state.tasks.finished.status), 'completed');
  assert.deepEqual(await store.select('tasks', { where: { status: 'completed' }, fields: ['id', 'status'] }),
    [{ id: 'finished', status: 'completed' }]);
  db.prepare('UPDATE orchestration_record_bodies SET data_json=? WHERE collection=? AND record_key=?')
    .run(cold, 'tasks', 'finished');
  const exported = path.join(dir, 'rollback.json');
  await store.exportLegacy(exported);
  assert.deepEqual(JSON.parse(fs.readFileSync(exported, 'utf8')).tasks.finished, record);
});

test('回执与正文原子回滚，状态恢复和删除不残留正文', async t => {
  let fail = false;
  const { store, file } = fixture(t, { hooks: { beforeCommit() {
    if (fail) throw new Error('模拟事务提交失败');
  } } });
  const original = { id: 'atomic', status: 'running', lastOutput: '初始正文' };
  await store.mutate(draft => { draft.tasks.atomic = original; });
  fail = true;
  await assert.rejects(store.mutate(draft => {
    draft.tasks.atomic.status = 'completed';
    draft.tasks.atomic.lastOutput = '未提交正文';
  }), /模拟事务提交失败/);
  fail = false;
  const db = new Database(file);
  t.after(() => db.close());
  const bodies = () => db.prepare('SELECT count(*) AS n FROM orchestration_record_bodies').get().n;
  assert.deepEqual(await store.read(state => state.tasks.atomic), original);
  assert.equal(bodies(), 0);
  await store.mutate(draft => { draft.tasks.atomic.status = 'completed'; });
  assert.equal(bodies(), 1);
  await store.mutate(draft => { draft.tasks.atomic.status = 'running'; });
  assert.equal(bodies(), 0);
  assert.deepEqual(await store.read(state => state.tasks.atomic), original);
  await store.mutate(draft => { draft.tasks.atomic.status = 'completed'; });
  await store.mutate(draft => { delete draft.tasks.atomic; });
  assert.equal(bodies(), 0);
  assert.equal(await store.read(state => state.tasks.atomic), undefined);
});

test('容量超额后的投递去重、回调重试和派发结果查询保持兼容', async t => {
  const { store, clock, file } = fixture(t, { retention: { maxRecords: 1 } });
  const now = () => clock.value;
  const outbox = createOutbox({ store, now });
  const payload = { text: '需要保留的投递正文'.repeat(1000) };
  await outbox.enqueue({ id: 'sent', sessionId: 'owner', payload });
  const [leased] = await outbox.claim({ workerId: 'worker' });
  await outbox.ack('sent', leased.leaseToken);

  const waits = createWaitService({ store, now, callbackTokenFactory: () => 'test-only-token' });
  const wait = await waits.register({ sessionId: 'owner', mode: 'callback', injectPrefix: '回调' });
  assert.equal((await waits.resolveCallback(wait.id, wait.token, payload)).ok, true);
  const operations = createOperationService({ store, now });
  await operations.observeTask({ sessionId: 'owner', taskId: 'monitor', status: 'completed',
    detail: { lastOutput: '无需轮询的历史正文'.repeat(1000) } });
  const activity = await operations.taskActivity({ sessionId: 'owner', taskIds: '["monitor"]' });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].status, 'completed');
  assert.equal(activity[0].lastOutput, undefined);
  assert.deepEqual(await operations.taskActivity({ sessionId: 'other', taskIds: ['monitor'] }), []);
  await assert.rejects(operations.taskActivity({ sessionId: 'owner', taskIds: 'invalid' }),
    error => error.statusCode === 400);
  const admitted = await operations.admitDispatch({ ownerSessionId: 'owner', resultSessionId: 'owner',
    idempotencyKey: 'stable-request', spec: { chatId: 'worker', targetId: 'worker', message: '执行任务' } });
  const result = { status: 'completed', text: '完整派发结果'.repeat(1000), source: 'worker' };
  await operations.completeDispatch(admitted.id, result);
  await store.mutate(draft => { draft.tasks.finished = { id: 'finished', status: 'completed',
    completedAt: clock.value, updatedAt: clock.value, lastOutput: '结束' }; });
  clock.value += 60_001;
  const maintenance = await store.pruneRetained();
  assert.equal(maintenance.capacityTriggered, true);
  assert.equal(maintenance.deletedTasks + maintenance.deletedOutbox, 0);
  assert.equal((await outbox.enqueue({ id: 'sent', sessionId: 'owner', payload })).idempotent, true);
  assert.deepEqual((await outbox.get('sent')).payload, payload);
  assert.equal((await waits.resolveCallback(wait.id, wait.token, payload)).idempotent, true);
  assert.equal((await waits.resolveCallback(wait.id, wait.token, { text: '不同结果' })).code, 'payload_conflict');
  assert.equal((await operations.completeDispatch(admitted.id, result)).idempotent, true);
  assert.equal((await operations.get(admitted.id)).result.text, result.text);
  await store.close({ exportRollback: false });
  const reopened = createOrchestrationSqliteStore({ file, now });
  try {
    assert.equal((await createOutbox({ store: reopened, now }).enqueue({
      id: 'sent', sessionId: 'owner', payload,
    })).idempotent, true);
    assert.equal((await createWaitService({ store: reopened, now }).resolveCallback(
      wait.id, wait.token, payload,
    )).idempotent, true);
    assert.equal((await createOperationService({ store: reopened, now }).get(admitted.id)).result.text, result.text);
  } finally { await reopened.close({ exportRollback: false }); }
});
