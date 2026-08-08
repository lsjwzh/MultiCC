#!/usr/bin/env node
'use strict';

const readline = require('readline');

const SERVER_NAME = 'multicc-router';
const SERVER_VERSION = '1.6.0';
const BASE_URL = String(process.env.MULTICC_BASE_URL || '').replace(/\/+$/, '');
const CAPABILITY = String(process.env.MULTICC_ROUTER_CAPABILITY || '');

const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['target_session_id', 'message'],
  properties: {
    target_session_id: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Stable same-directory target session id. Terminal targets require allow_terminal=true.',
    },
    message: {
      type: 'string',
      minLength: 1,
      maxLength: 262144,
      description: 'Complete self-contained task instructions for the target session.',
    },
    idempotency_key: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^[A-Za-z0-9._:-]+$',
      description: 'Optional stable retry key. Omit to use the current turn-scoped deterministic key.',
    },
    allow_terminal: {
      type: 'boolean',
      default: false,
      description: 'Set true only when the originating user message names this terminal session by its exact id or complete label. Mentioning terminal/CLI software is not sufficient.',
    },
  },
};

const DISPATCH_MASTER_SCHEMA = {
  ...TARGET_SCHEMA,
  required: [...TARGET_SCHEMA.required, 'mode'],
  properties: {
    ...TARGET_SCHEMA.properties,
    mode: {
      type: 'string',
      enum: ['sync', 'async'],
      description: 'sync keeps this tool call open and streams safe provider-emitted reasoning plus worker progress before returning the final result inline. async returns after admission and later wakes this session with a new result message.',
    },
    timeout_seconds: {
      type: 'number',
      minimum: 1,
      maximum: 21600,
      description: 'Maximum synchronous attachment time (up to 6 hours). Valid only for mode=sync.',
    },
  },
};

const DISPATCH_CANCEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operation_id'],
  properties: {
    operation_id: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Operation id (op_...) returned by this session\'s own route_task/dispatch_master call.',
    },
    reason: {
      type: 'string',
      maxLength: 500,
      description: 'Optional cancellation reason recorded on the operation.',
    },
    cancel_running: {
      type: 'boolean',
      default: false,
      description: 'Set true to also interrupt the target turn when the task already left the FIFO and is running.',
    },
  },
};

const DISPATCH_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation_id: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Optional operation id. Omit it to recover/list dispatches owned by this session after an ambiguous tool interruption.',
    },
    target_session_id: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Optional target filter when operation_id is unknown.',
    },
    active_only: {
      type: 'boolean',
      default: true,
      description: 'List only non-terminal dispatches by default.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
    },
  },
};

const USER_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: {
    question: {
      type: 'string',
      minLength: 1,
      maxLength: 16384,
      description: 'The exact blocking question the user must answer before work can continue.',
    },
    reason: {
      type: 'string',
      maxLength: 4096,
      description: 'Optional concise explanation of why the task cannot safely continue.',
    },
    options: {
      type: 'array',
      maxItems: 12,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 512 },
      description: 'Optional user-facing choices. Omit for free-text input.',
    },
    allow_multiple: {
      type: 'boolean',
      default: false,
      description: 'Whether the user may select more than one option.',
    },
  },
};

const EXTERNAL_WAIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'reason'],
  properties: {
    mode: {
      type: 'string',
      enum: ['callback', 'delay'],
      description: 'callback waits for an authenticated external POST; delay schedules a durable wake-up.',
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      description: 'Concise reason for waiting. For delay mode this is included in the trusted wake-up envelope.',
    },
    timeout_seconds: {
      type: 'number',
      minimum: 10,
      maximum: 604800,
      description: 'Callback expiry, from 10 seconds through 7 days. Valid only for callback mode.',
    },
    delay_seconds: {
      type: 'number',
      minimum: 1,
      maximum: 604800,
      description: 'Durable delay, from 1 second through 7 days. Required for delay mode.',
    },
    idempotency_key: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^[A-Za-z0-9._:-]+$',
      description: 'Optional stable retry key. Reuse it only for the exact same wait.',
    },
  },
};

