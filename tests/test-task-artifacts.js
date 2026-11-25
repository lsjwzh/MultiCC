'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { collectTaskArtifacts } = require('../src/task-shell/artifacts');
const { fixture } = require('./helpers/task-shell');
const { fakeApp, mountHost } = require('./helpers/task-shell-host');
const entry = messages => ({ task: { id: 'tsk_a', title: 'Task A' }, sessionId: 'task-a', messages });
const message = (content, extra = {}) => ({ role: 'assistant', taskId: 'tsk_a', content, ts: 1000, ...extra });
const row = (artifact, extra = {}) => ({ kind: 'page', title: artifact, url: `/artifacts/${artifact}/index.html`, ...extra });

test('task artifacts merge registry metadata and full transcript references without duplicates', () => {
  const messages = [message('[Report](/artifacts/report/index.html) /artifacts/report/index.html?view=all'),
    message('/artifacts/report/chart.png', { ts: 2000 }),
    message('', { tools: [{ result: 'published /artifacts/tool/data.csv' }] })];
  const result = collectTaskArtifacts(entry(messages), [row('report', { title: 'Report title', createdAt: '2026-09-11T01:00:00Z' }), row('early', { taskId: 'tsk_a' })], () => true);
  assert.equal(result.items.length, 4);
  assert.equal(result.items[0].title, 'Report title');
  assert.equal(result.items.find(i => i.url.endsWith('chart.png')).kind, 'file');
  assert.ok(result.items.some(i => i.artifactId === 'early'), 'registered before the final reply');
  assert.equal(result.items.some(i => i.expired), false);
});

test('task scope excludes other tasks, user references, inherited context and tool input examples', () => {
  const messages = [message('/artifacts/own/index.html'), message('/artifacts/foreign/index.html', { taskId: 'tsk_b' }),
    message('/artifacts/user/index.html', { role: 'user' }), message('/artifacts/inherited/index.html', { inherited: true }),
    message('', { tools: [{ input: '/artifacts/input/index.html', result: '/artifacts/error/index.html', is_error: true }] })];
  const result = collectTaskArtifacts(entry(messages), [row('other-task', { taskId: 'tsk_b', sessionId: 'task-a' }),
    row('shared', { sessionId: 'shared-shell' }), row('legacy', { sessionId: 'task-a' }),
    row('service', { taskId: 'tsk_a', kind: 'service' })]);
  assert.deepEqual(result.items.map(i => i.artifactId).sort(), ['legacy', 'own']);
  assert.deepEqual(collectTaskArtifacts({ ...entry([]), sessionId: 'shared-shell' }, [row('shared', { sessionId: 'shared-shell' })]).items, []);
});

test('missing files remain visible and traversal or external lookalikes are rejected', () => {
  const messages = [message('/artifacts/gone/index.html /artifacts/live/index.html https://other.test/artifacts/external/index.html /artifacts/live/../../private')];
  const result = collectTaskArtifacts(entry(messages), [], id => id !== 'gone');
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find(i => i.artifactId === 'gone').expired, true);
  assert.equal(result.items.find(i => i.artifactId === 'live').expired, false);
});

test('registered URL parameters survive collection and invalid legacy timestamps do not break the list', () => {
  const result = collectTaskArtifacts(entry([message('/artifacts/report/index.html', { ts: 1e30, tools: {} })]),
    [row('report', { url: '/artifacts/report/index.html?view=directories', taskId: 'tsk_a' })]);
  assert.equal(result.items[0].url, '/artifacts/report/index.html?view=directories');
  assert.equal(result.items[0].createdAt, null);
});

