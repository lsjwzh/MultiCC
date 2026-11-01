'use strict';

// 生产任务板：Rust 常驻权威副本 + JS 镜像。
//
// 镜像是原对象外包一层 Proxy：任何深度的写入都记到所属条目（tasks/modules/
// taskGroups 的某个 id，或根键）上，下一次调用规则前只上送这些脏条目；Rust 在
// 常驻副本上就地执行规则，只回传变化的条目，这里按旧的就地回填语义写回原对象，
// 保持调用方持有的任务引用身份。规则不再每次序列化整板。
//
// Proxy 抓不到的写入只有一种：调用方把自建对象挂进板后，又经自己手里的裸引用
// 修改它。挂入时记为 volatile，落盘前每次上送都整条复核；另有全量校验兜底
// （测试每次调用后、生产每 10 分钟），分叉以宿主镜像为准重新上送。
const { getNative, runNative, nativeCode } = require('../native/runtime');
const domain = require('../native/task-domain');
const { wireDate } = require('./planning');

const KINDS = ['tasks', 'modules', 'taskGroups'];
const SEP = '\u0001';
const compareIds = (a, b) => a.localeCompare(b);
const isObject = value => value !== null && typeof value === 'object';
// JS 把整数样式的键按数值排在最前，与 Rust 的插入序不同：出现时显式上送键序。
const integerKey = key => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;

function replacePlain(target, value) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(value, key)) delete target[key];
  Object.assign(target, value);
  return target;
}
function reorderObject(holder, order) {
  const entries = new Map(Object.entries(holder));
  for (const key of Object.keys(holder)) delete holder[key];
  for (const key of order) {
    if (!entries.has(key)) continue;
    holder[key] = entries.get(key);
    entries.delete(key);
  }
  for (const [key, value] of entries) holder[key] = value;
}
const sameKeys = (a, b) => a.length === b.length && a.every((key, i) => key === b[i]);
function codeError(message) {
  const error = new Error(String(message || 'task_board_failed'));
  const code = /^([A-Za-z][A-Za-z0-9_]*)(?::|$)/.exec(error.message)?.[1];
  if (code) error.code = code;
  return error;
}
// 测试运行（node --test 会设置 NODE_TEST_CONTEXT）默认逐次全量校验；显式 0 关闭。
function verifyByDefault() {
  const flag = process.env.MULTICC_TASK_BOARD_VERIFY;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return !!process.env.NODE_TEST_CONTEXT;
}

