'use strict';
// Regression: a short-lived SQLite connection in another process can checkpoint
// and remove WAL while the Rust connection retains stale pages. The revision and
// outbox row below are written in the same SQLite transaction and must agree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const { getNative } = require('../src/native/runtime');

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

test('Rust connection sees a short-lived external writer transaction consistently', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-wal-mixed-'));
  const file = path.join(dir, 'db.sqlite');
  const store = new (getNative().RustOrchestrationStore)(file, null, 1000, { env: {}, policy: {} });
  t.after(() => { store.request('close', {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const seed = new Database(file);
  seed.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('q', JSON.stringify({ id: 'q', sessionId: 's', state: 'pending', payload: { message: 'before' } }), 's', 'pending', 1, 1, 1);
  seed.close();
  assert.equal(store.request('info', {}).state.revision, 0);
  const source = `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const db=new D(process.argv[1]);db.transaction(()=>{const row=JSON.parse(db.prepare('SELECT data_json FROM orchestration_outbox WHERE id=?').get('q').data_json);row.payload.message='external';db.prepare('UPDATE orchestration_outbox SET data_json=? WHERE id=?').run(JSON.stringify(row),'q');db.prepare("UPDATE orchestration_meta SET value_json='1' WHERE key='revision'").run()})();db.close()`;
  const child = spawnSync(process.execPath, ['-e', source, file], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const header = store.request('begin', {});
  const item = store.request('inspect', { collection: 'outbox', key: 'q', path: ['payload', 'message'] });
  store.request('end', {});
  assert.equal(JSON.parse(item.valueJson), 'external');
  assert.equal(header.revision, 1, 'revision and row were committed atomically by the same external writer');
});

test('external SQLite writer stays consistent when the Rust process never opens the file with another SQLite library', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-wal-isolated-'));
  const file = path.join(dir, 'db.sqlite');
  const store = new (getNative().RustOrchestrationStore)(file, null, 1000, { env: {}, policy: {} });
  t.after(() => { store.request('close', {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const source = `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const db=new D(process.argv[1]);db.transaction(()=>{db.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('q',JSON.stringify({id:'q',sessionId:'s',state:'pending',payload:{message:'external'}}),'s','pending',1,1,1);db.prepare("UPDATE orchestration_meta SET value_json='1' WHERE key='revision'").run()})();db.close()`;
  assert.equal(store.request('info', {}).state.revision, 0);
  const child = spawnSync(process.execPath, ['-e', source, file], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const header = store.request('begin', {});
  const item = store.request('inspect', { collection: 'outbox', key: 'q', path: ['payload', 'message'] });
  store.request('end', {});
  assert.equal(JSON.parse(item.valueJson), 'external');
  assert.equal(header.revision, 1);
});

test('same-process connections using the Rust SQLite implementation preserve the external writer', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-wal-same-sqlite-'));
  const file = path.join(dir, 'db.sqlite');
  const store = new (getNative().RustOrchestrationStore)(file, null, 1000, { env: {}, policy: {} });
  t.after(() => { store.request('close', {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const Driver = require('../src/sqlite/driver').databaseConstructor();
  const db = new Driver(file);
  db.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('q', JSON.stringify({ id: 'q', sessionId: 's', state: 'pending', payload: { message: 'before' } }), 's', 'pending', 1, 1, 1);
  db.close();
  assert.equal(store.request('info', {}).state.revision, 0);
  const source = `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const db=new D(process.argv[1]);db.transaction(()=>{const row=JSON.parse(db.prepare('SELECT data_json FROM orchestration_outbox WHERE id=?').get('q').data_json);row.payload.message='external';db.prepare('UPDATE orchestration_outbox SET data_json=? WHERE id=?').run(JSON.stringify(row),'q');db.prepare("UPDATE orchestration_meta SET value_json='1' WHERE key='revision'").run()})();db.close()`;
  const child = spawnSync(process.execPath, ['-e', source, file], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const header = store.request('begin', {});
  const item = store.request('inspect', { collection: 'outbox', key: 'q', path: ['payload', 'message'] });
  store.request('end', {});
  assert.equal(JSON.parse(item.valueJson), 'external');
  assert.equal(header.revision, 1);
});

test('separate Rust owner process remains coherent with a Node SQLite writer', { timeout: 5000 }, async t => {
  const { fork } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-wal-owner-process-'));
  const file = path.join(dir, 'db.sqlite');
  const workerFile = path.join(dir, 'owner.cjs');
  fs.writeFileSync(workerFile, `const addon=require(process.env.MULTICC_RUST_ADDON);const store=new addon.RustOrchestrationStore(process.argv[2],null,1000,{env:{},policy:{}});process.send({ready:true});process.on('message',message=>{try{if(message==='read'){const state=store.request('begin',{});const item=store.request('inspect',{collection:'outbox',key:'q',path:['payload','message']});store.request('end',{});process.send({revision:state.revision,value:item.valueJson});}else{store.request('close',{});process.disconnect()}}catch(e){process.send({error:String(e)})}})`);
  const addon = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../native/prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');
  const child = fork(workerFile, [file], { env: { ...process.env, MULTICC_RUST_ADDON: addon }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const receive = () => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`owner exited ${code}: ${errors}`))); });
  t.after(async () => { await stopChild(child); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(await receive(), { ready: true });
  const db = new Database(file);
  db.transaction(() => { db.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('q', JSON.stringify({ id: 'q', sessionId: 's', state: 'pending', payload: { message: 'external' } }), 's', 'pending', 1, 1, 1); db.prepare("UPDATE orchestration_meta SET value_json='1' WHERE key='revision'").run(); })();
  db.close();
  const response = receive(); child.send('read');
  assert.deepEqual(await response, { revision: 1, value: '"external"' });
});

test('a killed isolated Rust SQLite writer rolls back its incomplete transaction', { timeout: 5000 }, async t => {
  const { fork } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-wal-kill-'));
  const file = path.join(dir, 'db.sqlite');
  const workerFile = path.join(dir, 'writer.cjs');
  const driverFile = path.resolve(__dirname, '../src/sqlite/driver.js');
  const sql = "PRAGMA journal_mode=WAL; CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('before'); BEGIN IMMEDIATE; UPDATE state SET value='incomplete'";
  fs.writeFileSync(workerFile, `const {databaseConstructor}=require(${JSON.stringify(driverFile)});const D=databaseConstructor();const db=new D(process.argv[2]);db.exec(${JSON.stringify(sql)});process.send({ready:true})`);
  const child = fork(workerFile, [file], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { await stopChild(child); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`writer exited ${code}: ${errors}`))); });
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  const db = new Database(file, { readonly: true });
  assert.equal(db.prepare('SELECT value FROM state').get().value, 'before'); db.close();
});

test('isolated Rust writer waits for the Node writer lock and then commits', { timeout: 5000 }, async t => {
  const { fork } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-wal-lock-'));
  const file = path.join(dir, 'db.sqlite'); const workerFile = path.join(dir, 'writer.cjs');
  const driverFile = path.resolve(__dirname, '../src/sqlite/driver.js');
  fs.writeFileSync(workerFile, `const {databaseConstructor}=require(${JSON.stringify(driverFile)});const D=databaseConstructor();const db=new D(process.argv[2]);process.send({ready:true});process.on('message',()=>{try{db.exec("BEGIN IMMEDIATE; UPDATE state SET value='child'; COMMIT");process.send({committed:true});db.close();process.disconnect()}catch(e){process.send({error:String(e)});process.disconnect()}})`);
  const db = new Database(file); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE state(value TEXT); INSERT INTO state VALUES('initial')");
  const child = fork(workerFile, [file], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { await stopChild(child); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`writer exited ${code}: ${errors}`))); });
  db.exec("BEGIN IMMEDIATE; UPDATE state SET value='parent'");
  let responded = false;
  const response = new Promise((resolve, reject) => { child.once('message', value => { responded = true; resolve(value); }); child.once('exit', code => { if (!responded) reject(new Error(`writer exited ${code}: ${errors}`)); }); });
  child.send('write'); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(responded, false, 'Rust writer must wait while Node owns the SQLite write lock');
  db.exec('COMMIT'); assert.deepEqual(await response, { committed: true });
  assert.equal(db.prepare('SELECT value FROM state').get().value, 'child');
});
