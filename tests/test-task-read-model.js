'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createTaskReadModel } = require('../src/native/task-read-model');
const { CompatDatabase: NodeDatabase } = require('../src/sqlite/node-driver');
const { getNative } = require('../src/native/runtime');
const { oracle, fixtures, initialize } = require('./helpers/task-read-model');
const addon = getNative('read_model', process.env.MULTICC_REQUIRE_RUST_TESTS === '1' ? 'rust' : 'auto');
const native = typeof addon?.RustTaskReadModel === 'function';
if (!native && process.env.MULTICC_REQUIRE_RUST_TESTS === '1') throw new Error('read_model_backend_unavailable');

async function setup(t, data = fixtures(), opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-read-model-'));
  const file = path.join(dir, 'tasks.sqlite');
  const db = new NodeDatabase(file);
  initialize(db, data.tasks, opts);
  const model = createTaskReadModel({ addon });
  t.after(async () => { await model.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await model.run({ op: 'open', file });
  const refresh = (options = {}) => model.run({ op: 'refresh', metadata: data.metadata, overlays: data.overlays, ...options });
  return { db, file, model, data, refresh };
}
const run = (name, fn) => test(name, { skip: !native }, fn);
const withoutRevision = ({ revision, ...value }) => value;

run('直接读取完整记录，摘要不暴露上下文，与现有 Air 索引逐字段一致', async t => {
  const { model, data, refresh } = await setup(t);
  assert.equal((await refresh()).rowsLoaded, data.tasks.length);
  const result = await model.run({ op: 'snapshot' });
  assert.deepEqual(result.tasks, oracle(data.tasks, data.metadata, data.overlays).snapshot().tasks);
  assert.ok(!JSON.stringify(result).includes('contextLedger'));
});
run('分页、全部状态、目录、置顶、访问排序与中文搜索对照', async t => {
  const { model, data, refresh } = await setup(t);
  await refresh(); const expected = oracle(data.tasks, data.metadata, data.overlays);
  let comparisons = 0;
  for (const status of ['all', 'open', 'recent', 'archived', 'today', 'needs', 'waiting', 'waitingReply', 'todo', 'achieved', 'interact', 'running', 'error', 'succeeded']) {
    for (const sort of ['', 'oldest', 'visit']) for (const dirId of ['', 'dir0', 'dir1']) {
      const options = { status, sort, dirId, dayStart: 5002, page: 2, limit: 7,
        visits: { tsk_00003: 9, tsk_00008: 1 } };
      assert.deepEqual(withoutRevision(await model.run({ op: 'page', options })), expected.page(options)); comparisons++;
    }
  }
  for (const query of ['中文', '😀', '工具', '不存在', 'ΟΣ', 'ος']) {
    const options = { status: 'all', query };
    assert.deepEqual(withoutRevision(await model.run({ op: 'page', options })), expected.page(options)); comparisons++;
  }
  assert.equal(comparisons, 132);
});
run('空集合、指定 ID 顺序、重复置顶和分页边界保持一致', async t => {
  const { model, data, refresh } = await setup(t);
  data.metadata.taskPins.push(data.metadata.taskPins[0]);
  await refresh(); const expected = oracle(data.tasks, data.metadata, data.overlays);
  for (const options of [{ ids: [] }, { ids: ['tsk_00004', 'tsk_00001', 'tsk_00004'] },
    { page: 999, limit: 2.9 }, { limit: -9 }, { page: -2, limit: 99 }, { dirId: 'missing' },
    { limit: '3', page: '2' }, { query: '中'.repeat(201) }]) {
    assert.deepEqual(withoutRevision(await model.run({ op: 'page', options })), expected.page(options));
  }
});
run('统计按现有状态别名、生命周期和待办忽略口径计算', async t => {
  const data = fixtures(40);
  const aliases = [' DONE ', 'completed', 'success', 'failed', 'paused', 'released', 'thinking', 'gone', '???'];
  data.tasks.forEach((task, i) => { data.overlays[task.id].runState = aliases[i % aliases.length]; });
  const { model, refresh } = await setup(t, data);
  await refresh(); const expected = oracle(data.tasks, data.metadata, data.overlays);
  for (const dayStart of [0, 5002, 99999]) {
    assert.deepEqual((await model.run({ op: 'stats', dayStart })).counts, expected.stats(dayStart));
  }
});
run('缓存命中不重复读取数据库，强制校验不制造新 revision', async t => {
  const { refresh } = await setup(t);
  const first = await refresh(), warm = await refresh(), forced = await refresh({ force: true });
  assert.deepEqual(warm, { revision: first.revision, reloaded: false, rowsLoaded: 0 });
  assert.equal(forced.changed, false); assert.equal(forced.revision, first.revision);
});
run('跨连接新增、更新、删除后刷新可见，分页缓存随快照失效', async t => {
  const { db, model, data, refresh } = await setup(t);
  await refresh(); const before = await model.run({ op: 'page', options: { status: 'all' } });
  const task = { ...data.tasks[2], title: '跨连接修改', refs: [{ ts: 999999 }] };
  db.prepare("UPDATE shell_records SET body=? WHERE kind='task' AND id=?").run(JSON.stringify(task), task.id);
  data.tasks[2] = task;
  const added = { ...task, id: 'tsk_new', title: '新增' };
  db.prepare("INSERT INTO shell_records VALUES ('task',?,?)").run(added.id, JSON.stringify(added)); data.tasks.push(added);
  db.prepare("DELETE FROM shell_records WHERE kind='task' AND id=?").run(data.tasks[0].id); data.tasks.shift();
  assert.equal((await refresh()).revision, before.revision + 1);
  assert.deepEqual(withoutRevision(await model.run({ op: 'page', options: { status: 'all' } })),
    oracle(data.tasks, data.metadata, data.overlays).page({ status: 'all' }));
});
run('元数据与实时覆盖输入变化会失效，不修改原始记录', async t => {
  const { db, model, data, refresh } = await setup(t);
  await refresh(); const body = db.prepare("SELECT body FROM shell_records WHERE id=?").get(data.tasks[4].id).body;
  data.metadata.taskPins.reverse(); data.metadata.taskTodos.push(data.tasks[5].id);
  data.overlays[data.tasks[4].id].runState = 'waiting'; await refresh();
  assert.deepEqual(withoutRevision(await model.run({ op: 'page', options: { status: 'needs' } })),
    oracle(data.tasks, data.metadata, data.overlays).page({ status: 'needs' }));
  assert.equal(db.prepare('SELECT body FROM shell_records WHERE id=?').get(data.tasks[4].id).body, body);
});
run('只读打开不创建缺失文件，也不接受任意 SQL 或写命令', async t => {
  const { model, file, refresh } = await setup(t); await refresh();
  const missing = file + '.missing';
  await assert.rejects(model.run({ op: 'open', file: missing }), /source_unavailable/);
  assert.equal(fs.existsSync(missing), false);
  for (const cmd of [{ op: 'write', sql: 'DELETE FROM shell_records' }, { op: 'refresh', sql: 'DELETE FROM shell_records' }]) {
    await assert.rejects(model.run(cmd), /invalid_command/);
  }
  assert.equal((await model.run({ op: 'page' })).total > 0, true);
});
run('损坏记录刷新失败保留上次完整快照，恢复后可重试', async t => {
  const { db, model, data, refresh } = await setup(t); await refresh();
  const before = await model.run({ op: 'snapshot' }); const id = data.tasks[3].id;
  db.prepare('UPDATE shell_records SET body=? WHERE id=?').run('{broken', id);
  await assert.rejects(refresh(), /invalid_record/);
  assert.deepEqual(await model.run({ op: 'snapshot' }), before);
  db.prepare('UPDATE shell_records SET body=? WHERE id=?').run(JSON.stringify({ ...data.tasks[3], title: '恢复' }), id);
  assert.equal((await refresh()).revision, before.revision + 1);
});
run('schema 升级和损坏数据库拒绝打开，不覆盖原模型', async t => {
  const { db, file, model, refresh } = await setup(t); await refresh();
  const before = await model.run({ op: 'snapshot' });
  db.pragma('user_version=2');
  await assert.rejects(model.run({ op: 'open', file }), /unsupported_schema/);
  assert.deepEqual(await model.run({ op: 'snapshot' }), before);
  const broken = file + '.broken'; fs.writeFileSync(broken, 'not a database');
  await assert.rejects(model.run({ op: 'open', file: broken }), /schema|open_failed/);
});
run('无效类型、孤立 surrogate 和不支持的 ID 明确失败', async t => {
  const { db, data, model, refresh } = await setup(t); await refresh();
  await assert.rejects(model.run({ op: 'page', options: { limit: {} } }), /invalid_number/);
  await assert.rejects(model.run({ op: 'page', options: { query: 'a'.repeat(199) + '😀' } }), /unsupported_query/);
  data.overlays[data.tasks[0].id].title = '禁止覆盖源字段';
  await assert.rejects(refresh(), /unsupported_overlay/); delete data.overlays[data.tasks[0].id].title;
  db.prepare('UPDATE shell_records SET body=? WHERE id=?').run(JSON.stringify({ ...data.tasks[0], title: '\ud800' }), data.tasks[0].id);
  await assert.rejects(refresh(), /invalid_record/);
  db.prepare('UPDATE shell_records SET body=? WHERE id=?').run(JSON.stringify(data.tasks[0]), data.tasks[0].id);
  db.prepare("INSERT INTO shell_records VALUES('task',?,?)").run('tsk_A', JSON.stringify({ ...data.tasks[0], id: 'mismatched' }));
  await assert.rejects(refresh(), /unsupported_identity/);
});
run('历史 ID 使用现有 ICU 排序，新增或删除后自动更新顺序', async t => {
  const data=fixtures(6), ids=['task-Z','任务甲','tsk_A','tsk_0','a_b','a-b'];
  data.tasks.forEach((task,i)=>{task.id=ids[i];task.createdAt=1;task.updatedAt=2;task.refs=[];});
  data.overlays={};data.metadata.taskPins=[];
  const {db,model,refresh}=await setup(t,data);await refresh();
  assert.deepEqual((await model.run({op:'snapshot'})).tasks,oracle(data.tasks,data.metadata).snapshot().tasks);
  const added={...data.tasks[0],id:'任务乙'};data.tasks.push(added);
  db.prepare("INSERT INTO shell_records VALUES('task',?,?)").run(added.id,JSON.stringify(added));
  await refresh();
  assert.deepEqual(withoutRevision(await model.run({op:'page',options:{status:'all'}})),oracle(data.tasks,data.metadata).page({status:'all'}));
  db.prepare("DELETE FROM shell_records WHERE id=?").run(added.id);data.tasks.pop();await refresh();
  assert.deepEqual((await model.run({op:'snapshot'})).tasks,oracle(data.tasks,data.metadata).snapshot().tasks);
});
test('关闭失败可以重试，后续调用仍按关闭状态保护',async()=>{
  let attempts=0;
  const model=createTaskReadModel({addon:{RustTaskReadModel:class{async run(){if(++attempts===1)throw Error('queue_full');return {result:'{"closed":true}'};}}}});
  await assert.rejects(model.close(),/queue_full/);assert.deepEqual(await model.close(),{closed:true});
  await assert.rejects(model.run({op:'page'}),/closed/);
});
run('真实任务壳的缺省生命周期字段可以投影，null 与缺省保持区别', async t => {
  const data = fixtures(3); delete data.tasks[0].status; data.tasks[1].status = null;
  delete data.tasks[0].updatedAt; delete data.tasks[0].refs;
  const { model, refresh } = await setup(t, data); await refresh();
  assert.deepEqual((await model.run({ op: 'snapshot' })).tasks, oracle(data.tasks, data.metadata, data.overlays).snapshot().tasks);
});
run('独占写锁使刷新明确失败，解锁后重试且无部分发布', async t => {
  const { file, model, refresh } = await setup(t, fixtures(20), { journal: 'DELETE' }); await refresh();
  const before = await model.run({ op: 'snapshot' });
  // SQLite file locks must be exercised across processes: independently linked
  // SQLite libraries in one process do not provide a valid lock-contention probe.
  const holder = spawn(process.execPath, ['-e', `
    const D=require(process.argv[1]).CompatDatabase,db=new D(process.argv[2]);
    db.exec('BEGIN EXCLUSIVE');process.stdout.write('locked');
    let done=false;function close(){if(done)return;done=true;clearTimeout(timer);db.exec('ROLLBACK');db.close();process.stdin.destroy();}
    const timer=setTimeout(close,2000);process.stdin.once('data',close);
  `, require.resolve('../src/sqlite/node-driver'), file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => holder.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', () => reject(new Error('lock_holder_exited'))); });
    await assert.rejects(refresh({ force: true }), /read_failed/);
  } finally { holder.stdin.end('release'); await exited; }
  assert.deepEqual(await model.run({ op: 'snapshot' }), before);
  assert.equal((await refresh({ force: true })).changed, false);
});
run('源文件被移走或原子替换时拒绝刷新，不继续使用旧文件句柄', async t => {
  const { file, model, refresh } = await setup(t, fixtures(3), { journal: 'DELETE' }); await refresh();
  const before = await model.run({ op: 'snapshot' });
  fs.renameSync(file, file + '.away');
  await assert.rejects(refresh(), /source_unavailable/);
  fs.renameSync(file + '.away', file);
  assert.equal((await refresh()).reloaded, false);
  fs.copyFileSync(file, file + '.replacement'); fs.renameSync(file + '.replacement', file);
  await assert.rejects(refresh(), /source_replaced/);
  assert.deepEqual(await model.run({ op: 'snapshot' }), before);
});
run('并发提交整批更新时每份读取快照只看到一个完整代次', async t => {
  const data = fixtures(300), { file, model, refresh } = await setup(t, data);
  const Writer = require('../src/sqlite/driver').CompatDatabase, writer = new Writer(file);
  const put = writer.prepare('UPDATE shell_records SET body=? WHERE id=?');
  try { for (let generation = 1; generation <= 5; generation++) {
    const reading = refresh({ force: true });
    writer.transaction(() => { for (const task of data.tasks) {
      put.run(JSON.stringify({ ...task, title: `generation${generation}` }), task.id);
    } })();
    await reading;
    const snapshot = await model.run({ op: 'snapshot' });
    const titles = new Set(snapshot.tasks.map(task => task.title));
    // The very first reader may capture the original fixture. Later reads must
    // capture either the complete previous batch or the complete new batch.
    if (generation > 1 || [...titles].some(title => title.startsWith('generation'))) assert.equal(titles.size, 1);
  } } finally { writer.close(); }
});
run('空库刷新与统计、关闭后重开均正常', async t => {
  const { model, file, refresh } = await setup(t, fixtures(0));
  await assert.rejects(model.run({ op: 'page' }), /not_ready/);
  await refresh(); assert.equal((await model.run({ op: 'page' })).total, 0);
  assert.deepEqual((await model.run({ op: 'stats' })).counts, {});
  await model.run({ op: 'open', file }); await refresh();
  assert.equal((await model.run({ op: 'snapshot' })).tasks.length, 0);
  await model.close(); await model.close();
  await assert.rejects(model.run({ op: 'page' }), /closed/);
});
run('并发调用按受理顺序执行，一个失败不污染后续命令', async t => {
  const { model, data } = await setup(t);
  const commands = [model.run({ op: 'refresh', metadata: data.metadata, overlays: data.overlays }),
    model.run({ op: 'page', options: { status: 'all' } }), model.run({ op: 'bad' }),
    model.run({ op: 'stats', dayStart: 0 })];
  const results = await Promise.allSettled(commands);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[1].value.total, data.tasks.length);
});
test('桥接队列有界，关闭排在已受理命令后且不会被满队列挡住', async () => {
  let release; const gate = new Promise(r => { release = r; }); const seen = [];
  const model = createTaskReadModel({ maxPending: 1, addon: { RustTaskReadModel: class {
    async run(input) { const { op } = JSON.parse(input); seen.push(op); if (op !== 'close') await gate;
      return { result: JSON.stringify({ op }) }; }
  } } });
  const first = model.run({ op: 'page' });
  await assert.rejects(model.run({ op: 'stats' }), /queue_full/);
  const closed = model.close(); release(); await first; await closed;
  assert.deepEqual(seen, ['page', 'close']);
  await assert.rejects(model.run({ op: 'page' }), /closed/);
});
run('显式复用与仅元数据增量不读任务正文，缓存查询及时失效', async t => {
  const { model, data, refresh } = await setup(t); await refresh();
  const before = await model.run({ op: 'snapshot' });
  const warm = await model.run({ op: 'sync' });
  assert.equal(warm.rowsLoaded, 0); assert.equal(warm.changed, false);
  data.metadata.taskTodos.push(data.tasks[6].id); data.metadata.taskPins.reverse();
  const next = await model.run({ op: 'sync', metadata: data.metadata, baseRevision: before.revision });
  assert.equal(next.rowsLoaded, 0); assert.equal(next.reloaded, false); assert.equal(next.changed, true);
  const view = await model.run({ op: 'view', options: { status: 'todo' }, dayStart: 5002 });
  const expected = oracle(data.tasks, data.metadata, data.overlays);
  assert.deepEqual(withoutRevision(view.page), expected.page({ status: 'todo' }));
  assert.deepEqual(view.counts, expected.stats(5002));
  await assert.rejects(model.run({ op: 'sync', baseRevision: before.revision, metadata: {} }), /stale_revision/);
  await assert.rejects(model.run({ op: 'sync', metadata: null }), /invalid_metadata/);
  assert.equal((await model.run({ op: 'snapshot' })).revision, next.revision);
});
run('实时覆盖替换与清除复用原摘要，失败不污染覆盖或快照', async t => {
  const { model, data, refresh } = await setup(t); await refresh();
  const id = data.tasks[4].id;
  data.overlays[id] = { runState: 'waiting', goalState: 'interact' };
  const reply = await model.run({ op: 'sync', overlayChanges: { [id]: data.overlays[id] } });
  assert.equal(reply.rowsLoaded, 0);
  assert.deepEqual((await model.run({ op: 'snapshot' })).tasks, oracle(data.tasks, data.metadata, data.overlays).snapshot().tasks);
  const before = await model.run({ op: 'snapshot' });
  await assert.rejects(model.run({ op: 'sync', overlayChanges: { [id]: { title: 'invalid' } } }), /unsupported_overlay/);
  assert.deepEqual(await model.run({ op: 'snapshot' }), before);
  delete data.overlays[id];
  assert.equal((await model.run({ op: 'sync', overlayChanges: { [id]: null } })).rowsLoaded, 0);
  assert.deepEqual((await model.run({ op: 'snapshot' })).tasks, oracle(data.tasks, data.metadata, data.overlays).snapshot().tasks);
});
run('省略输入仍检测跨连接写入，重载后保留元数据与实时覆盖', async t => {
  const { model, db, data, refresh } = await setup(t); await refresh();
  data.tasks[0].title = 'new database generation';
  db.prepare('UPDATE shell_records SET body=? WHERE id=?').run(JSON.stringify(data.tasks[0]), data.tasks[0].id);
  assert.equal((await model.run({ op: 'sync' })).rowsLoaded, data.tasks.length);
  assert.deepEqual((await model.run({ op: 'snapshot' })).tasks, oracle(data.tasks, data.metadata, data.overlays).snapshot().tasks);
  const before = await model.run({ op: 'snapshot' });
  db.prepare('UPDATE shell_records SET body=? WHERE id=?').run('{bad', data.tasks[0].id);
  await assert.rejects(model.run({ op: 'sync', metadata: {} }), /invalid_record/);
  assert.deepEqual(await model.run({ op: 'snapshot' }), before);
});
