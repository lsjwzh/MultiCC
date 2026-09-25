'use strict';

// Bridges one ACP (Agent Client Protocol) agent child to the host. ACP is
// JSON-RPC 2.0, one message per line, over the agent's stdio; every CLI that
// speaks it (`opencode acp`, `gemini --experimental-acp`, `grok agent stdio`,
// `codebuddy --acp`) is driven by this one file. Two lanes, mirroring
// codex-app-server-bridge.cjs:
//
//   • one-shot  — prompt after `--`. initialize → open session → one
//                 session/prompt → exit when its response (the stopReason)
//                 arrives. Everything but the agent's own on-disk session dies
//                 with the turn.
//   • resident  — `--resident`, no prompt in argv. The agent and its session
//                 stay alive; one JSON turn request per stdin line
//                 ({text, sessionId?, model?} or {type:'cancel'}). Exits when
//                 stdin ends or the agent dies.
//
// stdout carries JSONL the acp adapter decodes:
//   • the agent's own `session/update` notifications, forwarded verbatim
//   • {method:'multicc/session', params:{sessionId, resumed, agentInfo}}
//   • {method:'multicc/turnEnd', params:{sessionId, stopReason, usage}} — the
//     authoritative turn boundary (the session/prompt response)
//   • {method:'multicc/error',   params:{message, code, phase}}
//   • {method:'multicc/notice',  params:{message}}
//   • {method:'multicc/permission', params:{title, optionId}} — audit only
//
// Requests the agent addresses TO the client are answered here: permission
// requests are auto-approved (every multicc lane runs unattended, like
// `--auto`/`--yolo`), and the client advertises no fs/terminal capability so
// agents keep using their own tools.

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 60_000;
const CANCEL_GRACE_MS = 2_000;
const ROUTER_ENV_KEYS = [
  'MULTICC_SESSION_ID', 'MULTICC_BASE_URL', 'MULTICC_TURN_ID',
  'MULTICC_ORIGIN_DISPATCH_ID', 'MULTICC_ROUTER_CAPABILITY', 'MULTICC_IMAGE_BRIDGE',
];

function parseArgs(argv) {
  const options = { agentArgs: [], resident: false, label: 'ACP' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--agent-bin') options.agentBin = argv[++index];
    else if (value === '--agent-arg') options.agentArgs.push(argv[++index]);
    else if (value === '--label') options.label = argv[++index];
    else if (value === '--session-id') options.sessionId = argv[++index];
    else if (value === '--model') options.model = argv[++index];
    else if (value === '--mode') options.mode = argv[++index];
    else if (value === '--effort') options.effort = argv[++index];
    else if (value === '--router-mcp') {
      options.routerMcp = { command: argv[++index], script: argv[++index] };
    } else if (value === '--resident') options.resident = true;
    else if (value === '--') { options.prompt = argv.slice(index + 1).join(' '); break; }
  }
  if (!options.agentBin) throw new Error('missing --agent-bin');
  if (!options.resident && !options.prompt) throw new Error('missing prompt');
  return options;
}

function emit(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

function errorMessage(error) {
  if (!error) return 'unknown error';
  const data = error.data && typeof error.data === 'object' ? error.data : null;
  const detail = data && (data.message || data.details || data.error);
  const base = error.message || String(error);
  return detail && !base.includes(String(detail)) ? `${base}: ${detail}` : base;
}

function routerMcpServers(routerMcp, env) {
  if (!routerMcp?.command || !routerMcp?.script) return [];
  // The capability token lives in this process' env (the host minted it for
  // this spawn); ACP hands MCP env explicitly, so it must be copied across.
  const serverEnv = ROUTER_ENV_KEYS
    .filter(key => env[key])
    .map(name => ({ name, value: String(env[name]) }));
  return [{ name: 'multicc_router', command: routerMcp.command, args: [routerMcp.script], env: serverEnv }];
}

// Prefer an always-allow option, then allow-once, then whatever the agent
// listed first — an unattended lane must never leave the agent waiting.
function pickPermissionOption(options) {
  const list = Array.isArray(options) ? options : [];
  return list.find(option => option?.kind === 'allow_always')
    || list.find(option => option?.kind === 'allow_once')
    || list.find(option => /^allow/.test(String(option?.kind || '')))
    || list[0]
    || null;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    input_tokens: Number(usage.inputTokens || 0),
    output_tokens: Number(usage.outputTokens || 0),
    cache_read_input_tokens: Number(usage.cachedReadTokens || 0),
    cache_creation_input_tokens: Number(usage.cachedWriteTokens || 0),
    ...(usage.thoughtTokens != null ? { reasoning_output_tokens: Number(usage.thoughtTokens || 0) } : {}),
  };
}

