'use strict';
// Deterministic unit test for src/wait-injector.js — fake inject/exec, no claude.
const wait = require('../src/wait-injector');

const injected = [];               // [{session, text}]
let pollOutput = 'status: pending';  // exec returns this
let busy = false;
let durablePending = false;

wait.init({
  inject: async (session, text) => { injected.push({ session, text }); },
  exec: async () => ({ stdout: pollOutput, code: 0 }),
  isBusy: () => busy,
  hasExplicitWait: session => durablePending && session === 'durable-session',
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

  // ── D: auto-continue (UNCAPPED - only 'D' is terminal) ──
  console.log('D. auto-continue');
  injected.length = 0;
  let started = 0;
  for (let i = 0; i < 8; i++) if (wait.autoContinue('s4', { delayMs: 0 })) started++;
  await sleep(20);
  ok(started === 8, `uncapped - all 8 accepted (got ${started})`);
  ok(injected.length === 8, 'all 8 nudges injected (no give-up cap)');
  wait.resetAuto('s4');
  ok(wait.autoContinue('s4', { delayMs: 0 }), 'resetAuto re-enables auto-continue');
  await sleep(20); // flush the s4 nudge so it can't pollute later sections

  // ── D: skipped if explicit wait pending ──
  injected.length = 0;
  wait.register({ session: 's5', mode: 'callback' });
  ok(wait.autoContinue('s5') === false, 'auto-continue skipped when explicit wait pending');
  durablePending = true;
  ok(wait.hasWait('durable-session'), 'durable explicit wait is visible to compatibility guards');
  ok(wait.autoContinue('durable-session') === false, 'auto-continue skips durable explicit wait without owning it');
  durablePending = false;
  ok(!wait.hasWait('durable-session'), 'durable guard clears without an in-memory shadow wait');

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

  // ── G: resumeInterrupted (P+no-turn resume, now capped) ──
  console.log('G. resumeInterrupted (unknown-interruption resume)');
  injected.length = 0;
  let riStarted = 0;
  for (let i = 0; i < 12; i++) if (wait.resumeInterrupted('sri', { delayMs: 0 })) riStarted++;
  await sleep(20);
  ok(riStarted === 10, `capped at 10 consecutive (got ${riStarted})`);
  ok(injected.length === 10, 'exactly 10 resume nudges injected');
  ok(injected[0].text.includes('未知中断'), 'nudge names the recovery intent');
  wait.resetInterrupted('sri');
  ok(wait.resumeInterrupted('sri', { delayMs: 0 }), 'resetInterrupted re-enables resume');
  await sleep(20); // flush

  // ── G: skipped if explicit wait pending ──
  injected.length = 0;
  wait.register({ session: 'sri2', mode: 'callback' });
  ok(wait.resumeInterrupted('sri2') === false, 'resumeInterrupted skipped when explicit wait pending');

  // ── v2: bg-completion result de-dup (autoContinue + bgCheck skip) ──
  console.log('v2. bg-completion de-dup');
  injected.length = 0;
  // Before the de-dup window opens, both autoContinue and bgCheck inject.
  ok(wait.autoContinue('sv2', { delayMs: 0 }), 'auto-continue injects before bg-result window');
  ok(wait.bgCheck('sv2', { delayMs: 0 }), 'bgCheck injects before bg-result window');
  await sleep(20); // flush
  // Open the de-dup window: both must skip (no empty nudge on top of the result).
  injected.length = 0;
  wait.noteBgResultInjected('sv2');
  ok(wait.autoContinue('sv2', { delayMs: 0 }) === false, 'auto-continue skipped while bg-result window open');
  ok(wait.bgCheck('sv2', { delayMs: 0 }) === false, 'bgCheck skipped while bg-result window open');
  ok(injected.length === 0, 'no empty nudge injected during de-dup window');
  // resetBgResult (real user message) re-opens auto-continue.
  wait.resetBgResult('sv2');
  ok(wait.autoContinue('sv2', { delayMs: 0 }), 'auto-continue re-enabled after resetBgResult');
  await sleep(20); // flush so it can't pollute later sections

  // ── durable admission is immediate; the shared scheduler owns busy deferral ──
  console.log('busy durable admission');
  injected.length = 0; busy = true;
  const r6 = wait.register({ session: 's6', mode: 'callback' });
  wait.resolve(r6.id, r6.token, 'data');
  await sleep(50);
  ok(injected.length === 1, 'busy callback is admitted once without a volatile retry timer');
  busy = false;
  await sleep(100);
  ok(injected.length === 1, 'becoming idle does not duplicate the durable admission');

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'}  (${pass} pass, ${fail} fail)`);
  process.exit(fail === 0 ? 0 : 1);
})();
