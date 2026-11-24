'use strict';

// Air 任务「手动忽略」—— 用户已经知晓、不想再被待办提醒的那些任务。
//
// 待办视图里总有一类是「我看过了，它在等我处理，但我不想现在处理」。运行态表达
// 不了这件事（它仍然是 error / waiting），所以要像 pin、手动待办一样单独落一份
// 用户选择：
//
//   文件：<data dir>/air-todo-ignores.json（默认），形状
//         { items: [{ taskId, kind, stamp }, …] }
//         kind  = 忽略当下的待办来源类别：'error' | 'waiting'
//         stamp = 这一次问题发生的时刻（任务/会话上的 endedAt 等）
//   接口：POST /api/air/todos/ignore { taskId } → 切换忽略
//         → { ok, ignored, kind, taskIds, todos }
//
// 忽略只对「待办来源」有意义：出错（runState=error）或等待回复（runState=waiting）。
// 其它任务（运行中、已完成、归档……）调用 ignore 一律 400 todo_ignore_not_applicable
// —— 需要交互的任务应该走「标记达成」，而不是被永久藏起来。
//
// 失效规则（读取时剪枝，不写盘：GET 不该有副作用）：
//   1. 任务被删 → 失效。
//   2. 类别变了（不再出错 / 不再等待）→ 失效。以后再出错就是新异常，会重新进待办。
//   3. 类别仍是同类，但出现了「新的一次」→ 失效。判据是这一次问题发生的时刻
//      （会话 taskState.endedAt，E/W 落判时写入；等待还可用 pendingUserInput.createdAt
//      兜底）大于忽略时记下的 stamp。**不用 task.updatedAt 判新异常**：改名、移动、
//      已读、生命周期调整都会推大 updatedAt，那是非状态操作。
//   4. 老格式条目（没有 kind）按旧规则兼容读取：updatedAt > stamp 即失效。
//   5. 拿不到「发生时刻」时退回保守规则：类别相同且 updatedAt > stamp 也失效。
//      已知误差：这种情况下一次改名字可能误伤忽略；正常 E/W 判定都有 endedAt。
//
// 忽略动作本身只写这份文件，绝不碰任务记录的 updatedAt —— 否则一次点击会把
// 刚写下的 stamp 立刻作废。
//
// 「手动待办」与忽略互相独立：忽略不清待办，标记待办也不清忽略。
// 两者是用户分别表达的两件事，把它们绑成互斥只会让人第二次点同一个按钮时
// 丢掉第一次的选择。

const stateStore = require('../state/store');
const { createPaths } = require('../paths');

const TODO_IGNORE_LIMIT = 500;
const SCHEMA_VERSION = 1;
const FILE_KIND = 'air-todo-ignores';
const IGNORE_KINDS = new Set(['error', 'waiting']);

/** 只做形状归一：丢掉空值、按 taskId 去重、截断上限。有效性由运行时按当下任务表判。 */
function normalizeIgnores(value, limit = TODO_IGNORE_LIMIT) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const taskId = raw && typeof raw.taskId === 'string' ? raw.taskId.trim() : '';
    if (!taskId || seen.has(taskId)) continue;
    const stamp = Number(raw.stamp);
    // 老条目没有 kind：保留 null，读取时走 updatedAt 兼容规则。
    const kind = raw && IGNORE_KINDS.has(raw.kind) ? raw.kind : null;
    out.push({ taskId, kind, stamp: Number.isFinite(stamp) ? stamp : 0 });
    seen.add(taskId);
    if (out.length >= limit) break;
  }
  return out;
}

