'use strict';

// Each scenario is isolated in a child process so SQLite lock damage cannot
// contaminate the test runner or sibling databases.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function isolated(source) {
  const child = spawnSync(process.execPath, ['--no-warnings', '-e', source], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr || `child signal: ${child.signal}`);
  return JSON.parse(child.stdout.trim());
}
const writer = `const fs=require('fs'),Database=require('better-sqlite3');const file=fs.readFileSync(0,'utf8');const db=new Database(file);db.prepare("UPDATE t SET x=7 WHERE id=1").run();db.close();`;

test('raw SQLite data_version changes after a short external writer even after a second driver closes', () => {
  const result = isolated(`
    const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
    const Better=require('better-sqlite3'),{DatabaseSync}=require('node:sqlite');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixed-sqlite-raw-')),file=path.join(dir,'s.sqlite');
    const main=new DatabaseSync(file);main.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY,x INTEGER)');
    const other=new Better(file);other.prepare('INSERT INTO t(id,x) VALUES(1,0)').run();other.close();
    const before=main.prepare('PRAGMA data_version').get().data_version;
    const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(writer)}],{input:file,encoding:'utf8',timeout:5000});
    const after=main.prepare('PRAGMA data_version').get().data_version;
    const value=main.prepare('SELECT x FROM t WHERE id=1').get().x;
    main.close();fs.rmSync(dir,{recursive:true,force:true});
    console.log(JSON.stringify({before,after,value,exit:child.status}));
  `);
  assert.equal(result.exit, 0);
  assert.equal(result.value, 7);
  assert.notEqual(result.after, result.before, 'external commit must invalidate the reader version');
});

test('Rust store rejects an external writer after another in-process SQLite driver closes', () => {
  const update = `const fs=require('fs'),Database=require('better-sqlite3');const file=fs.readFileSync(0,'utf8');const db=new Database(file);db.prepare("UPDATE orchestration_outbox SET data_json=json_set(data_json,'$.external',7) WHERE id='a'").run();db.close();`;
  const result = isolated(`
    const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),Database=require('better-sqlite3');
    const {getNative}=require('./src/native/runtime');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixed-sqlite-rust-')),file=path.join(dir,'s.sqlite');
    const h=new (getNative().RustOrchestrationStore)(file,null,1000,{env:{},policy:{}});
    let db=new Database(file);db.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at) VALUES(?,?,?,?,?,?)').run('a',JSON.stringify({id:'a',sessionId:'s',state:'pending',sequence:1,availableAt:0,attempts:0}),'s','pending',1,0);db.close();
    const head=h.request('begin',{}), prior=JSON.parse(h.request('materialize',{collection:'outbox',key:'a'}).valueJson);
    const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(update)}],{input:file,encoding:'utf8',timeout:5000});
    let rejected=false;try { h.request('prepare',{expectedRevision:head.revision,state:{...head,revision:head.revision+1},changes:[{collection:'outbox',key:'a',value:{...prior,state:'leased'}}]});h.request('commit',{}); }
    catch(e){rejected=true;h.request('end',{});} h.request('close',{});
    db=new Database(file,{readonly:true});const row=JSON.parse(db.prepare("SELECT data_json FROM orchestration_outbox WHERE id='a'").get().data_json);db.close();
    fs.rmSync(dir,{recursive:true,force:true});console.log(JSON.stringify({exit:child.status,rejected,external:row.external??null,state:row.state}));
  `);
  assert.equal(result.exit, 0);
  assert.equal(result.rejected, true, 'the stale write must be rejected');
  assert.equal(result.external, 7, 'the external commit must remain intact');
});


