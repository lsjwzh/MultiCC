'use strict';

const path = require('node:path');
const { renderPrompt } = require('../message-composer');
const { createClaudeAdapter } = require('./claude');

function createClaudeExpAdapter(deps = {}) {
  const base = createClaudeAdapter(deps);
  const bridge = deps.bridge || path.join(__dirname, 'claude-agent-sdk-bridge.mjs');

  return {
    ...base,
    name: 'claude-exp',
    cmd: process.execPath,
    buildTerminalCmd() {
      return `${deps.claudeCmd || deps.cmd || 'claude'} --help`;
    },
    buildInvocation(env) {
      const so = env.spawnOpts;
      const model = deps.resolveSessionWireModel(so.rawModel, {
        providerModel: so.providerModel,
        providerModels: so.providerModels,
        skipDefaultModel: so.skipDefaultModel,
        defaultModel: deps.claudeDefaultModel(),
      });
      const effort = deps.cliEffortLevel({ effort: so.rawEffort });
      const args = [bridge];
      if (env.historyHandle.isFirstTurn) args.push('--session-id', env.historyHandle.cliSessionId);
      else args.push('--resume', env.historyHandle.cliSessionId);
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      if (so.rawAgent) args.push('--agent', so.rawAgent);
      if (env.systemPrompt) args.push('--system-prompt', env.systemPrompt);
      if (Array.isArray(deps.chatDisallowedTools) && deps.chatDisallowedTools.length) {
        args.push('--disallowed-tools-json', JSON.stringify(deps.chatDisallowedTools));
      }
      if (so.maxTurns > 0) args.push('--max-turns', String(so.maxTurns));
      if (deps.routerMcpNode && deps.routerMcpScript) {
        args.push('--router-node', deps.routerMcpNode, '--router-script', deps.routerMcpScript);
      }
      args.push('--');
      const ultracode = deps.normalizeEffort(so.rawEffort) === 'ultracode';
      deps.debugLogClaudeInvoke?.({ model: so.rawModel, effort: so.rawEffort }, [...args, renderPrompt(env)]);
      return {
        cmd: process.execPath,
        args,
        payload: renderPrompt(env),
        ...(ultracode ? { settings: { ultracode: true } } : {}),
      };
    },
    decodeEvent(event) {
      if (event?.type === 'system' && event.subtype === 'sdk_error') {
        return [{
          type: 'error', label: 'Claude Exp', kind: 'provider',
          message: event.error || 'Claude Agent SDK bridge failed',
        }];
      }
      return base.decodeEvent(event);
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createClaudeExpAdapter };
