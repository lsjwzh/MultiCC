'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { deriveToolTiming, diffToolTiming, deriveOpenTasks } = require('../src/chat/turn-event-replay');

// Journal-line helpers: the derivation consumes {seq, ts, event} records.
const line = (seq, ts, event) => ({ seq, ts, event });
const toolUse = (id, name, input) => line(0, 0, {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input: input || {} }] },
});
const toolResult = (id, isError) => line(0, 0, {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: !!isError }] },
});

test('derives measured timing for opened-and-closed tools from line timestamps', () => {
  const tools = deriveToolTiming([
    toolUse('t1', 'Bash'),
    line(2, 5_000, { type: 'assistant', message: { content: [] } }),
    toolResult('t1'),
  ].map((r, i) => ({ ...r, seq: i + 1, ts: (i + 1) * 1000 })));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Bash');
  assert.equal(tools[0].startedAt, 1000);
  assert.equal(tools[0].endedAt, 3000);
  assert.equal(tools[0].isError, false);
});

test('a tool without a result derives as running (endedAt null), never fabricated', () => {
  const tools = deriveToolTiming([
    { ...toolUse('t1', 'Read'), ts: 1_000 },
    { ...toolUse('t2', 'Bash'), ts: 2_000 },
    { ...toolResult('t1'), ts: 5_000 },
  ]);
  assert.equal(tools[1].endedAt, null);
  assert.equal(tools[1].isError, false);
});

test('error flags and duplicate blocks collapse to the first sighting', () => {
  const tools = deriveToolTiming([
    { ...toolUse('t1', 'Bash'), ts: 1_000 },
    { ...toolUse('t1', 'Bash'), ts: 9_000 }, // replay/duplicate broadcast
    { ...toolResult('t1', true), ts: 4_000 },
    { ...toolResult('t1', true), ts: 8_000 },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].startedAt, 1_000);
  assert.equal(tools[0].endedAt, 4_000);
  assert.equal(tools[0].isError, true);
});

test('orphan tool_results (no journal witness of the tool_use) are ignored', () => {
  const tools = deriveToolTiming([{ ...toolResult('ghost'), ts: 1_000 }]);
  assert.deepEqual(tools, []);
});

test('stub lines (oversized payloads journaled as type-only) do not crash derivation', () => {
  const tools = deriveToolTiming([
    { seq: 1, ts: 1_000, event: { type: 'assistant', journaled: 'stub', payloadBytes: 40_000 } },
    { ...toolUse('t1', 'Read'), seq: 2, ts: 2_000 },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Read');
});

test('diffToolTiming reports empty for a faithful blob within tolerance', () => {
  const derived = [
    { id: 't1', name: 'Bash', startedAt: 1_000, endedAt: 4_000, isError: false },
    { id: 't2', name: 'Read', startedAt: 5_000, endedAt: null, isError: false },
  ];
  const blob = [
    { id: 't1', name: 'Bash', startedAt: 1_010, endedAt: 3_990, is_error: false },
    { id: 't2', name: 'Read', startedAt: 5_010 },
  ];
  assert.deepEqual(diffToolTiming(derived, blob), []);
});

test('diffToolTiming flags drift, fabrication, loss, and error mismatch', () => {
  const derived = [
    { id: 't1', name: 'Bash', startedAt: 1_000, endedAt: 4_000, isError: true },
    { id: 't2', name: 'Read', startedAt: 5_000, endedAt: null, isError: false }, // missing from blob
  ];
  const blob = [
    { id: 't1', name: 'bash', startedAt: 90_000, endedAt: 4_000, is_error: false }, // name+start drift
    { id: 't2x', name: 'Ghost', startedAt: 1_000 }, // never journaled
    // t2 missing entirely
  ];
  const kinds = diffToolTiming(derived, blob).map(m => m.kind).sort();
  assert.deepEqual(kinds, [
    'isError_mismatch',
    'missing_from_blob',
    'missing_from_journal',
    'name_mismatch',
    'startedAt_drift',
  ].sort());
});

test('diffToolTiming flags a blob end for a tool the journal still shows running', () => {
  const derived = [{ id: 't1', name: 'Bash', startedAt: 1_000, endedAt: null, isError: false }];
  const blob = [{ id: 't1', name: 'Bash', startedAt: 1_000, endedAt: 2_000 }];
  assert.deepEqual(diffToolTiming(derived, blob).map(m => m.kind), ['endedAt_fabricated_in_blob']);
});

test('derivation covers the adapter path too (same normalized broadcast shape)', () => {
  // codex/opencode/zcode tool_start/tool_result are normalized to the same
  // assistant.tool_use / user.tool_result broadcasts before chatBroadcast.
  const tools = deriveToolTiming([
    { seq: 1, ts: 100, event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_1', name: 'shell', input: { cmd: 'ls' } }] } } },
    { seq: 2, ts: 900, event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'files', is_error: false }] } } },
  ]);
  assert.deepEqual(tools, [
    { id: 'call_1', name: 'shell', startedAt: 100, endedAt: 900, isError: false },
  ]);
});

test('deriveOpenTasks returns tasks with no terminal event, latest witness ts', () => {
  const open = deriveOpenTasks([
    { seq: 1, ts: 1_000, event: { type: 'monitor_started', task_id: 'a', description: '子任务 A', background: true } },
    { seq: 2, ts: 2_000, event: { type: 'monitor_started', task_id: 'b', description: 'Monitor x', background: true } },
    { seq: 3, ts: 3_000, event: { type: 'monitor_progress', task_id: 'a', status: 'running', background: true } },
    { seq: 4, ts: 4_000, event: { type: 'monitor_done', task_id: 'b', status: 'completed', background: true } },
    { seq: 5, ts: 5_000, event: { type: 'background_tasks', tasks: [{ task_id: 'a', status: 'running' }] } },
  ]);
  // b closed; a survived to the journal cutoff — exactly what a restart killed.
  assert.deepEqual(open, [
    { task_id: 'a', description: '子任务 A', lastTs: 5_000 },
  ]);
});

test('deriveOpenTasks is robust to repeats, orphans, and empty input', () => {
  assert.deepEqual(deriveOpenTasks([]), []);
  assert.deepEqual(deriveOpenTasks(null), []);
  // Replayed started/progress must not duplicate; an orphan progress (start
  // line rotated away) is not fabricated into a task.
  const open = deriveOpenTasks([
    { seq: 1, ts: 1_000, event: { type: 'monitor_started', task_id: 'a', description: 'A' } },
    { seq: 2, ts: 9_000, event: { type: 'monitor_started', task_id: 'a', description: 'A' } },
    { seq: 3, ts: 5_000, event: { type: 'monitor_progress', task_id: 'ghost', status: 'running' } },
  ]);
  assert.deepEqual(open, [{ task_id: 'a', description: 'A', lastTs: 9_000 }]);
});

test('turn-engine replays journal open tasks on reconnect only when the live set is empty', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  assert.match(source, /deriveOpenTasks\(turnEventJournal\.readAll\(sessionName\)\)/,
    'reconnect path derives open tasks from the journal');
  assert.match(source, /activeTasks\.length === 0 && turnEventJournal/,
    'replay only when the in-memory runtime knows nothing (post-restart)');
  assert.match(source, /RECONNECT_REPLAY_WINDOW_MS/, 'replay is time-bounded');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /sendWs,\s*\n\s*turnEventJournal,/, 'server wires the journal into the turn engine');
});

// ---------------------------------------------------------------------------
// Rust migration differential.
//
// The pre-migration module is frozen as a Git blob (tests/helpers/legacy-
// turn-event-replay.js, byte-identical) and compiled from source; the current
// module must reproduce it on a fixed corpus: return shape, key order,
// descriptors, reference identity (an id reopened after a delete is the same
// object twice), property-read order and counts (scripted getters, Proxy
// traps), thrown errors (constructor + message) and the coercion rules behind
// `>` / `-` (tolerance) and Map/Set keys (SameValueZero; BigInt, Symbol and
// object ids). Every rule in the frozen source is also mutated once to prove
// the corpus observes it (a green differential without coverage proves
// nothing).
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const LEGACY_BLOB = 'eebf16010e55fe9cb51d1209882c76bacb7c0370';
const LEGACY_BYTES = fs.readFileSync(path.join(__dirname, 'helpers', 'legacy-turn-event-replay.js'));
const LEGACY_SOURCE = LEGACY_BYTES.toString('utf8');
const K = v => () => v; // corpus dimension entry: a factory evaluated per trial
const ABSENT = Symbol('absent');
const set = (o, k, v) => { if (v !== ABSENT) o[k] = v; return o; };

const MODULE_PATH = path.join(__dirname, '..', 'src', 'chat', 'turn-event-replay.js');
const currentSource = () => fs.readFileSync(MODULE_PATH, 'utf8');

// Both sides are compiled from source for every case. A long-lived JS module
// goes through V8's tiering: once one for-of site has seen two iterator
// methods (the corpus installs custom ones), its non-callable @@iterator error
// turns into "number 5 is not a function" instead of the site constant
// (logs/v8-oracle-jit-trigger.txt in the migration evidence). Freshly compiled
// code is the cold, monomorphic state the production call sites are in.
function compileModule(source, require_ = require) {
  const mod = { exports: {} };
  // The frozen source carries its own 'use strict' directive.
  new Function('module', 'exports', 'require', source)(mod, mod.exports, require_);
  return mod.exports;
}
const coldCurrent = () => compileModule(currentSource(), require('node:module').createRequire(MODULE_PATH));

function frozenSource() {
  const actual = crypto.createHash('sha1')
    .update(`blob ${LEGACY_BYTES.length}\0`).update(LEGACY_BYTES).digest('hex');
  assert.equal(actual, LEGACY_BLOB, 'tests/helpers/legacy-turn-event-replay.js must stay byte-identical to the frozen blob');
  return LEGACY_SOURCE;
}

const describeNumber = n => (Number.isNaN(n) ? 'NaN' : Object.is(n, -0) ? '-0' : String(n));

// Identity-aware view of an outcome. Corpus values registered through
// c.name() print as their label; implementation-created objects print shape +
// own property layout, and a reference seen twice keeps its first @k number.
function viewer(c) {
  const seen = new Map();
  const walk = v => {
    if (v === null) return null;
    switch (typeof v) {
      case 'undefined': return 'undefined';
      case 'number': return describeNumber(v);
      case 'string': return JSON.stringify(v);
      case 'boolean': return v;
      case 'bigint': return `${v}n`;
      default: break;
    }
    const label = c.ids.get(v);
    if (label !== undefined) return { t: typeof v, ref: label, corpus: true };
    if (typeof v === 'symbol') return { t: 'symbol', desc: String(v) };
    if (seen.has(v)) return seen.get(v);
    const ref = `@${seen.size}`;
    seen.set(v, ref);
    const array = Array.isArray(v);
    const shape = array ? 'Array'
      : Object.getPrototypeOf(v) === Object.prototype ? 'Object'
      : Object.prototype.toString.call(v);
    const own = Object.keys(v).map(k => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      const kind = typeof d.get === 'function' || typeof d.set === 'function'
        ? `accessor[e=${+d.enumerable},c=${+d.configurable}]`
        : d.writable && d.enumerable && d.configurable ? 'wec'
        : `data[w=${+d.writable},e=${+d.enumerable},c=${+d.configurable}]`;
      return [k, kind, walk(v[k])];
    });
    const hidden = Object.getOwnPropertyNames(v)
      .filter(k => !Object.prototype.propertyIsEnumerable.call(v, k) && !(array && k === 'length'));
    const symbols = Object.getOwnPropertySymbols(v).map(s => String(s));
    return { t: 'object', shape, ref, own, ...(hidden.length ? { hidden } : {}), ...(symbols.length ? { symbols } : {}) };
  };
  return walk;
}

const thrownView = (c, e) => {
  const label = c.ids.get(e);
  if (label !== undefined) return { throws: true, sentinel: label };
  if (e instanceof Error) return { throws: true, ctor: e.constructor.name, name: e.name, message: e.message };
  return { throws: true, value: viewer(c)(e) };
};

// One corpus case: fresh inputs from make(c), the call, then a deterministic
// text (outcome view + property-read trace) that legacy and current must agree
// on byte for byte.
function trial(mod, fn, make) {
  const c = {
    ids: new Map(), trace: [],
    name(value, label) { this.ids.set(value, label); return value; },
  };
  const args = make(c);
  const base = c.trace.length;
  let out;
  let end;
  try {
    const value = mod[fn](...args);
    end = c.trace.length;
    out = { ok: viewer(c)(value) };
  } catch (e) {
    end = c.trace.length;
    out = thrownView(c, e);
  }
  const trace = c.trace.slice(base, end);
  return { out, trace, text: JSON.stringify(out) + (trace.length ? `\n${trace.join('\n')}` : '') };
}

const CORPUS = [];
const add = (fn, name, make) => CORPUS.push({ fn, name, make });
const addFuzz = (fn, name, make) => FUZZ.push({ fn, name, make });
const FUZZ = []; // seeded cases: compared, but not used for the mutation check
const matrix = (list, fn, prefix, dims, build) => {
  const keys = Object.keys(dims);
  const walk = (i, chosen, label) => {
    if (i === keys.length) { list.push({ fn, name: `${prefix}:${label}`, make: c => build(c, chosen) }); return; }
    for (const [tag, factory] of dims[keys[i]]) walk(i + 1, { ...chosen, [keys[i]]: factory }, label ? `${label},${keys[i]}=${tag}` : `${keys[i]}=${tag}`);
  };
  walk(0, {}, '');
};

