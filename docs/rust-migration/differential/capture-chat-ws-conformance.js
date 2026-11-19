'use strict';

// Captures the CLIENT-VISIBLE /ws/chat contract from a real gateway + real
// Node server + a fake Claude CLI on an isolated data root, and freezes it as
// the equivalence oracle for the move of the /ws/chat upgrade, admission and
// connection ownership into the Rust front door.
//
//   node docs/rust-migration/differential/capture-chat-ws-conformance.js
//   node docs/rust-migration/differential/capture-chat-ws-conformance.js --out /tmp/fresh.json
//
// What it freezes is what a browser or the app can observe, not internals:
// the upgrade status, every data frame (type, key set and, for the small
// stable ones, the exact JSON), and the close code and reason. It complements
// capture-replay-buffer.js, which pins the replay buffer's content.
//
// The admission matrix uses an `X-Forwarded-For` header to make a loopback
// request count as external (the locality policy treats any forwarding
// metadata as non-local), so the remote-credential paths run on 127.0.0.1.
//
// Never touches ~/.multicc, the main checkout's data directory or the live
// service: HOME, MULTICC_DATA_DIR and the CLI binaries all point into a
// mkdtemp root that is removed on exit.

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { assertTestDir } = require('../../../src/paths');
const isolatedHostEnv = require('../../../tests/helpers/isolated-host-env');

const ROOT = path.join(__dirname, '..', '..', '..');
const TOKEN = 'capture-chat-ws-conformance-token';
const outFlag = process.argv.indexOf('--out');
const OUT = outFlag > 0 && process.argv[outFlag + 1]
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(__dirname, 'chat-ws-conformance-golden.json');
// Frame types small and stable enough to freeze byte for byte. Everything else
// is frozen as a type plus its sorted key set.
const EXACT_TYPES = new Set(['error', 'pong', 'task_shell_routed']);
const EXTERNAL = { 'X-Forwarded-For': '203.0.113.9' };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(base, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('capture server did not become ready');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One connection, observed from the client side. `steps` run in order once the
// upgrade succeeds; every frame that arrives is recorded in arrival order, with
// `{ "@": name }` marks interleaved where a step asked for one.
function observe(url, { headers = {}, steps = [], quietMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const timeline = [];
    const result = { upgrade: null, close: null, closedBy: null };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve({ result, timeline });
    };
    const guard = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error(`conformance probe timed out: ${url.replace(TOKEN, '<token>')}`));
    }, 40000);
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    ws.on('unexpected-response', (_request, response) => {
      result.upgrade = response.statusCode;
      response.resume();
      response.on('end', finish);
    });
    ws.on('message', data => {
      try { timeline.push(JSON.parse(String(data))); } catch (_) { timeline.push({ raw: String(data) }); }
    });
    ws.on('error', () => {});
    ws.on('close', (code, reason) => {
      result.close = { code, reason: reason.toString() };
      if (!result.closedBy) result.closedBy = 'server';
      finish();
    });
    ws.on('open', async () => {
      result.upgrade = 101;
      try {
        for (const step of steps) {
          if (ws.readyState !== WebSocket.OPEN) break;
          if (step.send) ws.send(JSON.stringify(step.send));
          else if (step.raw !== undefined) ws.send(step.raw);
          else if (step.compute) ws.send(JSON.stringify(step.compute(timeline)));
          else if (step.mark) timeline.push({ '@': step.mark });
          else if (step.sleep) await sleep(step.sleep);
          else if (step.until) {
            const started = Date.now();
            while (!timeline.some(step.until) && ws.readyState === WebSocket.OPEN) {
              if (Date.now() - started > 20000) throw new Error(`step timeout: ${step.label || 'until'}`);
              await sleep(25);
            }
          }
        }
        // A short quiet window lets late frames of the last step land before
        // the observation ends; a server-initiated close ends it sooner.
        await sleep(quietMs);
        if (ws.readyState === WebSocket.OPEN) {
          result.closedBy = 'client';
          ws.close(1000, 'capture done');
        }
      } catch (error) {
        try { ws.terminate(); } catch (_) {}
        reject(error);
      }
    });
  });
}

