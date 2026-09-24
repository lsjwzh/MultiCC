'use strict';

const path = require('node:path');
const { completion, createCompletionTracker } = require('./completion');
const { renderPrompt } = require('../message-composer');
const { normalizeCodexUsage, routerMcpConfigArgs } = require('./codex');

function appServerUsage(source) {
  const usage = source?.last || source?.total || source || {};
  return normalizeCodexUsage({
    input_tokens: Number(usage.inputTokens || 0),
    cached_input_tokens: Number(usage.cachedInputTokens || 0),
    cache_write_input_tokens: Number(usage.cacheWriteInputTokens || 0),
    output_tokens: Number(usage.outputTokens || 0),
    reasoning_output_tokens: Number(usage.reasoningOutputTokens || 0),
    ...(source?.modelContextWindow != null ? { model_context_window: source.modelContextWindow } : {}),
  });
}

function addUsage(current = {}, next = {}) {
  const summed = {};
  for (const key of [
    'input_tokens', 'cached_input_tokens', 'cache_read_input_tokens',
    'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens',
  ]) {
    summed[key] = Number(current[key] || 0) + Number(next[key] || 0);
  }
  const contextWindow = next.model_context_window ?? current.model_context_window;
  return contextWindow == null ? summed : { ...summed, model_context_window: contextWindow };
}

function requestUserInputEvent(params) {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  const first = questions[0];
  if (!first) return null;
  const question = [first.header, first.question].filter(Boolean).join('\n');
  const options = (Array.isArray(first.options) ? first.options : [])
    .map(option => option && option.label).filter(Boolean);
  const fallbackText = questions.map((item) => {
    const heading = item.header ? `**${item.header}**\n` : '';
    const choices = (Array.isArray(item.options) ? item.options : [])
      .map(option => `  - ${option.label}${option.description ? `：${option.description}` : ''}`).join('\n');
    return `${heading}${item.question || ''}${choices ? `\n${choices}` : ''}`;
  }).join('\n\n');
  return {
    type: 'user_input_signal', toolName: 'request_user_input', question, options,
    allowMultiple: false, fallbackText, log: 'native requestUserInput decoded to user_input_signal',
  };
}

