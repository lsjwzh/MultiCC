'use strict';

// Frozen oracle for the pre-migration adapter-neutral chat reducer. This is the
// Node implementation of `applyAdapterChatEvent` (and the only helpers it still
// owned), copied verbatim from src/chat/turn-engine.js before the move into
// native/addon/src/chat_events.rs. Host effects arrive through the same names
// the native reducer uses, so a differential run compares decisions, mutations
// and ordering rather than I/O. Do not "improve" this file: it is the reference
// the Rust reducer must match byte-for-byte.
//
// Kernels that were already native before this batch are imported exactly as
// the old module imported them: route redaction, error-envelope detection,
// message sanitization, error-only classification and native session capture.
const {
  detectErrorEnvelope, sanitizeMessage, isErrorOnlyText,
} = require('../../src/chat/api-error-policy');
const { redactProviderRouteCapability } = require('../../src/observability');

function appendAdapterAssistantText(current, text, options = {}) {
  const prior = String(current || '');
  const next = String(text || '');
  if (options.delta === true) return `${prior}${next}`;
  return prior ? `${prior}\n\n${next}` : next;
}

function adapterReasoningProgressEvent(event) {
  if (!event || typeof event.text !== 'string' || !event.text) return null;
  return {
    type: 'reasoning',
    id: typeof event.id === 'string' ? event.id : null,
    text: event.text,
    snapshot: true,
  };
}

function meaningfulTurnOutput(cs) {
  const text = String(cs?.currentAssistantText || '');
  return !!(text.trim() && !isErrorOnlyText(text));
}

function turnHasSideEffects(cs) {
  return !!(cs?.currentToolCalls || []).some(tool => tool && tool.name !== 'Thinking');
}

// `markReplaySafeAssistantEnvelope` with the host envelope marker injected so
// the oracle records the same port call the native reducer makes.
function markReplaySafeAssistantEnvelope(event, providerName, markHostEnvelope) {
  if (!event || event.type !== 'assistant' || !Array.isArray(event.message?.content)) return event;
  const blocks = event.message.content;
  if (!blocks.length || !blocks.every(block => block && block.type === 'text')) return event;
  const envelope = detectErrorEnvelope(providerName, blocks.map(block => String(block.text || '')).join(''));
  return envelope && envelope.body == null ? markHostEnvelope(event) : event;
}