// Identifiers minted per run (session, task, receipt, message ids, UUIDs) and
// wall-clock values would make a frozen frame differ on every capture. They are
// replaced by a stable placeholder that keeps the id's family, so a frame that
// loses or gains an id still shows up as a change.
const VOLATILE = [
  [/\b(task|tsk|sr|sh|rcpt|msg|op|turn|clm)([-_])[0-9a-f]{8,}\b/g, '<$1$2id>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>'],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<iso-time>'],
  [/\b1[6-9]\d{11}\b/g, '<epoch-ms>'],
];
function stable(frame) {
  let text = JSON.stringify(frame);
  for (const [pattern, replacement] of VOLATILE) text = text.replace(pattern, replacement);
  return JSON.parse(text);
}

function collapse(frames) {
  const kinds = [];
  for (const frame of frames) {
    const kind = frame['@'] ? `@${frame['@']}` : (frame.type || 'unknown');
    const subtype = frame.subtype ? `/${frame.subtype}` : '';
    const label = kind + subtype;
    if (kinds.length && kinds[kinds.length - 1].type === label && !frame['@']) kinds[kinds.length - 1].count += 1;
    else kinds.push({ type: label, count: 1 });
  }
  return kinds;
}

// Frames the engine emits from an asynchronous persistence step. Their position
// relative to the surrounding frames differs between otherwise identical runs
// (the annotation lands before or after the next queue frame), so the ordered
// sequence leaves them out and their per-type counts are frozen instead.
const INTERLEAVED = new Set(['chat_history_annotation', 'aux_verdict_staleness']);

// A whole turn is surrounded by broadcasts from independent async machinery
// (token statistics, API-error policy, queue and task-state refreshes) whose
// presence and order differ between identical runs, in the retired Node
// implementation as much as in any replacement. For a turn only the anchors
// below are frozen: their relative order, their key sets and the exact routed
// frames. Everything else is deliberately not part of the contract.
const FLOW_ANCHORS = new Set(['stream_start', 'stream_event', 'assistant', 'result', 'stream_end']);

function shape(allFrames, flow = false) {
  const timeline = allFrames.filter(frame => (flow
    ? frame['@'] || FLOW_ANCHORS.has(frame.type) || EXACT_TYPES.has(frame.type)
    : !INTERLEAVED.has(frame.type)));
  const interleaved = {};
  for (const frame of allFrames) {
    if (!flow && INTERLEAVED.has(frame.type)) interleaved[frame.type] = (interleaved[frame.type] || 0) + 1;
  }
  const frames = timeline.filter(frame => !frame['@']);
  const keys = {};
  for (const frame of frames) {
    const type = frame.type || 'unknown';
    keys[type] = [...new Set([...(keys[type] || []), ...Object.keys(frame)])].sort();
  }
  return {
    sequence: collapse(timeline),
    interleaved: Object.fromEntries(Object.entries(interleaved).sort(([a], [b]) => a.localeCompare(b))),
    keys: Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b))),
    exact: frames.filter(frame => EXACT_TYPES.has(frame.type)).map(stable),
  };
}