function createBridge(options, { env = process.env, spawnFn = spawn } = {}) {
  const child = spawnFn(options.agentBin, options.agentArgs, {
    cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let stopping = false;
  let agentCapabilities = {};
  let agentInfo = null;
  let authMethods = [];
  // Set while session/load replays history: those updates describe turns the
  // host already recorded and must not be re-emitted as new output.
  let replaying = false;
  let sessionId = null;
  let configOptions = [];
  let activePrompt = null;
  let cancelRequested = false;
  let exitResolve;
  const exited = new Promise(resolve => { exitResolve = resolve; });

  function write(message) {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  function request(method, params, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(Object.assign(new Error(`${method} timed out`), { code: 'acp_timeout' }));
      }, timeoutMs) : null;
      pending.set(id, { resolve, reject, timer, method });
      write({ id, method, params });
    });
  }

  function answerClientRequest(message) {
    if (message.method === 'session/request_permission') {
      const option = pickPermissionOption(message.params?.options);
      if (!option) {
        write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        return;
      }
      emit('multicc/permission', {
        title: message.params?.toolCall?.title || null,
        kind: message.params?.toolCall?.kind || null,
        optionId: option.optionId,
      });
      write({ id: message.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } });
      return;
    }
    write({ id: message.id, error: { code: -32601, message: `multicc ACP client does not implement ${message.method}` } });
  }

  const childLines = readline.createInterface({ input: child.stdout });
  childLines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch (_) { return; }
    if (!message || typeof message !== 'object') return;
    if (message.id != null && !message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(Object.assign(new Error(errorMessage(message.error)), {
          code: message.error.code, rpcError: message.error,
        }));
      } else waiter.resolve(message.result || {});
      return;
    }
    if (!message.method) return;
    if (message.id != null) { answerClientRequest(message); return; }
    if (message.method === 'session/update') {
      if (replaying) return;
      process.stdout.write(`${JSON.stringify({ method: message.method, params: message.params })}\n`);
    }
  });

  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('error', (error) => {
    emit('multicc/error', { message: `${options.label} failed to start: ${error.message}`, code: 'spawn_failed', phase: 'spawn' });
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    for (const waiter of pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error(`${options.label} exited before answering ${waiter.method}`), { code: 'agent_exited' }));
    }
    pending.clear();
    exitResolve({ code, signal });
  });

  function stopChild() {
    if (stopping) return exited;
    stopping = true;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000);
    timer.unref();
    exited.then(() => clearTimeout(timer));
    try { child.stdin.end(); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
    return exited;
  }

  async function initialize() {
    const result = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'multicc', title: 'MultiCC', version: '1.0.0' },
    });
    agentCapabilities = result.agentCapabilities || {};
    agentInfo = result.agentInfo || null;
    authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
  }

  function withAuthHint(error) {
    const auth = /auth|api key|log ?in|credential/i.test(error.message) || error.code === -32000 || error.code === 401;
    if (!auth || !authMethods.length) return error;
    const hints = authMethods.map(method => method.description || method.name || method.id).filter(Boolean);
    error.message = `${error.message} (${hints.join('; ')})`;
    error.code = 'auth_required';
    return error;
  }

  // Re-attach to a session an earlier process left on disk, preferring the
  // non-replaying resume; fall back to load (replay suppressed), then to a new
  // session with a visible notice rather than wedging the conversation forever.
  async function openSession(existingId) {
    const common = { cwd: process.cwd(), mcpServers: routerMcpServers(options.routerMcp, env) };
    if (existingId) {
      try {
        let result;
        if (agentCapabilities.sessionCapabilities?.resume) {
          result = await request('session/resume', { sessionId: existingId, ...common });
        } else if (agentCapabilities.loadSession) {
          replaying = true;
          try { result = await request('session/load', { sessionId: existingId, ...common }); }
          finally { replaying = false; }
        } else {
          throw new Error(`${options.label} cannot resume sessions over ACP`);
        }
        sessionId = existingId;
        configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
        emit('multicc/session', { sessionId, resumed: true, agentInfo });
        return result || {};
      } catch (error) {
        if (error.code === 'agent_exited') throw error;
        emit('multicc/notice', {
          message: `${options.label} could not resume session ${existingId} (${error.message}); started a new session — earlier context is not visible to the agent.`,
        });
      }
    }
    const result = await request('session/new', common).catch(error => { throw withAuthHint(error); });
    if (!result.sessionId) throw new Error(`${options.label} did not return a sessionId`);
    sessionId = result.sessionId;
    configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    emit('multicc/session', { sessionId, resumed: false, agentInfo });
    return result;
  }

  function findOption(predicate) {
    return configOptions.find(option => option && predicate(option)) || null;
  }

  async function setConfig(option, value) {
    const choices = Array.isArray(option.options) ? option.options : [];
    const flat = choices.flatMap(choice => (Array.isArray(choice?.options) ? choice.options : [choice]));
    if (flat.length && !flat.some(choice => choice?.value === value)) {
      const sample = flat.slice(0, 8).map(choice => choice.value).join(', ');
      throw Object.assign(new Error(`${options.label} has no ${option.id} "${value}" (available: ${sample}${flat.length > 8 ? ', …' : ''})`), { code: 'invalid_config' });
    }
    if (option.currentValue === value) return;
    const result = await request('session/set_config_option', { sessionId, configId: option.id, value });
    if (Array.isArray(result?.configOptions)) configOptions = result.configOptions;
  }

  // Model is binding: a session pinned to a model must not silently run on the
  // agent's default. Mode and effort are best-effort hints.
  async function applySessionConfig(opened, { model, mode, effort }) {
    if (model) {
      const option = findOption(o => o.category === 'model' || o.id === 'model');
      if (option) await setConfig(option, model);
      else if (opened?.models?.availableModels) {
        if (opened.models.currentModelId !== model) await request('session/set_model', { sessionId, modelId: model });
      } else {
        throw Object.assign(new Error(`${options.label} does not expose model selection over ACP`), { code: 'invalid_config' });
      }
    }
    if (mode) {
      const option = findOption(o => o.category === 'mode' || o.id === 'mode');
      if (option) await setConfig(option, mode).catch(error => emit('multicc/notice', { message: error.message }));
      else if (opened?.modes?.availableModes?.some(m => m.id === mode)) {
        await request('session/set_mode', { sessionId, modeId: mode })
          .catch(error => emit('multicc/notice', { message: error.message }));
      }
    }
    if (effort) {
      const option = findOption(o => o.category === 'thought_level' || /variant|effort|thought|reasoning/i.test(o.id));
      if (option) await setConfig(option, effort).catch(error => emit('multicc/notice', { message: error.message }));
      else emit('multicc/notice', { message: `${options.label} has no reasoning-effort option over ACP; "${effort}" was ignored.` });
    }
  }

  async function prompt(text) {
    cancelRequested = false;
    activePrompt = request('session/prompt', {
      sessionId, prompt: [{ type: 'text', text }],
    }, { timeoutMs: 0 });
    try {
      const result = await activePrompt;
      const stopReason = cancelRequested && result.stopReason !== 'end_turn' ? 'cancelled' : (result.stopReason || 'end_turn');
      emit('multicc/turnEnd', { sessionId, stopReason, usage: normalizeUsage(result.usage) });
      return stopReason;
    } finally {
      activePrompt = null;
    }
  }

  // In-place interrupt. The agent answers the pending session/prompt with
  // stopReason "cancelled"; if it does not within the grace window the caller
  // falls back to stopping the child.
  async function cancel() {
    if (!activePrompt || !sessionId) return false;
    cancelRequested = true;
    write({ method: 'session/cancel', params: { sessionId } });
    const settled = await Promise.race([
      activePrompt.then(() => true, () => true),
      new Promise(resolve => setTimeout(() => resolve(false), CANCEL_GRACE_MS).unref()),
    ]);
    return settled;
  }

  return {
    child, exited, initialize, openSession, applySessionConfig, prompt, cancel, stopChild,
    get sessionId() { return sessionId; },
    get busy() { return !!activePrompt; },
  };
}

