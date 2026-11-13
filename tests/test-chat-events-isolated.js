'use strict';

// Real gateway + real server + fake Claude CLI (tests/helpers/fake-claude-lane.js),
// isolated data root. The native reducer (chat_apply_claude_event) is what
// mutates the live chat session; this proves the port wiring end-to-end:
// stream → result, tool_use → tool_result normalization, background task
// events, API-error dedupe/append-vs-suppress, an interrupted result with no
// `result` key, and reconnect replay. Never touches ~/.multicc, the main
// checkout's data directory or the live service.

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
const TOKEN = 'isolated-chat-events-token';
const FAKE = path.join(__dirname, 'helpers', 'fake-claude-lane.js');

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
  throw new Error('isolated chat-events server did not become ready');
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
              throw new Error(`${label} timeout: ${JSON.stringify(frames).slice(-3000)}`);
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

const OUTPUT_FRAMES = new Set(['assistant', 'stream_event', 'text', 'result']);
const frameText = frame => {
  if (frame?.type === 'stream_event') return frame.event?.delta?.text || '';
  const content = frame?.message?.content ?? frame?.content ?? frame?.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => block.text || '').join('');
  return '';
};
const hasText = (frames, needle) => frames.some(frame =>
  OUTPUT_FRAMES.has(frame?.type) && (frameText(frame).includes(needle) || JSON.stringify(frame).includes(needle)));
// Frames from the first one carrying this turn's prompt marker onward. The
// previous turn's trailing bookkeeping (notify/stream_end/session_queue) can
// still be in flight, so a length snapshot taken before send is not a safe cut.
// The committed user message carries the turnId; every provider frame for that
// turn is tagged with it, which keeps a previous turn's late retry frames out.
const messageTurnId = (frames, marker) => frames
  .filter(frame => frame?.type === 'chat_msg_meta' && frame.message
    && typeof frame.message.content === 'string' && frame.message.content.includes(marker))
  .map(frame => frame.message.turnId)
  .find(Boolean) || null;
// Correlate completion with this prompt's admitted FIFO entry. Earlier turns'
// results, stream_end frames and delayed scheduler events cannot satisfy it.
const turnSettled = (frames, marker, admissionFrames = frames) => {
  const entry = admissionFrames.find(frame => frame?.type === 'session_queue'
    && frame.event === 'queued' && frame.message?.includes(marker));
  return !!entry?.entryId && frames.some(frame => frame?.type === 'session_queue'
    && frame.event === 'completed' && frame.entryId === entry.entryId);
};
// Keep the queue correlation visible when a tool turn times out. The ordinary
// timeout contains only the end of a potentially long frame list, which can
// omit both the admission and the result. Never include prompt or tool output.
const turnCompletionEvidence = (frames, marker) => {
  const admitted = frames.filter(frame => frame?.type === 'session_queue'
    && frame.event === 'queued' && frame.message?.includes(marker));
  const entryIds = new Set(admitted.map(frame => frame.entryId).filter(Boolean));
  const turnId = messageTurnId(frames, marker);
  return {
    admissions: admitted.length,
    turnId,
    queue: frames.filter(frame => frame?.type === 'session_queue' && entryIds.has(frame.entryId))
      .map(frame => ({ event: frame.event, entryId: frame.entryId, state: frame.state,
        reason: frame.reason, classifyState: frame.classifyState })).slice(-40),
    output: frames.filter(frame => frame?.turnId === turnId && turnId
      && ['assistant', 'result', 'stream_end', 'api_error'].includes(frame.type))
      .map(frame => ({ type: frame.type, subtype: frame.subtype, is_error: frame.is_error,
        reasonCode: frame.reasonCode, routeAttemptId: frame.routeAttemptId })).slice(-40),
  };
};

