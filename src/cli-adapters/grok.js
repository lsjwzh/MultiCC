'use strict';

const { createAcpAdapter } = require('./acp');
const { displayNameOf } = require('../cli/cli-capability');

// Grok Build (@xai-official/grok) over ACP (`grok agent stdio`). Model and
// reasoning effort are launch flags of `grok agent` and must precede the
// `stdio` subcommand. --no-leader keeps every spawn on its own backend instead
// of attaching to a shared leader process a user may have enabled in
// config.toml; --always-approve matches the unattended lane (the bridge also
// auto-answers permission requests). Auth is the CLI's own (`grok login`).
function createGrokAdapter({ cmd, routerMcpNode = null, routerMcpScript = null, userInputReminder = '' }) {
  return createAcpAdapter({
    name: 'grok', label: displayNameOf('grok'), cmd,
    agentArgs: so => [
      'agent', '--no-leader', '--always-approve',
      ...(so.rawModel ? ['-m', so.rawModel] : []),
      ...(so.rawEffort ? ['--reasoning-effort', so.rawEffort] : []),
      'stdio',
    ],
    modelViaArgv: true,
    effortViaArgv: true,
    routerMcpNode, routerMcpScript, userInputReminder,
    terminalCmd(session) {
      let command = cmd;
      if (session.model) command += ` -m ${session.model}`;
      if (session.cliSessionId) command += ` --resume ${session.cliSessionId}`;
      return command;
    },
  });
}

module.exports = { createGrokAdapter };
