'use strict';

// Fixed event envelope: what a hook hands to the next action. Rule authors
// never define variables - they only write the instruction. Pure, no I/O.
//
//   sessionId, event, goal, goalState, conclusion, summary, error, taskId, ts
//
// `conclusion` = the last assistant reply of the source session (clipped and
// redacted). The next session can read the full history by `sessionId`. It is
// not computed here: the chat history runtime walks its cached messages from
// the tail (`latestAssistantConclusion`) and returns only the finished text.
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
const asText = text => String(text == null ? '' : text);

function redactText(text) {
  return request('redactText', { text: asText(text), home: os.homedir() });
}

function clipText(text, max) {
  // `length > max` and `slice(0, max)` both coerce max with ToNumber.
  return request('clipText', { text: asText(text), max: String(Number(max)), home: os.homedir() });
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
  redactText, clipText, summaryOf, renderInjection,
};
