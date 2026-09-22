'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const prepareTurn = require('./helpers/claude-exp-turn');
const { processSpawnArgs } = require('../src/chat/process-spawn-args');

function sdkProcess(invocation, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.cmd, processSpawnArgs(invocation), {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch (_) {}
      reject(new Error(`SDK process timed out: ${stderr.slice(-1000)}`));
    }, 40000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { resolve({ code, stderr, events: stdout.trim().split('\n').filter(Boolean).map(JSON.parse) }); }
      catch (error) { reject(error); }
    });
  });
}

test('real Agent SDK creates a fresh target after 34 source replies, then resumes across processes', { timeout: 110000 }, async t => {
  t.mock.method(console, 'error', () => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-claude-exp-sdk-'));
  const cwd = path.join(root, 'project');
  const configDir = path.join(root, 'claude');
  fs.mkdirSync(cwd); fs.mkdirSync(configDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Parent history checks and SDK subprocesses use the SAME isolated store.
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  t.after(() => { if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig; });
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 20 })); return; }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    const input = JSON.parse(body); requests.push(input);
    const text = `sdk-answer-${requests.length}`;
    const message = { id: `msg_test_${requests.length}`, type: 'message', role: 'assistant',
      model: input.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 5 } };
    if (!input.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', {}); res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  // No inherited provider credentials, routing env, or user settings.
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root,
    CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'isolated-test-only',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  const id = randomUUID();
  const record = { id: 'sdk-handoff', kind: 'chat', cli: 'claude-exp', cliSessionId: id,
    model: 'claude-sonnet-4-6', pendingCliHandoff: { status: 'pending', toCli: 'claude-exp', reusedTarget: false } };
  const history = Array.from({ length: 34 }, () => ({ role: 'assistant', content: 'source Claude reply' }));
  const first = prepareTurn({ record, cwd, history, connected: true, text: 'remember SDK_FIRST_MARKER' });
  assert.equal(first.envelope.historyHandle.isFirstTurn, true);
  assert.equal(first.invocation.args[1], '--session-id');

  // Reproduce the production symptom with the real SDK before testing recovery.
  const bad = { ...first.invocation, args: first.invocation.args.map(a => a === '--session-id' ? '--resume' : a) };
  const missing = await sdkProcess(bad, cwd, env);
  assert.equal(missing.code, 1);
  assert.match(JSON.stringify(missing.events), /No conversation found with session ID/);
  assert.equal(requests.length, 0, 'missing native history fails before any model request');

  const created = await sdkProcess(first.invocation, cwd, env);
  assert.equal(created.code, 0, created.stderr);
  assert.ok(created.events.some(e => e.type === 'result' && e.subtype === 'success'));
  assert.ok(created.events.some(e => e.type === 'system' && e.subtype === 'init' && e.session_id === id));
  assert.ok(fs.readdirSync(path.join(configDir, 'projects'), { recursive: true }).some(file => file.endsWith(`${id}.jsonl`)));

  // Even a still-pending handoff must resume when an earlier attempt wrote history.
  const second = prepareTurn({ record: JSON.parse(JSON.stringify(record)), cwd, history, connected: false, text: 'second turn' });
  assert.equal(second.envelope.historyHandle.isFirstTurn, false);
  assert.equal(second.invocation.args[1], '--resume');
  const resumed = await sdkProcess(second.invocation, cwd, env);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.ok(resumed.events.some(e => e.type === 'result' && e.subtype === 'success'));
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('SDK_FIRST_MARKER')
    && JSON.stringify(r.messages).includes('second turn')), 'resumed request contains first-turn history');
});
