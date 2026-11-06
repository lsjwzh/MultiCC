'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTaskShellStore } = require('../src/task-shell/store');
const { createTaskBoardRepository } = require('../src/task-board/repository');
const { createAirCardCache } = require('../src/workspace/air-card-cache');
const { taskDomain, taskDomainAsync } = require('../src/native/task-domain');
const { getNative, nativeCode } = require('../src/native/runtime');
const { boardRule } = require('../src/task-board/native-bridge');
const planning = require('../src/task-board/planning');
const { mkRuntime } = require('./helpers/task-board-runtime');
const core = require('../src/task-board/core');
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-domain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('Rust 仓储在外部提交和本连接回滚后失效，嵌套事务不留下索引', t => {
  const file = path.join(directory(t), 'tasks.sqlite');
  const a = createTaskShellStore(file), b = createTaskShellStore(file);
  t.after(() => { a.close(); b.close(); });
  a.set('task', 't', { id: 't', sessionId: 's1', title: '原始' });
  const before = a.cachedById('task');
  b.set('task', 't', { id: 't', sessionId: 's2', title: '外部修改' });
  assert.notEqual(a.cachedById('task'), before);
  assert.equal(a.cachedById('task').get('t').title, '外部修改');
  assert.throws(() => a.transaction(() => {
    a.set('task', 't', { id: 't', sessionId: 's3' });
    a.transaction(() => { a.set('receipt', 'r', { id: 'r', shellId: 'sh' }); });
    assert.equal(a.cachedById('task').get('t').sessionId, 's3');
    throw new Error('中断事务');
  }), /中断事务/);
  assert.equal(a.get('task', 't').sessionId, 's2');
  assert.equal(a.taskBySession('s3'), null);
  assert.deepEqual(a.receiptsForShell('sh'), []);
  assert.equal(a.cachedById('task').get('t').sessionId, 's2');
});
test('Rust 仓储拒绝异步事务并完整回滚，快照正文不可改写', t => {
  const store = createTaskShellStore(':memory:'); t.after(() => store.close());
  assert.throws(() => store.transaction(() => { store.set('task', 't', { id: 't' }); return Promise.resolve(); }), /必须同步/);
  assert.equal(store.get('task', 't'), null);
  store.set('snapshot', 'immutable', { a: 1 });
  assert.throws(() => store.set('snapshot', 'immutable', { a: 2 }), /immutable snapshot conflict/);
  assert.deepEqual(store.get('snapshot', 'immutable'), { a: 1 });
});
test('Rust 任务板恢复更高版本，备份原始迁移输入且不覆盖旧备份', t => {
  const dir = directory(t), file = path.join(dir, 'board.json');
  const legacy = { tasks: { t: { title: '任务', refs: [] } }, modules: {} };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const repo = createTaskBoardRepository(file);
  assert.deepEqual(repo.load().raw, legacy);
  const backup = fs.readFileSync(path.join(dir, 'board.pre-planning-v1.json'), 'utf8');
  const a = { schemaVersion: 2, revision: 3, tasks: {}, modules: {} };
  repo.save(a);
  fs.writeFileSync(path.join(dir, 'board.planning-v2.json'), JSON.stringify({ ...a, revision: 4 }));
  assert.equal(repo.load().raw.revision, 4);
  assert.equal(repo.load().restored, true);
  assert.equal(fs.readFileSync(path.join(dir, 'board.pre-planning-v1.json'), 'utf8'), backup);
  fs.writeFileSync(file, '{broken');
  assert.equal(repo.load().raw.revision, 4);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99 }));
  assert.throws(() => repo.load(), { code: 'TASK_BOARD_SCHEMA_UNSUPPORTED' });
});
test('Rust 任务板实际文件写入失败时恢复两个文件，首次失败无幻影主文件', t => {
  const dir = directory(t), file = path.join(dir, 'board.json');
  const repo = createTaskBoardRepository(file), recovery = path.join(dir, 'board.planning-v2.json');
  const original = { schemaVersion: 2, revision: 1, tasks: {}, modules: {} };
  repo.save(original);
  const old = fs.readFileSync(recovery, 'utf8');
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(() => repo.save({ ...original, revision: 2 }), /TASK_BOARD_STORAGE/);
  assert.equal(fs.readFileSync(recovery, 'utf8'), old);
  fs.rmSync(file, { recursive: true }); fs.unlinkSync(recovery); fs.mkdirSync(recovery);
  assert.throws(() => repo.save(original), /TASK_BOARD_STORAGE/);
  assert.equal(fs.existsSync(file), false);
});
test('Rust 卡片缓存拒绝失效中的并发提交，并能在构建失败后继续刷新', async () => {
  const cache = createAirCardCache({ mode: 'on', clock: () => 1, random: () => 0 });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const options = { keyOf: x => x, signatureOf: () => 'same', build: async () => { await held; return { card: { id: 't' } }; } };
  const pending = cache.resolveAsync('one', ['t'], options);
  await new Promise(resolve => setImmediate(resolve));
  cache.resolve('two', ['t'], { ...options, build: () => ({ card: { id: 't', title: '新版本' } }) });
  release();
  await assert.rejects(pending, /card_cache_version_changed/);
  const next = await cache.resolveAsync('two', ['t'], { ...options, build: () => assert.fail('应命中缓存') });
  assert.equal(next.entries[0].card.title, '新版本');
  await assert.rejects(cache.resolveAsync('three', ['t'], { ...options, build: () => { throw new Error('构建失败'); } }), /构建失败/);
  const recovered = await cache.resolveAsync('three', ['t'], { ...options, build: () => ({ card: { id: 't' } }) });
  assert.equal(recovered.entries[0].card.id, 't');
});
test('Rust 批量卡片在缓存被后续请求回收后仍完成原快照，不串入新权限', async () => {
  const cache = createAirCardCache({ mode: 'on', clock: () => 10, random: () => 0 });
  const options = readOnly => ({ keyOf: t => t.id, signatureOf: () => 'same',
    build: () => assert.fail('生产底稿应整批交由 Rust 生成'),
    nativeBaseOf: task => ({ task, access: { readOnly }, record: null, workspace: null, lease: null }) });
  const task = { id: 't', title: '原快照', status: 'active', runState: 'idle', refs: [] };
  const first = await cache.resolveAsync('old', [task], options(true));
  const second = await cache.resolveAsync('new', [{ ...task, title: '新快照' }], options(false));
  const facts = { now: 10, facts: {}, merges: {}, capacityReasons: {} };
  const [oldCards, newCards] = await Promise.all([cache.overlayAsync(first, facts), cache.overlayAsync(second, facts)]);
  assert.equal(oldCards[0].title, '原快照');
  assert.equal(oldCards[0].readOnly, true);
  assert.equal(newCards[0].title, '新快照');
  assert.equal(newCards[0].readOnly, false);
  assert.equal(Object.hasOwn(oldCards[0], 'dirId'), false, '缺省字段仍应省略');
});
test('Rust 卡片异步刷新队列溢出时排队等待而非拒绝', async () => {
  const cache = createAirCardCache({ mode: 'on' });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const options = { keyOf: id => id, signatureOf: () => 'same',
    build: async () => { await held; return { card: { id: 't' } }; } };
  const queued = Array.from({ length: 20 }, () => cache.resolveAsync('g', ['t'], options));
  release();
  const settled = await Promise.all(queued);
  assert.equal(settled.length, 20, '并发刷新应全部排队完成，不再出现 card_cache_queue_full');
  const next = await cache.resolveAsync('g', ['t'], options);
  assert.equal(next.hits, 1);
});
test('Rust 任务板拒绝另一仓储实例的陈旧覆盖，落盘权限保持私有', t => {
  const dir = directory(t), file = path.join(dir, 'board.json');
  const a = createTaskBoardRepository(file), b = createTaskBoardRepository(file);
  const board = { schemaVersion: 2, revision: 1, tasks: {}, modules: {} };
  a.save(board, 0);
  assert.equal(b.load().raw.revision, 1);
  a.save({ ...board, revision: 2 }, 1);
  assert.throws(() => b.save({ ...board, revision: 3 }, 1), /TASK_BOARD_REVISION_CONFLICT/);
  assert.equal(a.load().raw.revision, 2);
  if (process.platform !== 'win32') {
    for (const name of ['board.json', 'board.planning-v2.json', 'board.lock']) {
      assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
    }
  }
});
test('Rust 异步卡片签名追踪原地修改、权限事实、线路展示名及工作区租约', async () => {
  const board = { modules: {}, taskGroups: {}, tasks: { t: { id: 't', title: '任务', sessionId: 's', refs: [] } } };
  const input = { op: 'airInputs', epoch: '1', board, shellTasks: [], records: { s: { id: 's', providerName: '原线路' } }, admission: { workspaces: [{ id: 'w', ownerId: 's', dirId: 'd', residency: 'resident' }], leases: [] } };
  let previous = await taskDomainAsync(input);
  for (const mutate of [() => { board.tasks.t.title = '改名'; }, () => { input.records.s.taskBoundTaskId = 't'; }, () => { input.records.s.providerName = '新线路'; }, () => { input.admission.leases.push({ workspaceId: 'w', state: 'running' }); }]) {
    mutate(); const next = await taskDomainAsync(input);
    assert.notEqual(next.signatures.t, previous.signatures.t); previous = next;
  }
  assert.equal(previous.lifecycle.d.leased, 1);
  assert.equal(previous.lifecycle.d.onDisk, 1);
  assert.deepEqual(taskDomain({ op: 'airVisible', board, shellTasks: [{ id: 't', embedded: true }] }), []);
});
test('Rust 任务身份合并拒绝越目录和循环，不以相似标题合并独立任务', () => {
  const board = core.createEmptyBoard();
  core.applyTagResult(board, [{ id: 'new', title: '实现搜索', module: '服务端' }], { sessionId: 's', dirId: 'a', userMsgId: 'm1' }, 1);
  core.applyTagResult(board, [{ id: 'new', title: '接入搜索', module: '服务端' }], { sessionId: 's', dirId: 'b', userMsgId: 'm2' }, 2);
  const ids = Object.keys(board.tasks);
  assert.equal(ids.length, 2);
  assert.equal(core.mergeTasks(board, { targetTaskId: ids[0], sourceTaskIds: [ids[1]], now: 3 }).error, 'task_directory_mismatch');
  board.tasks[ids[0]].mergedInto = ids[1]; board.tasks[ids[1]].mergedInto = ids[0];
  assert.equal(core.resolveTask(board, ids[0]), null);
  const normalized = core.normalizeBoard(board);
  assert.ok(ids.every(id => core.resolveTask(normalized, id)));
});
test('lifecycle 对不存在的任务显式报错，不再生成幽灵任务行', () => {
  const board = { tasks: { t1: { id: 't1', title: 'A', status: 'active', refs: [] } }, modules: {} };
  assert.throws(() => boardRule('lifecycle', { board, taskId: 'tsk_ghost', operation: 'archive', now: 1 }), /task_not_found/);
  assert.equal(board.tasks.tsk_ghost, undefined, '缺失任务不能被 serde IndexMut 插成幽灵行');
  assert.equal(boardRule('lifecycle', { board, taskId: 't1', operation: 'archive', now: 1 }).ok, true);
  assert.equal(board.tasks.t1.status, 'archived');
  assert.deepEqual(Object.keys(board.tasks), ['t1']);
});
test('ownerPlan 与 linkByTask 共用 link-task 索引并回填否定缓存', t => {
  const store = createTaskShellStore(':memory:'); t.after(() => store.close());
  store.set('link', 'lnk1', { id: 'lnk1', taskId: 'tskA', shellId: 'shellA' });
  assert.deepEqual(store.rule({ action: 'ownerPlan', task: { id: 'tskA', refs: [] }, records: {} }), { shellId: 'shellA' });
  const missing = { id: 'tskB', refs: [] };
  assert.equal(store.rule({ action: 'ownerPlan', task: missing, records: {} }), null);
  assert.deepEqual(store.get('link-task', 'tskB'), { taskId: 'tskB', shellId: null, linkId: null },
    '规则路径的未命中必须与 linkByTask op 一样回填否定缓存');
  assert.equal(store.rule({ action: 'ownerPlan', task: missing, records: {} }), null);
});
test('planning 把 0/false 当作非法 priority 校验，dueAt 0 保持可用', () => {
  for (const bad of [0, false]) {
    const rejected = planning.createPlannedTask({ tasks: {}, modules: {} }, { title: 'T', dirId: 'd', priority: bad }, { id: 'tsk_p', now: 1 });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'invalid_priority', `priority=${bad} 不应被 truthiness 跳过`);
  }
  const board = { tasks: {}, modules: {} };
  const created = planning.createPlannedTask(board, { title: 'T', dirId: 'd' }, { id: 'tsk_ok', now: 1 });
  assert.equal(created.ok, true);
  const updated = planning.updatePlannedTask(board, 'tsk_ok', { priority: 0 }, { expectedRevision: 1 });
  assert.equal(updated.ok, false);
  assert.equal(updated.error, 'invalid_priority');
  const zeroDue = planning.createPlannedTask({ tasks: {}, modules: {} }, { title: 'D', dirId: 'd', dueAt: 0 }, { id: 'tsk_due', now: 1 });
  assert.equal(zeroDue.ok, true, 'dueAt=0 是合法纪元时间，旧实现接受');
});
test('classification id 池耗尽时派生唯一 id 而非复用 missing 占位', () => {
  const out = taskDomain({ op: 'classification', action: 'applyTagResult',
    board: { tasks: {}, modules: {} },
    entries: [{ title: '任务甲', module: '模块一' }, { title: '任务乙', module: '模块二' }, { title: '任务丙', module: '模块三' }],
    ref: { sessionId: 's1', dirId: 'd1' }, now: 11, newIds: [] });
  assert.equal(out.result.length, 3);
  const taskIds = Object.keys(out.board.tasks), moduleIds = Object.keys(out.board.modules);
  assert.equal(taskIds.length, 3);
  assert.equal(moduleIds.length, 3);
  for (const id of [...taskIds, ...moduleIds]) {
    assert.ok(!id.includes('missing'), `id 池耗尽不得退回占位符：${id}`);
  }
});
test('孤立代理项由 Rust 宽松解码清洗，字面反斜杠保持原样', t => {
  const store = createTaskShellStore(':memory:'); t.after(() => store.close());
  store.set('task', 't', { id: 't', sessionId: 's', title: '坏标题\ud800' });
  assert.ok(store.get('task', 't').title.includes('�'), 'set 内嵌 body 也要走清洗');
  store.set('task', 'lit', { id: 'lit', sessionId: 's', title: '\\ud800' });
  assert.equal(store.get('task', 'lit').title, '\\ud800', '字面反斜杠+ud800 不是代理项转义');
  const withLone = planning.createPlannedTask({ tasks: {}, modules: {} }, { title: '甲\udfff乙', dirId: 'd' }, { id: 'tsk_s', now: 1 });
  assert.equal(withLone.ok, true);
  assert.ok(withLone.task.title.includes('�'));

  const normalized = taskDomain({ op: 'planning', action: 'normalizePlanningTask',
    task: { title: '丙\udc00' }, options: {}, dates: [], idOrder: [] });
  assert.ok(normalized.task.title.includes('�'), 'taskDomain 同步入口也要清洗');

  const dir = directory(t), file = path.join(dir, 'board.json');
  fs.writeFileSync(file, '{"schemaVersion":2,"revision":1,"tasks":{"t":{"id":"t","title":"丁\\ud800"}},"modules":{}}');
  const loaded = createTaskBoardRepository(file).load();
  assert.equal(loaded.raw.tasks.t.title, '丁�', '任务板仓储 load 读得出孤立代理项');

  const cache = new (getNative().RustAirCardCache)();
  const reply = JSON.parse(cache.run(JSON.stringify({ op: 'overlay', keys: ['t'], tokens: [0], nativeRenderable: false,
    entries: [{ t: {}, card: { id: 't', title: '戊\ud800', refs: [] } }], facts: {}, now: 1, merges: {}, capacityReasons: {} })));
  assert.ok(reply.cards[0].title.includes('�'), '卡片缓存解析也要清洗');
});
test('cardOverlay 恒写 runState 键，lastMessageAt 回退走数字链', () => {
  const overlay = taskDomain({ op: 'cardOverlay', task: { id: 't', title: 'T', refs: [] },
    card: { id: 't', title: 'T' }, facts: {}, now: 5, merge: null, capacityReason: null });
  assert.ok('runState' in overlay, 'runState 键必须恒存在（旧契约），缺省为 null');
  assert.equal(overlay.runState, null);
  const base = taskDomain({ op: 'cardBase', task: { id: 't2', title: 'T', status: 'active', refs: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: 1735689600000 }, record: null, workspace: null, lease: null });
  assert.equal(base.card.lastMessageAt, 1735689600000, 'ISO createdAt 数值为 0，须回退到数值 updatedAt 而不是清零');
});
test('relationList 的 revision 沿用 Number(x)||1 口径', t => {
  const store = createTaskShellStore(':memory:'); t.after(() => store.close());
  store.set('relation', 'r1', { id: 'r1', shellId: 'sh', kind: 'blocks', revision: '2' });
  store.set('relation', 'r2', { id: 'r2', shellId: 'sh', kind: 'blocks', revision: 1.5 });
  store.set('relation', 'r3', { id: 'r3', shellId: 'sh', kind: 'blocks', revision: 0 });
  const rows = store.rule({ action: 'relationList', shellId: 'sh' });
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.id, r.revision])), { r1: 2, r2: 1.5, r3: 1 });
});
test('测试假仓储执行与 Rust 相同的 expectedRevision 乐观锁', t => {
  const rt = mkRuntime({ atomicWriteJson: (f, value) => fs.writeFileSync(f, JSON.stringify(value)) });
  t.after(() => fs.rmSync(path.dirname(rt.file), { recursive: true, force: true }));
  const repo = rt.deps.taskBoardRepository;
  const board = { schemaVersion: 2, revision: 1, tasks: {}, modules: {} };
  repo.save(board, 0);
  assert.throws(() => repo.save({ ...board, revision: 2 }, 5), { code: 'TASK_BOARD_REVISION_CONFLICT' });
  repo.save({ ...board, revision: 2 }, 1);
  assert.equal(repo.load().raw.revision, 2);
});
test('主档读不出时隔离原文件并回落恢复档，不把空板写回去', t => {
  const dir = directory(t), file = path.join(dir, 'board.json');
  const recovery = path.join(dir, 'board.planning-v2.json');
  const corrupt = '{"tasks":';
  const good = { schemaVersion: 2, revision: 5, tasks: { a: { id: 'a', title: '恢复' } }, modules: {} };
  fs.writeFileSync(file, corrupt);
  fs.writeFileSync(recovery, JSON.stringify(good));
  const repo = createTaskBoardRepository(file);
  const loaded = repo.load();
  assert.equal(loaded.restored, true);
  assert.equal(loaded.raw.revision, 5);
  assert.deepEqual(loaded.raw.tasks, good.tasks);
  assert.equal(loaded.quarantined.length, 1);
  assert.equal(fs.readFileSync(loaded.quarantined[0], 'utf8'), corrupt);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt, '隔离只复制，不动原文件');
  repo.save({ ...good, revision: 6 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 6, 'save 后主档恢复可读');
  assert.equal(fs.readFileSync(loaded.quarantined[0], 'utf8'), corrupt, '隔离备份仍在');
});
test('主档坏且无恢复档时返回空板但保留隔离备份', t => {
  const dir = directory(t), file = path.join(dir, 'board.json');
  const corrupt = '{"tasks": [';
  fs.writeFileSync(file, corrupt);
  const repo = createTaskBoardRepository(file);
  const loaded = repo.load();
  assert.equal(loaded.raw, null);
  assert.equal(loaded.restored, false);
  assert.equal(loaded.quarantined.length, 1);
  assert.equal(fs.readFileSync(loaded.quarantined[0], 'utf8'), corrupt);
  repo.save({ schemaVersion: 2, revision: 1, tasks: {}, modules: {} });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 1);
  assert.equal(fs.readFileSync(loaded.quarantined[0], 'utf8'), corrupt);
});
test('恢复档读不出时隔离它并继续用主档', t => {
  const dir = directory(t), file = path.join(dir, 'board.json');
  const recovery = path.join(dir, 'board.planning-v2.json');
  const good = { schemaVersion: 2, revision: 3, tasks: { a: { id: 'a' } }, modules: {} };
  const corrupt = '{"schemaVersion":2,"revision":9';
  fs.writeFileSync(file, JSON.stringify(good));
  fs.writeFileSync(recovery, corrupt);
  const loaded = createTaskBoardRepository(file).load();
  assert.equal(loaded.restored, false);
  assert.equal(loaded.raw.revision, 3);
  assert.equal(loaded.quarantined.length, 1);
  assert.equal(fs.readFileSync(loaded.quarantined[0], 'utf8'), corrupt);
});
test('preserve 冲突备份磁盘主档并以磁盘 revision+1 落盘', t => {
  const dir = directory(t), file = path.join(dir, 'board.json');
  const a = createTaskBoardRepository(file), b = createTaskBoardRepository(file);
  a.save({ schemaVersion: 2, revision: 1, tasks: {}, modules: {} }, 0);
  b.save({ schemaVersion: 2, revision: 2, tasks: { external: { id: 'external' } }, modules: {} }, 1);
  const externalBytes = fs.readFileSync(file);
  const out = a.save({ schemaVersion: 2, revision: 2, tasks: { mine: { id: 'mine' } }, modules: {} }, 1,
    { onConflict: 'preserve' });
  assert.equal(out.ok, true);
  assert.equal(out.revision, 3);
  assert.equal(out.conflict.diskRevision, 2);
  assert.deepEqual(fs.readFileSync(out.conflict.backup), externalBytes, '备份就是外部写者落盘的原始字节');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 3);
  assert.throws(() => b.save({ schemaVersion: 2, revision: 4, tasks: {}, modules: {} }, 0),
    { code: 'TASK_BOARD_REVISION_CONFLICT' });
  assert.equal(b.load().raw.revision, 3, '默认模式冲突仍不落盘');
});
test('运行时在外部推高 revision 后连续两次修改都能落盘', t => {
  const rt = mkRuntime();
  t.after(() => fs.rmSync(path.dirname(rt.file), { recursive: true, force: true }));
  const external = createTaskBoardRepository(rt.file);
  external.save({ schemaVersion: 2, revision: 1, tasks: { ext: { id: 'ext', title: '外部' } }, modules: {} }, 0);
  const board = rt.runtime.getBoard();
  board.tasks.one = { id: 'one', title: '一', status: 'active', refs: [] };
  assert.equal(rt.runtime.save(), true);
  board.tasks.two = { id: 'two', title: '二', status: 'active', refs: [] };
  assert.equal(rt.runtime.save(), true);
  const disk = JSON.parse(fs.readFileSync(rt.file, 'utf8'));
  assert.equal(Object.keys(disk.tasks).length, 2);
  assert.equal(disk.revision, 3);
});
test('原生 panic 被捕获为 TASK_DOMAIN_PANIC，且之后进程仍可用', () => {
  const root = path.resolve(__dirname, '..');
  const script = `
    const root = ${JSON.stringify(root)};
    const { taskDomain, taskDomainAsync } = require(root + '/src/native/task-domain');
    const { getNative, nativeCode } = require(root + '/src/native/runtime');
    const planning = require(root + '/src/task-board/planning');
    const codeOf = error => { nativeCode(error); return error.code; };
    (async () => {
      let syncCode, asyncCode, planningCode, cacheCode;
      try { taskDomain({ op: '__panicProbe' }); } catch (error) { syncCode = codeOf(error); }
      const afterSync = taskDomain({ op: 'airVisible', board: { tasks: {}, modules: {} }, shellTasks: [] });
      try { await taskDomainAsync({ op: '__panicProbe' }); } catch (error) { asyncCode = codeOf(error); }
      const afterAsync = await taskDomainAsync({ op: 'airVisible', board: { tasks: {}, modules: {} }, shellTasks: [] });
      try { planning.normalizePlanningTask([]); } catch (error) { planningCode = codeOf(error); }
      const afterPlanning = taskDomain({ op: 'airVisible', board: { tasks: {}, modules: {} }, shellTasks: [] });
      const cache = new (getNative().RustAirCardCache)();
      try { cache.run(JSON.stringify({ op: '__panicProbe' })); } catch (error) { cacheCode = codeOf(error); }
      const afterCache = JSON.parse(cache.run(JSON.stringify({ op: 'open', mode: 'shadow', verifyMs: 60000, reportMs: 600000, now: 1 })));
      console.log(JSON.stringify({ syncCode, asyncCode, planningCode, cacheCode,
        afterSync: Array.isArray(afterSync), afterAsync: Array.isArray(afterAsync),
        afterPlanning: Array.isArray(afterPlanning), afterCache: afterCache.mode }));
    })();
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: root, env: { ...process.env, MULTICC_TASK_DOMAIN_PANIC_PROBE: '1' }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.deepEqual(result, {
    syncCode: 'TASK_DOMAIN_PANIC', asyncCode: 'TASK_DOMAIN_PANIC',
    planningCode: 'TASK_DOMAIN_PANIC', cacheCode: 'TASK_DOMAIN_PANIC',
    afterSync: true, afterAsync: true, afterPlanning: true, afterCache: 'shadow',
  });
});
