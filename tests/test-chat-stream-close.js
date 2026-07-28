'use strict';

// L0 regression: close() is the teardown behind session delete, history clear
// and the chat "restart process" recovery action. Deleting the map entry
// disarms every proc handler (each is guarded by `sessions.get(name)?.proc ===
// proc`), so close() itself has to finish the job. Two failures this pins:
//
//   • an in-flight turn whose promise never settles — finishTurn/onExit are the
//     only other places that resolve it, so the caller (finalizeStreamingTurn)
//     never runs and the session stays "streaming" forever;
//   • a CLI that ignores SIGTERM and keeps running after teardown, holding the
//     provider connection while a respawn starts a second one alongside it.
//
// Uses the same deterministic fake-CLI substrate as test-chat-stream-idle-guard.

const assert = require('assert');
const stream = require('../src/chat-stream');

// Fake CLI that acknowledges each user line with a `result` event.
const echoCli = [
  "let buf=''",
  "process.stdin.on('data', c => {",
  "  buf += c.toString()",
  "  while (buf.includes('\\n')) {",
  "    const i=buf.indexOf('\\n'); buf=buf.slice(i+1)",
  "    process.stdout.write(JSON.stringify({type:'result', result:'ok'})+'\\n')",
  "  }",
  "})",
  "process.stdin.on('end', () => process.exit(0))",
].join(';');

// Fake CLI that NEVER answers and refuses to die on SIGTERM — the worst case
// close() has to handle: a turn stuck in flight behind an unkillable-by-TERM
// process. setInterval keeps the event loop alive so it cannot exit on its own.
const deafCli = [
  "process.on('SIGTERM', () => {})",
  "process.stdin.resume()",
  'setInterval(() => {}, 1000)',
].join(';');

function ensure(name, cli, opts) {
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: process.cwd(),
    sessionId: `${name}-id`,
    baseArgs: ['-e', cli, '--'],
    env: { ...process.env },
    idleMs: 60_000,
    ...opts,
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const running = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

(async () => {
  // ── Case 1: close() during an in-flight turn settles that turn ──
  // Without this the promise below never resolves and the test times out — which
  // is exactly the production symptom, a session stuck mid-turn forever.
  ensure('close-inflight', deafCli);
  let settled = null;
  const inflight = stream.send('close-inflight', 'hello?', () => {})
    .then(() => { settled = 'resolved'; })
    .catch(() => { settled = 'rejected'; });
  await sleep(150);
  assert.strictEqual(stream.status('close-inflight').busy, true, 'turn is in flight');
  const deafPid = stream.status('close-inflight').pid;
  assert.ok(deafPid, 'in-flight turn has a live pid');

  stream.close('close-inflight');
  await Promise.race([inflight, sleep(2000)]);
  assert.strictEqual(settled, 'rejected',
    'close() must settle the in-flight turn (it rejects; nothing else ever will)');
  assert.strictEqual(stream.status('close-inflight'), null, 'session entry is gone after close');

  // ── Case 2: a SIGTERM-deaf process is escalated to SIGKILL ──
  // close() asked politely and then let go of the handle, so the escalation has
  // to be armed inside close() or the process leaks.
  assert.strictEqual(running(deafPid), true, 'still alive immediately after SIGTERM (it ignores TERM)');
  await sleep(2200); // past CLOSE_KILL_GRACE_MS (1.5s) plus scheduling slack
  assert.strictEqual(running(deafPid), false,
    'close() must escalate to SIGKILL — a TERM-deaf CLI would otherwise outlive teardown');

  // ── Case 3: close() is the "restart spawn" primitive — a later send respawns ──
  // This is what makes the recovery action work: tear the entry down, and the
  // next turn re-ensures and spawns a brand-new process.
  ensure('close-respawn', echoCli);
  await stream.send('close-respawn', 'first', () => {});
  const firstPid = stream.status('close-respawn').pid;
  assert.ok(firstPid, 'first turn spawned a process');

  stream.close('close-respawn');
  assert.strictEqual(stream.status('close-respawn'), null, 'entry dropped');
  await sleep(200);
  assert.strictEqual(running(firstPid), false, 'the old process is gone');

  ensure('close-respawn', echoCli);
  await stream.send('close-respawn', 'second', () => {});
  const secondPid = stream.status('close-respawn').pid;
  assert.ok(secondPid, 'respawned after close');
  assert.notStrictEqual(secondPid, firstPid, 'the respawn is a genuinely new process');
  stream.close('close-respawn');

  // ── Case 4: onDispose fires exactly once, and close() of an unknown name is a no-op ──
  let disposed = 0;
  ensure('close-dispose', echoCli, { onDispose: () => { disposed += 1; } });
  await stream.send('close-dispose', 'hi', () => {});
  stream.close('close-dispose');
  assert.strictEqual(disposed, 1, 'onDispose released the sidecar once');
  stream.close('close-dispose');
  assert.strictEqual(disposed, 1, 'closing an already-closed session does not re-dispose');
  assert.doesNotThrow(() => stream.close('never-existed'), 'closing an unknown session is a no-op');

  console.log('chat-stream close(): in-flight settle + SIGKILL escalation + respawn OK');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
