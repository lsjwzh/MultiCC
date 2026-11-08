'use strict';

const { getNative } = require('../native/runtime');

// The response still belongs to Node. Rust owns the incremental decoder,
// framing and decision about which SSE events count as model progress.
function createModelStreamProgress() {
  const state = new (getNative().RustModelStreamProgress)();
  return chunk => typeof chunk === 'string' ? state.feedText(chunk) : state.feed(Buffer.from(chunk));
}

module.exports = { createModelStreamProgress };
