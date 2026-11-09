'use strict';

// Real gateway + real server + fake codex/opencode CLI binaries, isolated data
// root. Proves the adapter-neutral event reducer runs end-to-end through the
// same ports as production: decodeEvent parses the CLI's JSONL, the native
// reducer mutates the live session, and the WS room sees the claude-shaped
// assistant/tool frames. Codex uses `codex exec --json`; the opencode lane uses
// the legacy `run --format json` shape (MULTICC_OPENCODE_LEGACY_JSON=1), which
// is the shared opencode-like decoder family. Never touches ~/.multicc, the main
// checkout's data directory or the live service.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'isolated-chat-adapter-token';

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
      if ((await fetch(`${base}/readyz`)).status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated adapter server did not become ready');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error(`WebSocket timed out: ${url}`));
    }, 10000);
    ws.on('message', data => {
      try { frames.push(JSON.parse(String(data))); } catch (_) { frames.push({ raw: String(data) }); }
    });
    ws.once('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        frames,
        send(frame) { ws.send(JSON.stringify(frame)); },
        async until(predicate, label = 'frame', ms = 20000) {
          const started = Date.now();
          while (!predicate(frames)) {
            if (Date.now() - started > ms) {
              throw new Error(`${label} timeout: ${JSON.stringify(frames).slice(-2000)}`);
            }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        },
      });
    });
    ws.once('error', reject);
  });
}

const frameText = frame => {
  const content = frame?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => block?.text || block?.content || '').join('');
  return '';
};
const OUTPUT_FRAMES = new Set(['assistant', 'stream_event', 'text', 'result', 'user']);
const hasText = (frames, needle) => frames.some(frame =>
  OUTPUT_FRAMES.has(frame?.type) && (frameText(frame).includes(needle) || JSON.stringify(frame).includes(needle)));

async function main() {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-chat-adapter-')));
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

  const fakeCodex = path.join(root, 'fake-codex.js');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake-codex 0.154.0\\n'); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
emit({ type: 'thread.started', thread_id: 'thread-fake-1' });
emit({ type: 'turn.started' });
emit({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'echo hi' } });
emit({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', aggregated_output: 'hi\\n', exit_code: 0 } });
emit({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'HELLO_FROM_CODEX' } });
emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
process.stdout.write('', () => process.exit(0));
`, { mode: 0o755 });

  const fakeOpencode = path.join(root, 'fake-opencode.js');
  fs.writeFileSync(fakeOpencode, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake-opencode 1.0.0\\n'); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
emit({ sessionID: 'ses-open-1', type: 'step_start' });
emit({ sessionID: 'ses-open-1', type: 'text', part: { text: 'HELLO_FROM_OPENCODE' } });
emit({ sessionID: 'ses-open-1', type: 'tool_use', part: { id: 't1', tool: 'bash',
  state: { input: { command: 'pwd' }, status: 'running' } } });
emit({ sessionID: 'ses-open-1', type: 'tool_use', part: { id: 't1', tool: 'bash',
  state: { status: 'completed', output: '/tmp' } } });
emit({ sessionID: 'ses-open-1', type: 'step_finish', part: { reason: 'stop', cost: 0,
  tokens: { input: 3, output: 2 } } });
process.stdout.write('', () => process.exit(0));
`, { mode: 0o755 });

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
      ...process.env,
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
      CLAUDE_CMD: path.join(root, 'missing-claude'),
      CODEX_CMD: fakeCodex,
      OPENCODE_CMD: fakeOpencode,
      MULTICC_OPENCODE_LEGACY_JSON: '1',
      QODER_CMD: path.join(root, 'missing-qoder'),
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
  async function waitIdle(sessionId) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const body = await (await fetch(`${base}/api/sessions/${sessionId}/liveness`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })).json();
      if (body && body.state !== 'working') return body;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`session ${sessionId} never became idle`);
  }

  try {
    await waitReady(base);
    const dir = await apiOk('POST', '/api/directories', { name: 'Adapter lanes', path: project, create: true });

    for (const lane of [
      { cli: 'codex', welcome: 'HELLO_FROM_CODEX', toolText: 'hi' },
      { cli: 'opencode', welcome: 'HELLO_FROM_OPENCODE', toolText: '/tmp' },
    ]) {
      const created = await apiOk('POST', `/api/directories/${dir.id}/sessions`, {
        cli: lane.cli, kind: 'chat', label: `adapter-${lane.cli}`,
      });
      const sessionId = created.id || created.sessionId;
      assert.ok(sessionId, `${lane.cli} session created: ${JSON.stringify(created)}`);

      const socket = await connect(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionId)}&token=${TOKEN}`);
      sockets.push(socket.ws);
      await socket.until(frames => frames.length > 0, `${lane.cli} initial frame`);
      socket.send({ type: 'user_message', text: `PING_${lane.cli.toUpperCase()}`, taskShell: true, clientMsgId: randomUUID() });

      await socket.until(frames => hasText(frames, lane.welcome), `${lane.cli} assistant text`);
      await socket.until(frames => hasText(frames, lane.toolText), `${lane.cli} tool result`);
      await socket.until(frames => frames.some(frame =>
        frame?.type === 'assistant' && JSON.stringify(frame).includes('tool_use')), `${lane.cli} tool card`);
      await waitIdle(sessionId);
      socket.ws.close();
    }
    console.log('test-chat-adapter-events-isolated ok');
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch (_) {}
    }
    try { child.kill('SIGTERM'); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 300));
    if (output.includes('UnhandledPromiseRejection')) {
      console.error(output);
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
