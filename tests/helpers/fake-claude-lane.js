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
if (args.includes('--version')) { process.stdout.write('fake-claude 9.9.9\n'); process.exit(0); }
const success = request => ({ type: 'control_response',
  response: { subtype: 'success', request_id: request.request_id, response: {} } });
let initialized = false;
const queued = [];
const hookRequests = new Map();

function result(text, extra = {}) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: text,
    num_turns: 1, session_id: sessionId, ...extra });
}

// Hosts prepend managed-context boilerplate to the prompt; echo only the
// caller's marker so tests can assert on an exact string.
function markerOf(text) {
  return (text.match(/(?:PING|SLOW)_[A-Z0-9_]+/g) || []).pop() || text;
}

function handleUser(message) {
  const text = (message.message?.content || []).map(block => block.text || '').join('');
  if (scenario === 'held-attributed') {
    if (text === 'UNANSWERED') {
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] } });
      return;
    }
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] } });
    result(`echo:${text}`, { uuid: require('node:crypto').randomUUID(), user_message_uuid: message.uuid,
      user_message_uuids: [message.uuid], usage: { input_tokens: 3 }, total_cost_usd: 0.03 });
    return;
  }
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
  // Chat-events scenarios: a single prompt marker drives a shaped event stream
  // so tests/test-chat-events-isolated.js can exercise the reducer through a
  // real gateway + server without a real model.
  if (text.includes('EVT_TOOL_USE')) {
    emit({ type: 'stream_event', event: { type: 'content_block_start',
      index: 0, content_block: { type: 'tool_use', id: 'toolu_evt_1', name: 'Edit' } } });
    emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake',
      content: [{ type: 'tool_use', id: 'toolu_evt_1', name: 'Edit', input: { file_path: '/tmp/evt.txt' } }] } });
    emit({ type: 'user', session_id: sessionId, message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_evt_1',
        content: [{ type: 'text', text: 'patched' }] }] } });
    emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake',
      content: [{ type: 'text', text: 'TOOL_DONE' }] } });
    result('TOOL_DONE', { usage: { input_tokens: 11, output_tokens: 7 }, total_cost_usd: 0.02 });
    return;
  }
  if (text.includes('EVT_API_ERROR')) {
    const afterOutput = text.includes('AFTER_OUTPUT');
    if (afterOutput) {
      emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake',
        content: [{ type: 'text', text: 'genuine answer' }] } });
    }
    const error = { type: 'assistant', session_id: sessionId,
      uuid: `api-error-${process.pid}-${afterOutput ? 'after' : 'empty'}`,
      is_api_error_message: true, api_error_status: 500, request_id: 'req_evt_1', error: 'api_error',
      message: { role: 'assistant', model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: 500 upstream exploded' }] } };
    // Real CLIs repeat the same synthetic message with the same uuid; the
    // reducer must dedupe it. This emits it twice on purpose.
    emit(error); emit(error);
    if (text.includes('SUCCESS_RESULT')) {
      // Protocol success alone does not recover the synthetic API error.
      // Without a real answer, the host may still retry this error-only turn.
      result('synthetic-error-answer', { usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
      return;
    }
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
      num_turns: 1, session_id: sessionId });
    return;
  }
  if (text.includes('EVT_BG_TASK')) {
    emit({ type: 'system', subtype: 'task_started', task_id: 'bg_evt_1',
      description: 'background probe', session_id: sessionId });
    emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake',
      content: [{ type: 'text', text: 'BG_ACK' }] } });
    result('BG_ACK', { usage: { input_tokens: 3, output_tokens: 2 } });
    setTimeout(() => emit({ type: 'system', subtype: 'task_notification', task_id: 'bg_evt_1',
      status: 'completed', summary: 'background probe', output: 'bg done', session_id: sessionId }), 300);
    return;
  }
  if (text.includes('EVT_REPLAY')) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'replay-partial' } } });
    setTimeout(() => {
      emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake',
        content: [{ type: 'text', text: 'replay-done' }] } });
      result('replay-done', { usage: { input_tokens: 2, output_tokens: 2 } });
    }, 1500);
    return;
  }
  if (text.includes('EVT_ABORTED')) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'partial-before-abort' } } });
    emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', model: 'fake',
      content: [{ type: 'text', text: 'partial-before-abort' }] } });
    // An interrupted turn ends with an error result that carries no `result` key.
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
      terminal_reason: 'aborted_tools', num_turns: 1, session_id: sessionId });
    return;
  }
  if (scenario === 'slow' || text.includes('SLOW')) { setTimeout(() => result(`slow:${markerOf(text)}`), 5000); return; }
  emit({ type: 'stream_event', event: { type: 'content_block_delta',
    delta: { type: 'text_delta', text: `echo:${markerOf(text)}` } } });
  emit({ type: 'assistant', session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text: `echo:${markerOf(text)}` }] } });
  result(`echo:${markerOf(text)}`);
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
