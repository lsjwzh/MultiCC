'use strict';

// Captures REAL /ws/chat replay-buffer behaviour from a real gateway + real
// Node server + a fake Claude CLI on an isolated data root, and freezes it as
// the differential corpus for multicc_core::chat_replay_buffer.
//
//   node docs/rust-migration/differential/capture-replay-buffer.js
//
// Each scenario drives a turn through the production engine with a fake CLI
// and then reconnects a second socket; what that socket
// receives IS the buffer's content, observed through the same burst path the
// product uses. The capture therefore records externally visible behaviour
// rather than instrumented internals -- no production file is patched to make
// it observable.
//
// Scenarios, chosen because each exercises a different buffer rule:
//   replay          a turn still streaming  -> the buffer replays in order
//   eviction        more than the 500 cap   -> oldest frames are dropped, FIFO
//   turn-boundary   a finished turn, then a new one -> the buffer was cleared
//   cancel          cancelled mid-stream    -> what survives for the next client
//   retry           controlled API retry    -> replay of the second attempt
//   background      post-result completion  -> live notification and reconnect
//   crash-recovery  server killed mid-turn  -> the buffer is per-process state:
//                   after a relaunch on the same data dir the reconnecting
//                   client is served from history only, no stream_event burst
//
// Retry and background completion are driven through the real turn engine by
// the fake CLI. The capture fails if the retry or completion is not observed.
//
// Never touches ~/.multicc, the main checkout's data directory or the live
// service: HOME, MULTICC_DATA_DIR and the CLI binaries all point into a
// mkdtemp root that is removed on exit.

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { assertTestDir } = require('../../../src/paths');
const isolatedHostEnv = require('../../../tests/helpers/isolated-host-env');

const ROOT = path.join(__dirname, '..', '..', '..');
const TOKEN = 'capture-replay-buffer-token';
// `--out <file>` writes a fresh capture elsewhere without touching the frozen
// golden; tests/test-chat-replay-wiring-capture.js compares such a capture
// against it.
const outFlag = process.argv.indexOf('--out');
const OUT = outFlag > 0 && process.argv[outFlag + 1]
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(__dirname, 'chat-replay-buffer-golden.json');
// The production cap in src/chat/turn-engine.js; the burst overshoots it so the
// eviction rule is observed rather than assumed.
const BURST = 620;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(base, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('capture server did not become ready');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const frameBytes = [];
    const wireFrames = [];
    let wirePending = Buffer.alloc(0);
    let headersPending = true;
    let wireError = null;
    const checkWire = () => {
      if (wireError) throw new Error(wireError);
      const messages = [];
      let fragments = [];
      let binary = false;
      for (const frame of wireFrames) {
        const raw = Buffer.from(frame.base64, 'base64');
        const opcode = raw[0] & 0x0f;
        if (opcode >= 8) continue;
        if (opcode === 1 || opcode === 2) { fragments = []; binary = opcode === 2; }
        else if (opcode !== 0 || !fragments.length) throw new Error('invalid captured data frame sequence');
        const marker = raw[1] & 0x7f;
        const offset = marker === 126 ? 4 : marker === 127 ? 10 : 2;
        fragments.push(raw.subarray(offset));
        if (raw[0] & 0x80) {
          messages.push({ binary, base64: Buffer.concat(fragments).toString('base64') });
          fragments = [];
        }
      }
      for (let i = 0; i < frameBytes.length; i += 1) {
        if (!messages[i] || messages[i].binary !== frameBytes[i].binary
            || messages[i].base64 !== frameBytes[i].base64) {
          throw new Error(`wire/message mismatch at ${i}`);
        }
      }
    };
    const captureWire = chunk => {
      if (wireError) return;
      wirePending = Buffer.concat([wirePending, chunk]);
      if (headersPending) {
        const end = wirePending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const status = wirePending.subarray(0, end).toString('latin1').split('\r\n')[0];
        if (!/^HTTP\/1\.1 101\b/.test(status)) { wireError = `unexpected upgrade status: ${status}`; return; }
        wirePending = wirePending.subarray(end + 4);
        headersPending = false;
      }
      while (wirePending.length >= 2) {
        const marker = wirePending[1] & 0x7f;
        let header = 2;
        let length = marker;
        if (marker === 126) {
          if (wirePending.length < 4) return;
          length = wirePending.readUInt16BE(2); header = 4;
        } else if (marker === 127) {
          if (wirePending.length < 10) return;
          const wideLength = wirePending.readBigUInt64BE(2);
          if (wideLength > BigInt(64 * 1024 * 1024)) { wireError = 'wire frame too large'; return; }
          length = Number(wideLength); header = 10;
        }
        if (wirePending[1] & 0x80) { wireError = 'server sent a masked frame'; return; }
        if (wirePending.length < header + length) return;
        wireFrames.push({ opcode: wirePending[0] & 0x0f,
          base64: wirePending.subarray(0, header + length).toString('base64') });
        wirePending = wirePending.subarray(header + length);
      }
    };
    const ws = new WebSocket(url, {
      maxPayload: 64 * 1024 * 1024,
      perMessageDeflate: false,
      createConnection(options) {
        const socket = net.connect({ host: options.host, port: options.port });
        socket.on('data', captureWire);
        return socket;
      },
    });
    const waiters = [];
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error(`WebSocket timed out: ${url}`));
    }, 15000);
    ws.on('message', (data, isBinary) => {
      frameBytes.push({ binary: isBinary, base64: Buffer.from(data).toString('base64') });
      try { frames.push(JSON.parse(String(data))); } catch (_) { frames.push({ raw: String(data) }); }
      for (const wake of waiters.splice(0)) wake();
    });
    ws.once('open', () => {
      clearTimeout(timer);
      resolve({
        ws, frames, frameBytes, wireFrames,
        checkWire,
        send(frame) { ws.send(JSON.stringify(frame)); },
        async until(predicate, label = 'frame', ms = 30000) {
          const started = Date.now();
          while (!predicate(frames)) {
            if (Date.now() - started > ms) throw new Error(`${label} timeout`);
            await new Promise(done => {
              const fallback = setTimeout(done, 50);
              waiters.push(() => { clearTimeout(fallback); done(); });
            });
          }
          return frames;
        },
      });
    });
    ws.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

