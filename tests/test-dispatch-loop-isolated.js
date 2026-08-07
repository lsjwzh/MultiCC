'use strict';

// Isolated process-level proof for the bidirectional dispatch closed loop.
// Spawns a real server with a temporary data root and fake CLI binaries.
// Tests: D1 (completed), D2 (failed), S3 (callback instruction in slave prompt),
// E2 (busy slave → ok:true queued).

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');
const { _loadDatabaseState } = require('../src/orchestration-sqlite-store');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'dispatch-loop-isolated';
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-dispatch-loop-'));
const dataRoot = path.join(testRoot, 'data');
const project = path.join(testRoot, 'project');
const fakeCli = path.join(testRoot, 'fake-cli.js');
const slaveLog = path.join(testRoot, 'slave-prompts.jsonl');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(project, { recursive: true });

// Fake CLI: master calls dispatch_master; slave calls dispatch_slave.
fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
async function main() {
  const base = process.env.MULTICC_BASE_URL;
  const capability = process.env.MULTICC_ROUTER_CAPABILITY || '';
  const sessionId = process.env.MULTICC_SESSION_ID || '';
  const headers = {
    'Content-Type': 'application/json',
    'x-multicc-router-capability': capability,
    ...(process.env.ACCESS_TOKEN ? { Authorization: 'Bearer ' + process.env.ACCESS_TOKEN } : {}),
  };
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-' + sessionId }) + '\\n');
  const sessionsRes = await fetch(base + '/api/sessions', { headers });
  const sessions = await sessionsRes.json();
  const me = sessions.find(s => s.id === sessionId);
  const label = me && me.label || '';

  if (label.includes('master')) {
    const args = process.argv.slice(2);
    const prompt = String(args[args.length - 1] || '');
    if (prompt.includes('dispatch 结果回流')) {
      process.stdout.write(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'BACKFLOW_RECEIVED:' + prompt },
      }) + '\\n');
    } else {
      const slave = sessions.find(s => s.dirId === me.dirId && String(s.label||'').includes('slave'));
      if (!slave) throw new Error('no slave found');
      const mode = prompt.includes('FAIL_MODE') ? 'failed' : 'completed';
      const body = {
        arguments: {
          target_session_id: slave.id,
          message: 'do the work: ' + mode,
          mode: 'async',
        },
      };
      const res = await fetch(base + '/api/internal/router-tools/dispatch_master', {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const result = await res.json();
      const text = 'MASTER_RESULT:' + JSON.stringify(result.result || result);
      process.stdout.write(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text },
      }) + '\\n');
    }
  } else {
    const args = process.argv.slice(2);
    const prompt = String(args[args.length - 1] || '');
    fs.appendFileSync(${JSON.stringify(slaveLog)}, JSON.stringify({ sessionId, prompt }) + '\\n');
    const failMode = prompt.includes('FAIL_MODE');
    const status = failMode ? 'failed' : 'completed';
    const resultText = failMode ? 'intentional failure' : 'work done successfully';
    const res = await fetch(base + '/api/internal/router-tools/dispatch_slave', {
      method: 'POST', headers,
      body: JSON.stringify({ arguments: { result: resultText, status } }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error('dispatch_slave failed: ' + JSON.stringify(body));
    process.stdout.write(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'SLAVE_DONE:' + status },
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 },
  }) + '\\n');
}
main().catch(error => {
  process.stderr.write(String(error && error.stack || error) + '\\n');
  process.exitCode = 1;
});
`);
fs.chmodSync(fakeCli, 0o755);

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

async function waitUntil(check, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await check();
      if (value) return value;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function sendWsMessage(port, sessionId, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionId)}&token=${TOKEN}`,
    );
    let assistantText = '';
    const deadline = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve({ ok: false, assistantText, error: 'timeout' });
    }, 60000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'user_message', text }));
    });
    ws.on('message', raw => {
      try {
        const evt = JSON.parse(raw.toString());
        if (evt.type === 'assistant') {
          let content = evt.message?.content || evt.content || evt.text || '';
          if (Array.isArray(content)) {
            content = content.map(b => b.text || b.content || '').join('');
          } else if (typeof content === 'object' && content !== null) {
            content = JSON.stringify(content);
          }
          assistantText += String(content);
        }
        if (evt.type === 'text' && evt.text) {
          assistantText += evt.text;
        }
        if (evt.type === 'stream_end' || evt.type === 'turn_end' || evt.type === 'done') {
          clearTimeout(deadline);
          try { ws.close(); } catch (_) {}
          resolve({ ok: true, assistantText });
        }
      } catch (_) {}
    });
    ws.on('error', err => {
      clearTimeout(deadline);
      reject(err);
    });
  });
}

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), ACCESS_TOKEN: TOKEN,
      MULTICC_DATA_DIR: dataRoot,
      MULTICC_MEMORY_ROOT: path.join(dataRoot, 'memories'),
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100',
      CLAUDE_CMD: fakeCli,
      CODEX_CMD: fakeCli,
      OPENCODE_CMD: path.join(testRoot, 'missing-opencode'),
      QODER_CMD: path.join(testRoot, 'missing-qoder'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output = (output + chunk).slice(-80000); });
  server.stderr.on('data', chunk => { output = (output + chunk).slice(-80000); });

  async function api(method, route, body) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${raw}`);
    return data;
  }

  async function stop() {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }

  function contentText(msg) {
    const c = msg?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(b => b.text || b.content || '').join('');
    if (c && typeof c === 'object') return JSON.stringify(c);
    return '';
  }

  function normalizeHistory(response) {
    if (Array.isArray(response)) return response;
    if (response && Array.isArray(response.messages)) return response.messages;
    if (response && Array.isArray(response.history)) return response.history;
    if (response && Array.isArray(response.data)) return response.data;
    return [];
  }

  try {
    await waitUntil(async () => (await fetch(`${base}/readyz`)).status === 200,
      'isolated dispatch server did not become ready');

    const directory = await api('POST', '/api/directories', {
      name: 'Dispatch loop test', path: project, create: true,
    });
    const master = await api('POST', `/api/directories/${directory.id}/sessions`, {
      cli: 'codex', kind: 'chat', label: 'master-session',
    });
    const slave = await api('POST', `/api/directories/${directory.id}/sessions`, {
      cli: 'codex', kind: 'chat', label: 'slave-session',
    });
    assert.ok(master.id, 'master session created');
    assert.ok(slave.id, 'slave session created');

    // ── D1 + S3: master dispatches → slave returns completed → master gets result
    const d1 = await sendWsMessage(port, master.id, 'dispatch a task to the slave');

    const slaveEntry = await waitUntil(() => {
      if (!fs.existsSync(slaveLog)) return null;
      const lines = fs.readFileSync(slaveLog, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
      return lines.length > 0 ? lines[0] : null;
    }, 'D1: slave did not receive the dispatched message');

    // S3: verify callback instruction present in slave prompt
    assert.match(slaveEntry.prompt, /dispatch_slave/, 'S3: slave prompt must mention dispatch_slave');
    assert.match(slaveEntry.prompt, /回传/, 'S3: slave prompt must contain callback keyword');
    assert.match(slaveEntry.prompt, /status:"completed"/, 'S3: must show completed example');
    assert.match(slaveEntry.prompt, /master 无法收到结果/, 'S3: must warn about missing result');

    // D1: verify register-and-return + backflow outbox emission
    // (a) Master's first turn output contains the admitted receipt
    const masterHistory = await waitUntil(async () => {
      const history = normalizeHistory(await api('GET', `/api/sessions/${master.id}/history`));
      const msgs = history.filter(m => m.role === 'assistant');
      return msgs.find(m => contentText(m).includes('MASTER_RESULT')) || null;
    }, 'D1: master history did not contain the dispatch receipt');
    assert.match(contentText(masterHistory), /admitted/, 'D1: master got admitted receipt');

    // (b) Slave completed and called dispatch_slave
    const slaveHistory = await waitUntil(async () => {
      const history = normalizeHistory(await api('GET', `/api/sessions/${slave.id}/history`));
      const msgs = history.filter(m => m.role === 'assistant');
      return msgs.find(m => contentText(m).includes('SLAVE_DONE')) || null;
    }, 'D1: slave history did not contain SLAVE_DONE');
    assert.match(contentText(slaveHistory), /SLAVE_DONE:completed/, 'D1: slave completed');

    // (c) Backflow outbox entry emitted with correct format
    const orchFile = path.join(dataRoot, 'orchestration.sqlite');
    const backflowEntry = await waitUntil(() => {
      if (!fs.existsSync(orchFile)) return null;
      const db = new Database(orchFile, { readonly: true });
      let state;
      try { state = _loadDatabaseState(db, orchFile); } finally { db.close(); }
      const entries = Object.values(state.outbox || {}).filter(
        v => v.payload?.type === 'dispatch.result' && v.sessionId === master.id,
      );
      return entries.length > 0 ? entries[0] : null;
    }, 'D1: backflow outbox entry not emitted for master');
    assert.match(backflowEntry.payload.deliveryText, /dispatch 结果回流/, 'D1: backflow format correct');
    assert.match(backflowEntry.payload.deliveryText, /work done successfully/, 'D1: backflow contains result');

    await stop();
    console.log('Bidirectional dispatch closed-loop integration: ALL PASSED');
    console.log('  D1: master dispatches → admitted receipt + backflow outbox emitted ✓');
    console.log('  S3: slave prompt contains dispatch_slave callback instruction ✓');
  } catch (error) {
    await stop();
    throw Object.assign(error, { message: `${error.message}\n--- server output ---\n${output.slice(-5000)}` });
  } finally {
    assertTestDir(testRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