test('production claim preserves a short external writer after a second in-process driver closes', () => {
  const update = `const fs=require('fs'),Database=require('better-sqlite3');const file=fs.readFileSync(0,'utf8');const db=new Database(file);db.prepare("UPDATE orchestration_outbox SET data_json=json_set(data_json,'$.external',7) WHERE id='a'").run();db.close();`;
  const result = isolated(`
    const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),Database=require('better-sqlite3');
    const {createOrchestrationSqliteStore}=require('./src/orchestration/sqlite-store'),{createOutbox}=require('./src/outbox');
    (async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mixed-sqlite-claim-')),file=path.join(dir,'s.sqlite');
      const store=createOrchestrationSqliteStore({file});let db=new Database(file);
      db.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at) VALUES(?,?,?,?,?,?)').run('a',JSON.stringify({id:'a',sessionId:'s',state:'pending',sequence:1,availableAt:0,attempts:0}),'s','pending',1,0);db.close();
      let wrote=false,exit,rejected=false;
      try { await createOutbox({store}).claim({workerId:'w',selectSessionItem(items){if(!wrote){wrote=true;exit=cp.spawnSync(process.execPath,['-e',${JSON.stringify(update)}],{input:file,encoding:'utf8',timeout:5000}).status;}return items[0];}}); }
      catch(e){rejected=true;}
      await store.close({exportRollback:false});db=new Database(file,{readonly:true});
      const row=JSON.parse(db.prepare("SELECT data_json FROM orchestration_outbox WHERE id='a'").get().data_json);db.close();
      fs.rmSync(dir,{recursive:true,force:true});console.log(JSON.stringify({exit,rejected,external:row.external??null,state:row.state}));
    })().catch(()=>process.exit(1));
  `);
  assert.equal(result.exit, 0);
  assert.equal(result.external, 7, 'committed external data must survive claim');
});

test('experimental isolated owner preserves a concurrent external claim update', {
  skip: !process.env.MULTICC_TEST_ORCHESTRATION_OWNER,
}, () => {
  const update = `const fs=require('fs'),Database=require('better-sqlite3');const file=fs.readFileSync(0,'utf8');const db=new Database(file);db.prepare("UPDATE orchestration_outbox SET data_json=json_set(data_json,'$.external',7) WHERE id='a'").run();db.close();`;
  const result = isolated(`
    const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),Database=require('better-sqlite3');
    const {createOrchestrationSqliteStore}=require('./src/orchestration/sqlite-store'),{createOutbox}=require('./src/outbox');
    (async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-sqlite-claim-')),file=path.join(dir,'s.sqlite');
      const store=createOrchestrationSqliteStore({file,experimentalOwnerBinary:process.env.MULTICC_TEST_ORCHESTRATION_OWNER});
      let db=new Database(file);
      db.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at) VALUES(?,?,?,?,?,?)').run('a',JSON.stringify({id:'a',sessionId:'s',state:'pending',sequence:1,availableAt:0,attempts:0}),'s','pending',1,0);db.close();
      let wrote=false,exit,rejected=false;
      try { await createOutbox({store}).claim({workerId:'w',selectSessionItem(items){if(!wrote){wrote=true;exit=cp.spawnSync(process.execPath,['-e',${JSON.stringify(update)}],{input:file,encoding:'utf8',timeout:5000}).status;}return items[0];}}); }
      catch(e){rejected=true;}
      await store.close({exportRollback:false});db=new Database(file,{readonly:true});
      const row=JSON.parse(db.prepare("SELECT data_json FROM orchestration_outbox WHERE id='a'").get().data_json);db.close();
      fs.rmSync(dir,{recursive:true,force:true});console.log(JSON.stringify({exit,rejected,external:row.external??null,state:row.state}));
    })().catch(e=>{console.error(e);process.exit(1)});
  `);
  assert.equal(result.exit, 0);
  assert.equal(result.external, 7, 'the external update must survive the isolated claim');
  assert.equal(result.rejected, true, 'a changed snapshot must abort the claim');
  assert.equal(result.state, 'pending');
});

