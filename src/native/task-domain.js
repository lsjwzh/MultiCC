'use strict';
const { getNative, runNative, nativeCode } = require('./runtime');

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
  const addon = getNative('task_domain', 'rust');
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
  const addon = getNative('task_domain', 'rust');
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
module.exports = { taskDomain, taskDomainAsync, replace, cloneBoard, forWire, registerBoardStore, boardStoreOf, trackedProxies };
