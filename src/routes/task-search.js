'use strict';

// Full-text task search over HTTP.
//
// The board itself is already fully downloaded by every client (Air snapshot /
// console), but the *searchable* corpus is not: turn excerpts live only in the
// board file, which no client holds. So the ranking runs here, on the same pure
// module the attribution path uses (src/task-board/search.js), and the client
// gets ranked ids plus the matched snippet — never the whole corpus.
//
// Read-only: nothing here mutates the board or touches disk.

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

function createTaskSearchRoutes({ getBoard, logger = console } = {}) {
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

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function') {
      throw new TypeError('task-search routes require Express app.get');
    }
    app.get('/api/task-board/search', handleSearch);
  }

  return { mountRoutes, handleSearch };
}

module.exports = { createTaskSearchRoutes, MAX_QUERY_CHARS, DEFAULT_LIMIT, MAX_LIMIT };
