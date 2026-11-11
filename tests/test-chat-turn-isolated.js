'use strict';

// Real gateway + real server + fake Claude CLI, isolated data root. Proves the
// native chat-session table and turn runtime owner survive a full turn
// lifecycle through /ws/chat: connect → send → stream → result → reconnect
// replay, cancel mid-stream (lease released, next turn claims), and deleting a
// running session (directory cascade, since task-bound rooms are not removable
// one by one). Never touches ~/.multicc, the main checkout's data directory or
// the live service.

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');
const isolatedHostEnv = require('./helpers/isolated-host-env');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'isolated-chat-turn-token';

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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated chat-turn server did not become ready');
}

async function waitUntil(check, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
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
// Match only rendered output frames; a queued-control frame echoes the raw
// message text and must not satisfy an "assistant said" assertion.
const OUTPUT_FRAMES = new Set(['assistant', 'stream_event', 'text', 'result']);
const hasText = (frames, needle) => frames.some(frame =>
  OUTPUT_FRAMES.has(frame?.type) && (frameText(frame).includes(needle) || JSON.stringify(frame).includes(needle)));
const terminal = frames => frames.some(frame =>
  frame?.type === 'stream_end' || (frame?.type === 'result' && !frame.partial));

(async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-chat-turn-')));
  const dataDir = assertTestDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const gitConfig = path.join(home, '.gitconfig');
  const commitPolicy = require('../commit-policy.json');
  for (const field of ['name', 'email']) {
    execFileSync('git', ['config', '--file', gitConfig, `user.${field}`, commitPolicy[field]]);
  }
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  const fakeCli = path.join(root, 'fake-claude.js');
  const invocationLog = path.join(root, 'invocations.jsonl');

  // Fake Claude. The chat lane runs the CLI in streaming mode
  // (--input-format stream-json), so the prompt arrives as a JSON user message
  // on stdin, not argv. HANG_FOREVER streams a delta then waits to be killed;
  // SLOW_REPLAY streams a delta then finishes late so a reconnect can observe
  // `cs.streamReplay`. The last write's flush callback exits, because exiting
  // straight after writing to a pipe drops the buffered bytes.
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(invocationLog)};
const args = process.argv.slice(2);
const record = event => fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid, args }) + '\\n');
if (args.includes('--version')) { process.stdout.write('fake-claude 9.9.9\\n'); process.exitCode = 0; }
else {
const sessionAt = args.indexOf('--session-id');
const sessionId = sessionAt >= 0 ? args[sessionAt + 1] : 'fake-claude-session';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const delta = text => emit({ type: 'stream_event', event: { type: 'content_block_delta',
  delta: { type: 'text_delta', text } } });
const finish = text => {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  record('finished');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: text, num_turns: 1, session_id: sessionId }) + '\\n', () => process.exit(0));
};
record('spawn');
process.on('SIGTERM', () => { record('sigterm'); process.exit(143); });
process.on('SIGINT', () => { record('sigterm'); process.exit(130); });
process.stdout.on('error', () => {});
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => block.text || block.content || '').join('') : '';
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch (_) { return; }
  if (message?.type === 'control_request') {
    // The host installs its Monitor admission hook before the first prompt and
    // fails the turn if the CLI does not acknowledge initialization.
    if (message.request?.subtype === 'initialize') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    }
    return;
  }
  const text = textOf(message?.message?.content ?? message?.content);
  const marker = (text.match(/(?:PING|SLOW_REPLAY|HANG_FOREVER)_[A-Z0-9_]+/g) || []).pop();
  if (!marker) return;
  record('prompt:' + marker);
  if (marker.includes('HANG_FOREVER')) {
    delta('hang:partial');
    record('hanging');
    setInterval(() => {}, 1000);
  } else if (marker.includes('SLOW_REPLAY')) {
    delta('slow:partial');
    setTimeout(() => finish('slow:done'), 2500);
  } else {
    delta('echo:' + marker);
    finish('echo:' + marker);
  }
});
}
`);
  fs.chmodSync(fakeCli, 0o755);

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
    env: {
      ...isolatedHostEnv(),
      NODE_ENV: 'test',
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
      MULTICC_CLAUDE_BIN: fakeCli,
      CODEX_CMD: path.join(root, 'missing-codex'),
      OPENCODE_CMD: path.join(root, 'missing-opencode'),
      QODER_CMD: path.join(root, 'missing-qoder'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-30000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-30000); });
  const sockets = [];

  async function api(method, route) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      ...(method === 'GET' ? {} : { body: JSON.stringify({}) }),
    });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  }
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
  function sendUser(socket, text) {
    socket.send({ type: 'user_message', text, taskShell: true, clientMsgId: randomUUID() });
  }

  try {
    await waitReady(base);

    const dirA = await apiOk('POST', '/api/directories', {
      name: 'Chat turn A', path: projectA, create: true,
    });
    const dirB = await apiOk('POST', '/api/directories', {
      name: 'Chat turn B', path: projectB, create: true,
    });
    const createdA = await apiOk('POST', `/api/directories/${dirA.id}/sessions`, {
      cli: 'claude', kind: 'chat', label: 'turn-a',
    });
    const sessionA = createdA.id || createdA.sessionId;
    assert.ok(sessionA, `session A created: ${JSON.stringify(createdA)}`);
    const wsUrl = `ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionA)}&token=${TOKEN}`;

    // ── 1. connect → send → stream → result ──
    const first = await connect(wsUrl);
    sockets.push(first.ws);
    await waitUntil(() => first.frames.length > 0, 'no initial chat frame');
    sendUser(first, 'PING_ONE');
    await first.until(frames => hasText(frames, 'echo:PING_ONE'), 'assistant echo');
    await first.until(terminal, 'turn completion');
    first.ws.close();

    // ── 2. reconnect replay: a second socket sees the live streamReplay ──
    const second = await connect(wsUrl);
    sockets.push(second.ws);
    await waitUntil(() => second.frames.length > 0, 'no second chat frame');
    sendUser(second, 'SLOW_REPLAY_ONE');
    await second.until(frames => hasText(frames, 'slow:partial'), 'slow partial delta');
    second.ws.close();
    const third = await connect(wsUrl);
    sockets.push(third.ws);
    await third.until(frames => hasText(frames, 'slow:partial'),
      'reconnect replay of the in-flight delta');
    await third.until(frames => hasText(frames, 'slow:done'), 'slow result after reconnect');
    await third.until(terminal, 'slow turn completion');

    // ── 3. cancel mid-stream releases the preparation lease ──
    sendUser(third, 'HANG_FOREVER_ONE');
    await third.until(frames => hasText(frames, 'hang:partial'), 'hang partial delta');
    await waitUntil(() => invocations().some(row => row.event === 'hanging'),
      'fake CLI never hung');
    // The task-shell control path only cancels the turn the client names; the
    // turnId comes from the stream frames.
    const turnId = [...third.frames].reverse().find(frame => frame.turnId)?.turnId;
    assert.ok(turnId, 'stream frames must carry the active turnId');
    third.send({ type: 'cancel', taskShell: true, clientMsgId: randomUUID(), turnId });
    await waitUntil(() => invocations().some(row => row.event === 'sigterm'),
      'cancelled fake CLI did not receive SIGTERM').catch(error => {
      error.message += ` frames=${JSON.stringify(third.frames.slice(-6)).slice(-2000)}`;
      throw error;
    });
    await third.until(terminal, 'cancel terminal frame', 30000);
    // A new claim on the same session proves the runtime store returned to idle.
    const before = invocations().filter(row => row.event === 'spawn').length;
    sendUser(third, 'PING_TWO');
    await third.until(frames => hasText(frames, 'echo:PING_TWO'), 'post-cancel turn');
    await third.until(terminal, 'post-cancel completion');
    assert.ok(invocations().filter(row => row.event === 'spawn').length > before,
      'post-cancel turn must spawn a fresh CLI process');

    // ── 4. deleting a running session is refused, not half-done ──
    // A task-bound room is its task's only chat evidence, so both supported
    // delete routes must refuse while the turn is open: the room route with
    // TASK_HISTORY_REFERENCED and the owning task route with task_busy. The
    // native owner must keep serving the live table through both refusals, and
    // the supported disposal (cancel, then delete the task) must then remove
    // the room without disturbing the surviving session.
    const createdB = await apiOk('POST', `/api/directories/${dirB.id}/sessions`, {
      cli: 'claude', kind: 'chat', label: 'turn-b',
    });
    const sessionB = createdB.id || createdB.sessionId;
    const fourth = await connect(
      `ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionB)}&token=${TOKEN}`);
    sockets.push(fourth.ws);
    await waitUntil(() => fourth.frames.length > 0, 'no session B chat frame');
    sendUser(fourth, 'HANG_FOREVER_TWO');
    await fourth.until(frames => hasText(frames, 'hang:partial'), 'session B hang delta');
    const taskB = [...fourth.frames].reverse().find(frame => frame.taskId)?.taskId;
    assert.match(String(taskB), /^tsk_/, 'running session B must carry its task id');
    const refusedRoom = await api('DELETE', `/api/sessions/${sessionB}?force=1`);
    assert.equal(refusedRoom.status, 409,
      `running room delete must be refused: ${refusedRoom.status} ${JSON.stringify(refusedRoom.body)}`);
    assert.equal(refusedRoom.body.code, 'TASK_HISTORY_REFERENCED');
    const refusedTask = await api('DELETE', `/api/task-board/tasks/${taskB}`);
    assert.equal(refusedTask.status, 409,
      `running task delete must be refused: ${refusedTask.status} ${JSON.stringify(refusedTask.body)}`);
    assert.equal(refusedTask.body.error, 'task_busy');
    // Both refusals must leave the live room and its turn intact.
    const stillThere = await api('GET', `/api/sessions/${sessionB}`);
    assert.equal(stillThere.status, 200, 'refused delete must not remove the live session');
    assert.ok(fourth.frames.filter(frame => frame.type === 'stream_event').length >= 1,
      'refused delete must not disturb the stream');
    // Supported disposal: cancel, then delete the owning task.
    const turnB = [...fourth.frames].reverse().find(frame => frame.turnId)?.turnId;
    fourth.send({ type: 'cancel', taskShell: true, clientMsgId: randomUUID(), turnId: turnB });
    await waitUntil(() => invocations().filter(row => row.event === 'sigterm').length >= 2,
      'session B cancel did not reach the CLI');
    // The task route only accepts the delete once the run released its lease,
    // so retrying here doubles as the cancel-settlement proof.
    const removedTask = await waitUntil(async () => {
      const attempt = await api('DELETE', `/api/task-board/tasks/${taskB}`);
      if (attempt.status === 200) return attempt;
      if (attempt.status === 409) return null;
      throw new Error(`task delete failed: ${attempt.status} ${JSON.stringify(attempt.body)}`);
    }, 'task delete never became legal after cancel', 300);
    const gone = await waitUntil(async () => {
      const probe = await api('GET', `/api/sessions/${sessionB}`);
      return probe.status === 404 ? probe : null;
    }, 'deleted task did not cascade its room');
    assert.equal(gone.status, 404);
    await waitReady(base);
    // The surviving session must still own a live runtime after the cascade.
    sendUser(third, 'PING_THREE');
    await third.until(frames => hasText(frames, 'echo:PING_THREE'), 'post-delete turn');
    await third.until(terminal, 'post-delete completion');
    console.log('isolated gateway + server chat turn/native runtime check passed');
  } catch (error) {
    console.error(output);
    console.error('INVOCATIONS:', invocations().map(row => row.event).join(','));
    throw error;
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch (_) {}
    }
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGINT');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
