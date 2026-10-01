'use strict';

// Byte budget for the connect-time chat_history frame.
//
// The connect replay sends the newest CHAT_HISTORY_PAGE messages as ONE WS
// frame. Counting messages bounds nothing: a single tool-heavy assistant turn
// can serialize to several MB, and once the frame passes ws-backpressure's
// maxFrameBytes the socket is closed with 1013. The page re-sends the same
// frame on every reconnect, so the page reconnects forever (2026-10-01: a
// 4-message page of 9.2MB). Raising the cap only moves the cliff.
//
// So the frame is fitted to a byte budget instead:
//   1. drop the oldest messages first (hasMore=true lets the page fetch them
//      over HTTP /history, which has no frame cap), keeping at least one;
//   2. if what is left is still over budget, clip oversized tool strings in
//      the replay copy. Both renderers already truncate tool results to 2000
//      characters, so this only removes bytes nobody sees on connect.
// The persisted transcript is never touched; callers pass the replay copy.

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOOL_STRING_CHARS = 16 * 1024;

function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch (_) { return 0; }
}

function clipString(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars on reconnect]`;
}

function clipValue(value, maxChars) {
  if (typeof value === 'string') return clipString(value, maxChars);
  if (Array.isArray(value)) return value.map(item => clipValue(item, maxChars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = clipValue(child, maxChars);
    return out;
  }
  return value;
}

function clipMessageTools(message, maxChars) {
  if (!message || !Array.isArray(message.tools) || message.tools.length === 0) return message;
  return {
    ...message,
    tools: message.tools.map(tool => (tool && typeof tool === 'object'
      ? { ...tool, input: clipValue(tool.input, maxChars), result: clipValue(tool.result, maxChars) }
      : tool)),
  };
}

function fitHistoryFrame(messages, hasMore, {
  maxBytes = DEFAULT_MAX_BYTES,
  toolStringChars = DEFAULT_TOOL_STRING_CHARS,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const sizes = list.map(jsonBytes);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (total > maxBytes && list.length - start > 1) {
    total -= sizes[start];
    start += 1;
  }
  let kept = start > 0 ? list.slice(start) : list;
  let clipped = false;
  if (total > maxBytes) {
    kept = kept.map(message => clipMessageTools(message, toolStringChars));
    clipped = true;
  }
  return {
    messages: kept,
    hasMore: !!hasMore || start > 0,
    dropped: start,
    clipped,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_TOOL_STRING_CHARS,
  fitHistoryFrame,
};
