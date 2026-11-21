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

const BRIDGE = 'codex-app-bridge';
const BRIDGE_CMD = require('../src/native/runtime').gatewayPath();

function startBridge(root, extraArgs = [], envExtra = {}) {
  const logFile = path.join(root, `requests-${extraArgs.length}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(logFile, '');
  const child = spawn(BRIDGE_CMD, [BRIDGE, ...extraArgs], {
    cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile, ...envExtra }, stdio: ['pipe', 'pipe', 'pipe'],
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

test('resident bridge replaces a thread whose model provider no longer exists', async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-provider-gone-'));
  const bin = writeFakeAppServer(root);
  // The exact refusal codex 0.162 emits when a resumed chat names a provider
  // that was removed from config.toml (repro of the 2026-11-04 live failure).
  const bridge = startBridge(root,
    ['--codex-bin', bin, '--resident', '--thread-id', 'thread-from-disk'],
    {
      FAKE_CODEX_REJECT: 'thread/resume',
      FAKE_CODEX_REJECT_MESSAGE: 'This chat uses model provider "multicc_official_relay", which is no longer configured. Restore this provider\'s configuration to continue.',
    });
  t.after(() => { try { bridge.child.kill('SIGKILL'); } catch (_) {} });

  bridge.send('continue on a fresh thread');
  const turn = await bridge.nextTurn();
  assert.equal(turn.params.turn.status, 'completed');

  const missing = bridge.notifications.find((message) => message.method === 'multicc/native_session_missing');
  assert.ok(missing, `the host must be told the stored thread is gone; stderr=${bridge.stderr()}`);
  assert.equal(missing.params.threadId, 'thread-from-disk');

  const methods = bridge.requests().filter((item) => item.id).map((item) => item.method);
  assert.deepEqual(methods, ['initialize', 'thread/resume', 'thread/start', 'turn/start']);
  const started = bridge.requests().find((item) => item.method === 'turn/start');
  assert.equal(started.params.threadId, 'thread-resident',
    'the turn must run on the replacement thread, not the unusable one');

  bridge.child.stdin.end();
  assert.equal((await bridge.exited).code, 0, `recovery is not a failure; ${bridge.stderr()}`);
});

test('resident bridge still fails closed when resume breaks for another reason', async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-resume-fatal-'));
  const bin = writeFakeAppServer(root);
  // A timeout/auth/transport failure is not proof that the thread is unusable:
  // forking a fresh conversation there would silently drop the user's context.
  const bridge = startBridge(root,
    ['--codex-bin', bin, '--resident', '--thread-id', 'thread-from-disk'],
    { FAKE_CODEX_REJECT: 'thread/resume', FAKE_CODEX_REJECT_MESSAGE: 'thread/resume timed out' });
  t.after(() => { try { bridge.child.kill('SIGKILL'); } catch (_) {} });

  const exit = await bridge.exited;
  assert.equal(exit.code, 1);
  assert.equal(bridge.notifications.find((message) => message.method === 'multicc/native_session_missing'), undefined);
  assert.equal(bridge.requests().find((item) => item.method === 'thread/start'), undefined);
  assert.match(bridge.stderr(), /thread\/resume timed out/);
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
  // stdout and stderr are separate pipes: the warning can land after the
  // turn boundary we just awaited, so give it a bounded window instead of
  // reading stderr exactly once (a race that reddened CI on a fast runner).
  for (let attempt = 0; attempt < 100 && !/dropped a non-JSON stdin line/.test(bridge.stderr()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(bridge.stderr(), /dropped a non-JSON stdin line/);
  assert.deepEqual(
    bridge.requests().filter((item) => item.method === 'turn/start').map((item) => item.params.input[0].text),
    ['still works'],
  );
  bridge.child.stdin.end();
  await bridge.exited;
});

test('原生 Codex 桥在无 Node 的 PATH 中运行多轮并核对进程树', { timeout: 10_000 }, async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-native-zero-node-'));
  const bin = path.join(root, 'codex'); fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(bin, `#!/bin/sh
turn=0
while IFS= read -r line; do
 id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\\([0-9][0-9]*\\).*/\\1/p')
 case "$line" in
  *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fixture/0.154.0"}}\\n' "$id";;
  *'"method":"thread/start"'*) printf '{"id":%s,"result":{"thread":{"id":"native-thread"}}}\\n' "$id"; printf '{"method":"thread/started","params":{"thread":{"id":"native-thread"}}}\\n';;
  *'"method":"turn/start"'*) turn=$((turn+1)); printf '{"id":%s,"result":{"turn":{"id":"turn-%s"}}}\\n' "$id" "$turn";
   printf '{"method":"item/agentMessage/delta","params":{"itemId":"a","delta":"中文😀"}}\\n';
   printf '{"method":"turn/completed","params":{"turn":{"id":"turn-%s","status":"completed"}}}\\n' "$turn";;
 esac
