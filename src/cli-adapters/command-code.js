'use strict';

const { createAcpAdapter } = require('./acp');
const { displayNameOf } = require('../cli/cli-capability');

function createCommandCodeAdapter({ cmd, routerMcpNode = null, routerMcpScript = null, env = process.env }) {
  const defaultModel = `deepseek/${env.DEEPSEEK_FLASH_MODEL || 'deepseek-flash'}`;
  const adapter = createAcpAdapter({
    name: 'commandcode', label: displayNameOf('commandcode'), cmd,
    agentArgs: ['acp'], effortViaConfig: false,
    routerMcpNode, routerMcpScript,
    terminalCmd(session) {
      const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
      return `${quote(cmd)} --model ${quote(session.model || defaultModel)}`
        + (session.cliSessionId ? ` --resume ${quote(session.cliSessionId)}` : '');
    },
  });
  const invoke = adapter.buildInvocation;
  adapter.buildInvocation = envelope => invoke({
    ...envelope,
    spawnOpts: { ...envelope.spawnOpts, rawModel: envelope.spawnOpts.rawModel || defaultModel },
  });
  return adapter;
}

module.exports = { createCommandCodeAdapter };
