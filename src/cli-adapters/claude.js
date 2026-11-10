'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderPrompt } = require('../message-composer');
const { createResultCompletionTracker, isMainResult } = require('./result-completion');
const { displayNameOf } = require('../cli/cli-capability');

// One adapter for the whole Claude family. Chat always runs the resident Agent
// SDK lane: the adapter enters it by returning `sdkOptions`, which is what
// `stream-router` routes to `claude-sdk-stream.js` (the native RustClaudeLane).
// The old `claude -p` chat invocation is gone; the terminal still runs the
// `claude` executable, so `buildTerminalCmd` keeps its argv.
function createClaudeAdapter(deps = {}) {
  const {
    cmd,
    args = [],
    chatDisallowedTools = [],
    resolveSessionWireModel,
    cliEffortLevel,
    normalizeEffort,
    debugLogClaudeInvoke,
    routerMcpNode,
    routerMcpScript,
  } = deps;
  const bridge = deps.bridge || path.join(__dirname, 'claude-agent-sdk-bridge.mjs');

  return {
    name: 'claude',
    createCompletionTracker: createResultCompletionTracker,
    cmd,
    buildTerminalCmd(session) {
      let command = `${cmd}${args.length ? ' ' + args.join(' ') : ''}`;
      if (session.model) command += ` --model ${session.model}`;
      if (session.agent) command += ` --agent ${session.agent}`;
      const effort = cliEffortLevel(session);
      if (effort) command += ` --effort ${effort}`;
      // The turn-hook settings file already carries ultracode when requested.
      if (session.turnHookSettingsArg) command += ` --settings ${session.turnHookSettingsArg}`;
      else if (normalizeEffort(session?.effort) === 'ultracode') {
        command += ` --settings '{"ultracode":true}'`;
      }
      if (session.cliSessionId) command += ` --session-id ${session.cliSessionId}`;
      return command;
    },
    buildInvocation(env) {
      const so = env.spawnOpts;
      const model = resolveSessionWireModel(so.rawModel, {
        providerModel: so.providerModel,
        providerModels: so.providerModels,
        skipDefaultModel: so.skipDefaultModel,
        defaultModel: so.effectiveModel || null,
      });
      const effort = cliEffortLevel({ effort: so.rawEffort });
      const sdkArgs = [bridge];
      if (env.historyHandle.isFirstTurn) sdkArgs.push('--session-id', env.historyHandle.cliSessionId);
      else sdkArgs.push('--resume', env.historyHandle.cliSessionId);
      if (model) sdkArgs.push('--model', model);
      if (effort) sdkArgs.push('--effort', effort);
      if (so.rawAgent) sdkArgs.push('--agent', so.rawAgent);
      if (env.systemPrompt) sdkArgs.push('--system-prompt', env.systemPrompt);
      if (chatDisallowedTools.length) {
        sdkArgs.push('--disallowed-tools-json', JSON.stringify(chatDisallowedTools));
      }
      if (so.maxTurns > 0) sdkArgs.push('--max-turns', String(so.maxTurns));
      if (routerMcpNode && routerMcpScript) {
        sdkArgs.push('--router-node', routerMcpNode, '--router-script', routerMcpScript);
      }
      sdkArgs.push('--');
      const ultracode = normalizeEffort(so.rawEffort) === 'ultracode';
      debugLogClaudeInvoke?.({ model: so.rawModel, effort: so.rawEffort }, [...sdkArgs, renderPrompt(env)]);
      return {
        cmd: process.execPath,
        args: sdkArgs,
        payload: renderPrompt(env),
        sdkOptions: {
          model, effort, agent: so.rawAgent, systemPrompt: env.systemPrompt,
          disallowedTools: chatDisallowedTools, maxTurns: so.maxTurns,
          routerNode: routerMcpNode, routerScript: routerMcpScript,
        },
        ...(ultracode ? { settings: { ultracode: true } } : {}),
      };
    },
    decodeEvent(event) {
      if (event?.type === 'system' && event.subtype === 'sdk_error') {
        return [{
          type: 'error', label: displayNameOf('claude'), kind: 'provider',
          message: event.error || 'Claude Agent SDK bridge failed',
        }];
      }
      if (event?.type === 'result' && !isMainResult(event)) return [];
      if (event && event.type === 'system' && event.subtype === 'init') {
        return [{ type: 'session_init', model: event.model, raw: event }];
      }
      return [{ type: 'claude_event', raw: event }];
    },
    prepareSpawn({ sessionId }) {
      try {
        if (!sessionId) return 0;
        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        if (!fs.existsSync(projectsDir)) return 0;

        let cleaned = 0;
        for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const jsonlPath = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
          if (!fs.existsSync(jsonlPath)) continue;
          const output = fs.readFileSync(jsonlPath, 'utf8').split('\n').map((line) => {
            if (!line.trim()) return line;
            try {
              const parsed = JSON.parse(line);
              if (parsed.message && Array.isArray(parsed.message.content)) {
                parsed.message.content = parsed.message.content.filter((block) => {
                  const emptyThinking = block.type === 'thinking'
                    && (!block.thinking || !/\S/.test(block.thinking));
                  if (emptyThinking) cleaned += 1;
                  return !emptyThinking;
                });
              }
              return JSON.stringify(parsed);
            } catch (_) {
              return line;
            }
          });
          if (cleaned > 0) fs.writeFileSync(jsonlPath, output.join('\n'));
          break;
        }
        return cleaned;
      } catch (_) {
        return 0;
      }
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createClaudeAdapter };
