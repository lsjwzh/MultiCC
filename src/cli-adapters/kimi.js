'use strict';

// Kimi Code adapter (@moonshot-ai/kimi-code, binary `kimi`).
//
// Headless protocol (grounded from the 2.3.3 bundle,
// /opt/homebrew/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs): `kimi
// -p <prompt> --output-format stream-json` emits one JSON object per line:
//   { role:"meta", type:"system.version", version }                 (banner)
//   { role:"assistant", content?, tool_calls:[{type,id,function:{name,arguments}}] }
//   { role:"tool", tool_call_id, content }                          (tool result)
//   { role:"meta", type:"turn.step.retrying", failed_attempt, next_attempt,
//     max_attempts, delay_ms, error_name, error_message, status_code } (transient)
//   { role:"meta", type:"session.resume_hint", session_id, command }(last line)
//   { type:"error", code, message, details }                       (fatal, exit 4)
// `--auto` must NOT be passed with `-p`: validateOptions throws
// "Cannot combine --prompt with --auto." (main.mjs byte ~19537959) and the
// print path already calls `setMode("auto")` on the agent (main.mjs
// ~21931856, in the same block that catches SESSION_OCCUPIED).
// Continuation turns use `-S/--session <sessionId>` (the resume hint id).
// Provider credentials ride kimi-code's documented env fallback
// (KIMI_API_KEY / KIMI_BASE_URL), injected by buildKimiCodeRoute.

const { renderPrompt } = require('../message-composer');
const { claudeLikeMcpArgs } = require('./router-mcp');
const { createCompletionTracker } = require('./completion');
const { getNative } = require('../native/runtime');

const { displayNameOf } = require('../cli/cli-capability');
const LABEL = displayNameOf('kimi');

function numberOrUndefined(value) {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) ? n : undefined;
}

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

function createKimiAdapter({ cmd, routerMcpNode, routerMcpScript } = {}) {
  const routerArgs = claudeLikeMcpArgs(routerMcpNode, routerMcpScript);
  return {
    name: 'kimi',
    // kimi-code 0.32.0 runV2Print writes resume_hint only after runNativeTurn
    // accepts result.type=completed. Cleanup/goal failures can still exit 1,
    // so the marker is confirmed at process close, not at receipt time.
    createCompletionTracker() {
      const native = new (getNative().RustKimiCompletionTracker)();
      return createCompletionTracker({
        observe: event => native.observe(event),
        close: (boundary, evidence, facts) => native.close(boundary, evidence, facts),
      });
    },
    cmd,
    routerMcpNode,
    routerMcpScript,
    buildTerminalCmd(session) {
      let command = cmd;
      if (session && session.model) command += ` --model ${session.model}`;
      if (session && session.cliSessionId) command += ` --session ${session.cliSessionId}`;
      return command;
    },
    buildInvocation(env) {
      const isFirstTurn = env.historyHandle.isFirstTurn;
      // Print mode already forces permission-mode auto; `--auto` + `-p` is a
      // fatal option conflict in the installed 2.x line (see the header).
      const args = ['--output-format', 'stream-json', ...routerArgs];
      if (env.spawnOpts.rawModel) args.push('--model', env.spawnOpts.rawModel);
      if (!isFirstTurn && env.historyHandle.cliSessionId) {
        args.push('--session', env.historyHandle.cliSessionId);
      }
      const prompt = renderPrompt(env);
      const payload = isFirstTurn && env.rolePrompt
        ? `[Role prompt]\n${env.rolePrompt}\n[End of role prompt]\n\n${prompt}`
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
          // Transient provider retry — NOT a turn failure: a later attempt can
          // succeed, and the turn is decided by the last one. Keep the turn
          // visibly alive and carry the structured facts for observability;
          // emitting a `type:'error'` here would make the completion tracker
          // sawError sticky and fail a turn that later recovers.
          const retry = {};
          const failedAttempt = numberOrUndefined(event.failed_attempt);
          const nextAttempt = numberOrUndefined(event.next_attempt);
          const maxAttempts = numberOrUndefined(event.max_attempts);
          const delayMs = numberOrUndefined(event.delay_ms);
          const httpStatus = numberOrUndefined(event.status_code);
          if (failedAttempt !== undefined) retry.failedAttempt = failedAttempt;
          if (nextAttempt !== undefined) retry.nextAttempt = nextAttempt;
          if (maxAttempts !== undefined) retry.maxAttempts = maxAttempts;
          if (delayMs !== undefined) retry.delayMs = delayMs;
          if (httpStatus !== undefined) retry.httpStatus = httpStatus;
          if (typeof event.error_name === 'string' && event.error_name) retry.code = event.error_name;
          if (typeof event.error_message === 'string' && event.error_message) retry.message = event.error_message;
          decoded.push({
            type: 'status',
            status: 'thinking',
            ...(Object.keys(retry).length ? { retry } : {}),
          });
        }
      } else if (event.type === 'error') {
        // Fatal print-mode envelope (e.g. session.occupied, exit 4):
        // { type:"error", code, message, details } written to stdout by
        // reportSessionOccupied (main.mjs ~21940670). Terminal turn failures
        // that are thrown from runNativeTurn have no stdout envelope; they only
        // surface as stderr + exit 1 (the host's process-close fallback).
        const detail = event.details && typeof event.details === 'object' ? event.details : {};
        const message = event.message || detail.message || `${LABEL} 出错`;
        decoded.push({
          type: 'error',
          label: LABEL,
          message,
          kind: 'provider',
          error: {
            source: 'kimi_event',
            provider: 'kimi',
            code: event.code || detail.code || detail.name,
            httpStatus: numberOrUndefined(detail.statusCode ?? detail.status
              ?? event.status_code ?? event.statusCode),
            requestId: detail.requestId || detail.requestID || event.requestId,
            message,
          },
        });
      }
      return decoded;
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createKimiAdapter, LABEL };
