'use strict';

// Terminal turn ledger (status plan v4, step 2 — shadow mode): contract,
// ledger state machine, second-evidence readers, hook shim, runtime wiring and
// the adapter flags that carry the injected hooks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { normalizeEnvelope, transitionId } = require('../src/turn-ledger/contract');
const { createTurnLedger } = require('../src/turn-ledger/ledger');
const { claudeVerdict, codexVerdict, createTurnEndEvidence } = require('../src/turn-ledger/evidence');
const { createHookInstaller, WRAPPER_SOURCE } = require('../src/turn-ledger/hook-install');
const { createTurnLedgerRuntime } = require('../src/turn-ledger/runtime');
const hookScript = require('../scripts/multicc-turn-hook');

const HOOK_SCRIPT = path.join(__dirname, '..', 'scripts', 'multicc-turn-hook.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Deterministic ledger: scheduled confirms run only when flush() is awaited.
function harness(verdicts = []) {
  const queue = [];
  const transitions = [];
  let n = 0;
  const ledger = createTurnLedger({
    now: () => 1000,
    schedule: fn => queue.push(fn),
    confirmTurnEnd: async () => verdicts.shift() || 'pending',
    onTransition: t => transitions.push(t),
  });
  const ev = (event, extra = {}) => ledger.apply({
    v: 1, eventId: `e${++n}`, ts: 1000 + n, sessionId: 's1', epoch: 1, cli: 'claude', event, ...extra,
  });
  const flush = async () => {
    while (queue.length) { queue.shift()(); await new Promise(r => setImmediate(r)); }
  };
  return { ledger, ev, flush, transitions, state: () => ledger.snapshot('s1')?.state };
}

test('contract: envelopes are validated and transition ids are stable', () => {
  const ok = { v: 1, eventId: 'a-1', ts: 5, sessionId: 's1', epoch: 1, event: 'Stop' };
  assert.ok(normalizeEnvelope(ok));
  assert.equal(normalizeEnvelope({ ...ok, v: 2 }), null);
  assert.equal(normalizeEnvelope({ ...ok, event: 'Bogus' }), null);
  assert.equal(normalizeEnvelope({ ...ok, ts: 0 }), null);
  assert.equal(transitionId({ sessionId: 's', epoch: 2, turnId: 't', seq: 3, state: 'D' }), 's:2:t:3:D');
});

test('ledger: Stop is only a candidate until evidence confirms it', async () => {
  const h = harness(['pending', 'confirmed']);
  h.ev('SessionStart');
  assert.equal(h.state(), null);  // no turn yet
  h.ev('UserPromptSubmit', { turnId: 'p1', promptHead: '修 bug' });
  assert.equal(h.state(), 'P');
  assert.equal(h.ev('Stop', { turnId: 'p1', transcriptPath: '/x' }), 'stop_candidate');
  assert.equal(h.state(), 'P');
  assert.equal(h.ledger.snapshot('s1').stopPending, true);
  await h.flush();
  assert.equal(h.state(), 'D');
  assert.equal(h.ledger.snapshot('s1').promptHead, '修 bug');
  assert.deepEqual(h.transitions.map(t => t.to), ['P', 'D']);
});

test('ledger: question tools and permission prompts are W, answering resumes P', () => {
  const h = harness();
  h.ev('UserPromptSubmit', { turnId: 'p1' });
  h.ev('PreToolUse', { turnId: 'p1', toolName: 'Bash' });
  assert.equal(h.state(), 'P');
  h.ev('PreToolUse', { turnId: 'p1', toolName: 'AskUserQuestion' });
  assert.equal(h.state(), 'W');
  h.ev('PostToolUse', { turnId: 'p1', toolName: 'AskUserQuestion' });
  assert.equal(h.state(), 'P');
  h.ev('Notification', { notificationType: 'permission_prompt' });
  assert.equal(h.state(), 'W');
});

test('ledger: continued, interrupted and background verdicts', async () => {
  const cont = harness(['continued']);
  cont.ev('UserPromptSubmit', { turnId: 'p1' });
  cont.ev('Stop', { turnId: 'p1' });
  await cont.flush();
  assert.equal(cont.state(), 'P');
  assert.equal(cont.ledger.snapshot('s1').stopPending, false);

  const intr = harness(['interrupted']);
  intr.ev('UserPromptSubmit', { turnId: 'p1' });
  intr.ev('Stop', { turnId: 'p1' });
  await intr.flush();
  assert.equal(intr.state(), 'E');
  const last = intr.transitions.at(-1);
  assert.equal(last.reason, 'interrupted');
  assert.equal(last.silent, true);

  const bg = harness(['confirmed']);
  bg.ev('UserPromptSubmit', { turnId: 'p1' });
  bg.ev('Stop', { turnId: 'p1', backgroundTasks: 2 });
  await bg.flush();
  assert.equal(bg.state(), 'B');
});

test('ledger: unconfirmed Stop stays P after retries are exhausted', async () => {
  const h = harness([]);
  h.ev('UserPromptSubmit', { turnId: 'p1' });
  h.ev('Stop', { turnId: 'p1' });
  await h.flush();
  assert.equal(h.state(), 'P');
});

test('ledger: StopFailure, Interrupt and SessionEnd without Stop are E', () => {
  const a = harness();
  a.ev('UserPromptSubmit', { turnId: 'p1' });
  a.ev('StopFailure', { turnId: 'p1' });
  assert.equal(a.state(), 'E');
  assert.equal(a.ledger.snapshot('s1').reason, 'api-error');

  const b = harness();
  b.ev('UserPromptSubmit', { turnId: 'p1' });
  b.ev('Interrupt', { turnId: 'p1' });
  assert.equal(b.ledger.snapshot('s1').reason, 'interrupted');

  const c = harness();
  c.ev('UserPromptSubmit', { turnId: 'p1' });
  c.ev('SessionEnd', { reason: 'other' });
  assert.equal(c.state(), 'E');
  assert.equal(c.ledger.snapshot('s1').reason, 'unknown-interruption');
});

test('ledger: SessionEnd right after Stop lets evidence decide', async () => {
  const h = harness(['confirmed']);
  h.ev('UserPromptSubmit', { turnId: 'p1' });
  h.ev('Stop', { turnId: 'p1' });
  h.ev('SessionEnd', { reason: 'prompt_input_exit' });
  await h.flush();
  assert.equal(h.state(), 'D');
  assert.equal(h.ledger.snapshot('s1').ownership, 'ended');
});

test('ledger: duplicates, stale epochs and stale turns never mutate the turn', () => {
  const h = harness();
  const env = { v: 1, eventId: 'dup', ts: 1, sessionId: 's1', epoch: 2, cli: 'codex', event: 'UserPromptSubmit', turnId: 't2', promptHead: 'hi' };
  assert.equal(h.ledger.apply(env), 'applied');
  assert.equal(h.ledger.apply(env), 'duplicate');
  assert.equal(h.ledger.apply({ ...env, eventId: 'old', epoch: 1, event: 'StopFailure' }), 'stale_epoch');
  assert.equal(h.ledger.apply({ ...env, eventId: 'x', event: 'StopFailure', turnId: 't1' }), 'stale_turn');
  assert.equal(h.state(), 'P');
  // A newer epoch (CLI relaunch) resets the turn but keeps the title.
  h.ledger.apply({ ...env, eventId: 'new', epoch: 3, event: 'SessionStart', turnId: null });
  assert.equal(h.state(), null);
  assert.equal(h.ledger.snapshot('s1').promptHead, 'hi');
});

test('evidence: Claude stop_hook_summary / interrupt and Codex task_complete', async t => {
  const J = o => JSON.stringify(o);
  const prompt = J({ type: 'user', message: { role: 'user', content: 'do it' } });
  const summary = p => J({ type: 'system', subtype: 'stop_hook_summary', preventedContinuation: p });
  assert.equal(claudeVerdict([prompt, summary(false)]), 'confirmed');
  assert.equal(claudeVerdict([prompt, summary(true)]), 'continued');
  assert.equal(claudeVerdict([summary(false), prompt]), 'pending');  // summary belongs to the previous turn
  const meta = J({ type: 'user', isMeta: true, message: { content: 'caveat' } });
  assert.equal(claudeVerdict([prompt, summary(false), meta]), 'confirmed');
  const intr = J({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  assert.equal(claudeVerdict([prompt, intr]), 'interrupted');

  const ev = (type, turn) => J({ type: 'event_msg', payload: { type, turn_id: turn } });
  assert.equal(codexVerdict([ev('task_started', 't1'), ev('task_complete', 't1')], 't1'), 'confirmed');
  assert.equal(codexVerdict([ev('task_complete', 't0'), ev('task_started', 't1')], 't1'), 'pending');
  assert.equal(codexVerdict([ev('turn_aborted', 't1')], 't1'), 'interrupted');

  const dir = tmpDir(t);
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, `${ev('task_complete', 't9')}\n`);
  const confirm = createTurnEndEvidence({ fs });
  assert.equal(await confirm({ cli: 'codex', turnId: 't9', transcriptPath: file }), 'confirmed');
  assert.equal(await confirm({ cli: 'codex', turnId: 't9', transcriptPath: path.join(dir, 'nope') }), 'pending');
});

test('hook shim: projects, redacts and spools atomically', t => {
  const rec = hookScript.project({
    hook_event_name: 'UserPromptSubmit', session_id: 'c1', prompt_id: 'p1',
    prompt: '<system-reminder>x</system-reminder>\n请用 sk-abcdef1234567890 部署\n第二行',
  }, { MULTICC_TURN_HOOK_SESSION: 's1', MULTICC_TURN_HOOK_EPOCH: '4', MULTICC_TURN_HOOK_CLI: 'claude' });
  assert.equal(rec.turnId, 'p1');
  assert.equal(rec.epoch, 4);
  assert.equal(rec.promptHead, '请用 [redacted] 部署');
  assert.equal(rec.prompt, undefined);
  assert.equal(hookScript.redact('api_key=abc123'), 'api_key=[redacted]');

  const spool = tmpDir(t);
  const env = { ...process.env, MULTICC_TURN_HOOK_SPOOL: spool, MULTICC_TURN_HOOK_SESSION: 's1', MULTICC_TURN_HOOK_EPOCH: '1', MULTICC_TURN_HOOK_CLI: 'codex' };
  const r = spawnSync(process.execPath, [HOOK_SCRIPT], {
    env, input: JSON.stringify({ hook_event_name: 'Stop', turn_id: 't1', session_id: 'x' }),
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, 0);
  const files = fs.readdirSync(path.join(spool, 's1'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{15}-[0-9a-f-]{36}\.json$/);
  assert.equal(fs.statSync(path.join(spool, 's1', files[0])).mode & 0o777, 0o600);
  const written = JSON.parse(fs.readFileSync(path.join(spool, 's1', files[0]), 'utf8'));
  assert.ok(normalizeEnvelope(written));

  // Garbage input or a missing spool env is a silent no-op, never a CLI error.
  assert.equal(spawnSync(process.execPath, [HOOK_SCRIPT], { env, input: 'not json' }).status, 0);
  assert.equal(spawnSync(process.execPath, [HOOK_SCRIPT], { env: { PATH: process.env.PATH }, input: '{}' }).status, 0);
});

test('hook installer: fixed wrapper path and per-CLI injection shapes', t => {
  const binDir = tmpDir(t);
  const inst = createHookInstaller({ binDir });
  assert.equal(inst.install(), path.join(binDir, 'multicc-turn-hook'));
  assert.equal(fs.readFileSync(inst.wrapperPath, 'utf8'), WRAPPER_SOURCE);
  assert.ok(fs.statSync(inst.wrapperPath).mode & 0o100);
  assert.ok(fs.existsSync(path.join(binDir, 'multicc-turn-hook.js')));
  inst.install();  // idempotent

  const settings = inst.claudeSettings({ ultracode: true });
  assert.equal(settings.ultracode, true);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, inst.wrapperPath);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'AskUserQuestion|ExitPlanMode');

  const args = inst.codexConfigArgs();
  assert.ok(args.some(a => a.startsWith('hooks.Stop=[{hooks=[{type="command"')));
  assert.ok(args.every(a => !a.includes("'")));  // safe inside the adapter's single quotes

  // Wrapper is inert without the spool env (hooks outside multicc do nothing).
  const r = spawnSync('/bin/sh', [inst.wrapperPath], { env: { PATH: process.env.PATH }, input: '{}' });
  assert.equal(r.status, 0);
});

test('runtime: prepareTerminal injects env/settings and sweep ingests the spool', async t => {
  const dataDir = tmpDir(t);
  const binDir = tmpDir(t);
  const logs = [];
  const rt = createTurnLedgerRuntime({
    dataDir,
    installer: createHookInstaller({ binDir }),
    logger: { log: m => logs.push(m), warn: m => logs.push(m) },
    ledgerOptions: { schedule: () => {} },
  });

  const termEnv = {};
  const out = rt.prepareTerminal({ id: 's1', cli: 'claude', effort: ' UltraCode ' }, termEnv);
  assert.equal(termEnv.MULTICC_TURN_HOOK_SESSION, 's1');
  assert.equal(termEnv.MULTICC_TURN_HOOK_EPOCH, '1');
  assert.equal(termEnv.MULTICC_TURN_HOOK_NODE, process.execPath);
  const settingsFile = path.join(dataDir, 'turn-hooks', 'settings', 's1.json');
  assert.equal(out.turnHookSettingsArg, `'${settingsFile}'`);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).ultracode, true);

  const env2 = {};
  const codex = rt.prepareTerminal({ id: 's2', cli: 'codex' }, env2);
  assert.ok(codex.turnHookConfigArgs.length > 0);
  rt.prepareTerminal({ id: 's1', cli: 'claude' }, {});
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'turn-hooks', 'sessions.json'), 'utf8')).s1.epoch, 2);

  // Unhooked CLIs and bad ids pass through untouched.
  const plain = { id: 's3', cli: 'gemini' };
  assert.equal(rt.prepareTerminal(plain, {}), plain);
  assert.equal(rt.prepareTerminal({ id: '../x', cli: 'claude' }, {}).turnHookSettingsArg, undefined);

  const spool = path.join(dataDir, 'turn-hooks', 'spool', 's1');
  hookScript.writeSpool(spool, { v: 1, eventId: 'e1', ts: 1, sessionId: 's1', epoch: 2, cli: 'claude', event: 'UserPromptSubmit', turnId: 'p1' });
  hookScript.writeSpool(spool, { v: 1, eventId: 'e2', ts: 2, sessionId: 's1', epoch: 2, cli: 'claude', event: 'Notification', notificationType: 'permission_prompt' });
  fs.writeFileSync(path.join(spool, '000000000000003-bad.json'), '{oops');
  rt.sweep();
  assert.deepEqual(fs.readdirSync(spool), []);
  assert.equal(rt.snapshot('s1').state, 'W');
  assert.ok(logs.some(m => /shadow\] s1 -→P/.test(m)));
  assert.ok(logs.some(m => /malformed/.test(m)));
});

