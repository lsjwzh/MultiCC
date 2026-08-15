'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOpencodeContextReader,
  clampThreshold,
  resolveThreshold,
  DEFAULT_THRESHOLD,
} = require('../src/chat/opencode-context');
const { createOpencodeContextGuard } = require('../src/chat/opencode-context-guard');

// ── Reader ──────────────────────────────────────────────────────────────────

function fakeDb(rows) {
  return {
    prepare() {
      return { get: id => (rows[id] !== undefined ? { data: rows[id] } : undefined) };
    },
    close() {},
  };
}

function usageRow(total, extra = {}) {
  return JSON.stringify({ tokens: { total, input: 10, output: 5, cache: { read: total - 15, write: 0 } }, ...extra });
}

test('reader reports the water level of exactly the requested native session', () => {
  const opens = [];
  const reader = createOpencodeContextReader({
    dbPath: '/fake/opencode.db',
    openDatabase: p => { opens.push(p); return fakeDb({
      'ses-bloated': usageRow(897243),
      'ses-fresh': usageRow(1200),
    }); },
    limitResolver: { resolve: () => ({ context: 1000000, output: 32768, source: 'models.dev', matched: 1 }) },
    threshold: 0.85,
  });
  assert.deepEqual(opens, []);
  const bloated = reader.read('ses-bloated', 'deepseek-v4-flash');
  assert.equal(opens.length, 1, 'read-only connection per read');
  assert.equal(bloated.found, true);
  assert.equal(bloated.tokens.total, 897243);
  assert.deepEqual(bloated.limit, { context: 1000000, output: 32768, source: 'models.dev' });
  assert.equal(bloated.ratio, 0.897);
  assert.equal(bloated.wouldRotate, true);
  // A sibling session in the same cwd is a distinct native id and stays low.
  const fresh = reader.read('ses-fresh', 'deepseek-v4-flash');
  assert.equal(fresh.tokens.total, 1200);
  assert.equal(fresh.wouldRotate, false);
  // Unknown ids and missing rows degrade without throwing.
  assert.deepEqual(reader.read('nope', 'm'), { found: false, reason: 'session-not-found' });
  assert.deepEqual(reader.read('', 'm'), { found: false, reason: 'no-native-session' });
  assert.deepEqual(reader.read(null, 'm'), { found: false, reason: 'no-native-session' });
});

test('reader never rotates on a fallback (unknown-model) limit', () => {
  const reader = createOpencodeContextReader({
    openDatabase: () => fakeDb({ s1: usageRow(200000) }),
    limitResolver: { resolve: () => ({ context: 128000, output: 8192, source: 'fallback', matched: 0 }) },
    threshold: 0.85,
  });
  const usage = reader.read('s1', 'totally-unknown');
  assert.equal(usage.limit.source, 'fallback');
  // 200000/128000 > threshold, but a guessed window must not drive rotation.
  assert.equal(usage.wouldRotate, false);
});

test('reader degrades safely when the database is unavailable or corrupt', () => {
  const unavailable = createOpencodeContextReader({
    openDatabase: () => { throw new Error('ENOENT'); },
  });
  assert.deepEqual(unavailable.read('s1', 'm'), { found: false, reason: 'db-unavailable' });

  const logs = [];
  const corrupt = createOpencodeContextReader({
    openDatabase: () => fakeDb({ s1: 'not-json' }),
    logger: { warn: (event, payload) => logs.push({ event, payload }) },
  });
  assert.equal(corrupt.read('s1', 'm').found, false);
  const throwing = createOpencodeContextReader({
    openDatabase: () => ({ prepare() { throw new Error('locked'); }, close() {} }),
    logger: { warn: () => {} },
  });
  assert.equal(throwing.read('s1', 'm').reason, 'read-failed');
});

test('threshold resolves from env and clamps into a safe band', () => {
  assert.equal(DEFAULT_THRESHOLD, 0.85);
  assert.equal(resolveThreshold({}), 0.85);
  assert.equal(resolveThreshold({ MULTICC_OPENCODE_CONTEXT_THRESHOLD: '0.7' }), 0.7);
  assert.equal(resolveThreshold({ MULTICC_OPENCODE_CONTEXT_THRESHOLD: '0.05' }), 0.5);
  assert.equal(resolveThreshold({ MULTICC_OPENCODE_CONTEXT_THRESHOLD: '4' }), 0.95);
  assert.equal(resolveThreshold({ MULTICC_OPENCODE_CONTEXT_THRESHOLD: 'abc' }), 0.85);
  assert.equal(clampThreshold(NaN), 0.85);
});

// ── Guard ───────────────────────────────────────────────────────────────────

function guardWith(readerResult) {
  return createOpencodeContextGuard({
    contextReader: { read: () => readerResult },
    logger: { warn: () => {} },
  });
}

const RECORD = { kind: 'chat', cli: 'opencode', cliSessionId: 'ses-1', model: 'deepseek-v4-flash' };

