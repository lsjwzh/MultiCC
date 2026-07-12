'use strict';

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
      const effort = cliEffortLevel(session);
      if (effort) command += ` --effort ${effort}`;
      if (normalizeEffort(session?.effort) === 'ultracode') {
        command += ` --settings '{"ultracode":true}'`;
      }
      if (session.cliSessionId) command += ` --session-id ${session.cliSessionId}`;
      return command;
    },
    buildChatSpawnArgs(session, prompt, opts) {
      const sysPrompt = opts.rolePrompt
        ? `${multiccImgHint}\n\n${opts.rolePrompt}`
        : multiccImgHint;
      const spawnArgs = [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--dangerously-skip-permissions',
        '--append-system-prompt', sysPrompt,
      ];
      const model = providers.resolveSessionWireModel(session.model, {
        providerModel: opts.providerModel,
        providerModels: opts.providerModels,
        skipDefaultModel: opts.skipDefaultModel,
        defaultModel: claudeDefaultModel(),
      });
      if (model) spawnArgs.push('--model', model);
      const effort = cliEffortLevel(session);
      if (effort) spawnArgs.push('--effort', effort);
      if (normalizeEffort(session?.effort) === 'ultracode') {
        spawnArgs.push('--settings', '{"ultracode":true}');
      }
      if (chatDisallowedTools.length) {
        spawnArgs.push('--disallowedTools', chatDisallowedTools.join(','));
      }
      if (opts.maxTurns > 0) spawnArgs.push('--max-turns', String(opts.maxTurns));
      if (opts.isFirstTurn) spawnArgs.push('--session-id', session.cliSessionId);
      else spawnArgs.push('--resume', session.cliSessionId);
      spawnArgs.push(prompt);
      debugLogClaudeInvoke(session, spawnArgs);
      return spawnArgs;
    },
    shape(env) {
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
        return { args, payload };
      }

      const args = [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--dangerously-skip-permissions',
        '--append-system-prompt', sysPrompt,
      ];
      if (model) args.push('--model', model);
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
      return { args, payload };
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createClaudeAdapter };