(async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-chat-ws-conformance-')));
  const dataDir = assertTestDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const gitConfig = path.join(home, '.gitconfig');
  const identity = require('../../../tests/helpers/git-test-identity');
  for (const field of ['name', 'email']) {
    execFileSync('git', ['config', '--file', gitConfig, `user.${field}`, identity[field]]);
  }
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const fakeCli = path.join(root, 'fake-claude.js');
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake-claude 9.9.9\\n'); process.exit(0); }
const sessionAt = args.indexOf('--session-id');
const sessionId = sessionAt >= 0 ? args[sessionAt + 1] : 'fake-conformance-session';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const delta = text => emit({ type: 'stream_event', event: { type: 'content_block_delta',
  delta: { type: 'text_delta', text } } });
process.on('SIGTERM', () => process.exit(143));
process.on('SIGINT', () => process.exit(130));
process.stdout.on('error', () => {});
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(b => b.text || b.content || '').join('') : '';
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch (_) { return; }
  if (message?.type === 'control_request') {
    if (message.request?.subtype === 'initialize') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    }
    return;
  }
  const text = textOf(message?.message?.content ?? message?.content);
  const marker = (text.match(/(?:HANG|DONE)_[A-Z0-9_]+/g) || []).pop();
  if (!marker) return;
  if (marker.startsWith('HANG')) { delta('hang:partial'); setInterval(() => {}, 1000); return; }
  delta('done:partial');
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done:final' }] } });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: 'done:final', num_turns: 1, session_id: sessionId }) + '\\n', () => process.exit(0));
});
`);
  fs.chmodSync(fakeCli, 0o755);

  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', type: 'message', role: 'assistant', content: [] }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

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
      ...isolatedHostEnv(),
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
      CLAUDE_CMD: fakeCli,
      MULTICC_CLAUDE_BIN: fakeCli,
      CODEX_CMD: path.join(root, 'missing-codex'),
      OPENCODE_CMD: path.join(root, 'missing-opencode'),
      QODER_CMD: path.join(root, 'missing-qoder'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', c => { output = (output + c).slice(-30000); });
  child.stderr.on('data', c => { output = (output + c).slice(-30000); });

  async function api(method, route, body, extraHeaders = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${raw}`);
    return raw ? JSON.parse(raw) : null;
  }

  const scenarios = [];
  try {
    await waitReady(base);
    const dir = await api('POST', '/api/directories', { name: 'Conformance', path: project, create: true });
    const provider = await api('POST', '/api/providers', {
      appType: 'claude', name: 'Conformance route',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/fixture`,
      authToken: 'conformance-provider-secret', model: 'claude-sonnet-4-5',
    });
    const newSession = async label => {
      const created = await api('POST', `/api/directories/${dir.id}/sessions`, {
        cli: 'claude', kind: 'chat', label, provider: provider.id,
      });
      return created.id || created.sessionId;
    };
    const url = (session, query = '') => `ws://127.0.0.1:${port}/ws/chat${session === null ? '' : `?session=${encodeURIComponent(session)}`}${query}`;
    const withToken = (session, extra = '') => url(session, `${session === null ? '?' : '&'}token=${TOKEN}${extra}`);
    const ticketFor = async wsPath => (await api('POST', '/api/auth/ws-ticket', { path: wsPath })).ticket;
    const record = async (name, probe, { flow = false } = {}) => {
      const { result, timeline } = await probe;
      scenarios.push({ name, ...(flow ? { flow: true } : {}), ...result, ...shape(timeline, flow) });
      process.stdout.write(`${name}: upgrade ${result.upgrade} close ${JSON.stringify(result.close)}\n`);
    };

    const idle = await newSession('conformance-idle');
    const burstDone = frame => frame.type === 'session_queue';

    // ---- Admission: who gets in, and with which close code the rest leave.
    await record('admit-local-no-credentials', observe(url(idle), { steps: [{ until: burstDone, label: 'burst' }] }));
    await record('deny-external-no-credentials', observe(url(idle), { headers: EXTERNAL }));
    await record('admit-external-legacy-token', observe(withToken(idle), { headers: EXTERNAL, steps: [{ until: burstDone, label: 'burst' }] }));
    await record('deny-external-wrong-token', observe(url(idle, '&token=wrong'), { headers: EXTERNAL }));
    await record('admit-external-ticket', observe(url(idle, `&ticket=${encodeURIComponent(await ticketFor('/ws/chat'))}`), { headers: EXTERNAL, steps: [{ until: burstDone, label: 'burst' }] }));
    const reused = await ticketFor('/ws/chat');
    await observe(url(idle, `&ticket=${encodeURIComponent(reused)}`), { headers: EXTERNAL, steps: [{ until: burstDone, label: 'burst' }] });
    await record('deny-external-ticket-reuse', observe(url(idle, `&ticket=${encodeURIComponent(reused)}`), { headers: EXTERNAL }));
    await record('deny-external-ticket-other-path', observe(url(idle, `&ticket=${encodeURIComponent(await ticketFor('/ws/meta'))}`), { headers: EXTERNAL }));

    // ---- Share links replace normal auth for exactly their own session.
    const viewShare = (await api('POST', `/api/sessions/${idle}/share`, { access: 'view' }));
    const operatePassword = 'conformance-pass-1';
    const operateShare = (await api('POST', `/api/sessions/${idle}/share`, { access: 'operate', password: operatePassword }));
    const shareToken = share => share.token || share.id;
    // A password-gated share is entered by exchanging the password for the
    // share's own cookie; the WebSocket then presents that cookie.
    const authResponse = await fetch(`${base}/api/share/${encodeURIComponent(shareToken(operateShare))}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: operatePassword }),
    });
    if (!authResponse.ok) throw new Error(`share auth failed: HTTP ${authResponse.status}`);
    const shareCookie = authResponse.headers.get('set-cookie').split(';')[0];
    const other = await newSession('conformance-other');
    await record('share-view-ignores-user-message', observe(url(idle, `&share=${encodeURIComponent(shareToken(viewShare))}`), {
      headers: EXTERNAL,
      steps: [
        { until: burstDone, label: 'burst' },
        { mark: 'user_message' },
        { send: { type: 'user_message', text: 'DONE_SHARE', taskShell: true, clientMsgId: randomUUID() } },
        { sleep: 500 },
        { mark: 'ping' },
        { send: { type: 'ping' } },
        { until: frame => frame.type === 'pong', label: 'pong' },
      ],
    }));
    await record('deny-share-operate-without-cookie', observe(url(idle, `&share=${encodeURIComponent(shareToken(operateShare))}`), { headers: EXTERNAL }));
    await record('share-operate-routes-user-message', observe(url(idle, `&share=${encodeURIComponent(shareToken(operateShare))}`), {
      headers: { ...EXTERNAL, Cookie: shareCookie },
      steps: [
        { until: burstDone, label: 'burst' },
        { mark: 'typing' },
        { send: { type: 'typing' } },
        { mark: 'clear_history' },
        { send: { type: 'clear_history' } },
        { sleep: 500 },
        { mark: 'ping' },
        { send: { type: 'ping' } },
        { until: frame => frame.type === 'pong', label: 'pong' },
      ],
    }));
    await record('deny-share-unknown-token', observe(url(idle, '&share=bogus'), { headers: EXTERNAL }));
    await record('deny-share-other-session', observe(url(other, `&share=${encodeURIComponent(shareToken(viewShare))}`), { headers: EXTERNAL }));

    // ---- Session resolution after admission.
    await record('session-missing', observe(withToken('no-such-session')));
    await record('session-parameter-absent', observe(withToken(null)));

    // ---- Client frames on an admitted socket.
    await record('ping-pong', observe(withToken(idle), {
      steps: [{ until: burstDone, label: 'burst' }, { mark: 'ping' }, { send: { type: 'ping' } },
        { until: frame => frame.type === 'pong', label: 'pong' }],
    }));
    await record('ignored-client-frames', observe(withToken(idle), {
      steps: [{ until: burstDone, label: 'burst' },
        { mark: 'malformed-json' }, { raw: '{not json' },
        { mark: 'unknown-type' }, { send: { type: 'definitely_not_a_message' } },
        { mark: 'typing' }, { send: { type: 'typing' } },
        { mark: 'ping' }, { send: { type: 'ping' } },
        { until: frame => frame.type === 'pong', label: 'pong' }],
    }));
    await record('user-message-without-task-shell', observe(withToken(idle), {
      steps: [{ until: burstDone, label: 'burst' }, { mark: 'user_message' },
        { send: { type: 'user_message', text: 'DONE_PLAIN', clientMsgId: randomUUID() } },
        { until: frame => frame.type === 'error', label: 'route-required error' }],
    }));

    // ---- A whole turn and a cancelled turn, as the client sees them.
    const turn = await newSession('conformance-turn');
    await record('turn-complete', observe(withToken(turn), {
      steps: [{ until: burstDone, label: 'burst' }, { mark: 'user_message' },
        { send: { type: 'user_message', text: 'DONE_ONE', taskShell: true, clientMsgId: randomUUID() } },
        { until: frame => frame.type === 'result', label: 'result' }, { sleep: 300 }],
    }), { flow: true });
    const cancelled = await newSession('conformance-cancel');
    await record('turn-cancelled', observe(withToken(cancelled), {
      steps: [{ until: burstDone, label: 'burst' }, { mark: 'user_message' },
        { send: { type: 'user_message', text: 'HANG_ONE', taskShell: true, clientMsgId: randomUUID() } },
        { until: frame => frame.type === 'stream_event', label: 'partial' },
        { mark: 'cancel' },
        // A task-shell control must name the task and turn it cancels; both
        // come from the stream_start frame the engine just broadcast.
        { compute: timeline => {
          const started = timeline.find(frame => frame.type === 'stream_start');
          return { type: 'cancel', taskShell: true, intent: 'cancel', text: '', taskId: started.taskId,
            turnId: started.turnId, clientMsgId: randomUUID() };
        } },
        { until: frame => frame.type === 'stream_end' || frame.type === 'error', label: 'cancel outcome' },
        { sleep: 800 }],
      quietMs: 800,
    }), { flow: true });
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
    await sleep(500);
    try { child.kill('SIGKILL'); } catch (_) {}
    upstream.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const golden = {
    capturedAt: new Date().toISOString().slice(0, 10),
    note: 'Client-visible /ws/chat contract of the Node-terminated implementation: upgrade status, frame '
      + 'sequence, frame key sets, exact small frames and close code/reason. Regenerate only to record an '
      + 'intended contract change.',
    scenarios,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(golden, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(ROOT, OUT)} (${scenarios.length} scenarios)\n`);
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
