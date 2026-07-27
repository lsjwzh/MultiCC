#!/usr/bin/env node
'use strict';

const readline = require('readline');

const SERVER_NAME = 'multicc-router';
const SERVER_VERSION = '1.3.0';
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
    name: 'dispatch_master',
    title: 'Dispatch and await worker',
    description: 'Durably dispatch to a same-directory chat worker and await its persisted result. Terminal sessions require allow_terminal=true. Busy targets are queued and never interrupted.',
    inputSchema: {
      ...TARGET_SCHEMA,
      properties: {
        ...TARGET_SCHEMA.properties,
        timeout_seconds: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 21600,
          description: 'How long this tool call waits. Timeout does not cancel the durable dispatch.',
        },
      },
    },
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
    description: 'Complete the dispatch that created this turn. Call exactly once after finishing the assigned work so dispatch_master receives the persisted result. A server-side post-turn fallback also completes the dispatch if this tool is not called.',
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

async function callBridge(name, args, signal) {
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
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* handled below */ }
  if (!response.ok) {
    const code = payload && typeof payload.code === 'string' ? payload.code : 'router_error';
    const error = new Error(code);
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
      const result = await callBridge(tool.name, params.arguments || {}, controller.signal);
      write({ jsonrpc: '2.0', id, result: toolContent(result, false) });
    } catch (error) {
      const code = typeof error.code === 'string' ? error.code : 'router_error';
      write({
        jsonrpc: '2.0', id,
        result: toolContent({ ok: false, code }, true),
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
