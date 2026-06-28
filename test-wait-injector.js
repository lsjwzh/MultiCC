'use strict';
// Deterministic unit test for src/wait-injector.js — fake inject/exec, no claude.
const wait = require('./src/wait-injector');

const injected = [];               // [{session, text}]
let pollOutput = 'status: pending';  // exec returns this
let busy = false;

wait.init({
  inject: async (session, text) => { injected.push({ session, text }); },
  exec: async () => ({ stdout: pollOutput, code: 0 }),
  isBusy: () => busy,
  log: () => {},
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅', msg); } else { fail++; console.log('  ❌', msg); } };

(async () => {
  // ── B: poll ──
  console.log('B. poll mode');
  const r = wait.register({ session: 's1', mode: 'poll', pollCmd: 'echo x', untilContains: 'DONE', intervalSec: 3, maxChecks: 5, injectPrefix: '[结果]' });
  ok(r.mode === 'poll' && r.id, 'registered poll wait');
  await wait.tick(Date.now() + 4000);  // due → probe → "pending", no match
  ok(injected.length === 0, 'no inject while condition unmet');
  pollOutput = 'status: DONE result=42';
  await wait.tick(Date.now() + 8000);  // due again → match
  ok(injected.length === 1 && injected[0].text.includes('DONE result=42'), 'injected poll output on match');
  ok(injected[0].text.startsWith('[结果]'), 'used injectPrefix');
  ok(!wait.hasWait('s1'), 'poll wait removed after match');

  // ── B: poll gives up after maxChecks ──
  console.log('B. poll maxChecks');
  injected.length = 0; pollOutput = 'nope';
  const r2 = wait.register({ session: 's2', mode: 'poll', pollCmd: 'echo x', untilContains: 'NEVER', intervalSec: 3, maxChecks: 2 });
  for (let i = 1; i <= 3; i++) await wait.tick(Date.now() + i * 4000);
  ok(injected.length === 1 && injected[0].text.includes('轮询超时'), 'injected timeout note after maxChecks');
  ok(!wait.hasWait('s2'), 'wait cleared after giving up');

  // ── A: callback ──
  console.log('A. callback mode');
  injected.length = 0;
  const r3 = wait.register({ session: 's3', mode: 'callback', injectPrefix: '[回调]' });
  ok(wait.resolve(r3.id, 'wrong', 'x').ok === false, 'rejects bad token');
  const res = wait.resolve(r3.id, r3.token, 'the answer is 7');
  ok(res.ok, 'resolve accepts correct token');
  await sleep(10);
  ok(injected.length === 1 && injected[0].text === '[回调]\nthe answer is 7', 'injected callback data');

  // ── D: auto-continue guardrails ──
  console.log('D. auto-continue');
  injected.length = 0;
  let started = 0;
  for (let i = 0; i < 8; i++) if (wait.autoContinue('s4', { delayMs: 0 })) started++;
  await sleep(20);
  ok(started === 5, `capped at 5 consecutive (got ${started})`);
  ok(injected.length === 5, 'exactly 5 nudges injected');
  wait.resetAuto('s4');
  ok(wait.autoContinue('s4', { delayMs: 0 }), 'resetAuto re-enables auto-continue');
  await sleep(20); // flush the s4 nudge so it can't pollute later sections

  // ── D: skipped if explicit wait pending ──
  injected.length = 0;
  wait.register({ session: 's5', mode: 'callback' });
  ok(wait.autoContinue('s5') === false, 'auto-continue skipped when explicit wait pending');

  // ── E: run_in_background nudge ──
  console.log('E. bgCheck (run_in_background guard)');
  injected.length = 0;
  let bgStarted = 0;
  for (let i = 0; i < 9; i++) if (wait.bgCheck('sbg', { delayMs: 0 })) bgStarted++;
  await sleep(20);
  ok(bgStarted === 6, `capped at 6 consecutive (got ${bgStarted})`);
  ok(injected.length === 6, 'exactly 6 bg nudges injected');
  ok(injected[0].text.includes('run_in_background') && injected[0].text.includes('run-detached'),
     'nudge names the anti-pattern and the fix');
  wait.resetBg('sbg');
  ok(wait.bgCheck('sbg', { delayMs: 0 }), 'resetBg re-enables bgCheck');
  await sleep(20); // flush so it can't pollute later sections

  // ── E: skipped if explicit wait pending ──
  injected.length = 0;
  wait.register({ session: 'sbg2', mode: 'callback' });
  ok(wait.bgCheck('sbg2') === false, 'bgCheck skipped when explicit wait pending');

  // ── F: API-error retry nudge ──
  console.log('F. apiRetry (API/transport error guard)');
  injected.length = 0;
  let apiStarted = 0;
  for (let i = 0; i < 6; i++) if (wait.apiRetry('sapi', { delayMs: 0 })) apiStarted++;
  await sleep(20);
  ok(apiStarted === 3, `capped at 3 consecutive (got ${apiStarted})`);
  ok(injected.length === 3, 'exactly 3 api retry nudges injected');
  ok(injected[0].text.includes('继续'), 'nudge asks the model to continue');
  wait.resetApi('sapi');
  ok(wait.apiRetry('sapi', { delayMs: 0 }), 'resetApi re-enables apiRetry');
  await sleep(20); // flush so it can't pollute later sections

  // ── F: skipped if explicit wait pending ──
  injected.length = 0;
  wait.register({ session: 'sapi2', mode: 'callback' });
  ok(wait.apiRetry('sapi2') === false, 'apiRetry skipped when explicit wait pending');

  // ── inject defers while busy ──
  console.log('busy deferral');
  injected.length = 0; busy = true;
  const r6 = wait.register({ session: 's6', mode: 'callback' });
  wait.resolve(r6.id, r6.token, 'data');
  await sleep(50);
  ok(injected.length === 0, 'inject deferred while session busy');
  busy = false;
  await sleep(1200);
  ok(injected.length === 1, 'inject fires once session is free');

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'}  (${pass} pass, ${fail} fail)`);
  process.exit(fail === 0 ? 0 : 1);
})();
