'use strict';

// Full-text search over HTTP: the task board, and the conversation behind it.
//
// The board itself is already fully downloaded by every client (Air snapshot /
// console), but the *searchable* corpus is not: turn excerpts live only in the
// board file, which no client holds. So the ranking runs here, on the same pure
// module the attribution path uses (src/task-board/search.js), and the client
// gets ranked ids plus the matched snippet — never the whole corpus.
//
//   GET /api/task-board/search   ranked task ids (src/task-board/search.js)
//   GET /api/search/messages     ranked message chunks (src/search/runtime.js);
//                                optional dirId / taskId scope filters
//
// Both live in this module because both are the same search box asking two
// corpora, and because the host mounts this module once — a second route module
// would cost server.js a line it does not have (see scripts/check-source-line-budget.js).
//
// Read-only: nothing here mutates the board or touches disk. The message route
// does hand work to the index runtime, but only reads: it never triggers a sweep.

const { createTaskSearchBackend } = require('../native/binding').taskSearch;

const MAX_QUERY_CHARS = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
// A directory or task id is an opaque key; this only stops a malformed request from
// travelling further (the values themselves are always bound, never interpolated).
const MAX_FILTER_CHARS = 200;

function csv(value) {
  const list = String(value == null ? '' : value).split(',')
    .map(item => item.trim()).filter(Boolean);
  return list.length ? list : null;
}

function clampLimit(value) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, parsed);
}

// A message hit is a *session*, but every search box in the product lists tasks. The
// board is the only place that knows which task(s) a conversation belongs to
// (refs[].sessionId) — the pool a client holds carries no refs at all — so the
// mapping is resolved here rather than shipped to each client to redo.
function sessionTaskIds(board) {
  const bySession = new Map();
  for (const task of Object.values(board?.tasks || {})) {
    for (const ref of Array.isArray(task?.refs) ? task.refs : []) {
      const sessionId = String(ref?.sessionId || '').trim();
      const taskId = String(task?.id || '');
      if (!sessionId || !taskId) continue;
      const list = bySession.get(sessionId);
      if (!list) bySession.set(sessionId, [taskId]);
      else if (!list.includes(taskId)) list.push(taskId);
    }
  }
  return bySession;
}

