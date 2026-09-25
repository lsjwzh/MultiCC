'use strict';

// Shared adapter for every CLI that speaks ACP (Agent Client Protocol). The
// host spawns acp-bridge.cjs, which drives the agent's own `acp`/`stdio`
// server and prints its `session/update` notifications plus the synthetic
// multicc/* boundary events; this module turns that JSONL into the generic
// turn-engine events. A CLI-specific adapter only supplies how to launch the
// agent (agentArgs) and which argv carries the model when the agent cannot
// switch it over ACP.

const path = require('node:path');
const { completion, createCompletionTracker } = require('./completion');
const { renderPrompt } = require('../message-composer');

const BRIDGE = path.join(__dirname, 'acp-bridge.cjs');

function contentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n');
  if (content.type === 'text') return content.text || '';
  if (content.type === 'content') return contentText(content.content);
  if (content.type === 'diff') {
    return `${content.path || ''}\n${content.newText != null ? content.newText : ''}`.trim();
  }
  if (content.type === 'terminal') return `[terminal ${content.terminalId || ''}]`;
  if (content.type === 'resource_link') return content.uri || content.name || '';
  if (content.type === 'resource') return content.resource?.text || content.resource?.uri || '';
  return '';
}

function toolName(update, fallback) {
  // `title` is the agent's human label ("ls", "Read src/a.js"); `kind` is the
  // stable category (read/edit/execute/…). Cards read better with the kind as
  // the name and the title as the current-file hint.
  const kind = update.kind && update.kind !== 'other' ? update.kind : null;
  return kind || fallback || update.title || 'tool';
}

function currentFile(update) {
  const location = Array.isArray(update.locations) ? update.locations[0] : null;
  return update.title || location?.path || null;
}

function createAcpCompletionTracker() {
  return createCompletionTracker({
    observe(event) {
      if (event?.method === 'multicc/error') return completion('failed', `acp_${event.params?.phase || 'error'}`);
      if (event?.method !== 'multicc/turnEnd') return null;
      const reason = event.params?.stopReason || 'unknown';
      if (reason === 'end_turn') return completion('completed', 'acp/end_turn');
      if (reason === 'cancelled') return completion('cancelled', 'acp/cancelled');
      // max_tokens / max_turn_requests: the agent stopped on a budget, the turn
      // is not a success the host may treat as final.
      return completion('failed', `acp/${reason}`);
    },
  });
}

