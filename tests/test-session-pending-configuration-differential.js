'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const legacy = require('./helpers/session-pending-configuration-oracle');
const { getNative, assignHostProperty } = require('../src/native/binding');
const native = {
  readConfiguration: (...args) => getNative().sessionPendingReadConfiguration(...args),
  desiredSession: session => getNative().sessionPendingDesiredSession(session, assignHostProperty),
  configurationBusy: (...args) => getNative().sessionPendingConfigurationBusy(...args),
  stageConfiguration: (session, draft, options) => getNative().sessionPendingStageConfiguration(session, draft, options, assignHostProperty),
};
function outcome(fn) {
  try { return { value: fn() }; }
  catch (error) { return { error: { name: error?.name, message: error?.message, code: error?.code } }; }
}
function compare(build, method) {
  const result = [];
  for (const impl of [legacy, native]) {
    const trace = [];
    const args = build(trace);
    const answer = outcome(() => impl[method](...args));
    if (method === 'stageConfiguration' && answer.value && typeof answer.value === 'object') {
      assert.equal(answer.value, args[0].pendingConfiguration);
      answer.value = { ...answer.value, updatedAt: '<time>' };
    }
    result.push({ answer, trace: trace.filter(k => !/(?:^|:)(?:claudeWorkflow|preferSubtasks)$/.test(k)) });
  }
  assert.deepEqual(result[1], result[0]);
}

test('field order and frozen exported field list', () => {
  const actual = getNative().sessionPendingConfigurationFields();
  assert.deepEqual(actual, [...legacy.CONFIG_FIELDS, 'claudeWorkflow', 'preferSubtasks']);
  assert.equal(Object.isFrozen(actual), true);
});

test('独立开关排队到下一轮并保留显式关闭', () => {
  const session = {};
  native.stageConfiguration(session, { cli: 'claude', effort: 'medium', claudeWorkflow: true, preferSubtasks: false }, {});
  const desired = native.desiredSession(session);
  assert.equal(desired.effort, 'medium');
  assert.equal(desired.claudeWorkflow, true);
  assert.equal(desired.preferSubtasks, false);
});

test('readConfiguration preserves cloning, defaults, errors and access order', () => {
  const samples = [
    () => [{}], () => [null], () => [undefined], () => [3],
    () => [{ provider: 'a', model: { m: '中', a: [1, undefined] }, effort: false }],
    () => [{ provider: 1n }], () => [{ provider: Symbol('x') }],
    trace => [new Proxy({ provider: 'p', model: 'm' }, { get(o,k,r) { trace.push(String(k)); return Reflect.get(o,k,r); } })],
    trace => [Object.defineProperty({}, 'effort', { get() { trace.push('throws'); throw new TypeError('getter failed'); } })],
    () => { const value={};value.self=value;return [{ provider:value }]; },
  ];
  for (const make of samples) compare(make, 'readConfiguration');
});

test('desiredSession re-reads the pending object in original order', () => {
  compare(() => [{ cli: 'claude', model: 'a' }], 'desiredSession');
  compare(() => [{ cli:'claude', pendingConfiguration:{ cli:'codex', profile:{ model:'m', provider:null } } }], 'desiredSession');
  compare(trace => {
    let reads=0;
    const obj={ cli:'claude', toJSON() { trace.push('json'); return { cli:this.cli }; } };
    Object.defineProperty(obj,'pendingConfiguration',{get(){ trace.push(`pending${++reads}`);return { cli:'codex', profile:{model:'m'} }; }});
    return [obj];
  }, 'desiredSession');
  for (const value of [null, undefined, 7, 1n]) compare(() => [value], 'desiredSession');
  compare(() => [{ toJSON() { return 3; }, pendingConfiguration: { cli:'codex', profile:{} } }], 'desiredSession');
});

