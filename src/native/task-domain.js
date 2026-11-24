'use strict';
const { getNative, runNative, nativeCode } = require('./runtime');
const { createStore } = require('../state/store');

// 生产任务板由 board-store.js 常驻在 Rust：命令里的 board 是它的镜像时只上送
// 变更、走常驻句柄；其余（测试与临时拼出的小板）仍整板序列化走无状态入口。
const stores = new WeakMap();          // 镜像根 → store
const trackedProxies = new WeakMap();  // 镜像内任意对象代理 → store
function registerBoardStore(board, store) { stores.set(board, store); }
function boardStoreOf(board) {
  return board !== null && typeof board === 'object' ? stores.get(board) || null : null;
}
// 经 Proxy 逐属性序列化比原对象慢数倍：命令顶层与临时拼的小板（{modules, tasks:{id:task}}）
// 里的镜像代理先换回原对象，只在命中时浅拷贝外层。
function forWire(value, depth = 3) {
  if (value === null || typeof value !== 'object') return value;
  const raw = trackedProxies.get(value)?.rawOf(value);
  if (raw) return raw;
  if (depth === 0 || Array.isArray(value)) return value;
  let copy = null;
  for (const key of Object.keys(value)) {
    const next = forWire(value[key], depth - 1);
    if (next !== value[key]) { copy ||= { ...value }; copy[key] = next; }
  }
  return copy || value;
}

// 孤立代理项（旧 JS 截断 emoji 的产物）由 Rust json_lenient 统一改写为 U+FFFD。
function taskDomain(command) {
  const store = boardStoreOf(command?.board);
  if (store) return store.call(command);
  const addon = getNative();
  if (typeof addon.taskDomain !== 'function') throw new Error('任务规则 Rust 接口不可用，请构建当前原生模块');
  try { return JSON.parse(addon.taskDomain(JSON.stringify(forWire(command)))); }
  catch (error) { throw nativeCode(error); }
}
// 只把原生决策写回旧调用者持有的对象，保持原有可变对象 API。
function replace(target, value) {
  if (trackedProxies.get(target)?.replaceTracked(target, value)) return target;
  for (const key of Object.keys(target)) if (!Object.hasOwn(value, key)) delete target[key];
  Object.assign(target, value);
  return target;
}
async function taskDomainAsync(command) {
  const store = boardStoreOf(command?.board);
  if (store) return store.callAsync(command);
  const addon = getNative();
  if (typeof addon.taskDomainAsync !== 'function') throw new Error('异步任务规则 Rust 接口不可用');
  const input = JSON.stringify(forWire(command));
  try { return JSON.parse(await runNative(() => addon.taskDomainAsync(input))); }
  catch (error) { throw nativeCode(error); }
}
// 整板深拷贝：生产板由 Rust 直接出快照，避免经 Proxy 逐属性序列化。
function cloneBoard(board) {
  const store = boardStoreOf(board);
  return store ? store.cloneRaw() : JSON.parse(JSON.stringify(board));
}
const call = (action, args = {}) => taskDomain({ op: 'attention', action, ...args });
function mutate(action, task, args) {
  const out = call(action, { task, ...args });
  if (task) replace(task, out.task);
  return out.changed;
}
const taskAttention = {
  attentionKind: state => call('kind', { state }),
  noteRunState: (task, previous, next, at = Date.now()) => mutate('note', task, { previous, next, at }),
  markSeen: (task, at = Date.now()) => mutate('seen', task, { at }),
  pendingAttention: task => call('pending', { task }),
  normalizeAttention: (source, task) => { mutate('normalize', task, { source }); },
};
// Rust owns validation, minting, recovery-row selection and display labels.
// V8 Maps retain opaque candidate keys, and StateStore owns the on-disk envelope.
function createTaskShortCodeRegistry({ file = null, candidate } = {}) {
  const native = getNative();
  const ids = new Map();
  const owners = new Map();
  const store = file && createStore({ file, kind: 'task-short-codes', schemaVersion: 1, legacyIsArray: false });
  if (store) {
    let loaded;
    try { loaded = store.loadOrRecover(); }
    catch (e) { throw new Error(`[task-short-code] registry state unusable at ${file}: ${e.message}`); }
    if (loaded.present) native.taskCodeRestore(ids, owners, loaded.data && loaded.data.byTaskId, file);
  }
  const save = store ? () => store.save({ byTaskId: Object.fromEntries(ids) }) : undefined;
  return {
    codeFor: id => native.taskCodeMint(ids, owners, candidate, save, id),
    has: id => ids.has(String(id ?? '').trim()),
    ownerOf: code => owners.get(code) || null,
    size: () => ids.size,
  };
}

