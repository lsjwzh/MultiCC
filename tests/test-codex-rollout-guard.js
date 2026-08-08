'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCodexRolloutGuard,
  DEFAULT_MAX_ROLLOUT_BYTES,
  DEFAULT_ARCHIVE_TTL_DAYS,
  ARCHIVE_DIRNAME,
} = require('../src/chat/codex-rollout-guard');

// The guard protects `codex exec resume` from oversized rollouts (observed:
// 440MB file → deterministic internal hang before the first upstream request).
// These tests run against a real temp home so the walk/archive semantics are
// exercised end to end.
delete process.env.MULTICC_CODEX_ROLLOUT_MAX_BYTES;
delete process.env.MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS;

function setupHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rollout-guard-'));
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '28');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return { homeDir, sessionsDir };
}

function writeRollout(sessionsDir, threadId, sizeBytes) {
  const file = path.join(sessionsDir, `rollout-2026-07-28T21-42-14-${threadId}.jsonl`);
  fs.writeFileSync(file, 'x'.repeat(sizeBytes));
  return file;
}

test('non-codex records and missing cliSessionId are skipped without touching fs', () => {
  const { homeDir } = setupHome();
  const guard = createCodexRolloutGuard({ homeDir });
  assert.equal(guard.enforce(null).action, 'skipped');
  assert.equal(guard.enforce({ cli: 'claude', cliSessionId: 'abc' }).action, 'skipped');
  assert.equal(guard.enforce({ cli: 'codex', cliSessionId: null }).action, 'skipped');
});

test('a rollout within budget is left untouched (action ok)', () => {
  const { homeDir, sessionsDir } = setupHome();
  const file = writeRollout(sessionsDir, 'thread-small', 1024);
  const guard = createCodexRolloutGuard({ homeDir, maxBytes: 10 * 1024 * 1024 });
  const result = guard.enforce({ cli: 'codex', cliSessionId: 'thread-small' });
  assert.equal(result.action, 'ok');
  assert.equal(result.totalBytes, 1024);
  assert.ok(fs.existsSync(file), 'within-budget file stays in place');
});

test('no matching rollout file yields not_found (fresh thread ids, missing dirs)', () => {
  const { homeDir } = setupHome();
  const guard = createCodexRolloutGuard({ homeDir });
  assert.equal(guard.enforce({ cli: 'codex', cliSessionId: 'no-such-thread' }).action, 'not_found');
});

test('an oversized rollout is archived out of the sessions tree, never deleted', () => {
  const { homeDir, sessionsDir } = setupHome();
  const file = writeRollout(sessionsDir, 'thread-big', 2048);
  const guard = createCodexRolloutGuard({ homeDir, maxBytes: 1024 });
  const result = guard.enforce({ cli: 'codex', cliSessionId: 'thread-big' });

  assert.equal(result.action, 'archived');
  assert.equal(result.cliSessionId, 'thread-big');
  assert.equal(result.archived.length, 1);
  assert.equal(result.archived[0].sizeBytes, 2048);
  assert.equal(fs.existsSync(file), false, 'original is gone from the sessions tree');
  const archivedTo = path.join(homeDir, '.codex', ARCHIVE_DIRNAME, path.basename(file));
  assert.equal(result.archived[0].archivedTo, archivedTo);
  assert.equal(fs.existsSync(archivedTo), true, 'content preserved in the archive dir');
  assert.equal(fs.readFileSync(archivedTo, 'utf8').length, 2048);
});

test('mixed sizes: only files above maxBytes are archived', () => {
  const { homeDir, sessionsDir } = setupHome();
  const big = writeRollout(sessionsDir, 'thread-mixed', 4096);
  const other = path.join(sessionsDir, 'rollout-extra-thread-mixed-2.jsonl');
  fs.writeFileSync(other, 'y'.repeat(10));
  const guard = createCodexRolloutGuard({ homeDir, maxBytes: 1024 });
  const result = guard.enforce({ cli: 'codex', cliSessionId: 'thread-mixed' });
  assert.equal(result.action, 'archived');
  assert.equal(result.archived.length, 1);
  assert.equal(result.archived[0].file, big);
  assert.ok(fs.existsSync(other), 'small sibling stays');
});

