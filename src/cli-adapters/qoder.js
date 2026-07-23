'use strict';

const { renderPrompt } = require('../message-composer');
const { claudeLikeMcpArgs } = require('./router-mcp');

/**
 * Qoder CN exposes a Claude-compatible stream-json envelope, but its command
 * line and session lifecycle are distinct. Keep those details here instead of
 * teaching the host about another vendor protocol.
 */
const QODER_REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function qoderEffortLevel(session) {
  const value = String(session?.effort || '').trim().toLowerCase();
  return QODER_REASONING_LEVELS.has(value) ? value : null;
}

function createQoderAdapter({ cmd, routerMcpNode, routerMcpScript }) {
  const routerArgs = claudeLikeMcpArgs(routerMcpNode, routerMcpScript);
  return {
    name: 'qoder',
    cmd,
    buildTerminalCmd(session) {
      let command = cmd;
      if (session.model) command += ` --model ${session.model}`;
      const effort = qoderEffortLevel(session);
      if (effort) command += ` --reasoning-effort ${effort}`;
      if (session.agent) command += ` --agent ${session.agent}`;
      if (session.cliSessionId) command += ` --resume ${session.cliSessionId}`;
      return command;
    },
    buildInvocation(env) {
      const so = env.spawnOpts;
      const args = [
        '-p', ...routerArgs, '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--append-system-prompt', env.systemPrompt,
      ];
      if (so.rawModel) args.push('--model', so.rawModel);
      const effort = qoderEffortLevel({ effort: so.rawEffort });
      if (effort) args.push('--reasoning-effort', effort);
      if (so.rawAgent) args.push('--agent', so.rawAgent);
      if (!env.historyHandle.isFirstTurn && env.historyHandle.cliSessionId) {
        args.push('--resume', env.historyHandle.cliSessionId);
      }
      return { cmd, args, payload: renderPrompt(env) };
    },
    decodeEvent(event) {
      if (!event || typeof event !== 'object') return [];
      if (event.type === 'system' && event.subtype === 'init') {
        const decoded = [{ type: 'session_init', model: event.model, raw: event }];
        if (event.session_id) decoded.push({ type: 'session_started', sessionId: event.session_id });
        return decoded;
      }
      return [{ type: 'claude_event', raw: event }];
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createQoderAdapter };
