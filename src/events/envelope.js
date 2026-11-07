'use strict';

// Fixed event envelope: what a hook hands to the next action. Rule authors
// never define variables - they only write the instruction. Pure, no I/O.
//
//   sessionId, event, goal, goalState, conclusion, summary, error, taskId, ts
//
// `conclusion` = the last assistant reply of the source session (clipped and
// redacted). The next session can read the full history by `sessionId`.
//
// Redaction, clipping and rendering live in native/core/src/events.rs (the old
// regex had no `u` flag, so lengths count UTF-16 units; Rust keeps that). The
// home directory is read per call, as before.

const os = require('os');
const { getNative } = require('../native/runtime');

const native = getNative();
const CATALOG = JSON.parse(native.eventsCatalog());
const request = (op, input) => JSON.parse(native.eventsRequest(op, JSON.stringify(input)));

const CONCLUSION_MAX = CATALOG.conclusionMax;
const SUMMARY_MAX = CATALOG.summaryMax;
// Events that carry a conclusion; running/restarted/trigger.* never do.
const CONCLUSION_EVENTS = Object.freeze(new Set(CATALOG.conclusionEvents));
// History is scanned from the end in pages, so a long chat never crosses the
// bridge whole; the reply is almost always within the last page.
const HISTORY_PAGE = 8;

const asText = text => String(text == null ? '' : text);

function redactText(text) {
  return request('redactText', { text: asText(text), home: os.homedir() });
}

function clipText(text, max) {
  // `length > max` and `slice(0, max)` both coerce max with ToNumber.
  return request('clipText', { text: asText(text), max: String(Number(max)), home: os.homedir() });
}

// history: array of chat messages in order. Returns the last non-empty assistant reply.
function conclusionFromHistory(history) {
  if (!Array.isArray(history)) return '';
  const home = os.homedir();
  for (let end = history.length; end > 0; end -= HISTORY_PAGE) {
    // Non-assistant messages can never be the conclusion; send them as null.
    const messages = history.slice(Math.max(0, end - HISTORY_PAGE), end)
      .map(message => (message && message.role === 'assistant' ? message : null));
    const found = request('conclusionPage', { messages, home });
    if (found !== null) return found;
  }
  return '';
}

function summaryOf(state) {
  return clipText(state && state.lastSummary || '', SUMMARY_MAX);
}

// The text injected into the next session. The user's instruction goes last.
function renderInjection(event, instruction) {
  return request('renderInjection', { event, instruction });
}

module.exports = {
  CONCLUSION_MAX, SUMMARY_MAX, CONCLUSION_EVENTS,
  redactText, clipText, conclusionFromHistory, summaryOf, renderInjection,
};
