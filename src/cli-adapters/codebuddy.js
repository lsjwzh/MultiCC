'use strict';

const { renderPrompt } = require('../message-composer');
const { claudeLikeMcpArgs } = require('./router-mcp');

/**
 * WorkBuddy / CodeBuddy CLI (Tencent, binary `codebuddy`, npm
 * @tencent-ai/codebuddy-code) speaks a byte-compatible Claude Code
 * stream-json envelope; only the flag spellings differ from qoder — effort is
 * `--effort` with a `minimal` rung below qoder's set, resume keeps
 * `--resume <sessionId>`. Vendor auth lives in ~/.codebuddy (`codebuddy`
 * TUI /login), so this CLI is providerless like qoder.
 */
const CODEBUDDY_REASONING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function codebuddyEffortLevel(session) {
  const value = String(session?.effort || '').trim().toLowerCase();
  return CODEBUDDY_REASONING_LEVELS.has(value) ? value : null;
}

function createCodebuddyAdapter({ cmd, routerMcpNode, routerMcpScript }) {
  const routerArgs = claudeLikeMcpArgs(routerMcpNode, routerMcpScript);
  return {
    name: 'codebuddy',
    cmd,
    buildTerminalCmd(session) {
      let command = cmd;
      if (session.model) command += ` --model ${session.model}`;
      const effort = codebuddyEffortLevel(session);
      if (effort) command += ` --effort ${effort}`;
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
      const effort = codebuddyEffortLevel({ effort: so.rawEffort });
      if (effort) args.push('--effort', effort);
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

module.exports = { createCodebuddyAdapter, CODEBUDDY_REASONING_LEVELS };
