'use strict';

// A persistent `-p` chat process bakes its ANTHROPIC_* routing env at spawn
// time (ANTHROPIC_BASE_URL carries the provider id). Switching provider updates
// s.env via ensure() but a LIVE process keeps talking to the old upstream until
// it respawns. chat-stream must detect the changed routing fingerprint at the
// next turn boundary and recycle the process with --resume (context preserved),
// and must NOT recycle when the routing env is unchanged.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stream = require('../src/chat-stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-stream-recycle-'));
const spawnLog = path.join(tmp, 'spawns.jsonl');

// Fake CLI: on start, append {argv, base, pid}; stays alive and emits one
// `result` event per stdin line (mirrors a warm persistent process).
const fakeCli = [
  "const fs=require('fs')",
  "fs.appendFileSync(process.env.SPAWN_LOG, JSON.stringify({argv:process.argv.slice(1),base:process.env.ANTHROPIC_BASE_URL||null,pid:process.pid})+'\\n')",
  "let buf=''",
  "process.stdin.on('data', c => {",
  "  buf += c.toString()",
  "  while (buf.includes('\\n')) {",
  "    const i=buf.indexOf('\\n'); buf=buf.slice(i+1)",
  "    process.stdout.write(JSON.stringify({type:'result', result:'ok'})+'\\n')",
  "  }",
  "})",
].join(';');

function ensureWith(name, sessionId, baseUrl) {
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: process.cwd(),
    sessionId,
    baseArgs: ['-e', fakeCli, '--'],
    // Fresh env object each send (as the server rebuilds childEnv per turn).
    env: { PATH: process.env.PATH, SPAWN_LOG: spawnLog, ANTHROPIC_BASE_URL: baseUrl },
    resume: false,
  });
}

function readSpawns() {
  const raw = fs.readFileSync(spawnLog, 'utf8').trim();
  return raw ? raw.split('\n').map(JSON.parse) : [];
}

(async () => {
  const name = 'recycle-stream';
  const sid = 'recycle-session-id';
  const urlA = 'http://127.0.0.1:3000/claude-proxy/provider-A/' + sid;
  const urlB = 'http://127.0.0.1:3000/claude-proxy/provider-B/' + sid;

  // Turn 1 — provider A. First spawn uses --session-id.
  ensureWith(name, sid, urlA);
  await stream.send(name, 'turn-1', () => {});
  const pidA = stream.status(name).pid;
  assert.ok(stream.status(name).alive, 'process alive after turn 1');

  // Turn 2 — SAME provider A. Must NOT recycle: same pid, still one spawn.
  ensureWith(name, sid, urlA);
  await stream.send(name, 'turn-2', () => {});
  assert.strictEqual(stream.status(name).pid, pidA, 'no recycle when routing env unchanged');
  assert.strictEqual(readSpawns().length, 1, 'still exactly one spawn after same-provider resend');

  // Turn 3 — switch to provider B. Must recycle at the turn boundary and
  // respawn with --resume <same id> (context preserved), pid changes.
  ensureWith(name, sid, urlB);
  await stream.send(name, 'turn-3', () => {});
  const pidB = stream.status(name).pid;
  assert.notStrictEqual(pidB, pidA, 'provider switch recycled the process (new pid)');

  const spawns = readSpawns();
  assert.strictEqual(spawns.length, 2, 'exactly two spawns total (initial + one recycle)');
  assert.deepStrictEqual(spawns[0].argv, ['--session-id', sid], 'first spawn is fresh --session-id');
  assert.strictEqual(spawns[0].base, urlA, 'first spawn routed to provider A');
  assert.deepStrictEqual(spawns[1].argv, ['--resume', sid], 'recycle respawn uses --resume (context preserved)');
  assert.strictEqual(spawns[1].base, urlB, 'respawn routed to provider B');

  // Turn 4 — stay on B. No further recycle.
  ensureWith(name, sid, urlB);
  await stream.send(name, 'turn-4', () => {});
  assert.strictEqual(stream.status(name).pid, pidB, 'no recycle once settled on provider B');
  assert.strictEqual(readSpawns().length, 2, 'no extra spawn after settling on B');

  stream.close(name);
  console.log('chat-stream provider-recycle tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  stream.close('recycle-stream');
  fs.rmSync(tmp, { recursive: true, force: true });
});
