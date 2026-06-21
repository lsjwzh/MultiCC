'use strict';

// Tests for src/detached.js — the detached long-task launcher — plus its
// integration with the wait-injector poll→inject machinery.
//
//   node test-detached.js
//
// Covers: (1) a job's output + real exit code land in the done-file; a stray
// `exit N` inside the command does NOT skip completion (subshell containment).
// (2) the job survives the launching process exiting. (3) end-to-end: launching
// a job + registering the poll wait causes the exit code + output tail to be
// injected back into the session.

const assert = require('assert');
const cp = require('child_process');
const detached = require('./src/detached');
const waitInjector = require('./src/wait-injector');

function sh(cmd) { return cp.execSync(cmd, { shell: '/bin/sh' }).toString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDone(job, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const out = sh(job.pollCmd);
    if (out.includes(job.doneMarker)) return out;
    await sleep(200);
  }
  throw new Error('timed out waiting for done-file');
}

async function testExitCodeAndOutput() {
  // `exit 7` must be contained in a subshell so the wrapper still writes done.
  const job = detached.launch({ command: 'echo OUT; echo ERR 1>&2; exit 7', label: 't1' });
  assert.strictEqual(sh(job.pollCmd), '', 'pollCmd should be empty before done');
  const out = await waitForDone(job);
  assert.ok(out.includes('exit=7'), 'exit code 7 captured');
  assert.ok(out.includes('OUT'), 'stdout captured');
  assert.ok(out.includes('ERR'), 'stderr captured');
  const st = detached.status(job.id);
  assert.strictEqual(st.exitCode, 7);
  assert.strictEqual(st.done, true);
  assert.strictEqual(st.running, false);
  assert.ok(detached.list().some(t => t.id === job.id), 'list() includes the job');
  console.log('  ✓ exit code + stdout/stderr captured; `exit` does not skip completion');
}

async function testSurvivesLauncherDeath() {
  // Spawn a child node that launches a 2s job then exits IMMEDIATELY. The job
  // must keep running and write its done-file after the launcher is gone.
  const script =
    `const d=require(${JSON.stringify(require('path').resolve(__dirname, 'src/detached'))});` +
    `const j=d.launch({command:'sleep 2; echo SURVIVED; exit 0',label:'t2'});` +
    `process.stdout.write(j.id);process.exit(0);`;
  const id = cp.execSync(`node -e ${JSON.stringify(script)}`).toString().trim();
  assert.ok(id.startsWith('d_'), 'got a job id from the dead launcher');
  // Launcher is now gone. Poll the done-file.
  const start = Date.now();
  let st = detached.status(id);
  while (!st.done && Date.now() - start < 8000) { await sleep(200); st = detached.status(id); }
  assert.strictEqual(st.done, true, 'job completed after launcher death');
  assert.strictEqual(st.exitCode, 0);
  assert.ok(st.logTail.includes('SURVIVED'), 'job actually ran to completion');
  console.log('  ✓ job survives the launching process exiting');
}

async function testWaitInjectorIntegration() {
  let injected = null;
  waitInjector.init({
    inject: (session, text) => { injected = { session, text }; return Promise.resolve(); },
    isBusy: () => false,
    exec: (cmd, cwd) => new Promise(r => cp.exec(cmd, { cwd, timeout: 20000, maxBuffer: 1 << 20, env: process.env },
      (e, so, se) => r({ stdout: so || '', stderr: se || '', code: e ? (e.code || 1) : 0 }))),
    log: () => {},
  });
  // Mirror what POST /api/sessions/:id/run-detached does.
  const job = detached.launch({ command: 'echo build-ok; exit 0', label: 't3' });
  waitInjector.register({
    session: 'sess-test', mode: 'poll', cwd: process.cwd(),
    pollCmd: job.pollCmd, untilContains: job.doneMarker,
    intervalSec: 3, maxChecks: 10, injectPrefix: '[后台任务完成] t3',
  });
  const start = Date.now();
  while (!injected && Date.now() - start < 15000) await sleep(250);
  assert.ok(injected, 'something was injected');
  assert.strictEqual(injected.session, 'sess-test');
  assert.ok(injected.text.includes('[后台任务完成]'), 'inject prefix present');
  assert.ok(injected.text.includes('exit=0'), 'exit code reported to session');
  assert.ok(injected.text.includes('build-ok'), 'output tail reported to session');
  console.log('  ✓ completion (exit code + output) injected back into the session');
}

(async () => {
  console.log('test-detached:');
  await testExitCodeAndOutput();
  await testSurvivesLauncherDeath();
  await testWaitInjectorIntegration();
  console.log('ALL PASS ✅');
  process.exit(0);
})().catch(e => { console.error('FAIL ❌', e); process.exit(1); });
