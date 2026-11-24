'use strict';

// Real gateway + real server + fake codex/opencode/agy CLI binaries, isolated
// data root. Proves the adapter-neutral event reducer runs end-to-end through
// the same ports as production: decodeEvent parses the CLI's JSONL, the native
// reducer mutates the live session, and the WS room sees the claude-shaped
// assistant/tool/thinking/usage frames. Codex uses `codex exec --json`; the
// opencode lane uses the legacy `run --format json` shape
// (MULTICC_OPENCODE_LEGACY_JSON=1); agy uses `--output-format stream-json
// --dangerously-skip-permissions ... -p <prompt>` (`multicc_core::agy_stream`).
// Never touches ~/.multicc, the main checkout's data directory or live service.
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
  const commitPolicy = require('./helpers/git-test-identity');
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
const fs = require('node:fs');
const marker = require('node:path').join(__dirname, 'question-asked');
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'asked');
  emit({ type: 'item.completed', item: { type: 'function_call', name: 'AskUserQuestion',
    arguments: JSON.stringify({ questions: [{ question: 'Which environment?', options: [{ label: 'test' }, { label: 'prod' }] }] }) } });
}
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

  const agyInvocationsFile = path.join(root, 'agy-invocations.jsonl');
  const fakeAgy = path.join(root, 'fake-agy.js');
  fs.writeFileSync(fakeAgy, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const args = process.argv.slice(2);
const formatIndex = args.indexOf('--output-format');
const outputFormat = formatIndex >= 0 ? args[formatIndex + 1] : '';
if (args.includes('--version')) { process.stdout.write('agy 1.5.14\\n'); process.exit(0); }
// Chat turns: \`agy --output-format stream-json --dangerously-skip-permissions ... -p <prompt>\`
// passes the prompt as the final argv token after \`-p\` (stdio[0] is 'ignore').
if (outputFormat === 'stream-json') {
  const printIndex = args.lastIndexOf('-p');
  if (!args.includes('--dangerously-skip-permissions') || printIndex < 0 || printIndex !== args.length - 2) {
    process.stderr.write('unexpected agy stream-json argv: ' + JSON.stringify(args) + '\\n');
    process.exit(2);
  }
  const prompt = args[printIndex + 1];
  const convIndex = args.indexOf('--conversation');
  const resumedConv = convIndex >= 0 ? args[convIndex + 1] : null;
  fs.appendFileSync(path.join(__dirname, 'agy-invocations.jsonl'),
    JSON.stringify({ args, prompt, resumedConv }) + '\\n');
  const conversation = resumedConv || 'agy-s1';
  emit({ event: 'init', conversation_id: conversation, init: { model: 'gemini-4-neon' } });
  if (!resumedConv) {
    emit({ event: 'step_update', step_update: {
      conversation_id: conversation, step_index: 1, state: 'ACTIVE', step_type: 'agent_response',
      thought_delta: 'THINK_AGY',
    } });
    emit({ event: 'step_update', step_update: {
      conversation_id: conversation, step_index: 1, state: 'DONE', step_type: 'agent_response',
      usage: { input_tokens: 80, output_tokens: 15, thinking_tokens: 12, cache_read_tokens: 0, total_tokens: 95 },
    } });
    emit({ event: 'step_update', step_update: {
      conversation_id: conversation, step_index: 2, state: 'ACTIVE', step_type: 'tool',
      tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: '/tmp/agy-note.txt' } },
    } });
    emit({ event: 'step_update', step_update: {
      conversation_id: conversation, step_index: 2, state: 'DONE', step_type: 'tool',
      tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: '/tmp/agy-note.txt' }, output: 'AGY_TOOL_OK' },
    } });
    emit({ event: 'step_update', step_update: {
      conversation_id: conversation, step_index: 3, state: 'ACTIVE', step_type: 'agent_response',
      text_delta: 'HELLO_',
    } });
    const step3Done = {
      conversation_id: conversation, step_index: 3, state: 'DONE', step_type: 'agent_response',
      text_delta: 'FROM_AGY',
      usage: { input_tokens: 20, output_tokens: 5, thinking_tokens: 8, cache_read_tokens: 60, total_tokens: 85 },
    };
    emit({ event: 'step_update', step_update: step3Done });
    // Duplicate DONE for the same step_index must be deduplicated by TurnAccumulator.
    emit({ event: 'step_update', step_update: { ...step3Done, text_delta: '' } });
    emit({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', num_turns: 1 } });
  } else {
    emit({ event: 'step_update', step_update: {
      conversation_id: conversation, step_index: 1, state: 'DONE', step_type: 'agent_response',
      text_delta: 'SECOND_FROM_AGY',
      usage: { input_tokens: 30, output_tokens: 10, cache_read_tokens: 90, total_tokens: 130 },
    } });
    // Turn 2+ result.usage in agy is conversation-cumulative; decoder must ignore it.
    emit({ event: 'result', result: {
      conversation_id: conversation, status: 'SUCCESS', num_turns: 2,
      usage: { input_tokens: 99999, output_tokens: 9999, cache_read_tokens: 88888 },
    } });
  }
  process.stdout.write('', () => process.exit(0));
} else if (args.includes('-p')) {
  // Quota probe: \`agy -p /usage --output-format json\`.
  process.stdout.write(JSON.stringify({command:{data:{groups:[]}}})); process.exit(0);
} else {
  // Model catalog probe: \`agy acp\` speaks ACP over stdio.
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m = JSON.parse(line);
    const reply = result => send({id:m.id, result});
    if (m.method === 'initialize') return reply({protocolVersion:1, agentCapabilities:{}, authMethods:[]});
    if (m.method === 'session/new') return reply({sessionId:'agy-s1'});
    if (m.method === 'session/set_config_option') return reply({configOptions:[]});
  });
}
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
      AGY_CMD: fakeAgy,
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
      if (lane.cli === 'codex') {
        await socket.until(frames => frames.some(frame => frame.type === 'user_input_required'), 'owned question');
        const question = socket.frames.find(frame => frame.type === 'user_input_required');
        assert.match(question.question, /Which environment/);
        await waitIdle(sessionId);
        const reconnect = await connect(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionId)}&token=${TOKEN}`);
        sockets.push(reconnect.ws);
        await reconnect.until(frames => frames.some(frame => frame.type === 'user_input_required' && frame.requestId === question.requestId), 'replayed question');
        reconnect.send({ type: 'user_message', text: 'test', taskShell: true, turnId: question.turnId,
          userInputRequestId: question.requestId, clientMsgId: randomUUID() });
        await reconnect.until(frames => frames.some(frame => frame.type === 'user_input_resolved' && frame.requestId === question.requestId), 'resolved question');
        await reconnect.until(frames => hasText(frames, 'HELLO_FROM_CODEX'), 'answer turn output');
        reconnect.ws.close();
      }
      await waitIdle(sessionId);
      socket.ws.close();
    }

    const created = await apiOk('POST', `/api/directories/${dir.id}/sessions`, {
      cli: 'agy', kind: 'chat', label: 'adapter-agy',
    });
    const sessionId = created.id || created.sessionId;
    assert.ok(sessionId);
    const socket = await connect(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionId)}&token=${TOKEN}`);
    sockets.push(socket.ws);
    await socket.until(frames => frames.length > 0, 'agy initial frame');
    socket.send({ type: 'user_message', text: 'PING_AGY', taskShell: true, clientMsgId: randomUUID() });
    await socket.until(frames => hasText(frames, 'HELLO_FROM_AGY'), 'agy assistant text');
    await socket.until(frames => hasText(frames, 'AGY_TOOL_OK'), 'agy tool result');
    await socket.until(frames => frames.some(frame =>
      frame?.type === 'assistant' && JSON.stringify(frame).includes('tool_use')), 'agy tool card');
    await socket.until(frames => frames.some(frame => JSON.stringify(frame).includes('THINK_AGY')), 'agy thinking snapshot');
    await socket.until(frames => frames.some(frame => frame.type === 'result' && frame.usage), 'agy turn 1 usage result');
    const agyResultsTurn1 = socket.frames.filter(frame => frame.type === 'result' && frame.usage);
    const usage = agyResultsTurn1[agyResultsTurn1.length - 1].usage;
    assert.equal(usage.input_tokens, 100);
    assert.equal(usage.output_tokens, 20);
    assert.equal(usage.cache_read_input_tokens, 60);
    assert.equal(usage.reasoning_output_tokens, 20);
    assert.equal(usage.total_tokens, 180);
    assert.equal(usage.context_tokens, 80);
    assert.equal(usage.usage_source, 'agy_stream');
    await waitIdle(sessionId);

    const mcpConfigPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
    assert.ok(fs.existsSync(mcpConfigPath), 'agy router MCP config should be written to HOME/.gemini/config/mcp_config.json');
    const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    assert.ok(mcpConfig?.mcpServers?.multicc_router?.command, `multicc_router MCP entry: ${JSON.stringify(mcpConfig)}`);

    const resultCountBeforeTurn2 = socket.frames.filter(frame => frame.type === 'result' && frame.usage).length;
    socket.send({ type: 'user_message', text: 'PING_AGY_TURN2', taskShell: true, clientMsgId: randomUUID() });
    await socket.until(frames => hasText(frames, 'SECOND_FROM_AGY'), 'agy turn 2 assistant text');
    await socket.until(frames =>
      frames.filter(frame => frame.type === 'result' && frame.usage).length > resultCountBeforeTurn2,
    'agy turn 2 usage result');
    const agyResultsTurn2 = socket.frames.filter(frame => frame.type === 'result' && frame.usage);
    const turn2Usage = agyResultsTurn2[agyResultsTurn2.length - 1].usage;
    assert.equal(turn2Usage.input_tokens, 30);
    assert.equal(turn2Usage.output_tokens, 10);
    assert.equal(turn2Usage.cache_read_input_tokens, 90);
    assert.equal(turn2Usage.total_tokens, 130);
    assert.equal(turn2Usage.context_tokens, 120);
    assert.equal(turn2Usage.usage_source, 'agy_stream');
    await waitIdle(sessionId);

    const invocations = fs.readFileSync(agyInvocationsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(invocations.length, 2, `expected 2 agy chat invocations, got ${invocations.length}`);
    assert.equal(invocations[0].resumedConv, null);
    assert.match(invocations[0].prompt, /PING_AGY/);
    assert.equal(invocations[1].resumedConv, 'agy-s1');
    assert.match(invocations[1].prompt, /PING_AGY_TURN2/);

    const history = await apiOk('GET', `/api/sessions/${sessionId}/history?limit=100`);
    const turn1HistoryUsage = history.messages.find(message => message.usage?.context_tokens === 80)?.usage;
    const turn2HistoryUsage = history.messages.find(message => message.usage?.context_tokens === 120)?.usage;
    assert.ok(turn1HistoryUsage, `agy turn 1 history usage: ${JSON.stringify(history)}`);
    assert.equal(turn1HistoryUsage.input_tokens, 100);
    assert.equal(turn1HistoryUsage.usage_source, 'agy_stream');
    assert.ok(turn2HistoryUsage, `agy turn 2 history usage: ${JSON.stringify(history)}`);
    assert.equal(turn2HistoryUsage.input_tokens, 30);
    socket.ws.close();
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
