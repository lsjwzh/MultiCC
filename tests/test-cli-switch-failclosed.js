'use strict';

// Deterministic process-level proof that a restored CLI returning a different
// native session id is rejected instead of being accepted as a fresh thread.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'cli-switch-failclosed-test';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-cli-failclosed-'));
const dataRoot = assertTestDir(path.join(tmpRoot, 'data'));
const project = path.join(tmpRoot, 'project');
const fakeCli = path.join(tmpRoot, 'fake-opencode.js');
const countFile = path.join(tmpRoot, 'invocations');
const fakeClaude = path.join(tmpRoot, 'fake-claude.js');
const claudeCountFile = path.join(tmpRoot, 'claude-invocations');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(dataRoot, { recursive: true });
fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('fs');
const countFile = ${JSON.stringify(countFile)};
let count = 0;
try { count = Number(fs.readFileSync(countFile, 'utf8')) || 0; } catch (_) {}
count += 1;
fs.writeFileSync(countFile, String(count));
const mismatch = count > 1;
process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: mismatch ? 'native-wrong' : 'native-one', part: {} }) + '\\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'text', part: { text: mismatch ? 'MUST-NOT-BE-ACCEPTED' : 'FIRST-OK' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: {} } }) + '\\n');
}, mismatch ? 1000 : 20);
`);
fs.chmodSync(fakeCli, 0o755);
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require('fs');
if (!process.argv.includes('--input-format') || !process.argv.includes('stream-json')) process.exit(0);
const countFile = ${JSON.stringify(claudeCountFile)};
let count = 0;
try { count = Number(fs.readFileSync(countFile, 'utf8')) || 0; } catch (_) {}
count += 1;
fs.writeFileSync(countFile, String(count));
let sent = false;
process.stdin.on('data', () => {
  if (sent) return;
  sent = true;
  if (count > 1) process.exit(7);
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE-FIRST-OK' }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', result: 'CLAUDE-FIRST-OK', total_cost_usd: 0, usage: {} }) + '\\n');
});
`);
fs.chmodSync(fakeClaude, 0o755);

let server;
let dirId;
let sessionId;
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
  for (let i = 0; i < 60; i += 1) {
    try { await api('GET', '/api/server-info'); return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('isolated server did not start');
}

function runTurn(text, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?session=${sessionId}&token=${TOKEN}`);
    let assistant = '';
    const errors = [];
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (error) reject(error);
      else resolve({ assistant, errors });
    };
    const timer = setTimeout(() => finish(new Error('turn timeout')), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'user_message', text })));
    ws.on('message', raw => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch (_) { return; }
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) if (block.type === 'text') assistant += block.text || '';
      }
      if (event.type === 'error') errors.push(event.error || event.message || 'unknown error');
      if (event.type === 'stream_end') setTimeout(() => finish(), 50);
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
      PORT: String(PORT),
      ACCESS_TOKEN: TOKEN,
      MULTICC_DATA_DIR: dataRoot,
      OPENCODE_CMD: fakeCli,
      CLAUDE_CMD: fakeClaude,
      CODEX_CMD: '/usr/bin/true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  await waitForServer();

  const directory = await api('POST', '/api/directories', { name: 'Fail closed', path: project, create: true });
  dirId = directory.id;
  const session = await api('POST', `/api/directories/${dirId}/sessions`, { cli: 'opencode', kind: 'chat' });
  sessionId = session.id;

  const first = await runTurn('first');
  if (!first.assistant.includes('FIRST-OK')) throw new Error('fake source turn did not complete');

  await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'codex' });
  const switchedBack = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'opencode' });
  if (!switchedBack.reusedTarget) throw new Error('target native session was not restored');

  const resumed = await runTurn('resume');
  if (resumed.assistant.includes('MUST-NOT-BE-ACCEPTED')) throw new Error('mismatched session output was accepted');
  if (!resumed.errors.some(error => /没有恢复预期的原生会话/.test(error))) {
    throw new Error(`missing fail-closed error: ${resumed.errors.join(' | ')}`);
  }
  const info = await api('GET', `/api/sessions/${sessionId}`);
  if (info.pendingCliHandoff?.status !== 'pending') throw new Error('failed handoff was consumed');
  if (Number(fs.readFileSync(countFile, 'utf8')) !== 2) throw new Error('server silently retried with a fresh session');

  const claudeSession = await api('POST', `/api/directories/${dirId}/sessions`, { cli: 'claude', kind: 'chat' });
  sessionId = claudeSession.id;
  const firstClaude = await runTurn('first Claude turn');
  if (!firstClaude.assistant.includes('CLAUDE-FIRST-OK')) throw new Error('fake Claude source turn did not complete');
  await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'codex' });
  const switchedClaudeBack = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'claude' });
  if (!switchedClaudeBack.reusedTarget) throw new Error('Claude stream session was not restored');
  const failedClaudeResume = await runTurn('resume Claude');
  if (!failedClaudeResume.errors.some(error => /目标 Claude 原生会话恢复异常/.test(error))) {
    throw new Error(`missing Claude fail-closed error: ${failedClaudeResume.errors.join(' | ')}`);
  }
  const claudeInfo = await api('GET', `/api/sessions/${sessionId}`);
  if (claudeInfo.pendingCliHandoff?.status !== 'pending') throw new Error('failed Claude handoff was consumed');
  await new Promise(resolve => setTimeout(resolve, 200));
  if (Number(fs.readFileSync(claudeCountFile, 'utf8')) !== 2) throw new Error('Claude resume was silently retried');

  console.log('cross-CLI native session mismatch and Claude resume failure both fail closed');
  await cleanup();
})().catch(async error => {
  console.error(error);
  if (stderr) console.error(stderr);
  await cleanup();
  process.exitCode = 1;
});
