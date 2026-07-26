'use strict';

// Isolated process-level proof for Qoder CN print-mode chat and native resume.
// The fake binary emits the same stream-json envelope as qoderclicn, so no
// Qoder account, network call, or user configuration is involved.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'qoder-chat-test';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-qoder-chat-'));
const dataRoot = assertTestDir(path.join(tmpRoot, 'data'));
const project = path.join(tmpRoot, 'project');
const fakeQoder = path.join(tmpRoot, 'qoderclicn');
const argsFile = path.join(tmpRoot, 'qoder-args.jsonl');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(fakeQoder, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args) + '\\n');
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : 'native-qoder-1';
const text = resumeAt >= 0 ? 'QODER-RESUME-OK' : 'QODER-FIRST-OK';
const splitAt = Math.max(1, Math.floor(text.length / 2));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'performance', session_id: sessionId }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: text.slice(0, splitAt) }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: text.slice(splitAt) }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', result: text, total_cost_usd: 0, usage: {} }) + '\\n');
`);
fs.chmodSync(fakeQoder, 0o755);

let server;
let dirId;
let sessionId;
let stdout = '';
let stderr = '';

async function api(method, route, body) {
  const response = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) { data = raw; }
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${raw}`);
  return data;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { await api('GET', '/api/server-info'); return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated Qoder server did not start');
}

function runTurn(text, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?session=${sessionId}&token=${TOKEN}`);
    let assistant = '';
    let assistantEvents = 0;
    let snapshotEvents = 0;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (error) reject(error);
      else resolve({ assistant, assistantEvents, snapshotEvents });
    };
    const timer = setTimeout(() => finish(new Error('Qoder turn timed out')), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'user_message', text })));
    ws.on('message', raw => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch (_) { return; }
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        assistantEvents += 1;
        if (event.message.textSnapshot === true) snapshotEvents += 1;
        for (const block of event.message.content) {
          if (block.type !== 'text') continue;
          if (event.message.textSnapshot === true) assistant = block.text || '';
          else assistant += block.text || '';
        }
      }
      if (event.type === 'error') finish(new Error(event.error || event.message || 'Qoder turn failed'));
      if (event.type === 'stream_end') setTimeout(() => finish(), 30);
    });
    ws.on('error', finish);
  });
}

async function stopServer() {
  if (!server) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  try { server.kill('SIGTERM'); } catch (_) {}
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
  if (server.exitCode === null) try { server.kill('SIGKILL'); } catch (_) {}
  server = null;
}

async function cleanup() {
  try { if (dirId) await api('DELETE', `/api/directories/${dirId}?force=1`); } catch (_) {}
  await stopServer();
  assertTestDir(tmpRoot);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), ACCESS_TOKEN: TOKEN, MULTICC_DATA_DIR: dataRoot,
      QODER_CMD: fakeQoder,
      CLAUDE_CMD: '/usr/bin/true', CODEX_CMD: '/usr/bin/true',
      OPENCODE_CMD: '/usr/bin/true', ZCODE_CMD: '/usr/bin/true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-8000); });
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  await waitForServer();

  const directory = await api('POST', '/api/directories', {
    name: 'Qoder Chat', path: project, create: true,
  });
  dirId = directory.id;
  const session = await api('POST', `/api/directories/${dirId}/sessions`, {
    cli: 'qoder', kind: 'chat', model: 'performance', effort: 'xhigh', agent: 'reviewer',
  });
  sessionId = session.id;

  const first = await runTurn('first Qoder turn');
  if (first.assistant !== 'QODER-FIRST-OK') {
    throw new Error(`missing first reply: ${first.assistant}`);
  }
  if (first.assistantEvents !== 2 || first.snapshotEvents !== 2) {
    throw new Error(`Qoder reply was not reconciled as two live snapshots: ${JSON.stringify(first)}`);
  }
  const sessionDocument = JSON.parse(fs.readFileSync(path.join(dataRoot, 'sessions.json'), 'utf8'));
  const records = Array.isArray(sessionDocument) ? sessionDocument : sessionDocument.data;
  const persisted = records.find(item => item.id === sessionId);
  if (persisted?.cliSessionId !== 'native-qoder-1') {
    throw new Error('Qoder native session id was not captured');
  }

  const calls = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const firstArgs = calls[0];
  for (const expected of ['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions',
    '--model', 'performance', '--reasoning-effort', 'xhigh', '--agent', 'reviewer']) {
    if (!firstArgs.includes(expected)) throw new Error(`missing first-turn argument: ${expected}`);
  }

  console.log('Qoder CN multi-part live snapshots and native session capture passed');
  await cleanup();
})().catch(async error => {
  console.error(error);
  if (stdout) console.error(stdout);
  if (stderr) console.error(stderr);
  await cleanup();
  process.exitCode = 1;
});