function createTaskSearchRoutes({ getBoard, messages = null, logger = console, searchTasks = createTaskSearchBackend() } = {}) {
  if (typeof getBoard !== 'function') {
    throw new TypeError('task-search routes require a getBoard() port');
  }

  // 空查询与 `query_too_long` 的判定在 Rust 侧（native/core/src/task_routes.rs）
  // ——它们必须在读板块之前发生，和退休的处理器同序。这里只保留检索本身。
  // 返回 `{ status, body }`，宿主端口原样交给 Rust。
  function searchBoard({ query, limit, dirId = null, dirIds = null, statuses = null, minScore = 0 }) {
    let board = null;
    try {
      board = getBoard();
    } catch (error) {
      logger.warn?.(`task_search_board_failed: ${error.message}`);
      return { status: 503, body: { error: 'task_board_unavailable' } };
    }
    if (!board || typeof board.tasks !== 'object') {
      return { status: 503, body: { error: 'task_board_unavailable' } };
    }
    const options = { limit, dirId, dirIds, statuses, minScore };
    const respond = results => ({ status: 200, body: { ok: true, query, count: results.length, results } });
    const fail = () => ({ status: 503, body: { error: 'task_search_unavailable' } });
    try {
      const results = searchTasks(board, query, options);
      return results && typeof results.then === 'function' ? results.then(respond, fail) : respond(results);
    } catch (_) { return fail(); }
  }

  /** The retired handler, kept for callers/tests that still hand it a fake req. */
  function handleSearch(req, res) {
    const query = String(req.query?.q ?? req.query?.query ?? '').trim();
    if (!query) return res.json({ ok: true, query: '', count: 0, results: [] });
    if (query.length > MAX_QUERY_CHARS) {
      return res.status(400).json({ error: 'query_too_long', maxLength: MAX_QUERY_CHARS });
    }
    return Promise.resolve(searchBoard({
      query,
      limit: clampLimit(req.query?.limit),
      dirId: String(req.query?.dirId || '').trim() || null,
      dirIds: csv(req.query?.dirIds),
      statuses: csv(req.query?.statuses),
      minScore: Number(req.query?.minScore) || 0,
    })).then(result => res.status(result.status).json(result.body));
  }

  // The message corpus is the whole conversation, so a result is a *session* plus
  // a chunk — not a task. Each hit therefore also carries the task ids that session
  // belongs to (`taskIds`, resolved from the board's refs, best-effort): that is what
  // lets a search box list these hits as task rows next to the board's own.
  //
  // `warming` is reported rather than hidden: while the first sweep is still
  // walking the corpus a short result list is a partial answer, and a client that
  // cannot tell the two apart would cache "no hits" for a query that has them.
  // Resolving the runtime is itself a step that can fail (it opens the index),
  // and a route that cannot reach its index is "unavailable", not "broken".
  // The front door asks this first so a 503 still wins over an empty query,
  // exactly like the retired handler's order.
  function messageScope() {
    let runtime = null;
    try {
      runtime = typeof messages === 'function' ? messages() : messages;
    } catch (error) {
      logger.warn?.(`message_search_unavailable: ${error.message}`);
    }
    if (!runtime || typeof runtime.findMessages !== 'function') return { unavailable: true };
    return { warming: !!runtime.status?.().warming };
  }

  // 查询校验（空串/超长/过滤键超长）在 Rust 侧完成；这里只查索引并把
  // 命中映射成会话行，失败统一 503 message_search_unavailable。
  function findMessages({ text, limit, kinds = null, refIds = null, dirId = null, taskId = null }) {
    try {
      const runtime = typeof messages === 'function' ? messages() : messages;
      if (!runtime || typeof runtime.findMessages !== 'function') throw new Error('message_search_unavailable');
      const found = runtime.findMessages({ text, limit,
        ...(kinds ? { kinds } : {}), ...(refIds ? { refIds } : {}),
        ...(dirId ? { dirId } : {}), ...(taskId ? { taskId } : {}) });
      // Best-effort: a board that cannot be read costs the hits their task ids (the
      // client then shows fewer rows), never the whole answer.
      let bySession = null;
      try {
        const board = getBoard();
        if (board && typeof board.tasks === 'object') bySession = sessionTaskIds(board);
      } catch (error) {
        logger.warn?.(`message_search_board_failed: ${error.message}`);
      }
      return found.map(hit => ({
        sessionId: hit.sessionId,
        messageId: hit.messageId,
        kind: hit.kind,
        updatedAt: hit.updatedAt,
        score: hit.score,
        taskIds: bySession ? (bySession.get(String(hit.sessionId || '')) || []) : [],
        // Same shape the board route returns — a window plus highlight ranges — so
        // a client renders message hits with the snippet renderer it already has.
        snippet: hit.snippet,
      }));
    } catch (error) {
      logger.warn?.(`message_search_failed: ${error.message}`);
      throw Object.assign(new Error('message_search_unavailable'), { code: 'message_search_unavailable', status: 503 });
    }
  }

  /** The retired handler, kept for callers/tests that still hand it a fake req. */
  function handleMessageSearch(req, res) {
    const query = String(req.query?.q ?? req.query?.query ?? '').trim();
    const scope = messageScope();
    if (scope.unavailable) return res.status(503).json({ error: 'message_search_unavailable' });
    const warming = scope.warming === true;
    if (!query) return res.json({ ok: true, query: '', count: 0, results: [], warming });
    if (query.length > MAX_QUERY_CHARS) {
      return res.status(400).json({ error: 'query_too_long', maxLength: MAX_QUERY_CHARS });
    }
    try {
      const kinds = csv(req.query?.role) || csv(req.query?.kinds);
      const refIds = csv(req.query?.session) || csv(req.query?.sessions);
      const dirId = String(req.query?.dirId || '').trim();
      const taskId = String(req.query?.taskId || '').trim();
      if (dirId.length > MAX_FILTER_CHARS || taskId.length > MAX_FILTER_CHARS) {
        return res.status(400).json({ error: 'filter_too_long', maxLength: MAX_FILTER_CHARS });
      }
      const found = findMessages({ text: query, limit: clampLimit(req.query?.limit), kinds, refIds, dirId, taskId });
      return res.json({ ok: true, query, count: found.length, mode: 'message', warming, results: found });
    } catch (error) {
      return res.status(503).json({ error: 'message_search_unavailable' });
    }
  }

  // 两条 GET 已由 Rust 前门独占（native/gateway/src/app/task_routes.rs）；
  // 这里只留回环宿主端口用的检索入口。
  return { searchBoard, messageScope, findMessages, handleSearch, handleMessageSearch };
}

module.exports = {
  createTaskSearchRoutes,
  MAX_QUERY_CHARS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
