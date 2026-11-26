'use strict';

const { getNative } = require('../native/binding');
let api;
function history() { return api ??= getNative().responsesHistoryApi(); }

function createCodexHistoryHooks(options = {}) {
  const logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : null;
  return Object.freeze({
    onRequest(context) { return history().onRequest(context, logger); },
    onUpstreamRejected(context) { return history().onUpstreamRejected(context, logger); },
  });
}

module.exports = { createCodexHistoryHooks };
