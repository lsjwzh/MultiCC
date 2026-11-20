'use strict';
// Frozen transcription of the connect-time chat_history frame byte budget,
// captured 2026-11-20 as the differential oracle for
// multicc_core::chat_history_frame.
//
// Source: src/chat/history-frame-budget.js, transcribed statement for
// statement. The budget exists because counting messages bounds nothing: a
// single tool-heavy assistant turn can serialize to several MB, and once the
// frame passes ws-backpressure's maxFrameBytes the socket is closed with 1013
// and the page reconnects forever (2026-10-01: a 4-message page of 9.2MB).
//
//   function fitHistoryFrame(messages, hasMore, { maxBytes, toolStringChars }) {
//     const list = Array.isArray(messages) ? messages : [];
//     const sizes = list.map(jsonBytes);
//     let total = sizes.reduce((sum, size) => sum + size, 0);
//     let start = 0;
//     while (total > maxBytes && list.length - start > 1) {
//       total -= sizes[start];
//       start += 1;
//     }
//     let kept = start > 0 ? list.slice(start) : list;
//     let clipped = false;
//     if (total > maxBytes) {
//       kept = kept.map(message => clipMessageTools(message, toolStringChars));
//       clipped = true;
//     }
//     return { messages: kept, hasMore: !!hasMore || start > 0, dropped: start, clipped };
//   }
//
// Three details decide the contract and are each easy to get wrong:
//
//   * `total` is NOT recomputed after clipping. The returned `clipped` flag
//     says the clip ran, not that the result now fits; a page of one huge
//     message stays over budget on purpose, because dropping it would send an
//     empty frame and the loop keeps at least one message.
//   * The size of a message is the byte length of ITS OWN JSON, summed. That
//     is not the frame's byte length (no array brackets, no commas, no
//     envelope), and the budget is deliberately compared against that sum.
//   * `jsonBytes` returns 0 when JSON.stringify throws (a cycle) or returns
//     undefined (a bare function/symbol). Such a message costs nothing and is
//     therefore never the reason anything is dropped.

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
  jsonBytes,
  clipString,
  clipValue,
  clipMessageTools,
  fitHistoryFrame,
};