// Scripted getter: logs `<tag>.<key>#<n>` per read and returns values[n-1]
// (the last value sticks), so a wrong read count or order changes the trace
// and, with distinct values, the result.
const reads = (c, tag, key, ...values) => {
  let n = 0;
  return {
    enumerable: true, configurable: true,
    get() {
      n += 1;
      c.trace.push(`${tag}.${key}#${n}`);
      const v = values[Math.min(n, values.length) - 1];
      if (v !== null && typeof v === 'object' && v.throws) throw v.throws;
      return v;
    },
  };
};
const THROWS = error => ({ throws: error });
const withReads = (c, tag, props, base = {}) => {
  for (const [k, values] of Object.entries(props)) Object.defineProperty(base, k, reads(c, tag, k, ...values));
  return base;
};
const watch = (c, tag, target) => new Proxy(target, {
  get(t, k, r) { c.trace.push(`${tag}.get:${String(k)}`); return Reflect.get(t, k, r); },
  set(t, k, v, r) { c.trace.push(`${tag}.set:${String(k)}`); return Reflect.set(t, k, v, r); },
  has(t, k) { c.trace.push(`${tag}.has:${String(k)}`); return Reflect.has(t, k); },
  deleteProperty(t, k) { c.trace.push(`${tag}.delete:${String(k)}`); return Reflect.deleteProperty(t, k); },
  ownKeys(t) { c.trace.push(`${tag}.ownKeys`); return Reflect.ownKeys(t); },
  getOwnPropertyDescriptor(t, k) { c.trace.push(`${tag}.gopd:${String(k)}`); return Reflect.getOwnPropertyDescriptor(t, k); },
  defineProperty(t, k, d) { c.trace.push(`${tag}.define:${String(k)}`); return Reflect.defineProperty(t, k, d); },
  getPrototypeOf(t) { c.trace.push(`${tag}.gpo`); return Reflect.getPrototypeOf(t); },
});
const revoked = () => { const p = Proxy.revocable({ type: 'assistant' }, {}); p.revoke(); return p.proxy; };
const throwing = (c, tag, key, error) => Object.defineProperty({}, key, {
  enumerable: true, configurable: true, get() { c.trace.push(`${tag}.${key}!`); throw error; },
});

// Fixtures.
const obj = pairs => Object.fromEntries(pairs.filter(([, v]) => v !== ABSENT));
const tool = (id = 't', name = 'T', startedAt = 1000, endedAt = 2000, isError = false) =>
  obj([['id', id], ['name', name], ['startedAt', startedAt], ['endedAt', endedAt], ['isError', isError]]);
const blobTool = (id = 't', name = 'T', startedAt = 1000, endedAt = ABSENT, is_error = ABSENT, isError = ABSENT) =>
  obj([['id', id], ['name', name], ['startedAt', startedAt], ['endedAt', endedAt], ['is_error', is_error], ['isError', isError]]);
const use = (id = 't', name = 'T', ts = 1000) => ({ seq: 1, ts, event: { type: 'assistant', message: { content: [obj([['type', 'tool_use'], ['id', id], ['name', name], ['input', {}]])] } } });
const result = (id = 't', ts = 2000, is_error = false) => ({ seq: 2, ts, event: { type: 'user', message: { content: [obj([['type', 'tool_result'], ['tool_use_id', id], ['content', 'ok'], ['is_error', is_error]])] } } });
const started = (task_id = 'a', description = ABSENT, command = ABSENT, ts = 1000) =>
  ({ seq: 1, ts, event: set(set({ type: 'monitor_started', task_id }, 'description', description), 'command', command) });
const progress = (task_id = 'a', ts = 1500) => ({ seq: 2, ts, event: { type: 'monitor_progress', task_id } });
const done = (task_id = 'a', ts = 2000) => ({ seq: 3, ts, event: { type: 'monitor_done', task_id } });
const snapshot = (tasks, ts = 3000) => ({ seq: 4, ts, event: { type: 'background_tasks', tasks } });

// ---- for-of sites: broken iterables and the real iterator protocol -------
// V8 renders the "not iterable" message from the loop-head syntax, so each
// site has its own constant text; the other iterator errors are shared.
const TERNARY_NOT_ITERABLE = 'object is not iterable (cannot read property Symbol(Symbol.iterator))';
const SITES = {
  records: {
    fn: 'deriveToolTiming', notIterable: TERNARY_NOT_ITERABLE,
    element: () => use(), throwing: () => ({ get event() { throw new RangeError('body'); } }),
    wrap: (c, it) => [it],
  },
  recordsOpen: {
    fn: 'deriveOpenTasks', notIterable: TERNARY_NOT_ITERABLE,
    element: () => started(), throwing: () => ({ get event() { throw new RangeError('body'); } }),
    wrap: (c, it) => [it],
  },
  content: {
    fn: 'deriveToolTiming', notIterable: 'contentBlocks is not a function or its return value is not iterable',
    element: () => ({ type: 'tool_use', id: 't', name: 'T' }), throwing: () => ({ get type() { throw new RangeError('body'); } }),
    wrap: (c, it) => [[{ seq: 1, ts: 1, event: { type: 'assistant', message: { content: it } } }]],
  },
  tasks: {
    fn: 'deriveOpenTasks', notIterable: 'event.tasks is not iterable',
    element: () => ({ task_id: 'a' }), throwing: () => ({ get task_id() { throw new RangeError('body'); } }),
    wrap: (c, it) => [[started('a'), { seq: 2, ts: 2, event: { type: 'background_tasks', tasks: it } }]],
  },
  derived: {
    fn: 'diffToolTiming', notIterable: TERNARY_NOT_ITERABLE,
    element: () => tool(), throwing: () => ({ get id() { throw new RangeError('body'); } }),
    wrap: (c, it) => [it, [blobTool()]],
  },
  blob: {
    fn: 'diffToolTiming', notIterable: TERNARY_NOT_ITERABLE,
    element: () => blobTool(), throwing: () => ({ get id() { throw new RangeError('body'); } }),
    wrap: (c, it) => [[tool()], it],
  },
};
const nextIs = v => K(() => ({ next: v }));
const nextReturns = v => K(() => ({ next: () => v }));
const ITER_BREAKS = [
  ...[['undefined', undefined], ['null', null], ['false', false], ['5', 5], ['"s"', 's'], ['NaN', NaN], ['1n', 1n],
    ['Symbol("m")', Symbol('m')], ['{}', {}], ['[]', []]].map(([tag, v]) => [`@@iterator=${tag}`, K(v)]),
  ['method ()=>({})', K(() => ({}))],
  ['method ()=>5', K(() => 5)], ['method ()=>null', K(() => null)], ['method ()=>"s"', K(() => 's')],
  ['next=5', nextIs(5)], ['next="s"', nextIs('s')], ['next=true', nextIs(true)], ['next=false', nextIs(false)],
  ['next=null', nextIs(null)], ['next=undefined', nextIs(undefined)], ['next={}', nextIs({})], ['next=[]', nextIs([])],
  ['next=Date', nextIs(new Date(0))], ['next=Map', nextIs(new Map())], ['next=Symbol()', nextIs(Symbol('n'))],
  ['next=7n', nextIs(7n)], ['next=class', nextIs(class C {})],
  ['next()=>5', nextReturns(5)], ['next()=>-0', nextReturns(-0)], ['next()=>1e21', nextReturns(1e21)],
  ['next()=>1e-7', nextReturns(1e-7)], ['next()=>0.30000000000000004', nextReturns(0.1 + 0.2)],
  ['next()=>123456789123456780000', nextReturns(123456789123456780000)], ['next()=>NaN', nextReturns(NaN)],
  ['next()=>Infinity', nextReturns(Infinity)], ['next()=>-Infinity', nextReturns(-Infinity)],
  ['next()=>"s"', nextReturns('s')], ['next()=>"a\\nb"', nextReturns('a\nb')], ['next()=>"a\\u0000b"', nextReturns('a\0b')],
  ['next()=>true', nextReturns(true)], ['next()=>false', nextReturns(false)], ['next()=>undefined', nextReturns(undefined)],
  ['next()=>null', nextReturns(null)], ['next()=>Symbol("d")', nextReturns(Symbol('d'))], ['next()=>Symbol()', nextReturns(Symbol())],
  ['next()=>Symbol.iterator', nextReturns(Symbol.iterator)], ['next()=>7n', nextReturns(7n)], ['next()=>-7n', nextReturns(-7n)],
  ['next()=>0n', nextReturns(0n)], ['next()=>123456789012345678901234567890n', nextReturns(123456789012345678901234567890n)],
  ['next getter throws', () => ({ get next() { throw new URIError('next'); } })],
  ['done getter throws', () => ({ next() { return { get done() { throw new URIError('done'); } }; } })],
  ['value getter throws', () => ({ next() { return { done: false, get value() { throw new URIError('value'); } }; } })],
];
const withMethod = (arr, method) => Object.assign(arr, { [Symbol.iterator]: method });
function addIterableCases(prefix, site) {
  for (const [tag, factory] of ITER_BREAKS) {
    add(site.fn, `${prefix}:${tag}`, c => site.wrap(c, withMethod([site.element(c), site.element(c)], factory(c))));
  }
  // Protocols that complete: generator, hand-written iterator, trailing
  // undefined element, Proxy-wrapped array (traps traced).
  add(site.fn, `${prefix}:generator`, c => site.wrap(c, withMethod([site.element(c), site.element(c)], function* () { yield this[0]; yield this[1]; })));
  add(site.fn, `${prefix}:custom`, c => site.wrap(c, withMethod([site.element(c), site.element(c)], function () {
    const a = this;
    let n = 0;
    return { next: () => (n < 3 ? { done: false, value: a[n++] } : { done: true }) };
  })));
  add(site.fn, `${prefix}:proxy`, c => site.wrap(c, watch(c, 'iter', [site.element(c), site.element(c)])));
  add(site.fn, `${prefix}:generator-throws`, c => site.wrap(c, withMethod([site.element(c)], function* () { yield this[0]; throw new EvalError('gen'); })));
  // Body throws: V8's for-of calls return() best-effort and always propagates
  // the original error (no TypeError for a non-object return, a throwing
  // return() or return getter never replaces it); nothing runs on completion.
  const body = method => c => site.wrap(c, withMethod([site.throwing()], method(c)));
  const once = extra => function () {
    const a = this;
    let n = 0;
    return Object.assign({ next: () => (n++ ? { done: true } : { done: false, value: a[0] }) }, extra);
  };
  add(site.fn, `${prefix}:return-on-throw`, body(c => once({ return() { c.trace.push('iter.return'); return {}; } })));
  add(site.fn, `${prefix}:return-throws-on-throw`, body(() => once({ return() { throw new SyntaxError('ret'); } })));
  add(site.fn, `${prefix}:return-getter-throws-on-throw`, body(() => once({ get return() { throw new SyntaxError('retget'); } })));
  add(site.fn, `${prefix}:return-non-callable-on-throw`, body(() => once({ return: 5 })));
  add(site.fn, `${prefix}:return-undefined-on-throw`, body(() => once({ return: undefined })));
  add(site.fn, `${prefix}:finally-on-throw`, body(c => function* () { try { yield this[0]; } finally { c.trace.push('iter.finally'); } }));
}
for (const [prefix, site] of Object.entries(SITES)) addIterableCases(`ITER.${prefix}`, site);