done
`, { mode: 0o755 });
  const bridge = startBridge(root, ['--codex-bin', bin, '--resident'], { PATH: path.join(root, 'empty') });
  t.after(async () => { bridge.child.kill('SIGKILL'); await bridge.exited; fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 2; i++) {
    const completed = bridge.nextTurn(); bridge.send('隔离执行');
    assert.equal((await completed).params.turn.status, 'completed');
  }
  const ps = require('node:child_process').spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  assert.equal(ps.status, 0);
  const rows = ps.stdout.trim().split('\n').map(line => { const fields = line.trim().split(/\s+/); return { pid: Number(fields[0]), parent: Number(fields[1]), command: fields.slice(2).join(' ') }; });
  const tree = new Set([bridge.child.pid]);
  for (const pid of tree) for (const row of rows) if (row.parent === pid) tree.add(row.pid);
  const owned = rows.filter(row => tree.has(row.pid));
  assert.ok(owned.length >= 2, '真实 CLI 子进程必须仍在运行');
  const nodes = owned.filter(row => /^(node|nodejs|node.exe)$/.test(path.basename(row.command)));
  console.log(`Codex 原生桥 PID ${bridge.child.pid}；PATH 无 Node；进程树 Node 数 ${nodes.length}`);
  for (const row of owned) console.log(`${row.pid} ${row.parent} ${row.command}`);
  assert.deepEqual(nodes, []);
  assert.equal(bridge.notifications.filter(event => event.method === 'turn/completed').length, 2);
  bridge.child.stdin.end(); assert.equal((await bridge.exited).code, 0);
});

test('等待 turn/start RPC 时关闭标准输入仍立即回收进程', { timeout: 5000 }, async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-pending-eof-'));
  const bin = writeFakeAppServer(root);
  const bridge = startBridge(root, ['--codex-bin', bin, '--resident'], { FAKE_CODEX_SILENT_METHOD: 'turn/start' });
  t.after(async () => { bridge.child.kill('SIGKILL'); await bridge.exited; fs.rmSync(root, { recursive: true, force: true }); });
  bridge.send('等待确认');
  const deadline = Date.now() + 2500;
  while (!bridge.requests().some(item => item.method === 'turn/start')) {
    assert.ok(Date.now() < deadline, bridge.stderr()); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const started = Date.now(); bridge.child.stdin.end();
  assert.equal((await bridge.exited).code, 0);
  assert.ok(Date.now() - started < 2000, '关闭不能等待 30 秒 RPC 超时');
});

test('回合中请求切换线程会等待前一回合完成再恢复目标线程', { timeout: 5000 }, async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-queued-switch-'));
  const bin = writeFakeAppServer(root);
  const bridge = startBridge(root, ['--codex-bin', bin, '--resident'], { FAKE_CODEX_HOLD_MS: '150' });
  t.after(async () => { bridge.child.kill('SIGKILL'); await bridge.exited; fs.rmSync(root, { recursive: true, force: true }); });
  const first = bridge.nextTurn(); bridge.send('第一轮');
  const deadline = Date.now() + 2500;
  while (!bridge.requests().some(item => item.method === 'turn/start')) {
    assert.ok(Date.now() < deadline, bridge.stderr()); await new Promise(resolve => setTimeout(resolve, 10));
  }
  bridge.child.stdin.write(`${JSON.stringify({ text: '第二轮', threadId: 'other-thread' })}\n`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bridge.requests().some(item => item.method === 'thread/resume'), false);
  await first;
  await bridge.nextTurn();
  assert.deepEqual(bridge.requests().filter(item => item.id).map(item => item.method), ['initialize', 'thread/start', 'turn/start', 'thread/resume', 'turn/start']);
  bridge.child.stdin.end(); await bridge.exited;
});

test('宿主关闭输出管道时透传写失败并回收 app-server', { timeout: 5000 }, async (t) => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-output-close-'));
  const bin = writeFakeAppServer(root);
  const bridge = startBridge(root, ['--codex-bin', bin, '--resident']);
  t.after(async () => { bridge.child.kill('SIGKILL'); await bridge.exited; fs.rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 2500;
  while (!bridge.notifications.some(item => item.method === 'thread/started')) {
    assert.ok(Date.now() < deadline, bridge.stderr()); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const closed = new Promise(resolve => bridge.child.stdout.once('close', resolve));
  bridge.child.stdout.destroy(); await closed;
  bridge.send('触发输出写入');
  assert.equal((await bridge.exited).code, 1);
  assert.match(bridge.stderr(), /app-server output failed:.*(?:Broken pipe|broken pipe|os error 32)/);
});
