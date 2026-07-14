'use strict';

const { resolveCliCommands } = require('./commands');
const { createCliProviderRegistry } = require('./core');
const { createClaudeAdapter } = require('./claude');
const { createCodexAdapter } = require('./codex');
const { createOpencodeAdapter } = require('./opencode');
const { createZcodeAdapter } = require('./zcode');

function createCliAdapters(deps) {
  const commands = resolveCliCommands({ isWindows: deps.isWindows });
  console.log(`[multicc] Using claude: ${commands.claude}`);
  console.log(`[multicc] Using codex: ${commands.codex}`);

  const registry = createCliProviderRegistry([
    createClaudeAdapter({
      cmd: commands.claude,
      args: deps.claudeArgs,
      chatDisallowedTools: deps.claudeChatDisallowedTools,
      multiccImgHint: deps.multiccImgHint,
      providers: deps.providers,
      claudeDefaultModel: deps.claudeDefaultModel,
      cliEffortLevel: deps.cliEffortLevel,
      normalizeEffort: deps.normalizeEffort,
      debugLogClaudeInvoke: deps.debugLogClaudeInvoke,
    }),
    createCodexAdapter({
      cmd: commands.codex,
      args: deps.codexArgs,
      codexReasoningConfigArg: deps.codexReasoningConfigArg,
      codexModelConfigArg: deps.codexModelConfigArg,
      envConstraint: deps.codexEnvConstraint,
      stayAlivePrompt: deps.codexStayAlivePrompt,
      multiccImgHint: deps.multiccImgHint,
      isResponseCompletedDisconnect: deps.isCodexResponseCompletedDisconnect,
      isTransportDisconnect: deps.isCodexTransportDisconnect,
    }),
    createOpencodeAdapter({ cmd: commands.opencode }),
    createZcodeAdapter({ cmd: commands.zcode }),
  ]);

  return { commands, registry };
}

module.exports = { createCliAdapters };
