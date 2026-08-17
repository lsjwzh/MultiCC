'use strict';

const { resolveTurnFinalization } = require('./finalize-plan');

const REQUIRED_PORTS = Object.freeze([
  'persistAssistant',
  'commitUsage',
  'broadcast',
  'cancelClassify',
  'clearIncrementalSave',
  'setStatus',
  'completeSessionTurn',
  'classifyTurnEnd',
  'resetInterrupted',
  'resumeInterrupted',
  'emitTurnOutcome',
  'runPostTurn',
]);

function assertFinalizeHostPorts(ports) {
  if (!ports || typeof ports !== 'object') throw new TypeError('finalize host ports are required');
  for (const name of REQUIRED_PORTS) {
    if (typeof ports[name] !== 'function') throw new TypeError(`finalize host port missing: ${name}`);
  }
  return ports;
}

function createTurnFinalizationExecutor(rawPorts) {
  const ports = assertFinalizeHostPorts(rawPorts);
  const now = typeof ports.now === 'function' ? ports.now : Date.now;
  const log = typeof ports.log === 'function' ? ports.log : () => {};
  const logError = typeof ports.logError === 'function' ? ports.logError : () => {};

  function isBlockedTerminalEffect(entry, context) {
    if (context.terminalBlocked !== true) return false;
    if (entry.type === 'complete-session-turn') return true;
    if (entry.type === 'freeze-interrupted' || entry.type === 'classify-turn-end') return true;
    return entry.type === 'emit-turn-outcome' && entry.status === 'succeeded';
  }

  function applyEffect(entry, context) {
    const { sessionName, cs } = context;
    if (isBlockedTerminalEffect(entry, context)) return;
    switch (entry.type) {
      case 'set-streaming':
        cs.isStreaming = entry.value;
        break;
      case 'cancel-classify':
        ports.cancelClassify(cs);
        break;
      case 'clear-stream-replay':
        cs.streamReplay = [];
        break;
      case 'report-empty-retry-failure': {
        const stderrTail = String(context.stderrTail || '').trim();
        ports.broadcast(sessionName, {
          type: 'error',
          error: context.pendingTransportError
            ? `Codex 出错：${context.pendingTransportError}`
            : stderrTail ? `${cs.cli} 无响应：${stderrTail}`
              : `${cs.cli} 无响应（exit ${context.code}${context.signal ? `/${context.signal}` : ''}）`,
        });
        break;
      }
      case 'report-handoff-resume-failure':
        ports.broadcast(sessionName, {
          type: 'error',
          error: context.runnerKind === 'stream'
            ? '目标 Claude 原生会话恢复异常；未自动新建或重试。请重新切换并选择“重置目标 CLI 会话”。'
            : `目标 ${cs.cli} 原生会话恢复失败；未自动创建新会话。请重新切换并选择“重置目标 CLI 会话”。`,
        });
        break;
      case 'clear-active-process':
        cs.claudeProc = null;
        break;
      case 'clear-incremental-save':
        ports.clearIncrementalSave(sessionName);
        break;
      case 'append-assistant-result':
        // The two-stage executor performs this write at the effect boundary.
        break;
      case 'commit-usage':
        if (context.turn && context.turn.resultDurable === true) {
          context.usageAttempted = true;
          try {
            context.usageDurable = ports.commitUsage(context) === true;
          } catch (error) {
            context.usageDurable = false;
            context.usageError = error && error.message ? String(error.message) : 'usage commit failed';
            logError('usage-commit-failed', { sessionName, error });
          }
          if (context.usageDurable !== true) context.terminalBlocked = true;
        }
        break;
      case 'increment-chat-turn-count':
        if (context.appendPersisted) cs.chatTurnCount++;
        break;
      case 'report-result-persistence-failure':
        ports.broadcast(sessionName, {
          type: 'error',
          error: '回复已生成但未能持久化，已停止回流和后续动作。',
        });
        break;
      case 'emit-synthetic-result':
        ports.broadcast(sessionName, {
          type: 'result',
          total_cost_usd: null,
          usage: {},
          durationMs: cs.turnStartedAt ? now() - cs.turnStartedAt : undefined,
          num_turns: cs.chatTurnCount,
        });
        break;
      case 'capture-final-text':
        context.finalText = cs.currentAssistantText;
        break;
      case 'reset-turn-output':
        cs.currentAssistantText = '';
        cs.currentToolCalls = [];
        cs._resultSaved = false;
        cs._sawApiError = false;
        if (entry.clearAdapterError) cs._adapterError = null;
        if (entry.clearTransportState) {
          cs._codexRecoveredDisconnect = false;
          cs._codexPendingStreamError = '';
          cs._codexPendingStreamErrorCount = 0;
          cs._codexTransportError = '';
          cs._codexStreamContinuationCount = 0;
        }
        break;
      case 'set-status':
        ports.setStatus(sessionName, entry.status);
        break;
      case 'classify-turn-end':
        // The plan's classification is the turn boundary's own verdict. It is
        // forwarded rather than dropped so the classify centre can skip the Aux
        // guess for outcomes the boundary already proved.
        ports.classifyTurnEnd(cs, sessionName, {
          classification: entry.classification || null,
          turnId: context.turn?.turnId || null,
          // Correlate the verdict with the task identity captured when this
          // turn was admitted.  The live session pointer is intentionally not
          // authoritative here: a delayed Aux attribution from an older turn
          // may have changed it while this runner was active.
          taskId: context.turn?.task?.id || null,
        });
        break;
      case 'complete-session-turn':
        Promise.resolve(ports.completeSessionTurn(sessionName)).catch(error => {
          logError('complete-session-turn-failed', { sessionName, error });
        });
        break;
      case 'reset-interrupted-resume':
        ports.resetInterrupted(sessionName);
        break;
      case 'emit-turn-outcome':
        ports.emitTurnOutcome(sessionName, {
          status: entry.status,
          notifyState: entry.notifyState,
          message: '执行成功',
          alert: false,
        });
        break;
      case 'try-resume-interrupted':
        if (ports.resumeInterrupted(sessionName)) {
          log('interrupted-resume', { sessionName });
        } else {
          ports.setStatus(sessionName, entry.fallbackStatus);
        }
        break;
      case 'freeze-interrupted':
        if (typeof ports.freezeInterrupted === 'function') {
          ports.freezeInterrupted(sessionName, entry.reason || 'unknown_interruption');
        }
        break;
      case 'stream-end':
        ports.broadcast(sessionName, { type: 'stream_end' });
        break;
      case 'run-post-turn':
        try {
          ports.runPostTurn(context, entry);
        } catch (error) {
          logError('post-turn-failed', { sessionName, error });
        }
        break;
      default:
        throw new Error(`unknown chat finalization effect: ${entry.type}`);
    }
  }

  function execute(plan, rawContext) {
    const context = {
      appendPersisted: false,
      finalText: '',
      usageAttempted: false,
      usageDurable: null,
      terminalBlocked: false,
      ...rawContext,
    };
    const applyAll = effects => effects.forEach(entry => applyEffect(entry, context));

    if (!plan.append || !plan.append.required) {
      const resolved = resolveTurnFinalization(plan, { resultDurable: context.turn.resultDurable });
      applyAll(resolved.effects);
      return Object.freeze({
        resolved,
        appendPersisted: false,
        finalText: context.finalText,
        usageDurable: context.usageDurable,
        terminalBlocked: context.terminalBlocked,
      });
    }

    const preliminary = resolveTurnFinalization(plan, { resultDurable: context.turn.resultDurable });
    const boundary = preliminary.effects.findIndex(entry => entry.type === 'append-assistant-result');
    if (boundary < 0) throw new Error('finalization append boundary missing');
    applyAll(preliminary.effects.slice(0, boundary));

    context.appendPersisted = ports.persistAssistant(context, plan.append) === true;
    const resolved = resolveTurnFinalization(plan, {
      appendPersisted: context.appendPersisted,
      resultDurable: context.turn.resultDurable,
    });
    const resolvedBoundary = resolved.effects.findIndex(entry => entry.type === 'append-assistant-result');
    if (resolvedBoundary < 0) throw new Error('resolved finalization append boundary missing');
    applyAll(resolved.effects.slice(resolvedBoundary + 1));
    return Object.freeze({
      resolved,
      appendPersisted: context.appendPersisted,
      finalText: context.finalText,
      usageDurable: context.usageDurable,
      terminalBlocked: context.terminalBlocked,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { assertFinalizeHostPorts, createTurnFinalizationExecutor };
