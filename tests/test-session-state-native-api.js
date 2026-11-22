'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { getNative } = require('../src/native/runtime');
const frozen = require('./helpers/legacy-session-state-binding');
const makeApi = () => getNative().sessionStateApi();

function outcome(operation) {
  try { return { value: operation() }; }
  catch (error) { return { error: error.constructor.name, message: error.message }; }
}

test('native session namespace retains real mutable Sets, names and frozen service identities', () => {
  const api = makeApi();
  assert.deepEqual(Object.keys(api), Object.keys(frozen));
  for (const key of ['RUNNING_STATUSES', 'SESSION_STATUSES']) {
    assert.ok(api[key] instanceof Set);
    assert.deepEqual([...api[key]], [...frozen[key]]);
    assert.equal(Object.isFrozen(api[key]), false);
  }
  for (const key of Object.keys(api).filter(key => typeof api[key] === 'function')) {
    assert.equal(api[key].name, frozen[key].name);
    assert.equal(api[key].length, frozen[key].length);
  }
  api.RUNNING_STATUSES.delete('thinking');
  api.RUNNING_STATUSES.add('invented');
  assert.equal(api.isRunningStatus('thinking'), frozen.isRunningStatus('thinking'));
  assert.equal(api.isRunningStatus('invented'), frozen.isRunningStatus('invented'));
  const service = api.createSessionStateService();
  assert.ok(Object.isFrozen(service));
  assert.equal(service.initial, api.initialSessionState);
  assert.deepEqual(Object.keys(service), ['initial', 'transition']);
  assert.equal(service.transition.name, 'transition');
  assert.equal(service.transition.length, 3);
  const initial = service.initial();
  assert.ok(Object.isFrozen(initial));
  assert.deepEqual(initial, frozen.initialSessionState());
});

test('native default parameters and primitive/null options match the frozen binding', t => {
  const original = Date.now;
  Date.now = () => 100;
  t.after(() => { Date.now = original; });
  const api = makeApi();
  for (const options of [undefined, null, false, 0, '', 'value', Symbol('options'), 1n, [], {}]) {
    assert.deepEqual(outcome(() => api.transitionSessionState(null, undefined, options)),
      outcome(() => frozen.transitionSessionState(null, undefined, options)));
    const shape = module => outcome(() => {
      const service = module.createSessionStateService(options);
      return { frozen: Object.isFrozen(service), initial: service.initial(), value: service.transition('s', null) };
    });
    assert.deepEqual(shape(api), shape(frozen));
  }
  for (const options of [{ clock: null }, { hasPendingWork: false }, { clock: 1, hasPendingWork: null }]) {
    assert.deepEqual(outcome(() => api.createSessionStateService(options)),
      outcome(() => frozen.createSessionStateService(options)));
  }
});

test('native service captures the default clock and preserves fallback and callback receivers', t => {
  const original = Date.now;
  t.after(() => { Date.now = original; });
  const exercise = module => {
    const reads = [];
    Date.now = () => 120;
    const captured = module.createSessionStateService();
    Date.now = () => 150;
    const first = captured.transition('s', null);
    Date.now = function () { reads.push(['default-now', this === Date]); return 200; };
    const service = module.createSessionStateService({
      clock() { reads.push(['clock', this === undefined]); return undefined; },
      hasPendingWork(id) { reads.push(['pending', this === undefined, id]); return { opaque: true }; },
    });
    const previous = { get status() { reads.push(['status']); return 'idle'; } };
    return { first, result: service.transition('session-id', previous, { status: 'succeeded' }), reads };
  };
  assert.deepEqual(exercise(makeApi()), exercise(frozen));
});

test('native public options evaluate defaults once and before state getters', t => {
  const original = Date.now;
  t.after(() => { Date.now = original; });
  const exercise = module => {
    const reads = [];
    Date.now = () => { reads.push('default-now'); return undefined; };
    const options = {
      get now() { reads.push('now'); return undefined; },
      get pendingWork() { reads.push('pending'); return false; },
    };
    const previous = { get status() { reads.push('status'); return 'idle'; } };
    return { result: outcome(() => module.transitionSessionState(previous, undefined, options)), reads };
  };
  assert.deepEqual(exercise(makeApi()), exercise(frozen));
});

test('native options read only selected getters and preserve error precedence', () => {
  const marker = new Error('pending getter');
  const exercise = module => {
    const reads = [];
    const options = new Proxy({}, {
      ownKeys() { throw new Error('must not enumerate options'); },
      get(_target, key) {
        reads.push(key);
        if (key === 'clock') return null;
        if (key === 'hasPendingWork') throw marker;
        throw new Error('unexpected option');
      },
    });
    let caught;
    try { module.createSessionStateService(options); } catch (error) { caught = error; }
    assert.equal(caught, marker);
    return reads;
  };
  assert.deepEqual(exercise(makeApi()), exercise(frozen));
  for (const thrown of [new Error('clock'), Symbol('clock'), { opaque: 'clock' }, null, undefined]) {
    for (const module of [makeApi(), frozen]) {
      const service = module.createSessionStateService({ clock() { throw thrown; },
        hasPendingWork() { assert.fail('pendingWork must not run after clock throws'); } });
      let caught; let failed = false;
      try { service.transition('s', null); } catch (error) { failed = true; caught = error; }
      assert.equal(failed, true);
      assert.equal(caught, thrown);
      const reads = [];
      const pendingFailure = module.createSessionStateService({ clock() { reads.push('clock'); return 100; },
        hasPendingWork() { reads.push('pending'); throw thrown; } });
      failed = false;
      try { pendingFailure.transition('s', { get status() { assert.fail('state must not be read after pendingWork throws'); } }); }
      catch (error) { failed = true; caught = error; }
      assert.equal(failed, true);
      assert.equal(caught, thrown);
      assert.deepEqual(reads, ['clock', 'pending']);
    }
  }
});

test('native callback reentry preserves the nested call order and result', () => {
  const exercise = module => {
    const reads = []; let service; let nested; let inside = false;
    service = module.createSessionStateService({
      clock() {
        reads.push('clock');
        if (!inside) { inside = true; nested = service.transition('inner', null, { status: 'running' }); return 100; }
        return 50;
      },
      hasPendingWork(id) { reads.push(id); return id === 'outer'; },
    });
    const result = service.transition('outer', null, { status: 'succeeded' });
    return { reads, nested, result };
  };
  assert.deepEqual(exercise(makeApi()), exercise(frozen));
});

test('native callback cycles remain collectible and the child exits naturally', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict');
    const api = require(${JSON.stringify(require.resolve('../src/native/runtime'))}).getNative().sessionStateApi();
    const weak = [];
    for (let i = 0; i < 20; i++) {
      const holder = {};
      holder.service = api.createSessionStateService({ clock: () => holder.service ? 100 : 0,
        hasPendingWork: () => !!holder.service });
      weak.push(new WeakRef(holder));
    }
    (async () => {
      for (let i = 0; i < 64; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(weak.filter(reference => reference.deref() === undefined).length, 20);
      console.log('collected 20 callback cycles');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: 'utf8', timeout: 20_000, env: process.env });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /collected 20 callback cycles/);
});
