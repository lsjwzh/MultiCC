'use strict';

// L0 regression: the idle-reclaim timer must NOT kill a warm streaming process
// while it still owns live background work. Killing it would murder the running
// background task and orphan its shadow monitor (the "后台任务一直转圈" bug).
//
// Uses the same deterministic fake-CLI substrate as test-chat-stream-resume:
// a tiny inline node script that echoes a `result` event per stdin line and
// then stays alive reading stdin (so the process only exits when we idle-kill
// it via stdin.end()).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stream = require('../src/chat-stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-idle-guard-'));

// Fake CLI: acknowledge each user line with a `result` event, then keep reading
// stdin. On stdin end (idle-kill), the process exits.
const fakeCli = [
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

function ensure(name, opts) {
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: process.cwd(),
    sessionId: `${name}-id`,
    baseArgs: ['-e', fakeCli, '--'],
    env: { ...process.env },
    idleMs: 30,            // tiny idle window so the timer fires fast in-test
    idleMaxHoldMs: 150,    // small hard ceiling for the leak-backstop case
    ...opts,
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── Case 1: no background work → idle-kill reclaims the process ──
  ensure('idle-plain', { isBackgroundActive: () => false });
  await stream.send('idle-plain', 'hi', () => {});
  assert.strictEqual(stream.isAlive('idle-plain'), true, 'alive right after turn');
  await sleep(120);
  assert.strictEqual(stream.isAlive('idle-plain'), false,
    'a process with no background work is idle-killed');
  stream.close('idle-plain');

  // ── Case 2: live background work → process is HELD across idle windows ──
  let bgActive = true;
  ensure('idle-bg', { isBackgroundActive: () => bgActive });
  await stream.send('idle-bg', 'start a long background task', () => {});
  await sleep(160); // several idle windows elapse (idleMs=30) but under maxHold
  assert.strictEqual(stream.isAlive('idle-bg'), true,
    'a process with live background work must survive idle windows');

  // Once the background work reports done, the next idle window reclaims it.
  bgActive = false;
  await sleep(120);
  assert.strictEqual(stream.isAlive('idle-bg'), false,
    'after background work ends, the process is reclaimed normally');
  stream.close('idle-bg');

  // ── Case 3: hard ceiling → a permanently "active" (leaked) task can't pin
  //    the process forever; it is reclaimed after idleMaxHoldMs. ──
  ensure('idle-leak', { isBackgroundActive: () => true }); // never turns false
  await stream.send('idle-leak', 'leak', () => {});
  await sleep(120);
  assert.strictEqual(stream.isAlive('idle-leak'), true,
    'still held before the hard ceiling');
  await sleep(200); // now past idleMaxHoldMs (150) since the hold began
  assert.strictEqual(stream.isAlive('idle-leak'), false,
    'the hard ceiling reclaims a permanently-silent (leaked) task');
  stream.close('idle-leak');

  console.log('chat-stream idle-guard tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const n of ['idle-plain', 'idle-bg', 'idle-leak']) stream.close(n);
  fs.rmSync(tmp, { recursive: true, force: true });
});
