'use strict';

// Frozen copy of the retired `conclusionFromHistory` rule, kept ONLY as the
// oracle for docs/rust-migration/differential/latest-assistant-conclusion.js.
// Production code must not require this file.
//
// The retired path cloned the whole history into Node, then paged it eight
// messages at a time across the FFI; per page the Rust core took the last
// message with `role === 'assistant'` whose text is non-empty after trim, then
// redacted and clipped it. Message selection and text extraction were exactly
// the logic below. Redaction and clipping are still the shared `clipText` op,
// because that is the same Rust function the retired page rule called.
//
// Text extraction and `String.prototype.trim` are done here in plain JS on
// purpose: they are an independent source of truth for the Rust implementation.

const os = require('node:os');
const { getNative } = require('../../src/native/runtime');

const HISTORY_PAGE = 8;
const native = getNative();
const CATALOG = JSON.parse(native.eventsCatalog());
const request = (op, input) => JSON.parse(native.eventsRequest(op, JSON.stringify(input)));

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block)
    .filter((block) => block && block.type === 'text')
    .filter((block) => typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function conclusionFromHistory(history) {
  if (!Array.isArray(history)) return '';
  const home = os.homedir();
  for (let end = history.length; end > 0; end -= HISTORY_PAGE) {
    const page = history.slice(Math.max(0, end - HISTORY_PAGE), end)
      .map((message) => (message && message.role === 'assistant' ? message : null));
    for (let i = page.length - 1; i >= 0; i -= 1) {
      const message = page[i];
      if (!message) continue;
      const text = contentText(message.content).trim();
      if (text) return request('clipText', { text, max: String(CATALOG.conclusionMax), home });
    }
  }
  return '';
}

module.exports = { conclusionFromHistory };