test('task artifact host ops follow the shell cursor, read historical tasks and do not start execution', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, { text: 'First', intent: 'work', clientMsgId: 'first' });
  f.statuses.set(first.sessionId, { busy: false });
  const second = await f.runtime.send(f.a.id, { text: 'Second', newTask: true, intent: 'work', clientMsgId: 'second' });
  f.histories.set(first.sessionId, [message('/artifacts/first/index.html', { taskId: first.taskId })]);
  f.histories.set(second.sessionId, [message('/artifacts/second/index.html', { taskId: second.taskId })]);
  const before = { sends: f.sends.length, creations: f.creations.length, view: f.runtime.view(f.a.id) };
  const { ok, fail } = mountHost(fakeApp(), { getRuntime: () => f.runtime,
    artifacts: async id => collectTaskArtifacts(await f.runtime.taskEntry(id), [], () => true) });
  const scope = await ok({ op: 'shell-artifacts-scope', shellId: f.a.id });
  assert.equal(scope.taskId, second.taskId);
  assert.deepEqual((await ok({ op: 'artifacts', taskId: scope.taskId })).items.map(i => i.artifactId), ['second']);
  assert.deepEqual((await ok({ op: 'artifacts', taskId: first.taskId })).items.map(i => i.artifactId), ['first']);
  assert.equal((await fail({ op: 'artifacts', taskId: 'missing' })).status, 404);
  assert.equal((await ok({ op: 'shell-artifacts-scope', shellId: f.b.id })).taskId, null);
  assert.deepEqual({ sends: f.sends.length, creations: f.creations.length, view: f.runtime.view(f.a.id) }, before);
});

test('task artifacts expose registry controls and sort permanent and pinned outputs above newer ones', () => {
  const result = collectTaskArtifacts(entry([message('/artifacts/unregistered/index.html')]), [
    row('plain', { id: 'plain-id', taskId: 'tsk_a', createdAt: '2026-10-16' }),
    row('pinned', { id: 'pin-id', taskId: 'tsk_a', pinned: true, createdAt: '2026-10-14' }),
    row('kept', { id: 'kept-id', taskId: 'tsk_a', permanent: true, createdAt: '2026-10-13' }),
    row('input', { id: 'input-id', taskId: 'tsk_a', retained: true, createdAt: '2026-10-12' }),
  ]);
  assert.deepEqual(result.items.slice(0, 3).map(i => i.artifactId), ['kept', 'pinned', 'plain']);
  assert.equal(result.items[0].registryId, 'kept-id');
  assert.equal(result.items[1].pinned, true);
  assert.equal(result.items.find(i => i.artifactId === 'input').retained, true);
  assert.equal(result.items.find(i => i.artifactId === 'unregistered').registryId, null);
});

test('artifact ops coalesce in-flight collects and memoize briefly per task', async () => {
  let collects = 0; let release; const gate = new Promise(done => { release = done; });
  const { ok } = mountHost(fakeApp(), {
    getRuntime: () => null,
    artifacts: async id => { collects += 1; if (collects === 1) await gate; return { taskId: id, title: '', items: [] }; },
    artifactsMemoMs: 60,
  });
  const inflight = [ok({ op: 'artifacts', taskId: 'tsk_a' }), ok({ op: 'artifacts', taskId: 'tsk_a' })];
  release();
  await Promise.all(inflight);
  assert.equal(collects, 1, '进行中的采集要合并成一个');
  await ok({ op: 'artifacts', taskId: 'tsk_a' });
  assert.equal(collects, 1, '完成后的短窗口内直接复用同一份结果');
  await new Promise(done => setTimeout(done, 70));
  await ok({ op: 'artifacts', taskId: 'tsk_a' });
  assert.equal(collects, 2, '窗口过后重新采集');
  await ok({ op: 'artifacts', taskId: 'tsk_b' });
  assert.equal(collects, 3, '不同任务各自采集');
});

test('a failed artifact collect is not memoized', async () => {
  let fails = true;
  const { ok, fail } = mountHost(fakeApp(), {
    getRuntime: () => null,
    artifacts: async id => { if (fails) throw Object.assign(new Error('boom'), { status: 500 }); return { taskId: id, title: '', items: [id] }; },
    artifactsMemoMs: 10_000,
  });
  const failed = await fail({ op: 'artifacts', taskId: 'tsk_b' });
  assert.equal(failed.status, 500);
  fails = false;
  const recovered = await ok({ op: 'artifacts', taskId: 'tsk_b' });
  assert.deepEqual(recovered.items, ['tsk_b'], '失败不能落缓存，下一轮要能恢复');
});

