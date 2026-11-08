#!/usr/bin/env node

// One-shot `claude-exp` lane. The adapter spawns this file with a prompt in
// argv and reads stream-json lines from stdout. It used to wrap
// `query()` from @anthropic-ai/claude-agent-sdk; it now drives the same native
// `claude` binary through the native lane (Rust), so no SDK JavaScript runs.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { getNative } = require('../native/runtime');
const { bundledClaudeCodeBinary } = require('../cli/claude-bundled-binary');
const { isMainResult } = require('../cli-adapters/result-completion');

export function parseArgs(argv) {
  const options = { disallowedTools: [] };
  let prompt = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      prompt = argv.slice(i + 1).join(' ');
      break;
    }
    if (arg === '--session-id') options.sessionId = argv[++i];
    else if (arg === '--resume') options.resume = argv[++i];
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--effort') options.effort = argv[++i];
    else if (arg === '--agent') options.agent = argv[++i];
    else if (arg === '--system-prompt') options.systemPrompt = argv[++i];
    else if (arg === '--settings') options.settings = argv[++i];
    else if (arg === '--max-turns') options.maxTurns = Number(argv[++i]);
    else if (arg === '--disallowed-tools-json') {
      const parsed = JSON.parse(argv[++i]);
      if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
        throw new Error('invalid --disallowed-tools-json');
      }
      options.disallowedTools = parsed;
    } else if (arg === '--router-node') options.routerNode = argv[++i];
    else if (arg === '--router-script') options.routerScript = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!prompt) throw new Error('prompt is required');
  if (options.sessionId && options.resume) throw new Error('--session-id and --resume are mutually exclusive');
  return { options, prompt };
}

// Flat shape for `RustClaudeLane.start()`; the native kernel assembles argv,
// env and the private settings file exactly as the SDK transport did.
export function laneConfig(input) {
  const settings = input.settings ? JSON.parse(fs.readFileSync(input.settings, 'utf8')) : {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-sdk-'));
  fs.chmodSync(dir, 0o700);
  const config = {
    cwd: process.cwd(),
    env: { ...process.env },
    settings,
    settingsPath: path.join(dir, 'settings.json'),
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    hookCallback: false,
  };
  if (input.sessionId) config.sessionId = input.sessionId;
  if (input.resume) { config.sessionId = input.resume; config.resume = true; }
  if (input.model) config.model = input.model;
  if (input.effort) config.effort = input.effort;
  if (input.agent) config.agent = input.agent;
  if (Number.isSafeInteger(input.maxTurns) && input.maxTurns > 0) config.maxTurns = input.maxTurns;
  if (input.systemPrompt) config.systemPromptAppend = input.systemPrompt;
  if (input.disallowedTools.length) config.disallowedTools = input.disallowedTools;
  if (input.routerNode && input.routerScript) {
    config.mcpServers = {
      multicc_router: { command: input.routerNode, args: [input.routerScript] },
    };
  }
  return config;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function defaultCreateLane(callback) {
  const binary = bundledClaudeCodeBinary();
  if (!binary) throw new Error('Bundled Claude Code binary is not available');
  const lane = new (getNative().RustClaudeLane)(callback);
  return { lane, binary };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function run(argv = process.argv.slice(2), createLane = defaultCreateLane, emit = write) {
  const { options, prompt } = parseArgs(argv);
  const config = laneConfig(options);
  const made = await createLane((payload) => {
    const [kind, a, b] = Array.isArray(payload) ? payload : [payload];
    onEvent(kind, a, b);
  });
  const lane = made.lane || made;
  const binary = made.binary || process.env.MULTICC_CLAUDE_BIN || bundledClaudeCodeBinary();
  if (!binary) throw new Error('Bundled Claude Code binary is not available');
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  let failure = null;
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  function onEvent(kind, a, b) {
    if (kind === 'message') {
      let message;
      try { message = JSON.parse(a); } catch (error) { failure = error; settle(); return; }
      emit(message);
      let main = false;
      try { main = isMainResult(message); } catch (_) { main = false; }
      if (main) settle();
      return;
    }
    if (kind === 'hook_callback') {
      // One-shot runs register no hooks, but answer defensively so the child
      // is never left waiting on a 30s host-hook deadline.
      try { lane.respondControl(a, '{}'); } catch (_) { /* lane closed */ }
      return;
    }
    if (kind === 'control_cancel') return;
    if (kind === 'error') { failure = new Error(a || 'Claude Code protocol error'); settle(); return; }
    if (kind === 'exit') {
      exited = true;
      if (a !== '' && Number.isInteger(Number(a))) exitCode = Number(a);
      try { exitSignal = JSON.parse(b)?.signal || null; } catch (_) { /* meta is best-effort */ }
      settle();
    }
  }
  // A napi ThreadsafeFunction does not hold the Node event loop open, and a
  // one-shot bridge has no sockets of its own: without a ref'd handle Node can
  // exit (code 13) while the turn is still waiting for a result delivered from
  // Rust. Keep exactly one ref'd timer for the life of the run.
  const keepAlive = setInterval(() => {}, 1 << 30);
  try {
    let startupError = null;
    try {
      await lane.start(JSON.stringify({ ...config, binary, binaryArgs: [] }));
      const user = {
        type: 'user', session_id: config.sessionId, uuid: crypto.randomUUID(), parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      };
      await lane.sendUser(JSON.stringify(user));
      await done;
    } catch (error) {
      // A startup failure can reject sendUser (initialize never succeeded)
      // before the exit event is delivered; keep the exit status authoritative.
      startupError = error;
    }
    try { lane.closeInput(); } catch (_) { /* already closed */ }
    for (let i = 0; i < 40 && !exited; i += 1) await sleep(50);
    if (!exited) { try { lane.kill('SIGTERM'); } catch (_) { /* already gone */ } }
    for (let i = 0; i < 20 && !exited; i += 1) await sleep(50);
    let tail = '';
    try { tail = lane.stderrTail() || ''; } catch (_) { /* lane gone */ }
    // The SDK transport treats a non-zero child exit as a failed run even when
    // every message was already emitted (for example `error_max_turns`), and it
    // appends the stderr tail to that error (session collisions live there).
    const suffix = tail.trim() ? `\n${tail.trim()}` : '';
    if (exitCode !== null && exitCode !== 0) throw new Error(`Claude Code process exited with code ${exitCode}${suffix}`);
    if (exitSignal) throw new Error(`Claude Code process terminated by ${exitSignal}${suffix}`);
    if (failure) throw failure;
    if (startupError) throw startupError;
  } finally {
    clearInterval(keepAlive);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write({ type: 'system', subtype: 'sdk_error', error: message.slice(0, 4000) });
    process.stderr.write(`[claude-exp] ${message}\n`);
    process.exitCode = 1;
  }
}
