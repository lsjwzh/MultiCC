'use strict';

// Isolated process-level proof for Qoder CN print-mode chat and native resume.
// The fake binary emits the same stream-json envelope as qoderclicn, so no
// Qoder account, network call, or user configuration is involved.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');
const { createQoderAdapter } = require('../src/cli-adapters/qoder');

// ── qoder: structured API-error fields ───────────────────────────────────
// The CLI writes a synthetic assistant frame (isApiErrorMessage, with the HTTP
// status in displayErrorCode) and then an error result frame. The adapter must
// expose those as the fields the shared classifier reads, without inventing a
// status from Qoder's own sub-400 codes.
const qoderUnit = createQoderAdapter({ cmd: 'qoder' });
const qoderSynthetic = qoderUnit.decodeEvent({
  type: 'assistant', isApiErrorMessage: true, displayErrorCode: 429,
  error: 'rate_limit_exceeded', errorDetails: 'HTTP 429',
  message: { model: 'performance', content: [{ type: 'text', text: '[API Error: rate limited]' }] },
})[0];
if (qoderSynthetic.type !== 'claude_event' || qoderSynthetic.raw.api_error_status !== 429) {
  throw new Error(`qoder synthetic assistant status not mapped: ${JSON.stringify(qoderSynthetic)}`);
}
if (qoderSynthetic.raw.displayErrorCode !== 429 || qoderSynthetic.raw.error !== 'rate_limit_exceeded') {
  throw new Error('qoder synthetic assistant fields must survive the mapping');
}
const qoderQuotaCode = qoderUnit.decodeEvent({
  type: 'assistant', isApiErrorMessage: true, displayErrorCode: 110,
  message: { content: [{ type: 'text', text: 'daily usage limit' }] },
})[0];
if ('api_error_status' in qoderQuotaCode.raw) {
  throw new Error('qoder sub-400 display code must not become an HTTP status');
}
const qoderResult = qoderUnit.decodeEvent({
  type: 'result', subtype: 'error_during_execution', is_error: true,
  error_code: 429, errors: ['The request limit has been reached.'],
})[0];
if (qoderResult.raw.error?.http_status !== 429
  || qoderResult.raw.error?.message !== 'The request limit has been reached.') {
  throw new Error(`qoder error result fields not mapped: ${JSON.stringify(qoderResult)}`);
}
if (qoderResult.raw.error_code !== 429 || !Array.isArray(qoderResult.raw.errors)) {
  throw new Error('qoder error result fields must survive the mapping');
}
// Provider string codes are not statuses; sub-400 numeric codes are Qoder's
// own (105/110/112…) and must not be reported as HTTP statuses.
const qoderStringCode = qoderUnit.decodeEvent({
  type: 'result', subtype: 'error_during_execution', is_error: true,
  error_code: 'invalid_api_key', error_message: 'bad key',
})[0];
if (qoderStringCode.raw.error?.http_status !== undefined
  || qoderStringCode.raw.error?.message !== 'bad key') {
  throw new Error(`qoder string code mapping wrong: ${JSON.stringify(qoderStringCode)}`);
}
const qoderInternalCode = qoderUnit.decodeEvent({
  type: 'result', subtype: 'error_during_execution', is_error: true,
  error_code: 10408, errors: ['timeout'],
})[0];
if ('http_status' in qoderInternalCode.raw.error) {
  throw new Error('qoder internal numeric code must not become an HTTP status');
}
// Success results and sub-agent results are untouched.
const qoderSuccess = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
if (qoderUnit.decodeEvent(qoderSuccess)[0].raw !== qoderSuccess) {
  throw new Error('qoder success result must pass through untouched');
}
if (qoderUnit.decodeEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, parent_tool_use_id: 't1' }).length !== 0) {
  throw new Error('qoder sub-agent result must still be filtered');
}

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
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'user_message', text, taskShell: true, clientMsgId: randomUUID(),
    })));
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
  // The session store is written by the server; under load the flush can land
  // just after the turn's stream_end, so wait briefly for the file instead of
  // racing it. A missing file past the wait is a real failure, reported with
  // the data root listing and the server's own stderr.
  const sessionsFile = path.join(dataRoot, 'sessions.json');
  for (let attempt = 0; attempt < 50 && !fs.existsSync(sessionsFile); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(sessionsFile)) {
    throw new Error(`sessions.json was never written under ${dataRoot}: `
      + `${fs.readdirSync(dataRoot).join(', ')}\nserver stderr:\n${stderr}`);
  }
  const sessionDocument = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
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
