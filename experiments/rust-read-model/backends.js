'use strict';

const path = require('node:path'), os = require('node:os');
const { Worker, parentPort, workerData, isMainThread } = require('node:worker_threads');
const { createAirReadIndex } = require('../../tests/helpers/legacy-air-read-index');
const { databaseConstructor } = require('../../src/sqlite/driver');
const { IncrementalModel } = require('./node-model');
const { project } = require('./fixtures');

function local(kind) {
  let model, db; const statements = new Map();
  function reset() { model = kind === 'current' ? createAirReadIndex() : new IncrementalModel(); }
  reset();
  function apply(cards, cmd) {
    if (cmd.reset) reset();
    if (kind === 'current') {
      model.apply({ ...cmd.metadata, tasks: cards }, { partial: !cmd.reset, removed: cmd.removed || [] });
      return { ready: true };
    }
    return model.apply(cards, cmd);
  }
  function prepare(sql) { if (!statements.has(sql)) statements.set(sql, db.prepare(sql)); return statements.get(sql); }
  function run(cmd) {
    switch (cmd.op) {
      case 'gc': global.gc?.(); return {};
      case 'apply': return apply(cmd.cards ? cmd.tasks : cmd.tasks.map(project), cmd);
      case 'page': {
        const { cursor, ...result } = model.page(cmd.options); return result;
      }
      case 'stats': return model.stats(cmd.dayStart || 0);
      case 'dbOpen': {
        db = new (databaseConstructor())(cmd.file); db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL'); db.pragma('busy_timeout = 5000');
        return { sqlite: db.prepare('SELECT sqlite_version() AS version').get().version };
      }
      case 'dbLoad': return apply(prepare(cmd.sql).all().map(row => project(JSON.parse(row.body))), { reset: true, metadata: cmd.metadata });
      case 'dbWrite': {
        const stmt = prepare("INSERT INTO shell_records(kind,id,body) VALUES ('task',?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body");
        db.transaction(() => { for (const t of cmd.tasks) stmt.run(t.id, JSON.stringify(t)); })();
        return { written: cmd.tasks.length };
      }
      case 'close': db?.close(); db = null; statements.clear(); reset(); return { closed: true };
      default: throw new Error('未知实验命令');
    }
  }
  return { run, close: () => run({ op: 'close' }) };
}

function createBackend(kind) {
  if (kind === 'current' || kind === 'incremental') return local(kind);
  if (kind === 'rust') {
    const file = process.env.MULTICC_EXPERIMENT_ADDON || path.join(os.tmpdir(), 'multicc-read-model-target', 'read_model.node');
    const { Experiment } = require(file), native = new Experiment();
    return { async run(cmd) { return JSON.parse((await native.run(JSON.stringify(cmd))).result); },
      async close() { await native.run('{"op":"close"}'); } };
  }
  if (kind !== 'worker') throw new Error('未知后端');
  const worker = new Worker(__filename, { workerData: { experiment: true } });
  const requests = new Map(); let seq = 0, dead = null, closed = false;
  const fail = error => { dead = error; for (const { reject } of requests.values()) reject(error); requests.clear(); };
  worker.on('error', fail);
  worker.on('exit', code => { if (code !== 0) fail(new Error(`工作线程退出：${code}`)); });
  worker.on('message', ({ id, result, error }) => {
    const pending = requests.get(id); if (!pending) return; requests.delete(id);
    if (error) pending.reject(new Error(error)); else pending.resolve(JSON.parse(result));
  });
  const run = cmd => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = ++seq; requests.set(id, { resolve, reject }); worker.postMessage({ id, input: JSON.stringify(cmd) });
  });
  return { run, async close() { if (closed) return; closed = true;
    try { await run({ op: 'close' }); } finally { dead = new Error('工作线程已关闭'); await worker.terminate(); } } };
}
if (!isMainThread && workerData?.experiment) {
  const backend = local('incremental');
  parentPort.on('message', ({ id, input }) => {
    try { parentPort.postMessage({ id, result: JSON.stringify(backend.run(JSON.parse(input))) }); }
    catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
}
module.exports = { createBackend };
