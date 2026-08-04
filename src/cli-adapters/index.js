'use strict';

const path = require('path');
const { resolveCliCommands } = require('./commands');
const { createCliProviderRegistry } = require('./core');
const { createClaudeAdapter } = require('./claude');
const { createCodexAdapter } = require('./codex');
const { createOpencodeAdapter } = require('./opencode');
const { createZcodeAdapter } = require('./zcode');
const { createQoderAdapter } = require('./qoder');
const { createKimiAdapter } = require('./kimi');

function createCliAdapters(deps) {
  const commands = resolveCliCommands({ isWindows: deps.isWindows });
  const routerMcpNode = deps.routerMcpNode || process.execPath;
  const routerMcpScript = deps.routerMcpScript
    || path.join(__dirname, '..', '..', 'scripts', 'multicc-router-mcp.js');
  console.log(`[multicc] Using claude: ${commands.claude}`);
  console.log(`[multicc] Using codex: ${commands.codex}`);
  console.log(`[multicc] Using qoder: ${commands.qoder}`);
  console.log(`[multicc] Using kimi: ${commands.kimi}`);

  const registry = createCliProviderRegistry([
    createClaudeAdapter({
      cmd: commands.claude,
      args: deps.claudeArgs,
      chatDisallowedTools: deps.claudeChatDisallowedTools,
      multiccImgHint: deps.multiccImgHint,
      resolveSessionWireModel: deps.resolveSessionWireModel,
      claudeDefaultModel: deps.claudeDefaultModel,
      cliEffortLevel: deps.cliEffortLevel,
      normalizeEffort: deps.normalizeEffort,
      debugLogClaudeInvoke: deps.debugLogClaudeInvoke,
      routerMcpNode,
      routerMcpScript,
    }),
    createCodexAdapter({
      cmd: commands.codex,
      args: deps.codexArgs,
      codexReasoningConfigArg: deps.codexReasoningConfigArg,
      codexModelConfigArg: deps.codexModelConfigArg,
      envConstraint: deps.codexEnvConstraint,
      stayAlivePrompt: deps.codexStayAlivePrompt,
      multiccImgHint: deps.multiccImgHint,
      routerMcpNode,
      routerMcpScript,
      isResponseCompletedDisconnect: deps.isCodexResponseCompletedDisconnect,
      isTransportDisconnect: deps.isCodexTransportDisconnect,
    }),
    createOpencodeAdapter({
      cmd: commands.opencode,
      userInputReminder: deps.userInputReminder,
    }),
    createZcodeAdapter({ cmd: commands.zcode }),
    createQoderAdapter({ cmd: commands.qoder, routerMcpNode, routerMcpScript }),
    createKimiAdapter({ cmd: commands.kimi, routerMcpNode, routerMcpScript }),
  ]);

  return { commands, registry };
}

module.exports = { createCliAdapters };
