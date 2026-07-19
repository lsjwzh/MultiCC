'use strict';

// Golden tests for the extracted codex session-file finder
// (src/cli-adapters/codex-session-file.js). Uses a real temp directory with
// real rollout *.jsonl files so the fs scan / first-line session_meta parse /
// cwd realpath match / mtime filter / recency ordering are all exercised
// end-to-end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCodexSessionFinder } = require('../src/cli-adapters/codex-session-file');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sess-'));
}

// Write a rollout file whose first line is a session_meta record.
function writeSession(dir, name, { id, cwd, mtimeMs, firstLine }) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const line = firstLine !== undefined
    ? firstLine
    : JSON.stringify({ type: 'session_meta', payload: { id, cwd } });
  fs.writeFileSync(p, line + '\n{"type":"event"}\n');
  if (mtimeMs !== undefined) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

function finderFor(defaultSessionsDir) {
  return createCodexSessionFinder({ fs, path, defaultSessionsDir }).findCodexSessionId;
}

test('matches the session_meta whose cwd equals the launch cwd', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  writeSession(root, 'a.jsonl', { id: 'sess-A', cwd, mtimeMs: Date.now() });
  const find = finderFor(root);
  assert.equal(find(cwd, 0), 'sess-A');
});

test('returns null when no session cwd matches', () => {
  const root = tmpRoot();
  writeSession(root, 'a.jsonl', { id: 'sess-A', cwd: '/some/other/path', mtimeMs: Date.now() });
  const find = finderFor(root);
  assert.equal(find('/not/this/one', 0), null);
});

test('ignores files modified before sinceMs', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const old = Date.now() - 60_000;
  writeSession(root, 'old.jsonl', { id: 'sess-old', cwd, mtimeMs: old });
  const find = finderFor(root);
  // sinceMs strictly after the file's mtime → filtered out
  assert.equal(find(cwd, old + 10_000), null);
  // sinceMs at/below the mtime → included
  assert.equal(find(cwd, old - 10_000), 'sess-old');
});

test('prefers the most-recently-modified matching session', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  writeSession(root, 'older.jsonl', { id: 'sess-older', cwd, mtimeMs: Date.now() - 30_000 });
  writeSession(root, 'newer.jsonl', { id: 'sess-newer', cwd, mtimeMs: Date.now() });
  const find = finderFor(root);
  assert.equal(find(cwd, 0), 'sess-newer');
});

test('recurses into subdirectories (codex nests by date)', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  writeSession(path.join(root, '2026', '07'), 'nested.jsonl', { id: 'sess-nested', cwd, mtimeMs: Date.now() });
  const find = finderFor(root);
  assert.equal(find(cwd, 0), 'sess-nested');
});

test('skips files whose first record is not session_meta, or lacks an id', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  writeSession(root, 'notmeta.jsonl', { firstLine: JSON.stringify({ type: 'event', payload: { cwd } }), mtimeMs: Date.now() });
  writeSession(root, 'noid.jsonl', { firstLine: JSON.stringify({ type: 'session_meta', payload: { cwd } }), mtimeMs: Date.now() });
  const find = finderFor(root);
  assert.equal(find(cwd, 0), null);
});

test('tolerates a malformed first line without throwing', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  writeSession(root, 'bad.jsonl', { firstLine: '{not valid json', mtimeMs: Date.now() });
  writeSession(root, 'good.jsonl', { id: 'sess-good', cwd, mtimeMs: Date.now() - 1000 });
  const find = finderFor(root);
  assert.equal(find(cwd, 0), 'sess-good');
});

test('returns null when the sessions dir does not exist', () => {
  const find = finderFor(path.join(os.tmpdir(), 'definitely-not-here-' + process.pid));
  assert.equal(find('/whatever', 0), null);
});

test('an explicit sessionsDir arg overrides the default', () => {
  const def = tmpRoot();
  const override = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  writeSession(def, 'd.jsonl', { id: 'from-default', cwd, mtimeMs: Date.now() });
  writeSession(override, 'o.jsonl', { id: 'from-override', cwd, mtimeMs: Date.now() });
  const find = finderFor(def);
  assert.equal(find(cwd, 0, override), 'from-override');
});

test('createCodexSessionFinder validates its deps', () => {
  assert.throws(() => createCodexSessionFinder({ path }), /fs is required/);
  assert.throws(() => createCodexSessionFinder({ fs }), /path is required/);
});
