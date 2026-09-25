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
//   GET /api/search/messages     ranked message chunks (src/search/runtime.js)
//
// Both live in this module because both are the same search box asking two
// corpora, and because the host mounts this module once — a second route module
// would cost server.js a line it does not have (see scripts/check-source-line-budget.js).
//
// Read-only: nothing here mutates the board or touches disk. The message route
// does hand work to the index runtime, but only reads: it never triggers a sweep.

const search = require('../task-board/search');

const MAX_QUERY_CHARS = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

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

function createTaskSearchRoutes({ getBoard, messages = null, logger = console } = {}) {
  if (typeof getBoard !== 'function') {
    throw new TypeError('task-search routes require a getBoard() port');
  }

  function handleSearch(req, res) {
    const query = String(req.query?.q ?? req.query?.query ?? '').trim();
    if (!query) return res.json({ ok: true, query: '', count: 0, results: [] });
    if (query.length > MAX_QUERY_CHARS) {
      return res.status(400).json({ error: 'query_too_long', maxLength: MAX_QUERY_CHARS });
    }
    let board = null;
    try {
      board = getBoard();
    } catch (error) {
      logger.warn?.(`task_search_board_failed: ${error.message}`);
      return res.status(503).json({ error: 'task_board_unavailable' });
    }
    if (!board || typeof board.tasks !== 'object') {
      return res.status(503).json({ error: 'task_board_unavailable' });
    }
    const results = search.searchBoard(board, query, {
      limit: clampLimit(req.query?.limit),
      dirId: String(req.query?.dirId || '').trim() || null,
      dirIds: csv(req.query?.dirIds),
      statuses: csv(req.query?.statuses),
      minScore: Number(req.query?.minScore) || 0,
    });
    return res.json({ ok: true, query, count: results.length, results });
  }

  // The message corpus is the whole conversation, so a result is a *session* plus
  // a chunk — not a task. Each hit therefore also carries the task ids that session
  // belongs to (`taskIds`, resolved from the board's refs, best-effort): that is what
  // lets a search box list these hits as task rows next to the board's own.
  //
  // `warming` is reported rather than hidden: while the first sweep is still
  // walking the corpus a short result list is a partial answer, and a client that
  // cannot tell the two apart would cache "no hits" for a query that has them.
  function handleMessageSearch(req, res) {
    const query = String(req.query?.q ?? req.query?.query ?? '').trim();
    // Resolving the runtime is itself a step that can fail (it opens the index),
    // and a route that cannot reach its index is "unavailable", not "broken": the
    // caller gets the same 503 as an unwired host rather than an Express 500.
    let runtime = null;
    try {
      runtime = typeof messages === 'function' ? messages() : messages;
    } catch (error) {
      logger.warn?.(`message_search_unavailable: ${error.message}`);
    }
    if (!runtime || typeof runtime.findMessages !== 'function') {
      return res.status(503).json({ error: 'message_search_unavailable' });
    }
    const warming = !!runtime.status?.().warming;
    if (!query) return res.json({ ok: true, query: '', count: 0, results: [], warming });
    if (query.length > MAX_QUERY_CHARS) {
      return res.status(400).json({ error: 'query_too_long', maxLength: MAX_QUERY_CHARS });
    }
    try {
      // Only the two conversation roles are indexed, so the filter is expressed in
      // the caller's words and unknown ones are dropped by the index's own filter.
      const kinds = csv(req.query?.role) || csv(req.query?.kinds);
      const refIds = csv(req.query?.session) || csv(req.query?.sessions);
      const found = runtime.findMessages({
        text: query,
        limit: clampLimit(req.query?.limit),
        ...(kinds ? { kinds } : {}),
        ...(refIds ? { refIds } : {}),
      });
      // Best-effort: a board that cannot be read costs the hits their task ids (the
      // client then shows fewer rows), never the whole answer.
      let bySession = null;
      try {
        const board = getBoard();
        if (board && typeof board.tasks === 'object') bySession = sessionTaskIds(board);
      } catch (error) {
        logger.warn?.(`message_search_board_failed: ${error.message}`);
      }
      return res.json({
        ok: true,
        query,
        count: found.length,
        mode: 'message',
        warming,
        results: found.map(hit => ({
          sessionId: hit.sessionId,
          messageId: hit.messageId,
          kind: hit.kind,
          updatedAt: hit.updatedAt,
          score: hit.score,
          taskIds: bySession ? (bySession.get(String(hit.sessionId || '')) || []) : [],
          // Same shape the board route returns — a window plus highlight ranges — so
          // a client renders message hits with the snippet renderer it already has.
          snippet: hit.snippet,
        })),
      });
    } catch (error) {
      logger.warn?.(`message_search_failed: ${error.message}`);
      return res.status(503).json({ error: 'message_search_unavailable' });
    }
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function') {
      throw new TypeError('task-search routes require Express app.get');
    }
    app.get('/api/task-board/search', handleSearch);
    app.get('/api/search/messages', handleMessageSearch);
  }

  return { mountRoutes, handleSearch, handleMessageSearch };
}

module.exports = {
  createTaskSearchRoutes,
  MAX_QUERY_CHARS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