test('adapters: terminal commands carry the injected hook flags', () => {
  const { createClaudeAdapter } = require('../src/cli-adapters/claude');
  const { createCodexAdapter } = require('../src/cli-adapters/codex');
  const claude = createClaudeAdapter({
    cmd: 'claude', resolveSessionWireModel: m => m, claudeDefaultModel: () => null,
    cliEffortLevel: () => null, normalizeEffort: e => (e ? String(e).trim().toLowerCase() : null),
    debugLogClaudeInvoke: () => {},
  });
  const codex = createCodexAdapter({
    cmd: 'codex', codexReasoningConfigArg: () => null, codexModelConfigArg: () => null, multiccImgHint: 'hint',
  });

  const withHook = claude.buildTerminalCmd({ id: 's1', effort: 'ultracode', turnHookSettingsArg: "'/d/s1.json'" });
  assert.match(withHook, / --settings '\/d\/s1\.json'/);
  assert.doesNotMatch(withHook, /"ultracode":true/);  // carried inside the settings file instead
  assert.match(claude.buildTerminalCmd({ id: 's1', effort: 'ultracode' }), /--settings '\{"ultracode":true\}'/);

  const cmd = codex.buildTerminalCmd({ id: 's2', turnHookConfigArgs: ['hooks.Stop=[{hooks=[]}]'] });
  assert.match(cmd, / -c 'hooks\.Stop=\[\{hooks=\[\]\}\]'/);
});
