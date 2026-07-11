'use strict';

function createOpencodeAdapter({ cmd }) {
  return {
    name: 'opencode',
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
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createOpencodeAdapter };