function reportFailure(label, error, phase) {
  emit('multicc/error', {
    message: `${label}: ${error.message}`,
    code: error.code || null,
    phase,
  });
  process.exitCode = 1;
}

async function runOneShot(options, bridge) {
  let phase = 'initialize';
  try {
    await bridge.initialize();
    phase = 'session';
    const opened = await bridge.openSession(options.sessionId);
    phase = 'config';
    await bridge.applySessionConfig(opened, options);
    phase = 'prompt';
    const stopReason = await bridge.prompt(options.prompt);
    if (stopReason === 'cancelled' || stopReason === 'refusal') process.exitCode = 1;
  } catch (error) {
    reportFailure(options.label, error, phase);
  } finally {
    await bridge.stopChild();
  }
}

async function runResident(options, bridge) {
  try {
    await bridge.initialize();
    const opened = await bridge.openSession(options.sessionId);
    await bridge.applySessionConfig(opened, options);
  } catch (error) {
    reportFailure(options.label, error, 'session');
    await bridge.stopChild();
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
      if (next.model && next.model !== options.model) {
        await bridge.applySessionConfig({}, { model: next.model });
        options.model = next.model;
      }
      await bridge.prompt(next.text);
    } catch (error) {
      reportFailure(options.label, error, 'prompt');
      if (error.code === 'agent_exited') return;
    } finally {
      busy = false;
    }
    pump();
  }
  const stdinLines = readline.createInterface({ input: process.stdin });
  stdinLines.on('line', (line) => {
    if (!line.trim()) return;
    let turn;
    try { turn = JSON.parse(line); } catch (_) {
      process.stderr.write(`[${options.label}] resident bridge dropped a non-JSON stdin line\n`);
      return;
    }
    if (turn?.type === 'cancel') {
      bridge.cancel().then((settled) => { if (!settled) bridge.stopChild(); });
      return;
    }
    const text = typeof turn === 'string' ? turn : turn?.text;
    if (typeof text !== 'string' || !text) return;
    queued.push({ text, model: turn?.model || null });
    pump();
  });
  stdinLines.on('close', () => { bridge.stopChild(); });
  bridge.exited.then(() => { try { process.stdin.destroy(); } catch (_) {} });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const bridge = createBridge(options);
  let signalled = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (signalled) { bridge.stopChild(); return; }
      signalled = true;
      // Give the agent a chance to end the turn cleanly (so its session file
      // records the interruption) before the child is stopped.
      bridge.cancel().finally(() => bridge.stopChild());
    });
  }
  bridge.exited.then(({ code }) => {
    if (process.exitCode == null && code) process.exitCode = code;
  });
  const run = options.resident ? runResident : runOneShot;
  run(options, bridge).catch(error => reportFailure(options.label, error, 'bridge'));
}

if (require.main === module) main();

module.exports = { createBridge, normalizeUsage, parseArgs, pickPermissionOption, routerMcpServers };
