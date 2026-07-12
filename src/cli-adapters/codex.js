'use strict';

const { renderPrompt } = require('../message-composer');

function createCodexAdapter(deps) {
  const {
    cmd,
    args = [],
    codexReasoningConfigArg,
    codexModelConfigArg,
    envConstraint,
    stayAlivePrompt,
    multiccImgHint,
  } = deps;

  function configArgsFor(session) {
    return [codexReasoningConfigArg(session), codexModelConfigArg(session)].filter(Boolean);
  }

  function firstTurnPrompt(prompt, opts) {
    const promptPrefixes = [multiccImgHint];
    if (envConstraint) promptPrefixes.push(envConstraint);
    if (opts.rolePrompt) {
      promptPrefixes.push(`[角色设定]\n${opts.rolePrompt}\n[角色设定结束]`);
    }
    return `${promptPrefixes.join('\n\n')}\n\n${prompt}`;
  }

  return {
    name: 'codex',
    cmd,
    buildTerminalCmd(session) {
      const baseArgs = args.length ? ' ' + args.join(' ') : '';
      const configArgs = configArgsFor(session).map(arg => ` -c '${arg}'`).join('');
      if (session.cliSessionId) return `${cmd}${baseArgs}${configArgs} resume ${session.cliSessionId}`;
      return `${cmd}${baseArgs}${configArgs}`;
    },
    buildChatSpawnArgs(session, prompt, opts) {
      let promptText = opts.isFirstTurn ? firstTurnPrompt(prompt, opts) : prompt;
      if (stayAlivePrompt) promptText += `\n${stayAlivePrompt}`;

      const spawnArgs = ['exec'];
      for (const arg of configArgsFor(session)) spawnArgs.push('-c', arg);
      if (!opts.isFirstTurn) spawnArgs.push('resume', session.cliSessionId);
      spawnArgs.push(
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        promptText,
      );
      return spawnArgs;
    },
    shape(env) {
      const so = env.spawnOpts;
      const session = { effort: so.rawEffort, model: so.rawModel };
      const isFirstTurn = env.historyHandle.isFirstTurn;
      const prompt = renderPrompt(env);
      let payload = isFirstTurn ? firstTurnPrompt(prompt, { rolePrompt: env.rolePrompt }) : prompt;
      if (stayAlivePrompt) payload += `\n${stayAlivePrompt}`;
      const args = ['exec'];
      for (const arg of configArgsFor(session)) args.push('-c', arg);
      if (!isFirstTurn) args.push('resume', env.historyHandle.cliSessionId);
      args.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox');
      return { args, payload };
    },
    needsAsyncSessionIdCapture: true,
  };
}

module.exports = { createCodexAdapter };
