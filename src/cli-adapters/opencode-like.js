'use strict';

const { renderPrompt } = require('../message-composer');

function createOpencodeLikeAdapter({ name, label, cmd }) {
  return {
    name,
    cmd,
    buildTerminalCmd(session) {
      let command = cmd;
      if (session.model) command += ` --model ${session.model}`;
      if (session.cliSessionId) command += ` --session ${session.cliSessionId}`;
      return command;
    },
    buildInvocation(env) {
      const so = env.spawnOpts;
      const isFirstTurn = env.historyHandle.isFirstTurn;
      const args = ['run', '--format', 'json', '--auto'];
      if (so.rawModel) args.push('--model', so.rawModel);
      if (!isFirstTurn && env.historyHandle.cliSessionId) {
        args.push('--session', env.historyHandle.cliSessionId);
      } else if (!isFirstTurn) {
        args.push('--continue');
      }
      const prompt = renderPrompt(env);
      const payload = isFirstTurn && env.rolePrompt
        ? `[角色设定]\n${env.rolePrompt}\n[角色设定结束]\n\n${prompt}`
        : prompt;
      return { cmd, args, payload };
    },
    decodeEvent(event) {
      if (!event || typeof event !== 'object') return [];
      const decoded = [];
      if (event.sessionID) decoded.push({ type: 'session_started', sessionId: event.sessionID });
      const part = event.part || {};
      if (event.type === 'step_start') {
        decoded.push({ type: 'status', status: 'thinking' });
      } else if (event.type === 'text' && part.text) {
        decoded.push({ type: 'assistant_text', text: part.text });
      } else if (event.type === 'tool_use' || event.type === 'tool_call') {
        const state = part.state || {};
        decoded.push({
          type: 'tool_update',
          id: part.callID || part.id,
          name: part.tool || part.name || 'tool',
          input: state.input != null ? state.input : (part.args || {}),
          currentFile: state.title || null,
          completed: state.status === 'completed' || state.output !== undefined,
          content: typeof state.output === 'string'
            ? state.output
            : (state.output == null ? '' : JSON.stringify(state.output)),
          isError: state.status === 'error',
        });
      } else if (event.type === 'step_finish') {
        if (!part.reason || part.reason === 'stop') {
          const tokens = part.tokens || {};
          decoded.push({
            type: 'complete',
            cost: part.cost != null ? part.cost : null,
            usage: {
              input_tokens: tokens.input || 0,
              output_tokens: tokens.output || 0,
              cache_read_input_tokens: (tokens.cache && tokens.cache.read) || 0,
              cache_creation_input_tokens: (tokens.cache && tokens.cache.write) || 0,
            },
          });
        }
      } else if (event.type === 'error') {
        const error = event.error || part.error;
        const message = (error && error.data && error.data.message)
          || (error && error.message)
          || (typeof error === 'string' ? error : '')
          || `${name} 出错`;
        decoded.push({ type: 'error', label, message, kind: 'provider' });
      }
      return decoded;
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createOpencodeLikeAdapter };
