'use strict';

// L0 regression (H1, docs/chat-page-architecture-review.md 五节): cancel() used
// to send SIGTERM and nothing more. A CLI that ignores SIGTERM stayed alive
// while remaining in the session map, so pump() kept considering it (isAlive)
// and every later turn reused the wedged process. The fix: cancel() arms the
// SIGTERM -> SIGKILL escalation on the captured handle, same as close().
//
// Uses the same deterministic fake-CLI substrate as test-chat-stream-close.

const assert = require('assert');
const stream = require('../src/chat-stream');

// Fake CLI that NEVER answers and refuses to die on SIGTERM. setInterval keeps
// the event loop alive so it cannot exit on its own - only SIGKILL ends it.
const deafCli = [
  "process.on('SIGTERM', () => {})",
  "process.stdin.resume()",
  'setInterval(() => {}, 1000)',
].join(';');

// Fake CLI that answers each user line with a `result` event and exits on
// SIGTERM (default Node behavior - SIGTERM with no listener terminates).
const echoCli = [
  "let buf=''",
  "process.stdin.on('data', c => {",
  "  buf += c.toString()",
  "  while (buf.includes('\\n')) {",
  "    const i=buf.indexOf('\\n'); buf=buf.slice(i+1)",
  "    process.stdout.write(JSON.stringify({type:'result', result:'ok'})+'\\n')",
  "  }",
  "})",
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
  // ── Case 1: a SIGTERM-deaf process is escalated to SIGKILL by cancel() ──
  // Before the fix the pid below was still alive long after the grace window
  // and isAlive() kept returning true, i.e. the wedged process was reusable.
  ensure('cancel-deaf', deafCli);
  let settled = null;
  const inflight = stream.send('cancel-deaf', 'hello?', () => {})
    .then(() => { settled = 'resolved'; })
    .catch(() => { settled = 'rejected'; });
  await sleep(150);
  const deafPid = stream.status('cancel-deaf').pid;
  assert.ok(deafPid, 'in-flight turn has a live pid');

  stream.cancel('cancel-deaf');
  assert.strictEqual(running(deafPid), true,
    'still alive immediately after SIGTERM (it ignores TERM)');
  // CLOSE_KILL_GRACE_MS is 1_500; wait past it and let the escalation fire.
  await sleep(2_200);
  assert.strictEqual(running(deafPid), false,
    'cancel() must escalate to SIGKILL - a TERM-deaf CLI would otherwise stay wedged and be reused by later turns');
  assert.strictEqual(stream.isAlive('cancel-deaf'), false,
    'isAlive must report the killed process as dead so pump() respawns instead of reusing it');
  await inflight;
  assert.strictEqual(settled, 'rejected', 'the cancelled turn rejects via the exit path');

  // A later send must spawn a genuinely new, working process - this is the
  // "no permanent wedge" property the fix buys.
  ensure('cancel-deaf', echoCli);
  await stream.send('cancel-deaf', 'again', () => {});
  const respawnPid = stream.status('cancel-deaf').pid;
  assert.ok(respawnPid, 'respawned after cancel+escalation');
  assert.notStrictEqual(respawnPid, deafPid, 'the respawn is a genuinely new process');
  stream.close('cancel-deaf');

  // ── Case 2: a well-behaved process exits on SIGTERM and is NOT SIGKILLed ──
  // The escalation timer is cleared by the exit event; nothing may break when
  // the graceful path wins.
  ensure('cancel-polite', echoCli);
  await stream.send('cancel-polite', 'hi', () => {});
  const politePid = stream.status('cancel-polite').pid;
  assert.ok(politePid, 'warm process alive before cancel');
  stream.cancel('cancel-polite');
  await sleep(2_200);
  assert.strictEqual(running(politePid), false, 'polite process exited on SIGTERM alone');
  assert.strictEqual(stream.status('cancel-polite').busy, false, 'no turn stuck busy');
  stream.close('cancel-polite');

  // ── Case 3: cancel() of an unknown session is a no-op ──
  assert.doesNotThrow(() => stream.cancel('never-existed'), 'cancelling an unknown session is a no-op');

  console.log('chat-stream cancel(): SIGKILL escalation + clean respawn OK');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
