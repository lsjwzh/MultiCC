'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const legacy = require('./helpers/legacy-task-display-attribution');
const addon = require('../src/native/runtime').getNative();
const native = { taskFields: addon.taskDisplayFields, displayTask: addon.taskDisplayTask,
  displayMessages: addon.taskDisplayMessages };

test('registry codes use JS coercion, Unicode uppercase and exactly four ASCII alphanumerics', () => {
  const symbol = Symbol('key');
  const task = Object.freeze({ id: 't', taskShortCode: 'old', [symbol]: { nested: true } });
  for (const value of [null, 0, false, 1234, 1234n, Symbol('code'), '\uFEFFa1b2\u00A0', ' ßa2 ',
    'ß', 'ＡBCD', '0ab_', 'abcde', '\ud800abc', { toString: () => '1abc' }]) {
    const codeFor = id => { assert.equal(id, 't'); return value; };
    assert.deepEqual(native.taskFields(task, codeFor), legacy.taskFields(task, codeFor));
    const expected = legacy.displayTask(task, codeFor);
    const actual = native.displayTask(task, codeFor);
    assert.deepEqual(actual, expected);
    assert.equal(actual === task, expected === task);
    assert.equal(actual[symbol], task[symbol]);
  }
  for (const value of [undefined, null, 0, false, '', () => {}, { id: 0 }, {}]) {
    const unused = () => assert.fail('registry must not run');
    assert.deepEqual(native.taskFields(value, unused), legacy.taskFields(value, unused));
    assert.equal(native.displayTask(value, unused), value);
  }
});

test('message attribution matches fallback, sparse map, getter and callback order', () => {
  function run(api) {
    const trace = [];
    const tracked = (name, fields) => new Proxy(fields, {
      get(target, key, receiver) { trace.push(name + '.' + String(key)); return Reflect.get(target, key, receiver); },
    });
    const fallback = tracked('fallback', { id: 'current', title: 'Current' });
    const source = tracked('source', { title: 'Source' });
    const unchanged = { taskId: 'invalid' };
    const rows = [tracked('named', { taskId: 'other', taskName: 'Explicit' }), , {}, { taskId: 'other' },
      { taskId: 'orphan' }, unchanged, null, 1];
    const out = api.displayMessages(rows, fallback, tracked('options', {
      getTask(id) { trace.push('lookup ' + id); return id === 'other' ? source : null; },
      codeFor(id) { trace.push('code ' + id); return id === 'invalid' ? 'x' : ' a1b2 '; },
    }));
    assert.equal(out[5], unchanged);
    assert.equal(1 in out, false);
    assert.deepEqual(rows[2], {});
    return { out, trace };
  }
  assert.deepEqual(run(native), run(legacy));
});

test('projection short circuits and propagates the original lookup, registry and spread errors', () => {
  for (const api of [legacy, native]) {
    const marker = new Error('lookup failed');
    const fail = () => { throw marker; };
    for (const rows of [null, {}, [], 'input']) {
      assert.equal(api.displayMessages(rows), rows);
      assert.equal(api.displayMessages(rows, null, { getTask: fail, codeFor: false }), rows);
    }
    assert.deepEqual(api.displayMessages('input', null, { codeFor: fail }), []);
    assert.throws(() => api.displayMessages([], {}, null), TypeError);
    for (const options of [{ getTask: fail, codeFor: assert.fail }, { codeFor: fail }]) {
      assert.throws(() => api.displayMessages([{ taskId: 1 }], {}, options), error => error === marker);
    }
    const message = { taskId: 1, get field() { return fail(); } };
    assert.throws(() => api.displayMessages([message], null, { codeFor: () => 'abcd' }), error => error === marker);
    assert.equal(api.displayMessages([message], null, { codeFor: () => 'bad' })[0], message);
    assert.throws(() => api.displayTask({ get id() { return fail(); } }), error => error === marker);
    assert.throws(() => api.displayMessages([{}], null, { getTask: null, codeFor: fail }), TypeError);
  }
});

test('an array can retain its mapper and access the original live task after the call', () => {
  for (const api of [legacy, native]) {
    const rows = [];
    rows.map = mapper => mapper;
    const fallback = { id: 't', title: 'before' };
    const mapper = api.displayMessages(rows, fallback, { codeFor: () => 'abcd' });
    fallback.title = 'after';
    assert.deepEqual(mapper({}), { taskId: 't', taskName: 'after', taskShortCode: 'ABCD' });
    assert.equal(mapper(), undefined);
  }
});

test('board response, task-shell detail and explicit task entry use registry display codes', async t => {
  const codeFor = () => ' a0b2 ';
  const { mkRuntime } = require('./helpers/task-board-runtime');
  const board = mkRuntime({ taskShortCode: codeFor });
  t.after(() => fs.rmSync(path.dirname(board.file), { recursive: true, force: true }));
  const { createPendingTask } = require('../src/task-board/core');
  const card = createPendingTask(board.runtime.getBoard(), { taskId: 'task-display', sessionId: 'sess-1',
    dirId: 'dir-1', taskText: 'Display code', now: 1 });
  let response;
  await board.runtime.routePorts.status({ taskId: card.id, body: { status: 'done' } }, {
    status() { return this; }, json(body) { response = body; },
  });
  assert.equal(response.task.taskShortCode, 'A0B2');
  assert.equal(card.taskShortCode, undefined);

  const { fixture } = require('./helpers/task-shell');
  const f = fixture(t, { taskShortCode: codeFor });
  const task = f.runtime.adopt(f.a.id, 'a');
  f.histories.set(task.sessionId, [{ id: 'm', role: 'user', content: 'hello' }]);
  for (const detail of [await f.runtime.detail(f.a.id, task.id), await f.runtime.taskEntry(task.id)]) {
    assert.equal(detail.task.taskShortCode, 'A0B2');
    assert.equal(detail.messages[0].taskId, task.id);
    assert.equal(detail.messages[0].taskShortCode, 'A0B2');
  }
  assert.equal(f.store.get('task', task.id).taskShortCode, undefined);
});
