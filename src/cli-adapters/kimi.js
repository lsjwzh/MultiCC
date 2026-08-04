'use strict';

// Kimi Code adapter (@moonshot-ai/kimi-code, binary `kimi`).
//
// Headless protocol (grounded from the 0.32.x bundle): `kimi -p <prompt>
// --output-format stream-json --auto` emits one JSON object per line:
//   { role:"meta", type:"system.version", ... }                    (banner)
//   { role:"assistant", content?, tool_calls:[{type,id,function:{name,arguments}}] }
//   { role:"tool", tool_call_id, content }                          (tool result)
//   { role:"meta", type:"turn.step.retrying", error_message, ... }  (transient)
//   { role:"meta", type:"session.resume_hint", session_id, command }(last line)
// Continuation turns use `-S/--session <sessionId>` (the resume hint id).
// Provider credentials ride kimi-code's documented env fallback
// (KIMI_API_KEY / KIMI_BASE_URL), injected by buildKimiCodeRoute.

const { renderPrompt } = require('../message-composer');

const LABEL = 'Kimi Code';

function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function createKimiAdapter({ cmd } = {}) {
  return {
    name: 'kimi',
    cmd,
    buildTerminalCmd(session) {
      let command = cmd;
      if (session && session.model) command += ` --model ${session.model}`;
      if (session && session.cliSessionId) command += ` --session ${session.cliSessionId}`;
      return command;
    },
    buildInvocation(env) {
      const isFirstTurn = env.historyHandle.isFirstTurn;
      const args = ['--output-format', 'stream-json', '--auto'];
      if (env.spawnOpts.rawModel) args.push('--model', env.spawnOpts.rawModel);
      if (!isFirstTurn && env.historyHandle.cliSessionId) {
        args.push('--session', env.historyHandle.cliSessionId);
      }
      const prompt = renderPrompt(env);
      const payload = isFirstTurn && env.rolePrompt
        ? `[角色设定]\n${env.rolePrompt}\n[角色设定结束]\n\n${prompt}`
        : prompt;
      // `-p` consumes the following argv; multicc appends the payload as the
      // trailing positional, so `-p` must stay the last flag.
      args.push('-p');
      return { cmd, args, payload };
    },
    decodeEvent(event) {
      if (!event || typeof event !== 'object') return [];
      const decoded = [];
      if (event.role === 'assistant') {
        if (typeof event.content === 'string' && event.content) {
          decoded.push({ type: 'assistant_text', text: event.content });
        }
        if (Array.isArray(event.tool_calls)) {
          for (const call of event.tool_calls) {
            const fn = call && call.function ? call.function : {};
            decoded.push({
              type: 'tool_update',
              id: call && call.id,
              name: fn.name || 'tool',
              input: parseToolArguments(fn.arguments),
              currentFile: null,
              completed: false,
              content: '',
              isError: false,
            });
          }
        }
      } else if (event.role === 'tool') {
        decoded.push({
          type: 'tool_update',
          id: event.tool_call_id,
          name: 'tool',
          input: {},
          currentFile: null,
          completed: true,
          content: typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? ''),
          isError: false,
        });
      } else if (event.role === 'meta') {
        if (event.type === 'session.resume_hint' && event.session_id) {
          decoded.push({ type: 'session_started', sessionId: event.session_id });
        } else if (event.type === 'turn.step.retrying') {
          // Transient provider retry — keep the turn visibly alive; the final
          // outcome arrives as assistant text or a non-zero exit.
          decoded.push({ type: 'status', status: 'thinking' });
        }
      }
      return decoded;
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createKimiAdapter, LABEL };