// ---- deriveToolTiming -----------------------------------------------------
// ids: every truthy kind is a SameValueZero Map key passed through by
// reference; falsy ids never open a tool.
{
  const zoo = [
    ...['t1', 'a b', '1', 'constructor', '__proto__', 'toString'].map(s => [`'${s}'`, K(s)]),
    ['1n', K(1n)], ['2n', K(2n)], ['123456789012345678901234567890n', K(123456789012345678901234567890n)],
    ['Symbol', c => c.name(Symbol('s'), 'idSym')], ['Symbol.for', c => c.name(Symbol.for('k'), 'idSymFor')],
    ['object', c => c.name({ tag: 'key' }, 'idObj')], ['function', c => c.name(() => 'id', 'idFn')],
    ['boxed', c => c.name(new Number(3), 'idBox')],
  ];
  matrix(CORPUS, 'deriveToolTiming', 'DT.id', { id: zoo }, (c, { id }) => {
    const v = id(c);
    return [[use(v), result(v), use(v, 'dup', 3000), result(v, 4000, true)]];
  });
  for (const [tag, v] of [['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['-0', -0], ['NaN', NaN], ["''", ''], ['0n', 0n]]) {
    add('deriveToolTiming', `DT.falsy-id:${tag}`, () => [[use(v), result('x')]]);
  }
  add('deriveToolTiming', 'DT.absent-id', () => [[{ seq: 1, ts: 1, event: { type: 'assistant', message: { content: [obj([['type', 'tool_use'], ['name', 'T']])] } } }]]);

  const NAMES = [
    ['absent', K(ABSENT)], ['undefined', K(undefined)], ['null', K(null)], ["''", K('')], ['0', K(0)], ['-0', K(-0)], ['1', K(1)],
    ['NaN', K(NaN)], ['1n', K(1n)], ['Bash', K('Bash')], ['true', K(true)], ['false', K(false)],
    ['symbol', c => c.name(Symbol('n'), 'nameSym')], ['object', c => c.name({ n: 1 }, 'nameObj')], ['function', c => c.name(() => 'n', 'nameFn')],
  ];
  matrix(CORPUS, 'deriveToolTiming', 'DT.name', { name: NAMES }, (c, { name }) => [[use('t', name(c)), result('t')]]);

  const TS = [
    ['absent', K(ABSENT)], ['undefined', K(undefined)], ['null', K(null)], ['0', K(0)], ['-0', K(-0)], ['NaN', K(NaN)],
    ['1e21', K(1e21)], ['str', K('str')], ['1n', K(1n)], ['Infinity', K(Infinity)], ['-Infinity', K(-Infinity)], ['1.5', K(1.5)],
    ['true', K(true)], ['symbol', c => c.name(Symbol('ts'), 'tsSym')], ['object', c => c.name({ ts: 1 }, 'tsObj')],
  ];
  matrix(CORPUS, 'deriveToolTiming', 'DT.ts', { start: TS, end: TS.slice(0, 8) }, (c, { start, end }) => [[use('t', 'T', start(c)), result('t', end(c))]]);
}
// Journal line / event shapes (shared by both derivations).
const SHAPES = [
  ['null', K(null)], ['undefined', K(undefined)], ['0', K(0)], ['-0', K(-0)], ['NaN', K(NaN)], ["''", K('')], ['false', K(false)], ['true', K(true)],
  ['5', K(5)], ['str', K('str')], ['1n', K(1n)], ['{}', K({})],
  ['symbol', c => c.name(Symbol('r'), 'recSym')], ['function', c => c.name(() => 1, 'recFn')],
  ['event=undefined', K({ event: undefined })], ['event=null', K({ event: null })], ['event=0', K({ event: 0 })], ["event=''", K({ event: '' })],
  ['event=false', K({ event: false })], ['event=NaN', K({ event: NaN })], ['event=5', K({ event: 5 })], ['event=str', K({ event: 'str' })],
  ['event=true', K({ event: true })], ['event=1n', K({ event: 1n })],
  ['event=symbol', c => ({ event: c.name(Symbol('e'), 'evSym') })], ['event=function', c => ({ event: c.name(() => 1, 'evFn') })],
  ['event={type:assistant}', K({ event: { type: 'assistant' } })],
  ['message=null', K({ event: { type: 'assistant', message: null } })], ['message=0', K({ event: { type: 'assistant', message: 0 } })],
  ['message=str', K({ event: { type: 'assistant', message: 'str' } })], ["message=''", K({ event: { type: 'assistant', message: '' } })],
  ['message=true', K({ event: { type: 'assistant', message: true } })], ['message=1n', K({ event: { type: 'assistant', message: 1n } })],
  ['message=symbol', c => ({ event: { type: 'assistant', message: c.name(Symbol('m'), 'msgSym') } })],
  ['message=function', c => ({ event: { type: 'assistant', message: c.name(() => 1, 'msgFn') } })],
  ['content=null', K({ event: { type: 'assistant', message: { content: null } } })],
  ['content=5', K({ event: { type: 'assistant', message: { content: 5 } } })],
  ['content=str', K({ event: { type: 'assistant', message: { content: 'str' } } })],
  ['content=arraylike', K({ event: { type: 'assistant', message: { content: { length: 1, 0: { type: 'tool_use', id: 'x' } } } } })],
  ['content=[]', K({ event: { type: 'assistant', message: { content: [] } } })],
  ['content=sparse', K({ event: { type: 'assistant', message: { content: [, { type: 'tool_use', id: 'x' }] } } })],
];
matrix(CORPUS, 'deriveToolTiming', 'DT.record', { record: SHAPES }, (c, { record }) => [[record(c), use('t')]]);
matrix(CORPUS, 'deriveOpenTasks', 'OT.record', { record: SHAPES }, (c, { record }) => [[record(c), started('a')]]);
{
  const CONTAINERS = [
    ['null', K(null)], ['undefined', K(undefined)], ['5', K(5)], ['str', K('str')], ['true', K(true)], ['1n', K(1n)],
    ['symbol', c => c.name(Symbol('c'), 'contSym')], ['{}', K({})], ['arraylike', K({ length: 1, 0: use() })], ['[]', K([])],
    ['new Array(0)', K(new Array(0))], ['[,]', K([,])], ['[,]rec', K([, use()])], ['rec,,rec', K([use('a'), , use('b')])],
    ['rec,undefined,null', K([use('a'), undefined, null])], ['frozen', K(Object.freeze([use()]))],
  ];
  matrix(CORPUS, 'deriveToolTiming', 'DT.records', { records: CONTAINERS }, (c, { records }) => [records(c)]);
  matrix(CORPUS, 'deriveOpenTasks', 'OT.records', { records: CONTAINERS }, (c, { records }) => [records(c)]);
  for (const fn of ['deriveToolTiming', 'deriveOpenTasks']) {
    const tag = fn === 'deriveToolTiming' ? 'DT' : 'OT';
    const good = fn === 'deriveToolTiming' ? [use('a', 'A'), result('a')] : [started('a'), progress('a')];
    add(fn, `${tag}.records:proxy`, c => [watch(c, 'records', good)]);
    add(fn, `${tag}.records:proxy-get-throws`, c => [new Proxy([good[0]], { get(t, k) { throw new RangeError(`records get ${String(k)}`); } })]);
    add(fn, `${tag}.records:revoked`, c => [c.name(revoked(), 'rp')]);
  }
  const BLOCKS = [
    ...SHAPES.slice(0, 12).map(([tag, f]) => [tag, f]),
    ['{}+id', K({ id: 'x' })], ['tool_use-no-id', K({ type: 'tool_use' })], ['tool_use-empty-id', K({ type: 'tool_use', id: '' })],
    ['Tool_use', K({ type: 'Tool_use', id: 'x' })], ['type=[tool_use]', K({ type: ['tool_use'], id: 'x' })],
    ['type={toString}', K({ type: { toString() { return 'tool_use'; } }, id: 'x' })],
    ['type=symbol', c => ({ type: c.name(Symbol('tool_use'), 'typeSym'), id: 'x' })],
    ['type=1n', K({ type: 1n, id: 'x' })], ['sparse', K([, { type: 'tool_use', id: 'x' }])],
  ];
  const RESULT_BLOCKS = BLOCKS.concat([
    ['tool_result-no-id', K({ type: 'tool_result' })], ['tool_result-empty-id', K({ type: 'tool_result', tool_use_id: '' })],
    ['Tool_result', K({ type: 'Tool_result', tool_use_id: 't' })], ['type=[tool_result]', K({ type: ['tool_result'], tool_use_id: 't' })],
    ['type={toString}', K({ type: { toString() { return 'tool_result'; } }, tool_use_id: 't' })],
  ]);
  matrix(CORPUS, 'deriveToolTiming', 'DT.block', { block: BLOCKS }, (c, { block }) => {
    const b = block(c);
    return [[{ seq: 1, ts: 1, event: { type: 'assistant', message: { content: Array.isArray(b) ? b : [b, { type: 'tool_use', id: 't', name: 'T' }] } } }]];
  });
  matrix(CORPUS, 'deriveToolTiming', 'DT.result-block', { block: RESULT_BLOCKS }, (c, { block }) => {
    const b = block(c);
    return [[use('t'), { seq: 2, ts: 2, event: { type: 'user', message: { content: Array.isArray(b) ? b : [b, { type: 'tool_result', tool_use_id: 't', is_error: true }] } } }]];
  });
  for (const [tag, make] of [
    ['record', c => [c.name(revoked(), 'rp')]],
    ['event', c => [{ event: c.name(revoked(), 'rp') }]],
    ['block', c => [{ event: { type: 'assistant', message: { content: [c.name(revoked(), 'rp')] } } }]],
    ['message', c => [{ event: { type: 'assistant', message: c.name(revoked(), 'rp') } }]],
  ]) add('deriveToolTiming', `DT.revoked-${tag}`, make);
  add('deriveOpenTasks', 'OT.revoked-record', c => [c.name(revoked(), 'rp')]);
  add('deriveOpenTasks', 'OT.revoked-event', c => [{ event: c.name(revoked(), 'rp') }]);
  add('deriveOpenTasks', 'OT.revoked-tasks', c => [started('a'), { event: { type: 'background_tasks', tasks: c.name(revoked(), 'rp') } }]);
}

// Read-order contracts for deriveToolTiming (scripted getters): how many
// times and in which order the legacy code reads each property is part of the
// behavior, because getters can be stateful.
{
  const content = block => ({ type: 'assistant', message: { content: [block] } });
  // event twice per processed record (guard + destructure), ts once, a
  // skipped record reads event once.
  add('deriveToolTiming', 'DT.reads:record', c => [[
    withReads(c, 'rec', { event: [content({ type: 'tool_use', id: 't', name: 'T' }), content([])], ts: [7] }, { seq: 1 }),
    withReads(c, 'rec', { event: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }, null], ts: [9] }, { seq: 2 }),
    withReads(c, 'rec', { event: [null, content([])] }),
  ]]);
  for (const [tag, values] of [['assistant', ['assistant']], ['user', ['user', 'user']], ['other', ['other', 'user']], ['second-read-matches', ['other', 'assistant']], ['second-read-user', ['x', 'user', 'assistant']]]) {
    add('deriveToolTiming', `DT.reads:type:${tag}`, c => [[{ event: withReads(c, 'ev', { type: values }, { message: { content: [{ type: 'tool_use', id: 't', name: 'T' }, { type: 'tool_result', tool_use_id: 't' }] } }) }]]);
  }
  // message twice; content is read from the second read
  add('deriveToolTiming', 'DT.reads:message', c => {
    const empty = { content: [] };
    const full = { content: [{ type: 'tool_use', id: 't', name: 'T' }] };
    return [[
      { event: withReads(c, 'ev1', { type: ['assistant'], message: [full, empty] }) },
      { event: withReads(c, 'ev2', { type: ['assistant'], message: [empty, full] }) },
      { event: withReads(c, 'ev3', { type: ['assistant'], message: [full, null] }) },
    ]];
  });
  // block: type once; id five times on first sighting (guard, has(), the
  // Map key argument, the literal, order.push) and twice on a repeat; name
  // once; tool_result: tool_use_id twice, is_error once.
  add('deriveToolTiming', 'DT.reads:block', c => [[
    { event: { type: 'assistant', message: { content: [withReads(c, 'b', { type: ['tool_use'], id: ['t', 't', 't', 't'], name: ['T'] })] } } },
    { event: { type: 'assistant', message: { content: [withReads(c, 'b2', { type: ['tool_use'], id: ['t', 't'], name: ['ignored'] })] } } },
    { event: { type: 'assistant', message: { content: [withReads(c, 'b3', { type: ['tool_result'], id: ['never'] })] } } },
  ]]);
  add('deriveToolTiming', 'DT.reads:block-type', c => [[
    { event: { type: 'assistant', message: { content: [withReads(c, 'b', { type: ['x', 'tool_use'], id: ['never'] })] } } },
  ]]);
  for (const [tag, factory] of [['object', () => ({})], ['symbol', () => Symbol('i')]]) {
    // the Map key (3rd read) and the order entry (4th read) differ -> [undefined]
    add('deriveToolTiming', `DT.reads:id-fresh:${tag}`, c => [[{ event: { type: 'assistant', message: { content: [withReads(c, 'b', { id: [factory(), factory(), factory(), factory()] }, { type: 'tool_use' })] } } }]]);
    // the has() probe saw the shared object, the key is the fresh one
    add('deriveToolTiming', `DT.reads:id-shared:${tag}`, c => {
      const s = factory();
      return [[{ event: { type: 'assistant', message: { content: [withReads(c, 'b', { id: [s, s, factory(), s] }, { type: 'tool_use' })] } } }]];
    });
  }
  add('deriveToolTiming', 'DT.reads:id-throws-3', c => [[{ event: { type: 'assistant', message: { content: [withReads(c, 'b', { id: ['t', 't', THROWS(new RangeError('id3'))] }, { type: 'tool_use' })] } } }]]);
  add('deriveToolTiming', 'DT.reads:id-throws-4', c => [[use('x'), { event: { type: 'assistant', message: { content: [withReads(c, 'b', { id: ['t', 't', 't', THROWS(new RangeError('id4'))] }, { type: 'tool_use' })] } } }]]);
  add('deriveToolTiming', 'DT.reads:result', c => [[
    { event: { type: 'user', message: { content: [withReads(c, 'r0', { tool_use_id: ['ghost', 'ghost'] }, { type: 'tool_result' })] } } },
    use('t'),
    { event: { type: 'user', message: { content: [withReads(c, 'r1', { tool_use_id: ['t', 't'], is_error: ['', 1] }, { type: 'tool_result' })] } } },
    { event: { type: 'user', message: { content: [withReads(c, 'r2', { tool_use_id: ['t', 't'], is_error: ['never', 'never'] }, { type: 'tool_result' })] } } },
  ]]);
  add('deriveToolTiming', 'DT.reads:result-falsy-guard', c => [[use('t'), { event: { type: 'user', message: { content: [withReads(c, 'r', { tool_use_id: ['', 't'] }, { type: 'tool_result' })] } } }]]);
  add('deriveToolTiming', 'DT.reads:result-id-fresh', c => [[use('t'), { event: { type: 'user', message: { content: [withReads(c, 'r', { tool_use_id: ['t', 'ghost'] }, { type: 'tool_result' })] } } }]]);
  add('deriveToolTiming', 'DT.order', () => [[use('b'), result('ghost'), use('a', 'A', 500), result('b', 900), use('c'), result('b', 950, true), result('a', 1000), use('b', 'B', 999)]]);
  add('deriveToolTiming', 'DT.first-result-wins', () => [[use('t'), result('t', 10, false), result('t', 20, true)]]);
  add('deriveToolTiming', 'DT.id-object-passthrough', c => {
    const id = c.name({ id: 1 }, 'objId');
    return [[use(id), result(id), use(id, 'dup', 3000), result(id, 4000, true)]];
  });
  add('deriveToolTiming', 'DT.watched', c => {
    const content2 = watch(c, 'content', [watch(c, 'block', { type: 'tool_use', id: 't', name: 'T' }), watch(c, 'block2', { type: 'tool_use', id: 't' })]);
    const record = watch(c, 'record', { seq: 1, ts: 5, event: watch(c, 'event', { type: 'assistant', message: watch(c, 'message', { content: content2 }) }) });
    const record2 = watch(c, 'record2', { seq: 2, ts: 9, event: watch(c, 'event2', { type: 'user', message: { content: [watch(c, 'block3', { type: 'tool_result', tool_use_id: 't', is_error: 1 })] } }) });
    return [[record, record2]];
  });
}

