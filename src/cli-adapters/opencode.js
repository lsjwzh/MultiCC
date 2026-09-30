'use strict';

const { createAcpAdapter } = require('./acp');
const { createOpencodeLikeAdapter } = require('./opencode-like');

// OpenCode runs over ACP (`opencode acp`) through acp-bridge.cjs: streamed
// text/thinking, live tool cards, an authoritative stopReason and in-place
// session/cancel. Session ids (ses_…) are the same ids `opencode run --session`
// uses, so conversations started on the old JSON lane resume unchanged.
// MULTICC_OPENCODE_LEGACY_JSON=1 restores the `run --format json` lane.
const { displayNameOf } = require('../cli/cli-capability');

const LABEL = displayNameOf('opencode');

function createOpencodeAdapter({
  cmd, userInputReminder = '', routerMcpNode = null, routerMcpScript = null,
  env = process.env,
}) {
  if (env.MULTICC_OPENCODE_LEGACY_JSON === '1') {
    return createOpencodeLikeAdapter({
      name: 'opencode', label: LABEL, cmd, supportsAgentVariant: true,
      includeThinking: true, userInputReminder,
    });
  }
  return createAcpAdapter({
    name: 'opencode', label: LABEL, cmd, agentArgs: ['acp'],
    // OpenCode agents (build/plan) are ACP session modes.
    agentViaMode: true,
    routerMcpNode, routerMcpScript, userInputReminder,
    terminalCmd(session) {
      let command = cmd;
      if (session.model) command += ` --model ${session.model}`;
      if (session.effort) command += ` --variant ${session.effort}`;
      if (session.agent) command += ` --agent ${session.agent}`;
      if (session.cliSessionId) command += ` --session ${session.cliSessionId}`;
      return command;
    },
  });
}

module.exports = { createOpencodeAdapter };
