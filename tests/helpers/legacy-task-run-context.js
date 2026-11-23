'use strict';

// Compiles the task context wall injected as a task-bound session's first-turn
// prompt prefix (message-composer task-context layer). Redaction, budgeting and
// rendering live in the Rust kernel (native/core/src/task_run_context.rs); this
// bridge only projects the board record onto the fields the kernel reads and
// precomputes the one engine-defined rule the kernel cannot own.
//
// The addon now accepts a real JavaScript value (`native/addon/src/js_bridge.rs`),
// so no wire markers are needed: lone surrogates, `undefined`, `NaN`, `-0`,
// Buffers and Dates all cross the boundary intact.
//
// `Date.parse` stays in JS because it parses natural-language dates with the
// engine's ICU data. The kernel reads a message timestamp as
// `ts ?? timestamp ?? createdAt`, uses it directly when it is a finite number,
// and otherwise only applies `Number(string)`. So when the first non-nullish
// field is a string that `Number()` cannot read but `Date.parse` can, replace
// it with the parsed milliseconds before the value crosses.
const { getNative } = require('../native/runtime');

const TASK_KEYS = ['id', 'taskId', 'title', 'name', 'status', 'summary', 'description', 'areas'];
const MESSAGE_KEYS = ['text', 'content', 'body', 'role', 'ts', 'timestamp', 'createdAt', 'id', 'messageId'];
const INPUT_KEYS = ['task', 'messages', 'artifacts', 'currentText', 'maxChars', 'version', 'includeCurrent'];

// Property reads are what the kernel would otherwise do on a large object over
// FFI: keep only the keys it consumes. Primitives and null pass through so the
// kernel can apply the same coercion the JS implementation used.
function projectObject(source, keys) {
  if (source === null || typeof source !== 'object') return source;
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

// Mirrors `normalizeTimestamp(ts ?? timestamp ?? createdAt)`: only the first
// non-nullish field matters, and only a string can need `Date.parse`.
function precomputeTimestamp(message) {
  for (const key of ['ts', 'timestamp', 'createdAt']) {
    const value = message[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) return;
    if (Number.isFinite(Number(value))) return;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) message[key] = parsed;
    return;
  }
}

function toCommand(options) {
  const command = {};
  for (const key of INPUT_KEYS) if (options[key] !== undefined) command[key] = options[key];
  if (command.task !== undefined) command.task = projectObject(command.task, TASK_KEYS);
  if (Array.isArray(command.messages)) {
    command.messages = command.messages.map((message) => {
      const projected = projectObject(message, MESSAGE_KEYS);
      if (projected !== message) precomputeTimestamp(projected);
      return projected;
    });
  }
  return command;
}

// Destructuring stays in the parameter list so that `buildTaskRunContext(null)`
// throws the same engine-level TypeError the JS implementation threw, before
// the kernel ever runs.
function buildTaskRunContext({
  task,
  messages,
  artifacts,
  currentText,
  maxChars,
  version,
  includeCurrent,
} = {}) {
  const addon = getNative();
  if (typeof addon.buildTaskRunContext !== 'function') {
    throw new Error('任务上下文 Rust 接口不可用，请构建当前原生模块');
  }
  const command = toCommand({ task, messages, artifacts, currentText, maxChars, version, includeCurrent });
  const result = addon.buildTaskRunContext(command);
  if (result && typeof result.$error === 'string') throw new TypeError(result.$error);
  return result;
}

module.exports = { buildTaskRunContext };
