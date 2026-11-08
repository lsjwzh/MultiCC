#!/usr/bin/env node
'use strict';
// A deterministic stand-in for `claude --output-format stream-json ...`.
//
// It speaks the same newline-delimited JSON control envelope as the real
// binary, so the native lane can be exercised without network or a real model.
// The scenario is selected with FAKE_CLAUDE_SCENARIO; every received line is
// appended to FAKE_CLAUDE_LOG when that is set.
const fs = require('node:fs');
const readline = require('node:readline');

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'basic';
const logFile = process.env.FAKE_CLAUDE_LOG;
const sessionArg = args.find(value => value.startsWith('--session-id='))
  || args.find(value => value.startsWith('--resume='));
const sessionId = sessionArg ? sessionArg.slice(sessionArg.indexOf('=') + 1) : 'fake-session';
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ __fake: 'spawn', pid: process.pid, argv: args, env: process.env })}\n`);
const success = request => ({ type: 'control_response',
  response: { subtype: 'success', request_id: request.request_id, response: {} } });
let initialized = false;
const queued = [];
const hookRequests = new Map();

function result(text, extra = {}) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: text,
    num_turns: 1, session_id: sessionId, ...extra });
}

function handleUser(message) {
  const text = (message.message?.content || []).map(block => block.text || '').join('');
  if (scenario === 'delayed-exit-output' || scenario === 'held-exit-output') {
    // 父进程先退出；继承输出管道的短命子进程稍后写入终局帧。
    const { spawn } = require('node:child_process');
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: '完整终局', session_id: sessionId }) + '\n';
    const delay = scenario === 'held-exit-output' ? 1500 : 80;
    spawn(process.execPath, ['-e', `process.stdout.on('error', () => {}); setTimeout(() => process.stdout.write(${JSON.stringify(line)}), ${delay})`],
      { stdio: ['ignore', 'inherit', 'ignore'] });
    process.exit(0);
  }
  if (scenario === 'malformed-then-result') {
    process.stdout.write('这不是 JSON\n' + JSON.stringify({ type: 'result', subtype: 'success', result: '不能交付' }) + '\n');
    return;
  }
  if (scenario === 'split-stderr') {
    const bytes = Buffer.from('中文错误尾部');
    let at = 0;
    const timer = setInterval(() => {
      if (at === bytes.length) { clearInterval(timer); process.exit(3); }
      else process.stderr.write(bytes.subarray(at, ++at));
    }, 5);
    return;
  }
  if (scenario === 'hook') {
    const requestId = `hookreq-${hookRequests.size + 1}`;
    hookRequests.set(requestId, text);
    emit({ type: 'control_request', request_id: requestId, request: {
      subtype: 'hook_callback', callback_id: 'hook_0',
      input: { hook_event_name: 'UserPromptSubmit', prompt: text, source: 'user', prompt_id: 'p1' },
    } });
    return;
  }
  if (scenario === 'hang') return;
  if (scenario === 'missing-history') {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1,
      session_id: sessionId, result: `No conversation found with session ID: ${sessionId}` });
    return;
  }
  if (scenario === 'slow' || text.includes('SLOW')) { setTimeout(() => result(`slow:${text}`), 5000); return; }
  emit({ type: 'stream_event', event: { type: 'content_block_delta',
    delta: { type: 'text_delta', text: `echo:${text}` } } });
  emit({ type: 'assistant', session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] } });
  result(`echo:${text}`);
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  if (message.type === 'control_response') {
    const requestId = message.response?.request_id;
    if (requestId && hookRequests.has(requestId)) {
      hookRequests.delete(requestId);
      const decision = message.response.response?.decision || 'allowed';
      emit({ type: 'assistant', session_id: sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: `hook:${decision}` }] } });
      result(`hook:${decision}`);
    }
    return;
  }
  if (message.type !== 'control_request') {
    if (message.type === 'user') {
      if (initialized) handleUser(message); else queued.push(message);
    }
    return;
  }
  const request = message.request || {};
  if (request.subtype === 'initialize') {
    if (scenario === 'unresponsive-initialize') {
      process.on('SIGTERM', () => {});
      return;
    }
    emit({ type: 'control_response', response: { subtype: 'success',
      request_id: message.request_id,
      response: { commands: [], output_style: 'default', hooks_applied: true } } });
    initialized = true;
    emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake',
      tools: [], permissionMode: 'bypassPermissions' });
    for (const held of queued.splice(0)) handleUser(held);
    return;
  }
  if (request.subtype === 'interrupt') {
    // `stalled-interrupt` never answers: the host must fall back to SIGTERM.
    if (scenario === 'stalled-interrupt') return;
    emit(success(message));
    // The real CLI acks first and then ends the aborted turn with an error
    // result that carries no `result` key (aborted_tools).
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
      terminal_reason: 'aborted_tools', num_turns: 1, session_id: sessionId });
    return;
  }
  if (request.subtype === 'set_model') { emit(success(message)); return; }
  if (request.subtype === 'get_task_output') {
    emit({ type: 'control_response', response: { subtype: 'success',
      request_id: message.request_id,
      response: { output: `fake:${request.task_id}`, total_bytes: 4, truncated: false } } });
    return;
  }
  if (request.subtype === 'stop_task') { emit(success(message)); return; }
  emit({ type: 'control_response', response: { subtype: 'error',
    request_id: message.request_id, error: 'unsupported control request' } });
});
input.on('close', () => { process.exit(0); });