// `ctx` supplies the live bindings the old closure owned. Effects go through
// the same names as `nativeChatEventPorts` plus the adapter-only ports.
function applyAdapterChatEventLegacy(ctx, provider, cs, persisted, sessionName, rawEvent, forward, turn, runner) {
  const {
    isCurrentTurnRunner,
    touchActivity,
    decodeEvent,
    observeAdapter,
    scrubAttemptStructure,
    applyClaudeChatEvent,
    noteReportedModel,
    rememberActiveCliState,
    savePersistedSessions,
    captureSession,
    assignKillReason,
    finishProviderAttempt,
    updatePhase,
    setSessionStatus,
    recordUserInput,
    consoleWarn,
    consoleLog,
    scheduleIncrementalSave,
    backgroundRecordToolUseId,
    markHostEnvelope,
    logger,
  } = ctx;
  const markReplaySafeAssistantEnvelopeFor = event => markReplaySafeAssistantEnvelope(event, provider.name, markHostEnvelope);

  if (!isCurrentTurnRunner(cs, turn, runner)) return;
  touchActivity(sessionName, turn.turnId);
  const decoded = decodeEvent(provider, rawEvent) || [];
  runner.completion.observe(rawEvent, Array.isArray(decoded) ? decoded : [decoded]);
  for (let evt of (Array.isArray(decoded) ? decoded : [decoded])) {
    if (!evt) continue;
    evt = scrubAttemptStructure(runner.providerAttempt, evt); observeAdapter(cs, evt);
    if (evt.type === 'claude_event') {
      applyClaudeChatEvent(cs, sessionName, evt.raw, forward, turn, runner, provider.name);
      continue;
    }
    if (evt.type === 'session_init') {
      if (evt.model) noteReportedModel(sessionName, evt.model);
      continue;
    }
    if (evt.type === 'native_session_missing' && evt.sessionId === persisted.cliSessionId) {
      persisted.cliSessionId = null;
      persisted._streamSessionId = null;
      runner.freshNativeSession = true;
      rememberActiveCliState(persisted);
      savePersistedSessions('runtime.codex-resume-missing');
      forward({ type: 'system', subtype: 'warning',
        message: 'Codex 原生会话已不可复用（历史缺失或线路配置已变更），已自动新建会话并附带上下文摘要，继续本条消息。' });
      continue;
    }
    if (evt.type === 'session_started') {
      const handoff = persisted.pendingCliHandoff;
      const resumeMismatch = !!(
        evt.sessionId
        && persisted.cliSessionId
        && evt.sessionId !== persisted.cliSessionId
        && handoff
        && handoff.status === 'pending'
        && handoff.reusedTarget
        && handoff.toCli === persisted.cli
      );
      if (resumeMismatch) {
        cs._adapterError = 'cross-cli target returned a different native session id';
        runner.adapterError = cs._adapterError;
        assignKillReason(runner, 'cli_resume_mismatch');
        forward({
          type: 'error',
          error: `目标 ${persisted.cli} 没有恢复预期的原生会话；未接受 CLI 返回的新会话。请重新切换并选择“重置目标 CLI 会话”。`,
        });
        finishProviderAttempt(runner, 'failed', {
          errorCategory: 'adapter_configuration', reasonCode: 'cli_resume_mismatch',
        });
        if (cs.claudeProc) {
          try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
        }
        continue;
      }
      const captured = captureSession(persisted, evt.sessionId, runner.freshNativeSession);
      if (captured.mismatch) {
        cs._adapterError = 'native resume returned a different session id';
        runner.adapterError = cs._adapterError;
        assignKillReason(runner, 'native_resume_mismatch');
        forward({
          type: 'error',
          error: `目标 ${persisted.cli} 返回了不同的原生会话；为避免把回复写入错误上下文，本轮已停止。`,
        });
        finishProviderAttempt(runner, 'failed', {
          errorCategory: 'adapter_configuration', reasonCode: 'native_resume_mismatch',
        });
        if (cs.claudeProc) {
          try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
        }
        continue;
      }
      if (captured.changed) {
        rememberActiveCliState(persisted);
        savePersistedSessions('runtime.chat-session-id-capture');
        consoleLog(`[multicc/chat] [${sessionName}] captured ${provider.name} session id=${captured.current}`);
      }
      continue;
    }
    if (evt.type === 'status') {
      updatePhase(sessionName, turn.turnId, evt.phase || evt.status);
      setSessionStatus(sessionName, { status: evt.status || 'thinking', currentFile: evt.currentFile || null });
      continue;
    }
    if (evt.type === 'activity') {
      updatePhase(sessionName, turn.turnId, {
        phase: evt.phase || 'tool', safeToolKind: evt.toolKind,
      });
      setSessionStatus(sessionName, { status: 'running', currentFile: null });
      continue;
    }
    if (evt.type === 'user_input_signal') {
      const landed = recordUserInput(evt, sessionName, turn.turnId);
      if (evt.log) consoleWarn(`[multicc/chat] [${sessionName}] ${provider.name} ${evt.log}`);
      if (landed && landed.ok) continue;
      evt = { type: 'assistant_text', text: (landed && landed.fallbackText) || evt.fallbackText || '' };
    }
    if (evt.type === 'assistant_text') {
      updatePhase(sessionName, turn.turnId, 'thinking');
      if (!evt.text) continue;
      cs.currentAssistantText = redactProviderRouteCapability(
        appendAdapterAssistantText(cs.currentAssistantText, evt.text, { delta: evt.delta === true }),
      );
      forward(markReplaySafeAssistantEnvelopeFor({
        type: 'assistant',
        message: {
          textSnapshot: true,
          content: [{ type: 'text', text: cs.currentAssistantText }],
        },
      }));
      setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
      scheduleIncrementalSave(sessionName, cs);
      if (evt.log) consoleWarn(`[multicc/chat] [${sessionName}] ${provider.name} ${evt.log}`);
      continue;
    }
    if (evt.type === 'tool_start') {
      updatePhase(sessionName, turn.turnId, 'tool', evt.name);
      const tool = { name: evt.name, input: evt.input || {}, id: evt.id, startedAt: Date.now() };
      cs.currentToolCalls.push(tool);
      backgroundRecordToolUseId(sessionName, evt.id);
      forward({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: evt.name, id: evt.id, input: evt.input || {} }] },
      });
      setSessionStatus(sessionName, { status: evt.status || 'running', currentFile: evt.currentFile || null });
      continue;
    }
    if (evt.type === 'tool_result') {
      updatePhase(sessionName, turn.turnId, 'thinking');
      const text = evt.content || '';
      forward({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: evt.id, content: text, is_error: !!evt.isError }] },
      });
      const tool = cs.currentToolCalls.find(item => item.id === evt.id);
      if (tool) {
        tool.result = text.length > 1000 ? text.slice(0, 1000) + '...' : text;
        tool.is_error = !!evt.isError;
        tool.endedAt = Date.now();
      }
      continue;
    }
    if (evt.type === 'tool_update') {
      updatePhase(sessionName, turn.turnId,
        evt.completed ? 'thinking' : 'tool', evt.name);
      const id = evt.id || `call_${cs.currentToolCalls.length}`;
      let tool = cs.currentToolCalls.find(item => item.id === id);
      if (!tool) {
        tool = { name: evt.name, input: evt.input || {}, id, startedAt: Date.now() };
        cs.currentToolCalls.push(tool);
        backgroundRecordToolUseId(sessionName, id);
        forward({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: evt.name, id, input: evt.input || {} }] },
        });
      }
      setSessionStatus(sessionName, { status: 'running', currentFile: evt.currentFile || null });
      if (evt.completed) {
        const text = evt.content || '';
        forward({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!evt.isError }] },
        });
        tool.result = text.length > 1000 ? text.slice(0, 1000) + '...' : text;
        tool.is_error = !!evt.isError;
        tool.endedAt = Date.now();
      }
      continue;
    }
    if (evt.type === 'thinking') {
      updatePhase(sessionName, turn.turnId, 'thinking');
      const reasoningProgress = adapterReasoningProgressEvent(evt);
      if (reasoningProgress) forward(reasoningProgress);
      let tool = evt.id && cs.currentToolCalls.find(item => item.id === evt.id);
      if (tool && evt.snapshot === true) tool.input = { text: evt.text || '' };
      else {
        tool = { name: 'Thinking', input: { text: evt.text || '' }, id: evt.id, startedAt: Date.now() };
        cs.currentToolCalls.push(tool);
        backgroundRecordToolUseId(sessionName, evt.id);
      }
      forward({ type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Thinking', id: evt.id, input: tool.input }] } });
      if (evt.delta !== true || evt.completed === true) {
        forward({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: evt.id, content: evt.text || '', is_error: false }] },
        });
        tool.endedAt = Date.now();
      }
      continue;
    }
    if (evt.type === 'complete') {
      runner.pendingCompletionEvent = evt;
      continue;
    }
    if (evt.type === 'error') {
      const publicMessage = sanitizeMessage(evt.message);
      logger.warn('chat_provider_error_observed', { sessionId: sessionName, turnId: turn.turnId, runnerId: runner.runnerId,
        provider: provider.name, kind: evt.kind || 'provider_error', message: publicMessage });
      updatePhase(sessionName, turn.turnId,
        evt.kind === 'transport_disconnect' ? 'recovering' : 'finalizing');
      if (evt.kind === 'response_completed_disconnect') {
        cs._codexPendingStreamError = publicMessage;
        cs._codexPendingStreamErrorCount = (cs._codexPendingStreamErrorCount || 0) + 1;
        const hasOutput = !!(cs.currentAssistantText || cs.currentToolCalls.length || cs._resultSaved);
        if (hasOutput) cs._codexRecoveredDisconnect = true;
        logger.warn('chat_provider_response_completed_disconnect', { sessionId: sessionName, provider: provider.name,
          afterOutput: hasOutput, occurrence: cs._codexPendingStreamErrorCount });
      } else if (evt.kind === 'transport_disconnect') {
        cs._codexTransportError = publicMessage;
        cs._sawApiError = true;
        runner.sawApiError = true;
        runner.apiErrorRaw = evt.error || {
          source: `${provider.name}_event`,
          provider: provider.name,
          code: 'connection_reset',
          message: evt.message,
        };
        logger.warn('chat_provider_transport_error', {
          sessionId: sessionName,
          provider: provider.name,
          phase: meaningfulTurnOutput(cs) || turnHasSideEffects(cs) ? 'stream' : 'before_first_token',
        });
      } else {
        cs._adapterError = publicMessage;
        runner.adapterError = publicMessage;
        runner.sawApiError = true;
        runner.apiErrorRaw = evt.error || {
          source: `${provider.name}_event`,
          provider: provider.name,
          code: 'provider_error',
          message: evt.message,
        };
        forward({ type: 'error', error: `${evt.label || provider.name} 出错：${publicMessage}` });
      }
    }
  }
}

module.exports = { applyAdapterChatEventLegacy, appendAdapterAssistantText, adapterReasoningProgressEvent };
