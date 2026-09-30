'use strict';
// The codex app-server bridge in its resident lane.
//
// `codex app-server --listen stdio://` is a long-lived server, but the bridge
// used to wrap it one-shot: prompt in argv, SIGTERM on `turn/completed`. That
// meant every turn paid a fresh thread (or a `thread/resume`), which is exactly
// what the codex-exp lane could not afford to keep doing. These tests pin the
// resident contract:
//
//   • ONE thread for the whole session — turn two must NOT re-open it
//   • a turn boundary is `turn/completed`, not process exit
//   • ending stdin is the graceful shutdown (host closed the session)
//   • the one-shot lane still works when a prompt is in argv

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const test = require('node:test');

const { writeFakeAppServer } = require('./helpers/fake-codex-app-server');

const BRIDGE = path.join(__dirname, '../src/cli-adapters/codex-app-server-bridge.cjs');

function startBridge(root, extraArgs = []) {
  const logFile = path.join(root, `requests-${extraArgs.length}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(logFile, '');
  const child = spawn(process.execPath, [BRIDGE, ...extraArgs], {
    cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const notifications = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch (_) { return; }
    notifications.push(message);
    for (const waiter of waiters.splice(0)) waiter(message);
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return {
    child,
    notifications,
    stderr: () => stderr,
    requests: () => (fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line))),
    // Wait for the next notification (turn boundary) or reject on process death.
    nextTurn(timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for turn/completed; stderr=${stderr}`)), timeoutMs);
        const waiter = (message) => {
          if (message.method !== 'turn/completed') return false;
          clearTimeout(timer);
          resolve(message);
          return true;
        };
        waiters.push(function keep(message) {
          if (waiter(message)) return;
          waiters.push(keep);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`bridge exited code=${code} before the turn finished; stderr=${stderr}`));
        });
      });
    },
    send(text) { child.stdin.write(`${JSON.stringify({ text })}\n`); },
    exited: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
  };
}

test('resident bridge keeps one thread across turns and exits when stdin ends', async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-resident-'));
  const bin = writeFakeAppServer(root);
  const bridge = startBridge(root, ['--codex-bin', bin, '--resident']);
  t.after(() => { try { bridge.child.kill('SIGKILL'); } catch (_) {} });

  bridge.send('hello one');
  const first = await bridge.nextTurn();
  assert.equal(first.params.turn.status, 'completed');

  bridge.send('hello two');
  const second = await bridge.nextTurn();
  assert.equal(second.params.turn.status, 'completed');

  const requests = bridge.requests();
  assert.deepEqual(
    requests.filter((item) => item.id).map((item) => item.method),
    ['initialize', 'thread/start', 'turn/start', 'turn/start'],
    'turn two must reuse the thread the bridge already opened, not re-open it',
  );
  const turns = requests.filter((item) => item.method === 'turn/start');
  assert.deepEqual(turns.map((item) => item.params.input[0].text), ['hello one', 'hello two']);
  assert.equal(turns[1].params.threadId, 'thread-resident', 'both turns run on the same thread');

  bridge.child.stdin.end();
  const exit = await bridge.exited;
  assert.equal(exit.code, 0, `closing stdin is the graceful shutdown; ${bridge.stderr()}`);
});

test('resident bridge re-attaches to a resumed thread instead of forking one', async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-resume-'));
  const bin = writeFakeAppServer(root);
  const bridge = startBridge(root, ['--codex-bin', bin, '--resident', '--thread-id', 'thread-from-disk']);
  t.after(() => { try { bridge.child.kill('SIGKILL'); } catch (_) {} });

  bridge.send('continue');
  await bridge.nextTurn();

  const methods = bridge.requests().filter((item) => item.id).map((item) => item.method);
  assert.deepEqual(methods, ['initialize', 'thread/resume', 'turn/start']);
  assert.equal(
    bridge.requests().find((item) => item.method === 'thread/resume').params.threadId,
    'thread-from-disk',
  );
  bridge.child.stdin.end();
  await bridge.exited;
});

test('resident bridge refuses a non-JSON stdin line instead of starting a turn', async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-garbage-'));
  const bin = writeFakeAppServer(root);
  const bridge = startBridge(root, ['--codex-bin', bin, '--resident']);
  t.after(() => { try { bridge.child.kill('SIGKILL'); } catch (_) {} });

  bridge.child.stdin.write('not json\n');
  bridge.send('still works');
  await bridge.nextTurn();
  assert.match(bridge.stderr(), /dropped a non-JSON stdin line/);
  assert.deepEqual(
    bridge.requests().filter((item) => item.method === 'turn/start').map((item) => item.params.input[0].text),
    ['still works'],
  );
  bridge.child.stdin.end();
  await bridge.exited;
});
