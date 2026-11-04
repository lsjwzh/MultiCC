'use strict';

const { classifyProviderError } = require('../provider-error');

function opencodeProcessError(cli, raw, stderr) {
  // Keep raw evidence before truncation. A substantive RPC cause always wins.
  if (cli !== 'opencode' || (raw && raw.code !== 'agent_exited')) return null;
  const error = { source: 'process_stderr', provider: cli, message: stderr };
  return classifyProviderError(error, error) ? error : null;
}

module.exports = { opencodeProcessError };
