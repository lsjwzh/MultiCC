'use strict';

// The official Antigravity CLI owns authentication and model configuration.
// ACP session/resume preserves conversations across MultiCC turn processes.
const { createAcpAdapter } = require('./acp');
const { displayNameOf } = require('../cli/cli-capability');
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function createAgyAdapter({ cmd, routerMcpNode = null, routerMcpScript = null }) {
  return createAcpAdapter({
    name: 'agy', label: displayNameOf('agy'), cmd,
    agentArgs: ['acp', '--dangerously-skip-permissions'],
    routerMcpNode, routerMcpScript,
    terminalCmd(session) {
      let command = quote(cmd);
      if (session.model) command += ` --model ${quote(session.model)}`;
      if (session.cliSessionId) command += ` --conversation ${quote(session.cliSessionId)}`;
      return command;
    },
  });
}
module.exports = { createAgyAdapter };
