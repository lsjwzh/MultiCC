'use strict';

// Isolated server integration test for the cross-CLI control plane. It never
// sends a model turn, so it needs no provider credentials and leaves no native
// Claude/Codex/OpenCode sessions behind.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');

// The session-admin cluster's public routes are claimed by the Rust front door
// (native/gateway/src/app/session_admin.rs), so an isolated host has to start
// the real gateway with server.js as its child instead of bare node.
function gatewayBinary() {
  const addon = process.env.MULTICC_RUST_ADDON
    || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.join(ROOT, 'native', 'prebuilt'),
      `${process.platform}-${process.arch}`, 'multicc_core.node');
  return path.join(path.dirname(addon),
    process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
}

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'cli-switch-api-test';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-cli-switch-'));
const dataRoot = assertTestDir(path.join(tmpRoot, 'data'));
const project = path.join(tmpRoot, 'project');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(project, { recursive: true });

let server;
let stderr = '';
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

async function waitUntil(check, message, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await check();
      if (value) return value;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function cleanup() {
  try { if (server) server.kill('SIGTERM'); } catch (_) {}
  assertTestDir(tmpRoot);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  server = spawn(gatewayBinary(), ['serve', '--cwd', ROOT, '--node', process.execPath, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), ACCESS_TOKEN: TOKEN, MULTICC_DATA_DIR: dataRoot,
      CLAUDE_CMD: '/usr/bin/true', CODEX_CMD: '/usr/bin/true',
      QODER_CMD: '/usr/bin/true', OPENCODE_CMD: '/usr/bin/true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();
  console.log('\nCross-CLI API integration tests');

  let response = await api('POST', '/api/directories', { name: 'CLI Switch', path: project });
  ok(response.status === 200 && response.data.id, 'create isolated directory');
  const dirId = response.data.id;

  response = await api('POST', `/api/directories/${dirId}/sessions`, { cli: 'opencode', kind: 'chat' });
  ok(response.status === 200 && response.data.cli === 'opencode', 'create OpenCode chat');
  const sessionId = response.data.id;
  const taskId = response.data.taskId;
  ok(typeof taskId === 'string' && taskId.length > 0,
    'directory chat creation adopts a board task (task-bound hidden room)');

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

  response = await api('GET', `/api/v1/sessions/${sessionId}`);
  const boundedWire = JSON.stringify(response.data);
  ok(response.status === 200 && response.data.session?.id === sessionId && response.data.session?.cli === 'codex',
    'v1 session query is composed through the bounded domain service');
  ok(!boundedWire.includes('worktreePath') && !boundedWire.includes('cliSessionId')
    && !boundedWire.includes('rolePrompt') && !boundedWire.includes('cwd'),
  'v1 session query excludes host and native-session internals');
  response = await api('GET', '/api/v1/sessions');
  ok(response.status === 200 && !response.data.sessions?.some(item => item.id === sessionId),
    'v1 fleet list keeps task-bound rooms out of the human-shaped fleet');

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

  response = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'qoder' });
  ok(response.status === 200 && response.data.cli === 'qoder', 'OpenCode → Qoder CN switch');
  response = await api('PATCH', `/api/sessions/${sessionId}`, {
    model: 'performance', effort: 'xhigh', agent: 'reviewer',
  });
  ok(response.status === 200 && response.data.model === 'performance'
    && response.data.effort === 'xhigh' && response.data.agent === 'reviewer',
  'Qoder CN model, reasoning effort, and native agent are persisted');
  response = await api('PATCH', `/api/sessions/${sessionId}`, { provider: 'relay' });
  ok(response.status === 400 && /invalid provider/.test(response.data.error || ''),
    'Qoder CN rejects MultiCC provider routing');

  response = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'opencode' });
  ok(response.status === 200 && response.data.effort === 'high' && response.data.agent === 'build',
    'Qoder CN → OpenCode restores the OpenCode-specific settings');

  response = await api('POST', `/api/sessions/${sessionId}/fork`, { includeMemory: false });
  ok(response.status === 200 && response.data.sessionId, 'fork created');
  ok(!JSON.stringify(response.data).includes('transcript'), 'fork response does not expose checkpoint transcript');
  const forkId = response.data.sessionId;
  response = await api('GET', `/api/sessions/${forkId}`);
  ok(response.status === 200 && response.data.pendingCliHandoff?.status === 'pending', 'fork gets a semantic handoff checkpoint');
  ok(response.data.effort === 'high' && response.data.agent === 'build',
    'fork inherits active CLI-specific variant and native agent settings');

  // A fork is a plain fleet session with its own materialized worktree, unlike
  // the task-bound room it came from (whose workspace is created lazily at
  // delivery). The bounded projections and the Git checkpoint are therefore
  // asserted against the fork.
  // Task-first: the always-on Air producer adopts every chat record onto the
  // board, so a fork does not stay a plain fleet session — it becomes a
  // task-bound room like the one it came from. The fleet and workspace
  // projections are human-shaped, so they must show the task cards instead and
  // keep the room (and its host internals) off the wire.
  const forkTaskId = await waitUntil(async () => {
    const got = await api('GET', `/api/sessions/${forkId}`);
    return got.data?.taskBoundTaskId || null;
  }, 'the fork was never adopted onto the board');
  response = await api('GET', '/api/v1/sessions');
  const fleetWire = JSON.stringify(response.data);
  ok(response.status === 200 && !(response.data.sessions || []).some(item => item.id === forkId),
    'v1 fleet list keeps the task-bound fork out of the human-shaped fleet');
  ok(!fleetWire.includes(forkId) && !fleetWire.includes('worktreePath')
    && !fleetWire.includes('cliSessionId') && !fleetWire.includes('rolePrompt')
    && !fleetWire.includes('cwd'),
  'v1 session list uses the same bounded projection');
  response = await api('GET', `/api/v1/directories/${dirId}/workspace`);
  const workspaceWire = JSON.stringify(response.data);
  ok(response.status === 200 && response.data.workspace?.count === response.data.workspace?.sessions?.length,
    'v1 workspace is composed through the bounded workspace service');
  ok(!workspaceWire.includes(forkId) && !workspaceWire.includes('currentFile')
    && !workspaceWire.includes('worktreePath') && !workspaceWire.includes(project),
  'v1 workspace excludes task-bound rooms, filesystem and current-file paths');

  response = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cli: 'opencode', fresh: true });
  ok(response.status === 200 && response.data.changed && response.data.fresh, 'explicit same-CLI native reset');

  const sessionDocument = JSON.parse(fs.readFileSync(path.join(dataRoot, 'sessions.json'), 'utf8'));
  const records = Array.isArray(sessionDocument) ? sessionDocument : sessionDocument.data;
  const persisted = records.find(item => item.id === sessionId);
  ok(!!persisted?.cliStates?.claude && !!persisted?.cliStates?.codex
    && !!persisted?.cliStates?.opencode && !!persisted?.cliStates?.qoder,
    'all visited CLI states persisted');
  const forkPersisted = records.find(item => item.id === forkId);
  ok(!!forkPersisted?.pendingCliHandoff?.checkpoint?.git?.head, 'checkpoint persists Git HEAD');

  response = await api('DELETE', `/api/task-board/tasks/${taskId}`);
  ok(response.status === 200 && response.data.deleted === true,
    'cleanup releases the task-owned room through the task board');
  response = await api('GET', `/api/sessions/${sessionId}`);
  ok(response.status === 404, 'task deletion removed the hidden task-bound room');
  // The fork's transcript is pinned by its own adopted task, so the directory
  // cannot go until that card does (task-first keeps the evidence with it).
  response = await api('DELETE', `/api/task-board/tasks/${forkTaskId}`, { force: true });
  ok(response.status === 200, 'cleanup releases the forked room through the task board');
  // Both rooms were already disposed with their task cards, so the directory
  // itself is all that is left to remove.
  response = await api('DELETE', `/api/directories/${dirId}?force=1`);
  ok(response.status === 200, 'cleanup directory and sessions', JSON.stringify(response.data));
  response = await api('GET', '/api/directories');
  ok(!(response.data || []).some(item => item.id === dirId), 'directory is gone');

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
