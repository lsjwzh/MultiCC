'use strict';

// Byte budget for the connect-time chat_history frame.
//
// The rule belongs to `multicc_core::chat_history_frame`; this module is its
// JavaScript face and keeps the existing export shape. The budget exists
// because counting messages bounds nothing: a single tool-heavy assistant turn
// can serialize to several MB, and once the frame passes ws-backpressure's
// maxFrameBytes the socket is closed with 1013 — so the page re-sends the same
// oversized frame on every reconnect and reconnects forever (2026-10-01: a
// 4-message page of 9.2MB). Raising the cap only moves the cliff.
//
// So the frame is fitted to a byte budget instead:
//   1. drop the oldest messages first (hasMore=true lets the page fetch them
//      over HTTP /history, which has no frame cap), keeping at least one;
//   2. if what is left is still over budget, clip oversized tool strings in
//      the replay copy. Both renderers already truncate tool results to 2000
//      characters, so this only removes bytes nobody sees on connect.
// The persisted transcript is never touched; callers pass the replay copy.
//
// Why the page itself does not cross into Rust. The kernel takes the per-
// message SIZES and returns the decision; this module applies it. Copying the
// page across a JSON bridge was measured at 23-55x the cost of doing it here
// (an 896KB page: 0.10ms -> 5.48ms of blocked main thread), and it is paid on
// every reconnect, which arrive at a few per second across a fleet. Keeping
// the slice local also preserves what the retired function guaranteed: when
// nothing is dropped the caller gets back the very same array, not a clone.
// `chat_history_frame`'s own tests prove this three-part application is
// indistinguishable from the whole function on every corpus case.

const { getNative } = require('../native/runtime');

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOOL_STRING_CHARS = 16 * 1024;

// The one measurement the kernel cannot make without the page: a message's own
// JSON byte length. `JSON.stringify` yielding undefined (a function, a symbol)
// made `Buffer.byteLength` throw and the catch returned 0, so such a message
// costs nothing and is never the reason anything is dropped.
function messageBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch (_) { return 0; }
}

// JSON has no Infinity: `JSON.stringify` writes it as null, which the kernel
// would read as "a budget of 0" -- the opposite of the retired comparison,
// where `total > Infinity` is false and so nothing is ever dropped or clipped.
// `Infinity` is the natural way to say "no limit", so it is mapped to the
// largest safe integer, which behaves the same. NaN is deliberately NOT
// handled: it is a caller bug whose retired behaviour was already nonsense
// (`maxBytes: NaN` never drops, `toolStringChars: NaN` wrote "truncated NaN
// chars"), and no caller passes it.
function limit(value) {
  return value === Infinity ? Number.MAX_SAFE_INTEGER : value;
}

function fitHistoryFrame(messages, hasMore, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const request = { sizes: list.map(messageBytes), hasMore: !!hasMore };
  // Only a present option is forwarded, so the kernel applies the same
  // destructuring defaults the retired signature had.
  if (options && options.maxBytes !== undefined) request.maxBytes = limit(options.maxBytes);
  const plan = JSON.parse(getNative().chatHistoryFramePlan(JSON.stringify(request)));
  // `start > 0 ? list.slice(start) : list` — the identity case matters: a page
  // under budget is the common case and must not be copied.
  let kept = plan.dropped > 0 ? list.slice(plan.dropped) : list;
  if (plan.clipped) {
    const clip = { messages: kept };
    if (options && options.toolStringChars !== undefined) {
      clip.toolStringChars = limit(options.toolStringChars);
    }
    kept = JSON.parse(getNative().chatHistoryFrameClip(JSON.stringify(clip)));
  }
  return {
    messages: kept,
    hasMore: plan.hasMore,
    dropped: plan.dropped,
    clipped: plan.clipped,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_TOOL_STRING_CHARS,
  messageBytes,
  fitHistoryFrame,
};