test('stageConfiguration preserves defaults, getter order and errors', () => {
  const make = (options, withOption = true) => trace => {
    const session = new Proxy({}, { set(o,k,v,r) { trace.push(`set:${String(k)}`); return Reflect.set(o,k,v,r); }, get(o,k,r) { if(k==='pendingConfiguration') trace.push('get:pending'); return Reflect.get(o,k,r); } });
    const draft = new Proxy({ cli:'codex', model:'m' }, { get(o,k,r) { trace.push(`draft:${String(k)}`); return Reflect.get(o,k,r); } });
    return withOption ? [session,draft,options] : [session,draft];
  };
  compare(make(undefined,false),'stageConfiguration');
  compare(make({fresh:true}),'stageConfiguration');
  compare(make({fresh:undefined}),'stageConfiguration');
  compare(make(null),'stageConfiguration');
  compare(() => [{},null], 'stageConfiguration');
  compare(() => [null,{cli:'claude'}], 'stageConfiguration');
  compare(() => [1,{cli:'claude'}], 'stageConfiguration');
  compare(() => ['x',{cli:'claude'}], 'stageConfiguration');
  compare(() => [Object.freeze({}),{cli:'claude'}], 'stageConfiguration');
  compare(() => [Object.freeze({pendingConfiguration:0}),{cli:'claude'}], 'stageConfiguration');
  compare(() => [new Proxy({}, {set(){ return false; }}),{cli:'claude'}], 'stageConfiguration');
});

function deps(trace, options={}) {
  const inner = {
    getChatState(id) { trace.push(`chat:${id}`); if(options.chatThrows) throw Error('chat'); return options.chat; },
    getChatStream() { trace.push('stream'); if(options.streamThrows) throw Error('stream'); return options.stream; },
    getPreparation(id) { trace.push(`prepare:${id}`); return options.preparation; },
    hasLiveBackgroundTasks(id) { trace.push(`background:${id}`); return options.background; },
  };
  return new Proxy(inner, { get(o,k,r) { trace.push(`dep:${String(k)}`); if(options.depThrows===k) throw Error('dep'); return Reflect.get(o,k,r); } });
}
test('configurationBusy keeps destructuring, short-circuit, callbacks and coercion order', () => {
  const scenarios = [
    {}, { chat:{isStreaming:true} }, { preparation:{phase:'preparing'} },
    { preparation:{phase:'running'} }, { stream:{status(){ return {busy:true}; }} },
    { stream:{status(){ return {queued:'2'}; }} }, { stream:{status(){ return {queued:1n}; }} },
    { stream:{status(){ return {queued:Symbol('q')}; }} },
    { stream:{status(){ return {queued:{ [Symbol.toPrimitive](hint) { assert.equal(hint,'number'); return 2; } }}; }} }, { background:true },
    { chatThrows:true }, { streamThrows:true }, { depThrows:'getPreparation' },
  ];
  for (const options of scenarios) compare(trace => ['s',deps(trace,options)], 'configurationBusy');
  compare(() => ['s'], 'configurationBusy');
  compare(() => ['s',null], 'configurationBusy');
});

test('JSON methods are looked up and called in the same order', () => {
  const original = global.JSON;
  try {
    compare(trace => {
      global.JSON = {
        get parse() { trace.push('get:parse'); return function(v) { trace.push(`call:parse:${this===global.JSON}`); return original.parse(v); }; },
        get stringify() { trace.push('get:stringify'); return function(v) { trace.push(`call:stringify:${this===global.JSON}`); return original.stringify(v); }; },
      };
      return [{ provider:'p' }];
    }, 'readConfiguration');
  } finally { global.JSON=original; }
});

test('property and dependency getter exceptions retain original identity', () => {
  for (const impl of [legacy, native]) {
    const marker = new Error('same object');
    const session = Object.defineProperty({}, 'effort', { get() { throw marker; } });
    assert.throws(() => impl.readConfiguration(session), error => error === marker);
    const ports = Object.defineProperty({}, 'getChatState', { get() { throw marker; } });
    assert.throws(() => impl.configurationBusy('s', ports), error => error === marker);
    const pending = { toJSON() { return {}; } };
    Object.defineProperty(pending, 'pendingConfiguration', { get() { throw marker; } });
    assert.throws(() => impl.desiredSession(pending), error => error === marker);
    const options = Object.defineProperty({}, 'fresh', { get() { throw marker; } });
    assert.throws(() => impl.stageConfiguration({}, {}, options), error => error === marker);
  }
});

test('strict assignment preserves proxy traps and the original thrown value', () => {
  for (const impl of [legacy, native]) {
    const marker = new Error('setter failed');
    const session = new Proxy({}, { set() { throw marker; } });
    assert.throws(() => impl.stageConfiguration(session, {cli:'claude'}), error => error === marker);
  }
  compare(trace => [new Proxy({}, {
    set() { trace.push('set'); return false; },
    isExtensible() { trace.push('unexpected:isExtensible'); return true; },
    getOwnPropertyDescriptor() { trace.push('unexpected:descriptor'); return undefined; },
  }), {cli:'claude'}], 'stageConfiguration');
});
