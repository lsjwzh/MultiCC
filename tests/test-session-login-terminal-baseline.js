'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const implementations = [
  require('./helpers/legacy-session-login-terminal'),
  require('../src/session/login-terminal'),
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
