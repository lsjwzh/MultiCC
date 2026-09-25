'use strict';
// The resident zcode lane: the REAL bridge (`zcode-bridge.cjs --resident`)
// against a fake `zcode.cjs app-server`, driven both raw (the stdin/stdout
// contract) and through the host's app-server stream facade (what the session
// lifecycle actually calls). What is pinned here:
//   • one engine and one native session serve every turn;
//   • background work started in a turn survives it, and the engine's self-wake
//     turn flows into the same (held) host turn;
//   • without a hold, live background work keeps the child from being recycled
//     or reclaimed until it ends.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { createCodexAppStream } = require('../src/chat/codex-app-stream');
const { createZcodeAdapter } = require('../src/cli-adapters/zcode');
const { createBackgroundTaskTracker } = require('../src/cli-adapters/zcode-app-server');
const { writeFakeZcodeAppServer } = require('./helpers/fake-zcode-app-server');

const BRIDGE = path.join(__dirname, '../src/cli-adapters/zcode-bridge.cjs');

function fixture(name, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `multicc-zcode-resident-${name}-`));
  const log = path.join(root, 'requests.jsonl');
  fs.writeFileSync(log, '');
  const engine = writeFakeZcodeAppServer(root);
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'zai/glm-5.2', provider: { zai: { models: { 'glm-5.2': {} } } } }));
  return {
    root, log, engine, settings,
    env: {
      ...process.env,
      ZCODE_ENGINE: engine, ZCODE_SETTINGS: settings, FAKE_ZCODE_LOG: log,
      MULTICC_ZCODE_HOLD_QUIET_MS: '150', MULTICC_ZCODE_LEGACY: '', ...env,
    },
    requests: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// Raw driver: one bridge child, turns written as stdin lines.
function startBridge(t, fx, args = []) {
  const child = spawn(process.execPath, [BRIDGE, '--resident', ...args], {
    cwd: fx.root, env: fx.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A failed assertion must not leave the bridge (and its engine) running.
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); });
  const events = [];
  const waiters = [];
  let buf = '';
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
      for (const w of waiters.splice(0)) w();
    }
  });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const until = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; events=${JSON.stringify(events)} stderr=${stderr}`)), ms);
    const check = () => {
      if (pred(events)) { clearTimeout(timer); resolve(events); } else waiters.push(check);
    };
    check();
  });
  const turnEnds = () => events.filter((e) => e.type === 'multicc_turn_end');
  return {
    child, events, exited, until,
    send: (turn) => child.stdin.write(JSON.stringify(turn) + '\n'),
    waitTurnEnds: (n) => until(() => turnEnds().length >= n).then(turnEnds),
  };
}

const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.part.text).join('');

test('one engine and one native session serve every turn, and stdin close shuts it down', { timeout: 10000 }, async (t) => {
  const fx = fixture('turns');
  t.after(fx.cleanup);
  const b = startBridge(t, fx);
  b.send({ text: 'one' });
  await b.waitTurnEnds(1);
  b.send({ text: 'two' });
  const ends = await b.waitTurnEnds(2);
  assert.deepEqual(ends.map((e) => e.status), ['success', 'success']);
  assert.equal(textOf(b.events), 'echo:oneecho:two');
  const reqs = fx.requests();
  assert.equal(reqs.filter((r) => r.method === 'session/create').length, 1);
  assert.equal(new Set(reqs.map((r) => r.pid)).size, 1, 'both turns ran on the same engine');
  const sends = reqs.filter((r) => r.method === 'session/send');
  assert.equal(sends[0].params.sessionId, sends[1].params.sessionId);
  b.child.stdin.end();
  assert.equal((await b.exited).code, 0);
});

test('a background task holds the turn and its self-wake turn flows into it', { timeout: 10000 }, async (t) => {
  const fx = fixture('hold');
  t.after(fx.cleanup);
  const b = startBridge(t, fx);
  b.send({ text: 'bg job' });
  await b.waitTurnEnds(1);
  const types = b.events.map((e) => e.type);
  const end = types.indexOf('multicc_turn_end');
  const woke = b.events.findIndex((e) => e.type === 'text' && /woke/.test(e.part.text));
  assert.ok(woke > 0 && woke < end, `self-wake answer must land inside the held turn: ${JSON.stringify(types)}`);
  assert.equal(textOf(b.events), 'started background\n\nwoke', 'the wake answer is separated from the first answer');
  const bg = b.events.filter((e) => e.type === 'multicc_background').map((e) => e.active);
  assert.deepEqual(bg, [1, 0]);
  assert.ok(types.indexOf('multicc_background') < end);
  assert.equal(b.events[end].status, 'success');
  b.child.stdin.end();
  await b.exited;
});

test('cancel during a hold ends the turn with the answer it already has', { timeout: 10000 }, async (t) => {
  const fx = fixture('hold-cancel', { FAKE_ZCODE_BG_MS: '60000' });
  t.after(fx.cleanup);
  const b = startBridge(t, fx);
  b.send({ text: 'bg job' });
  await b.until((ev) => ev.some((e) => e.type === 'step_finish'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.events.some((e) => e.type === 'multicc_turn_end'), false, 'held while the task runs');
  b.child.kill('SIGTERM');
  const { code } = await b.exited;
  assert.equal(code, 0);
  assert.deepEqual(b.events.filter((e) => e.type === 'multicc_turn_end').map((e) => e.status), ['success']);
});

test('cancel mid-turn stops the engine turn and reports it cancelled', { timeout: 10000 }, async (t) => {
  const fx = fixture('cancel');
  t.after(fx.cleanup);
  const b = startBridge(t, fx);
  b.send({ text: 'slow' });
  await b.until((ev) => ev.some((e) => e.type === 'text'));
  b.child.kill('SIGTERM');
  await b.exited;
  assert.ok(fx.requests().some((r) => r.method === 'v4/command' && r.params.type === 'stop'));
  const ends = b.events.filter((e) => e.type === 'multicc_turn_end');
  assert.equal(ends.length, 1);
  assert.notEqual(ends[0].status, 'success');
});

test('a per-turn model mismatch fails that turn only', { timeout: 10000 }, async (t) => {
  const fx = fixture('mismatch');
  t.after(fx.cleanup);
  const b = startBridge(t, fx);
  b.send({ text: 'one', model: 'zai/other-model' });
  const [first] = await b.waitTurnEnds(1);
  assert.equal(first.status, 'failed');
  assert.ok(b.events.some((e) => e.type === 'error'));
  b.send({ text: 'two', model: 'zai/glm-5.2' });
  const ends = await b.waitTurnEnds(2);
  assert.equal(ends[1].status, 'success');
  assert.match(textOf(b.events), /echo:two/);
  b.child.stdin.end();
  await b.exited;
});

test('the legacy engine path still serves resident turns and resumes its session', { timeout: 10000 }, async (t) => {
  const fx = fixture('legacy', { MULTICC_ZCODE_LEGACY: '1' });
  t.after(fx.cleanup);
  const capture = path.join(fx.root, 'legacy-args.jsonl');
  fs.writeFileSync(fx.engine, [
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "process.stdout.write(JSON.stringify({ sessionId: 'sess_legacy', response: 'ok', projection: { status: 'idle' }, usage: { inputTokens: 1, outputTokens: 1 } }));",
  ].join('\n'));
  const b = startBridge(t, fx);
  b.send({ text: 'one' });
  await b.waitTurnEnds(1);
  b.send({ text: 'two' });
  const ends = await b.waitTurnEnds(2);
  assert.deepEqual(ends.map((e) => e.status), ['success', 'success']);
  const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes('--resume'), false);
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], 'sess_legacy');
  b.child.stdin.end();
  await b.exited;
});

// ── Through the host stream facade ──

function streamFixture(name, env) {
  const fx = fixture(name, env);
  const stream = createCodexAppStream();
  stream.ensure(name, {
    cmd: BRIDGE, cwd: fx.root, baseArgs: ['--resident'], env: fx.env,
    streamBackend: 'zcode-app-server', idleMs: 60_000,
  });
  return { ...fx, stream };
}

function collect() {
  const events = [];
  return { events, onEvent: (evt) => events.push(evt) };
}

test('the stream serves turns on one child, learns the session and hides the sentinels', { timeout: 10000 }, async (t) => {
  const fx = streamFixture('stream-turns');
  t.after(async () => { await fx.stream.closeAndWait('stream-turns'); fx.cleanup(); });
  const one = collect();
  const r = await fx.stream.send('stream-turns', 'hello', one.onEvent);
  assert.equal(r.result.type, 'multicc_turn_end');
  assert.equal(one.events.some((e) => /^multicc_/.test(e.type)), false, 'sentinels are not provider events');
  assert.equal(textOf(one.events), 'echo:hello');
  const status = fx.stream.status('stream-turns');
  assert.equal(status.backend, 'zcode');
  assert.match(status.threadId, /^sess_fake_/);
  const pid = status.pid;
  await fx.stream.send('stream-turns', 'again', () => {});
  assert.equal(fx.stream.status('stream-turns').pid, pid, 'warm child reused');
  assert.equal(fx.requests().filter((q) => q.method === 'session/create').length, 1);
});

test('a held stream turn resolves only after the self-wake answer', { timeout: 10000 }, async (t) => {
  const fx = streamFixture('stream-hold');
  t.after(async () => { await fx.stream.closeAndWait('stream-hold'); fx.cleanup(); });
  const c = collect();
  await fx.stream.send('stream-hold', 'bg job', c.onEvent);
  assert.match(textOf(c.events), /started background\n\nwoke$/);
  assert.equal(fx.stream.status('stream-hold').backgroundActive, false);
});

test('without a hold, live background work defers recycle until it ends', { timeout: 10000 }, async (t) => {
  const fx = streamFixture('stream-nohold', { MULTICC_BACKGROUND_HOLD_MAX_MS: '0', FAKE_ZCODE_BG_MS: '800' });
  t.after(async () => { await fx.stream.closeAndWait('stream-nohold'); fx.cleanup(); });
  await fx.stream.send('stream-nohold', 'bg job', () => {});
  assert.equal(fx.stream.status('stream-nohold').backgroundActive, true);
  assert.deepEqual(fx.stream.recycle('stream-nohold', 'pool'), { ok: true, applied: 'deferred-background' });
  assert.equal(fx.stream.status('stream-nohold').alive, true, 'the background task keeps its engine');
  const deadline = Date.now() + 5000;
  while (fx.stream.status('stream-nohold').alive && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.stream.status('stream-nohold').alive, false, 'recycled once the task ended');
  // The next turn resumes the same native session on a fresh child.
  const sid = fx.stream.status('stream-nohold').threadId;
  await fx.stream.send('stream-nohold', 'after', () => {});
  const resumes = fx.requests().filter((q) => q.method === 'session/resume');
  assert.equal(resumes.at(-1).params.sessionId, sid);
});

test('a rewritten route file respawns the child at the next boundary and resumes the session', { timeout: 10000 }, async (t) => {
  const fx = streamFixture('stream-route');
  t.after(async () => { await fx.stream.closeAndWait('stream-route'); fx.cleanup(); });
  await fx.stream.send('stream-route', 'one', () => {});
  const before = fx.stream.status('stream-route');
  fs.writeFileSync(fx.settings, JSON.stringify({ model: 'zai/glm-5.2', provider: { zai: { models: { 'glm-5.2': {} } }, other: {} } }));
  await fx.stream.send('stream-route', 'two', () => {});
  const after = fx.stream.status('stream-route');
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.threadId, before.threadId);
  assert.equal(fx.requests().filter((q) => q.method === 'session/resume').at(-1).params.sessionId, before.threadId);
});

test('the zcode adapter declares the resident lane', () => {
  const adapter = createZcodeAdapter({});
  const inv = adapter.buildInvocation({
    historyHandle: { isFirstTurn: false, cliSessionId: 'sess_abc' },
    spawnOpts: { rawModel: 'zai/glm-5.2' },
    contextLayers: [], userText: 'hi', suffix: '',
  });
  assert.equal(inv.streamBackend, 'zcode-app-server');
  assert.equal(inv.nativeKey, 'cliSessionId');
  assert.equal(inv.clientAllocatesNativeId, false);
  assert.deepEqual(inv.streamArgs, ['--session', 'sess_abc', '--model', 'zai/glm-5.2', '--resident']);
  assert.deepEqual(inv.turnOptions, { model: 'zai/glm-5.2' });
});

test('the zcode completion tracker settles on the resident stream boundary', () => {
  const adapter = createZcodeAdapter({});
  const run = (boundary) => {
    const tracker = adapter.createCompletionTracker();
    for (const raw of [
      { type: 'step_start', sessionID: 'sess_a', part: {} },
      { type: 'text', sessionID: 'sess_a', part: { text: 'done' } },
      { type: 'step_finish', sessionID: 'sess_a', part: { reason: 'stop' } },
    ]) tracker.observe(raw, adapter.decodeEvent(raw));
    return tracker.finish(boundary).state;
  };
  assert.equal(run({ kind: 'stream', resolved: true }), 'completed');
  assert.equal(run({ kind: 'process', code: 0 }), 'completed', 'the one-shot lane is unchanged');
  assert.equal(run({ kind: 'stream', rejected: true }), 'failed');
});

test('the background ledger counts running tasks and prunes ones whose process is gone', () => {
  const alive = new Set([101, 102]);
  const tasks = createBackgroundTaskTracker({ isAlive: (pid) => alive.has(pid) });
  const upd = (taskId, status, pid) => ({ type: 'session.updated', payload: { taskId, taskKind: 'bash', status, pid } });
  assert.equal(tasks.observe(upd('exec_1', 'running', 101)), true);
  assert.equal(tasks.observe(upd('exec_2', 'running', 102)), true);
  assert.equal(tasks.observe(upd('exec_1', 'running', 101)), false, 'a repeat is not a change');
  assert.equal(tasks.observe({ type: 'session.updated', payload: { title: 'renamed' } }), false);
  assert.equal(tasks.observe({ type: 'turn.started', payload: { taskId: 'exec_9', status: 'running' } }), false);
  assert.equal(tasks.active, 2);
  assert.equal(tasks.observe(upd('exec_1', 'completed', 101)), true);
  alive.delete(102);
  assert.equal(tasks.prune(), true, 'a task whose process died without a terminal report is dropped');
  assert.equal(tasks.active, 0);
});
