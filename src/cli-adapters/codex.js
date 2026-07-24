'use strict';

const { renderPrompt } = require('../message-composer');

function normalizeCodexUsage(usage) {
  const source = usage || {};
  const cached = Number(source.cached_input_tokens || source.cache_read_input_tokens || 0);
  const totalInput = Number(source.input_tokens || 0);
  return {
    ...source,
    input_tokens: source.cache_read_input_tokens == null
      ? Math.max(0, totalInput - cached)
      : totalInput,
    cache_read_input_tokens: cached,
  };
}

function collabToolName(tool) {
  if (tool === 'spawn_agent') return 'Agent';
  if (tool === 'wait') return 'Agent Wait';
  if (tool === 'send_input') return 'Agent Input';
  if (tool === 'close_agent') return 'Agent Close';
  return `Agent ${tool || 'Task'}`;
}

function collabResult(item) {
  const states = item.agents_states || {};
  const lines = Object.entries(states).map(([id, state]) => {
    const status = state && state.status ? state.status : 'unknown';
    const message = state && state.message ? `: ${state.message}` : '';
    return `${id} [${status}]${message}`;
  });
  return lines.join('\n') || item.status || '';
}

// codex function/custom tool arguments arrive as a JSON string; parse to an
// object for the tool card's input panel, falling back to the raw string.
function parseToolArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch (_) {
    return { arguments: String(raw) };
  }
}

function mcpResultText(item) {
  if (item && item.error) {
    return typeof item.error === 'string'
      ? item.error
      : String(item.error.message || item.error.code || 'MCP tool failed');
  }
  const result = item && item.result;
  if (typeof result === 'string') return result;
  if (result && Array.isArray(result.content)) {
    const text = result.content
      .filter(block => block && block.type === 'text')
      .map(block => String(block.text || ''))
      .join('\n');
    if (text) return text;
  }
  if (result == null) return '';
  try { return JSON.stringify(result); } catch (_) { return String(result); }
}

function routerMcpConfigArgs(node, script) {
  if (!node || !script) return [];
  const envVars = [
    'MULTICC_BASE_URL',
    'MULTICC_SESSION_ID',
    'MULTICC_TURN_ID',
    'MULTICC_ORIGIN_DISPATCH_ID',
    'MULTICC_ROUTER_CAPABILITY',
  ];
  return [
    `mcp_servers.multicc_router.command=${JSON.stringify(String(node))}`,
    `mcp_servers.multicc_router.args=${JSON.stringify([String(script)])}`,
    `mcp_servers.multicc_router.env_vars=${JSON.stringify(envVars)}`,
    'mcp_servers.multicc_router.enabled=true',
    'mcp_servers.multicc_router.required=true',
    'mcp_servers.multicc_router.startup_timeout_sec=10',
    'mcp_servers.multicc_router.tool_timeout_sec=21630',
    'mcp_servers.multicc_router.default_tools_approval_mode="approve"',
  ];
}

