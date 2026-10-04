'use strict';

const { renderPrompt } = require('../message-composer');
const { completion, createCompletionTracker } = require('./completion');
const { displayNameOf } = require('../cli/cli-capability');

// 1.74.1 的 ACP 目录不包含 BYOK 模型；原生 headless 支持相同配置与恢复。
function createCommandCodeAdapter({ cmd, env = process.env }) {
  const defaultModel = `deepseek/${env.DEEPSEEK_FLASH_MODEL || 'deepseek-flash'}`;
  let thinkingSequence = 0;
  const label = displayNameOf('commandcode');
  const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  function failure(event) {
    const message = event.message || event.error?.message || (typeof event.error === 'string' ? event.error : '') || 'Command Code 执行失败';
    return { type: 'error', label, message, kind: 'provider', error: {
      source: 'commandcode_event', provider: 'commandcode', message,
      code: event.code || event.error?.code, httpStatus: event.status || event.error?.status,
    } };
  }
  return {
    name: 'commandcode', cmd, needsAsyncSessionIdCapture: false,
    buildTerminalCmd(session) {
      return `${quote(cmd)} --model ${quote(session.model || defaultModel)}`
        + (session.cliSessionId ? ` --resume ${quote(session.cliSessionId)}` : '');
    },
    buildInvocation(envelope) {
      const args = ['--output-format', 'json', '--model', envelope.spawnOpts.rawModel || defaultModel,
        '--skip-onboarding', '--no-auto-update', '--yolo'];
      if (!envelope.historyHandle.isFirstTurn && envelope.historyHandle.cliSessionId) args.push('--resume', envelope.historyHandle.cliSessionId);
      args.push('-p');
      const prompt = renderPrompt(envelope);
      const payload = envelope.historyHandle.isFirstTurn && envelope.rolePrompt
        ? `[Role prompt]\n${envelope.rolePrompt}\n[End of role prompt]\n\n${prompt}` : prompt;
      return { cmd, args, payload };
    },
    createCompletionTracker() {
      return createCompletionTracker({ observe(raw) {
        const event = raw.event || raw;
        if (event.type === 'error') return completion('failed', 'commandcode/error');
        if (raw.type !== 'result') return null;
        return completion(raw.subtype === 'success' && raw.stopReason === 'end_turn' ? 'completed' : 'failed', `commandcode/${raw.stopReason || raw.subtype || 'unknown'}`);
      } });
    },
    decodeEvent(raw) {
      if (!raw || typeof raw !== 'object') return [];
      const event = raw.event || raw;
      if (event.type === 'run_start' && event.sessionId) return [{ type: 'session_started', sessionId: event.sessionId }];
      if (event.type === 'turn_start') return [{ type: 'status', status: 'thinking' }];
      if (event.type === 'text_delta' && event.delta) return [{ type: 'assistant_text', text: event.delta, delta: true }];
      if (event.type === 'message_end') return (event.content || []).filter(x => x.type === 'thinking' && x.thinking)
        .map(x => ({ type: 'thinking', id: `commandcode-thinking-${++thinkingSequence}`, text: x.thinking, completed: true }));
      if (event.type === 'tool_queued') return [{ type: 'tool_update', id: event.toolCallId, name: event.toolName, input: event.input || {}, completed: false }];
      if (['tool_completed', 'tool_failed', 'tool_errored', 'tool_error', 'tool_denied'].includes(event.type)) return [{ type: 'tool_update',
        id: event.toolCallId, name: event.toolName, completed: true, isError: event.type !== 'tool_completed',
        content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result || event.error || ''),
      }];
      if (event.type === 'error') return [failure(event)];
      // 只在最终 result 计量一次，避免 run_end 与每次 model_request_end 重复累计。
      if (raw.type === 'result') {
        if (raw.subtype !== 'success' || raw.stopReason !== 'end_turn') return [failure(raw)];
        const u = raw.usage || {};
        return [{ type: 'complete', cost: null, usage: { input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0,
          cache_read_input_tokens: u.cacheReadTokens || 0, cache_creation_input_tokens: u.cacheWriteTokens || 0 } }];
      }
      return [];
    },
  };
}
module.exports = { createCommandCodeAdapter };
