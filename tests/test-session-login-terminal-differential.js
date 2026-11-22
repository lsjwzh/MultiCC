'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const implementations = [
  require('./helpers/legacy-session-login-terminal'),
  { createLoginTerminalDisposer: deps => require('../src/native/runtime').getNative().sessionLoginTerminalDisposer(deps) },
];

function fixture(implementation, options = {}) {
  const trace = [];
  class Records extends Map {
    delete(id) { trace.push(`delete:${id}`); if (options.deleteError) throw options.deleteError; return super.delete(id); }
  }
  const records = new Records([
    ['a', { id:'a', dirId:'d', loginFlow:'codex-login' }],
    ['b', { id:'b', dirId:'d', loginFlow:'another' }],
    ['c', { id:'c', dirId:'e', loginFlow:'codex-login' }],
  ]);
  const dispose = implementation.createLoginTerminalDisposer({
    persistedSessions: records,
    async destroySessionCascade(record, dir, flags) {
      trace.push(`cascade:${record.id}:${dir.id}:${flags.force}`);
      if (options.cascadeError) throw options.cascadeError;
    },
    async tmuxKillSession(id) { trace.push(`kill:${id}`); if (options.killError) throw options.killError; },
    saveSessions(source) { trace.push(`save:${source}`); if (options.saveError) throw options.saveError; },
  });
  return { dispose, records, trace };
}

test('login cleanup snapshots matches and orders cascade, kill, delete, save', async () => {
  for (const implementation of implementations) {
    const { dispose, records, trace } = fixture(implementation);
    assert.equal(await dispose('  codex-login  '), 2);
    assert.deepEqual(trace, [
      'cascade:a:d:true', 'kill:a', 'delete:a',
      'cascade:c:e:true', 'kill:c', 'delete:c', 'save:runtime.login-terminal-reset',
    ]);
    assert.deepEqual([...records.keys()], ['b']);
    assert.equal(dispose.length, 1);
    assert.equal(await dispose(), 0);
    assert.equal(await dispose(null), 0);
    assert.equal(await dispose(''), 0);
    assert.equal(await dispose('codex-login'), 0);
    assert.equal(trace.filter(row => row.startsWith('save:')).length, 1);
  }
});

test('cascade and tmux failures are swallowed but deletion continues', async () => {
  for (const implementation of implementations) {
    const { dispose, records, trace } = fixture(implementation, { cascadeError: Error('cascade'), killError: Error('kill') });
    assert.equal(await dispose('codex-login'), 2);
    assert.deepEqual([...records.keys()], ['b']);
    assert.deepEqual(trace.filter(row => row.startsWith('delete:')), ['delete:a', 'delete:c']);
  }
});

test('delete and save errors reject with the original error identity', async () => {
  for (const implementation of implementations) {
    for (const key of ['deleteError','saveError']) {
      const marker = Error(key);
      const { dispose } = fixture(implementation, { [key]: marker });
      await assert.rejects(dispose('codex-login'), error => error === marker);
    }
  }
});

test('factory validation, coercion and property errors match the original boundary', async () => {
  for (const implementation of implementations) {
    assert.throws(() => implementation.createLoginTerminalDisposer(null), { name:'TypeError', message:'[login-terminal] dependencies are required' });
    assert.throws(() => implementation.createLoginTerminalDisposer({}), { name:'TypeError', message:'[login-terminal] persistedSessions map is required' });
    assert.throws(() => implementation.createLoginTerminalDisposer({ persistedSessions:new Map() }), { name:'TypeError', message:'[login-terminal] tmuxKillSession is required' });
    const { dispose } = fixture(implementation);
    const marker = Error('coercion');
    const promise = dispose({ toString() { throw marker; } });
    await assert.rejects(promise, error => error === marker);
    assert.equal(await dispose(Symbol('other')), 0);
  }
});

test('dependency getters are read in the same order including optional ports', () => {
  const traces = [];
  for (const implementation of implementations) {
    const trace = [];
    const backing = { persistedSessions:new Map(), tmuxKillSession() {}, destroySessionCascade() {}, saveSessions() {} };
    const ports = new Proxy(backing, { get(target, key, receiver) { trace.push(String(key)); return Reflect.get(target, key, receiver); } });
    implementation.createLoginTerminalDisposer(ports);
    traces.push(trace);
  }
  assert.deepEqual(traces[1], traces[0]);
  assert.deepEqual(traces[0], ['persistedSessions','tmuxKillSession','destroySessionCascade','destroySessionCascade','saveSessions','saveSessions']);
});