const deltaText = frame => (frame?.type === 'stream_event'
  ? (frame.event?.delta?.text || '') : '');
const outputFrames = new Set(['assistant', 'stream_event', 'text', 'result']);
const hasText = (frames, needle) => frames.some(frame =>
  outputFrames.has(frame?.type) && JSON.stringify(frame).includes(needle));

(async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-replay-capture-')));
  const dataDir = assertTestDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const gitConfig = path.join(home, '.gitconfig');
  const identity = require('../../../tests/helpers/git-test-identity');
  for (const field of ['name', 'email']) {
    execFileSync('git', ['config', '--file', gitConfig, `user.${field}`, identity[field]]);
  }
  const projectA = path.join(root, 'project-a');
  fs.mkdirSync(projectA, { recursive: true });
  const invocationLog = path.join(root, 'cli.log');
  const fakeCli = path.join(root, 'fake-claude.js');

  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const log = ${JSON.stringify(invocationLog)};
const record = event => fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid }) + '\\n');
if (args.includes('--version')) { process.stdout.write('fake-claude 9.9.9\\n'); process.exitCode = 0; }
else {
const sessionAt = args.indexOf('--session-id');
const sessionId = sessionAt >= 0 ? args[sessionAt + 1] : 'fake-capture-session';
// Per-launch tag: the crash-recovery scenario must be able to tell a replayed
// pre-crash frame apart from a post-relaunch auto-retry of the same prompt.
const inst = process.env.CAPTURE_INSTANCE || 'x';
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
  : Array.isArray(content) ? content.map(b => b.text || b.content || '').join('') : '';
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch (_) { return; }
  if (message?.type === 'control_request') {
    if (message.request?.subtype === 'initialize') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    }
    return;
  }
  const text = textOf(message?.message?.content ?? message?.content);
  const marker = (text.match(/(?:HOLD|BURST|DONE|HANG|CRASH|RETRY|BACKGROUND)_[A-Z0-9_]+/g) || []).pop();
  if (!marker) return;
  record('prompt:' + marker);
  if (marker.startsWith('HOLD')) {
    delta('hold:one'); delta('hold:two'); delta('hold:three');
    setInterval(() => {}, 1000);
  } else if (marker.startsWith('BURST')) {
    for (let i = 0; i < ${BURST}; i += 1) delta('burst:' + i);
    setInterval(() => {}, 1000);
  } else if (marker.startsWith('RETRY')) {
    if (!fs.readFileSync(log, 'utf8').includes('retry-initial')) {
      record('retry-initial'); process.exit(1);
    }
    record('retry-second'); delta('retry:live'); setInterval(() => {}, 1000);
  } else if (marker.startsWith('BACKGROUND')) {
    emit({ type: 'system', subtype: 'task_started', task_id: 'capture_bg',
      description: 'capture background task', session_id: sessionId });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'background:ack' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'background:ack',
      num_turns: 1, session_id: sessionId });
    setTimeout(() => emit({ type: 'system', subtype: 'task_notification', task_id: 'capture_bg',
      status: 'completed', summary: 'capture background done', session_id: sessionId }), 300);
    setInterval(() => {}, 1000);
  } else if (marker.startsWith('CRASH')) {
    delta('crash:' + inst + ':one'); delta('crash:' + inst + ':two');
    setInterval(() => {}, 1000);
  } else if (marker.startsWith('HANG')) {
    delta('hang:partial');
    setInterval(() => {}, 1000);
  } else {
    delta('done:partial');
    finish('done:final');
  }
});
}
`);
  fs.chmodSync(fakeCli, 0o755);

  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', type: 'message', role: 'assistant', content: [] }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  const port = await freePort();
  let base = `http://127.0.0.1:${port}`;
  const addon = process.env.MULTICC_RUST_ADDON
    || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.join(ROOT, 'native', 'prebuilt'),
      `${process.platform}-${process.arch}`, 'multicc_core.node');
  const gateway = path.join(path.dirname(addon),
    process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  const outputs = [];
  const children = [];
  let instance = 0;
  function spawnServer(listenPort) {
    instance += 1;
    let output = '';
    const child = spawn(gateway, ['serve', '--cwd', ROOT, '--node', process.execPath, 'server.js'], {
      cwd: ROOT,
      env: {
        ...isolatedHostEnv(),
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(listenPort),
        ACCESS_TOKEN: TOKEN,
        CAPTURE_INSTANCE: `i${instance}`,
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
    child.stdout.on('data', c => { output = (output + c).slice(-30000); });
    child.stderr.on('data', c => { output = (output + c).slice(-30000); });
    children.push(child);
    outputs.push(() => output);
    return child;
  }
  // The Node child holds the orchestration SQLite owner lease; the crash
  // scenario must wait for its actual exit, not just the gateway's death.
  const nodeChildPid = gatewayPid => {
    try {
      return execFileSync('pgrep', ['-P', String(gatewayPid), 'node'], { encoding: 'utf8' })
        .split('\n').map(s => s.trim()).filter(Boolean)[0] || null;
    } catch (_) { return null; }
  };
  const descendants = pid => {
    let children;
    try {
      children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
        .split('\n').map(s => s.trim()).filter(Boolean);
    } catch (_) { return []; }
    return children.flatMap(childPid => [childPid, ...descendants(childPid)]);
  };
  const waitForExit = pid => new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const check = () => {
      if (!pid) return resolve();
      try { process.kill(Number(pid), 0); } catch (_) { return resolve(); }
      if (Date.now() > deadline) return reject(new Error(`isolated Node child ${pid} did not exit`));
      setTimeout(check, 100);
    };
    check();
  });
  let child = spawnServer(port);

  const sockets = [];
  const orphanedNodes = new Set();
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
  const sendUser = (socket, text) => socket.send({
    type: 'user_message', text, taskShell: true, clientMsgId: randomUUID(),
  });
  const liveSnapshot = socket => {
    socket.checkWire();
    return { liveFrameBytes: socket.frameBytes.slice(), liveWireFrames: socket.wireFrames.slice() };
  };

  const scenarios = [];
  try {
    await waitReady(base);
    const dir = await apiOk('POST', '/api/directories', {
      name: 'Replay capture', path: projectA, create: true,
    });
    const provider = await apiOk('POST', '/api/providers', {
      appType: 'claude', name: 'Capture route',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/fixture`,
      authToken: 'capture-provider-secret', model: 'claude-sonnet-4-5',
    });

    // Each scenario gets its own session so a previous turn's buffer cannot
    // leak into the next observation.
    const wsUrl = id => `ws://127.0.0.1:${new URL(base).port}/ws/chat?session=${encodeURIComponent(id)}&token=${TOKEN}`;
    async function session(label) {
      const created = await apiOk('POST', `/api/directories/${dir.id}/sessions`, {
        cli: 'claude', kind: 'chat', label, provider: provider.id,
      });
      return created.id || created.sessionId;
    }

    // Reconnect and record exactly what the fresh socket is handed.
    async function observe(wsUrl, settle) {
      const next = await connect(wsUrl);
      sockets.push(next.ws);
      await next.until(f => f.length > 0, 'reconnect frame');
      await settle(next);
      const replayed = next.frames.filter(f => f.type === 'stream_event').map(deltaText);
      const kinds = [];
      for (const frame of next.frames) {
        const kind = frame?.type || 'unknown';
        if (kinds[kinds.length - 1]?.type !== kind) kinds.push({ type: kind, count: 1 });
        else kinds[kinds.length - 1].count += 1;
      }
      try { next.ws.close(); } catch (_) {}
      next.checkWire();
      return { replayed, kinds, frameBytes: next.frameBytes.slice(), wireFrames: next.wireFrames.slice() };
    }

    // 1. replay: a live turn's buffered deltas reach a reconnecting client.
    {
      const id = await session('replay');
      const first = await connect(wsUrl(id));
      sockets.push(first.ws);
      await first.until(f => f.length > 0, 'initial frame');
      sendUser(first, 'HOLD_ONE');
      await first.until(f => hasText(f, 'hold:three'), 'all three deltas');
      first.ws.close();
      const seen = await observe(wsUrl(id), s => s.until(f => hasText(f, 'hold:three'), 'replayed deltas'));
      scenarios.push({ name: 'replay', ...liveSnapshot(first), ...seen });
    }

    // 2. eviction: more frames than the cap; the oldest must be gone.
    {
      const id = await session('eviction');
      const first = await connect(wsUrl(id));
      sockets.push(first.ws);
      await first.until(f => f.length > 0, 'initial frame');
      sendUser(first, 'BURST_ONE');
      await first.until(f => hasText(f, `burst:${BURST - 1}`), 'burst tail');
      first.ws.close();
      const seen = await observe(wsUrl(id), s => s.until(f => hasText(f, `burst:${BURST - 1}`), 'replayed tail'));
      scenarios.push({ name: 'eviction', emitted: BURST, ...liveSnapshot(first), ...seen });
    }

    // 3. turn boundary: a finished turn, then a live one. The finished turn's
    //    frames must not reappear alongside the new turn's.
    {
      const id = await session('turn-boundary');
      const first = await connect(wsUrl(id));
      sockets.push(first.ws);
      await first.until(f => f.length > 0, 'initial frame');
      sendUser(first, 'DONE_ONE');
      await first.until(f => hasText(f, 'done:final'), 'first turn result');
      sendUser(first, 'HOLD_TWO');
      await first.until(f => hasText(f, 'hold:three'), 'second turn deltas');
      first.ws.close();
      const seen = await observe(wsUrl(id), s => s.until(f => hasText(f, 'hold:three'), 'replayed second turn'));
      scenarios.push({ name: 'turn-boundary', ...liveSnapshot(first), ...seen });
    }

    // 4. cancel: stop a streaming turn, then look with a fresh socket.
    {
      const id = await session('cancel');
      const first = await connect(wsUrl(id));
      sockets.push(first.ws);
      await first.until(f => f.length > 0, 'initial frame');
      sendUser(first, 'HANG_ONE');
      await first.until(f => hasText(f, 'hang:partial'), 'hang delta');
      const turnId = [...first.frames].reverse().find(frame => frame.turnId)?.turnId;
      if (!turnId) throw new Error('cancel capture: active turn id missing');
      const invocations = () => fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
        .filter(Boolean).map(line => JSON.parse(line));
      const runner = invocations().find(row => row.event === 'prompt:HANG_ONE');
      if (!runner) throw new Error('cancel capture: runner missing');
      first.send({ type: 'cancel', taskShell: true, clientMsgId: randomUUID(), turnId });
      const deadline = Date.now() + 30000;
      while (!invocations().some(row => row.event === 'sigterm' && row.pid === runner.pid)) {
        if (Date.now() >= deadline) throw new Error('cancel capture: runner was not terminated');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await first.until(frames => frames.some(frame => frame?.type === 'stream_end'
        || (frame?.type === 'result' && !frame.partial)), 'cancel terminal frame');
      first.ws.close();
      const seen = await observe(wsUrl(id), () => new Promise(r => setTimeout(r, 1500)));
      scenarios.push({ name: 'cancel', ...liveSnapshot(first), ...seen });
    }

    // 5. The Claude stream failure is retried by the API retry path; reconnect
    // during the second invocation. It is not the fresh-retry path.
    {
      const id = await session('retry');
      const first = await connect(wsUrl(id));
      sockets.push(first.ws);
      await first.until(f => f.length > 0, 'initial frame');
      sendUser(first, 'RETRY_ONE');
      await first.until(f => hasText(f, 'retry:live'), 'API retry delta');
      if (!first.frames.some(frame => frame.type === 'system' && frame.subtype === 'warning'
          && typeof frame.message === 'string' && frame.message.includes('受控重试'))) {
        throw new Error('retry capture: API retry notice was not observed');
      }
      if (!fs.readFileSync(invocationLog, 'utf8').includes('retry-second')) {
        throw new Error('retry capture: second invocation was not observed');
      }
      first.ws.close();
      const seen = await observe(wsUrl(id), s => s.until(f => hasText(f, 'retry:live'), 'retry replay'));
      scenarios.push({ name: 'retry', ...liveSnapshot(first), ...seen });
    }

    // 6. A background task completes after the turn result.
    {
      const id = await session('background');
      const first = await connect(wsUrl(id));
      sockets.push(first.ws);
      await first.until(f => f.length > 0, 'initial frame');
      sendUser(first, 'BACKGROUND_ONE');
      await first.until(f => f.some(frame => frame.type === 'monitor_started' && frame.task_id === 'capture_bg'), 'background started');
      await first.until(f => f.some(frame => frame.type === 'monitor_done' && frame.task_id === 'capture_bg'), 'background completion');
      first.ws.close();
      const seen = await observe(wsUrl(id), () => new Promise(r => setTimeout(r, 1000)));
      scenarios.push({ name: 'background', ...liveSnapshot(first), ...seen });
    }

    // 7. crash-recovery: kill the whole server mid-turn (SIGKILL, no graceful
    //    shutdown), relaunch on the SAME data dir, reconnect. The buffer is
    //    per-process state: the fresh server has nothing to burst, only the
    //    persisted history.
    {
      const id = await session('crash-recovery');
      const first = await connect(wsUrl(id));
      sockets.push(first.ws);
      await first.until(f => f.length > 0, 'initial frame');
      sendUser(first, 'CRASH_ONE');
      await first.until(f => hasText(f, 'crash:i1:two'), 'deltas before the kill');
      first.ws.close();
      const doomedNodePid = nodeChildPid(child.pid);
      if (!doomedNodePid) throw new Error('crash capture: Node child not found');
      // Crash the entire isolated backend, not just its supervising gateway.
      // Otherwise the orphaned Node process keeps the live turn and owner lease.
      const doomedChildren = descendants(doomedNodePid);
      orphanedNodes.add(doomedNodePid);
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
      try { process.kill(Number(doomedNodePid), 'SIGKILL'); } catch (_) {}
      for (const pid of doomedChildren) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
      }
      await waitForExit(doomedNodePid);
      orphanedNodes.delete(doomedNodePid);
      const relaunchPort = await freePort();
      child = spawnServer(relaunchPort);
      base = `http://127.0.0.1:${relaunchPort}`;
      // The restarted owner may need to recover the previous lease.
      await waitReady(base, 60000);
      // Long enough for any dead-runner auto-retry to fire: a retry would emit
      // i2-tagged deltas, which must not be confused with the pre-crash buffer.
      const seen = await observe(wsUrl(id), () => new Promise(r => setTimeout(r, 3000)));
      scenarios.push({ name: 'crash-recovery', ...liveSnapshot(first), ...seen });
    }

    fs.writeFileSync(OUT, `${JSON.stringify({
      capturedAt: new Date().toISOString().slice(0, 10),
      cap: 500,
      note: 'Captured from a real gateway + Node server + fake Claude CLI. '
        + 'liveFrameBytes[] records the original connection; replayed[] and frameBytes[] '
        + 'are what a reconnecting /ws/chat client received. '
        + 'wireFrames and liveWireFrames contain complete server-to-client frames including headers; '
        + 'frameBytes contains decoded messages. Compression is disabled for capture.',
      scenarios,
    }, null, 2)}\n`);
    for (const s of scenarios) {
      console.log(`${s.name}: ${s.replayed.length} replayed stream_event frames`
        + (s.emitted ? ` (emitted ${s.emitted})` : ''));
    }
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  } catch (error) {
    console.error('capture failed:', error.message);
    console.error(outputs.map(read => read().slice(-2000)).join('\n--- relaunch boundary ---\n'));
    process.exitCode = 1;
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch (_) {} }
    for (const proc of children) {
      try { proc.kill('SIGTERM'); } catch (_) {}
    }
    for (const pid of orphanedNodes) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {}
    }
    await new Promise(resolve => setTimeout(resolve, 600));
    for (const proc of children) {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
    upstream.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