function createAcpAdapter({
  name, label, cmd, agentArgs = [], bridge = BRIDGE,
  // agentArgs: string[] or (spawnOpts) => string[]. modelViaArgv/effortViaArgv
  // mark CLIs whose agentArgs function already carries model/effort as launch
  // flags, so the bridge must not also switch them over ACP.
  modelViaArgv = false, effortViaArgv = false, effortViaConfig = true, agentViaMode = false,
  routerMcpNode = null, routerMcpScript = null, userInputReminder = '',
  terminalCmd = null,
}) {
  // Per-adapter decode state, keyed by the agent's own ids so concurrent
  // sessions of the same CLI never share an entry.
  const thoughts = new Map();
  const tools = new Map();

  function closeThoughts(sessionId) {
    const out = [];
    for (const [key, entry] of thoughts) {
      if (entry.sessionId !== sessionId) continue;
      thoughts.delete(key);
      if (entry.text) out.push({ type: 'thinking', id: entry.id, text: entry.text, snapshot: true, completed: true });
    }
    return out;
  }

  function forgetSession(sessionId) {
    for (const [key, entry] of tools) if (entry.sessionId === sessionId) tools.delete(key);
  }

  function decodeUpdate(sessionId, update) {
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = contentText(update.content);
      const out = closeThoughts(sessionId);
      if (text) out.push({ type: 'assistant_text', text, delta: true });
      return out;
    }
    if (kind === 'agent_thought_chunk') {
      const text = contentText(update.content);
      if (!text) return [];
      const key = `${sessionId}:${update.messageId || 'thought'}`;
      const entry = thoughts.get(key) || {
        sessionId, id: `thinking_${update.messageId || `${sessionId}_${Date.now()}`}`, text: '',
      };
      entry.text += text;
      thoughts.set(key, entry);
      return [{ type: 'thinking', id: entry.id, text: entry.text, snapshot: true, delta: true }];
    }
    if (kind === 'tool_call') {
      const out = closeThoughts(sessionId);
      const key = `${sessionId}:${update.toolCallId}`;
      const name = toolName(update);
      const input = update.rawInput || {};
      // turn-engine keeps the input a card was created with, and some agents
      // (OpenCode) announce the call before its arguments are known — defer the
      // card until an update carries real input or the call finishes.
      const announced = Object.keys(input).length > 0;
      tools.set(key, { sessionId, name, input, announced });
      if (announced) {
        out.push({
          type: 'tool_update', id: update.toolCallId, name, input,
          currentFile: currentFile(update), completed: false,
        });
      }
      if (update.status === 'completed' || update.status === 'failed') {
        out.push({
          type: 'tool_update', id: update.toolCallId, name, input, currentFile: currentFile(update),
          completed: true, content: contentText(update.content) || contentText(update.rawOutput), isError: update.status === 'failed',
        });
        tools.delete(key);
      }
      return out;
    }
    if (kind === 'tool_call_update') {
      const key = `${sessionId}:${update.toolCallId}`;
      const known = tools.get(key) || { sessionId, name: toolName(update), input: {}, announced: false };
      if (update.rawInput && typeof update.rawInput === 'object') known.input = update.rawInput;
      tools.set(key, known);
      const done = update.status === 'completed' || update.status === 'failed';
      if (!done) {
        if (known.announced || !Object.keys(known.input).length) return [];
        known.announced = true;
        return [{
          type: 'tool_update', id: update.toolCallId, name: known.name, input: known.input,
          currentFile: currentFile(update), completed: false,
        }];
      }
      tools.delete(key);
      let text = contentText(update.content);
      if (!text && update.rawOutput != null) {
        text = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
      }
      return [{
        type: 'tool_update', id: update.toolCallId, name: known.name, input: known.input,
        currentFile: currentFile(update), completed: true, content: text, isError: update.status === 'failed',
      }];
    }
    if (kind === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const message = entries.map(entry => `${entry.status === 'completed' ? '✓' : '•'} ${entry.content}`).join('\n');
      return message ? [{ type: 'activity', phase: 'plan', message }] : [];
    }
    return [];
  }

  function buildArgs(env) {
    const so = env.spawnOpts;
    const args = [bridge, '--agent-bin', cmd, '--label', label];
    const argv = typeof agentArgs === 'function' ? agentArgs(so) : agentArgs;
    for (const arg of argv) args.push('--agent-arg', arg);
    if (env.historyHandle.cliSessionId) args.push('--session-id', env.historyHandle.cliSessionId);
    if (so.rawModel && !modelViaArgv) args.push('--model', so.rawModel);
    if (so.rawEffort && effortViaConfig && !effortViaArgv) args.push('--effort', so.rawEffort);
    if (so.rawAgent && agentViaMode) args.push('--mode', so.rawAgent);
    if (routerMcpNode && routerMcpScript) args.push('--router-mcp', routerMcpNode, routerMcpScript);
    return args;
  }

  return {
    name,
    cmd,
    protocol: 'acp',
    createCompletionTracker: createAcpCompletionTracker,
    buildTerminalCmd(session) {
      if (terminalCmd) return terminalCmd(session);
      return cmd;
    },
    buildInvocation(env) {
      const isFirstTurn = env.historyHandle.isFirstTurn;
      const prompt = renderPrompt(env);
      let payload = isFirstTurn && env.rolePrompt
        ? `[Role prompt]\n${env.rolePrompt}\n[End of role prompt]\n\n${prompt}`
        : prompt;
      if (userInputReminder) payload = `${userInputReminder}\n\n${payload}`;
      // `--` ends the bridge flags; the spawn path appends the payload after it.
      return { cmd: process.execPath, args: [...buildArgs(env), '--'], payload };
    },
    decodeEvent(event) {
      const method = event?.method;
      const params = event?.params || {};
      if (method === 'session/update') {
        return params.update ? decodeUpdate(params.sessionId, params.update) : [];
      }
      if (method === 'multicc/session') {
        return params.sessionId ? [{ type: 'session_started', sessionId: params.sessionId }] : [];
      }
      if (method === 'multicc/notice') {
        return [{ type: 'activity', phase: 'warning', message: params.message || '' }];
      }
      if (method === 'multicc/turnEnd') {
        const out = closeThoughts(params.sessionId);
        forgetSession(params.sessionId);
        const reason = params.stopReason;
        if (reason === 'end_turn') out.push({ type: 'complete', cost: null, usage: params.usage || {} });
        else if (reason === 'cancelled') out.push({ type: 'error', label, kind: 'cancelled', message: `${label} turn cancelled` });
        else {
          const message = reason === 'max_tokens'
            ? `${label} stopped: output token limit reached`
            : reason === 'max_turn_requests'
              ? `${label} stopped: model request limit for this turn reached`
              : reason === 'refusal' ? `${label} refused to continue` : `${label} stopped: ${reason}`;
          out.push({ type: 'error', label, kind: 'provider', message, error: { source: `${name}_event`, provider: name, code: reason, message } });
        }
        return out;
      }
      if (method === 'multicc/error') {
        const message = params.message || `${label} error`;
        return [{
          type: 'error', label, kind: 'provider', message,
          error: { source: `${name}_event`, provider: name, code: params.code || params.phase || null, message },
        }];
      }
      return [];
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { BRIDGE, contentText, createAcpAdapter, createAcpCompletionTracker };