// ---- diffToolTiming -------------------------------------------------------
const CONTAINERS = [
  ['null', K(null)], ['undefined', K(undefined)], ['5', K(5)], ['str', K('str')], ['true', K(true)], ['1n', K(1n)],
  ['symbol', c => c.name(Symbol('c'), 'contSym')], ['{}', K({})], ['arraylike', K({ length: 1, 0: use() })], ['[]', K([])],
  ['new Array(0)', K(new Array(0))], ['[,]', K([,])], ['[,]rec', K([, use()])], ['rec,,rec', K([use('a'), , use('b')])],
  ['rec,undefined,null', K([use('a'), undefined, null])], ['frozen', K(Object.freeze([use()]))],
];
{
  const DERIVED_IDS = [
    ...['t1', '1', 'constructor', '__proto__'].map(s => [`'${s}'`, K(s)]),
    ['1n', K(1n)], ['123456789012345678901234567890n', K(123456789012345678901234567890n)], ['true', K(true)],
    ['NaN', K(NaN)], ['0', K(0)], ['-0', K(-0)], ['undefined', K(undefined)],
    ['Symbol', c => c.name(Symbol('d'), 'dSym')], ['object', c => c.name({ id: 1 }, 'dObj')], ['function', c => c.name(() => 'd', 'dFn')],
  ];
  // A blob entry with a falsy id is never indexed, so those derived ids
  // report missing_from_blob even when the blob lists the same value.
  matrix(CORPUS, 'diffToolTiming', 'DF.id', { id: DERIVED_IDS }, (c, { id }) => [[tool(id(c), 'T')], [blobTool(id(c), 'T')]]);
  for (const [tag, d, b] of [['-0-vs-0', -0, 0], ['0-vs--0', 0, -0], ['NaN-vs-NaN', NaN, NaN], ['1-vs-1n', 1, 1n], ['"1"-vs-1', '1', 1]]) {
    add('diffToolTiming', `DF.id:${tag}`, () => [[tool(d)], [blobTool(b)]]);
  }
  add('diffToolTiming', 'DF.id:symbol.for', () => [[tool(Symbol.for('same'))], [blobTool(Symbol.for('same'))]]);
  add('diffToolTiming', 'DF.id:symbol-same-desc', () => [[tool(Symbol('x'))], [blobTool(Symbol('x'))]]);
  add('diffToolTiming', 'DF.id:object-same-shape', () => [[tool({})], [blobTool({})]]);
  const BLOB_IDS = [
    ['null', K(null)], ['undefined', K(undefined)], ['false', K(false)], ["''", K('')], ['0', K(0)], ['-0', K(-0)], ['NaN', K(NaN)],
    ['0n', K(0n)], ['5', K(5)], ['str', K('str')], ['true', K(true)], ['1n', K(1n)],
    ['Symbol', c => c.name(Symbol('b'), 'bSym')], ['object', c => c.name({}, 'bObj')],
  ];
  matrix(CORPUS, 'diffToolTiming', 'DF.blob-id', { id: BLOB_IDS }, (c, { id }) => [[tool('t')], [blobTool(id(c), 'T', 1000, 2000), blobTool('t')]]);
  const ENTRIES = [
    ['null', K(null)], ['undefined', K(undefined)], ['0', K(0)], ['5', K(5)], ['str', K('str')], ['true', K(true)], ['1n', K(1n)],
    ['symbol', c => c.name(Symbol('e'), 'eSym')], ['{}', K({})], ['revoked', c => c.name(revoked(), 'rp')],
    ['proxy', c => watch(c, 'entry', { id: 't', name: 'T', startedAt: 1000, endedAt: 2000 })],
  ];
  matrix(CORPUS, 'diffToolTiming', 'DF.blob-entry', { entry: ENTRIES }, (c, { entry }) => [[tool('t')], [entry(c), blobTool('t')]]);
  matrix(CORPUS, 'diffToolTiming', 'DF.derived-entry', { entry: ENTRIES }, (c, { entry }) => [[entry(c), tool('t')], [blobTool('t')]]);
  matrix(CORPUS, 'diffToolTiming', 'DF.containers', { derived: CONTAINERS, blob: CONTAINERS }, (c, { derived, blob }) => [derived(c), blob(c)]);
  add('diffToolTiming', 'DF.blob-dup-last-wins', () => [[tool('t', 'T')], [blobTool('t', 'A', 1000, 2000), blobTool('t', 'B', 1000, 3000)]]);
  add('diffToolTiming', 'DF.derived-dup', () => [[tool('t', 'T'), tool('t', 'T', 5000, 6000)], [blobTool('t', 'T')]]);

  const NAMES2 = [
    ['absent', K(ABSENT)], ['undefined', K(undefined)], ['null', K(null)], ["''", K('')], ['0', K(0)], ['1', K(1)], ['NaN', K(NaN)],
    ['T', K('T')], ['t', K('t')], ['1n', K(1n)], ['true', K(true)],
    ['symbol', c => c.name(Symbol('n'), 'nSym')], ['object', c => c.name({ n: 1 }, 'nObj')],
  ];
  matrix(CORPUS, 'diffToolTiming', 'DF.name', { b: NAMES2, d: NAMES2 }, (c, { b, d }) => [[tool('t', d(c))], [blobTool('t', b(c), 1000, 2000)]]);
  const STAMPS = [
    ['absent', K(ABSENT)], ['undefined', K(undefined)], ['null', K(null)], ['0', K(0)], ['-0', K(-0)], ['NaN', K(NaN)],
    ['Infinity', K(Infinity)], ['-Infinity', K(-Infinity)], ["'1000'", K('1000')], ["'abc'", K('abc')], ['1000n', K(1000n)],
    ['Object(1000)', K(new Number(1000))], ['true', K(true)], ['{}', K({})], ['[1000]', K([1000])], ['999.9999', K(999.9999)],
    ['2000.5', K(2000.5)], ['-1000', K(-1000)],
  ];
  matrix(CORPUS, 'diffToolTiming', 'DF.blob-start', { stamp: STAMPS }, (c, { stamp }) => [[tool('t')], [blobTool('t', 'T', stamp(c), 2000)]]);
  matrix(CORPUS, 'diffToolTiming', 'DF.blob-end', { stamp: STAMPS }, (c, { stamp }) => [[tool('t')], [blobTool('t', 'T', 1000, stamp(c))]]);
  matrix(CORPUS, 'diffToolTiming', 'DF.blob-end-running', { stamp: STAMPS }, (c, { stamp }) => [[tool('t', 'T', 1000, null)], [blobTool('t', 'T', 1000, stamp(c))]]);
  const DSTAMPS = [
    ['undefined', K(undefined)], ['null', K(null)], ["'1000'", K('1000')], ["'x'", K('x')], ['1n', K(1n)], ['true', K(true)],
    ['1000.5', K(1000.5)], ['-0', K(-0)], ['NaN', K(NaN)], ['Infinity', K(Infinity)],
    ['Symbol', c => c.name(Symbol('s'), 'sSym')], ['Object(1000)', K(new Number(1000))], ['new Date(0)', K(new Date(0))],
    ['[1000]', K([1000])], ['{valueOf:1000}', K({ valueOf: 1000 })], ['{valueOf(){}}', K({ valueOf() { return 1000; } })],
    ['{[Symbol.toPrimitive]:5}', K({ [Symbol.toPrimitive]: 5 })],
    ['{[Symbol.toPrimitive]:null}', K({ [Symbol.toPrimitive]: null, valueOf() { return 1000; } })],
    ['{[Symbol.toPrimitive](){return {}}}', K({ [Symbol.toPrimitive]() { return {}; } })],
    ['{[Symbol.toPrimitive](){return 2000n}}', K({ [Symbol.toPrimitive]() { return 2000n; } })],
    ['Object.create(null)', K(Object.create(null))], ['Object(5n)', K(Object(5n))],
    ['revoked', c => c.name(revoked(), 'rp')], ['{toString(){return "1000"}}', K({ toString() { return '1000'; } })],
    ['{toString:"1000"}', K({ toString: '1000' })],
  ];
  matrix(CORPUS, 'diffToolTiming', 'DF.derived-start', { stamp: DSTAMPS }, (c, { stamp }) => [[tool('t', 'T', stamp(c), 2000)], [blobTool('t', 'T', 1000, 2000)]]);
  matrix(CORPUS, 'diffToolTiming', 'DF.derived-end', { stamp: DSTAMPS }, (c, { stamp }) => [[tool('t', 'T', 1000, stamp(c))], [blobTool('t', 'T', 1000, 2000)]]);
  const ENDS = [['null', K(null)], ['undefined', K(undefined)], ['absent', K(ABSENT)], ['2000', K(2000)], ['NaN', K(NaN)], ["'x'", K('x')], ['-0', K(-0)], ['4000.5', K(4000.5)]];
  const BENDS = [['absent', K(ABSENT)], ['null', K(null)], ['NaN', K(NaN)], ['2000', K(2000)], ['4000', K(4000)], ['4000.5', K(4000.5)], ['-1000', K(-1000)], ["'2000'", K('2000')], ['2000n', K(2000n)]];
  matrix(CORPUS, 'diffToolTiming', 'DF.end', { d: ENDS, b: BENDS }, (c, { d, b }) => [[tool('t', 'T', 1000, d(c))], [blobTool('t', 'T', 1000, b(c))]]);
  const FLAGS = [
    ['absent', K(ABSENT)], ['undefined', K(undefined)], ['null', K(null)], ['0', K(0)], ['1', K(1)], ["''", K('')], ["'x'", K('x')],
    ['NaN', K(NaN)], ['{}', K({})], ['[]', K([])], ['false', K(false)], ['true', K(true)], ['0n', K(0n)], ['1n', K(1n)], ['-0', K(-0)],
  ];
  const DFLAGS = [['true', K(true)], ['false', K(false)], ['0', K(0)], ['1', K(1)], ['undefined', K(undefined)], ['null', K(null)], ["'x'", K('x')], ['NaN', K(NaN)], ['1n', K(1n)]];
  matrix(CORPUS, 'diffToolTiming', 'DF.flag', { is_error: FLAGS.slice(0, 10), isError: FLAGS.slice(2, 10), d: DFLAGS.slice(0, 5) }, (c, { is_error, isError, d }) => [[tool('t', 'T', 1000, 2000, d(c))], [blobTool('t', 'T', 1000, 2000, is_error(c), isError(c))]]);

  // Tolerance: the third argument's toleranceMs through every coercion path
  // of `Math.abs(a - b) > toleranceMs` (ToPrimitive default hint, ToNumeric,
  // exact Number-vs-BigInt comparison), against gaps around the boundary.
  const COUNTING = () => { let n = 0; return { valueOf() { n += 1; return [2500, 0][Math.min(n, 2) - 1]; } }; };
  const tol = v => K({ toleranceMs: v });
  const TOL = [
    ['absent', K(ABSENT)], ['undefined', K(undefined)], ['{}', K({})], ['{toleranceMs:undefined}', K({ toleranceMs: undefined })],
    ['null', K(null)], ['5', K(5)], ["'s'", K('s')], ['true', K(true)], ['false', K(false)], ['Symbol', c => tol(c.name(Symbol('t'), 'tolSym'))(c)],
    ['1n', K(1n)], ['2000n', K(2000n)], ['-2000n', K(-2000n)], ['0n', K(0n)], ['()=>1', c => tol(c.name(() => 1, 'tolFn'))(c)],
    ['Object.create(null)', K(Object.create(null))], ['[]', K([])], ['frozen', K(Object.freeze({}))],
    ['getter-throws', () => ({ get toleranceMs() { throw new RangeError('tol'); } })],
    ['proxy-get-throws', () => new Proxy({}, { get(t, k) { throw new RangeError('ptol'); } })],
    ['revoked', c => c.name(revoked(), 'rp')],
    ...[0, -0, -5, NaN, Infinity, -Infinity, 2000, 1999.5, 2000.5, 1e-7].map(v => [`number ${v}`, tol(v)]),
    ...['2000', '2e3', ' 2000 ', '2000n', '', '0x7d0', '1_0', '+2000', '-1', 'Infinity', 'NaN'].map(v => [`string '${v}'`, tol(v)]),
    ['null-val', tol(null)], ['true-val', tol(true)], ['false-val', tol(false)], ['undefined-val', tol(undefined)],
    ['[2000]', tol([2000])], ['[1,2]', tol([1, 2])], ['[]', tol([])], ['{}', tol({})], ['[null]', tol([null])], ['[undefined]', tol([undefined])],
    ['new Number(2000)', tol(new Number(2000))], ['new Date(2000)', tol(new Date(2000))], ['new Boolean(true)', tol(new Boolean(true))],
    ['new String("2000")', tol(new String('2000'))],
    ['()=>2000', c => tol(c.name(() => 2000, 'fn2000'))(c)], ['/2000/', tol(/2000/)],
    ['{valueOf}', tol({ valueOf() { return 2000; } })], ['{valueOf:2000}', tol({ valueOf: 2000 })],
    ['{toString(){return "2000"}}', tol({ toString() { return '2000'; } })], ['{toString:"2000"}', tol({ toString: '2000' })],
    ['{[Symbol.toPrimitive](h){return h}}', tol({ [Symbol.toPrimitive](h) { return h; } })],
    ['{[Symbol.toPrimitive]:5}', tol({ [Symbol.toPrimitive]: 5 })],
    ['{[Symbol.toPrimitive](){return {}}}', tol({ [Symbol.toPrimitive]() { return {}; } })],
    ['{[Symbol.toPrimitive](){return 2000n}}', tol({ [Symbol.toPrimitive]() { return 2000n; } })],
    ['{[Symbol.toPrimitive](){return undefined}}', tol({ [Symbol.toPrimitive]() { return undefined; } })],
    ['2000n-val', tol(2000n)], ['-2000n-val', tol(-2000n)], ['0n-val', tol(0n)], ['2^80n', tol(2n ** 80n)], ['-(2^80n)', tol(-(2n ** 80n))],
    ['2^1024n', tol(2n ** 1024n)], ['2^1023n', tol(2n ** 1023n)], ['Object(2000n)', tol(Object(2000n))],
    ['9007199254740993n', tol(9007199254740993n)], ['123456789n', tol(123456789n)],
    ['counting-valueOf', () => ({ toleranceMs: COUNTING() })],
    ['throwing-valueOf', tol({ valueOf() { throw new EvalError('vo'); } })], ['revoked-valueOf', c => tol(c.name(revoked(), 'rp'))(c)],
  ];
  const GAPS = [['0', 0], ['1999.5', 1999.5], ['2000', 2000], ['2000.5', 2000.5], ['5000', 5000], ['-2000.5', -2000.5], ['-0', -0], ['1e-9', 1e-9]];
  matrix(CORPUS, 'diffToolTiming', 'DF.tolerance', { tol: TOL, gap: GAPS }, (c, { tol: t, gap }) => {
    const options = t(c);
    return [[tool('t')], [blobTool('t', 'T', 1000 + gap, 2000 + gap)], ...(options === ABSENT ? [] : [options])];
  });
  // A stateful tolerance is coerced once per comparison and drives branches.
  add('diffToolTiming', 'DF.tolerance:counting', () => [[tool('t')], [blobTool('t', 'T', 3000, 2500)], { toleranceMs: COUNTING() }]);
  add('diffToolTiming', 'DF.tolerance:counting-2', () => [[tool('t')], [blobTool('t', 'T', 2500, 5000)], { toleranceMs: COUNTING() }]);
  add('diffToolTiming', 'DF.reads:options', c => [[tool('t')], [blobTool()], withReads(c, 'opt', { toleranceMs: [undefined, 5000] })]);
  // toleranceMs is read once (destructured); the running case has no blob
  // end, so neither comparison is reached.
  add('diffToolTiming', 'DF.reads:options-per-comparison', c => [[tool('t')], [blobTool('t', 'T', 3000, 5000)], withReads(c, 'opt', { toleranceMs: [2000, 2000, 2000] })]);
  add('diffToolTiming', 'DF.reads:options-running', c => [[tool('t')], [blobTool('t', 'T', 3000)], withReads(c, 'opt', { toleranceMs: [2000, 2000, 2000] })]);
  add('diffToolTiming', 'DF.reads:options-getter-throws', c => [[tool('t')], [blobTool()], throwing(c, 'opt', 'toleranceMs', new RangeError('g'))]);
  add('diffToolTiming', 'DF.options:revoked', c => [[tool('t')], [blobTool()], c.name(revoked(), 'rp')]);
  add('diffToolTiming', 'DF.options:proxy-get-throws', c => [[tool('t')], [blobTool()], new Proxy({}, { get(t, k) { throw new RangeError('p'); } })]);
  for (const [tag, v] of [['null', null], ['undefined', undefined], ['5', 5], ["'s'", 's'], ['true', true], ['Symbol', Symbol('o')], ['1n', 1n], ['{}', {}], ['frozen', Object.freeze({})], ['Object.create(null)', Object.create(null)]]) {
    add('diffToolTiming', `DF.options:${tag}`, () => [[tool('t')], [blobTool()], v]);
  }
  // Operand order: the subtraction's right operand coerces before the tolerance.
  add('diffToolTiming', 'DF.reads:coercion-order', c => [[
    { id: 't', name: 'T', isError: false,
      startedAt: { [Symbol.toPrimitive](h) { c.trace.push('d.start'); return 1000; } },
      endedAt: { [Symbol.toPrimitive](h) { c.trace.push('d.end'); return 2000; } } },
  ], [blobTool('t', 'T', 1000, 2000)], { toleranceMs: { [Symbol.toPrimitive](h) { c.trace.push('tol'); return 2000; } } }]);
  // Derived / blob read counts: id twice (three with a mismatch), name once
  // (twice), stamps once or twice depending on Number.isFinite, is_error
  // once, isError only when is_error is falsy.
  add('diffToolTiming', 'DF.reads:entry', c => [
    [withReads(c, 'd', { id: ['t', 't'], name: ['T'], startedAt: [1000], endedAt: [2000], isError: [false] }),
      withReads(c, 'd2', { id: ['ghost', 'ghost', 'ghost'], name: ['G'] })],
    [withReads(c, 'b', { id: ['t', 't'], name: ['T', 'T'], startedAt: [1000, 1000], endedAt: [2000, 2000], is_error: ['never'], isError: ['never'] })],
  ]);
  add('diffToolTiming', 'DF.reads:entry-mismatch', c => [
    [withReads(c, 'd', { id: ['t', 't', 't'], name: ['T', 'T'], startedAt: [1000, 1000], endedAt: [2000, 2000], isError: [false, false] })],
    [withReads(c, 'b', { id: ['t', 't'], name: ['B', 'B', 'B'], startedAt: [5000, 5000], endedAt: [9000, 9000], is_error: ['never'], isError: [1] })],
  ]);
  add('diffToolTiming', 'DF.order', () => [
    [tool('a', 'A'), tool('b', 'B', 5, 10, true), tool('c')],
    [blobTool('z', 'Z'), blobTool('a', 'a', 5000, 6000), blobTool('c', 'C', 1000, 2000, true), blobTool('a', 'A2', 1000, 2000)],
  ]);
}

