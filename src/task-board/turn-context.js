'use strict';

// Compiles the task context wall injected as a task-bound session's first-turn
// prompt prefix (message-composer task-context layer). Redaction, budgeting and
// rendering live in the Rust kernel (native/core/src/task_run_context.rs); this
// bridge only projects the board record onto the fields the kernel reads and
// tags the values JSON cannot carry.
//
// Two kinds of value need a marker because the wire is JSON:
//   { "$multiccText": base64(utf16le) }  a string holding a lone surrogate
//   { "$multiccBuffer": base64 }         a Buffer (content/digest inputs)
//   { "$multiccNumber": "NaN" }          NaN/Infinity/-0, which JSON drops
//   { "$multiccUndefined": true }        an own property/element set to undefined
// A plain `JSON.stringify` would turn lone surrogates into U+FFFD (the kernel's
// lenient decoder rewrites them) and would flatten a Buffer into
// {"type":"Buffer","data":...}. The kernel restores both before applying rules,
// and emits results with JSON.stringify byte semantics so a lone surrogate cut
// out of a surrogate pair survives the trip back.
const { getNative } = require('../native/runtime');

const TASK_KEYS = ['id', 'taskId', 'title', 'name', 'status', 'summary', 'description', 'areas'];
const MESSAGE_KEYS = ['text', 'content', 'body', 'role', 'ts', 'timestamp', 'createdAt', 'id', 'messageId'];
const INPUT_KEYS = ['task', 'messages', 'artifacts', 'currentText', 'maxChars', 'version', 'includeCurrent'];

function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { index += 1; continue; }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

// Undefined has to survive as a marker: `stableStringify` prints `undefined`
// inside objects and nothing inside arrays, so dropping the key would change
// rendered content and artifact digests. Circular input (impossible for
// persisted JSON, but the old implementation tolerated it) degrades to a
// placeholder string.
function toWire(value, seen = new Set()) {
  if (value === undefined) return { $multiccUndefined: true };
  if (typeof value === 'string') {
    return hasLoneSurrogate(value)
      ? { $multiccText: Buffer.from(value, 'utf16le').toString('base64') }
      : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { $multiccNumber: String(value) };
    if (Object.is(value, -0)) return { $multiccNumber: '-0' };
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return { $multiccBuffer: value.toString('base64') };
  if (seen.has(value)) return '[circular reference]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => toWire(item, seen));
    const out = {};
    for (const key of Object.keys(value)) {
      const next = toWire(value[key], seen);
      if (next !== undefined) out[key] = next;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

// Property reads are what the kernel would otherwise do on a large object over
// FFI: keep only the keys it consumes. Primitives and null pass through so the
// kernel can apply the same coercion the JS implementation used.
function projectObject(source, keys) {
  if (source === null || typeof source !== 'object') return source;
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function toCommand(options) {
  const command = {};
  for (const key of INPUT_KEYS) if (options[key] !== undefined) command[key] = options[key];
  if (command.task !== undefined) command.task = projectObject(command.task, TASK_KEYS);
  if (Array.isArray(command.messages)) {
    command.messages = command.messages.map(message => projectObject(message, MESSAGE_KEYS));
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
  const result = JSON.parse(addon.buildTaskRunContext(JSON.stringify(toWire(command))));
  if (result && typeof result.$error === 'string') throw new TypeError(result.$error);
  return result;
}

module.exports = { buildTaskRunContext };
