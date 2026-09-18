'use strict';

// Air 任务 Pin —— 用户钉在页头顶上的那几个任务。
//
// 为什么在服务端：这份清单说的是「我手上正在盯的活」，和 ui-layout.json 同一个
// 理由 —— 存在浏览器里的话，换一台机器、换 App 打开就全没了。Web 页头的「齐刘海」
// 与侧栏、App 侧栏的置顶读的都是这里这一份。
//
//   文件：<data dir>/air-pins.json（默认），形状 { taskIds: [taskId, …] }
//   接口：GET  /api/air/pins          → { ok, taskIds }
//        POST /api/air/pins          { taskIds }  → 整份替换（最多 5 个）
//        POST /api/air/pins/toggle   { taskId }   → 钉上 / 拔掉
//
// 上限是产品语义不是技术限制：页头那块空白放得下五个，再多就把标题挤没了。
// 满了之后 toggle 返回 409 pin_limit_reached，由界面说话 —— 悄悄挤掉最早的那个
// 会让人以为自己的选择丢了。
//
// 存在性剪枝在读的时候做（任务被删掉，钉子自己掉下来）：写下来的 id 是用户的选择，
// 别因为一次「没读到」就把它删了。

const stateStore = require('../state/store');
const { createPaths } = require('../paths');

const PIN_LIMIT = 5;
const SCHEMA_VERSION = 1;

/** 只做形状归一：丢掉空值、去重、截断到上限。存在性由运行时按当下的任务表判。 */
function normalizePins(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const raw of list) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= PIN_LIMIT) break;
  }
  return out;
}

function createAirPinRuntime(rawDeps) {
  const deps = rawDeps || {};
  // 默认跟着 src/paths.js 的数据目录走（和 sessions.json / ui-layout.json 同一处），
  // 嵌入式宿主也可以自己指一个文件。
  const file = deps.file || createPaths().airPinsFile;
  if (typeof deps.listTaskIds !== 'function') throw new TypeError('[air-pins] listTaskIds() is required');
  const logger = deps.logger || console;
  const store = stateStore.createStore({
    file, kind: 'air-pins', schemaVersion: SCHEMA_VERSION, legacyIsArray: false,
  });

  // 进程内的权威副本，懒加载：新装的实例没有这个文件，不该为每次请求付一次 stat。
  let pinned = null;

  function load() {
    if (pinned) return pinned;
    try {
      const r = store.loadOrRecover();
      pinned = normalizePins(r.present ? r.data?.taskIds : null);
    } catch (e) {
      // 读不出来最多丢掉几个钉子，别的都不影响 —— 这里从空开始是对的爆炸半径。
      logger.warn(`[multicc/air-pins] unreadable pins file, starting empty: ${e.message}`);
      pinned = [];
    }
    return pinned;
  }

  function persist() {
    try { store.save({ taskIds: pinned }); }
    catch (e) { logger.warn(`[multicc/air-pins] save failed: ${e.message}`); }
  }

  function knownIds() {
    try { return new Set(deps.listTaskIds()); }
    catch (_) { return null; }   // 任务表读不到就不剪枝，宁可多留一个 hook
  }

  /** 客户端看到的清单：写下来的顺序，去掉已经不存在的任务。 */
  function read() {
    const known = knownIds();
    const list = normalizePins(load());
    return known ? list.filter(id => known.has(id)) : list;
  }

  /** 整份替换（拖排序、批量取消都走这里）。超出上限的尾巴直接丢掉。 */
  function replace(taskIds) {
    const known = knownIds();
    pinned = normalizePins(taskIds).filter(id => !known || known.has(id));
    persist();
    return read();
  }

  /** 一个按钮点下去：钉着就拔掉，没钉就钉上；满了报错，由界面说话。 */
  function toggle(taskId) {
    const id = typeof taskId === 'string' ? taskId.trim() : '';
    if (!id) throw Object.assign(new Error('taskId is required'), { status: 400, code: 'task_id_required' });
    const known = knownIds();
    if (known && !known.has(id)) throw Object.assign(new Error('任务不存在'), { status: 404, code: 'task_not_found' });
    const current = read();
    if (current.includes(id)) return replace(current.filter(value => value !== id));
    if (current.length >= PIN_LIMIT) {
      throw Object.assign(new Error(`最多只能 Pin ${PIN_LIMIT} 个任务`), { status: 409, code: 'pin_limit_reached' });
    }
    return replace([...current, id]);
  }

  // `target` 是 express Router（生产）或 app（测试）—— 两者都暴露 get/post。
  function mountRoutes(target) {
    target.get('/api/air/pins', (req, res) => { res.json({ ok: true, taskIds: read() }); });
    target.post('/api/air/pins', (req, res) => {
      const body = req.body || {};
      if (!Array.isArray(body.taskIds)) {
        return res.status(400).json({ ok: false, code: 'task_ids_required', message: 'taskIds 必须是数组' });
      }
      res.json({ ok: true, taskIds: replace(body.taskIds) });
    });
    target.post('/api/air/pins/toggle', (req, res) => {
      try { res.json({ ok: true, taskIds: toggle((req.body || {}).taskId) }); }
      catch (error) {
        res.status(error.status || 500).json({ ok: false, code: error.code || 'pin_failed', message: error.status ? error.message : 'Request failed' });
      }
    });
  }

  return { file, limit: PIN_LIMIT, read, replace, toggle, mountRoutes };
}

module.exports = { PIN_LIMIT, normalizePins, createAirPinRuntime };
