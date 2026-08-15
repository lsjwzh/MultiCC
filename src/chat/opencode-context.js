'use strict';

// Read-only water level for OpenCode native sessions.
//
// OpenCode keeps its native conversation in ~/.local/share/opencode/opencode.db
// (SQLite, WAL). The authoritative usage figure is the `tokens` object of the
// session's LATEST message row: `total` is what the model saw on the most
// recent request, i.e. the live context water level. Queries are strictly
// scoped by the exact native session id MultiCC captured from the adapter's
// session_started event, so sibling sessions in the same working directory are
// never mis-attributed.
//
// Everything here is read-only (node:sqlite readOnly connection tolerates the
// live WAL). MultiCC never writes to the user's OpenCode database.

const path = require('path');
const { createOpencodeModelLimitResolver } = require('../providers/opencode-model-limits');

const DEFAULT_DB_PATH = () => {
  const home = process.env.HOME || require('node:os').homedir();
  return path.join(home, '.local', 'share', 'opencode', 'opencode.db');
};

const DEFAULT_THRESHOLD = 0.85;

function clampThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.min(0.95, Math.max(0.5, n));
}

function resolveThreshold(env = process.env) {
  if (env.MULTICC_OPENCODE_CONTEXT_THRESHOLD != null && env.MULTICC_OPENCODE_CONTEXT_THRESHOLD !== '') {
    return clampThreshold(env.MULTICC_OPENCODE_CONTEXT_THRESHOLD);
  }
  return DEFAULT_THRESHOLD;
}

function openDefaultDatabase(dbPath) {
  // Lazy require: node:sqlite is experimental and emits a startup warning; the
  // lazy load also keeps the module requireable in environments without it.
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

function extractTokens(data) {
  const tokens = data && typeof data === 'object' ? data.tokens : null;
  if (!tokens || typeof tokens !== 'object') return null;
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    total: num(tokens.total),
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(tokens.cache && tokens.cache.read),
    cacheWrite: num(tokens.cache && tokens.cache.write),
  };
}

function createOpencodeContextReader(deps = {}) {
  const dbPathResolver = deps.dbPath
    ? () => deps.dbPath
    : DEFAULT_DB_PATH;
  const openDatabase = deps.openDatabase || openDefaultDatabase;
  const limitResolver = deps.limitResolver || createOpencodeModelLimitResolver();
  const logger = deps.logger || console;
  const threshold = deps.threshold != null ? clampThreshold(deps.threshold) : resolveThreshold(deps.env);

  // Reads the latest message's token usage for exactly one native session.
  // Returns null when the row / db is unavailable — callers degrade, never throw.
  function read(sessionId, modelId) {
    const nativeId = String(sessionId || '').trim();
    if (!nativeId) return { found: false, reason: 'no-native-session' };
    let db;
    try {
      db = openDatabase(dbPathResolver());
    } catch (_) {
      return { found: false, reason: 'db-unavailable' };
    }
    try {
      const row = db.prepare(
        'SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1',
      ).get(nativeId);
      if (!row) return { found: false, reason: 'session-not-found' };
      let data;
      try { data = JSON.parse(row.data); } catch (_) { data = null; }
      const tokens = extractTokens(data);
      if (!tokens) return { found: false, reason: 'usage-missing' };
      const limit = limitResolver.resolve(modelId);
      const ratio = limit.context > 0 ? tokens.total / limit.context : 0;
      return {
        found: true,
        sessionId: nativeId,
        tokens,
        limit: { context: limit.context, output: limit.output, source: limit.source },
        threshold,
        ratio: Math.round(ratio * 1000) / 1000,
        wouldRotate: limit.source === 'models.dev' && ratio >= threshold,
      };
    } catch (error) {
      try { logger.warn('opencode_context_read_failed', { reason: error && error.message }); } catch (_) {}
      return { found: false, reason: 'read-failed' };
    } finally {
      try { if (db && typeof db.close === 'function') db.close(); } catch (_) {}
    }
  }

  return Object.freeze({ read, threshold });
}

module.exports = {
  DEFAULT_THRESHOLD,
  clampThreshold,
  createOpencodeContextReader,
  resolveThreshold,
};
