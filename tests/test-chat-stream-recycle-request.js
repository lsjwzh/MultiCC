'use strict';

// An explicit recycle request (chat-stream.recycle) exists for one reason: a `-p`
// process holds the conversation in memory, so trimming its transcript on disk
// changes nothing until the process restarts with `--resume <same id>` and re-reads
// the file. Without this, the context governor prunes bytes nobody is reading.
//
// The three behaviours that matter:
//   1. idle  → replaced now, and the respawn resumes the same session id;
//   2. busy  → applied at the turn boundary, never mid-turn;
//   3. live background work → deferred, because killing that process reaps the task
//      and orphans its shadow monitor (the "后台任务一直转圈" bug).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stream = require('../src/chat-stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-recycle-req-'));
const spawnLog = path.join(tmp, 'spawns.jsonl');

// Fake CLI: logs its argv/pid on start, then answers each stdin line with a
// `result` event after a short delay (so a turn is observably in flight).
const fakeCli = [
  "const fs=require('fs')",
  "fs.appendFileSync(process.env.SPAWN_LOG, JSON.stringify({argv:process.argv.slice(1),pid:process.pid})+'\\n')",
  "let buf=''",
  "process.stdin.on('data', c => {",
  "  buf += c.toString()",
  "  while (buf.includes('\\n')) {",
  "    const i=buf.indexOf('\\n'); buf=buf.slice(i+1)",
  "    setTimeout(() => process.stdout.write(JSON.stringify({type:'result', result:'ok'})+'\\n'), 120)",
  "  }",
  "})",
  "process.stdin.on('end', () => process.exit(0))",
].join(';');

let bgActive = false;

function ensureWith(name, sessionId) {
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: process.cwd(),
    sessionId,
    baseArgs: ['-e', fakeCli, '--'],
    env: { PATH: process.env.PATH, SPAWN_LOG: spawnLog },
    isBackgroundActive: () => bgActive,
    resume: false,
  });
}

const readSpawns = () => {
  const raw = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim() : '';
  return raw ? raw.split('\n').map(JSON.parse) : [];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const name = 'recycle-req';
  const sid = 'recycle-req-session';

  // ── unknown session: a no-op, not a throw ─────────────────────────────────
  assert.deepStrictEqual(stream.recycle('never-ensured', 'x'),
    { ok: false, applied: 'unknown-session' });

  ensureWith(name, sid);
  // ── not yet spawned: nothing to replace; the first spawn reads the new file ─
  assert.strictEqual(stream.recycle(name, 'pruned').applied, 'not-running');

  await stream.send(name, 'turn-1', () => {});
  const pid1 = stream.status(name).pid;
  assert.strictEqual(readSpawns().length, 1);

  // ── 1. idle → replaced immediately, respawn resumes the same session ───────
  assert.strictEqual(stream.recycle(name, 'transcript-pruned').applied, 'now');
  await sleep(250);
  assert.strictEqual(stream.isAlive(name), false, 'the old process is gone');
  assert.strictEqual(stream.status(name).recycling, false,
    'the exit must clear `recycling`, or every future turn on this session is blocked');

  await stream.send(name, 'turn-2', () => {});
  const spawns = readSpawns();
  assert.strictEqual(spawns.length, 2, 'exactly one respawn');
  assert.notStrictEqual(stream.status(name).pid, pid1, 'new process');
  assert.deepStrictEqual(spawns[1].argv, ['--resume', sid],
    'the respawn must --resume the same id, or the trimmed transcript is not what comes back');

  // ── 2. busy → deferred to the turn boundary, turn still completes ──────────
  const pid2 = stream.status(name).pid;
  const inFlight = stream.send(name, 'turn-3', () => {});
  await sleep(20);   // mid-turn
  assert.strictEqual(stream.status(name).busy, true, 'turn is in flight');
  assert.strictEqual(stream.recycle(name, 'transcript-pruned').applied, 'deferred-boundary');
  assert.strictEqual(stream.status(name).pid, pid2, 'a recycle must never interrupt a live turn');
  await inFlight;    // the turn itself completes normally

  // The pending request is applied when the next turn pumps.
  await stream.send(name, 'turn-4', () => {});
  assert.notStrictEqual(stream.status(name).pid, pid2, 'deferred recycle applied at the boundary');
  assert.strictEqual(readSpawns().length, 3);
  assert.strictEqual(stream.status(name).recycleRequested, false, 'request consumed');

  // ── 3. live background work → deferred, process left alone ────────────────
  const pid3 = stream.status(name).pid;
  bgActive = true;
  assert.strictEqual(stream.recycle(name, 'transcript-pruned').applied, 'deferred-background');
  await sleep(120);
  assert.strictEqual(stream.status(name).pid, pid3,
    'killing a process that owns live background work reaps the task and orphans its monitor');
  // A turn while background work is live must run, not stall on the pending request.
  await stream.send(name, 'turn-5', () => {});
  assert.strictEqual(stream.status(name).pid, pid3, 'still held while background work is live');
  assert.strictEqual(stream.status(name).recycleRequested, true, 'request still pending');
  // Once the background work clears, the next boundary applies it.
  bgActive = false;
  await stream.send(name, 'turn-6', () => {});
  assert.notStrictEqual(stream.status(name).pid, pid3, 'applied once the hold is released');

  stream.close(name);
  console.log('chat-stream recycle-request tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  stream.close('recycle-req');
  fs.rmSync(tmp, { recursive: true, force: true });
});
