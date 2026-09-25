'use strict';

const { createAcpAdapter } = require('./acp');

// Gemini CLI over ACP (`gemini --experimental-acp`). The model is fixed per
// process with `-m`; resume uses session/load (Gemini advertises loadSession,
// the bridge drops the replayed history). Auth is the CLI's own: `gemini` login
// (Google OAuth) or GEMINI_API_KEY in the environment.
function createGeminiAdapter({ cmd, routerMcpNode = null, routerMcpScript = null, userInputReminder = '' }) {
  return createAcpAdapter({
    name: 'gemini', label: 'Gemini', cmd,
    agentArgs: so => ['--experimental-acp', '--yolo', ...(so.rawModel ? ['-m', so.rawModel] : [])],
    modelViaArgv: true,
    effortViaConfig: false,
    routerMcpNode, routerMcpScript, userInputReminder,
    terminalCmd(session) {
      let command = cmd;
      if (session.model) command += ` -m ${session.model}`;
      if (session.cliSessionId) command += ` --resume ${session.cliSessionId}`;
      return command;
    },
  });
}

module.exports = { createGeminiAdapter };