function createAirTodoIgnoreRuntime(rawDeps) {
  const deps = rawDeps || {};
  // 默认跟着 src/paths.js 的数据目录走；宿主（或测试）可以自己指一个文件。
  const file = deps.file || createPaths().airTodoIgnoresFile;
  if (typeof deps.listTasks !== 'function') {
    throw new TypeError(`[${FILE_KIND}] listTasks() is required`);
  }
  const logger = deps.logger || console;
  const store = stateStore.createStore({
    file, kind: FILE_KIND, schemaVersion: SCHEMA_VERSION, legacyIsArray: false,
  });

  // 进程内的权威副本，懒加载：没碰过忽略的实例不该为每次请求付一次 stat。
  let items = null;

  function load() {
    if (items) return items;
    try {
      const r = store.loadOrRecover();
      items = normalizeIgnores(r.present ? r.data?.items : null);
    } catch (e) {
      // 读不出来最多丢掉几个忽略，别的都不影响 —— 从空开始是对的爆炸半径。
      logger.warn(`[multicc/${FILE_KIND}] unreadable file, starting empty: ${e.message}`);
      items = [];
    }
    return items;
  }

  function persist(next) {
    try { store.save({ items: next }); }
    catch (e) {
      logger.warn(`[multicc/${FILE_KIND}] save failed: ${e.message}`);
      throw Object.assign(new Error('忽略状态无法保存'), { code: 'todo_ignore_save_failed', status: 500 });
    }
  }

  // 类别与「这一次问题何时发生」由宿主给：快照里折出来的 runState 是唯一口径，
  // 这里不自己从 status 猜。读不到返回 { kind: null, occurredAt: 0 }。
  function problemOf(task) {
    if (typeof deps.problemOf !== 'function') return { kind: null, occurredAt: 0 };
    try {
      const value = deps.problemOf(task) || {};
      return {
        kind: IGNORE_KINDS.has(value.kind) ? value.kind : null,
        occurredAt: Number(value.occurredAt) > 0 ? Number(value.occurredAt) : 0,
      };
    } catch (error) {
      if (error?.code === 'SESSION_WORK_OWNER_UNAVAILABLE') throw error;
      return { kind: null, occurredAt: 0 };
    }
  }

  // 任务表快照：taskId → { updatedAt, task, problem }。读不到返回 null —— 那时
  // 不剪枝，宁可多留一个忽略，也别因为一次「没读到」把用户的选择删掉。
  //
  // problem 是懒算的：/api/air 每轮都会读一次忽略，若在这里给全部上千张卡都折
  // 一遍 runState，等于把快照最贵的那段再跑一遍。真正需要它的只有「已经写下的
  // 那几个忽略」，所以等 stillValid 用到时再算。
  function taskViews() {
    try {
      const map = new Map();
      for (const task of deps.listTasks() || []) {
        if (!task || !task.id) continue;
        const raw = task.updatedAt;
        const value = typeof raw === 'number' ? raw : Number(raw);
        map.set(task.id, {
          updatedAt: Number.isFinite(value) && value > 0 ? value : 0,
          task, problem: null,
        });
      }
      return map;
    } catch (_) { return null; }
  }

  function problemFor(view) {
    if (!view.problem) view.problem = problemOf(view.task);
    return view.problem;
  }

  function stillValid(entry, view) {
    if (!view) return false;                                  // 任务被删
    if (!entry.kind) return !(view.updatedAt > entry.stamp);  // 老格式：旧的 updatedAt 规则
    const problem = problemFor(view);
    if (problem.kind !== entry.kind) return false;            // 不再是同类问题
    const occurredAt = problem.occurredAt;
    if (occurredAt > entry.stamp) return false;               // 同类问题的新一次
    // 没有精确「发生时刻」时退回保守规则（见文件头已知误差）。
    if (!(occurredAt > 0) && view.updatedAt > entry.stamp) return false;
    return true;
  }

  // 剪枝要判「这一次问题是哪一类、什么时候发生」，而那要问会话状态的 owner。
  // owner 不可读时有两种正确行为，取决于调用方是读还是写：
  //   读（/api/air 每轮都会走到）—— 不剪枝，原样返回用户写下的选择。判不出来
  //     不等于判成「失效」，而整轮快照更不该因为这份辅助清单作废：它和卡片正文
  //     无关，却排在 1500+ 张卡之后，抛出去就是把整轮计算全扔掉再 5 秒重试一次。
  //     这与 pins/todos 的 knownIds() 完全同一条原则（读不到就不剪枝）。
  //   写（toggle）—— fail-closed。写盘要以判准为前提，判不准就别落盘。
  /** 当前有效的忽略（读取时剪枝，不写盘：GET 不该有副作用）。 */
  function effective(views = taskViews(), { strict = false } = {}) {
    // 任务表读不到时不剪枝：一次读失败不该删掉用户的选择。
    if (!views) return load();
    try {
      return load().filter(entry => stillValid(entry, views.get(entry.taskId)));
    } catch (error) {
      if (strict || error?.code !== 'SESSION_WORK_OWNER_UNAVAILABLE') throw error;
      return load();
    }
  }

  function read() { return effective().map(entry => entry.taskId); }

  /** 忽略时刻：这一次问题发生的时刻；拿不到才退回 updatedAt / 当下。 */
  function stampOf(view) {
    if (!view) return Date.now();
    const problem = problemFor(view);
    if (problem.occurredAt > 0) return problem.occurredAt;
    if (view.updatedAt > 0) return view.updatedAt;
    return Date.now();
  }

  /** 一个按钮点下去：忽略着就取消，没忽略就记下。 */
  function toggle(taskId) {
    const id = typeof taskId === 'string' ? taskId.trim() : '';
    if (!id) throw Object.assign(new Error('taskId is required'), { status: 400, code: 'task_id_required' });
    const views = taskViews();
    if (!views) {
      // 读不到任务表就判不了类别；忽略一个来历不明的任务比拒绝更糟。
      throw Object.assign(new Error('任务表暂时不可用'), { status: 503, code: 'todo_ignore_unavailable' });
    }
    if (!views.has(id)) {
      throw Object.assign(new Error('任务不存在'), { status: 404, code: 'task_not_found' });
    }
    const view = views.get(id);
    const current = effective(views, { strict: true });
    const previous = current.find(entry => entry.taskId === id);
    let next, ignored, kind;
    if (previous) {
      // 取消忽略永远允许，即使类别刚刚变了（条目此时已无效就走新增分支）。
      next = current.filter(entry => entry.taskId !== id);
      ignored = false;
      kind = previous.kind || null;
    } else {
      const problem = view ? problemFor(view) : { kind: null, occurredAt: 0 };
      if (!problem.kind) {
        throw Object.assign(new Error('只有出错或等待回复的任务可以忽略'), {
          status: 400, code: 'todo_ignore_not_applicable',
        });
      }
      if (current.length >= TODO_IGNORE_LIMIT) {
        throw Object.assign(new Error(`最多只能忽略 ${TODO_IGNORE_LIMIT} 个任务`), { status: 409, code: 'todo_ignore_limit_reached' });
      }
      // 顺手把已经失效的老条目剪掉（读取时只过滤，写盘时真正清理）。
      next = [...current, { taskId: id, kind: problem.kind, stamp: stampOf(view) }];
      ignored = true;
      kind = problem.kind;
    }
    persist(next);
    items = next;
    return { ignored, kind, taskIds: read(), todos: readTodos() };
  }

  function readTodos() {
    if (typeof deps.readTodos !== 'function') return [];
    try { return deps.readTodos(); }
    catch (_) { return []; }
  }

  // `target` 是 express Router（生产）或 app（测试）—— 两者都暴露 post。
  function mountRoutes(target) {
    target.post('/api/air/todos/ignore', (req, res) => {
      try { res.json({ ok: true, ...toggle((req.body || {}).taskId) }); }
      catch (error) {
        res.status(error.status || 500).json({
          ok: false, code: error.code || 'todo_ignore_failed',
          message: error.status ? error.message : 'Request failed',
        });
      }
    });
  }

  return { file, limit: TODO_IGNORE_LIMIT, read, toggle, mountRoutes };
}

module.exports = { TODO_IGNORE_LIMIT, IGNORE_KINDS, normalizeIgnores, createAirTodoIgnoreRuntime };