test('guard orders rotation only on a real-limit breach at a safe boundary', () => {
  const verdict = guardWith({
    found: true,
    sessionId: 'ses-1',
    tokens: { total: 900000 },
    limit: { context: 1000000, output: 32768, source: 'models.dev' },
    threshold: 0.85,
    ratio: 0.9,
    wouldRotate: true,
  }).enforce(RECORD);
  assert.equal(verdict.action, 'rotate');
  assert.equal(verdict.reason, 'context_water_level_exceeded');
  assert.equal(verdict.tokensTotal, 900000);
  assert.equal(verdict.contextLimit, 1000000);
  assert.ok(Object.isFrozen(verdict));
});

test('guard stays passive below the threshold, on fallback limits, and while a handoff is pending', () => {
  const hot = { found: true, tokens: { total: 10 }, limit: { context: 1000000, source: 'models.dev' }, threshold: 0.85, ratio: 0.01, wouldRotate: false };
  assert.equal(guardWith(hot).enforce(RECORD).reason, 'below_threshold');

  const guessed = { found: true, tokens: { total: 900000 }, limit: { context: 128000, source: 'fallback' }, threshold: 0.85, ratio: 7, wouldRotate: false };
  const guessedVerdict = guardWith(guessed).enforce(RECORD);
  assert.equal(guessedVerdict.action, 'skipped');
  assert.equal(guessedVerdict.reason, 'limit_unknown');

  const pending = { ...RECORD, pendingCliHandoff: { status: 'pending', reason: 'auto_native_context_rotate' } };
  assert.equal(guardWith({ ...hot, wouldRotate: true, ratio: 0.99 }).enforce(pending).reason, 'handoff_pending');
  // A consumed handoff must not block the next rotation forever.
  const consumed = { ...RECORD, pendingCliHandoff: { status: 'consumed' } };
  assert.equal(guardWith({ ...hot, wouldRotate: true, ratio: 0.99 }).enforce(consumed).action, 'rotate');
});

test('guard skips sessions without a native id and fails open on reader errors', () => {
  assert.equal(guardWith({ found: true, wouldRotate: true }).enforce({ ...RECORD, cliSessionId: null }).reason, 'no_native_session');
  assert.equal(guardWith({ found: false, reason: 'db-unavailable' }).enforce(RECORD).reason, 'db-unavailable');
  assert.equal(guardWith({ found: false, reason: 'session-not-found' }).enforce(RECORD).reason, 'session-not-found');
  const failing = createOpencodeContextGuard({
    contextReader: { read: () => { throw new Error('boom'); } },
    logger: { warn: () => {} },
  });
  assert.equal(failing.enforce(RECORD).action, 'skipped');
  assert.equal(failing.enforce(RECORD).reason, 'error');
  // Prefer the streaming-path id when both exist, matching context-level.
  const streamed = guardWith({ found: true, tokens: { total: 950000 }, limit: { context: 1000000, source: 'models.dev' }, threshold: 0.85, ratio: 0.95, wouldRotate: true })
    .enforce({ ...RECORD, _streamSessionId: 'ses-stream' });
  assert.equal(streamed.action, 'rotate');
});

test('turn-engine wires the opencode rotation at turn admission, before native-session lineage', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  const hook = source.indexOf("turnCli === 'opencode' && persisted.cliSessionId");
  assert.ok(hook > 0, 'the opencode admission hook must exist');
  const codexHook = source.indexOf("turnCli === 'codex' && persisted.cliSessionId");
  assert.ok(codexHook > 0 && hook > codexHook, 'the opencode hook sits after the codex guard');
  const lineage = source.indexOf('hasNativeSession: !!persisted.cliSessionId');
  assert.ok(lineage > hook, 'rotation must clear native state BEFORE the turn decides first-vs-resume');
  assert.ok(source.includes("reason: 'auto_native_context_rotate'"));
  // Rotation is decision + shared handoff machinery, never a direct write into
  // the user's OpenCode database.
  const guardSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'chat', 'opencode-context-guard.js'), 'utf8');
  assert.equal(guardSource.includes('INSERT'), false);
  assert.equal(guardSource.includes('UPDATE'), false);
  assert.equal(guardSource.includes('DELETE'), false);
});

test('guard reads a real SQLite database read-only via node:sqlite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-opencode-ctx-'));
  const dbFile = path.join(root, 'opencode.db');
  // Build a minimal WAL-shaped database with better-sqlite3, then read it
  // through the default node:sqlite opener exactly like production.
  const Database = require('better-sqlite3');
  const db = new Database(dbFile);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  insert.run('m2', 'ses-a', 2000, usageRow(500000));
  insert.run('m1', 'ses-a', 1000, usageRow(100000));
  insert.run('m3', 'ses-b', 3000, usageRow(50));
  db.close();
  const reader = createOpencodeContextReader({
    dbPath: dbFile,
    limitResolver: { resolve: () => ({ context: 1000000, output: 32768, source: 'models.dev', matched: 1 }) },
    threshold: 0.85,
  });
  const usage = reader.read('ses-a', 'm');
  assert.equal(usage.found, true);
  // The LATEST message wins (500000, not the older 100000).
  assert.equal(usage.tokens.total, 500000);
  assert.equal(usage.wouldRotate, false);
  assert.equal(reader.read('ses-b', 'm').tokens.total, 50);
  fs.rmSync(root, { recursive: true, force: true });
});
