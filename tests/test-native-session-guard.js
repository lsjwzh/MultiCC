'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createNativeSessionGuard,
  DEFAULT_MAX_BYTES,
  DEFAULT_ARCHIVE_TTL_DAYS,
  ARCHIVE_DIRNAME,
} = require('../src/chat/native-session-guard');

// The guard protects the resume-capable non-codex lanes (zcode/kimi/
// codebuddy/qoder/dsh) from unbounded native session growth — the same
// failure class as the 181MB codex rollout. These tests run against real
// temp homes so the walk/archive/sweep semantics are exercised end to end.
delete process.env.MULTICC_NATIVE_SESSION_MAX_BYTES;
delete process.env.MULTICC_NATIVE_SESSION_ARCHIVE_TTL_DAYS;

function setupHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-native-guard-'));
  return { homeDir };
}

function zcodeHomeFor(homeDir) {
  return sessionId => path.join(homeDir, '.multicc', 'zcode-homes', `${sessionId}-deadbeef0000`);
}

function writeFile(file, sizeBytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(sizeBytes));
  return file;
}

test('unhandled clis, missing cliSessionId and null records are skipped', () => {
  const { homeDir } = setupHome();
  const guard = createNativeSessionGuard({ homeDir, env: {} });
  assert.equal(guard.enforce(null).action, 'skipped');
  assert.equal(guard.enforce({ cli: 'claude', cliSessionId: 'abc' }).action, 'skipped');
  assert.equal(guard.enforce({ cli: 'codex', cliSessionId: 'abc' }).action, 'skipped');
  assert.equal(guard.enforce({ cli: 'gemini', cliSessionId: 'abc' }).action, 'skipped');
  assert.equal(guard.enforce({ cli: 'grok', cliSessionId: 'abc' }).action, 'skipped');
  assert.equal(guard.enforce({ cli: 'zcode', cliSessionId: null }).action, 'skipped');
});