test('registry task titles are readable before the shell runtime has started', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createTaskShellHost } = require('../src/task-shell/host');
  const { createTaskShellStore } = require('../src/task-shell/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-task-title-'));
  const file = path.join(dir, 'shell.sqlite');
  const store = createTaskShellStore(file);
  store.set('task', 'tsk_saved', { id: 'tsk_saved', title: 'Saved title' }); store.close();
  const host = createTaskShellHost({ file, records: new Map() });
  t.after(() => { host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(host.artifactTaskTitle('tsk_saved'), 'Saved title');
  assert.equal(host.artifactTaskTitle('tsk_missing'), null);
});


// 产物引用识别已迁入 Rust，生产入口是 src/native/runtime.js 的 artifactReference 门面；旧实现
// 原样冻结在 tests/helpers/legacy-artifact-reference.js。下面用同一组固定输入逐项核对两个
// 实现：外部 URL、编码与空白、大小写与前导斜杠、循环与共享对象、getter 的次数与顺序、
// 深度/节点/引用上限、稳定排序，以及抛出异常的原对象。带结论的断言钉住语料确实走到了对应
// 分支，免得差分空转；改语料等于改契约。
test('artifact references match the frozen implementation on a fixed corpus', () => {
  const fs = require('node:fs'), path = require('node:path');
  const { compileFunction } = require('node:vm'), { createRequire } = require('node:module');
  const { createHash } = require('node:crypto');
  const file = path.resolve(__dirname, '../src/artifact-reference.js');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-artifact-reference.js'));
  assert.equal(createHash('sha1').update('blob ' + source.length + '\0').update(source).digest('hex'),
    '38c6509083b9f0c89d4db9e7118f4829a252c6e9');
  const mod = { exports: {} };
  compileFunction(source.toString(), ['module', 'require'], { filename: file })(mod, createRequire(file));
  const frozen = trace(mod.exports), live = trace(require('../src/native/runtime').artifactReference);
  assert.deepEqual(live, frozen);
  console.log(`artifact-reference differential: ${frozen.length} rows, sha256 ${createHash('sha256').update(JSON.stringify(frozen)).digest('hex')}`);
});

test('artifact traversal observes live built-ins and preserves iterator errors', () => {
  const original = require('./helpers/legacy-artifact-reference');
  const current = require('../src/native/runtime').artifactReference;
  function observe(api, make) {
    const values = Object.values, has = WeakSet.prototype.has, own = Object.prototype.hasOwnProperty;
    try { return api.extractArtifactReferences(make()); }
    catch (e) { return [e.name, e.message]; }
    finally { Object.values = values; WeakSet.prototype.has = has; Object.prototype.hasOwnProperty = own; }
  }
  const cases = [
    () => ({get artifactIds() { Object.values = function () { return this === Object ? ['/artifacts/got'] : []; }; }}),
    () => [{get artifactIds() { WeakSet.prototype.has = () => true; }}, {artifactId: 'ignored'}],
    () => [{get artifactIds() { Object.prototype.hasOwnProperty = () => false; }}, {artifactId: 'ignored'}],
    () => { let reads = 0; return {get artifactIds() { return ++reads === 1 ? [] : null; }}; },
    () => Object.assign([], { [Symbol.iterator]() { return 2; } }),
    () => Object.assign([], { [Symbol.iterator]() { return { next: 2 }; } }),
    () => Object.assign([], { [Symbol.iterator]() { return { next: () => 2 }; } }),
    () => ({get artifactIds() { Object.values = () => null; }}),
  ];
  for (const make of cases) assert.deepEqual(observe(current, make), observe(original, make));
});