test('provider sessions live under codexHomesDir/<provider>', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rollout-guard-'));
  const codexHomesDir = path.join(homeDir, '.multicc', 'codex-homes');
  const sessionsDir = path.join(codexHomesDir, 'prov1', 'sessions', '2026', '01', '01');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, 'rollout-x-thread-prov.jsonl');
  fs.writeFileSync(file, 'z'.repeat(2048));
  const guard = createCodexRolloutGuard({ homeDir, codexHomesDir, maxBytes: 1024 });
  const result = guard.enforce({ cli: 'codex', cliSessionId: 'thread-prov', provider: 'prov1' });
  assert.equal(result.action, 'archived');
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(path.join(codexHomesDir, 'prov1', ARCHIVE_DIRNAME, path.basename(file))));
});

test('force mode archives regardless of size (restart-spawn contract)', () => {
  const { homeDir, sessionsDir } = setupHome();
  const file = writeRollout(sessionsDir, 'thread-force', 16); // tiny, under any budget
  const guard = createCodexRolloutGuard({ homeDir });
  const plain = guard.enforce({ cli: 'codex', cliSessionId: 'thread-force' });
  assert.equal(plain.action, 'ok', 'without force a tiny rollout stays');
  assert.ok(fs.existsSync(file));

  const forced = guard.enforce({ cli: 'codex', cliSessionId: 'thread-force' }, { force: true });
  assert.equal(forced.action, 'archived');
  assert.equal(forced.archived[0].sizeBytes, 16);
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(path.join(homeDir, '.codex', ARCHIVE_DIRNAME, path.basename(file))));

  const missing = guard.enforce({ cli: 'codex', cliSessionId: 'thread-force' }, { force: true });
  assert.equal(missing.action, 'not_found', 'already archived → nothing left to do');
});

test('default budget is 10MB and configurable via dep', () => {
  const guard = createCodexRolloutGuard({});
  assert.equal(guard.maxBytes, DEFAULT_MAX_ROLLOUT_BYTES);
  assert.equal(DEFAULT_MAX_ROLLOUT_BYTES, 10 * 1024 * 1024);
  assert.equal(createCodexRolloutGuard({ maxBytes: 5 }).maxBytes, 5);
  assert.equal(createCodexRolloutGuard({ maxBytes: NaN }).maxBytes, DEFAULT_MAX_ROLLOUT_BYTES);
});

test('filesystem failures fail open: action error, turn must proceed', () => {
  const { homeDir, sessionsDir } = setupHome();
  writeRollout(sessionsDir, 'thread-x', 2048);
  const warnings = [];
  const guard = createCodexRolloutGuard({
    // stat succeeds (file is over budget) but the archive move explodes — the
    // guard must surface 'error' without blocking the turn.
    fsImpl: { ...fs, renameSync: () => { throw new Error('disk exploded'); } },
    homeDir,
    maxBytes: 1024,
    logger: { warn: (name, payload) => warnings.push([name, payload]) },
  });
  const result = guard.enforce({ cli: 'codex', cliSessionId: 'thread-x' });
  assert.equal(result.action, 'error');
  assert.match(result.error, /disk exploded/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'codex_rollout_guard_error');
});

// --- archive TTL cleanup -----------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function writeArchived(archiveDir, name, sizeBytes, ageDays) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const file = path.join(archiveDir, name);
  fs.writeFileSync(file, 'a'.repeat(sizeBytes));
  const past = (Date.now() - ageDays * DAY_MS) / 1000;
  fs.utimesSync(file, past, past);
  return file;
}