const EXTERNAL_WAIT_ID_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['wait_id'],
  properties: {
    wait_id: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^wait-router-[a-f0-9]{24}$',
      description: 'Wait id returned by wait_for_external_result in this session.',
    },
  },
};

const TOOLS = [
  {
    name: 'wait_for_user_answer',
    title: 'Wait for user answer',
    description: 'Call this before ending a turn with a blocking question: when a user decision, confirmation, choice, or missing required information is necessary and work cannot safely continue. It records the structured question card and returns immediately; then present the same question as the final response and stop the turn without running more tools.',
    inputSchema: USER_INPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'request_user_input',
    title: 'Wait for user answer (legacy alias)',
    description: 'Backward-compatible alias for wait_for_user_answer. Prefer wait_for_user_answer for a blocking question.',
    inputSchema: USER_INPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'wait_for_external_result',
    title: 'Wait for external result',
    description: 'Register a durable callback or delay for the current session. It never accepts a session id, command, URL to poll, or arbitrary injected message. Callback capability URLs are returned only by the first successful registration; an idempotent replay never rotates or re-exposes the secret.',
    inputSchema: EXTERNAL_WAIT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'get_external_wait',
    title: 'Get external wait',
    description: 'Read the bounded status of a durable external wait created by this session.',
    inputSchema: EXTERNAL_WAIT_ID_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'cancel_external_wait',
    title: 'Cancel external wait',
    description: 'Cancel a pending durable external wait created by this session. Resolved waits cannot be cancelled.',
    inputSchema: EXTERNAL_WAIT_ID_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'route_task',
    title: 'Route task (one way)',
    description: 'Durably queue a one-way task for an existing same-directory worker. Prefer an existing chat worker. Terminal sessions require exact user targeting plus allow_terminal=true. Returns after admission and never recollects the result.',
    inputSchema: TARGET_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'dispatch_cancel',
    title: 'Cancel a dispatched task',
    description: 'Cancel a task this session previously queued via route_task/dispatch_master — the required first step before re-routing. A task still sitting in the target FIFO is removed silently (the worker never sees it); one already running needs cancel_running=true and interrupts the target turn. Idempotent; an already-terminal operation reports its real status.',
    inputSchema: DISPATCH_CANCEL_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'dispatch_status',
    title: 'Recover dispatch status',
    description: 'Read authoritative durable dispatch and target FIFO/running state for operations owned by this session. Use this after any dispatch_master timeout, terminated stream, network error, or missing receipt. Such errors do not prove that the worker stopped. Never re-route the same task until dispatch_status shows a terminal operation or dispatch_cancel confirms cancellation.',
    inputSchema: DISPATCH_STATUS_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'dispatch_master',
    title: 'Dispatch to worker',
    description: 'Durably dispatch to a same-directory worker. mode=sync keeps this call pending, streams safe provider-emitted reasoning and worker dialogue progress, and returns the final worker result inline without dispatch_slave or a new chat message. mode=async returns after admission; do not poll or inspect the worker—continue only independent work and end naturally, then MultiCC wakes this session with the dispatch_slave result as a new message. Busy targets are queued and never interrupted. A timeout, terminated stream, or transport error never proves that the admitted task stopped: recover with dispatch_status, then wait or cancel before re-routing.',
    inputSchema: DISPATCH_MASTER_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

TOOLS.push({
    name: 'dispatch_slave',
    title: 'Return dispatch result',
    description: 'Complete the async dispatch that created this turn. Call exactly once after finishing so the result is inserted into and wakes the caller session. Sync dispatches complete automatically from the final turn output and reject this tool.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['result'],
      properties: {
        result: {
          type: 'string',
          minLength: 1,
          maxLength: 524288,
          description: 'Concise final result including verification and remaining risks.',
        },
        status: {
          type: 'string',
          enum: ['completed', 'failed'],
          default: 'completed',
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
});

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolContent(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

async function readNdjson(response, onProgress) {
  if (!response.body) throw new Error('router stream ended without a body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.type === 'progress') onProgress?.(frame.progress || {});
      if (frame.type === 'result') finalResult = frame.result;
      if (frame.type === 'error') {
        const error = new Error(frame.message || frame.code || 'router_error');
        error.code = frame.code || 'router_error';
        throw error;
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const frame = JSON.parse(buffer);
    if (frame.type === 'progress') onProgress?.(frame.progress || {});
    if (frame.type === 'result') finalResult = frame.result;
    if (frame.type === 'error') {
      const error = new Error(frame.message || frame.code || 'router_error');
      error.code = frame.code || 'router_error';
      throw error;
    }
  }
  if (finalResult === undefined) throw new Error('router stream ended without a result');
  return finalResult;
}

async function callBridge(name, args, signal, onProgress) {
  if (!BASE_URL || !CAPABILITY) throw new Error('MultiCC router environment is unavailable');
  const response = await fetch(`${BASE_URL}/api/internal/router-tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-multicc-router-capability': CAPABILITY,
    },
    body: JSON.stringify({ arguments: args || {} }),
    signal,
  });
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/x-ndjson')) {
    return readNdjson(response, onProgress);
  }
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* handled below */ }
  if (!response.ok) {
    const code = payload && typeof payload.code === 'string' ? payload.code : 'router_error';
    const detail = payload && (payload.error || payload.message);
    const error = new Error(detail ? `${code}: ${detail}` : code);
    error.code = code;
    throw error;
  }
  return payload && Object.prototype.hasOwnProperty.call(payload, 'result')
    ? payload.result
    : payload;
}

const inflight = new Map();

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'notifications/cancelled') {
    inflight.get(message.params?.requestId)?.abort();
    return;
  }
  if (message.id == null) return;
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return;
  }
  if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(entry => entry.name === params.name);
    if (!tool) {
      write({
        jsonrpc: '2.0', id,
        result: toolContent({ ok: false, code: 'unknown_tool' }, true),
      });
      return;
    }
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      const progressToken = params._meta?.progressToken;
      let progress = 0;
      const result = await callBridge(
        tool.name,
        params.arguments || {},
        controller.signal,
        progressToken == null ? null : update => write({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: ++progress,
            message: String(update?.message || update?.kind || 'worker progress'),
          },
        }),
      );
      write({ jsonrpc: '2.0', id, result: toolContent(result, false) });
    } catch (error) {
      const interrupted = error?.name === 'AbortError'
        || error?.code === 'tool_call_cancelled'
        || /terminated|abort|cancelled|stream ended without a result/i.test(String(error?.message || ''));
      const code = interrupted
        ? 'router_call_interrupted'
        : (typeof error.code === 'string' ? error.code : 'router_error');
      const message = interrupted
        ? 'The router call ended without a terminal receipt. This does not cancel an admitted dispatch. Call dispatch_status (filter by target_session_id if operation_id is unknown); do not re-route until the original is terminal or dispatch_cancel succeeds.'
        : (error.message || code);
      write({
        jsonrpc: '2.0', id,
        result: toolContent({
          ok: false, code, message,
          ...(interrupted ? { recovery_tool: 'dispatch_status' } : {}),
        }, true),
      });
    } finally {
      inflight.delete(id);
    }
    return;
  }
  rpcError(id, -32601, 'Method not found');
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  // Do not serialize calls: dispatch_master may legitimately remain pending
  // while Codex sends cancellation or other protocol traffic.
  handle(message).catch(() => {
    if (message && message.id != null) rpcError(message.id, -32603, 'Internal error');
  });
});
