'use strict';

// Exercise actual turn-engine wiring with deterministic native CLI subprocesses.
// All state and CLIs live in a temporary directory; no model requests are made.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-completion-e2e-')));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir);
const scenarios = [
  ['codex', 'completed', false], ['codex', 'failed', true], ['codex', 'unknown', true],
  ['codex', 'late-exit-error', true], ['claude', 'completed', false], ['claude', 'failed', true],
  ['opencode', 'completed', false], ['opencode', 'tool-stop', true],
];
const write = (kind, data) => fs.writeFileSync(path.join(dataDir, kind + '.json'), JSON.stringify({
  __multiccSchema: { kind, version: 1, writtenAt: new Date().toISOString() }, data,
}));
write('sessions', []);
write('directories', []);
const scenarioFile = path.join(root, 'scenario');
const commands = {};
for (const cli of ['codex', 'claude', 'opencode']) {
  const file = path.join(root, `fake-${cli}.cjs`);
  commands[cli.toUpperCase() + '_CMD'] = file;
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const cli = ${JSON.stringify(cli)};
const mode = fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8');
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
function reply() {
  const text = 'native-answer:' + cli + ':' + mode;
  if (cli === 'codex') {
    emit({ type: 'thread.started', thread_id: 'thread-' + mode });
    emit({ type: 'item.completed', item: { type: 'agent_message', text } });
    if (mode !== 'unknown') emit({ type: mode === 'failed' ? 'turn.failed' : 'turn.completed', usage: {}, error: mode === 'failed' ? { message: 'failure' } : undefined });
  } else if (cli === 'claude') {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    emit({ type: 'result', subtype: 'success', is_error: mode === 'failed', terminal_reason: mode === 'failed' ? 'api_error' : 'completed', usage: {} });
  } else {
    emit({ type: 'step_start', sessionID: 'session-' + mode });
    emit({ type: 'text', part: { text } });
    if (mode === 'tool-stop') emit({ type: 'tool_use', part: { callID: 'tool-1', tool: 'read', state: { status: 'completed', output: 'ok' } } });
    emit({ type: 'step_finish', part: { reason: 'stop', tokens: {} } });
  }
  if (cli !== 'claude') process.exitCode = mode === 'late-exit-error' ? 1 : 0;
}
if (cli === 'claude' && process.argv.includes('--input-format')) {
  let pending = '';
  process.stdin.on('data', data => { pending += data; if (pending.includes('\\n')) { pending = ''; reply(); } });
} else reply();
`, { mode: 0o755 });
}
fs.writeFileSync(scenarioFile, 'completed');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, output = '', ws;
async function stop() {
  ws?.terminate();
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const done = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
  await done;
  clearTimeout(timer);
}

(async () => {
  try {
    const probe = net.createServer(); probe.listen(0, '127.0.0.1');
    await new Promise(resolve => probe.once('listening', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, ...commands,
        PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', ACCESS_TOKEN: 'completion-test',
        MULTICC_DATA_DIR: dataDir, MULTICC_MEMORY_ROOT: path.join(dataDir, 'memories'),
        MULTICC_ENV_FILE: path.join(root, 'test.env'), MULTICC_TASK_SHELLS: '0', ASR_LOCAL: 'off',
        CODEX_OAUTH_AUTO_REFRESH: '0', CLAUDE_OAUTH_AUTO_REFRESH: '0',
        MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const s of [server.stdout, server.stderr]) s.on('data', chunk => { output = (output + chunk).slice(-60000); });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + '/readyz')).ok) { ready = true; break; } } catch (_) {}
      if (server.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, 'isolated host ready');
    const repoDir = path.join(root, 'repo'); fs.mkdirSync(repoDir);
    const git = args => execFileSync('git', ['-C', repoDir, ...args], { stdio: 'pipe' });
    git(['init', '-q']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'Test workspace\n');
    git(['add', '.']); git(['commit', '-qm', 'initial']);
    const post = async (url, body) => {
      const response = await fetch(base + url, { method: 'POST',
        headers: { Authorization: 'Bearer completion-test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const directory = await post('/api/directories', { name: 'completion-test', path: repoDir });
    const dirId = directory.id || directory.directory.id;
    for (const [cli, mode, partial] of scenarios) {
      const session = await post(`/api/directories/${dirId}/sessions`, { cli, kind: 'chat', label: `${cli}-${mode}` });
      const sid = session.id || session.session.id;
      fs.writeFileSync(scenarioFile, mode);
      ws = new WebSocket(`${base}/ws/chat?session=${sid}`, { headers: { Authorization: 'Bearer completion-test' } });
      const frames = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${sid} init missing: ${JSON.stringify(frames)}`)), 5000);
        ws.once('error', error => { clearTimeout(timer); reject(error); });
        ws.on('message', raw => {
          const event = JSON.parse(String(raw)); frames.push(event);
          if (event.type === 'system' && event.subtype === 'init') { clearTimeout(timer); resolve(); }
        });
      });
      const ended = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${sid} did not finalize: ${JSON.stringify(frames).slice(-3000)}`)), 15000);
        ws.once('close', () => { clearTimeout(timer); reject(new Error(`${sid} socket closed`)); });
        ws.on('message', raw => {
          const event = JSON.parse(String(raw));
          if (event.type === 'stream_end') { clearTimeout(timer); resolve(); }
        });
      });
      ws.send(JSON.stringify({ type: 'user_message', taskShell: true, clientMsgId: `completion-${cli}-${mode}`, text: `check ${sid}` }));
      await ended;
      const history = await (await fetch(`${base}/api/sessions/${sid}/history`, {
        headers: { Authorization: 'Bearer completion-test' },
      })).json();
      const messages = Array.isArray(history) ? history : history.messages;
      const answer = messages?.find(m => m.role === 'assistant' && m.content?.includes(`native-answer:${cli}:${mode}`));
      assert.ok(answer, `${sid} retains output`);
      assert.equal(answer.partial === true, partial, `${sid} finality`);
      assert.equal(frames.some(e => e.type === 'result'), !partial || cli === 'claude', `${sid} final result frame`);
      console.log(`PASS ${sid}: ${partial ? 'partial' : 'durable final'}`);
      ws.terminate(); ws = null;
    }
  } catch (error) { console.error(output); throw error; }
  finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
