'use strict';

const path = require('node:path');
const { renderPrompt } = require('../message-composer');
const { createCompletionTracker } = require('./completion');
const { getNative } = require('../native/runtime');
const { extractUpstreamError } = require('../upstream-error');

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const ROUTER_EXTENSION = path.join(__dirname, 'pi-router-extension.mjs');
const textContent = content => Array.isArray(content)
  ? content.filter(item => item.type === 'text').map(item => item.text || '').join('\n') : '';
const lastAssistant = event => (event.messages || []).filter(message => message.role === 'assistant').at(-1);
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function piError(message, code = 'provider_error') {
  const upstream = extractUpstreamError(message);
  const detail = upstream.message || message;
  return { type: 'error', label: 'Pi', message: detail, error: {
    source: 'pi_event', provider: 'pi', code: upstream.code || upstream.type || code,
    message: detail,
    httpStatus: upstream.httpStatus || Number(/(?:status(?: code)?|HTTP)\s*:?\s*([45]\d\d)\b/i.exec(message)?.[1]) || undefined,
    requestId: upstream.requestId,
    ...(upstream.param ? { param: upstream.param } : {}),
  } };
}

// Verified against @earendil-works/pi-coding-agent 1.3.0 JSON print mode.
// JSON mode has native persisted sessions and exits
// after the prompt; the host owns process-group cancellation as for Codex.
// Authentication and model providers remain Pi's own ~/.pi/agent config.
function createPiAdapter({ cmd = 'pi', routerMcpNode, routerMcpScript } = {}) {
  return {
    name: 'pi', cmd, needsAsyncSessionIdCapture: false,
    buildTerminalCmd(session = {}) {
      return [quote(cmd),
        ...(session.model ? ['--model', quote(session.model)] : []),
        ...(PI_THINKING_LEVELS.includes(session.effort) ? ['--thinking', session.effort] : []),
        ...(session.cliSessionId ? ['--session', quote(session.cliSessionId)] : []),
      ].join(' ');
    },
    buildInvocation(env) {
      const so = env.spawnOpts || {};
      const args = ['--mode', 'json', '--print'];
      if (so.rawModel) args.push('--model', so.rawModel);
      if (PI_THINKING_LEVELS.includes(so.rawEffort)) args.push('--thinking', so.rawEffort);
      if (!env.historyHandle.isFirstTurn && env.historyHandle.cliSessionId) {
        args.push('--session', env.historyHandle.cliSessionId);
      }
      if (env.systemPrompt) args.push('--append-system-prompt', env.systemPrompt);
      if (routerMcpNode && routerMcpScript) args.push('--extension', ROUTER_EXTENSION,
        '--multicc-router-node', routerMcpNode, '--multicc-router-script', routerMcpScript);
      // Pi treats leading '-' / '@' as options / attachments even after '--'.
      // A leading newline preserves literal user content as a positional prompt.
      const prompt = renderPrompt(env);
      return { cmd, args, payload: /^[-@]/.test(prompt) ? `\n${prompt}` : prompt };
    },
    createCompletionTracker() {
      // Pi may emit agent_end(error), auto_retry_start, then agent_end(stop).
      // Only the latest boundary is authoritative once the process settles.
      const native = new (getNative().RustPiCompletionTracker)();
      return createCompletionTracker({
        observe: event => native.observe(event, lastAssistant),
        close: (_boundary, _evidence, facts) => native.close(facts),
      });
    },
    decodeEvent(event) {
      if (!event || typeof event !== 'object') return [];
      if (event.type === 'session' && event.id) return [{ type: 'session_started', sessionId: event.id }];
      if (event.type === 'agent_start' || event.type === 'auto_retry_start') return [{ type: 'status', status: 'thinking' }];
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent || {};
        if (update.type === 'text_delta' && update.delta) return [{ type: 'assistant_text', text: update.delta, delta: true }];
        if (update.type === 'thinking_delta' || update.type === 'thinking_end') {
          const text = event.message?.content?.[update.contentIndex]?.thinking || update.content || update.delta || '';
          return [{ type: 'thinking', id: `pi_thinking_${event.message?.timestamp || 0}_${update.contentIndex || 0}`,
            text, snapshot: true, delta: update.type !== 'thinking_end', completed: update.type === 'thinking_end' }];
        }
      }
      if (event.type === 'tool_execution_start') return [{ type: 'tool_start', id: event.toolCallId,
        name: event.toolName, input: event.args || {}, currentFile: event.args?.path || null }];
      if (event.type === 'tool_execution_end') return [{ type: 'tool_result', id: event.toolCallId,
        content: textContent(event.result?.content), isError: !!event.isError }];
      if (event.type === 'auto_retry_end' && event.success === false) {
        return [piError(event.finalError || 'Pi 自动重试失败', 'pi_retry_exhausted')];
      }
      if (event.type === 'agent_end') {
        const messages = (event.messages || []).filter(message => message.role === 'assistant');
        const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        let cost = 0;
        for (const message of messages) {
          const u = message.usage || {};
          usage.input_tokens += Number(u.input || 0);
          usage.output_tokens += Number(u.output || 0);
          usage.cache_read_input_tokens += Number(u.cacheRead || 0);
          usage.cache_creation_input_tokens += Number(u.cacheWrite || 0);
          cost += Number(u.cost?.total || 0);
        }
        // Pi 1.3 explicitly identifies retriable boundaries. Older versions
        // omit this flag, so leave those errors to native completion instead
        // of showing an error which an automatic retry may still recover.
        const last = messages.at(-1);
        const errors = event.willRetry === false && ['error', 'length'].includes(last?.stopReason)
          ? [piError(last.errorMessage || (last.stopReason === 'length'
            ? 'Pi 达到模型输出长度限制，回复未完成' : 'Pi 请求失败'), `pi_${last.stopReason}`)] : [];
        return [...errors, { type: 'complete', usage, cost }];
      }
      return [];
    },
  };
}

module.exports = { createPiAdapter, PI_THINKING_LEVELS };