// ---- deriveOpenTasks ------------------------------------------------------
{
  const TASK_IDS = [
    ...['a', 'a b', '1', '__proto__', 'constructor'].map(s => [`'${s}'`, K(s)]), ['1n', K(1n)], ['-5n', K(-5n)],
    ['Symbol', c => c.name(Symbol('t'), 'tidSym')], ['Symbol.for', c => c.name(Symbol.for('tk'), 'tidSymFor')],
    ['object', c => c.name({ t: 1 }, 'tidObj')], ['function', c => c.name(() => 't', 'tidFn')], ['boxed', c => c.name(new Number(3), 'tidBox')],
  ];
  matrix(CORPUS, 'deriveOpenTasks', 'OT.task-id', { id: TASK_IDS }, (c, { id }) => {
    const v = id(c);
    return [[started(v), progress(v), started(v, 'D2', undefined, 2000), snapshot([{ task_id: v }], 3000)]];
  });
  for (const [tag, v] of [['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['-0', -0], ['NaN', NaN], ["''", ''], ['0n', 0n]]) {
    add('deriveOpenTasks', `OT.falsy-task-id:${tag}`, () => [[started(v), progress(v), done(v)]]);
  }
  const DESCS = [
    ['absent', K(ABSENT)], ['undefined', K(undefined)], ['null', K(null)], ["''", K('')], ['0', K(0)], ['NaN', K(NaN)], ['false', K(false)],
    ['D', K('D')], ['1n', K(1n)], ['true', K(true)], ['-0', K(-0)],
    ['symbol', c => c.name(Symbol('d'), 'descSym')], ['object', c => c.name({ d: 1 }, 'descObj')], ['function', c => c.name(() => 'd', 'descFn')],
  ];
  const CMDS = [
    ['absent', K(ABSENT)], ['undefined', K(undefined)], ['null', K(null)], ["''", K('')], ['C', K('C')], ['7', K(7)],
    ['object', c => c.name({ c: 1 }, 'cmdObj')], ['0', K(0)], ['false', K(false)],
  ];
  matrix(CORPUS, 'deriveOpenTasks', 'OT.description', { d: DESCS, cmd: CMDS }, (c, { d, cmd }) => [[started('a', d(c), cmd(c))]]);
  const TS2 = [
    ['undefined', K(undefined)], ['null', K(null)], ['0', K(0)], ['-0', K(-0)], ['NaN', K(NaN)], ['1n', K(1n)], ['str', K('x')],
    ['Infinity', K(Infinity)], ['symbol', c => c.name(Symbol('ts'), 'otsSym')], ['object', c => c.name({}, 'otsObj')],
  ];
  matrix(CORPUS, 'deriveOpenTasks', 'OT.ts', { start: TS2, end: TS2.slice(0, 5) }, (c, { start, end }) => {
    const last = end(c);
    return [[started('a', 'D', undefined, start(c)), progress('a', end(c)), snapshot([{ task_id: 'a' }], last)]];
  });
  // Read counts: task_id twice on start (guard + argument), three times on a
  // known progress, twice on an unknown one, twice on done; description once,
  // command only when description is falsy; event.tasks twice (isArray + head).
  add('deriveOpenTasks', 'OT.reads:started', c => [[started('a'), withReads(c, 'rec', { ts: [5] }, { event: withReads(c, 'ev', { type: ['monitor_started'], task_id: ['a', 'a'], description: ['D'], command: ['never'] }) })]]);
  add('deriveOpenTasks', 'OT.reads:started-command', c => [[{ ts: 5, event: withReads(c, 'ev', { type: ['monitor_started'], task_id: ['a', 'a'], description: ['', 0], command: ['C'] }) }]]);
  add('deriveOpenTasks', 'OT.reads:started-absent', c => [[{ ts: 5, event: withReads(c, 'ev', { type: ['monitor_started'], task_id: ['a', 'a'], description: [undefined], command: [undefined] }) }]]);
  add('deriveOpenTasks', 'OT.reads:progress-known', c => [[started('a'), { ts: 7, event: withReads(c, 'ev', { type: ['monitor_progress'], task_id: ['a', 'a', 'a'] }) }]]);
  add('deriveOpenTasks', 'OT.reads:progress-unknown', c => [[withReads(c, 'ev', { type: ['monitor_progress'], task_id: ['ghost', 'ghost', 'ghost'] })]]);
  add('deriveOpenTasks', 'OT.reads:progress-fresh-id', c => [[started('a'), { ts: 7, event: withReads(c, 'ev', { type: ['monitor_progress'], task_id: ['a', {}, {}] }) }]]);
  add('deriveOpenTasks', 'OT.reads:done', c => [[started('a'), { ts: 7, event: withReads(c, 'ev', { type: ['monitor_done'], task_id: ['a', 'a', 'a'] }) }]]);
  add('deriveOpenTasks', 'OT.reads:done-fresh-id', c => [[started('a'), { ts: 7, event: withReads(c, 'ev', { type: ['monitor_done'], task_id: ['a', {}] }) }]]);
  add('deriveOpenTasks', 'OT.reads:done-unknown', c => [[{ ts: 7, event: withReads(c, 'ev', { type: ['monitor_done'], task_id: ['ghost', 'ghost', 'ghost'] }) }]]);
  for (const [tag, values] of [['monitor_started', ['monitor_started']], ['monitor_progress', ['monitor_progress', 'x']], ['monitor_done', ['monitor_done', 'x', 'x']], ['background_tasks', ['background_tasks', 'x', 'x', 'x']]]) {
    add('deriveOpenTasks', `OT.reads:type:${tag}`, c => [[started('a'), { ts: 7, event: withReads(c, 'ev', { type: values }, { task_id: 'a', tasks: [{ task_id: 'a' }] }) }]]);
  }
  add('deriveOpenTasks', 'OT.reads:type:none', c => [[started('a'), { ts: 7, event: withReads(c, 'ev', { type: ['x', 'y', 'z', 'w'], task_id: ['never'] }) }]]);
  add('deriveOpenTasks', 'OT.reads:type:4th-read', c => [[started('a'), { ts: 7, event: withReads(c, 'ev', { type: ['x', 'y', 'z', 'background_tasks'], tasks: [{ task_id: 'a' }] }) }]]);
  add('deriveOpenTasks', 'OT.reads:tasks-twice', c => [[started('a'), { ts: 7, event: withReads(c, 'ev', { type: ['background_tasks'], tasks: [[{ task_id: 'a' }], [{ task_id: 'ghost' }]] }) }]]);
  add('deriveOpenTasks', 'OT.reads:entry', c => [[started('a'), { ts: 7, event: { type: 'background_tasks', tasks: [
    withReads(c, 't1', { task_id: ['a', 'a'] }),
    withReads(c, 't2', { task_id: ['', 0], id: ['a', 'a'] }),
    withReads(c, 't3', { task_id: ['ghost', 'ghost'], id: ['never'] }),
    withReads(c, 't4', { task_id: [undefined], id: [0] }),
    withReads(c, 't5', { task_id: ['a', {}] }),
    withReads(c, 't6', { task_id: [0], id: ['a'] }),
  ] } }]]);
  // Each entry is the whole tasks list: the odd entry first, a known task last.
  const TASK_ENTRIES = [
    ['null', () => [null, { task_id: 'a' }]], ['undefined', () => [undefined, { task_id: 'a' }]], ['0', () => [0, { task_id: 'a' }]],
    ["''", () => ['', { task_id: 'a' }]], ['5', () => [5, { task_id: 'a' }]], ['{}', () => [{}, { task_id: 'a' }]],
    ['symbol', c => [c.name(Symbol('t'), 'teSym'), { task_id: 'a' }]], ['1n', () => [1n, { task_id: 'a' }]],
    ['revoked', c => [c.name(revoked(), 'rp'), { task_id: 'a' }]],
    ['{task_id:a}', () => [{ task_id: 'a' }, { task_id: 'ghost' }]], ['{id:a}', () => [{ id: 'a' }, { task_id: 'ghost' }]],
    ['{task_id:0,id:a}', () => [{ task_id: 0, id: 'a' }, { task_id: 'ghost' }]], ['{task_id:a,id:b}', () => [{ task_id: 'a', id: 'b' }, { task_id: 'ghost' }]],
    ['{task_id:null,id:a}', () => [{ task_id: null, id: 'a' }, { task_id: 'ghost' }]], ['{task_id:ghost,id:a}', () => [{ task_id: 'ghost', id: 'a' }, { task_id: 'ghost' }]],
    ['{id:ghost}', () => [{ id: 'ghost' }, { task_id: 'a' }]], ['sparse', () => [, { task_id: 'a' }]], ['sparse-only', () => [,]],
  ];
  matrix(CORPUS, 'deriveOpenTasks', 'OT.snapshot', { entry: TASK_ENTRIES }, (c, { entry }) => [[started('a'), snapshot(entry(c), 5000)]]);
  for (const [tag, make] of [['{}', () => ({})], ['str', () => 't'], ['null', () => null], ['undefined', () => undefined], ['arraylike', () => ({ length: 1, 0: { task_id: 'a' } })], ['proxy', c => watch(c, 'tasks', [{ task_id: 'a' }])], ['frozen', () => Object.freeze([{ task_id: 'a' }])], ['[]', () => []], ['[,]', () => [,]]]) {
    add('deriveOpenTasks', `OT.snapshot-shape:${tag}`, c => [[started('a'), snapshot(make(c), 5000)]]);
  }
  add('deriveOpenTasks', 'OT.lifecycle', () => [[started('a', 'A'), started('b', 'B'), progress('a', 1500), done('b', 2000), snapshot([{ task_id: 'a' }, { task_id: 'b' }], 2500), done('ghost'), progress('b', 2600), started('b', 'B2', undefined, 2700)]]);
  // Reopening after a delete: order keeps the id twice, so the same new object
  // is returned twice (reference identity is part of the contract).
  add('deriveOpenTasks', 'OT.reopen-same-ref', () => [[started('a', 'A'), done('a'), started('a', 'A2'), snapshot([{ id: 'a' }], 5000)]]);
  add('deriveOpenTasks', 'OT.reopen-order', () => [[started('a', 'A'), started('b', 'B'), done('a'), started('a', 'A2')]]);
  add('deriveOpenTasks', 'OT.reopen-triple', () => [[started('a'), done('a'), started('a'), done('a'), started('a')]]);
  add('deriveOpenTasks', 'OT.retouch', () => [[started('a', 'A'), started('a', 'B', 'C', 5000), progress('a', 6000)]]);
  add('deriveOpenTasks', 'OT.throws:description', c => [[{ ts: 5, event: { type: 'monitor_started', task_id: 'a', get description() { throw new RangeError('desc'); } } }]]);
  add('deriveOpenTasks', 'OT.throws:task-id-2nd-read', c => [[{ ts: 5, event: withReads(c, 'ev', { type: ['monitor_started'], task_id: ['a', THROWS(new RangeError('tid'))] }) }]]);
  add('deriveOpenTasks', 'OT.throws:progress-3rd-read', c => [[started('a'), { ts: 5, event: withReads(c, 'ev', { type: ['monitor_progress'], task_id: ['a', 'a', THROWS(new RangeError('tid'))] }) }]]);
  add('deriveOpenTasks', 'OT.watched', c => [[
    watch(c, 'record', { seq: 1, ts: 5, event: watch(c, 'event', { type: 'monitor_started', task_id: 'a', description: 'D' }) }),
    watch(c, 'record2', { seq: 2, ts: 9, event: watch(c, 'event2', { type: 'background_tasks', tasks: watch(c, 'tasks', [watch(c, 'entry', { task_id: 'a' })]) }) }),
  ]]);
}

// ---- seeded fuzz ----------------------------------------------------------
const mulberry32 = seed => () => {
  seed |= 0;
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
{
  const SCALARS = [undefined, null, true, false, 0, -0, 1, -1, NaN, Infinity, -Infinity, 1.5, 999.5, 1000, 1999.5, 2000, 2000.5, 3000, 1e21, 1e-7,
    '', 'a', 't', 'T', 'Bash', 'assistant', 'user', 'tool_use', 'tool_result', 'monitor_started', 'monitor_progress', 'monitor_done',
    'background_tasks', '1000', '2000n', 1n, 2000n, 0n, -1n, 123456789012345678901234567890n];
  const value = (c, rnd) => {
    const r = rnd();
    if (r < 0.6) return pick(rnd, SCALARS);
    if (r < 0.66) return c.name(Symbol('f'), 'sym');
    if (r < 0.72) return c.name(Symbol.for('f'), 'symfor');
    if (r < 0.8) return c.name({}, 'obj');
    if (r < 0.84) return c.name(() => 1, 'fn');
    if (r < 0.87) return c.name(new Number(1000), 'boxed');
    if (r < 0.9) return c.name({ valueOf() { return 1000; } }, 'valueOf');
    if (r < 0.93) return c.name({ valueOf() { return 2000n; } }, 'valueOfN');
    if (r < 0.96) return c.name(Object(5n), 'bigintObj');
    return c.name([1000], 'arr');
  };
  const sparse = (rnd, n, make) => { const a = new Array(n); for (let i = 0; i < n; i++) if (rnd() < 0.85) a[i] = make(); return a; };
  const block = (c, rnd) => {
    const r = rnd();
    if (r < 0.15) return value(c, rnd);
    if (r < 0.2) return null;
    const b = { type: pick(rnd, ['tool_use', 'tool_result', 'tool_use', 'tool_result', 'x', value(c, rnd)]) };
    if (rnd() < 0.9) b[rnd() < 0.5 ? 'id' : 'tool_use_id'] = pick(rnd, ['t1', 't2', 'a', 'b', '', value(c, rnd), 0, undefined, 1n, 'constructor']);
    if (rnd() < 0.7) b.name = value(c, rnd);
    if (rnd() < 0.5) b.is_error = value(c, rnd);
    if (rnd() < 0.2) b.isError = value(c, rnd);
    return b;
  };
  const event = (c, rnd) => {
    if (rnd() < 0.12) return value(c, rnd);
    const type = pick(rnd, ['assistant', 'user', 'monitor_started', 'monitor_progress', 'monitor_done', 'background_tasks', 'other', value(c, rnd)]);
    const ev = { type };
    if (type === 'assistant' || type === 'user') {
      if (rnd() < 0.9) ev.message = rnd() < 0.85 ? { content: sparse(rnd, Math.floor(rnd() * 4), () => block(c, rnd)) } : value(c, rnd);
      return ev;
    }
    if (rnd() < 0.9) ev.task_id = pick(rnd, ['a', 'b', 'c', '', value(c, rnd), 0, undefined, 1n]);
    if (rnd() < 0.6) ev.description = value(c, rnd);
    if (rnd() < 0.3) ev.command = value(c, rnd);
    if (type === 'background_tasks') {
      ev.tasks = rnd() < 0.85 ? sparse(rnd, Math.floor(rnd() * 4), () => {
        const t = rnd() < 0.2 ? value(c, rnd) : {};
        if (typeof t === 'object' && t) {
          if (rnd() < 0.8) t.task_id = pick(rnd, ['a', 'b', '', value(c, rnd), 0]);
          if (rnd() < 0.5) t.id = pick(rnd, ['a', 'c', value(c, rnd)]);
        }
        return t;
      }) : value(c, rnd);
    }
    return ev;
  };
  const record = (c, rnd) => (rnd() < 0.1 ? value(c, rnd) : { seq: 1, ts: value(c, rnd), event: rnd() < 0.12 ? value(c, rnd) : event(c, rnd) });
  const records = (c, rnd) => sparse(rnd, Math.floor(rnd() * 7), () => record(c, rnd));
  const maybe = (o, k, v) => { if (v !== ABSENT) o[k] = v; return o; };
  const stamp = (c, rnd) => {
    const r = rnd();
    if (r < 0.7) return pick(rnd, SCALARS);
    if (r < 0.76) return ABSENT;
    if (r < 0.8) return new Number(1000);
    if (r < 0.84) return new Date(0);
    if (r < 0.88) return Object.create(null);
    if (r < 0.92) return [1000];
    if (r < 0.96) return { valueOf() { return 1000; } };
    return { [Symbol.toPrimitive](h) { return h; } };
  };
  const toolLike = (c, rnd, derived) => {
    const t = {};
    maybe(t, 'id', rnd() < 0.95 ? pick(rnd, ['t1', 't2', '', 0, -0, NaN, undefined, 1n, value(c, rnd)]) : ABSENT);
    maybe(t, 'name', stamp(c, rnd));
    maybe(t, 'startedAt', stamp(c, rnd));
    maybe(t, 'endedAt', rnd() < 0.3 ? null : stamp(c, rnd));
    if (derived) maybe(t, 'isError', stamp(c, rnd));
    else {
      maybe(t, 'is_error', stamp(c, rnd));
      if (rnd() < 0.3) maybe(t, 'isError', stamp(c, rnd));
    }
    return t;
  };
  const TOLPOOL = [0, -0, -5, NaN, Infinity, 2000, 1999.5, 2000.5, '2000', '2e3', '2000n', '', null, true, undefined, -2000n, 0n, 2n ** 80n,
    Object(2000n), [2000], [1, 2], {}, new Number(2000), new Date(2000), () => 2000, /2000/, { valueOf() { return 2000; } },
    { valueOf() { return 2000n; } }, { [Symbol.toPrimitive](h) { return h; } }, { [Symbol.toPrimitive]: 5 }, Object.create(null), Symbol('tol')];
  const options = (c, rnd) => {
    const r = rnd();
    if (r < 0.3) return ABSENT;
    if (r < 0.4) return pick(rnd, [null, undefined, 5, 's', true, Symbol('o'), 1n, {}, Object.freeze({}), Object.create(null)]);
    if (r < 0.5) return {};
    const o = {};
    if (rnd() < 0.9) o.toleranceMs = pick(rnd, TOLPOOL);
    return o;
  };
  for (let seed = 1; seed <= 900; seed++) {
    addFuzz('deriveToolTiming', `FZ.deriveToolTiming:${seed}`, c => { const rnd = mulberry32(seed * 7919); return [records(c, rnd)]; });
    addFuzz('deriveOpenTasks', `FZ.deriveOpenTasks:${seed}`, c => { const rnd = mulberry32(seed * 104729); return [records(c, rnd)]; });
    addFuzz('diffToolTiming', `FZ.diffToolTiming:${seed}`, c => {
      const rnd = mulberry32(seed * 1299709);
      return [
        sparse(rnd, Math.floor(rnd() * 5), () => (rnd() < 0.1 ? value(c, rnd) : toolLike(c, rnd, true))),
        sparse(rnd, Math.floor(rnd() * 5), () => (rnd() < 0.1 ? value(c, rnd) : toolLike(c, rnd, false))),
        options(c, rnd),
      ].filter(v => v !== ABSENT);
    });
  }
}

// ---- mutation self-check --------------------------------------------------
// Each entry rewrites one rule of the frozen source ([label, find, replace,
// nth occurrence]); at least one corpus case must notice every one of them,
// otherwise a green differential would say nothing about that rule.
const MUTATIONS = [
  ['deriveToolTiming: !record.event guard dropped', 'if (!record || !record.event) continue;', 'if (!record) continue;', 1],
  ['deriveOpenTasks: !record.event guard dropped', 'if (!record || !record.event) continue;', 'if (!record) continue;', 2],
  ["deriveToolTiming: 'assistant' renamed", "if (event.type === 'assistant') {", "if (event.type === 'assistants') {", 1],
  ['deriveToolTiming: assistant blocks ignored', 'for (const block of contentBlocks(event)) {', 'for (const block of []) {', 1],
  ['deriveToolTiming: user blocks ignored', 'for (const block of contentBlocks(event)) {', 'for (const block of []) {', 2],
  ["deriveToolTiming: falsy tool_use id accepted", "if (!block || block.type !== 'tool_use' || !block.id) continue;", "if (!block || block.type !== 'tool_use') continue;", 1],
  ['deriveToolTiming: duplicate tool_use re-opens', 'if (!byId.has(block.id)) {', 'if (true) {', 1],
  ["deriveToolTiming: name without || ''", "name: block.name || ''", 'name: block.name', 1],
  ['deriveToolTiming: startedAt re-reads record.ts', 'startedAt: ts,', 'startedAt: record.ts,', 1],
  ['deriveToolTiming: order.unshift', 'order.push(block.id);', 'order.unshift(block.id);', 1],
  ["deriveToolTiming: 'user' renamed", "} else if (event.type === 'user') {", "} else if (event.type === 'users') {", 1],
  ["deriveToolTiming: falsy tool_use_id accepted", "if (!block || block.type !== 'tool_result' || !block.tool_use_id) continue;", "if (!block || block.type !== 'tool_result') continue;", 1],
  ['deriveToolTiming: duplicate results overwrite', 'if (!tool || tool.endedAt !== null) continue;', 'if (!tool) continue;', 1],
  ['deriveToolTiming: isError always true', 'tool.isError = !!block.is_error;', 'tool.isError = true;', 1],
  ['deriveToolTiming: isError reads is_error twice', 'tool.isError = !!block.is_error;', 'tool.isError = !!(block.is_error || block.is_error);', 1],
  ['deriveToolTiming: endedAt re-reads record.ts', 'tool.endedAt = ts;', 'tool.endedAt = record.ts;', 1],
  ['contentBlocks: message read once', 'const content = event && event.message && event.message.content;', 'const content = event && event.message.content;', 1],
  ['contentBlocks: message read three times', 'const content = event && event.message && event.message.content;', 'const content = event && event.message && event.message && event.message.content;', 1],
  ['contentBlocks: content not array-checked', 'return Array.isArray(content) ? content : [];', 'return content;', 1],
  ['diffToolTiming: DEFAULT_TOLERANCE_MS is 2001', 'const DEFAULT_TOLERANCE_MS = 2000;', 'const DEFAULT_TOLERANCE_MS = 2001;', 1],
  ['diffToolTiming: destructured default is 2001', '{ toleranceMs = DEFAULT_TOLERANCE_MS } = {}', '{ toleranceMs = 2001 } = {}', 1],
  ['diffToolTiming: blob entries with falsy id indexed', 'if (tool && tool.id) blobById.set(tool.id, tool);', 'if (tool) blobById.set(tool.id, tool);', 1],
  ['diffToolTiming: missing_from_blob key order', "mismatches.push({ id: d.id, kind: 'missing_from_blob', name: d.name });", "mismatches.push({ kind: 'missing_from_blob', id: d.id, name: d.name });", 1],
  ["diffToolTiming: name check without || ''", "if ((b.name || '') !== d.name) {", 'if (b.name !== d.name) {', 1],
  ['diffToolTiming: name_mismatch key order', "mismatches.push({ id: d.id, kind: 'name_mismatch', derived: d.name, blob: b.name });", "mismatches.push({ id: d.id, kind: 'name_mismatch', blob: b.name, derived: d.name });", 1],
  ['diffToolTiming: blob start not finite-checked', 'const bStart = Number.isFinite(b.startedAt) ? b.startedAt : null;', 'const bStart = b.startedAt;', 1],
  ['diffToolTiming: blob end not finite-checked', 'const bEnd = Number.isFinite(b.endedAt) ? b.endedAt : null;', 'const bEnd = b.endedAt;', 1],
  ['diffToolTiming: null blob start not flagged', 'if (bStart === null || Math.abs(bStart - d.startedAt) > toleranceMs) {', 'if (Math.abs(bStart - d.startedAt) > toleranceMs) {', 1],
  ['diffToolTiming: startedAt drift boundary is >=', 'Math.abs(bStart - d.startedAt) > toleranceMs', 'Math.abs(bStart - d.startedAt) >= toleranceMs', 1],
  ['diffToolTiming: startedAt_drift reads b.startedAt again', "mismatches.push({ id: d.id, kind: 'startedAt_drift', derived: d.startedAt, blob: bStart });", "mismatches.push({ id: d.id, kind: 'startedAt_drift', derived: d.startedAt, blob: b.startedAt });", 1],
  ['diffToolTiming: d.endedAt == null', 'if (d.endedAt === null) {', 'if (d.endedAt == null) {', 1],
  ['diffToolTiming: fabricated end inverted', "if (bEnd !== null) mismatches.push({ id: d.id, kind: 'endedAt_fabricated_in_blob', blob: bEnd });", "if (bEnd === null) mismatches.push({ id: d.id, kind: 'endedAt_fabricated_in_blob', blob: bEnd });", 1],
  ['diffToolTiming: null blob end not flagged', '} else if (bEnd === null || Math.abs(bEnd - d.endedAt) > toleranceMs) {', '} else if (Math.abs(bEnd - d.endedAt) > toleranceMs) {', 1],
  ['diffToolTiming: endedAt drift boundary is >=', 'Math.abs(bEnd - d.endedAt) > toleranceMs', 'Math.abs(bEnd - d.endedAt) >= toleranceMs', 1],
  ['diffToolTiming: is_error read after isError', 'if (!!(b.is_error || b.isError) !== d.isError) {', 'if (!!(b.isError || b.is_error) !== d.isError) {', 1],
  ["diffToolTiming: isError_mismatch derived hardcoded", "mismatches.push({ id: d.id, kind: 'isError_mismatch', derived: d.isError });", "mismatches.push({ id: d.id, kind: 'isError_mismatch', derived: !d.isError });", 1],
  ["diffToolTiming: missing_from_journal without name", "mismatches.push({ id, kind: 'missing_from_journal', name: b.name });", "mismatches.push({ id, kind: 'missing_from_journal' });", 1],
  ['deriveToolTiming: record destructure order', 'const { event, ts } = record;', 'const { ts, event } = record;', 1],
  ['deriveOpenTasks: record destructure order', 'const { event, ts } = record;', 'const { ts, event } = record;', 2],
  ["deriveOpenTasks: 'monitor_started' renamed", "if (event.type === 'monitor_started' && event.task_id) {", "if (event.type === 'monitor_starteds') {", 1],
  ["deriveOpenTasks: monitor_started without task_id guard", "if (event.type === 'monitor_started' && event.task_id) {", "if (event.type === 'monitor_started') {", 1],
  ['deriveOpenTasks: description/command swapped', "description: event.description || event.command || '',", "description: event.command || event.description || '',", 1],
  ['deriveOpenTasks: lastTs re-reads record.ts', "lastTs: ts,\n      });\n    } else if (event.type === 'monitor_progress'", "lastTs: record.ts,\n      });\n    } else if (event.type === 'monitor_progress'", 1],
  ["deriveOpenTasks: 'monitor_progress' renamed", "} else if (event.type === 'monitor_progress' && event.task_id && tasks.has(event.task_id)) {", "} else if (event.type === 'monitor_progresss' && event.task_id && tasks.has(event.task_id)) {", 1],
  ['deriveOpenTasks: orphan progress fabricates a task', "} else if (event.type === 'monitor_progress' && event.task_id && tasks.has(event.task_id)) {", "} else if (event.type === 'monitor_progress' && event.task_id) {", 1],
  ["deriveOpenTasks: 'monitor_done' renamed", "} else if (event.type === 'monitor_done' && event.task_id) {", "} else if (event.type === 'monitor_dones' && event.task_id) {", 1],
  ['deriveOpenTasks: monitor_done without task_id guard', "} else if (event.type === 'monitor_done' && event.task_id) {", "} else if (event.type === 'monitor_done') {", 1],
  ['deriveOpenTasks: done does not delete', 'tasks.delete(event.task_id);', ';', 1],
  ["deriveOpenTasks: 'background_tasks' renamed", "} else if (event.type === 'background_tasks' && Array.isArray(event.tasks)) {", "} else if (event.type === 'background_taskss' && Array.isArray(event.tasks)) {", 1],
  ['deriveOpenTasks: tasks not array-checked', "} else if (event.type === 'background_tasks' && Array.isArray(event.tasks)) {", "} else if (event.type === 'background_tasks') {", 1],
  ['deriveOpenTasks: snapshot entries ignored', 'for (const t of event.tasks) {', 'for (const t of []) {', 1],
  ['deriveOpenTasks: id source swapped', 'const id = t && (t.task_id || t.id);', 'const id = t && (t.id || t.task_id);', 1],
  ['deriveOpenTasks: unknown snapshot ids fabricated', 'if (id && tasks.has(id)) touch(id, { lastTs: ts });', 'if (id) touch(id, { lastTs: ts });', 1],
  ['deriveOpenTasks: task key order', "tasks.set(id, { task_id: id, description: '', lastTs: null, ...fields });", "tasks.set(id, { description: '', task_id: id, lastTs: null, ...fields });", 1],
  ['deriveOpenTasks: retouch dropped', 'Object.assign(tasks.get(id), fields);', ';', 1],
  ['deriveOpenTasks: deleted tasks kept', 'return order.map(id => tasks.get(id)).filter(Boolean);', 'return order.map(id => tasks.get(id));', 1],
];

function mutate(source, [label, find, replace, nth]) {
  let at = -1;
  for (let n = 0; n < nth; n++) {
    at = source.indexOf(find, at + 1);
    assert.notEqual(at, -1, `mutation anchor not found (${label}): ${find}`);
  }
  return source.slice(0, at) + replace + source.slice(at + find.length);
}

test('current module reproduces the frozen legacy module on the fixed corpus', () => {
  const coldLegacy = () => compileModule(frozenSource());
  const mismatches = [];
  const legacyHash = crypto.createHash('sha256');
  const currentHash = crypto.createHash('sha256');
  const coverage = { cases: 0, throws: 0, typeErrors: 0, sameRef: 0, ownUndefined: 0, bigint: 0, symbol: 0, passthrough: 0, traced: 0, kinds: new Set(), iterSites: new Set(), iterTraced: {} };
  for (const cs of [...CORPUS, ...FUZZ]) {
    const a = trial(coldLegacy(), cs.fn, cs.make);
    const b = trial(coldCurrent(), cs.fn, cs.make);
    legacyHash.update(`${cs.name}\n${a.text}\n`);
    currentHash.update(`${cs.name}\n${b.text}\n`);
    coverage.cases += 1;
    assert.ok(!a.text.includes('mod[fn]') && !b.text.includes('mod[fn]'), `case ${cs.name} is not registered against a module function`);
    if (a.text !== b.text) {
      if (mismatches.length < 10) mismatches.push(`${cs.name}\n--- legacy\n${a.text}\n--- current\n${b.text}`);
      continue;
    }
    coverage.throws += a.out.throws ? 1 : 0;
    coverage.typeErrors += a.out.ctor === 'TypeError' ? 1 : 0;
    // The viewer prints a repeated reference as a bare "@k" string.
    coverage.sameRef += /(?<!"ref")[,:]"@\d+"/.test(a.text) ? 1 : 0;
    coverage.ownUndefined += /\["[a-z_]+","wec","undefined"\]/.test(a.text) ? 1 : 0;
    coverage.bigint += /\d+n"/.test(a.text) ? 1 : 0;
    coverage.symbol += /"t":"symbol"/.test(a.text) ? 1 : 0;
    coverage.passthrough += /"corpus":true/.test(a.text) ? 1 : 0;
    coverage.traced += a.trace.length ? 1 : 0;
    for (const m of [TERNARY_NOT_ITERABLE, SITES.content.notIterable, SITES.tasks.notIterable]) if (a.text.includes(m)) coverage.iterSites.add(m);
    if (cs.name.startsWith('ITER.') && a.trace.length) { const site = cs.name.slice('ITER.'.length).split(':')[0]; coverage.iterTraced[site] = (coverage.iterTraced[site] || 0) + 1; }
    // A mismatch entry is viewed as [key, descriptor, value], so the kind is a quoted string inside a string.
    for (const m of a.text.matchAll(/\["kind","wec","\\"([A-Za-z_]+)\\""\]/g)) coverage.kinds.add(m[1]);
  }
  assert.deepEqual(mismatches, [], `differential mismatches (first ${mismatches.length} shown)`);
  // The corpus must actually exercise the rules it claims to guard.
  assert.ok(coverage.cases > 4000, `cases ${coverage.cases}`);
  assert.ok(coverage.throws > 100 && coverage.typeErrors > 50, JSON.stringify(coverage));
  assert.ok(coverage.sameRef >= 1, 'a reopened id is returned as the same object twice');
  assert.ok(coverage.ownUndefined >= 1, 'an own property holding undefined');
  assert.ok(coverage.bigint >= 1 && coverage.symbol >= 1 && coverage.passthrough >= 1, JSON.stringify(coverage));
  assert.ok(coverage.traced >= 60, `traced ${coverage.traced}`);
  // Every loop head is actually iterated: its own "not iterable" text is seen
  // and its iterator traps (proxy, return(), finally) are traced.
  assert.equal(coverage.iterSites.size, 3, JSON.stringify([...coverage.iterSites]));
  assert.deepEqual(Object.keys(coverage.iterTraced).sort(), ['blob', 'content', 'derived', 'records', 'recordsOpen', 'tasks']);
  assert.ok(Object.values(coverage.iterTraced).every(n => n >= 3), JSON.stringify(coverage.iterTraced));
  assert.deepEqual(
    [...coverage.kinds].sort(),
    ['endedAt_drift', 'endedAt_fabricated_in_blob', 'isError_mismatch', 'missing_from_blob', 'missing_from_journal', 'name_mismatch', 'startedAt_drift'],
  );
  if (process.env.TURN_EVENT_REPLAY_DIFF_DIGEST) {
    fs.writeFileSync(process.env.TURN_EVENT_REPLAY_DIFF_DIGEST, `${JSON.stringify({
      legacyBlob: LEGACY_BLOB,
      cases: coverage.cases,
      corpus: CORPUS.length,
      fuzz: FUZZ.length,
      coverage: { ...coverage, kinds: [...coverage.kinds].sort() },
      legacySha256: legacyHash.digest('hex'),
      currentSha256: currentHash.digest('hex'),
    }, null, 2)}\n`);
  }
});

test('the corpus observes every mutated rule of the frozen source', () => {
  const coldLegacy = () => compileModule(frozenSource());
  const baseline = CORPUS.map(cs => trial(coldLegacy(), cs.fn, cs.make).text);
  const escaped = [];
  const caughtBy = {};
  for (const m of MUTATIONS) {
    const first = CORPUS.find((cs, i) => trial(compileModule(mutate(frozenSource(), m)), cs.fn, cs.make).text !== baseline[i]);
    if (first) caughtBy[m[0]] = first.name; else escaped.push(m[0]);
  }
  assert.deepEqual(escaped, [], `no corpus case notices: ${escaped.join('; ')}`);
  if (process.env.TURN_EVENT_REPLAY_MUTATION_DIGEST) {
    fs.writeFileSync(process.env.TURN_EVENT_REPLAY_MUTATION_DIGEST, `${JSON.stringify({ mutations: MUTATIONS.length, caughtBy }, null, 2)}\n`);
  }
});

test('module surface is frozen with the four public names', () => {
  const mod = require('../src/chat/turn-event-replay');
  assert.ok(Object.isFrozen(mod));
  assert.deepEqual(Object.keys(mod), ['deriveToolTiming', 'diffToolTiming', 'deriveOpenTasks', 'DEFAULT_TOLERANCE_MS']);
  assert.deepEqual(
    Object.values(mod).map(v => (typeof v === 'function' ? `${v.name}/${v.length}` : `${typeof v}=${v}`)),
    ['deriveToolTiming/1', 'diffToolTiming/2', 'deriveOpenTasks/1', 'number=2000'],
  );
  for (const entry of [mod.deriveToolTiming, mod.diffToolTiming, mod.deriveOpenTasks]) {
    assert.deepEqual(Reflect.construct(entry, [[], []]), []);
  }
});

test('current module pins identity, key order, descriptors, tolerance boundary and error texts', () => {
  const [t] = deriveToolTiming([toolUse('t1', 'Bash', null), toolResult('t1', true)]);
  assert.deepEqual(Object.keys(t), ['id', 'name', 'startedAt', 'endedAt', 'isError']);
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  for (const k of Object.keys(t)) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(t, k), { value: t[k], writable: true, enumerable: true, configurable: true }, k);
  }
  assert.equal(t.isError, true);

  const [task] = deriveOpenTasks([started('a', 'A')]);
  assert.deepEqual(Object.keys(task), ['task_id', 'description', 'lastTs']);
  assert.equal(Object.getPrototypeOf(task), Object.prototype);
  // An id reopened after a delete keeps both order slots, so the same new
  // object is returned twice.
  const reopened = deriveOpenTasks([started('a', 'A'), done('a'), started('a', 'A2')]);
  assert.equal(reopened.length, 2);
  assert.equal(reopened[0], reopened[1]);
  assert.equal(reopened[0].description, 'A2');

  // A getter yielding a fresh object per read: block.id is read five times on
  // first sighting, so the stored key and the ordered id are different
  // objects and the final lookup misses.
  const freshIds = deriveToolTiming([{ event: { type: 'assistant', message: { content: [{ type: 'tool_use', get id() { return {}; }, name: 'T' }] } } }]);
  assert.deepEqual(freshIds, [undefined]);

  // Drift equal to the tolerance is absorbed, on either side of the BigInt line.
  assert.deepEqual(diffToolTiming([tool('t')], [blobTool('t', 'T', 3000, 4000)]), []);
  assert.deepEqual(diffToolTiming([tool('t')], [blobTool('t', 'T', 3000.5, 4000)]).map(m => m.kind), ['startedAt_drift']);
  assert.deepEqual(diffToolTiming([tool('t')], [blobTool('t', 'T', 3000, 4000)], { toleranceMs: 2000n }), []);
  assert.deepEqual(diffToolTiming([tool('t')], [blobTool('t', 'T', 3000, 4000)], { toleranceMs: 1999n }).map(m => m.kind), ['startedAt_drift', 'endedAt_drift']);
  assert.deepEqual(diffToolTiming([tool('t')], [blobTool('t', 'T', 3000, 4000)], { toleranceMs: '2000' }), []);

  const cold = coldCurrent();
  assert.throws(() => cold.diffToolTiming([null], []), { name: 'TypeError', message: "Cannot read properties of null (reading 'id')" });
  assert.throws(() => cold.diffToolTiming([], [], null), { name: 'TypeError', message: "Cannot read properties of null (reading 'toleranceMs')" });
  assert.throws(() => cold.deriveToolTiming(Object.assign([use()], { [Symbol.iterator]: 5 })), { name: 'TypeError', message: TERNARY_NOT_ITERABLE });
  assert.throws(() => cold.deriveToolTiming([{ event: { type: 'assistant', message: { content: Object.assign([1], { [Symbol.iterator]: 5 }) } } }]), { name: 'TypeError', message: SITES.content.notIterable });
  assert.throws(() => cold.deriveOpenTasks([{ event: { type: 'background_tasks', tasks: Object.assign([1], { [Symbol.iterator]: 5 }) } }]), { name: 'TypeError', message: SITES.tasks.notIterable });
  assert.throws(() => cold.diffToolTiming([tool('t', 'T', 1n)], [blobTool()]), { name: 'TypeError', message: 'Cannot mix BigInt and other types, use explicit conversions' });
  assert.throws(() => cold.diffToolTiming([tool('t', 'T', Symbol('s'))], [blobTool()]), { name: 'TypeError', message: 'Cannot convert a Symbol value to a number' });
  assert.throws(() => cold.diffToolTiming([tool()], [blobTool()], { toleranceMs: { [Symbol.toPrimitive]: 5 } }), { name: 'TypeError', message: 'number 5 is not a function' });
  assert.throws(() => cold.deriveOpenTasks(Object.assign([started()], { [Symbol.iterator]: () => ({ next: () => 7n }) })), { name: 'TypeError', message: 'Iterator result 7 is not an object' });

  // Read-order contract, locked directly (the counts come from the frozen source).
  const trace = [];
  const ev = { type: 'assistant', message: { content: [withReads({ trace }, 'b', { type: ['tool_use'], id: ['t', 't', 't', 't', 't'], name: ['T'] })] } };
  deriveToolTiming([withReads({ trace }, 'rec', { event: [ev], ts: [7] })]);
  assert.deepEqual(trace, ['rec.event#1', 'rec.event#2', 'rec.ts#1', 'b.type#1', 'b.id#1', 'b.id#2', 'b.id#3', 'b.id#4', 'b.name#1', 'b.id#5']);
});

test('scripts/turn-event-report.js still runs on the module (journal -> derived -> blob parity)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-event-report-'));
  try {
    fs.mkdirSync(path.join(dir, 'chat_history', 'turn-events'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chat_history', 'turn-events', 's1.events.jsonl'), `${[
      line(1, 1000, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
      line(2, 4000, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      line(3, 5000, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } }),
    ].map(l => JSON.stringify(l)).join('\n')}\n`);
    const blob = path.join(dir, 'chat_history', 's1.json');
    const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'turn-event-report.js'), 's1', '--dir', dir], { encoding: 'utf8' });
    fs.writeFileSync(blob, JSON.stringify({ messages: [{ tools: [
      { id: 't1', name: 'Bash', startedAt: 1010, endedAt: 3990, is_error: false },
      { id: 't2', name: 'Read', startedAt: 5010 },
    ] }] }));
    const parity = run();
    assert.equal(parity.status, 0, parity.stderr || parity.stdout);
    assert.match(parity.stdout, /2 tools derived/);
    assert.match(parity.stdout, /blob parity: 2 tools in blob, 0 mismatch\(es\)/);

    fs.writeFileSync(blob, JSON.stringify({ messages: [{ tools: [{ id: 't1', name: 'bash', startedAt: 90000, endedAt: 3990 }] }] }));
    const drifted = run();
    assert.equal(drifted.status, 1, drifted.stderr || drifted.stdout);
    assert.match(drifted.stdout, /blob parity: 1 tools in blob, [1-9]\d* mismatch\(es\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重连保留高基数标识的引用、重开顺序和同一任务对象', () => {
  const ids = Array.from({ length: 1024 }, (_, i) => {
    switch (i % 4) {
      case 0: return Object.freeze({ name: '同名' });
      case 1: return Symbol('同名');
      case 2: return function task() {};
      default: return Symbol.for('replay-' + i);
    }
  });
  const records = ids.map(id => started(id));
  records.push(...ids.map(id => done(id)));
  records.push(...ids.slice().reverse().map(id => started(id)));
  records.push(snapshot(ids.map(id => ({ task_id: id })), 6000));
  const tasks = deriveOpenTasks(records);
  assert.equal(tasks.length, ids.length * 2);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(tasks[i].task_id, ids[i]);
    assert.equal(tasks[i].lastTs, 6000);
    assert.equal(tasks[i], tasks[tasks.length - 1 - i]);
  }
});

test('重连按冻结顺序读取实时 Map 方法与任务标识', () => {
  const legacy = require('./helpers/legacy-turn-event-replay');
  function trace(derive) {
    const previous = global.Map;
    const events = [];
    class TracedMap extends previous {
      has(id) { events.push('has ' + id); return super.has(id); }
      set(id, task) { events.push('set ' + id); return super.set(id, task); }
      get(id) { events.push('get ' + id); return super.get(id); }
      delete(id) { events.push('delete ' + id); return super.delete(id); }
    }
    const update = { type: 'monitor_progress', get task_id() {
      events.push('id');
      return 't';
    } };
    global.Map = TracedMap;
    try {
      const tasks = derive([started('t'), { event: update, ts: 2000 }, done('t'), started('t')]);
      return { events, sameTask: tasks[0] === tasks[1] };
    } finally {
      global.Map = previous;
    }
  }
  const expected = trace(legacy.deriveOpenTasks);
  assert.ok(expected.events.includes('delete t'));
  assert.deepEqual(trace(deriveOpenTasks), expected);
});

test('重连遇到不可调用的 Map 方法时保留参数读取顺序和异常', () => {
  const legacy = require('./helpers/legacy-turn-event-replay').deriveOpenTasks;
  function capture(derive, method) {
    const original = global.Map;
    const trace = [];
    class BadMap extends original {}
    Object.defineProperty(BadMap.prototype, method, { get() {
      trace.push(method);
      return 0;
    } });
    const records = [started('t'), { event: {
      type: 'monitor_done',
      get task_id() { trace.push('id'); return 't'; },
    } }];
    global.Map = BadMap;
    let thrown;
    try { derive(records); } catch (error) { thrown = error; }
    finally { global.Map = original; }
    assert.ok(thrown instanceof TypeError);
    return [trace, thrown.message];
  }
  for (const method of ['has', 'set', 'delete', 'get']) {
    assert.deepEqual(capture(deriveOpenTasks, method), capture(legacy, method));
  }
});