function openBoardStore({ raw: input = null, repository = null, logger = console,
  verify = verifyByDefault(), verifyIntervalMs = 10 * 60_000 } = {}) {
  const addon = getNative('task_domain', 'rust');
  if (typeof addon?.RustTaskBoard !== 'function') {
    throw new Error('任务板常驻 Rust 接口不可用，请构建当前原生模块后手动重启');
  }
  const native = new addon.RustTaskBoard();
  const warn = message => { try { (logger?.warn || logger?.log)?.call(logger, message); } catch (_) {} };

  // 与无状态 normalizeBoard 相同的宿主事实：原始板每个任务的 dueAt 与任务组序。
  const rawTasks = Object.values(isObject(input) && input.tasks || {});
  const opened = native.open(JSON.stringify({
    raw: input,
    dates: rawTasks.map(task => [task?.dueAt, wireDate(task?.dueAt)]),
    idOrder: Object.values(isObject(input) && input.taskGroups || {}).map(group => group?.id)
      .filter(Boolean).sort(compareIds),
    verifyReads: verify,
  }));
  const raw = JSON.parse(opened);

  const dirty = Object.fromEntries(KINDS.map(kind => [kind, new Set()]));
  const keyed = new Set();      // 需要上送插入序的集合
  const resort = new Set(['tasks', 'taskGroups']);  // 需要上送宿主排序的集合
  const replaced = new Set();   // 整个集合被替换（本次落盘前每次整块上送）
  const rootDirty = new Set();
  const volatile = new Set();
  const knownDates = new Set();
  let pendingDates = [];
  let full = false;
  let tx = null;

  function noteDate(task) {
    const value = isObject(task) ? task.dueAt : undefined;
    if (value === undefined) return;
    const key = JSON.stringify(value);
    if (knownDates.has(key)) return;
    knownDates.add(key);
    pendingDates.push([value, wireDate(value)]);
  }
  for (const kind of KINDS) {
    if (isObject(raw[kind]) && Object.keys(raw[kind]).some(integerKey)) keyed.add(kind);
  }
  for (const task of Object.values(isObject(raw.tasks) ? raw.tasks : {})) noteDate(task);

  // ── 事务前像 ────────────────────────────────────────────────────────────
  function capture(kind, id) {
    if (!tx) return;
    const key = kind + SEP + id;
    if (tx.pre.has(key)) return;
    const holder = kind === 'root' ? raw : raw[kind];
    const present = isObject(holder) && Object.hasOwn(holder, id);
    tx.pre.set(key, { kind, id, present, value: present ? holder[id] : undefined,
      json: present ? JSON.stringify(holder[id]) : null });
  }
  function touch(kind, id) {
    capture(kind, id);
    if (kind === 'root') rootDirty.add(id);
    else dirty[kind].add(id);
  }

  // ── Proxy 镜像 ──────────────────────────────────────────────────────────
  const metas = new WeakMap();   // proxy → { target, kind, id }
  const cache = new WeakMap();   // target → Map(owner → proxy)
  function adopt(value, kind, id) {
    if (!isObject(value)) return value;
    const meta = metas.get(value);
    if (meta && !meta.container) {
      if (meta.kind !== kind || meta.id !== id) volatile.add(kind + SEP + id);
      return meta.target;
    }
    volatile.add(kind + SEP + id);
    return meta ? meta.target : value;
  }
  function wrap(value, kind, id) {
    if (!isObject(value)) return value;
    const meta = metas.get(value);
    const target = meta ? meta.target : value;
    const owner = kind + SEP + id;
    let byOwner = cache.get(target);
    if (!byOwner) cache.set(target, byOwner = new Map());
    let proxy = byOwner.get(owner);
    if (!proxy) {
      proxy = new Proxy(target, {
        get(t, k, r) {
          const value = Reflect.get(t, k, r);
          // 只包自有属性：原型上的东西（含 __proto__）原样返回。
          return typeof k === 'string' && Object.hasOwn(t, k) ? wrap(value, kind, id) : value;
        },
        set(t, k, v) { touch(kind, id); t[k] = adopt(v, kind, id); return true; },
        deleteProperty(t, k) { if (Object.hasOwn(t, k)) touch(kind, id); return delete t[k]; },
        defineProperty(t, k, d) { touch(kind, id); return Reflect.defineProperty(t, k, d); },
      });
      byOwner.set(owner, proxy);
      metas.set(proxy, { target, kind, id });
      tracked.set(proxy, store);
    }
    return proxy;
  }
  const containers = new Map();
  function container(kind) {
    const target = raw[kind];
    if (!isObject(target)) return target;
    let hit = containers.get(kind);
    if (hit?.target !== target) {
      const proxy = new Proxy(target, {
        get(t, k, r) {
          const value = Reflect.get(t, k, r);
          return typeof k === 'string' && Object.hasOwn(t, k) ? wrap(value, kind, k) : value;
        },
        set(t, k, v) {
          if (typeof k !== 'string') { t[k] = v; return true; }
          if (!Object.hasOwn(t, k)) { keyed.add(kind); resort.add(kind); }
          touch(kind, k);
          t[k] = adopt(v, kind, k);
          return true;
        },
        deleteProperty(t, k) {
          if (typeof k === 'string' && Object.hasOwn(t, k)) { keyed.add(kind); resort.add(kind); touch(kind, k); }
          return delete t[k];
        },
        defineProperty(t, k, d) {
          if (typeof k === 'string') { keyed.add(kind); resort.add(kind); touch(kind, k); }
          return Reflect.defineProperty(t, k, d);
        },
      });
      hit = { target, proxy };
      containers.set(kind, hit);
      metas.set(proxy, { target, kind: 'root', id: kind, container: true });
      tracked.set(proxy, store);
    }
    return hit.proxy;
  }
  function replaceKind(kind, value) {
    capture('root', kind);
    const meta = isObject(value) ? metas.get(value) : null;
    raw[kind] = meta ? meta.target : value;
    replaced.add(kind);
    keyed.add(kind);
    resort.add(kind);
    for (const id of dirty[kind]) dirty[kind].delete(id);
  }
  const board = new Proxy(raw, {
    get(t, k, r) {
      if (KINDS.includes(k)) return container(k);
      const value = Reflect.get(t, k, r);
      return typeof k === 'string' && Object.hasOwn(t, k) ? wrap(value, 'root', k) : value;
    },
    set(t, k, v) {
      if (typeof k !== 'string') { t[k] = v; return true; }
      if (KINDS.includes(k)) { replaceKind(k, v); return true; }
      touch('root', k);
      t[k] = adopt(v, 'root', k);
      return true;
    },
    deleteProperty(t, k) {
      if (typeof k === 'string' && Object.hasOwn(t, k)) {
        if (KINDS.includes(k)) replaceKind(k, undefined);
        else touch('root', k);
      }
      return delete t[k];
    },
  });

  // ── 上送 ────────────────────────────────────────────────────────────────
  const sortedTasks = () => Object.keys(isObject(raw.tasks) ? raw.tasks : {}).sort(compareIds);
  // 与无状态调用一致：任务组序取各组的 id 字段（组内 id 与键一致时等价于键）。
  const sortedGroups = () => Object.values(isObject(raw.taskGroups) ? raw.taskGroups : {})
    .map(group => group?.id).filter(Boolean).sort(compareIds);
  function pending() {
    return full || replaced.size || keyed.size || resort.size || rootDirty.size || volatile.size
      || pendingDates.length || KINDS.some(kind => dirty[kind].size);
  }
  function takeSync() {
    if (!pending()) return undefined;
    for (const owner of volatile) {
      const [kind, id] = owner.split(SEP);
      if (kind === 'root') rootDirty.add(id); else dirty[kind].add(id);
    }
    if (full) {
      full = false;
      for (const kind of KINDS) dirty[kind].clear();
      keyed.clear(); resort.clear(); rootDirty.clear();
      for (const task of Object.values(isObject(raw.tasks) ? raw.tasks : {})) noteDate(task);
      return { full: raw, orders: { tasks: sortedTasks(), taskGroups: sortedGroups() },
        dates: pendingDates.splice(0) };
    }
    const sync = {};
    for (const kind of KINDS) {
      const holder = isObject(raw[kind]) ? raw[kind] : null;
      if (replaced.has(kind)) {
        sync[kind] = { replace: holder || {} };
        if (kind === 'tasks') for (const task of Object.values(holder || {})) noteDate(task);
      } else if (dirty[kind].size || keyed.has(kind)) {
        const set = [], del = [];
        for (const id of dirty[kind]) {
          if (holder && Object.hasOwn(holder, id)) {
            set.push([id, holder[id]]);
            if (kind === 'tasks') noteDate(holder[id]);
          } else del.push(id);
        }
        sync[kind] = { set, del, order: keyed.has(kind) && holder ? Object.keys(holder) : null };
      }
      if (dirty[kind].size && kind === 'taskGroups') resort.add(kind);
      dirty[kind].clear();
    }
    keyed.clear();
    if (rootDirty.size) {
      const set = {}, del = [];
      for (const key of rootDirty) {
        if (Object.hasOwn(raw, key)) set[key] = raw[key]; else del.push(key);
      }
      sync.root = { set, del };
      rootDirty.clear();
    }
    if (resort.size) {
      sync.orders = {};
      if (resort.has('tasks')) sync.orders.tasks = sortedTasks();
      if (resort.has('taskGroups')) sync.orders.taskGroups = sortedGroups();
      resort.clear();
    }
    if (pendingDates.length) sync.dates = pendingDates.splice(0);
    return sync;
  }
  function send(method, payload, retried = false) {
    const sync = takeSync();
    const text = JSON.stringify(sync ? { ...payload, sync } : payload);
    try { return JSON.parse(native[method](text)); }
    catch (error) {
      // 上送是否已生效无从判断：下一次整板重同步。
      full = true;
      if (!retried && /RESYNC_REQUIRED/.test(String(error?.message))) return send(method, payload, true);
      throw nativeCode(error);
    }
  }
  function flush() {
    if (pending()) send('apply', {});
  }

  // ── 回填 ────────────────────────────────────────────────────────────────
  function applyDiff(diff) {
    if (!isObject(diff)) return;
    for (const kind of KINDS) {
      const part = diff[kind];
      if (!isObject(part)) continue;
      if (!isObject(raw[kind])) raw[kind] = {};
      const holder = raw[kind];
      let keysChanged = false;
      for (const [id, value] of part.set || []) {
        capture(kind, id);
        const current = Object.hasOwn(holder, id) ? holder[id] : undefined;
        if (current === undefined) keysChanged = true;
        if (isObject(current) && isObject(value) && !Array.isArray(current) && !Array.isArray(value)) {
          replacePlain(current, value);
        } else holder[id] = value;
        if (kind === 'tasks') noteDate(holder[id]);
        if (integerKey(id)) keyed.add(kind);
      }
      for (const id of part.del || []) {
        capture(kind, id);
        if (Object.hasOwn(holder, id)) { delete holder[id]; keysChanged = true; }
      }
      if (Array.isArray(part.order)) reorderObject(holder, part.order);
      if (keysChanged || kind === 'taskGroups') resort.add(kind);
    }
    if (isObject(diff.root)) {
      for (const [key, value] of Object.entries(diff.root.set || {})) { capture('root', key); raw[key] = value; }
      for (const key of diff.root.del || []) { capture('root', key); delete raw[key]; }
    }
  }
  // 规则失败：常驻副本可能半改，用宿主手里规则执行前的副本覆盖它列出的条目。
  function restore(touched) {
    if (!isObject(touched)) return;
    for (const kind of KINDS) {
      const part = touched[kind];
      if (!isObject(part)) continue;
      for (const id of part.ids || []) dirty[kind].add(id);
      if (part.order) keyed.add(kind);
    }
    for (const key of touched.root || []) rootDirty.add(key);
    try { flush(); } catch (_) { full = true; }
  }

  // ── 规则调用 ────────────────────────────────────────────────────────────
  function call(command) {
    const { board: _board, ...rest } = command;
    const reply = send('apply', { command: domain.forWire(rest) });
    if (!reply.ok) {
      restore(reply.restore);
      throw codeError(reply.error);
    }
    applyDiff(reply.diff);
    if (reply.readonlyMutated) {
      const message = `TASK_BOARD_READONLY_MUTATED:${rest.op}.${rest.action || ''}`;
      if (verify) throw codeError(message);
      warn(`[multicc/taskboard] ${message}`);
    }
    if (verify) check('call');
    return reply.out;
  }
  async function callAsync(command) {
    const { board: _board, ...rest } = command;
    flush();
    const text = JSON.stringify({ command: domain.forWire(rest) });
    let reply;
    try { reply = JSON.parse(await runNative(() => native.applyAsync(text))); }
    catch (error) {
      if (!/RESYNC_REQUIRED/.test(String(error?.message))) { full = true; throw nativeCode(error); }
      full = true;
      flush();
      reply = JSON.parse(await runNative(() => native.applyAsync(text)));
    }
    if (!reply.ok) throw codeError(reply.error);
    return reply.out;
  }

  // ── 落盘与事务 ──────────────────────────────────────────────────────────
  function persist(expectedRevision) {
    let result;
    if (repository?.nativeFile) {
      const reply = send('persist', { file: repository.nativeFile, expectedRevision, onConflict: 'preserve' });
      applyDiff(reply.diff);
      if (!reply.ok) throw codeError(reply.error);
      result = reply.result;
    } else {
      // 注入的仓储（测试故障注入）只认整板对象。
      const value = send('snapshot', {});
      result = repository.save(value, expectedRevision, { onConflict: 'preserve' });
      if (result?.revision != null && Number(result.revision) !== Number(raw.revision)) {
        capture('root', 'revision');
        raw.revision = result.revision;
        rootDirty.add('revision');
      }
    }
    volatile.clear();
    replaced.clear();
    if (verify) check('persist');
    return result;
  }
  function rollback(own) {
    if (own.done) return;
    own.done = true;
    if (tx === own) tx = null;
    for (const { kind, id, present, value, json } of own.pre.values()) {
      if (kind === 'root') {
        if (KINDS.includes(id)) {
          raw[id] = present ? JSON.parse(json) : undefined;
          if (!present) delete raw[id];
          replaced.add(id); keyed.add(id); resort.add(id);
        } else {
          if (present && json !== undefined) raw[id] = JSON.parse(json); else delete raw[id];
          rootDirty.add(id);
        }
        continue;
      }
      if (!isObject(raw[kind])) raw[kind] = {};
      const holder = raw[kind];
      if (present) {
        const before = JSON.parse(json);
        if (isObject(value) && isObject(before) && !Array.isArray(value)) {
          replacePlain(value, before);
          holder[id] = value;
        } else holder[id] = before;
      } else delete holder[id];
      dirty[kind].add(id);
    }
    for (const kind of KINDS) {
      const before = own.order[kind];
      if (!before || !isObject(raw[kind])) continue;
      if (!sameKeys(Object.keys(raw[kind]), before)) { reorderObject(raw[kind], before); keyed.add(kind); resort.add(kind); }
    }
    try { flush(); } catch (_) { full = true; }
  }
  // 就地事务：fn 收到 rollback；抛错自动回滚。替代旧的整板深拷贝候选再回填。
  function transaction(fn) {
    if (tx) return fn(() => rollback(tx));
    const own = { pre: new Map(), done: false,
      order: Object.fromEntries(KINDS.map(kind => [kind, isObject(raw[kind]) ? Object.keys(raw[kind]) : null])) };
    tx = own;
    try { return fn(() => rollback(own)); }
    catch (error) { rollback(own); throw error; }
    finally { if (tx === own) tx = null; }
  }

  // ── 全量校验 ────────────────────────────────────────────────────────────
  function check(reason) {
    const reply = send('verify', { board: raw });
    if (reply.ok) return true;
    const drift = reply.drift || {};
    const summary = [];
    for (const kind of KINDS) {
      const part = drift[kind];
      if (!part) continue;
      for (const id of part.ids || []) dirty[kind].add(id);
      if (part.order) keyed.add(kind);
      summary.push(`${kind}:${(part.ids || []).slice(0, 5).join(',')}${part.order ? '+order' : ''}`);
    }
    for (const key of drift.root || []) rootDirty.add(key);
    if (drift.root?.length) summary.push(`root:${drift.root.join(',')}`);
    try { flush(); } catch (_) { full = true; }
    const message = `TASK_BOARD_MIRROR_DRIFT:${reason}:${summary.join(';')}`;
    if (verify) throw codeError(message);
    warn(`[multicc/taskboard] ${message}`);
    return false;
  }
  let timer = null;
  if (verifyIntervalMs > 0) {
    timer = setInterval(() => { try { check('periodic'); } catch (_) {} }, verifyIntervalMs);
    timer.unref?.();
  }

  // 调用方持有的任务对象被规则整体回填（addRefToTask 等）：写原对象并记脏，
  // 新值来自原生 JSON、无人持有裸引用，不算 volatile。
  function replaceTracked(target, value) {
    const meta = metas.get(target);
    if (!meta || meta.container) return false;
    touch(meta.kind, meta.id);
    replacePlain(meta.target, value);
    return true;
  }

  const tracked = domain.trackedProxies;
  const store = {
    board, native, call, callAsync, flush, persist, transaction, replaceTracked,
    rawOf: value => metas.get(value)?.target,
    verify: reason => check(reason || 'manual'),
    snapshot: () => send('snapshot', {}),
    cloneRaw: () => send('snapshot', {}),
    close() { if (timer) clearInterval(timer); timer = null; },
  };
  domain.registerBoardStore(board, store);
  return store;
}

module.exports = { openBoardStore };