test('sweep deletes archives older than the TTL and keeps fresh ones', () => {
  const { homeDir } = setupHome();
  const archiveDir = path.join(homeDir, '.codex', ARCHIVE_DIRNAME);
  const old = writeArchived(archiveDir, 'rollout-old.jsonl', 5000, DEFAULT_ARCHIVE_TTL_DAYS + 10);
  const fresh = writeArchived(archiveDir, 'rollout-fresh.jsonl', 300, 1);
  const guard = createCodexRolloutGuard({ homeDir });
  const result = guard.sweepExpiredArchives({ force: true });
  assert.deepEqual(result.deleted, [old]);
  assert.equal(result.freedBytes, 5000);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(fresh), 'fresh archive survives the sweep');
});

test('TTL defaults to 30 days, is configurable, and 0 disables cleanup', () => {
  const guard = createCodexRolloutGuard({});
  assert.equal(DEFAULT_ARCHIVE_TTL_DAYS, 30);
  assert.equal(guard.archiveTtlMs, 30 * DAY_MS);
  assert.equal(createCodexRolloutGuard({ archiveTtlDays: 7 }).archiveTtlMs, 7 * DAY_MS);
  assert.equal(createCodexRolloutGuard({ archiveTtlDays: 0 }).archiveTtlMs, 0);
  assert.equal(createCodexRolloutGuard({ archiveTtlDays: NaN }).archiveTtlMs, 30 * DAY_MS);

  const { homeDir } = setupHome();
  const archiveDir = path.join(homeDir, '.codex', ARCHIVE_DIRNAME);
  const ancient = writeArchived(archiveDir, 'rollout-ancient.jsonl', 100, 999);
  const disabled = createCodexRolloutGuard({ homeDir, archiveTtlDays: 0 });
  const result = disabled.sweepExpiredArchives({ force: true });
  assert.equal(result.disabled, true);
  assert.ok(fs.existsSync(ancient), 'TTL 0 keeps every archive forever');

  const shortTtl = createCodexRolloutGuard({ homeDir, archiveTtlDays: 1 });
  const swept = shortTtl.sweepExpiredArchives({ force: true });
  assert.deepEqual(swept.deleted, [ancient]);
});

test('sweep is throttled to one pass per 6h unless forced', () => {
  const { homeDir } = setupHome();
  const guard = createCodexRolloutGuard({ homeDir });
  const t0 = Date.now();
  assert.equal(guard.sweepExpiredArchives({ force: true, nowMs: t0 }).throttled, undefined);
  assert.equal(guard.sweepExpiredArchives({ nowMs: t0 + 3600_000 }).throttled, true, '1h later: throttled');
  const later = guard.sweepExpiredArchives({ nowMs: t0 + 7 * 3600_000 });
  assert.equal(later.throttled, undefined, 'after the interval the sweep runs again');
});

test('sweep covers provider codex homes under codexHomesDir', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rollout-guard-'));
  const codexHomesDir = path.join(homeDir, '.multicc', 'codex-homes');
  const provArchive = path.join(codexHomesDir, 'prov1', ARCHIVE_DIRNAME);
  const expired = writeArchived(provArchive, 'rollout-prov.jsonl', 700, 90);
  const guard = createCodexRolloutGuard({ homeDir, codexHomesDir });
  const result = guard.sweepExpiredArchives({ force: true });
  assert.deepEqual(result.deleted, [expired]);
});

test('a successful archive opportunistically sweeps expired entries', () => {
  const { homeDir, sessionsDir } = setupHome();
  const archiveDir = path.join(homeDir, '.codex', ARCHIVE_DIRNAME);
  const old = writeArchived(archiveDir, 'rollout-stale.jsonl', 900, DEFAULT_ARCHIVE_TTL_DAYS + 5);
  writeRollout(sessionsDir, 'thread-sweeper', 2048);
  const guard = createCodexRolloutGuard({ homeDir, maxBytes: 1024 });
  const result = guard.enforce({ cli: 'codex', cliSessionId: 'thread-sweeper' });
  assert.equal(result.action, 'archived');
  assert.equal(fs.existsSync(old), false, 'enforce piggybacks the TTL sweep');
});
