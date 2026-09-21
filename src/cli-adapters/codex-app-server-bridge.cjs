'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const MIN_CODEX_VERSION = Object.freeze([0, 154, 0]);
const REQUEST_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = { config: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--config') options.config.push(argv[++index]);
    else if (value === '--codex-bin') options.codexBin = argv[++index];
    else if (value === '--thread-id') options.threadId = argv[++index];
    else if (value === '--model') options.model = argv[++index];
    else if (value === '--effort') options.effort = argv[++index];
    else if (value === '--') options.prompt = argv.slice(index + 1).join(' ');
  }
  if (!options.codexBin) throw new Error('missing --codex-bin');
  if (!options.prompt) throw new Error('missing prompt');
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
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let terminal = false;

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

lines.on('line', (line) => {
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
  if (!terminal && process.exitCode == null) process.exitCode = code || (signal ? 1 : 0);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch (_) {}
  });
}

async function main() {
  const initialized = await request('initialize', {
    clientInfo: { name: 'multicc-codex-exp', title: 'MultiCC Codex Experimental', version: '0.1.0' },
  });
  const version = versionFromUserAgent(initialized?.userAgent);
  if (!versionAtLeast(version, MIN_CODEX_VERSION)) {
    throw new Error(`unsupported app-server version: ${initialized?.userAgent || 'unknown'} (requires Codex >= ${MIN_CODEX_VERSION.join('.')})`);
  }
  write({ method: 'initialized', params: {} });
  const common = {
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    ...(options.model ? { model: options.model } : {}),
  };
  let threadId = options.threadId;
  if (threadId) {
    await request('thread/resume', { threadId, excludeTurns: true, ...common });
  } else {
    const started = await request('thread/start', {
      ...common,
      threadSource: 'multicc-codex-exp',
      sessionStartSource: 'startup',
    });
    threadId = started.thread?.id || started.threadId || started.id;
  }
  if (!threadId) throw new Error('app-server did not return a thread id');
  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: options.prompt }],
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  });
}

main().catch((error) => {
  process.stderr.write(`[codex-exp] ${error.message}\n`);
  process.exitCode = 1;
  try { child.kill('SIGTERM'); } catch (_) {}
});
