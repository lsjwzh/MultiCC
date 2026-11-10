'use strict';

// 真实网关与服务端，使用隔离数据目录和假的 SDK 子进程。
// 覆盖正常结束、无结果异常退出、无结果正常退出、排队续接与中途取消。
// Each scenario uses its own session so a frozen disposition cannot leak
// into the next assertion. Never touches ~/.multicc, the main checkout's data
// directory or the live service.

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'isolated-chat-finalize-token';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(base) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated chat-finalize server did not become ready');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const waiters = [];
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error(`WebSocket timed out: ${url}`));
    }, 10000);
    ws.on('message', data => {
      try { frames.push(JSON.parse(String(data))); } catch (_) { frames.push({ raw: String(data) }); }
      for (const wake of waiters.splice(0)) wake();
    });
    ws.once('open', () => {
      clearTimeout(timer);
      resolve({
        ws, frames,
        send(frame) { ws.send(JSON.stringify(frame)); },
        async until(predicate, label = 'frame', ms = 20000) {
          const started = Date.now();
          while (!predicate(frames)) {
            if (Date.now() - started > ms) {
              throw new Error(`${label} timeout: ${JSON.stringify(frames).slice(-2000)}`);
            }
            await new Promise(resolve => {
              const fallback = setTimeout(resolve, 50);
              waiters.push(() => { clearTimeout(fallback); resolve(); });
            });
          }
          return frames;
        },
      });
    });
    ws.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

const frameText = frame => {
  if (frame?.type === 'stream_event') return frame.event?.delta?.text || '';
  const content = frame?.message?.content ?? frame?.content ?? frame?.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => block.text || '').join('');
  return '';
};
const OUTPUT_FRAMES = new Set(['assistant', 'stream_event', 'text', 'result']);
const hasText = (frames, needle) => frames.some(frame =>
  OUTPUT_FRAMES.has(frame?.type) && (frameText(frame).includes(needle) || JSON.stringify(frame).includes(needle)));
const terminal = frames => frames.some(frame =>
  frame?.type === 'stream_end' || (frame?.type === 'result' && !frame.partial));

