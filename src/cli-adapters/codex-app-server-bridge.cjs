'use strict';

// Bridges one `codex app-server` child to the host. Two lanes use this file:
//
//   • one-shot  — the host spawns it per turn with the prompt after `--`; the
//                 bridge starts a turn, and kills the app-server on
//                 `turn/completed`. Everything (process, thread, context) dies
//                 with the turn.
//   • resident  — `--resident`, no prompt in argv. The bridge keeps the
//                 app-server AND the thread alive and reads one JSON turn
//                 request per line on stdin, so the next turn continues the
//                 same thread in-process instead of resuming it. It exits only
//                 when stdin ends (host closed the session) or the child dies.
//
// Both lanes emit the same thing on stdout: the app-server's own notifications,
// one JSON object per line, which the host decodes with the codex-exp adapter.
// Requests the app-server addresses TO the client (approvals) are answered
// here, because codex-exp v1 has no interactive approval surface.

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const MIN_CODEX_VERSION = Object.freeze([0, 154, 0]);
const REQUEST_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = { config: [], resident: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--config') options.config.push(argv[++index]);
    else if (value === '--codex-bin') options.codexBin = argv[++index];
    else if (value === '--thread-id') options.threadId = argv[++index];
    else if (value === '--model') options.model = argv[++index];
    else if (value === '--effort') options.effort = argv[++index];
    else if (value === '--resident') options.resident = true;
    else if (value === '--') options.prompt = argv.slice(index + 1).join(' ');
  }
  if (!options.codexBin) throw new Error('missing --codex-bin');
  // A resident bridge takes its first prompt on stdin like every later one, so
  // only the one-shot lane requires the argv prompt.
  if (!options.resident && !options.prompt) throw new Error('missing prompt');
  return options;
}

const options = parseArgs(process.argv.slice(2));
const childArgs = ['app-server', '--listen', 'stdio://'];
for (const config of options.config.filter(Boolean)) childArgs.push('-c', config);
const child = spawn(options.codexBin, childArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const childLines = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let terminal = false;
// Set by the resident loop; fires when the app-server reports the current turn
// is over, i.e. the bridge is ready for the next stdin line.
let onTurnComplete = null;

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(new Error(`${method} timed out`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, params });
  });
}

function versionFromUserAgent(userAgent) {
  const match = String(userAgent || '').match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(version, minimum) {
  if (!version) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }
  return true;
}

function replyUnsupported(message) {
  const method = String(message.method || '');
  const decision = method.includes('requestApproval') || /Approval$/.test(method)
    ? { decision: 'cancel' }
    : null;
  if (decision) write({ id: message.id, result: decision });
  else write({ id: message.id, error: { code: -32601, message: 'codex-exp bridge does not support interactive server requests yet' } });
}

childLines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (!message.method) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
  if (message.id !== undefined) {
    replyUnsupported(message);
    return;
  }
  if (message.method === 'turn/completed') {
    if (onTurnComplete) { onTurnComplete(); return; }
    terminal = true;
    setImmediate(() => child.kill('SIGTERM'));
  }
});

