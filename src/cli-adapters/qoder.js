'use strict';

const { createResultCompletionTracker, isMainResult } = require('./result-completion');

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

// Qoder rides the Claude protocol but its own error frames carry the facts in
// different places. Grounded from qoderclicn (Bun bundle):
//  - a model failure is yielded as a synthetic assistant frame built by
//    `wv({...})` (~125922946): `isApiErrorMessage:true`, the display text in
//    message.content, and `displayErrorCode` — Yx (~125898352) sets it to the
//    HTTP status (401/403/429/5xx) or a Qoder numeric code (105/110/112/113…);
//  - the turn then ends with a `result` frame rebuilt by Vx (~125898352) from
//    the error: `subtype:"error_during_execution"`, `is_error:true`,
//    `errors:[…]`, `error_message?`, and `error_code` (number for an HTTP
//    status, string for a provider code).
// The host classifies from structured status first, so surface the numeric
// HTTP status where the Claude lane already looks for it
// (`api_error_status` on the assistant frame, `error.http_status` on the
// result frame). Provider string codes are deliberately NOT mapped onto
// `code`: an explicit rate-limit code would override quota-wall wording in
// api-error-policy (the same reason claude-api-error-message.js passes only
// the status). No state is kept between events — one adapter instance serves
// every session and these frames carry no session id to correlate them.
function httpStatusOf(value) {
  const number = Number(value);
  return value !== null && value !== '' && Number.isFinite(number)
    && number >= 400 && number <= 599 ? Math.round(number) : undefined;
}

function firstMessage(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function resultErrorFields(event) {
  if (event.type !== 'result') return null;
  if (event.is_error !== true && !/^error(?:_|$)/.test(String(event.subtype || ''))) return null;
  const httpStatus = httpStatusOf(event.error_code)
    ?? httpStatusOf(event.http_status ?? event.status_code ?? event.status);
  const message = firstMessage(
    event.error_message,
    Array.isArray(event.errors) ? event.errors.find(value => typeof value === 'string' && value.trim()) : undefined,
    event.result,
  );
  if (httpStatus === undefined && message === undefined) return null;
  return {
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

function createQoderAdapter({ cmd, routerMcpNode, routerMcpScript }) {
  const routerArgs = claudeLikeMcpArgs(routerMcpNode, routerMcpScript);
  return {
    name: 'qoder',
    createCompletionTracker: createResultCompletionTracker,
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
      if (event?.type === 'result' && !isMainResult(event)) return [];
      if (!event || typeof event !== 'object') return [];
      if (event.type === 'system' && event.subtype === 'init') {
        const decoded = [{ type: 'session_init', model: event.model, raw: event }];
        if (event.session_id) decoded.push({ type: 'session_started', sessionId: event.session_id });
        return decoded;
      }
      if (event.type === 'result') {
        const error = event.error && typeof event.error === 'object' ? null : resultErrorFields(event);
        return [{ type: 'claude_event', raw: error ? { ...event, error } : event }];
      }
      if (event.type === 'assistant' && event.isApiErrorMessage === true
        && event.api_error_status == null && event.apiErrorStatus == null) {
        const httpStatus = httpStatusOf(event.displayErrorCode);
        if (httpStatus !== undefined) {
          return [{ type: 'claude_event', raw: { ...event, api_error_status: httpStatus } }];
        }
      }
      return [{ type: 'claude_event', raw: event }];
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createQoderAdapter };