(async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-chat-finalize-')));
  const dataDir = assertTestDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const gitConfig = path.join(home, '.gitconfig');
  const commitPolicy = require('../commit-policy.json');
  for (const field of ['name', 'email']) {
    execFileSync('git', ['config', '--file', gitConfig, `user.${field}`, commitPolicy[field]]);
  }
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const fakeCli = path.join(root, 'fake-claude.js');
  const invocationLog = path.join(root, 'invocations.jsonl');

  // PLAIN: a normal clean turn. CRASH: a delta then a non-zero exit without a
  // result event. NORESULT: a delta then a zero exit without a result event.
  // HANG: a delta then wait to be killed. The flush callback exits so a piped
  // write is not truncated.
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(invocationLog)};
const args = process.argv.slice(2);
const record = event => fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid }) + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const delta = text => emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const finish = text => {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: text, num_turns: 1, session_id: 'fake' }) + '\\n', () => process.exit(0));
};
if (args.includes('--version')) { process.stdout.write('fake-claude 9.9.9\\n'); process.exitCode = 0; }
else {
record('spawn');
process.on('SIGTERM', () => { record('sigterm'); process.exit(143); });
process.on('SIGINT', () => { record('sigterm'); process.exit(130); });
process.stdout.on('error', () => {});
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => block.text || block.content || '').join('') : '';
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch (_) { return; }
  if (message?.type === 'control_request') {
    if (message.request?.subtype === 'initialize') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    }
    return;
  }
  const text = textOf(message?.message?.content ?? message?.content);
  const marker = (text.match(/(?:PLAIN|CRASH|NORESULT|HANG|SLOW)_[A-Z0-9_]+/g) || []).pop();
  if (!marker) return;
  record('prompt:' + marker);
  if (marker.includes('CRASH')) {
    delta('crash:partial');
    record('crash');
    setTimeout(() => process.exit(3), 60);
  } else if (marker.includes('NORESULT')) {
    delta('noresult:partial');
    record('noresult');
    setTimeout(() => process.exit(0), 60);
  } else if (marker.includes('HANG')) {
    delta('hang:partial');
    record('hanging');
    setInterval(() => {}, 1000);
  } else if (marker.includes('SLOW')) {
    delta('slow:first');
    record('slow');
    setTimeout(() => finish('slow:done'), 2500);
  } else {
    delta('echo:' + marker);
    finish('echo:' + marker);
  }
});
}
`);
  fs.chmodSync(fakeCli, 0o755);
  // Claude 聊天已统一到内置 SDK，CLAUDE_CMD 只影响非聊天用途。
  // 仅在隔离测试子进程中替换二进制定位器，仍经过真实 Rust lane 和收尾链路。
  const preload = path.join(root, 'sdk-test-preload.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(ROOT, 'src/cli/claude-bundled-binary'))})
    .bundledClaudeCodeBinary = () => ${JSON.stringify(fakeCli)};\n`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const addon = process.env.MULTICC_RUST_ADDON
    || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.join(ROOT, 'native', 'prebuilt'),
      `${process.platform}-${process.arch}`, 'multicc_core.node');
  const gateway = path.join(path.dirname(addon),
    process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  let output = '';
  const child = spawn(gateway, ['serve', '--cwd', ROOT, '--node', process.execPath, 'server.js'], {
    cwd: ROOT,
    // Own a process group so forced teardown also stops the gateway's Node
    // child. Killing only the gateway leaves that writer racing directory removal.
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`,
      HOST: '127.0.0.1',
      PORT: String(port),
      ACCESS_TOKEN: TOKEN,
      MULTICC_ALLOW_LEGACY_WS_TOKEN: '1',
      MULTICC_ALLOW_REMOTE: '0',
      MULTICC_DATA_DIR: dataDir,
      MULTICC_MEMORY_ROOT: path.join(dataDir, 'memories'),
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100',
      MULTICC_TASK_SHELLS: '1',
      HOME: home,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: os.devNull,
      CLAUDE_CMD: fakeCli,
      CODEX_CMD: path.join(root, 'missing-codex'),
      OPENCODE_CMD: path.join(root, 'missing-opencode'),
      QODER_CMD: path.join(root, 'missing-qoder'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childClosed = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-30000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-30000); });
  const sockets = [];

  async function apiOk(method, route, body) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${raw}`);
    return raw ? JSON.parse(raw) : null;
  }
  const invocations = () => (fs.existsSync(invocationLog)
    ? fs.readFileSync(invocationLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []);
  const sendUser = (socket, text) => socket.send({
    type: 'user_message', text, taskShell: true, clientMsgId: randomUUID(),
  });

  async function newSession(label) {
    const created = await apiOk('POST', `/api/directories/${directory.id}/sessions`, {
      cli: 'claude', kind: 'chat', label,
    });
    const sessionId = created.id || created.sessionId;
    assert.ok(sessionId, `session created: ${JSON.stringify(created)}`);
    const socket = await connect(
      `ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionId)}&token=${TOKEN}`);
    sockets.push(socket.ws);
    await new Promise(resolve => setTimeout(resolve, 100));
    return socket;
  }

  let directory;
  try {
    await waitReady(base);
    directory = await apiOk('POST', '/api/directories', {
      name: 'Chat finalize', path: project, create: true,
    });

    // ── normal completion ──
    const plain = await newSession('plain');
    sendUser(plain, 'PLAIN_ONE');
    await plain.until(frames => hasText(frames, 'echo:PLAIN_ONE'), 'assistant echo');
    await plain.until(frames => frames.some(frame => frame?.type === 'stream_end'), 'clean turn terminal');
    const plainEnd = plain.frames.find(frame => frame.type === 'stream_end');
    assert.ok(plainEnd, 'clean turn must end with a stream_end frame');
    plain.ws.close();

    // ── abrupt close, non-zero exit, no result ──
    const crash = await newSession('crash');
    sendUser(crash, 'CRASH_ONE');
    await crash.until(frames => hasText(frames, 'crash:partial'), 'crash partial delta');
    await crash.until(terminal, 'crash terminal');
    assert.ok(invocations().some(row => row.event === 'crash'), 'fake CLI never crashed');
    assert.equal(hasText(crash.frames, 'crash:done'), false, 'a crash cannot fabricate a completed result');
    crash.ws.close();

    // ── zero exit without a result event ──
    const noresult = await newSession('noresult');
    sendUser(noresult, 'NORESULT_ONE');
    await noresult.until(frames => hasText(frames, 'noresult:partial'), 'no-result partial delta');
    await noresult.until(terminal, 'no-result terminal');
    assert.ok(invocations().some(row => row.event === 'noresult'), 'fake CLI never exited without a result');
    noresult.ws.close();

    // ── a new user message while a turn runs is queued, then claimed ──
    const queued = await newSession('queued');
    sendUser(queued, 'SLOW_ONE');
    await queued.until(frames => hasText(frames, 'slow:first'), 'queued partial delta');
    const beforeQueuedKills = invocations().filter(row => row.event === 'sigterm').length;
    sendUser(queued, 'PLAIN_THREE');
    await queued.until(frames => hasText(frames, 'slow:done'), 'queued turn completion');
    await queued.until(frames => hasText(frames, 'echo:PLAIN_THREE'),
      'follow-up turn after queue drain', 60000);
    assert.equal(invocations().filter(row => row.event === 'sigterm').length, beforeQueuedKills,
      'a queued follow-up must not kill the running CLI');
    await queued.until(frames => frames.some(frame => frame?.type === 'stream_end'),
      'follow-up turn completion', 45000);
    queued.ws.close();

    // ── mid-stream cancel ──
    const hang = await newSession('hang');
    sendUser(hang, 'HANG_ONE');
    await hang.until(frames => hasText(frames, 'hang:partial'), 'hang partial delta');
    const turnId = [...hang.frames].reverse().find(frame => frame.turnId)?.turnId;
    assert.ok(turnId, 'stream frames must carry the active turnId');
    hang.send({ type: 'cancel', taskShell: true, clientMsgId: randomUUID(), turnId });
    await hang.until(() => invocations().some(row => row.event === 'sigterm'), 'cancel did not reach the CLI');
    const hangTask = [...hang.frames].reverse().find(frame => frame.taskId)?.taskId;
    assert.match(String(hangTask), /^tsk_/, 'cancelled turn must carry its task id');
    // A cancelled turn ends without a result frame; the settlement is the
    // task-state/notify pair the operator sees. The classifier gives up only
    // after backoff (the isolated root has no aux provider), so allow the same
    // window the turn runtime suite uses.
    await hang.until(frames => frames.some(frame =>
      frame?.type === 'notify' && frame.taskId === hangTask && frame.state === 'error'),
    'cancel settlement', 45000);
    // SDK 的结束通知可先于取消事务的状态快照，等待取消事实本身。
    await hang.until(frames => frames.some(frame => frame?.type === 'task_state'
      && frame.taskId === hangTask && frame.cancelReason === 'user_cancelled'),
    'cancelled turn must freeze the task state as user-cancelled', 45000);
    // A fresh turn on the same session proves the runtime returned to idle.
    sendUser(hang, 'PLAIN_TWO');
    await hang.until(frames => hasText(frames, 'echo:PLAIN_TWO'), 'post-cancel turn');
    await hang.until(frames => frames.some(frame => frame?.type === 'stream_end'), 'post-cancel completion');
    hang.ws.close();

    // The server must survive every frozen disposition.
    await waitReady(base);
    console.log('isolated gateway + server finalize boundary check passed');
  } catch (error) {
    console.error(output);
    console.error('INVOCATIONS:', invocations().map(row => row.event).join(','));
    throw error;
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch (_) {}
    }
    // Wait for close (including inherited pipes), not merely the gateway's
    // exit. A signal exit has a null exitCode, so check signalCode too.
    let stopTimer;
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
      const closed = await Promise.race([
        childClosed.then(() => true),
        new Promise(resolve => { stopTimer = setTimeout(() => resolve(false), 10000); }),
      ]);
      if (!closed) {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        clearTimeout(stopTimer);
        await Promise.race([
          childClosed,
          new Promise((_, reject) => {
            stopTimer = setTimeout(() => reject(new Error('isolated gateway teardown timed out')), 5000);
          }),
        ]);
      }
    } finally { clearTimeout(stopTimer); }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
