'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createAirIndex } = require('../src/workspace/air-index-port');
const { createAirSyncRuntime } = require('../src/workspace/air-sync-runtime');
const { getNative } = require('../src/native/runtime');
const addon = getNative('read_model', process.env.MULTICC_REQUIRE_RUST_TESTS === '1' ? 'rust' : 'auto');
const native = addon?.taskReadModelProtocolVersion?.() === 1;
if (!native && process.env.MULTICC_REQUIRE_RUST_TESTS === '1') throw Error('air_read_protocol_unavailable');
const run = (name, fn) => test(name, { skip: !native }, fn);
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const task = (id, patch = {}) => ({ id, title: '任务', dirId: 'd', status: 'active', runState: 'idle', updatedAt: 10, lastMessageAt: 10, ...patch });
const snapshot = tasks => ({ directories: [{ id: 'd', name: '项目' }], taskPins: [], taskTodos: [], taskTodoIgnored: [], tasks });
class Socket extends EventEmitter {
  readyState = 1; frames = [];
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
}
const url = (cursor, day = 0) => new URL(`http://fixture?cursor=${cursor}&dayStart=${day}`);
const send = (socket, event) => socket.frames.push(event);
run('生产默认选择 Rust，完整快照由 Rust 序列化并计算稳定 ETag', async t => {
  const index = createAirIndex({ backend: 'rust' }); t.after(() => index.close());
  assert.equal(index.backend, 'rust');
  await index.apply(snapshot([task('task-历史')]));
  const first = await index.serialized();
  assert.equal(first.etag, `W/"${createHash('sha1').update(first.body).digest('base64url')}"`);
  assert.deepEqual(JSON.parse(first.body), await index.snapshot());
  await index.apply(snapshot([task('task-历史')]));
  assert.deepEqual(await index.serialized(), first);
  await index.apply(snapshot([task('task-历史', { runState: 'waiting' })]));
  assert.notEqual((await index.serialized()).etag, first.etag);
});
test('只允许显式 Node 回退，配置错误不会静默降级', () => {
  assert.equal(createAirIndex({ backend: 'node' }).backend, 'node');
  assert.throws(() => createAirIndex({ backend: 'auto' }), /invalid_air_read_backend/);
});
run('默认宿主使用 Rust；捕获重放后到订阅前的变更必定实时送达', async t => {
  let data = snapshot([task('tsk_a')]); const real = createAirIndex({ backend: 'rust' });
  const captured = gate(), release = gate();
  const index = { ...real, sync: async (...args) => { const result = await real.sync(...args); captured.resolve(); await release.promise; return result; } };
  const runtime = createAirSyncRuntime({ index, build: async () => data, send, logger: { warn() {} } }); t.after(() => runtime.close());
  await runtime.ensureReady();
  const socket = new Socket(), start = index.cursor(), attaching = runtime.attach(socket, url(start));
  await captured.promise;
  data = snapshot([task('tsk_a', { runState: 'succeeded' })]); runtime.invalidate(['tsk_a']); const publishing = runtime.flush();
  release.resolve(); await attaching; await publishing;
  assert.deepEqual(socket.frames.map(e => e.type), ['air_synced', 'air_delta']);
  assert.equal(socket.frames[1].previous, start); assert.equal(socket.frames[1].tasks[0].runState, 'succeeded');
  assert.equal(socket.frames[1].taskStats.all.today, 1);
});
run('发布已提交但尚未发送时重连，补齐与订阅仍按同一顺序交接', async t => {
  let data = snapshot([task('tsk_a')]), hold = false; const real = createAirIndex({ backend: 'rust' });
  const captured = gate(), release = gate();
  const index = { ...real, publish: async (...args) => { const result = await real.publish(...args); if (hold) { captured.resolve(); await release.promise; } return result; } };
  const runtime = createAirSyncRuntime({ index, build: async () => data, send }); t.after(() => runtime.close());
  await runtime.ensureReady(); const start = index.cursor(), live = new Socket(); await runtime.attach(live, url(start));
  hold = true; data = snapshot([task('tsk_a', { runState: 'succeeded' })]); runtime.invalidate(['tsk_a']); const publishing = runtime.flush();
  await captured.promise; const reconnect = new Socket(), attaching = runtime.attach(reconnect, url(start, 100));
  assert.equal(reconnect.frames.length, 0); release.resolve(); await publishing; await attaching;
  assert.equal(live.frames.at(-1).taskStats.all.today, 1);
  assert.deepEqual(reconnect.frames.map(e => e.type), ['air_delta', 'air_synced']);
  assert.equal(reconnect.frames[0].taskStats.all.today, undefined);
  assert.equal(reconnect.frames[0].cursor, live.frames.at(-1).cursor);
});
run('原生读取队列有界，生产者保留提交机会，单次失败不污染后续读取', async t => {
  let data = snapshot([task('tsk_a')]); const real = createAirIndex({ backend: 'rust' }), captured = gate(), release = gate();
  const index = { ...real, serialized: async () => { captured.resolve(); await release.promise; return real.serialized(); } };
  const runtime = createAirSyncRuntime({ index, maxPending: 1, build: async () => data, send }); t.after(() => runtime.close());
  await runtime.ensureReady(); const reading = runtime.serialized(); await captured.promise;
  await assert.rejects(runtime.query('page', {}), e => e.status === 503 && e.code === 'air_busy');
  data = snapshot([task('tsk_a', { title: '更新' })]); runtime.invalidate(['tsk_a']); const publishing = runtime.flush();
  release.resolve(); await reading; await publishing;
  await assert.rejects(runtime.query('page', { limit: {} }), /invalid_number/);
  assert.equal((await runtime.query('page', { status: 'all' })).tasks[0].title, '更新');
});
run('关闭等待正在进行的原生重放并关闭未订阅 socket，不再推送', async () => {
  const real = createAirIndex({ backend: 'rust' }), captured = gate(), release = gate();
  const index = { ...real, sync: async (...args) => { const result = await real.sync(...args); captured.resolve(); await release.promise; return result; } };
  const runtime = createAirSyncRuntime({ index, build: async () => snapshot([task('tsk_a')]), send });
  await runtime.ensureReady(); const socket = new Socket(), attaching = runtime.attach(socket, url(index.cursor()));
  await captured.promise; let drained = false; const closing = runtime.close().then(() => { drained = true; });
  assert.equal(socket.code, 1001); assert.equal(drained, false); release.resolve(); await attaching; await closing;
  assert.equal(socket.frames.length, 0); assert.equal(index.isReady(), false);
  await assert.rejects(runtime.query('page'), e => e.code === 'air_closed');
});
run('原生更新失败保留已发布快照与游标，恢复后完整重试', async t => {
  let data = snapshot([task('tsk_a')]); const runtime = createAirSyncRuntime({ build: async () => data, send, logger: { warn() {} } });
  t.after(() => runtime.close()); await runtime.ensureReady(); assert.equal(runtime.index.backend, 'rust');
  const before = runtime.index.cursor(), socket = new Socket(); await runtime.attach(socket, url(before)); socket.frames.length = 0;
  data = snapshot([task('tsk_a', { runState: {} })]); await runtime.flush();
  assert.equal(runtime.index.cursor(), before); assert.equal(socket.frames.length, 0);
  data = snapshot([task('tsk_a', { runState: 'error' })]); await runtime.flush();
  assert.equal(socket.frames.at(-1).tasks[0].runState, 'error'); assert.notEqual(runtime.index.cursor(), before);
});