function trace(api) {
  const { isArtifactId, normalizeRelativePath, extractArtifactReferences } = api;
  const sentinel = new Error('getter failed'), text = 'plain text', reason = Symbol('boom');
  const thrown = new Set([sentinel, text, reason]);
  let log = [];
  const rows = [];
  // 记下一次调用的结论：返回值、抛出值的种类与消息、是否就是原值，以及 getter 的调用轨迹。
  const run = (name, fn) => {
    let out;
    try { out = { value: show(fn()) }; }
    catch (error) { out = { error: error instanceof Error ? error.name : typeof error, message: String(error?.message ?? error), original: thrown.has(error) }; }
    rows.push([name, log, out]);
    log = [];
  };
  const expect = (wanted, fn) => assert.deepEqual(show(fn()), wanted);
  const of = value => () => value;
  const reads = entries => Object.defineProperties({}, Object.fromEntries(Object.entries(entries)
    .map(([key, read]) => [key, { enumerable: true, configurable: true, get() { log.push(key); return read(); } }])));
  const ref = (artifactId, relativePath = '') => ['artifactId,relativePath', artifactId, relativePath, true];
  const refs = names => names.map(name => ref(name));

  const ids = [undefined, null, true, false, 0, NaN, 1n, Symbol('id'), () => {}, {}, [], new String('ab'), '', 'a', 'A_b-9', '-_',
    'a'.repeat(128), 'a'.repeat(129), 'with space', 'café', '/artifacts/x', 'a/b', 'a.b', 'a\u0000b', '\ud83d', '😀', 'a\n', '﻿a', 'ａ'];
  ids.forEach((value, index) => run(['id', index], () => isArtifactId(value)));
  expect(true, () => isArtifactId('A_b-9'));
  expect(false, () => isArtifactId('a'.repeat(129)));
  expect(false, () => isArtifactId(new String('ab')));
  expect(false, () => isArtifactId('﻿a'));

  const wide = (first, rest) => [first, ...Array.from({ length: 31 }, () => rest)].join('/');
  const paths = [undefined, null, 123, true, Symbol('p'), '', '/', '//', '///', 'a/', 'a//', 'a/b//', 'a///b//', '/a', '//a', 'a?b', 'a#b', 'a\\b',
    'a/b', './a', 'a/./b', '../a', 'a/../b', 'a//b', '.hidden/x', 'a.b@c+d-e_f', 'a'.repeat(255), 'a'.repeat(256), '-x', '_x', '.x', '@x',
    '+x', '~x', 'x y', 'x,y', 'x\ty', 'é', 'a/B', 'A/b', '😀/x', 'a\u0000b', 'a/'.repeat(32), 'a/'.repeat(33), 'a/'.repeat(31) + 'b',
    wide('a'.repeat(31), 'a'.repeat(31)), wide('a'.repeat(32), 'a'.repeat(31)), wide('a'.repeat(33), 'a'.repeat(31)), 'a'.repeat(1023) + '/', 'a'.repeat(1025)];
  paths.forEach((value, index) => run(['path', index], () => normalizeRelativePath(value)));
  expect('', () => normalizeRelativePath('///'));
  expect('a/b', () => normalizeRelativePath('a/b//'));
  expect(null, () => normalizeRelativePath('a///b//'));
  expect(null, () => normalizeRelativePath('/a'));
  expect('a/'.repeat(31) + 'a', () => normalizeRelativePath('a/'.repeat(32)));
  expect(null, () => normalizeRelativePath('a/'.repeat(33)));
  expect(wide('a'.repeat(32), 'a'.repeat(31)), () => normalizeRelativePath(wide('a'.repeat(32), 'a'.repeat(31))));
  expect(null, () => normalizeRelativePath(wide('a'.repeat(33), 'a'.repeat(31))));

  const texts = ['', 'no refs', '/artifacts/', '/artifacts/a', '/artifacts/a/', '/artifacts/a/index.html', '/artifacts/a/index.html?x=1#frag',
    '/artifacts/A_b-9/x+y@z.w', '"/artifacts/a"', "'/artifacts/a'", '`/artifacts/a`', '(/artifacts/a)', '</artifacts/a>', '[/artifacts/a]',
    '{/artifacts/a}', '=/artifacts/a', '：/artifacts/a', ' /artifacts/a', '　/artifacts/a', ' /artifacts/a', '﻿/artifacts/a',
    '\u0085/artifacts/a', 'https://x.test/artifacts/a', 'http:/artifacts/a', 'foo:bar/artifacts/a', 'src=/artifacts/a',
    'src="//host/artifacts/a"', 'src=//host/artifacts/a', 'a//artifacts/b', '//artifacts/a', 'mailto:=/artifacts/a', 'http:=/artifacts/a',
    '1a:=/artifacts/a', 'a+b.c-d:=/artifacts/a', 'ab!=/artifacts/a', '//=/artifacts/a', 'a=//=/artifacts/a', ' =/artifacts/a', '/artifacts/a,',
    '/artifacts/a);/artifacts/b!', '/artifacts/a<b>', '/artifacts/a?x=/artifacts/b', '/artifacts/a /artifacts/a /artifacts/a/',
    '/artifacts/c/x /artifacts/a/z /artifacts/a /artifacts/b', '/artifacts/b /artifacts/B /artifacts/_x /artifacts/a-b /artifacts/a_b /artifacts/A/b',
    '/artifacts/a/_ /artifacts/a/A /artifacts/a/z', '/Artifacts/a', '/artifacts/%61', '/artifacts/a%2Fb', '/artifacts/a%20b',
    '/artifacts/a/b%20c', '/artifacts/../../x', '/artifacts/a/./b', '/artifacts/a/b/../c', '/artifacts/a//b', `/artifacts/${'a'.repeat(128)}`,
    `/artifacts/${'a'.repeat(129)}`, `/artifacts/a/${'b'.repeat(300)}`, `/artifacts/a/${'b/'.repeat(40)}x`, `/artifacts/a/${'b/'.repeat(31)}x`,
    '/artifacts/a b', '😀 /artifacts/a \ud83d/artifacts/b', '/artifacts/a\u0000b', '/artifacts/a,b/c?d#e', '/ARTIFACTS/a /artifacts/a',
    '/artifacts/ab/artifacts/cd', '/artifacts-/x', '/artifacts_x', 'x/artifacts/a', 'x/./artifacts/a', '/artifacts/a\t\n/artifacts/b',
    'x'.repeat(5000) + ' /artifacts/late', '/artifacts/a'.repeat(300)];
  texts.forEach((value, index) => run(['text', index], () => extractArtifactReferences(value)));
  const many = (count, prefix) => Array.from({ length: count }, (_, index) => `/artifacts/${prefix}${index}`).join(' ');
  run(['text', 'cap'], () => extractArtifactReferences(many(300, 'id')));
  run(['text', 'duplicates'], () => extractArtifactReferences('/artifacts/a /artifacts/b /artifacts/c '.repeat(100)));
  expect([], () => extractArtifactReferences('https://x.test/artifacts/a'));
  expect([], () => extractArtifactReferences('\u0085/artifacts/a'));
  expect([ref('a')], () => extractArtifactReferences('　/artifacts/a'));
  expect([ref('a'), ref('a', 'z'), ref('b'), ref('c', 'x')],
    () => extractArtifactReferences('/artifacts/c/x /artifacts/a/z /artifacts/a /artifacts/b'));
  expect(refs(Array.from({ length: 256 }, (_, index) => `id${index}`).sort()), () => extractArtifactReferences(many(300, 'id')));
  expect(refs(['a', 'b', 'c']), () => extractArtifactReferences('/artifacts/a /artifacts/b /artifacts/c '.repeat(100)));
  [undefined, null, 0, false, true, NaN, 10n, Symbol('content'), () => {}].forEach((value, index) => run(['root', index], () => extractArtifactReferences(value)));

  const tree = (name, build) => run(['tree', name], () => extractArtifactReferences(build()));
  // 根的深度是 0；第 32 层还会读，第 33 层不再读。
  const chain = depth => { let node = '/artifacts/deep'; for (let index = 0; index < depth; index += 1) node = { child: node }; return node; };
  const nesting = depth => { let node = ['/artifacts/deep-list']; for (let index = 0; index < depth; index += 1) node = [node]; return node; };
  // 根自己算第一个节点；第 10000 个之后的子节点不再进入，也就不再读它们的后代。
  const fan = leaf => { const root = {}; for (let index = 0; index <= 10000; index += 1) root[`c${index}`] = leaf(index); return root; };
  const seen = index => (index === 9998 ? '/artifacts/seen' : index >= 9999 ? '/artifacts/unseen' : 'x');
  const inner = index => reads({ inner: () => { log.push(`inner${index}`); return 'x'; } });
  const proxy = () => new Proxy({ artifactId: 'p' }, {
    getOwnPropertyDescriptor(target, key) { log.push(`gopd:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
    get(target, key, receiver) { log.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
    ownKeys(target) { log.push('ownKeys'); return Reflect.ownKeys(target); } });
  const revoked = () => { const pair = Proxy.revocable({}, {}); pair.revoke(); return pair.proxy; };
  const trees = [
    ['plain', () => ({ artifactId: 'a' })],
    ['with path', () => ({ artifactId: 'a', relativePath: 'x/y.png' })],
    ['invalid id', () => ({ artifactId: 'bad id', relativePath: 'x' })],
    ['inherited id', () => Object.create({ artifactId: 'inherited' })],
    ['hidden id', () => Object.defineProperty({}, 'artifactId', { value: 'hidden', enumerable: false })],
    ['non-string id', () => ({ artifactId: 7, relativePath: 'x' })],
    ['invalid path', () => ({ artifactId: 'a', relativePath: '/abs' })],
    ['undefined path', () => ({ artifactId: 'a', relativePath: undefined })],
    ['ids array', () => ({ artifactIds: ['x', 'y', 42, null, 'bad id', 'x', '/artifacts/z', { artifactId: 'nested' }] })],
    ['ids string', () => ({ artifactIds: 'abc' })],
    ['ids null', () => ({ artifactIds: null })],
    ['nested', () => ({ a: { b: ['/artifacts/deep', { artifactId: 'e' }] } })],
    ['root array', () => ['/artifacts/a', { artifactId: 'b' }]],
    ['result objects', () => [{ artifactId: 'again', relativePath: 'a/' }, '/artifacts/again']],
    ['cycle', () => { const value = { artifactId: 'cyc', list: ['/artifacts/cyc'] }; value.self = value; value.list.push(value, value.list); return value; }],
    ['shared object', () => { const value = reads({ artifactId: () => 's' }); return { x: value, y: value, z: [value] }; }],
    ['shared array', () => { const value = ['/artifacts/arr', { get v() { log.push('v'); return 1; } }]; return [value, value]; }],
    ['holey', () => [, '/artifacts/a']],
    ['subclass iterator', () => new (class extends Array { *[Symbol.iterator]() { yield '/artifacts/custom'; } })('/artifacts/base', '/artifacts/base')],
    ['boxed string', () => new String('/artifacts/boxed')],
    ['collections', () => [new Map([['/artifacts/m', 1]]), new Set(['/artifacts/s']), new Date(0), /re/g, new Uint8Array(2), Object.assign(Object.create(null), { artifactId: 'bare' })]],
    ['function root', () => Object.assign(() => {}, { artifactId: 'f' })],
    ['function child', () => ({ fn() { log.push('fn'); }, artifactId: 'fn-child' })],
    ['symbol key', () => ({ [Symbol('s')]: '/artifacts/sym', artifactId: 'sym' })],
    ['other realm', () => require('node:vm').runInNewContext('({ artifactId: "realm", list: ["/artifacts/realm-list"] })')],
    ['object depth 32', () => chain(32)],
    ['object depth 33', () => chain(33)],
    ['list depth 32', () => nesting(31)],
    ['list depth 33', () => nesting(32)],
    ['node cap text', () => fan(seen)],
    ['node cap getters', () => fan(inner)],
    ['reference cap', () => [...many(300, 'cap').split(' '), reads({ late: () => '/artifacts/late' })]],
    ['reference cap edge', () => [many(255, 'e'), '/artifacts/z1 /artifacts/z2', { artifactId: 'z3' }]],
    ['cap skips getters', () => ({ a: many(256, 'k'), b: reads({ after: () => '/artifacts/after' }) })],
    ['getter order', () => reads({ a: of('x'), b: of('/artifacts/g'), c: of(1) })],
    ['key order', () => Object.defineProperties({}, { 2: { enumerable: true, get() { log.push('two'); return 1; } },
      1: { enumerable: true, get() { log.push('one'); return 1; } }, b: { enumerable: true, get() { log.push('bee'); return 1; } },
      a: { enumerable: true, get() { log.push('ay'); return 1; } } })],
    ['id reads', () => reads({ artifactId: () => 'a' })],
    ['path reads', () => reads({ relativePath: () => 'p/q' })],
    ['id and path reads', () => reads({ artifactId: () => 'a', relativePath: () => 'p' })],
    ['ids reads', () => reads({ artifactIds: () => ['x'] })],
    ['ids reads non-array', () => reads({ artifactIds: () => 'x' })],
    ['changing id', () => { let count = 0; return reads({ artifactId: () => `id${count++}` }); }],
    ['changing ids', () => { let count = 0; return reads({ artifactIds: () => [`id${count++}`] }); }],
    ['throwing child', () => reads({ z: () => { throw sentinel; }, a: of('/artifacts/a') })],
    ['throwing id', () => reads({ artifactId: () => { throw sentinel; } })],
    ['throwing path', () => reads({ artifactId: () => 'a', relativePath: () => { throw sentinel; } })],
    ['throwing ids', () => reads({ artifactId: () => 'a', artifactIds: () => { throw sentinel; } })],
    ['throwing in array', () => [reads({ x: () => { throw sentinel; } }), '/artifacts/never']],
    ['throw undefined', () => reads({ x: () => { throw undefined; } })],
    ['throw string', () => reads({ x: () => { throw text; } })],
    ['throw symbol', () => reads({ x: () => { throw reason; } })],
    ['proxy traps', () => new Proxy({ artifactId: 'p', extra: '/artifacts/x' }, {
      getOwnPropertyDescriptor(target, key) { log.push(`gopd:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
      get(target, key, receiver) { log.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
      ownKeys(target) { log.push('ownKeys'); return Reflect.ownKeys(target); } })],
    ['revoked proxy', revoked],
    ['live array growth', () => { const list = [reads({ x: () => { list.push('/artifacts/pushed'); return 1; } })]; return list; }],
    ['getter deletes sibling', () => { const value = reads({ artifactIds: () => { delete value.extra; return ['x']; }, extra: () => '/artifacts/extra' }); return value; }],
    ['getter adds sibling', () => { const value = {}; Object.defineProperty(value, 'artifactId', { enumerable: true, get() {
      log.push('artifactId'); Object.defineProperty(value, 'added', { enumerable: true, configurable: true, get() { log.push('added'); return '/artifacts/added'; } }); return 'a'; } }); return value; }],
  ];
  trees.forEach(([name, build]) => tree(name, build));
  // 下标 5 留空：for-of 会沿原型链读到这个 getter。空下标会撞上实现内部往空数组 push 的位置。
  Object.defineProperty(Array.prototype, 5, { get() { log.push('hole'); return '/artifacts/hole'; }, configurable: true });
  try { tree('prototype hole', () => ['0', '1', '2', '3', '4', , '/artifacts/a']); } finally { delete Array.prototype[5]; }

  expect([ref('deep')], () => extractArtifactReferences(chain(32)));
  expect([], () => extractArtifactReferences(chain(33)));
  expect([ref('deep-list')], () => extractArtifactReferences(nesting(31)));
  expect([], () => extractArtifactReferences(nesting(32)));
  expect([ref('seen')], () => extractArtifactReferences(fan(seen)));
  extractArtifactReferences(fan(inner));
  // 每个子对象连同 getter 返回的字符串子节点占两个节点：c0..c4999 读完，c5000 起不再进入。
  assert.deepEqual([log.length, log[0], log.at(-1), log.includes('inner5000')], [10000, 'inner', 'inner4999', false], '节点上限之后不再读后代');
  log = [];
  extractArtifactReferences([...many(300, 'cap').split(' '), reads({ late: () => '/artifacts/late' })]);
  assert.equal(log.includes('late'), false, '引用满额后不再进入后续对象');
  extractArtifactReferences({ a: many(256, 'k'), b: reads({ after: () => '/artifacts/after' }) });
  assert.equal(log.includes('after'), false, '引用满额后不再枚举后续对象');
  expect(refs(Array.from({ length: 256 }, (_, index) => `cap${index}`).sort()),
    () => extractArtifactReferences([...many(300, 'cap').split(' '), reads({ late: () => '/artifacts/late' })]));
  expect([...refs(Array.from({ length: 255 }, (_, index) => `e${index}`).sort()), ref('z1')],
    () => extractArtifactReferences([many(255, 'e'), '/artifacts/z1 /artifacts/z2', { artifactId: 'z3' }]));
  const withLog = fn => { log = []; const out = show(extractArtifactReferences(fn())); return [out, log]; };
  log = [];
  assert.deepEqual(withLog(() => reads({ artifactId: () => 'a' })), [[ref('a')], ['artifactId', 'artifactId', 'artifactId']], 'artifactId 读两次，再作为子节点读一次');
  assert.deepEqual(withLog(() => reads({ artifactIds: () => ['x'] })), [[ref('x')], ['artifactIds', 'artifactIds', 'artifactIds']], 'artifactIds 读两次，再作为子节点读一次');
  assert.deepEqual(withLog(() => { let count = 0; return reads({ artifactId: () => `id${count++}` }); }),
    [[ref('id1')], ['artifactId', 'artifactId', 'artifactId']], '入表的是第二次读到的值');
  assert.deepEqual(withLog(proxy), [[ref('p')],
    ['gopd:artifactId', 'get:artifactId', 'gopd:relativePath', 'get:artifactId', 'get:artifactIds', 'ownKeys', 'gopd:artifactId', 'get:artifactId']], 'Proxy 陷阱的先后');
  assert.throws(() => extractArtifactReferences(reads({ x: () => { throw sentinel; } })), error => error === sentinel, 'getter 抛出的就是原对象');
  assert.throws(() => extractArtifactReferences(reads({ x: () => { throw reason; } })), error => error === reason, 'Symbol 也原样抛出');
  assert.throws(() => extractArtifactReferences(revoked()), { name: 'TypeError', message: "Cannot perform 'IsArray' on a proxy that has been revoked" });
  // 数字开头的不是 scheme，`12:=/artifacts/a` 里的引用照常成立；这些行接在原语料之后（变异测试补的，旧结论取自同一冻结 blob）。
  for (const value of ['12:=/artifacts/a', '1:=/artifacts/a', '1+2:=/artifacts/a', '1.2:=/artifacts/a', 'x12:=/artifacts/a', 'a1:=/artifacts/a', '12:/artifacts/a']) {
    run(['locator', value], () => extractArtifactReferences(value));
  }
  expect([ref('a')], () => extractArtifactReferences('12:=/artifacts/a'));
  expect([ref('a')], () => extractArtifactReferences('1:=/artifacts/a'));
  expect([], () => extractArtifactReferences('x12:=/artifacts/a'));
  // 每个结束边界都要能把 id 或路径截断（同样是补的行；原来只带 `!` 的那行前面是 `;`，根本没走到）。
  const ends = ['/artifacts/e1" /artifacts/e2\' /artifacts/e3` /artifacts/e4( /artifacts/e5) /artifacts/e6< /artifacts/e7> /artifacts/e8[ /artifacts/e9] /artifacts/e10{ /artifacts/e11} /artifacts/e12, /artifacts/e13; /artifacts/e14!',
    '/artifacts/p/q" /artifacts/p/r\' /artifacts/p/s( /artifacts/p/t[ /artifacts/p/u; /artifacts/p/v!'];
  for (const [index, value] of ends.entries()) run(['end boundary', index], () => extractArtifactReferences(value));
  expect(refs(Array.from({ length: 14 }, (_, index) => `e${index + 1}`).sort()), () => extractArtifactReferences(ends[0]));
  expect([ref('p', 'q'), ref('p', 'r'), ref('p', 's'), ref('p', 't'), ref('p', 'u'), ref('p', 'v')], () => extractArtifactReferences(ends[1]));
  log = [];
  return rows;
}

function show(value) {
  if (!Array.isArray(value)) return value;
  return value.map(entry => [Object.keys(entry).join(','), entry.artifactId, entry.relativePath, Object.getPrototypeOf(entry) === Object.prototype]);
}