(async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-chat-events-')));
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
  fs.copyFileSync(FAKE, fakeCli);
  fs.chmodSync(fakeCli, 0o755);
  const fakeLog = path.join(root, 'fake.jsonl');

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
      FAKE_CLAUDE_LOG: fakeLog,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  function sendUser(socket, text) {
    socket.send({ type: 'user_message', text, taskShell: true, clientMsgId: randomUUID() });
  }
  async function history(sessionId) {
    const page = await apiOk('GET', `/api/sessions/${sessionId}/history?limit=100`);
    return JSON.stringify(page.messages || []);
  }

  try {
    await waitReady(base);
    const dir = await apiOk('POST', '/api/directories', {
      name: 'Chat events', path: project, create: true,
    });
    const created = await apiOk('POST', `/api/directories/${dir.id}/sessions`, {
      cli: 'claude', kind: 'chat', label: 'events',
    });
    const session = created.id || created.sessionId;
    assert.ok(session, `session created: ${JSON.stringify(created)}`);
    const wsUrl = `ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(session)}&token=${TOKEN}`;
    const socket = await connect(wsUrl);
    sockets.push(socket.ws);
    await waitUntil(() => socket.frames.length > 0, 'no initial chat frame');

    // ── 1. stream → result over the real lane ──
    sendUser(socket, 'PING_BASIC_ONE');
    await socket.until(frames => hasText(frames, 'echo:PING_BASIC_ONE'), 'basic echo');
    await socket.until(frames => turnSettled(frames, 'PING_BASIC_ONE'), 'basic completion');
    assert.match(await history(session), /echo:PING_BASIC_ONE/, 'basic reply persisted');

    // ── 2. tool_use → tool_result → text → result ──
    const beforeTool = socket.frames.length;
    sendUser(socket, 'EVT_TOOL_USE_ONE');
    await socket.until(frames => frames.slice(beforeTool).some(frame =>
      frame?.type === 'assistant'
      && JSON.stringify(frame).includes('toolu_evt_1')), 'assistant tool_use frame');
    const toolFrames = socket.frames.slice(beforeTool);
    assert.ok(toolFrames.some(frame => frame?.type === 'assistant'
      && Array.isArray(frame.message?.content)
      && frame.message.content.some(block => block.type === 'tool_use' && block.name === 'Edit')),
    'assistant snapshot must carry the tool_use block');
    // The user tool_result frame is normalized to the block form.
    await socket.until(frames => frames.slice(beforeTool).some(frame =>
      frame?.type === 'user'
      && Array.isArray(frame.message?.content)
      && frame.message.content.some(block => block.type === 'tool_result'
        && JSON.stringify(block.content).includes('patched'))), 'normalized tool_result frame');
    await socket.until(frames => hasText(frames.slice(beforeTool), 'TOOL_DONE'), 'tool turn text');
    try {
      await socket.until(frames => turnSettled(frames, 'EVT_TOOL_USE_ONE'), 'tool turn completion');
    } catch (error) {
      console.error('TOOL TURN COMPLETION EVIDENCE:',
        JSON.stringify(turnCompletionEvidence(socket.frames, 'EVT_TOOL_USE_ONE')));
      throw error;
    }
    const toolHistory = await history(session);
    assert.match(toolHistory, /TOOL_DONE/, 'tool turn text persisted');
    assert.match(toolHistory, /toolu_evt_1/, 'tool call persisted with the assistant message');

    // ── 3. background task events outlive the turn ──
    sendUser(socket, 'EVT_BG_TASK_ONE');
    await socket.until(frames => frames.some(frame =>
      frame?.type === 'monitor_started' && frame?.task_id === 'bg_evt_1'),
    'background task_started surfaced');
    await socket.until(frames => hasText(frames, 'BG_ACK'), 'background turn text');
    await socket.until(frames => turnSettled(frames, 'EVT_BG_TASK_ONE'), 'background turn completion');
    await socket.until(frames => frames.some(frame =>
      frame?.type === 'monitor_done' && frame?.task_id === 'bg_evt_1'),
    'post-result task_notification surfaced after the turn');

    // ── 4. API error message: append once (dedupe) when there was no output ──
    sendUser(socket, 'EVT_API_ERROR_EMPTY_ONE SUCCESS_RESULT');
    await socket.until(frames => hasText(frames, 'upstream exploded'), 'api error surfaced');
    await socket.until(frames => turnSettled(frames, 'EVT_API_ERROR_EMPTY_ONE'), 'api error completion');
    const errorFrames = socket.frames
      .filter(frame => frame?.type === 'assistant' && frame.turnId === messageTurnId(socket.frames,
        'EVT_API_ERROR_EMPTY_ONE') && JSON.stringify(frame).includes('upstream exploded'));
    // The resident fake CLI reuses its UUID across provider retries. Each
    // attempt emits two copies, and must forward exactly one of that pair.
    const perAttemptUuid = new Map();
    for (const frame of errorFrames) {
      assert.ok(frame.routeAttemptId, 'the error must retain its provider attempt identity');
      assert.ok(frame.uuid, 'the fixture error must retain its message identity');
      const key = `${frame.routeAttemptId}:${frame.uuid}`;
      perAttemptUuid.set(key, (perAttemptUuid.get(key) || 0) + 1);
    }
    const sentAttempts = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(row => row.type === 'user' && row.message?.content?.some(block =>
        block.type === 'text' && block.text.includes('EVT_API_ERROR_EMPTY_ONE')));
    assert.ok(sentAttempts.length >= 1, 'the fake CLI must receive the error-only prompt');
    assert.equal(perAttemptUuid.size, sentAttempts.length, 'every actual attempt must forward its error once');
    for (const [key, count] of perAttemptUuid) {
      assert.equal(count, 1, `the repeated synthetic error ${key} must be forwarded once, got ${count}`);
    }

    // ── 5. API error message: suppress when the turn already has output ──
    sendUser(socket, 'EVT_API_ERROR_AFTER_OUTPUT_ONE SUCCESS_RESULT');
    await socket.until(frames => hasText(frames, 'genuine answer'), 'pre-error answer surfaced');
    await socket.until(frames => turnSettled(frames, 'EVT_API_ERROR_AFTER_OUTPUT_ONE'), 'suppressed api error completion');
    const suppressTurnId = messageTurnId(socket.frames, 'EVT_API_ERROR_AFTER_OUTPUT_ONE');
    assert.ok(suppressTurnId, 'the committed user message must carry its turnId');
    const suppressFrames = socket.frames.filter(frame => frame?.turnId === suppressTurnId);
    const firstResultAt = suppressFrames.findIndex(frame => frame?.type === 'result');
    const firstAttempt = firstResultAt < 0 ? suppressFrames : suppressFrames.slice(0, firstResultAt + 1);
    const suppressedAssistant = firstAttempt.filter(frame =>
      frame?.type === 'assistant' && JSON.stringify(frame).includes('upstream exploded'));
    assert.equal(suppressedAssistant.length, 0,
      'an API error after real output must not be appended to the assistant text: '
      + suppressedAssistant.map(frame => JSON.stringify(frame).slice(0, 400)).join(' || '));

    // ── 6. interrupted turn: error result without a `result` key ──
    sendUser(socket, 'EVT_ABORTED_ONE');
    await socket.until(frames => hasText(frames, 'partial-before-abort'),
      'aborted partial surfaced');
    await socket.until(frames => turnSettled(frames, 'EVT_ABORTED_ONE'), 'aborted turn completion');
    assert.ok(!(await history(session)).includes('undefined'),
      'an aborted result must not persist a literal undefined');
    // The session stays usable for the next turn.
    sendUser(socket, 'PING_AFTER_ABORT');
    await socket.until(frames => hasText(frames, 'echo:PING_AFTER_ABORT'),
      'post-abort turn');
    await socket.until(frames => turnSettled(frames, 'PING_AFTER_ABORT'), 'post-abort completion');

    // ── 7. reconnect replay of an in-flight delta ──
    sendUser(socket, 'EVT_REPLAY_ONE');
    await socket.until(frames => hasText(frames, 'replay-partial'), 'slow partial');
    socket.ws.close();
    const replay = await connect(wsUrl);
    sockets.push(replay.ws);
    await replay.until(frames => hasText(frames, 'replay-partial'),
      'reconnect replay of the in-flight delta');
    await replay.until(frames => hasText(frames, 'replay-done'), 'replay turn result');
    await replay.until(frames => turnSettled(frames, 'EVT_REPLAY_ONE', socket.frames), 'replay turn completion');

    console.log('isolated chat-events reducer wiring check passed');
  } catch (error) {
    console.error(output);
    console.error('FAKE LOG TAIL:', fs.existsSync(fakeLog)
      ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').slice(-20).map(line => {
        try {
          const record = JSON.parse(line);
          delete record.env;
          return JSON.stringify(record);
        } catch (_) { return '[invalid fixture record omitted]'; }
      }).join('\n') : '(none)');
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