test('snapshot, getters, coercion and failures preserve exact effect ordering', async () => {
  const results = [];
  for (const implementation of implementations) {
    const trace = [];
    const records = new Map();
    const first = {
      get loginFlow() { trace.push('flow:a'); return 'target'; },
      get dirId() { trace.push('dir:a'); throw Error('ignored dir'); },
      get id() { trace.push('id:a'); return 'a'; },
    };
    const second = {
      get loginFlow() { trace.push('flow:b'); return 'target'; },
      get dirId() { trace.push('dir:b'); return 'd'; },
      get id() { trace.push('id:b'); return 'b'; },
    };
    records.set('a',first); records.set('b',second);
    const dispose = implementation.createLoginTerminalDisposer({
      persistedSessions:records,
      destroySessionCascade(record) { trace.push(`cascade:${record===second}`); records.set('new', {id:'new',loginFlow:'target'}); },
      tmuxKillSession(id) { trace.push(`kill:${id}`); },
      saveSessions(source) { trace.push(`save:${source}`); },
    });
    const input = { [Symbol.toPrimitive](hint) { trace.push(`coerce:${hint}`); return ' target '; } };
    const count = await dispose(input);
    results.push({count, trace, remaining:[...records.keys()]});
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[0].remaining, ['new']);
  assert.deepEqual(results[0].trace, ['coerce:string','flow:a','dir:a','id:a','kill:a','id:a','flow:b','dir:b','cascade:true','id:b','kill:b','id:b','save:runtime.login-terminal-reset']);
});

test('exceptional getters reject or are ignored at their original boundary', async () => {
  for (const implementation of implementations) {
    const marker=Error('getter identity');
    const record=Object.defineProperty({},'loginFlow',{get(){throw marker;}});
    const dispose=implementation.createLoginTerminalDisposer({persistedSessions:new Map([['x',record]]),tmuxKillSession(){}});
    await assert.rejects(dispose('x'),error=>error===marker);
    const badDeps=Object.defineProperty({},'persistedSessions',{get(){throw marker;}});
    assert.throws(()=>implementation.createLoginTerminalDisposer(badDeps),error=>error===marker);
  }
});

test('many synchronously failing kills do not overflow and still save once', async () => {
  for (const implementation of implementations) {
    const count=12000;
    const records=new Map(Array.from({length:count},(_,i)=>[i,{id:i,loginFlow:'x'}]));
    let saves=0;
    const dispose=implementation.createLoginTerminalDisposer({persistedSessions:records,tmuxKillSession(){throw Error('ignored');},saveSessions(){saves++;}});
    assert.equal(await dispose('x'),count);
    assert.equal(records.size,0);
    assert.equal(saves,1);
  }
});

test('the returned promise waits for each asynchronous cleanup before deleting', async () => {
  for (const implementation of implementations) {
    const trace=[];let release;
    const records=new Map([['x',{id:'x',loginFlow:'flow'}]]);
    const dispose=implementation.createLoginTerminalDisposer({persistedSessions:records,tmuxKillSession(){trace.push('kill');return new Promise(resolve=>{release=resolve;});},saveSessions(){trace.push('save');}});
    const result=dispose('flow');
    assert.equal(result instanceof Promise,true);
    assert.equal(records.has('x'),true);
    assert.deepEqual(trace,['kill']);
    release();
    assert.equal(await result,1);
    assert.equal(records.has('x'),false);
    assert.deepEqual(trace,['kill','save']);
  }
});

test('native factory cycles can be garbage collected', () => {
  const { spawnSync } = require('node:child_process');
  const addon = require('../src/native/runtime').addonPath();
  const script = String.raw`
    const a=require(process.argv[1]);
    function cycle() { let factory; const deps={ persistedSessions:new Map(), tmuxKillSession(){return factory;} }; factory=a.sessionLoginTerminalDisposer(deps); return new WeakRef(factory); }
    function pendingCycle() { const record={id:'a',loginFlow:'x'}; const records=new Map([['a',record]]); const factory=a.sessionLoginTerminalDisposer({persistedSessions:records,tmuxKillSession(){return new Promise(()=>{});}}); const pending=factory('x'); record.pending=pending; return new WeakRef(pending); }
    (async()=>{ const refs=[cycle(),pendingCycle()]; for(let i=0;i<30;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();} if(refs.some(weak=>weak.deref()!==undefined))throw Error('factory or pending cleanup retained a cycle'); })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result=spawnSync(process.execPath,['--expose-gc','-e',script,addon],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr || String(result.error));
});
