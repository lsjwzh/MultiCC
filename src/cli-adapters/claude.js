'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderPrompt } = require('../message-composer');

function createClaudeAdapter(deps) {
  const {
    cmd,
    args = [],
    chatDisallowedTools = [],
    multiccImgHint,
    providers,
    claudeDefaultModel,
    cliEffortLevel,
    normalizeEffort,
    debugLogClaudeInvoke,
  } = deps;

  return {
    name: 'claude',
    cmd,
    buildTerminalCmd(session) {
      let command = `${cmd}${args.length ? ' ' + args.join(' ') : ''}`;
      if (session.model) command += ` --model ${session.model}`;
      if (session.agent) command += ` --agent ${session.agent}`;
      const effort = cliEffortLevel(session);
      if (effort) command += ` --effort ${effort}`;
      if (normalizeEffort(session?.effort) === 'ultracode') {
        command += ` --settings '{"ultracode":true}'`;
      }
      if (session.cliSessionId) command += ` --session-id ${session.cliSessionId}`;
      return command;
    },
    buildInvocation(env) {
      const so = env.spawnOpts;
      const sysPrompt = env.systemPrompt;
      const model = providers.resolveSessionWireModel(so.rawModel, {
        providerModel: so.providerModel,
        providerModels: so.providerModels,
        skipDefaultModel: so.skipDefaultModel,
        defaultModel: claudeDefaultModel(),
      });
      const effort = cliEffortLevel({ effort: so.rawEffort });
      const payload = renderPrompt(env);

      if (so.mode === 'streaming') {
        const extraArgs = [];
        if (so.rawAgent) extraArgs.push('--agent', so.rawAgent);
        if (effort) extraArgs.push('--effort', effort);
        if (chatDisallowedTools.length) {
          extraArgs.push('--disallowedTools', chatDisallowedTools.join(','));
        }
        const args = [
          '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
          '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
          ...(model ? ['--model', model] : []),
          ...(sysPrompt ? ['--append-system-prompt', sysPrompt] : []),
          ...extraArgs,
        ];
        debugLogClaudeInvoke({ model: so.rawModel, effort: so.rawEffort }, args);
        return { cmd, args, payload };
      }

      const args = [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--dangerously-skip-permissions',
        '--append-system-prompt', sysPrompt,
      ];
      if (model) args.push('--model', model);
      if (so.rawAgent) args.push('--agent', so.rawAgent);
      if (effort) args.push('--effort', effort);
      if (normalizeEffort(so.rawEffort) === 'ultracode') {
        args.push('--settings', '{"ultracode":true}');
      }
      if (chatDisallowedTools.length) {
        args.push('--disallowedTools', chatDisallowedTools.join(','));
      }
      if (so.maxTurns > 0) args.push('--max-turns', String(so.maxTurns));
      if (env.historyHandle.isFirstTurn) args.push('--session-id', env.historyHandle.cliSessionId);
      else args.push('--resume', env.historyHandle.cliSessionId);
      debugLogClaudeInvoke({ model: so.rawModel, effort: so.rawEffort }, [...args, payload]);
      return { cmd, args, payload };
    },
    decodeEvent(event) {
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