function createCodexExpAdapter(deps = {}) {
  const bridge = deps.bridge || path.join(__dirname, 'codex-app-server-bridge.cjs');
  const textDeltaItems = new Set();
  const reasoning = new Map();
  const usageByTurn = new Map();
  const activeTurns = new Set();

  function configArgs(session) {
    return [
      deps.codexReasoningConfigArg?.(session),
      deps.codexModelConfigArg?.(session),
      ...routerMcpConfigArgs(deps.routerMcpNode, deps.routerMcpScript),
    ].filter(Boolean);
  }

  return {
    name: 'codex-exp',
    cmd: process.execPath,
    createCompletionTracker() {
      return createCompletionTracker({ observe(event) {
        if (event?.method !== 'turn/completed') return null;
        const status = event.params?.turn?.status;
        if (status === 'completed') return completion('completed', 'turn/completed');
        if (status === 'interrupted') return completion('cancelled', 'turn/interrupted');
        return completion('failed', `turn/${status || 'failed'}`);
      } });
    },
    buildTerminalCmd() {
      return `${deps.codexCmd || 'codex'} --help`;
    },
    buildInvocation(env) {
      const session = {
        effort: env.spawnOpts.rawEffort,
        model: env.spawnOpts.rawModel,
        effectiveModel: env.spawnOpts.effectiveModel,
      };
      let prompt = renderPrompt(env);
      if (env.historyHandle.isFirstTurn) {
        const prefixes = [deps.multiccImgHint, deps.envConstraint, env.subagentHint];
        if (env.rolePrompt) prefixes.push(`[角色设定]\n${env.rolePrompt}\n[角色设定结束]`);
        prompt = `${prefixes.filter(Boolean).join('\n\n')}\n\n${prompt}`;
      } else if (deps.envConstraint) {
        prompt = `${deps.envConstraint}\n\n${prompt}`;
      }
      const args = [bridge, '--codex-bin', deps.codexCmd || 'codex'];
      if (env.historyHandle.cliSessionId) args.push('--thread-id', env.historyHandle.cliSessionId);
      if (env.spawnOpts.rawModel) args.push('--model', env.spawnOpts.rawModel);
      const effort = deps.codexReasoningLevel?.(session);
      if (effort) args.push('--effort', effort);
      for (const config of configArgs(session)) args.push('--config', config);
      return {
        cmd: process.execPath,
        // One-shot argv: `--` terminates the flags and the prompt is appended
        // after it by the spawn path.
        args: [...args, '--'],
        payload: prompt,
        // Resident argv: the app-server lane takes its prompt on stdin like every
        // later turn, so `--resident` stands where the one-shot prompt would and
        // no `--` may precede it (`--` would swallow the flag as the prompt).
        streamArgs: [...args, '--resident'],
        streamBackend: 'app-server',
        // The thread id is allocated by the app-server and observed from its
        // `thread/started` notification, so the host must not mint one and must
        // persist it under cliSessionId — the same field the per-turn lane fills
        // from the same notification.
        nativeKey: 'cliSessionId',
        clientAllocatesNativeId: false,
        // Per-turn model/effort ride on turn/start, so changing either never
        // forces the resident app-server to respawn.
        turnOptions: { model: env.spawnOpts.rawModel || null, effort: effort || null },
      };
    },
    decodeEvent(event) {
      const method = event?.method;
      const params = event?.params || {};
      if (!method) return [];
      if (method === 'item/tool/requestUserInput') {
        const signal = requestUserInputEvent(params);
        return signal ? [signal] : [];
      }
      if (event.id !== undefined && /(?:requestApproval|Approval)$/.test(method)) {
        return [{
          type: 'error', label: 'Codex Exp', kind: 'provider',
          message: 'Codex Exp v1 does not support interactive approvals; the request was cancelled.',
        }];
      }
      if (method === 'thread/started') {
        const thread = params.thread || {};
        return [{ type: 'session_started', sessionId: thread.id || thread.sessionId }];
      }
      if (method === 'thread/status/changed') {
        return [{ type: 'status', status: params.status?.type === 'idle' ? 'thinking' : 'running' }];
      }
      if (method === 'turn/started') {
        if (params.turn?.id) activeTurns.add(params.turn.id);
        return [];
      }
      if (method === 'item/agentMessage/delta') {
        textDeltaItems.add(params.itemId);
        return [{ type: 'assistant_text', text: params.delta || '', delta: true }];
      }
      if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
        const current = `${reasoning.get(params.itemId) || ''}${params.delta || ''}`;
        reasoning.set(params.itemId, current);
        return [{ type: 'thinking', id: params.itemId, text: current, snapshot: true, delta: true }];
      }
      if (method === 'item/started') {
        const item = params.item || {};
        if (item.type === 'commandExecution') {
          return [{ type: 'tool_start', id: item.id, name: 'Bash', input: { command: item.command, cwd: item.cwd }, status: 'running' }];
        }
        if (item.type === 'mcpToolCall') {
          return [{ type: 'tool_start', id: item.id, name: item.tool || 'MCP Tool', input: item.arguments || {}, status: 'running' }];
        }
        return [];
      }
      if (method === 'item/commandExecution/outputDelta') {
        return [{ type: 'tool_update', id: params.itemId, name: 'Bash', content: params.delta || '', completed: false }];
      }
      if (method === 'item/mcpToolCall/progress') {
        return [{ type: 'activity', phase: 'tool', toolKind: 'mcp', message: params.message || '' }];
      }
      if (method === 'item/completed') {
        const item = params.item || {};
        if (item.type === 'agentMessage') {
          const streamed = textDeltaItems.delete(item.id);
          return streamed ? [] : [{ type: 'assistant_text', text: item.text || '' }];
        }
        if (item.type === 'reasoning') {
          const text = (Array.isArray(item.summary) ? item.summary.join('\n') : '')
            || (Array.isArray(item.content) ? item.content.join('\n') : '')
            || reasoning.get(item.id) || '';
          reasoning.delete(item.id);
          return text ? [{ type: 'thinking', id: item.id, text, snapshot: true, completed: true }] : [];
        }
        if (item.type === 'commandExecution') {
          return [{ type: 'tool_result', id: item.id, content: item.aggregatedOutput || '', isError: item.status === 'failed' || Number(item.exitCode) !== 0 }];
        }
        if (item.type === 'mcpToolCall') {
          const content = Array.isArray(item.result?.content)
            ? item.result.content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
            : item.error?.message || '';
          return [{ type: 'tool_result', id: item.id, content, isError: item.status === 'failed' || !!item.error }];
        }
        return [];
      }
      if (method === 'thread/tokenUsage/updated') {
        // `total` is cumulative across the whole resumed thread, while `last`
        // is one model call. A tool-using turn emits several updates, so sum
        // each `last` for the active turn instead of overwriting it. Resuming a
        // thread also replays the previous turn's latest usage before the new
        // turn starts; activeTurns keeps that replay out of this process' bill.
        if (params.turnId && activeTurns.has(params.turnId)) {
          usageByTurn.set(params.turnId, addUsage(
            usageByTurn.get(params.turnId),
            appServerUsage(params.tokenUsage),
          ));
        }
        return [];
      }
      if (method === 'turn/completed') {
        const turn = params.turn || {};
        const usage = usageByTurn.get(turn.id) || {};
        usageByTurn.delete(turn.id);
        activeTurns.delete(turn.id);
        if (turn.status !== 'completed') {
          return [{ type: 'error', label: 'Codex Exp', message: turn.error?.message || `turn ${turn.status}`, kind: turn.status === 'interrupted' ? 'cancelled' : 'provider' }];
        }
        return [{ type: 'complete', cost: null, usage }];
      }
      if (method === 'error') {
        return [{ type: 'error', label: 'Codex Exp', message: params.error?.message || params.message || 'app-server error', kind: 'provider', error: params.error }];
      }
      if (method === 'warning' || method === 'configWarning' || method === 'deprecationNotice') {
        return [{ type: 'activity', phase: 'warning', message: params.message || params.summary || '' }];
      }
      return [];
    },
    needsAsyncSessionIdCapture: true,
  };
}

module.exports = { addUsage, appServerUsage, createCodexExpAdapter, requestUserInputEvent };