function createCodexAdapter(deps) {
  const {
    cmd,
    args = [],
    codexReasoningConfigArg,
    codexModelConfigArg,
    envConstraint,
    stayAlivePrompt,
    multiccImgHint,
    routerMcpNode,
    routerMcpScript,
    isResponseCompletedDisconnect = () => false,
    isTransportDisconnect = () => false,
  } = deps;

  function configArgsFor(session) {
    return [codexReasoningConfigArg(session), codexModelConfigArg(session)].filter(Boolean);
  }

  function firstTurnPrompt(prompt, opts) {
    const promptPrefixes = [multiccImgHint];
    if (envConstraint) promptPrefixes.push(envConstraint);
    if (opts.rolePrompt) {
      promptPrefixes.push(`[角色设定]\n${opts.rolePrompt}\n[角色设定结束]`);
    }
    return `${promptPrefixes.join('\n\n')}\n\n${prompt}`;
  }

  return {
    name: 'codex',
    cmd,
    buildTerminalCmd(session) {
      const baseArgs = args.length ? ' ' + args.join(' ') : '';
      const configArgs = configArgsFor(session).map(arg => ` -c '${arg}'`).join('');
      if (session.cliSessionId) return `${cmd}${baseArgs}${configArgs} resume ${session.cliSessionId}`;
      return `${cmd}${baseArgs}${configArgs}`;
    },
    buildInvocation(env) {
      const so = env.spawnOpts;
      const session = { effort: so.rawEffort, model: so.rawModel };
      const isFirstTurn = env.historyHandle.isFirstTurn;
      const prompt = renderPrompt(env);
      let payload = isFirstTurn ? firstTurnPrompt(prompt, { rolePrompt: env.rolePrompt }) : prompt;
      if (stayAlivePrompt) payload += `\n${stayAlivePrompt}`;
      const args = ['exec'];
      for (const arg of [
        ...configArgsFor(session),
        ...routerMcpConfigArgs(routerMcpNode, routerMcpScript),
      ]) args.push('-c', arg);
      if (!isFirstTurn) args.push('resume', env.historyHandle.cliSessionId);
      args.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox');
      return { cmd, args, payload };
    },
    decodeEvent(event) {
      if (!event || typeof event !== 'object') return [];
      if (event.type === 'thread.started') {
        return event.thread_id ? [{ type: 'session_started', sessionId: event.thread_id }] : [];
      }
      if (event.type === 'turn.started') return [];
      if (event.type === 'item.started') {
        const item = event.item || {};
        if (item.type === 'mcp_tool_call') {
          return [{
            type: 'tool_start',
            id: item.id || item.call_id,
            name: item.tool || item.name || 'MCP Tool',
            input: parseToolArguments(item.arguments),
            status: 'running',
          }];
        }
        if (item.type === 'collab_tool_call') {
          return [{
            type: 'tool_start', id: item.id, name: collabToolName(item.tool),
            input: {
              prompt: item.prompt || undefined,
              agentIds: item.receiver_thread_ids || [],
            },
            status: 'running',
          }];
        }
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          // Surface function/custom tool calls as real tool cards (like Bash),
          // not as a swallowed `activity` block. Otherwise a long chain of these
          // gives the user no inline progress and the turn looks stuck. id must
          // match the item.completed pairing below (codex keeps item.id stable).
          return [{
            type: 'tool_start', id: item.id || item.call_id,
            name: item.name || item.type,
            input: parseToolArguments(item.arguments),
            status: 'running',
          }];
        }
        if (item.type !== 'command_execution') return [];
        return [{
          type: 'tool_start', id: item.id, name: 'Bash',
          input: { command: item.command }, status: 'running',
        }];
      }
      if (event.type === 'item.completed') {
        const item = event.item || {};
        if (item.type === 'mcp_tool_call') {
          return [{
            type: 'tool_result',
            id: item.id || item.call_id,
            content: mcpResultText(item),
            isError: item.status === 'failed' || !!item.error || item.result?.isError === true,
          }];
        }
        if (item.type === 'collab_tool_call') {
          return [{
            type: 'tool_result', id: item.id,
            content: collabResult(item), isError: item.status === 'failed',
          }];
        }
        if (item.type === 'command_execution') {
          return [{
            type: 'tool_result', id: item.id, content: item.aggregated_output || '',
            isError: !!(item.exit_code && item.exit_code !== 0),
          }];
        }
        if (item.type === 'function_call' && /^(request_user_input|AskUserQuestion)$/i.test(item.name || '')) {
          let questionText = '';
          try {
            const parsed = JSON.parse(item.arguments || '{}');
            const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
            questionText = questions.map((question) => {
              const heading = question.header || question.title || '';
              const body = question.question || question.text || '';
              const options = Array.isArray(question.options)
                ? question.options.map(option => `  - ${option.label || option.text || ''}${option.description ? `：${option.description}` : ''}`).join('\n')
                : '';
              return `${heading ? `**${heading}**\n` : ''}${body}${options ? `\n${options}` : ''}`;
            }).join('\n\n');
          } catch (_) {
            questionText = String(item.arguments || '');
          }
          if (!questionText) return [];
          return [{
            type: 'assistant_text',
            text: `\n\n> [提问工具 ${item.name} 在非交互环境不可用，已转为文本透传]\n${questionText}\n`,
            log: `ask-tool ${item.name} degraded to text`,
          }];
        }
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          // Pair with the tool_start above so the card flips running→done and
          // shows the tool's output, instead of vanishing into an activity block.
          return [{
            type: 'tool_result', id: item.id || item.call_id,
            content: item.output || item.aggregated_output || item.result || '',
            isError: item.status === 'failed' || !!(item.exit_code && item.exit_code !== 0),
          }];
        }
        if (item.type === 'agent_message') {
          return [{ type: 'assistant_text', text: item.text || '', forwardSuffix: '\n\n' }];
        }
        if (item.type === 'reasoning') {
          return [{ type: 'thinking', id: item.id, text: item.text || '' }];
        }
        return [];
      }
      if (event.type === 'turn.completed') {
        return [{ type: 'complete', cost: null, usage: normalizeCodexUsage(event.usage) }];
      }
      if (event.type === 'error' || event.type === 'turn.failed') {
        const detail = event.error && typeof event.error === 'object' ? event.error : {};
        const message = String(event.message || detail.message || '未知错误');
        const kind = isResponseCompletedDisconnect(message)
          ? 'response_completed_disconnect'
          : isTransportDisconnect(message) ? 'transport_disconnect' : 'provider';
        return [{
          type: 'error',
          label: 'Codex',
          message,
          kind,
          error: {
            source: 'codex_event',
            provider: 'codex',
            code: detail.code || event.code || detail.type || event.type,
            httpStatus: detail.http_status || detail.status_code || detail.status
              || event.http_status || event.status_code || event.status,
            headers: detail.headers || event.headers,
            requestId: detail.request_id || event.request_id,
            message,
          },
        }];
      }
      return [];
    },
    needsAsyncSessionIdCapture: true,
  };
}

module.exports = {
  createCodexAdapter,
  mcpResultText,
  normalizeCodexUsage,
  routerMcpConfigArgs,
};