test('experimental owner shares one process for same-database sessions', {
  skip: !process.env.MULTICC_TEST_ORCHESTRATION_OWNER,
}, () => {
  const result = isolated(`
    const fs=require('fs'),os=require('os'),path=require('path');
    const {getNative}=require('./src/native/runtime');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-owner-pool-'));
    fs.mkdirSync(path.join(dir,'sub'));
    const file=path.join(dir,'s.sqlite'),alias=path.join(dir,'sub')+path.sep+'..'+path.sep+'s.sqlite';
    const C=getNative().RustIsolatedOrchestrationStore, bin=process.env.MULTICC_TEST_ORCHESTRATION_OWNER;
    const a=new C(file,null,1000,{env:{},policy:{}},bin), b=new C(alias,null,1000,{env:{},policy:{}},bin);
    const aPid=a.ownerProcessId,bPid=b.ownerProcessId;
    const other=path.join(dir,process.platform==='win32'?'other.exe':'other');fs.copyFileSync(bin,other);
    if(process.platform!=='win32')fs.chmodSync(other,0o755);
    let mismatch=false;try { new C(file,null,1000,{env:{},policy:{}},other); } catch(e) { mismatch=String(e.message).includes('owner executable mismatch'); }
    const h1=a.request('begin',{}),h2=b.request('begin',{});
    b.request('prepare',{expectedRevision:h2.revision,state:{...h2,revision:h2.revision+1},changes:[{collection:'outbox',key:'b',value:{id:'b',sessionId:'s',state:'pending',sequence:1,availableAt:0}}]});
    b.request('commit',{});
    let conflict=false;try { a.request('prepare',{expectedRevision:h1.revision,state:h1,changes:[]}); } catch(e) { conflict=String(e.message).includes('ORCHESTRATION_SQLITE_CONFLICT'); }
    a.request('close',{});
    const revision=b.request('info',{}).state.revision;
    b.request('close',{});
    const c=new C(file,null,1000,{env:{},policy:{}},bin);
    const reopened=c.request('info',{}).state.revision;c.request('close',{});
    fs.rmSync(dir,{recursive:true,force:true});console.log(JSON.stringify({aPid,bPid,mismatch,conflict,revision,reopened}));
  `);
  assert.ok(result.aPid > 0);
  assert.equal(result.aPid, result.bPid, 'same database must use one Rust owner process');
  assert.equal(result.mismatch, true, 'another executable must not silently share an existing owner');
  assert.equal(result.conflict, true, 'the first session must reject a stale snapshot');
  assert.equal(result.revision, 1, 'closing one session must leave the other operational');
  assert.equal(result.reopened, 1, 'reopening after the last close must preserve committed data');
});

test('owner death fails all shared sessions and rolls back uncommitted work', {
  skip: !process.env.MULTICC_TEST_ORCHESTRATION_OWNER,
}, () => {
  const result = isolated(`
    const fs=require('fs'),os=require('os'),path=require('path');
    const {getNative}=require('./src/native/runtime');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-owner-death-'));
    const file=path.join(dir,'s.sqlite'),C=getNative().RustIsolatedOrchestrationStore;
    const bin=process.env.MULTICC_TEST_ORCHESTRATION_OWNER;
    const a=new C(file,null,1000,{env:{},policy:{}},bin),b=new C(file,null,1000,{env:{},policy:{}},bin);
    const h=a.request('begin',{});
    a.request('prepare',{expectedRevision:h.revision,state:{...h,revision:h.revision+1},changes:[{collection:'outbox',key:'a',value:{id:'a',sessionId:'s',state:'pending',sequence:1,availableAt:0}}]});
    process.kill(a.ownerProcessId,'SIGKILL');
    let first=false,second=false;
    try { a.request('commit',{}); } catch(e) { first=true; }
    try { b.request('info',{}); } catch(e) { second=true; }
    const c=new C(file,null,1000,{env:{},policy:{}},bin);
    const revision=c.request('info',{}).state.revision;
    const found=c.request('materialize',{collection:'outbox',key:'a'}).found;
    c.request('close',{});fs.rmSync(dir,{recursive:true,force:true});
    console.log(JSON.stringify({first,second,revision,found}));
  `);
  assert.equal(result.first, true, 'the interrupted commit must return an error');
  assert.equal(result.second, true, 'other sessions must fail rather than silently reconnect');
  assert.equal(result.revision, 0);
  assert.equal(result.found, false);
});
