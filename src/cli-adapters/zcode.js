'use strict';

const { renderPrompt } = require('../message-composer');

function createZcodeAdapter({ cmd }) {
  return {
    name: 'zcode',
    cmd,
    buildTerminalCmd(session) {
      let command = cmd;
      if (session.model) command += ` --model ${session.model}`;
      if (session.cliSessionId) command += ` --session ${session.cliSessionId}`;
      return command;
    },
    buildChatSpawnArgs(session, prompt, opts) {
      const args = ['run', '--format', 'json', '--auto'];
      if (session.model) args.push('--model', session.model);
      if (!opts.isFirstTurn && session.cliSessionId) args.push('--session', session.cliSessionId);
      else if (!opts.isFirstTurn) args.push('--continue');
      let promptText = prompt;
      if (opts.isFirstTurn && opts.rolePrompt) {
        promptText = `[角色设定]\n${opts.rolePrompt}\n[角色设定结束]\n\n${prompt}`;
      }
      args.push(promptText);
      return args;
    },
    shape(env) {
      const so = env.spawnOpts;
      const isFirstTurn = env.historyHandle.isFirstTurn;
      const model = so.rawModel;
      const cliSessionId = env.historyHandle.cliSessionId;
      const args = ['run', '--format', 'json', '--auto'];
      if (model) args.push('--model', model);
      if (!isFirstTurn && cliSessionId) args.push('--session', cliSessionId);
      else if (!isFirstTurn) args.push('--continue');
      const prompt = renderPrompt(env);
      let payload = prompt;
      if (isFirstTurn && env.rolePrompt) {
        payload = `[角色设定]\n${env.rolePrompt}\n[角色设定结束]\n\n${prompt}`;
      }
      return { args, payload };
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createZcodeAdapter };
