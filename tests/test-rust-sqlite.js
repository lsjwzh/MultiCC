'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CompatDatabase: Rust, databaseConstructor } = require('../src/sqlite/driver');

function file(t, close = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-sqlite-'));
  t.after(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });
  return path.join(root, 'test.sqlite');
}
function memory(t) { const db = new Rust(':memory:'); t.after(() => db.close()); return db; }

test('默认路径确实执行 Rust，禁止加载 node:sqlite 仍能读写', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const Module = require('module'), load = Module._load;
    Module._load = function(id, ...rest) { if (id === 'node:sqlite' || id === 'better-sqlite3') throw Error('禁止旧驱动'); return load.call(this,id,...rest); };
    const Database = require('./src/sqlite/driver').databaseConstructor();
    const db = new Database(':memory:'); if(db.backend !== 'rust')process.exit(2);
    db.exec('CREATE TABLE t(x)');db.prepare('INSERT INTO t VALUES (?)').run('实际 Rust');
    if(db.prepare('SELECT x FROM t').get().x !== '实际 Rust')process.exit(3);db.close();
  `], { cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('Rust 缺失明确失败，没有 Node 应急驱动', () => {
  const result = spawnSync(process.execPath, ['-e', "const D=require('./src/sqlite/driver').databaseConstructor();new D(':memory:').close()"], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, MULTICC_RUST_ADDON: path.join(os.tmpdir(), 'missing-sqlite-addon.node') },
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /SQLITE_RUNTIME_UNAVAILABLE/);
});
test('参数与数值边界：NULL、Unicode、Blob、64 位整数、超限拒绝', t => {
  const db = memory(t);
  assert.deepEqual(db.prepare('SELECT ? AS n, ? AS s, ? AS b').get(undefined, '中文 😀\0尾', Buffer.from([0, 255, 65])),
    { n: null, s: '中文 😀\0尾', b: new Uint8Array([0, 255, 65]) });
  for (const number of [0n, -1n, 9007199254740991n]) assert.equal(db.prepare('SELECT ? AS n').get(number).n, Number(number));
  assert.equal(db.prepare('SELECT CAST(? AS TEXT) AS n').get(9223372036854775807n).n, '9223372036854775807');
  assert.throws(() => db.prepare('SELECT ? AS n').get(9007199254740992n), /safe integer/);
  assert.throws(() => db.prepare('SELECT ?').get(9223372036854775808n), /64-bit/);
  assert.throws(() => db.prepare('SELECT ?').get(true));
});
test('缓存绑定不泄露上次参数，命名参数前缀歧义必须拒绝', t => {
  const db = memory(t), stmt = db.prepare('SELECT @a AS a, @b AS b, ? AS c');
  assert.deepEqual(stmt.get({ a: 'a', b: 'b', extra1: 1, extra2: 2 }, 'c'), { a:'a', b:'b', c:'c' });
  assert.deepEqual(stmt.get({ a: 'next' }), { a:'next', b:null, c:null });
  assert.throws(() => db.prepare('SELECT @a, :a').get({ a:1 }), /ambiguous/);
  assert.deepEqual(db.prepare('SELECT @a AS a, :a AS b').get({ '@a': 1, ':a': 2 }), { a:1, b:2 });
  assert.deepEqual(db.prepare('SELECT ?2 AS v').get({ '?2': 7 }), { v:7 });
  assert.deepEqual(db.prepare('SELECT 1 AS "__proto__", 2 AS constructor').get(), { ['__proto__']:1, constructor:2 });
});
test('COMMIT 延迟外键失败必须回滚，连接可继续使用', t => {
  const db = memory(t);
  db.exec('CREATE TABLE p(id PRIMARY KEY); CREATE TABLE c(id REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
  assert.throws(() => db.transaction(() => db.prepare('INSERT INTO c VALUES (?)').run(9)).immediate(),
    { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  assert.equal(db.inTransaction, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM c').get().n, 0);
  db.transaction(() => { db.exec('INSERT INTO p VALUES(9); INSERT INTO c VALUES(9)'); })();
  assert.equal(db.prepare('SELECT count(*) AS n FROM c').get().n, 1);
});
test('外层手动事务与内层回滚、关闭后旧语句失效', t => {
  const db = memory(t);
  db.exec('CREATE TABLE t(x); BEGIN IMMEDIATE; INSERT INTO t VALUES(1)');
  assert.throws(() => db.transaction(() => { db.exec('INSERT INTO t VALUES(2)'); throw Error('取消'); })(), /取消/);
  assert.equal(db.inTransaction, true);
  db.exec('COMMIT');
  const statement = db.prepare('SELECT x FROM t');
  assert.deepEqual(statement.all(), [{x:1}]);
  db.close();
  assert.throws(() => statement.all(), /not open/);
});
test('已有数据库重新打开，WAL 双连接、data_version 与只读保护一致', t => {
  let writer, reader;
  const filename = file(t, () => { reader?.close(); writer?.close(); });
  writer = new Rust(filename);
  writer.pragma('journal_mode = WAL'); writer.exec('CREATE TABLE t(k TEXT PRIMARY KEY, body TEXT)');
  writer.prepare('INSERT INTO t VALUES (?, ?)').run('旧', JSON.stringify({ title: '旧数据' }));
  reader = new Rust(filename);
  assert.equal(reader.prepare('SELECT body FROM t').get().body, '{"title":"旧数据"}');
  const before = reader.pragma('data_version', { simple:true });
  writer.prepare('INSERT INTO t VALUES (?, ?)').run('另一个连接', '{}');
  assert.notEqual(reader.pragma('data_version', { simple:true }), before);
  reader.transaction(() => { reader.prepare('UPDATE t SET body=? WHERE k=?').run('{"title":"Rust"}', '旧'); })();
  assert.equal(writer.prepare('SELECT body FROM t WHERE k=?').get('旧').body, '{"title":"Rust"}');
  reader.close(); reader = new Rust(filename, { readonly:true, fileMustExist:true });
  assert.equal(reader.prepare('SELECT count(*) AS n FROM t').get().n, 2);
  assert.throws(() => reader.exec('DELETE FROM t'), { code:'SQLITE_READONLY' });
});
test('跨进程锁竞争超时不会留下部分写入，解锁后恢复', t => {
  let db;
  const filename = file(t, () => db?.close());
  db = new Rust(filename, { timeout: 25 });
  db.exec('CREATE TABLE t(x); BEGIN IMMEDIATE; INSERT INTO t VALUES(1)');
  const result = spawnSync(process.execPath, ['-e', `
    const D=require('./src/sqlite/driver').databaseConstructor(),db=new D(process.argv[1],{timeout:25});
    try{db.transaction(()=>db.exec('INSERT INTO t VALUES(2)')).immediate();process.exitCode=2}
    catch(e){if(e.code!=='SQLITE_BUSY'||db.inTransaction)throw e}finally{db.close()}
  `, filename], { cwd:path.resolve(__dirname,'..'),env:process.env, encoding:'utf8',timeout:10000 });
  assert.equal(result.status, 0, result.stderr);
  db.exec('COMMIT');
  assert.deepEqual(db.prepare('SELECT x FROM t').all(), [{x:1}]);
  db.transaction(() => db.exec('INSERT INTO t VALUES(3)')).immediate();
  assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 2);
});
test('缺失只读文件不创建，损坏文件不覆盖', t => {
  const filename=file(t);
  assert.throws(() => new Rust(filename,{readonly:true}), {code:'SQLITE_CANTOPEN'});
  assert.equal(fs.existsSync(filename),false);
  fs.writeFileSync(filename,'not-a-database');
  let db;
  try { db=new Rust(filename); assert.throws(()=>db.prepare('SELECT * FROM sqlite_master').all(), {code:'SQLITE_NOTADB'}); }
  catch(e) { assert.equal(e.code,'SQLITE_NOTADB'); }
  finally { if(db)db.close(); }
  assert.equal(fs.readFileSync(filename,'utf8'),'not-a-database');
});
test('FTS5 contentless_delete、JSON 函数、raw 返回保持可用', t => {
  const db=memory(t);
  db.exec("CREATE VIRTUAL TABLE f USING fts5(t,content='',contentless_delete=1); INSERT INTO f(rowid,t)VALUES(1,'rust sqlite')");
  assert.deepEqual(db.prepare('SELECT rowid FROM f WHERE f MATCH ?').all('rust'),[{rowid:1}]);
  db.exec('DELETE FROM f WHERE rowid=1');
  assert.deepEqual(db.prepare('SELECT rowid FROM f WHERE f MATCH ?').all('rust'),[]);
  assert.deepEqual(db.prepare("SELECT json_extract(?, '$.x') AS x").raw().get('{"x":7}'),[7]);
});

test('真实打包副本加载自己的 Rust 模块，移除产物后宿主环境不能掩盖缺失', t => {
  const root=path.dirname(file(t)), serverDir=path.join(root,'app-server');
  const {stageServer}=require('../scripts/desktop-bundle-server');
  const {verifyRuntimeSqlite}=require('../scripts/standalone-bundle');
  const logger={log(){}};
  stageServer({repoRoot:path.resolve(__dirname,'..'),out:serverDir,install:false,logger});
  const options={runtimeNode:process.execPath,serverDir,logger};
  assert.equal(verifyRuntimeSqlite(options).ok,true);
  fs.rmSync(path.join(serverDir,'native'),{recursive:true});
  assert.throws(()=>verifyRuntimeSqlite(options),/cannot open a SQLite database/);
});