test('handles() covers exactly the guarded lanes', () => {
  const guard = createNativeSessionGuard({ homeDir: os.tmpdir() });
  for (const cli of ['zcode', 'kimi', 'codebuddy', 'qoder', 'dsh']) {
    assert.equal(guard.handles(cli), true, cli);
  }
  for (const cli of ['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'gemini', 'grok']) {
    assert.equal(guard.handles(cli), false, cli);
  }
});

test('zcode: oversized rollout under <home>/.zcode is archived, never deleted', () => {
  const { homeDir } = setupHome();
  const record = { id: 'task-abc', cli: 'zcode', cliSessionId: 'sess_12345', provider: 'zp' };
  const zhome = zcodeHomeFor(homeDir)(record.id);
  const file = writeFile(path.join(zhome, '.zcode', 'cli', 'rollout', 'model-io-sess_12345.jsonl'), 4096);
  const guard = createNativeSessionGuard({
    homeDir, env: {}, maxBytes: 1024, zcodeSessionHomeFor: zcodeHomeFor(homeDir),
  });
  const result = guard.enforce(record);

  assert.equal(result.action, 'archived');
  assert.equal(result.cliSessionId, 'sess_12345');
  assert.equal(fs.existsSync(file), false, 'original is gone from the rollout dir');
  assert.equal(result.archived.length, 1);
  const archivedTo = result.archived[0].archivedTo;
  assert.ok(archivedTo.startsWith(path.join(zhome, '.zcode', ARCHIVE_DIRNAME) + path.sep));
  assert.equal(fs.readFileSync(archivedTo, 'utf8').length, 4096, 'content preserved');
  // A second enforce must not re-match the archived copy (archive dir is skipped).
  assert.equal(guard.enforce(record).action, 'not_found');
});

test('zcode: within budget is left untouched; missing home is not_found', () => {
  const { homeDir } = setupHome();
  const record = { id: 'task-small', cli: 'zcode', cliSessionId: 'sess_ok', provider: 'zp' };
  const zhome = zcodeHomeFor(homeDir)(record.id);
  const file = writeFile(path.join(zhome, '.zcode', 'cli', 'rollout', 'model-io-sess_ok.jsonl'), 512);
  const guard = createNativeSessionGuard({
    homeDir, env: {}, maxBytes: 1024, zcodeSessionHomeFor: zcodeHomeFor(homeDir),
  });
  assert.equal(guard.enforce(record).action, 'ok');
  assert.ok(fs.existsSync(file));
  assert.equal(guard.enforce({ id: 'task-none', cli: 'zcode', cliSessionId: 'sess_x', provider: 'zp' }).action, 'not_found');
});

test('kimi providerless: transcripts under ~/.kimi-code are archived by id match', () => {
  const { homeDir } = setupHome();
  const record = { id: 'task-kimi', cli: 'kimi', cliSessionId: 'k-sess-9', provider: null };
  const file = writeFile(path.join(homeDir, '.kimi-code', 'projects', 'cwd-slug', 'k-sess-9.jsonl'), 4096);
  const guard = createNativeSessionGuard({ homeDir, env: {}, maxBytes: 1024 });
  const result = guard.enforce(record);

  assert.equal(result.action, 'archived');
  assert.equal(fs.existsSync(file), false);
  assert.ok(result.archived[0].archivedTo.startsWith(path.join(homeDir, '.kimi-code', ARCHIVE_DIRNAME) + path.sep));
});

test('kimi provider lane: the per-session kimi home is the scan root', () => {
  const { homeDir } = setupHome();
  const kimiHome = path.join(homeDir, '.multicc', 'kimi-homes', 'task-kp-deadbeef0000');
  const record = { id: 'task-kp', cli: 'kimi', cliSessionId: 'k-sess-p', provider: 'kp' };
  writeFile(path.join(kimiHome, 'projects', 'cwd', 'k-sess-p.jsonl'), 4096);
  const guard = createNativeSessionGuard({
    homeDir, env: {}, maxBytes: 1024, kimiSessionHomeFor: () => kimiHome,
  });
  const result = guard.enforce(record);
  assert.equal(result.action, 'archived');
  assert.ok(result.archived[0].archivedTo.startsWith(path.join(kimiHome, ARCHIVE_DIRNAME) + path.sep));
});

test('codebuddy: Claude-Code-layout transcripts are archived under ~/.codebuddy', () => {
  const { homeDir } = setupHome();
  const record = { id: 'task-cb', cli: 'codebuddy', cliSessionId: '01a0c378-075a', provider: null };
  const file = writeFile(path.join(homeDir, '.codebuddy', 'projects', 'Users-x-y', '01a0c378-075a.jsonl'), 8192);
  const guard = createNativeSessionGuard({ homeDir, env: {}, maxBytes: 1024 });
  const result = guard.enforce(record);

  assert.equal(result.action, 'archived');
  assert.equal(fs.existsSync(file), false);
  assert.ok(result.archived[0].archivedTo.startsWith(path.join(homeDir, '.codebuddy', ARCHIVE_DIRNAME) + path.sep));
  assert.equal(guard.enforce(record).action, 'not_found', 'archived copy is not re-matched');
});

test('qoder: no matching transcript degrades to not_found (layout unverified)', () => {
  const { homeDir } = setupHome();
  fs.mkdirSync(path.join(homeDir, '.qoder'), { recursive: true });
  const guard = createNativeSessionGuard({ homeDir, env: {} });
  assert.equal(guard.enforce({ id: 'task-q', cli: 'qoder', cliSessionId: 'q-1' }).action, 'not_found');
});

test('dsh: the whole per-session directory is archived when oversized', () => {
  const { homeDir } = setupHome();
  const record = { id: 'task-dsh', cli: 'dsh', cliSessionId: 'multicc-0df62c53-19e1', provider: null };
  const sessionDir = path.join(homeDir, '.dsh', 'sessions', '--cwd--', record.cliSessionId);
  writeFile(path.join(sessionDir, 'session.jsonl.zstd'), 4096);
  const guard = createNativeSessionGuard({ homeDir, env: {}, maxBytes: 1024 });
  const result = guard.enforce(record);

  assert.equal(result.action, 'archived');
  assert.equal(fs.existsSync(sessionDir), false, 'session dir moved out of the store');
  const archivedTo = result.archived[0].archivedTo;
  assert.ok(archivedTo.startsWith(path.join(homeDir, '.dsh', ARCHIVE_DIRNAME) + path.sep));
  assert.equal(fs.existsSync(path.join(archivedTo, 'session.jsonl.zstd')), true, 'dir content preserved');
  // Other sessions of the same cwd stay put.
});

test('dsh: within budget dir is left untouched', () => {
  const { homeDir } = setupHome();
  const record = { id: 'task-dsh2', cli: 'dsh', cliSessionId: 'multicc-small-1', provider: null };
  const sessionDir = path.join(homeDir, '.dsh', 'sessions', '--cwd--', record.cliSessionId);
  writeFile(path.join(sessionDir, 'session.jsonl.zstd'), 128);
  const guard = createNativeSessionGuard({ homeDir, env: {}, maxBytes: 1024 });
  assert.equal(guard.enforce(record).action, 'ok');
  assert.ok(fs.existsSync(sessionDir));
});

test('force archives regardless of size (manual context rebuild)', () => {
  const { homeDir } = setupHome();
  const record = { id: 'task-cbf', cli: 'codebuddy', cliSessionId: 'cb-force', provider: null };
  writeFile(path.join(homeDir, '.codebuddy', 'projects', 'x', 'cb-force.jsonl'), 64);
  const guard = createNativeSessionGuard({ homeDir, maxBytes: 10 * 1024 * 1024 });
  assert.equal(guard.enforce(record, { force: true }).action, 'archived');
});

test('expired archives are swept by TTL; fresh ones survive', () => {
  const { homeDir } = setupHome();
  const archiveDir = path.join(homeDir, '.codebuddy', ARCHIVE_DIRNAME);
  const stale = writeFile(path.join(archiveDir, 'old.jsonl'), 100);
  const fresh = writeFile(path.join(archiveDir, 'new.jsonl'), 100);
  const oldMs = Date.now() - 31 * 86400000;
  fs.utimesSync(stale, new Date(oldMs), new Date(oldMs));
  const guard = createNativeSessionGuard({ homeDir, env: {} });
  const sweep = guard.sweepExpiredArchives({ force: true });
  assert.deepEqual(sweep.deleted, [stale]);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('sweep also removes expired archived directories (dsh shape)', () => {
  const { homeDir } = setupHome();
  const archiveDir = path.join(homeDir, '.dsh', ARCHIVE_DIRNAME);
  const staleDir = path.join(archiveDir, 'task-x-multicc-old-1');
  writeFile(path.join(staleDir, 'session.jsonl.zstd'), 100);
  const oldMs = Date.now() - 31 * 86400000;
  fs.utimesSync(staleDir, new Date(oldMs), new Date(oldMs));
  const guard = createNativeSessionGuard({ homeDir, env: {} });
  const sweep = guard.sweepExpiredArchives({ force: true });
  assert.deepEqual(sweep.deleted, [staleDir]);
  assert.equal(fs.existsSync(staleDir), false);
});

test('ttl 0 disables cleanup; constants are exported', () => {
  const { homeDir } = setupHome();
  const guard = createNativeSessionGuard({ homeDir, env: {}, archiveTtlDays: 0 });
  assert.equal(guard.sweepExpiredArchives({ force: true }).disabled, true);
  assert.equal(DEFAULT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(DEFAULT_ARCHIVE_TTL_DAYS, 30);
  assert.equal(ARCHIVE_DIRNAME, 'multicc-archived-sessions');
});