child.stderr.pipe(process.stderr);
child.on('error', (error) => {
  process.stderr.write(`[codex-exp] app-server spawn failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('app-server exited before responding'));
  }
  pending.clear();
  // No app-server means no bridge. In the resident lane the stdin readline would
  // otherwise hold this process open after a cancel/SIGTERM, leaving the host to
  // reap it on its kill escalation instead of on the child's exit.
  if (options.resident) { try { process.stdin.destroy(); } catch (_) {} }
  if (!terminal && process.exitCode == null) process.exitCode = code || (signal ? 1 : 0);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch (_) {}
  });
}

async function initialize() {
  const initialized = await request('initialize', {
    clientInfo: { name: 'multicc-codex-exp', title: 'MultiCC Codex Experimental', version: '0.1.0' },
  });
  const version = versionFromUserAgent(initialized?.userAgent);
  if (!versionAtLeast(version, MIN_CODEX_VERSION)) {
    throw new Error(`unsupported app-server version: ${initialized?.userAgent || 'unknown'} (requires Codex >= ${MIN_CODEX_VERSION.join('.')})`);
  }
  write({ method: 'initialized', params: {} });
}

function commonParams(model) {
  return {
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    ...(model ? { model } : {}),
  };
}

// Start a fresh thread, or re-attach to one an earlier process left behind.
// Returns the thread id the app-server will accept turns against.
async function openThread(threadId, model) {
  if (threadId) {
    await request('thread/resume', { threadId, excludeTurns: true, ...commonParams(model) });
    return threadId;
  }
  const started = await request('thread/start', {
    ...commonParams(model),
    threadSource: 'multicc-codex-exp',
    sessionStartSource: 'startup',
  });
  const created = started.thread?.id || started.threadId || started.id;
  if (!created) throw new Error('app-server did not return a thread id');
  return created;
}

function startTurn(threadId, { text, model, effort }) {
  return request('turn/start', {
    threadId,
    input: [{ type: 'text', text }],
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  });
}

async function runOneShot() {
  await initialize();
  const threadId = await openThread(options.threadId, options.model);
  await startTurn(threadId, {
    text: options.prompt, model: options.model, effort: options.effort,
  });
}

// Resident lane. Turns are serialized: an app-server turn is only started here
// after the previous `turn/completed`, so a line that arrives mid-turn waits in
// `queued` instead of interleaving two turns on one thread.
async function runResident() {
  await initialize();
  let threadId = null;
  try {
    threadId = await openThread(options.threadId, options.model);
  } catch (error) {
    process.stderr.write(`[codex-exp] ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const queued = [];
  let busy = false;

  async function pump() {
    if (busy) return;
    const next = queued.shift();
    if (!next) return;
    busy = true;
    try {
      await startTurn(threadId, next);
    } catch (error) {
      busy = false;
      process.stderr.write(`[codex-exp] turn failed: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    // busy stays true until the app-server reports the turn over; any queued
    // line is pumped from onTurnComplete below.
  }

  onTurnComplete = () => {
    busy = false;
    pump();
  };

  const stdinLines = readline.createInterface({ input: process.stdin });
  stdinLines.on('line', (line) => {
    if (!line.trim()) return;
    let turn;
    try { turn = JSON.parse(line); }
    catch (_) {
      process.stderr.write('[codex-exp] resident bridge dropped a non-JSON stdin line\n');
      return;
    }
    const text = typeof turn === 'string' ? turn : turn?.text;
    if (typeof text !== 'string' || !text) return;
    // A caller-supplied threadId switches threads, which is how a host that
    // lost its in-memory thread (restart) re-attaches instead of forking one.
    if (turn?.threadId && turn.threadId !== threadId) {
      openThread(turn.threadId, turn.model || options.model).then((id) => {
        threadId = id;
        queued.push({ text, model: turn.model || options.model, effort: turn.effort || options.effort });
        pump();
      }).catch((error) => {
        process.stderr.write(`[codex-exp] thread resume failed: ${error.message}\n`);
        process.exitCode = 1;
      });
      return;
    }
    queued.push({
      text, model: turn?.model || options.model, effort: turn?.effort || options.effort,
    });
    pump();
  });
  // The host closes a resident session by ending stdin; that is the only
  // graceful shutdown this lane has, so the app-server goes with it.
  stdinLines.on('close', () => {
    terminal = true;
    try { child.kill('SIGTERM'); } catch (_) {}
  });
}

const run = options.resident ? runResident : runOneShot;
run().catch((error) => {
  process.stderr.write(`[codex-exp] ${error.message}\n`);
  process.exitCode = 1;
  try { child.kill('SIGTERM'); } catch (_) {}
});