let activeRegistry;
function initTaskShortCodeRegistry(opts) { return activeRegistry = createTaskShortCodeRegistry(opts); }
function registry() { return activeRegistry ||= createTaskShortCodeRegistry(); }
function taskShortCode(id) { return registry().codeFor(id); }
const taskShortCodes = {
  taskShortCode, createTaskShortCodeRegistry, initTaskShortCodeRegistry,
  taskIdForShortCode: code => getNative().taskCodeLookup(code, registry),
  labelWithCode: (id, text) => getNative().taskCodeLabel(id, text, taskShortCode),
  CODE_LEN: 4, CODE_ALPHABET: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
};

let attributionModePolicy;
function getAttributionModePolicy() {
  if (attributionModePolicy) return attributionModePolicy;
  const native = getNative();
  const { attributionModes, defaultAttributionMode } = JSON.parse(native.taskRoutingCatalog());
  attributionModePolicy = {
    MODES: Object.freeze(attributionModes),
    DEFAULT_MODE: defaultAttributionMode,
    normalizeAttributionMode: (value, fallback = defaultAttributionMode) => native.normalizeHostAttributionMode(value, fallback),
    planAttributionAction: ({ mode, relation, targetTaskId, currentTaskId } = {}) =>
      native.planHostAttributionAction(mode, relation, targetTaskId, currentTaskId),
  };
  return attributionModePolicy;
}

function normalizePins(value, limit) { return getNative().airNormalizeTaskIds(value, limit); }

function readStoredPinIds(file) {
  let raw;
  try { raw = JSON.parse(require('node:fs').readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return getNative().airStoredPins(raw);
}

function createTaskIdListRuntime(rawDeps, spec) {
  const deps = rawDeps || {};
  const { kind, route, limit, codes, label } = spec;
  const file = deps.file || spec.defaultFile();
  if (typeof deps.listTaskIds !== 'function') throw new TypeError(`[${kind}] listTaskIds() is required`);
  const logger = deps.logger || console;
  const store = createStore({ file, kind, schemaVersion: 1, legacyIsArray: false });
  const owner = new (getNative().RustAirTaskList)();
  const ports = {
    spec: { limit, codes, label },
    listTaskIds: () => deps.listTaskIds(),
    load() {
      try { const state = store.loadOrRecover(); return state.present ? state.data?.taskIds : null; }
      catch (e) { logger.warn(`[multicc/${kind}] unreadable ${kind} file, starting empty: ${e.message}`); return null; }
    },
    save(taskIds) {
      try { store.save({ taskIds }); }
      catch (e) {
        logger.warn(`[multicc/${kind}] save failed: ${e.message}`);
        throw Object.assign(new Error(`${label.trim()} state could not be saved`), { code: codes.saveFailed, status: 500 });
      }
    },
  };
  const read = () => owner.run('read', ports, undefined);
  const replace = ids => owner.run('replace', ports, ids);
  const toggle = id => owner.run('toggle', ports, id);
  // Legacy embedders mount Express callbacks; the production Air HTTP surface is in the Rust gateway.
  function mountRoutes(target) {
    target.get(route, (req, res) => { res.json({ ok: true, taskIds: read() }); });
    target.post(route, (req, res) => {
      const body = req.body || {};
      if (!Array.isArray(body.taskIds)) {
        return res.status(400).json({ ok: false, code: 'task_ids_required', message: 'taskIds 必须是数组' });
      }
      try { res.json({ ok: true, taskIds: replace(body.taskIds) }); }
      catch (e) { res.status(e.status || 500).json({ ok: false, code: e.code || codes.failed, message: 'Request failed' }); }
    });
    target.post(`${route}/toggle`, (req, res) => {
      try { res.json({ ok: true, taskIds: toggle((req.body || {}).taskId) }); }
      catch (e) { res.status(e.status || 500).json({ ok: false, code: e.code || codes.failed, message: e.status ? e.message : 'Request failed' }); }
    });
  }
  return { file, limit, read, replace, toggle, mountRoutes };
}

function createAirList(deps, todo) {
  const spec = getNative().airTaskListSpec(todo);
  spec.defaultFile = () => require('../paths').createPaths()[spec.fileKey];
  return createTaskIdListRuntime(deps, spec);
}
const createAirPinRuntime = deps => createAirList(deps, false);
const createAirTodoRuntime = deps => createAirList(deps, true);

module.exports = { taskDomain, taskDomainAsync, replace, cloneBoard, forWire, registerBoardStore, boardStoreOf, trackedProxies, taskAttention, getAttributionModePolicy, ...taskShortCodes,
  readStoredPinIds, normalizePins, createTaskIdListRuntime, createAirPinRuntime, createAirTodoRuntime,
  get PIN_LIMIT() { return getNative().airTaskListSpec(false).limit; },
  get TODO_LIMIT() { return getNative().airTaskListSpec(true).limit; },
};
