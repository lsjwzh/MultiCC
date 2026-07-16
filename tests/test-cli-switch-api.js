'use strict';

// Isolated server integration test for the cross-CLI control plane. It never
// sends a model turn, so it needs no provider credentials and leaves no native
// Claude/Codex/OpenCode sessions behind.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'cli-switch-api-test';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-cli-switch-'));
const project = path.join(tmpRoot, 'project');
fs.mkdirSync(project, { recursive: true });

let server;
let passed = 0;
let failed = 0;
function ok(condition, name, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, route, body) {
  const response = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, data };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await api('GET', '/api/directories');
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('isolated server did not start');
}

function cleanup() {
  try { if (server) server.kill('SIGTERM'); } catch (_) {}
  for (const file of ['sessions.json', 'directories.json', 'events', 'chat_history', 'token_usage.json', 'token_daily.json']) {
    try { fs.rmSync(path.join(ROOT, file), { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ACCESS_TOKEN: TOKEN },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();
  console.log('\nCross-CLI API integration tests');

  let response = await api('POST', '/api/directories', { name: 'CLI Switch', path: project });
  ok(response.status === 200 && response.data.id, 'create isolated directory');
  const dirId = response.data.id;

  response = await api('POST', `/api/directories/${dirId}/sessions`, { cli: 'opencode', kind: 'chat' });
  ok(response.status === 200 && response.data.cli === 'opencode', 'create OpenCode chat');
  const sessionId = response.data.id;

  response = await api('PATCH', `/api/sessions/${sessionId}`, { effort: 'high', agent: 'build' });
  ok(response.status === 200 && response.data.effort === 'high' && response.data.agent === 'build',
    'OpenCode variant and native agent are persisted');

  response = await api('PATCH', `/api/sessions/${sessionId}`, { subagent: { providerId: 'x', model: 'y' } });
  ok(response.status === 400 && /only supported/.test(response.data.error || ''),
    'OpenCode rejects Claude/Codex-only subagent routing');

  response = await api('PATCH', `/api/sessions/${sessionId}`, { cli: 'codex' });
  ok(response.status === 400 && /switch-cli/.test(response.data.error || ''), 'PATCH cli is rejected explicitly');

  response = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'codex' });
  ok(response.status === 200 && response.data.changed && response.data.fromCli === 'opencode', 'OpenCode → Codex switch');
  ok(response.data.cliStates?.opencode && response.data.cliStates?.codex, 'per-CLI state summaries returned');
  ok(/^handoff_/.test(response.data.handoffId || ''), 'handoff id returned');
  const switchState = response.data;

  response = await api('GET', `/api/sessions/${sessionId}`);
  ok(response.status === 200 && response.data.cli === 'codex', 'GET reports active Codex CLI');
  ok(switchState.provider === response.data.provider
    && switchState.model === response.data.model
    && switchState.effectiveModel === response.data.effectiveModel
    && switchState.effort === response.data.effort
    && switchState.effectiveEffort === response.data.effectiveEffort
    && switchState.agent === response.data.agent,
  'switch response includes the target CLI AI settings');
  ok(response.data.cliAvailability && typeof response.data.cliAvailability.opencode?.available === 'boolean',
    'GET reports local CLI availability for the switcher');
  ok(response.data.pendingCliHandoff?.status === 'pending', 'handoff remains pending before target reply');
  ok(!JSON.stringify(response.data).includes('transcript'), 'GET does not expose checkpoint transcript');

  response = await api('PATCH', `/api/sessions/${sessionId}`, { agent: 'build' });
  ok(response.status === 400 && /only supported/.test(response.data.error || ''),
    'Codex rejects Claude/OpenCode-only native agent setting');

  response = await api('PATCH', `/api/sessions/${sessionId}`, { autoCommit: false });
  ok(response.status === 200 && !JSON.stringify(response.data).includes('transcript'),
    'PATCH does not expose checkpoint transcript');

  response = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'claude' });
  ok(response.status === 200 && response.data.cli === 'claude', 'Codex → Claude switch');
  response = await api('PATCH', `/api/sessions/${sessionId}`, { agent: 'reviewer' });
  ok(response.status === 200 && response.data.agent === 'reviewer', 'Claude native --agent setting is persisted');

  response = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'opencode' });
  ok(response.status === 200 && response.data.cli === 'opencode', 'Claude → OpenCode round trip');
  response = await api('GET', `/api/sessions/${sessionId}`);
  ok(response.data.effort === 'high' && response.data.agent === 'build',
    'OpenCode-specific variant and agent survive a CLI round trip');

  response = await api('POST', `/api/sessions/${sessionId}/fork`, { includeMemory: false });
  ok(response.status === 200 && response.data.sessionId, 'fork created');
  ok(!JSON.stringify(response.data).includes('transcript'), 'fork response does not expose checkpoint transcript');
  const forkId = response.data.sessionId;
  response = await api('GET', `/api/sessions/${forkId}`);
  ok(response.status === 200 && response.data.pendingCliHandoff?.status === 'pending', 'fork gets a semantic handoff checkpoint');
  ok(response.data.effort === 'high' && response.data.agent === 'build',
    'fork inherits active CLI-specific variant and native agent settings');

  response = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'opencode', fresh: true });
  ok(response.status === 200 && response.data.changed && response.data.fresh, 'explicit same-CLI native reset');

  const records = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions.json'), 'utf8'));
  const persisted = records.find(item => item.id === sessionId);
  ok(!!persisted?.cliStates?.claude && !!persisted?.cliStates?.codex && !!persisted?.cliStates?.opencode,
    'all visited CLI states persisted');
  ok(!!persisted?.pendingCliHandoff?.checkpoint?.git?.head, 'checkpoint persists Git HEAD');

  response = await api('DELETE', `/api/directories/${dirId}?force=1`);
  ok(response.status === 200 && response.data.removedSessions >= 3, 'cleanup directory and sessions');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} integration assertion(s) failed`);
  cleanup();
  setTimeout(() => process.exit(0), 200);
})().catch((error) => {
  console.error(error);
  if (stderr) console.error(stderr.slice(-3000));
  cleanup();
  setTimeout(() => process.exit(1), 200);
});
