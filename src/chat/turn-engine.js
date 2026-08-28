'use strict';

// Chat turn engine: per-turn and persistent-streaming chat turn execution, the
// stream-json WebSocket handler, and the orchestration wait-injector helpers.
// Extracted from server.js. Host bindings that are reassigned (let) or composed
// late are injected as GETTERS so this module never snapshots a null/TDZ value;
// stable containers, hoisted functions and early-initialized consts are passed
// by reference. Pure/stateless helpers are required directly from src/*.

const crypto = require('crypto');
const {
  TurnRequestError,
  normalizeTurnRequest,
  planTurnAdmission,
  createDurableMessageProof,
  createProviderRouteProof,
  evaluateSpawnGuard,
  createTurnLifecycle,
  bindTurnUsageAttribution,
  createRunnerOwnership,
  assignKillReason,
  clearErrorFlagsForSucceededTurn,
  recordResultEvent,
  hasMatchingPartialCheckpoint,
  planTurnFinalization,
  createTurnFinalizationExecutor,
  detectErrorEnvelope,
  isKnownHarmlessStderrLine,
  sanitizeMessage: sanitizeApiErrorMessage,
  retryNotice,
} = require('./index');
const {
  createProviderAttemptRuntime,
  markHostErrorEnvelope,
  providerAttemptFields,
  tagProviderAttemptEvent,
} = require('./provider-attempt-runtime');
const {
  createProviderInvocationFactory,
  providerRetryRouteOptions,
} = require('./provider-invocation');
const { createAutoProviderRuntime } = require('./auto-provider-runtime');
const { redactProviderRouteCapability } = require('../observability');
const { createWsEnvelope } = require('../api-contract');
const { taskShortCode } = require('../classify/task-short-code');
const { composeMessage, renderPrompt } = require('../message-composer');
const {
  rememberActiveCliState, renderHandoffPrompt, stateSummary: cliStateSummary,
  buildHandoffCheckpoint, clearAllNativeCliStates,
} = require('../cli-switch');
const { cliHandoffSummary } = require('../cli/switch-runtime');
const { summarizeHistoryUsage } = require('../codex-usage');
const { buildReplayMessages } = require('../routes/chat-history');
const chatStream = require('../chat-stream');
const waitInjector = require('../wait-injector');
const providers = require('../providers');
const { createTurnTimingRecorder } = require('./turn-timing');
const { deriveOpenTasks } = require('./turn-event-replay');
const { createCodexRolloutGuard } = require('./codex-rollout-guard');
const { captureNativeSessionId } = require('./native-session-state');
const { createOpencodeContextGuard } = require('./opencode-context-guard');
const { isInternalExecutionSlot } = require('../session/public-session-access');
const { providerSelectionDto } = require('../auto-provider-config');

function appendAdapterAssistantText(current, text) {
  const prior = String(current || '');
  const next = String(text || '');
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

function normalizeClaudeToolResultContent(content) {
  if (!Array.isArray(content)) {
    const text = typeof content === 'string' ? content : JSON.stringify(content == null ? '' : content);
    const safeText = redactProviderRouteCapability(text);
    return { text: safeText, content: safeText };
  }
  const joined = content.map(item => item && typeof item.text === 'string' ? item.text : '').join('');
  const safeText = redactProviderRouteCapability(joined);
  const nonText = content.filter(item => !item || typeof item.text !== 'string')
    .map(item => redactProviderRouteCapability(item));
  return {
    text: safeText,
    content: [...(safeText ? [{ type: 'text', text: safeText }] : []), ...nonText],
  };
}

function normalizeClaudeAssistantSnapshot(event, currentText) {
  if (!event || event.type !== 'assistant' || !Array.isArray(event.message?.content)) return event;
  const nonText = event.message.content.filter(block => block?.type !== 'text');
  return {
    ...event,
    message: {
      ...event.message,
      textSnapshot: true,
      content: [
        ...(currentText ? [{ type: 'text', text: redactProviderRouteCapability(currentText) }] : []),
        ...nonText,
      ],
    },
  };
}

function markReplaySafeAssistantEnvelope(event, providerName) {
  if (!event || event.type !== 'assistant' || !Array.isArray(event.message?.content)) return event;
  const blocks = event.message.content;
  if (!blocks.length || !blocks.every(block => block && block.type === 'text')) return event;
  const envelope = detectErrorEnvelope(
    providerName,
    blocks.map(block => String(block.text || '')).join(''),
  );
  return envelope && envelope.body == null ? markHostErrorEnvelope(event) : event;
}

function recoverDispatchFromHistory(history, operation) {
  const messages = Array.isArray(history) ? history : [];
  const operationId = operation?.id || null;
  const requestId = operation?.requestOutboxId || null;
  if (!operationId) return null;
  const ownedUserIndexes = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    if (message.originDispatchId === operationId
        || (requestId && (message.deliveryId === requestId || message.clientMsgId === requestId))) {
      ownedUserIndexes.push(index);
    }
  }
  if (!ownedUserIndexes.length) return null;

  // A superseded provider process may leave a cancelled/partial assistant row.
  // Recovery belongs to the latest turn that explicitly retained the dispatch
  // lineage, not to the first assistant row after the original request.
  const userIndex = ownedUserIndexes.at(-1);
  const user = messages[userIndex];
  const turnId = user?.turnId || null;
  const assistants = [];
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user' && (!turnId || message.turnId !== turnId)) break;
    if (message.role !== 'assistant') continue;
    if (turnId && message.turnId && message.turnId !== turnId) continue;
    assistants.push(message);
  }
  const assistant = assistants.at(-1) || null;
  if (!assistant) return { completed: false, lastOutput: '' };
  if (assistant._interim || assistant.partial || assistant.cancelled || assistant.error) {
    return { completed: false, lastOutput: String(assistant.content || '').slice(-4000) };
  }
  return { completed: true, text: String(assistant.content || '') };
}

// How long after a restart the reconnect replay keeps surfacing tasks that
// the restart killed. Long enough to cover a reconnect right after the
// restart plus a couple of page refreshes; short enough that yesterday's
// interruptions don't pop up on every visit.
const RECONNECT_REPLAY_WINDOW_MS = 15 * 60 * 1000;

// In-memory delivery-handoff facts backing runnerDeliveryHandoff(). The probe
// distinguishes "message already written to history" (persisted) from "a runner
// actually took over" (handedOff). Semantics per lookup:
//   known && handedOff===false → safe to re-execute (we watched it fail
//     before handoff; re-running cannot duplicate side effects);
//   known && handedOff===true → idempotent skip as before;
//   unknown (no record, e.g. after a restart) → conservative crash-recovery
//     reading stands: persisted = delivered, because re-running a message
//     that may have executed risks duplicate side effects.
function createDeliveryProbeRegistry({ maxIdentities = 64, now = Date.now } = {}) {
  const bySession = new Map();
  function record(sessionName, clientMsgId, deliveryId, facts = {}) {
    if (!sessionName || (!clientMsgId && !deliveryId)) return;
    let byIdentity = bySession.get(sessionName);
    if (!byIdentity) {
      byIdentity = new Map();
      bySession.set(sessionName, byIdentity);
    }
    const entry = Object.freeze({
      handedOff: facts.handedOff === true,
      turnId: facts.turnId || null,
      at: Number(now()),
    });
    for (const identity of [clientMsgId, deliveryId]) {
      if (!identity) continue;
      byIdentity.delete(identity);
      byIdentity.set(identity, entry);
    }
    while (byIdentity.size > maxIdentities) {
      byIdentity.delete(byIdentity.keys().next().value);
    }
  }
  function lookup(sessionName, identity) {
    if (!sessionName || !identity) return null;
    const byIdentity = bySession.get(sessionName);
    const entry = byIdentity ? byIdentity.get(identity) : null;
    if (!entry) return null;
    return { known: true, handedOff: entry.handedOff, turnId: entry.turnId, at: entry.at };
  }
  return Object.freeze({ record, lookup });
}

// The outbox re-delivers a persisted message only when the live engine
// actually watched it fail BEFORE a runner took over (duplicate admission +
// known probe + handedOff===false). Everything else keeps the historical
// duplicate semantics.
function shouldReexecutePersistedDelivery(duplicateSeen, duplicatePersisted, probe) {
  return duplicateSeen === true && duplicatePersisted === true
    && !!probe && probe.known === true && probe.handedOff === false;
}

function createChatTurnEngine(deps) {
  const {
    // ── Getters for reassigned / late-composed host bindings ──
    getBackgroundTaskRuntime,   // const in host, but composed after this cluster's original position
    getSessionWorkHost,         // let
    getChatHistoryRuntime,      // let
    getChatHistoryService,      // let
    getExperimentalTuiChatRuntime,
    getSessionHibernation,
    isShuttingDown,             // let bool _shuttingDown
    getPort,                    // let PORT
    getClaudeProxyEnabled,      // let
    getClaudeOfficialViaProxy,  // let
    // ── Pass-by-reference: stable containers / hoisted fns / early consts ──
    persistedSessions,
    chatSessions,
    invalidSessions,
    logger,
    folderMemory,
    detached,
    routerToolHost,
    turnProgressHeartbeat,
    providerRouterRuntime,
    providerAttemptRuntime,
    providerLimitCache,
    apiErrorHost,
    codexUsageHost,
    usageLimitPoller,
    taskContextHost,
    userInputSignalHost,
    chatTurnPreparationRuntime,
    workspaceBroadcast,
    setSessionStatus,
    noteReportedModel,
    spawn,
    cwdForSession,
    handleGatewayControl,
    pushToGateway,
    providerFor,
    cliAvailabilitySummary,
    savePersistedSessionsBestEffort,
    saveNotes,
    pendingNotesFor,
    appendEvent,
    classifyTurnEnd,
    cancelClassify,
    emitRunningNotify,
    emitTurnOutcome,
    ensureCurrentTask,
    getTaskState,
    setTaskState,
    buildGatewayPrompt,
    buildDispatchContextPrompt,
    buildGoalLimitNote,
    appendChatMessage,
    loadChatHistory,
    // Read-only transcript view; see the WS replay below for why the cloning
    // load() is the wrong tool for a caller that only measures.
    viewChatHistory = loadChatHistory,
    scheduleIncrementalSave,
    chatBroadcast,
    sendWs,
    // Turn event journal (#110): absent only in unit tests that never
    // exercise the reconnect replay.
    turnEventJournal = null,
    persistFinalAssistantResult,
    recordDurableTurnUsage,
    runDurablePostTurn,
    isCurrentTurnRunner,
    assistantCheckpointKey,
    recordAdapterUserInput,
    isGlm52Session,
    normalizeEffort,
    cliEffortLevel,
    recordApiSuccess,
    evaluateTurnApiError,
    meaningfulTurnOutput,
    turnHasSideEffects,
    clearSessionApiErrorState,
    scheduleOwnedRetry,
    isNetworkUnhealthy,
    holdSession,
    getTokenUsage,
    resetRoleTokenUsage,
    providerTokenWindows,
    getPendingMemoryDistill,
    effectiveSessionModel,
    effectiveSessionEffort,
    codexStreamDisconnectContinuePrompt,
    CODEX_STREAM_DISCONNECT_CONTINUE_MAX,
    resolveGoalLimits,
    auxQueue,
    GATEWAY_ID,
    MULTICC_IMG_HINT,
    CHAT_HISTORY_PAGE,
  } = deps;

  // Shared [turn-timing] recorder: one instance for every adapter path (claude
  // stream + per-turn spawn). See src/chat/turn-timing.js for the t0-t3 contract.
  const turnTiming = createTurnTimingRecorder();
  const attemptRuntime = providerAttemptRuntime || createProviderAttemptRuntime();

  // ── Persisted ≠ delivered (delivery probe) ──
  // The outbox's persisted-delivery recovery used to treat "user message is in
  // chat history" as "delivered". A turn that persisted the message and then
  // aborted in preparation (e.g. PROVIDER_PRODUCER_NOT_DRAINED) left exactly
  // that evidence — message on disk, runner never took over — so the retry
  // acknowledged a delivery that never executed, and the message sat in
  // history forever unexecuted. The registry (see createDeliveryProbeRegistry
  // above) records, per delivery identity, the runner-handoff outcome observed
  // by THIS live process; orchestration probes it before acknowledging a
  // persisted delivery as delivered.
  const DELIVERY_PROBE_MAX_IDENTITIES = 64;
  const deliveryProbeRegistry = createDeliveryProbeRegistry({
    maxIdentities: DELIVERY_PROBE_MAX_IDENTITIES,
  });
  const recordDeliveryProbe = deliveryProbeRegistry.record;
  const runnerDeliveryHandoff = deliveryProbeRegistry.lookup;
  const autoProviderRuntime = deps.autoProviderRuntime || createAutoProviderRuntime({
    providers, providerLimitCache, emit: chatBroadcast, logger,
    hasLiveBackgroundTasks: sessionId => {
      try { return getBackgroundTaskRuntime()?.hasLiveBackgroundTasks?.(sessionId) === true; }
      catch (_) { return true; }
    },
  });

  function forwardProviderEvent(sessionName, cs, turn, runner, event) {
    const observed = attemptRuntime.observeEvent(runner && runner.providerAttempt, event);
    if (!observed || observed.accepted !== true) {
      logger.warn?.('provider_attempt_event_suppressed', {
        sessionId: sessionName,
        turnId: turn && turn.turnId,
        routeAttemptId: runner && runner.providerAttempt && runner.providerAttempt.routeAttemptId,
        code: observed && observed.code || 'attempt_unavailable',
      });
      return false;
    }
    const tagged = tagProviderAttemptEvent(attemptRuntime.scrubAttemptEvent(observed, event), observed);
    cs.lastStreamAt = Date.now();
    turnProgressHeartbeat.touchVisible(sessionName, turn.turnId);
    cs.streamReplay.push(tagged);
    if (cs.streamReplay.length > 500) cs.streamReplay.shift();
    chatBroadcast(sessionName, tagged);
    return true;
  }

  function finishProviderAttempt(runner, outcome, facts = {}) {
    if (!runner || !runner.providerAttempt) return null;
    return attemptRuntime.finishAttempt(runner.providerAttempt, { outcome, ...facts });
  }
  // Pre-resume size guard: archive an oversized codex rollout before the turn
  // resumes it (`codex exec resume` hangs internally on one — no request ever
  // leaves the process). See src/chat/codex-rollout-guard.js.
  const codexRolloutGuard = deps.codexRolloutGuard || createCodexRolloutGuard({
    logger, codexSessionHomeFor: providers.codexSessionHome,
    prepareCodexSessionHome: providers.prepareCodexSessionHome,
  });
  // Turn-admission water-level guard for OpenCode native sessions. Decision
  // only; rotation itself happens in runChatTurn via the shared
  // pendingCliHandoff machinery. See ./opencode-context-guard.js.
  const opencodeContextGuard = deps.opencodeContextGuard || createOpencodeContextGuard({ logger });
  // One boot-time sweep so expired archives get pruned even if no turn ever
  // archives again; delayed so it never touches startup critical path.
  const rolloutArchiveSweepTimer = setTimeout(() => {
    try { codexRolloutGuard.sweepExpiredArchives({ force: true }); } catch (_) {}
  }, 10000);
  rolloutArchiveSweepTimer.unref?.();
  function turnTimingsField(sessionName, turnId) {
    const record = turnTiming.get(sessionName, turnId);
    if (!record || record.t3 === null) return undefined;
    return {
      t0: record.t0, t1: record.t1, t2: record.t2, t3: record.t3,
      spawnMs: record.t1 - record.t0,
      sendMs: record.t2 - record.t1,
      firstByteMs: record.t3 - record.t2,
      totalMs: record.t3 - record.t0,
    };
  }

  // Keep the claude transcript inside the context window before `--resume` replays
  // it. Claude Code auto-compacts on its own, so this is the second line of
  // defence: it drops the pre-compaction weight claude no longer replays, and it
  // elides individual oversized entries — the case compaction cannot fix, since a
  // single multi-hundred-KB tool result is ~100K tokens on its own and has to fit
  // in the very request that would summarise it.
  //
  // Two things this call site got wrong before, both silent:
  //   • it required './src/chat/transcript-prune' — a path that cannot resolve from
  //     inside src/chat/ — so the throw landed in an empty catch and the gate had
  //     never once run in production;
  //   • it passed cliSessionId, but a chat session's streaming context lives under
  //     _streamSessionId. With the correct project directory that id resolves to a
  //     different (dead) transcript, which the pruner would happily trim and report
  //     success for while the live one kept growing.
  function pruneTranscript(sessionName, persisted) {
    let report = null;
    try {
      const { maybePrune } = require('./transcript-prune');
      report = maybePrune(
        cwdForSession(persisted),
        persisted._streamSessionId || persisted.cliSessionId,
      );
    } catch (error) {
      // Best-effort: a prune failure must never break the turn. But it must be
      // visible — an empty catch here is what hid the broken require for months.
      logger.warn('transcript_prune_failed', {
        sessionId: sessionName,
        error: error && error.message ? error.message : String(error),
      });
      return null;
    }
    if (!report) return null;
    const mb = (n) => `${(n / (1024 * 1024)).toFixed(2)}MB`;
    logger.info('transcript_pruned', {
      sessionId: sessionName,
      strategy: report.strategy,
      beforeBytes: report.beforeBytes,
      afterBytes: report.afterBytes,
      droppedLines: report.droppedLines,
      elidedEntries: report.elidedEntries,
      lostTurns: report.lostTurns,
      keptSummary: report.keptSummary,
      contextAffected: report.contextAffected,
    });
    try {
      appendEvent(persisted.dirId, 'context_pruned',
        `上下文整理 ${mb(report.beforeBytes)} → ${mb(report.afterBytes)}（${report.strategy}）`,
        sessionName);
    } catch (_) {}
    // Only surface a notice when the model's own view changed. A pure
    // pre-compaction cut is invisible to it and would just be noise.
    if (report.contextAffected) {
      const detail = report.lostTurns > 0
        ? `已丢弃 ${report.lostTurns} 轮最早的对话`
        : `已压缩 ${report.elidedEntries} 条过大的工具输出`;
      chatBroadcast(sessionName, {
        type: 'system',
        subtype: 'context_pruned',
        message: `上下文已自动整理：${mb(report.beforeBytes)} → ${mb(report.afterBytes)}，${detail}。`,
      });
      // The live process still holds the untrimmed context in memory; only a
      // restart (with --resume on the trimmed file) picks the change up.
      try { chatStream.recycle(sessionName, 'transcript-pruned'); } catch (_) {}
    }
    return report;
  }

  // Apply one claude-shaped stream-json event to chat session state, then forward
  // it to clients. Shared by the per-turn spawn path (handleLine) and the
  // persistent streaming path (runChatTurnStreaming) so the two never drift.
  // The `result` event is the turn boundary: it saves the assistant message,
  // returns the session to idle, and fires post-turn hooks.
  function applyClaudeChatEvent(cs, sessionName, evt, forward, turn, runner, providerName = 'claude') {
    if (!isCurrentTurnRunner(cs, turn, runner)) return;
    evt = attemptRuntime.scrubAttemptStructure(runner.providerAttempt, evt);
    turnProgressHeartbeat.touchActivity(sessionName, turn.turnId);
    if (evt.type === 'assistant' && evt.message?.model) noteReportedModel(sessionName, evt.message.model);
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'text') {
          turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
          cs.currentAssistantText = redactProviderRouteCapability(
            cs.currentAssistantText + String(block.text || ''),
          );
          setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
          // Incremental save: flush the in-progress assistant message to disk
          // every 5s so a crash/restart mid-turn doesn't lose the whole reply.
          scheduleIncrementalSave(sessionName, cs);
        }
        if (block.type === 'tool_use') {
          turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'tool', block.name);
          // startedAt/endedAt ride in the persisted tools array: replay clients
          // (web + app) read them to show measured durations and the trajectory
          // strip. Sessions persisted before this field simply have neither —
          // the clients' unknown state, never a fabricated 0ms.
          cs.currentToolCalls.push({ name: block.name, input: block.input, id: block.id, startedAt: Date.now() });
          getBackgroundTaskRuntime().recordMainToolUseId(sessionName, block.id);
          if (block.name === 'TaskOutput') getBackgroundTaskRuntime().markTaskOutputAwaiting(sessionName, block.input);
          const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
          if (editTools.includes(block.name)) {
            setSessionStatus(sessionName, { status: 'editing', currentFile: block.input?.file_path || null });
          } else if (block.name === 'Bash') {
            setSessionStatus(sessionName, { status: 'running', currentFile: null });
          } else {
            setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
          }
        }
      }
    }
    if (evt.type === 'user' && evt.message?.content) {
      const contentWasArray = Array.isArray(evt.message.content);
      const normalizedContent = [];
      for (const r of (contentWasArray ? evt.message.content : [evt.message.content])) {
        if (r.type === 'tool_result') {
          turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
          const tc = cs.currentToolCalls.find(t => t.id === r.tool_use_id);
          const normalized = normalizeClaudeToolResultContent(r.content);
          if (tc) {
            tc.result = normalized.text;
            tc.is_error = r.is_error || false;
            tc.endedAt = Date.now();
            if (tc.result && tc.result.length > 1000) tc.result = tc.result.slice(0, 1000) + '...';
          }
          normalizedContent.push({ ...r, content: normalized.content });
        } else {
          normalizedContent.push(r);
        }
      }
      evt = { ...evt, message: { ...evt.message,
        content: contentWasArray ? normalizedContent : normalizedContent[0],
      } };
    }
    if (evt.type === 'result') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'finalizing');
      cs.currentCost = evt.total_cost_usd || null;
      const apiFailure = evt.is_error === true || (evt.subtype && evt.subtype !== 'success' && /error|abort|timeout/i.test(evt.subtype));
      const detectedErrorEnvelope = detectErrorEnvelope(providerName, cs.currentAssistantText);
      const envelopeError = apiFailure ? null : detectedErrorEnvelope;
      if (envelopeError && envelopeError.body != null) {
        // Trailing envelope appended after real output: strip the error text so
        // it never reaches the transcript; the meaningful body below is still
        // checkpointed as a partial by the close finalizer (finalize-plan's
        // append.required path fires on apiError + hasOutput).
        cs.currentAssistantText = envelopeError.body;
      }
      if (apiFailure || envelopeError) {
        getChatHistoryRuntime().clearIncrementalSave(sessionName);
        cs._sawApiError = true;
        runner.sawApiError = true;
        const detail = evt.error && typeof evt.error === 'object' ? evt.error : {};
        runner.apiErrorRaw = detectedErrorEnvelope || {
          source: providerName === 'qoder' ? 'qoder_result' : 'claude_result',
          provider: providerName,
          code: detail.code || evt.subtype || detail.type,
          httpStatus: detail.http_status || detail.status_code || detail.status
            || evt.http_status || evt.status_code || evt.status,
          headers: detail.headers || evt.headers,
          requestId: detail.request_id || evt.request_id,
          message: detail.message || evt.result || evt.subtype || 'api_error',
        };
      } else {
        recordApiSuccess(providerName, { retryAttempt: runner.apiRetryAttempt || 0, runner });
        clearSessionApiErrorState(sessionName, cs);
      }
      // Hoisted out of the if-block: forward() below also needs usage. Block
      // scoping it made live clients miss the result event entirely.
      const usage = evt.usage || {};
      runner.pendingUsage = usage;
      if (!apiFailure && !envelopeError && (cs.currentAssistantText || cs.currentToolCalls.length)) {
        const resultDurable = persistFinalAssistantResult(sessionName, cs, turn, runner, {
          role: 'assistant', content: cs.currentAssistantText,
          tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
          cost: cs.currentCost, usage: Object.keys(usage).length ? usage : undefined, ts: Date.now(),
          turnTimings: turnTimingsField(sessionName, turn.turnId),
        }, { resultEvent: true });
        if (resultDurable) {
          recordDurableTurnUsage(sessionName, runner, usage);
          cs.chatTurnCount++;
          // Durable result marks the turn complete so classify does not resume
          // it as an unknown interruption (duplicate replies, 1x/2x/3x usage).
          cs._resultSaved = true;
        }
        // Cancel any pending incremental-save timer: the final message is now
        // persisted, so a timer firing 0-5s later would append a stale _interim
        // AFTER the final — a duplicate bubble on reconnect. Mirrors the cancel
        // in the child-process close handler.
        getChatHistoryRuntime().clearIncrementalSave(sessionName);
      } else if (!apiFailure && !envelopeError) {
        recordResultEvent(turn, runner, { current: true, persisted: false });
      } else {
        // An error result is a turn boundary, not a durable successful answer.
        // Close finalization may checkpoint meaningful partial output, while an
        // error-only envelope remains eligible for a safe bounded retry.
        recordResultEvent(turn, runner, { current: true, persisted: false });
      }
      // Include durationMs + num_turns in the result broadcast so clients
      // (web + app) can display per-message task timing without client-side
      // clock guesswork. durationMs is the wall-clock time from turnStartedAt
      // (user submit) to this result — "模型接到消息到输出完成的耗时".
      const _resultDurationMs = cs.turnStartedAt ? Date.now() - cs.turnStartedAt : undefined;
      forward({ type: 'result', total_cost_usd: evt.total_cost_usd, usage, durationMs: _resultDurationMs, num_turns: cs.chatTurnCount });
      // Final classification and all post-turn effects run from the owned
      // close/finalize boundary. The result event alone is not enough: history
      // persistence may have failed or a retry may still be planned.
      setSessionStatus(sessionName, { status: cs._resultSaved ? 'succeeded' : 'idle', currentFile: null });
      // Turn boundary: refresh this session's provider usage limit if it exposes a
      // poll-only quota surface (GLM window %, DeepSeek balance). Fire-and-forget,
      // TTL-throttled and account-deduped inside the poller; never blocks the turn.
      usageLimitPoller.onTurnComplete(sessionName);
    }
    // Drop claude's `system init` — server already sent its own (but keep the
    // runtime-reported model before discarding).
    if (evt.type === 'system' && evt.subtype === 'init') { noteReportedModel(sessionName, evt.model); return; }
    if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
      const snapshot = normalizeClaudeAssistantSnapshot(evt, cs.currentAssistantText);
      forward(markReplaySafeAssistantEnvelope(snapshot, providerName));
      return;
    }
    forward(evt);
  }

  // Apply adapter-neutral events to server-owned chat state. Wire-format parsing
  // belongs to each CLI adapter; this function owns persistence, status and the
  // Claude-shaped event contract consumed by existing clients.
  function applyAdapterChatEvent(provider, cs, persisted, sessionName, rawEvent, forward, turn, runner) {
    if (!isCurrentTurnRunner(cs, turn, runner)) return;
    turnProgressHeartbeat.touchActivity(sessionName, turn.turnId);
    const decoded = provider.decodeEvent(rawEvent) || [];
    for (let evt of (Array.isArray(decoded) ? decoded : [decoded])) {
      if (!evt) continue;
      evt = attemptRuntime.scrubAttemptStructure(runner.providerAttempt, evt);
      if (evt.type === 'claude_event') {
        applyClaudeChatEvent(cs, sessionName, evt.raw, forward, turn, runner, provider.name);
        continue;
      }
      if (evt.type === 'session_init') {
        if (evt.model) noteReportedModel(sessionName, evt.model);
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
        const captured = captureNativeSessionId(persisted, evt.sessionId, { fresh: runner.freshNativeSession });
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
          savePersistedSessionsBestEffort('runtime.chat-session-id-capture');
          console.log(`[multicc/chat] [${sessionName}] captured ${provider.name} session id=${captured.current}`);
        }
        continue;
      }
      if (evt.type === 'status') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, evt.phase || evt.status);
        setSessionStatus(sessionName, { status: evt.status || 'thinking', currentFile: evt.currentFile || null });
        continue;
      }
      if (evt.type === 'activity') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, {
          phase: evt.phase || 'tool', safeToolKind: evt.toolKind,
        });
        setSessionStatus(sessionName, { status: 'running', currentFile: null });
        continue;
      }
      if (evt.type === 'user_input_signal') {
        // A CLI's built-in ask tool (codex AskUserQuestion). Land it on the same
        // structured waiting path as the MCP request_user_input tool; only if that
        // fails fall through to a plain-text passthrough so the question is shown.
        const landed = getSessionWorkHost() && recordAdapterUserInput({
          evt, sessionId: sessionName, turnId: turn.turnId,
          recordInput: (signal) => getSessionWorkHost().recordInput(signal),
        });
        if (evt.log) console.warn(`[multicc/chat] [${sessionName}] ${provider.name} ${evt.log}`);
        if (landed && landed.ok) continue;
        evt = { type: 'assistant_text', text: (landed && landed.fallbackText) || evt.fallbackText || '' };
      }
      if (evt.type === 'assistant_text') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
        if (!evt.text) continue;
        cs.currentAssistantText = redactProviderRouteCapability(
          appendAdapterAssistantText(cs.currentAssistantText, evt.text),
        );
        forward({
          type: 'assistant',
          // A cumulative authoritative snapshot heals a dropped/replayed WS
          // fragment and reconciles any proxy part_delta preview. OpenCode and
          // ZCode emit several complete text parts; treating them as one-shot
          // final blocks made the browser keep only the first until history reload.
          message: {
            textSnapshot: true,
            content: [{ type: 'text', text: cs.currentAssistantText }],
          },
        });
        setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
        scheduleIncrementalSave(sessionName, cs);
        if (evt.log) console.warn(`[multicc/chat] [${sessionName}] ${provider.name} ${evt.log}`);
        continue;
      }
      if (evt.type === 'tool_start') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'tool', evt.name);
        // Same timing stamps as the claude path: startedAt at tool_start,
        // endedAt at tool_result/tool_update-completed, persisted with the
        // tools array so replay shows measured durations on every CLI.
        const tool = { name: evt.name, input: evt.input || {}, id: evt.id, startedAt: Date.now() };
        cs.currentToolCalls.push(tool);
        getBackgroundTaskRuntime().recordMainToolUseId(sessionName, evt.id);
        forward({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: evt.name, id: evt.id, input: evt.input || {} }] },
        });
        setSessionStatus(sessionName, { status: evt.status || 'running', currentFile: evt.currentFile || null });
        continue;
      }
      if (evt.type === 'tool_result') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
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
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId,
          evt.completed ? 'thinking' : 'tool', evt.name);
        const id = evt.id || `call_${cs.currentToolCalls.length}`;
        let tool = cs.currentToolCalls.find(item => item.id === id);
        if (!tool) {
          tool = { name: evt.name, input: evt.input || {}, id, startedAt: Date.now() };
          cs.currentToolCalls.push(tool);
          getBackgroundTaskRuntime().recordMainToolUseId(sessionName, id);
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
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
        // Publish the provider-normalized reasoning text as its own safe event.
        // Sync dispatch subscribes to this event; the existing synthetic
        // Thinking tool card remains for Web/App compatibility. No tool input,
        // result, signature or raw provider envelope crosses this boundary.
        const reasoningProgress = adapterReasoningProgressEvent(evt);
        if (reasoningProgress) forward(reasoningProgress);
        const tool = { name: 'Thinking', input: { text: evt.text || '' }, id: evt.id, result: evt.text || '' };
        cs.currentToolCalls.push(tool);
        getBackgroundTaskRuntime().recordMainToolUseId(sessionName, evt.id);
        forward({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Thinking', id: evt.id, input: tool.input }] },
        });
        // codex reasoning arrives complete (no partial stream), so pair it with a
        // tool_result immediately — otherwise the Thinking card is stuck showing
        // 「running...」forever because no result ever follows.
        forward({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: evt.id, content: evt.text || '', is_error: false }] },
        });
        continue;
      }
      if (evt.type === 'complete') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'finalizing');
        recordApiSuccess(provider.name, { retryAttempt: runner.apiRetryAttempt || 0, runner });
        clearSessionApiErrorState(sessionName, cs);
        codexUsageHost.complete({ evt, cs, persisted, sessionName, turn, runner, forward });
        continue;
      }
      if (evt.type === 'error') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId,
          evt.kind === 'transport_disconnect' ? 'recovering' : 'finalizing');
        if (evt.kind === 'response_completed_disconnect') {
          const publicMessage = sanitizeApiErrorMessage(evt.message);
          cs._codexPendingStreamError = publicMessage;
          cs._codexPendingStreamErrorCount = (cs._codexPendingStreamErrorCount || 0) + 1;
          const hasOutput = !!(cs.currentAssistantText || cs.currentToolCalls.length || cs._resultSaved);
          if (hasOutput) cs._codexRecoveredDisconnect = true;
          logger.warn('chat_provider_response_completed_disconnect', {
            sessionId: sessionName,
            provider: provider.name,
            afterOutput: hasOutput,
            occurrence: cs._codexPendingStreamErrorCount,
          });
        } else if (evt.kind === 'transport_disconnect') {
          const publicMessage = sanitizeApiErrorMessage(evt.message);
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
          const publicMessage = sanitizeApiErrorMessage(evt.message);
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

  async function admitChatWork(sessionName, text, opts = {}) {
    const performAdmission = async () => {
      const experimentalRuntime = getExperimentalTuiChatRuntime?.();
      if (experimentalRuntime?.owns(persistedSessions.get(sessionName))) {
        return experimentalRuntime.admit(sessionName, text, opts);
      }
      return getSessionWorkHost()
        ? getSessionWorkHost().admit(sessionName, text, opts)
        : null;
    };
    const sessionHibernation = getSessionHibernation?.();
    const taskBound = !!persistedSessions.get(sessionName)?.taskBoundTaskId;
    let admitted;
    try {
      admitted = taskBound && sessionHibernation
        ? await sessionHibernation.admit(sessionName, performAdmission)
        : await performAdmission();
    } catch (error) {
      if (taskBound && error?.code === 'SESSION_PERSISTENCE_FAILED') {
        logger.warn?.('chat_workspace_restore_failed', { sessionId: sessionName, code: error.code });
        try {
          chatBroadcast(sessionName, {
            type: 'error',
            error: '会话工作区状态无法安全保存，消息未被接收；请稍后重试。',
            code: 'workspace_restore_failed',
          });
        } catch (_) {}
      }
      throw error;
    }
    if (admitted?.workspaceUnavailable) {
      logger.warn?.('chat_workspace_restore_failed', { sessionId: sessionName, code: admitted.code });
      try {
        chatBroadcast(sessionName, {
          type: 'error',
          error: '会话工作区恢复失败，消息未被接收；已保留休眠数据，请稍后重试。',
          code: 'workspace_restore_failed',
        });
      } catch (_) {}
    }
    // scheduler_not_ready is the one admission failure nothing downstream
    // reports: the auth gates and 消息入队失败 paths broadcast their own error
    // frames, but a missing/unwired scheduler runtime means the message was
    // queued NOWHERE and no turn will ever start. Without this frame the user's
    // message vanished with zero feedback (M3).
    if (!admitted || admitted.code === 'scheduler_not_ready') {
      logger.warn?.('chat_admit_scheduler_not_ready', { sessionId: sessionName });
      try {
        chatBroadcast(sessionName, {
          type: 'error',
          error: '会话调度器尚未就绪，消息未被接收；请稍后重试。',
          code: 'scheduler_not_ready',
        });
      } catch (_) {}
    }
    return admitted || { ok: false, code: 'scheduler_not_ready' };
  }

  function runChatTurn(sessionName, text, opts = {}) {
    const persisted = persistedSessions.get(sessionName);
    if (!persisted) {
      console.warn(`[multicc/chat] runChatTurn: no persisted record for ${sessionName}`);
      return false;
    }
    if (persisted.taskBoundTaskId && getSessionHibernation?.()) {
      try { getSessionHibernation().assertAwake(sessionName); }
      catch (error) {
        logger.warn?.('chat_run_hibernated_workspace_blocked', { sessionId: sessionName, code: error.code });
        try { chatBroadcast(sessionName, { type: 'error', code: 'workspace_hibernated', error: '会话工作区尚未恢复，消息未执行；系统会保留并重试投递。' }); } catch (_) {}
        return false;
      }
    }
    const experimentalRuntime = getExperimentalTuiChatRuntime?.();
    if (experimentalRuntime?.owns(persisted)) {
      return experimentalRuntime.admit(sessionName, text, opts);
    }
    // Typed Commander user input is intercepted by the host router. Any fallback
    // Commander turn is deliberately barred from the legacy marker dispatcher.

    // Normalize once at the host boundary. Native CLI session ids and provider
    // credentials stay outside the pure request; only proof of native history is
    // admitted. Reuse the history read when a WS state has not been materialized.
    const existingCs = chatSessions.get(sessionName);
    let initialHistory = null;
    const turnCount = existingCs
      ? existingCs.chatTurnCount
      : (initialHistory = loadChatHistory(sessionName)).filter(message => message.role === 'assistant').length;
    const turnCli = (existingCs && existingCs.cli) || persisted.cli || 'claude';
    // Pre-resume rollout size guard (codex only): an oversized rollout makes
    // `codex exec resume` hang internally before its first upstream request.
    // Archiving it here and clearing cliSessionId turns THIS turn into a fresh
    // thread; MultiCC context layers are recomposed below by composeMessage.
    if (turnCli === 'codex' && persisted.cliSessionId) {
      const guardResult = codexRolloutGuard.enforce(persisted);
      if (guardResult.action === 'blocked') {
        logger.error('codex_rollout_guard_blocked', {
          sessionId: sessionName, code: guardResult.code,
        });
        chatBroadcast(sessionName, {
          type: 'error', code: guardResult.code,
          error: 'Codex 原生会话历史无法唯一定位；为避免恢复到错误上下文，本轮已阻止。请检查重复的 rollout 文件。',
        });
        return false;
      }
      if (guardResult.action === 'archived') {
        persisted.cliSessionId = null;
        savePersistedSessionsBestEffort();
        logger.warn('codex_rollout_archived', {
          sessionId: sessionName,
          archivedCliSessionId: guardResult.cliSessionId,
          maxBytes: guardResult.maxBytes,
          archived: guardResult.archived.map(item => ({ file: item.file, sizeBytes: item.sizeBytes, archivedTo: item.archivedTo })),
        });
        appendEvent(persisted.dirId, 'codex_rollout_archived',
          `codex rollout 超过 ${(guardResult.maxBytes / 1048576).toFixed(0)}MB 已归档，本轮将重建上下文`, sessionName);
        chatBroadcast(sessionName, {
          type: 'system',
          subtype: 'rollout_archived',
          message: `codex 原生会话历史过大（rollout > ${Math.round(guardResult.maxBytes / 1048576)}MB），已归档并重建上下文；旧历史文件保留在归档目录，未删除。`,
        });
      }
    }
    // Pre-turn water-level guard (opencode only): when the CURRENT native
    // session crossed a safe fraction of the model's real context limit,
    // rotate to a fresh native session. Full page history is untouched; the
    // bounded handoff checkpoint carries prior context into this turn, and
    // clearing cliSessionId below makes this turn a first turn (fresh
    // `opencode run`, no --continue) — mirroring the manual rotate path.
    if (turnCli === 'opencode' && persisted.cliSessionId) {
      const contextVerdict = opencodeContextGuard.enforce(persisted);
      if (contextVerdict.action === 'rotate') {
        const rotationHistory = initialHistory || loadChatHistory(sessionName);
        const checkpoint = buildHandoffCheckpoint({
          session: persisted, fromCli: 'opencode', toCli: 'opencode', history: rotationHistory,
        });
        checkpoint.reason = 'auto_native_context_rotate';
        persisted.pendingCliHandoff = {
          id: `checkpoint_${crypto.randomBytes(8).toString('hex')}`,
          fromCli: 'opencode',
          toCli: 'opencode',
          createdAt: checkpoint.createdAt,
          status: 'pending',
          reason: 'auto_native_context_rotate',
          reusedTarget: false,
          checkpoint,
        };
        const clearedNativeSessions = clearAllNativeCliStates(persisted);
        rememberActiveCliState(persisted);
        savePersistedSessionsBestEffort('runtime.opencode-context-rotate');
        logger.warn('opencode_context_rotated', {
          sessionId: sessionName,
          rotatedCliSessionId: contextVerdict.cliSessionId,
          tokensTotal: contextVerdict.tokensTotal,
          contextLimit: contextVerdict.contextLimit,
          ratio: contextVerdict.ratio,
          threshold: contextVerdict.threshold,
          clearedNativeSessions,
        });
        appendEvent(persisted.dirId, 'opencode_context_rotated',
          `OpenCode 原生上下文水位 ${(contextVerdict.ratio * 100).toFixed(0)}%（${contextVerdict.tokensTotal}/${contextVerdict.contextLimit} tokens），已自动轮换原生会话`, sessionName);
        chatBroadcast(sessionName, {
          type: 'system',
          subtype: 'native_context_rotated',
          auto: true,
          message: `OpenCode 原生上下文水位已达 ${(contextVerdict.ratio * 100).toFixed(0)}%，本轮自动切换到新的原生会话并附带最近上下文摘要；完整对话历史保留不变。`,
        });
      }
    }
    // Preserve the old host ordering without mutating a duplicate delivery: when
    // no WS state exists, Claude allocates its UUID during accepted preparation,
    // before deciding first-vs-resume. This future allocation is the only extra
    // native-history proof admitted here; Codex and existing chat states continue
    // to require an already persisted native session id.
    const willAllocateClaudeNativeSession = !existingCs && turnCli === 'claude' && !persisted.cliSessionId;
    const inheritedLineage = opts.originContinue === true
      && existingCs && existingCs._continuationLineage
      ? existingCs._continuationLineage.lineage
      : null;
    let turnRequest;
    try {
      turnRequest = normalizeTurnRequest({
        sessionId: sessionName,
        text,
        cli: turnCli,
        turnCount,
        hasNativeSession: !!persisted.cliSessionId || willAllocateClaudeNativeSession,
        requestId: opts.requestId,
        clientMsgId: opts.clientMsgId,
        deliveryId: opts.deliveryId,
        originDispatchId: opts.originDispatchId
          || (inheritedLineage && inheritedLineage.kind === 'dispatch' ? inheritedLineage.operationId : null),
        originTrigger: opts.originTrigger === true
          || !!(!opts.originDispatchId && inheritedLineage && inheritedLineage.kind === 'trigger'),
        originContinue: opts.originContinue,
        goalLimits: opts.goalLimits,
        bgTaskIds: opts.bgTaskIds,
        bgToolUseIds: opts.bgToolUseIds,
        ...taskContextHost.turnOptions(opts),
      });
    } catch (error) {
      const code = error instanceof TurnRequestError ? error.code : 'invalid_request';
      logger.warn('chat_turn_rejected_invalid_request', { sessionId: sessionName, code });
      return false;
    }

    text = turnRequest.text;
    const clientMsgId = turnRequest.identity.clientMsgId || '';
    const deliveryId = turnRequest.identity.deliveryId || '';
    const originDispatchId = turnRequest.origin.operationId;
    const originContinue = turnRequest.launch.reason === 'continue';
    const directUserInput = opts.directUserInput === true;
    const goalLimits = turnRequest.goalLimits;
    const bgTaskIds = turnRequest.background.taskIds;
    const bgToolUseIds = turnRequest.background.toolUseIds;
    const requestedTask = turnRequest.task;

    // Durable orchestration may replay an outbox claim after a crash in the
    // narrow window between history persistence and outbox acknowledgement.
    // Treat the persisted client/delivery id as the local idempotency key.  A
    // duplicate rewrites the cached history to disk (important after a previous
    // failed save) but never starts or interrupts another CLI turn.
    let duplicateSeen = false;
    let duplicatePersisted = false;
    if (clientMsgId || deliveryId) {
      if (clientMsgId && getChatHistoryService().containsDelivery(sessionName, clientMsgId)) {
        duplicateSeen = true;
        duplicatePersisted = getChatHistoryService().hasPersistedDelivery(sessionName, clientMsgId);
      } else if (deliveryId && getChatHistoryService().containsDelivery(sessionName, deliveryId)) {
        duplicateSeen = true;
        duplicatePersisted = getChatHistoryService().hasPersistedDelivery(sessionName, deliveryId);
      }
    }
    // Persisted ≠ delivered: if THIS live process watched the runner reject
    // this exact identity before handoff, the persisted user message is a
    // leftover of that failed attempt, not a delivered turn. Drop the
    // duplicate short-circuit and re-execute below (without appending a
    // second copy of the message to history). An unknown probe (restart)
    // keeps the conservative idempotent skip.
    const priorDeliveryProbe = runnerDeliveryHandoff(sessionName, clientMsgId || deliveryId);
    const reexecutePersistedDelivery = shouldReexecutePersistedDelivery(
      duplicateSeen, duplicatePersisted, priorDeliveryProbe,
    );
    if (reexecutePersistedDelivery) {
      duplicateSeen = false;
      duplicatePersisted = false;
      logger.warn?.('chat_turn_reexecute_persisted_delivery', {
        sessionId: sessionName,
        clientMsgId: clientMsgId || null,
        deliveryId: deliveryId || null,
        priorTurnId: priorDeliveryProbe.turnId || null,
      });
    }

    const streamBusy = turnRequest.cli === 'claude' && !!chatStream.status(sessionName)?.busy;
    let claudeManagedProxy = false;
    if (turnRequest.cli === 'claude' && getClaudeProxyEnabled() && persisted.provider) {
      try {
        const summary = providerRouterRuntime.getProviderSummary('claude', persisted.provider);
        claudeManagedProxy = !!(summary && (summary.baseUrl
          || (summary.isOfficial && getClaudeOfficialViaProxy())));
      } catch (_) {}
    }
    const admission = planTurnAdmission(turnRequest, {
      duplicateSeen,
      duplicatePersisted,
      shuttingDown: isShuttingDown(),
      sessionExists: true,
      networkUnhealthy: isNetworkUnhealthy(),
      runningTurn: !!(existingCs && existingCs.claudeProc) || streamBusy,
      backgroundWorkActive: claudeManagedProxy
        && getBackgroundTaskRuntime().hasLiveBackgroundTasks(sessionName),
    });
    if (admission.decision === 'duplicate') {
      // An accepted duplicate is a settled delivery (this or an earlier
      // attempt handed off): record it so retries keep skipping idempotently.
      if (admission.accepted) {
        recordDeliveryProbe(sessionName, clientMsgId, deliveryId, { handedOff: true });
      }
      return admission.accepted;
    }
    if (admission.decision === 'reject') {
      if (admission.reason === 'shutdown') logger.warn('chat_turn_rejected_shutdown', { sessionId: sessionName });
      if (admission.reason === 'background-work-active') chatBroadcast(sessionName, {
        type: 'error',
        error: '后台任务仍在运行；为隔离本轮 Provider 路由，本消息尚未执行。请等待任务结束或先取消任务后重试。',
      });
      return false;
    }
    if (admission.decision === 'hold') {
      holdSession(sessionName, 'classify-inject', text);
      console.log(`[multicc/net] ${sessionName}: suppress system inject (originContinue) — network unhealthy, held for recovery`);
      return false;
    }

    const turnId = `turn_${crypto.randomBytes(12).toString('hex')}`;
    const turn = createTurnLifecycle(turnRequest, { turnId });
    // t0 = when the server received the user message. The chat-send route entry
    // stamps opts.receivedAt (survives the durable outbox via payload.options);
    // trigger/continuation launches without it fall back to turn-start time.
    turnTiming.begin(sessionName, turnId, {
      t0: Number.isFinite(opts.receivedAt) ? opts.receivedAt : Date.now(),
      cli: turnRequest.cli,
    });
    const claimed = chatTurnPreparationRuntime.claim(sessionName, turnId, {
      cli: turnRequest.cli,
      transport: turnRequest.execution.transport,
    });
    if (!claimed.ok) {
      logger.warn('chat_turn_rejected_preparation_in_flight', { sessionId: sessionName, code: claimed.code });
      return false;
    }
    let preparationOpen = true;
    let preparationFailure = 'preparation-failed';
    let cs = existingCs;
    let runnerHandedOff = false;
    let preparationStateActivated = false;
    let messageDurable = false;
    let preparationAttempt = null;

    try {
    // A real user/trigger turn resets auto-continue guards. Degraded automatic
    // continuations were already held at admission until recordApiSuccess resumes them.
    // A real (non-auto-continue) message means the user/trigger is driving again →
    // reset the D auto-continue guard so a future background-wait gets fresh budget.
    if (!originContinue || directUserInput) { waitInjector.resetAuto(sessionName); waitInjector.resetBg(sessionName); waitInjector.resetInterrupted(sessionName); waitInjector.resetBgResult(sessionName); }
    // Ensure session-level state exists even when no WS client is connected.
    if (!cs) {
      const csCli = persisted.cli || 'claude';
      if (csCli === 'claude' && !persisted.cliSessionId) {
        persisted.cliSessionId = crypto.randomUUID();
        savePersistedSessionsBestEffort('runtime.chat-session-id-allocate');
      }
      const hist = initialHistory || loadChatHistory(sessionName);
      cs = {
        clients: new Set(),
        claudeProc: null,
        lineBuf: '',
        cli: csCli,
        chatTurnCount: hist.filter(m => m.role === 'assistant').length,
        cwd: cwdForSession(persisted),
        currentAssistantText: '',
        currentToolCalls: [],
        currentCost: null,
        isStreaming: false,
        streamReplay: [],
        _classifyTimer: null,
        _classifyTaskId: null,
        _currentTaskId: taskContextHost.restore(hist),
      };
      chatSessions.set(sessionName, cs);
    }

    cancelClassify(cs);
    if (!originContinue || directUserInput) {
      apiErrorHost.cancelRetry(sessionName, cs);
      cs._apiRetryAttempt = 0;
      cs._lastApiErrorDecision = null;
      setTaskState(sessionName, { apiError: null }, { save: false });
    }
    const detachTaskContext = (!requestedTask.id && opts.schedulerWorkKind === 'task')
      || (!!originDispatchId && !requestedTask.id);
    const {
      taskId: nextTaskId, boundaryChanged: taskBoundaryChanged,
      detached: taskDetached,
    } = taskContextHost.beginTurn(cs, requestedTask, { detach: detachTaskContext });
    const inferredTaskStart = !requestedTask.id && taskBoundaryChanged
      && !taskDetached && !!nextTaskId;
    const messageTask = inferredTaskStart ? {
      id: nextTaskId,
      start: true,
      source: 'aux',
      text,
    } : requestedTask;

    // Persist the canonical user event before any provider execution.
    // A re-executed delivery already has its user message in history from the
    // failed attempt; appending again would duplicate the bubble, so only the
    // durable-presence check runs (falling back to a normal append if the
    // history was cleared in between).
    let userMessageSaved = false;
    if (reexecutePersistedDelivery) {
      try {
        userMessageSaved = getChatHistoryService()
          .hasPersistedDelivery(sessionName, clientMsgId || deliveryId);
      } catch (_) { userMessageSaved = false; }
    }
    if (!userMessageSaved) userMessageSaved = appendChatMessage(sessionName, {
      role: 'user', content: text, ts: Date.now(),
      turnId,
      clientMsgId: clientMsgId || undefined,
      deliveryId: deliveryId || undefined,
      originDispatchId: originDispatchId || undefined,
      // Metadata-only marker that this user message settles a wait_for_user_answer
      // prompt (answeredQuestionId === the prompt's requestId). The provider still
      // receives only `content: text`, so the model never sees this — it is the
      // message-carried backup for the fire-and-forget user_input_resolved event:
      // any connection that receives this message (live chat_msg_meta or history
      // replay) can tear the prompt card down without relying on the event
      // arriving. Idempotent with consumeUserInputRequestId on the clients.
      answeredQuestionId: opts.userInputRequestId || undefined,
      ...taskContextHost.messageMetadata(messageTask, nextTaskId, { detached: taskDetached }),
      bgTaskIds: Array.isArray(bgTaskIds) && bgTaskIds.length ? bgTaskIds : undefined,
      bgToolUseIds: Array.isArray(bgToolUseIds) && bgToolUseIds.length ? bgToolUseIds : undefined,
    });
    const durableMessageProof = createDurableMessageProof(turnRequest, { persisted: userMessageSaved });
    if (!userMessageSaved) {
      preparationFailure = 'message-not-durable';
      console.error(`[multicc/chat] [${sessionName}] refusing turn: user message was not persisted`);
      chatBroadcast(sessionName, { type: 'error', error: '消息未能持久化，已安全停止本轮；系统稍后会重试。' });
      setSessionStatus(sessionName, { status: 'idle', currentFile: null });
      return false;
    }
    messageDurable = true;
    if (opts.userInputRequestId) {
      const resolvedInput = userInputSignalHost.resolve(sessionName, opts.userInputRequestId);
      if (!resolvedInput.ok) {
        preparationFailure = resolvedInput.code || 'user-input-resolution-rejected';
        throw new Error(`pending user input resolution rejected: ${preparationFailure}`);
      }
    }
    const messageMarked = chatTurnPreparationRuntime.markMessageDurable(sessionName, turnId);
    if (!messageMarked.ok) {
      preparationFailure = messageMarked.code || 'message-proof-rejected';
      throw new Error(`turn message proof rejected: ${preparationFailure}`);
    }
    userInputSignalHost.beginTurn(sessionName, {
      originContinue: originContinue && !directUserInput,
      turnId,
    });

    // Reset accumulators
    cs.currentAssistantText = '';
    cs.currentUserText = text;          // store user message for summary context
    // Synchronous task goal fallback (zero-latency first frame); the in-progress
    // classify loop will refine it to a stable noun-phrase goal within 60s.
    ensureCurrentTask(cs, sessionName, text, taskBoundaryChanged);
    cs.currentTaskName = cs.currentTask ? cs.currentTask.goal : '新任务'; // compat for legacy callers
    cs.currentToolCalls = [];
    cs.currentCost = null;
    cs.isStreaming = true;
    preparationStateActivated = true;
    cs.turnStartedAt = Date.now();  // for per-reply interaction latency (durationMs)
    cs.lastStreamAt = cs.turnStartedAt;  // watchdog baseline: don't inherit prior turn's stale lastStreamAt
    cs.streamReplay = [];
    cs._resultSaved = false;
    // Adapter CLIs (opencode/zcode/qoder/kimi) have no native message_start
    // passthrough like claude's stream-json, so the browser's isStreaming would
    // otherwise stay false for the whole live turn. stream_end already has a
    // symmetric broadcast at finalize; give every turn a matching start frame.
    // Deliberately NOT routed through forward()/streamReplay — reconnecting
    // clients learn streaming state from the init is_streaming flag instead.
    chatBroadcast(sessionName, { type: 'stream_start' });
    if (persisted.cli === 'claude') pruneTranscript(sessionName, persisted);
    cs._adapterError = null;
    cs._sawApiError = false;
    cs._activeTurn = turn;
    cs._activeRunner = null;
    cs._continuationLineage = { turnId: turn.turnId, lineage: turn.lineage };
    turnProgressHeartbeat.start(sessionName, turn.turnId, { phase: 'starting' });
    // Reset the per-turn role breakdown (main vs sub) collected by the claude-proxy
    // onUsage hook. A new user turn starts a fresh "本轮" window, so stale subagent
    // totals from the previous turn must not bleed into the new one.
    resetRoleTokenUsage(sessionName);
    cs._codexRecoveredDisconnect = false;
    cs._codexPendingStreamError = '';
    cs._codexPendingStreamErrorCount = 0;
    cs._codexTransportError = '';
    cs._codexStreamContinuationCount = 0;

    // Task start: show a neutral placeholder instantly. Structured finalization
    // decides P/D/W/B/E at turn end; best-effort Aux attribution names/groups the
    // task afterward and the periodic scan only retries unresolved names.
    cancelClassify(cs);
    emitRunningNotify(sessionName, `处理中：${(cs.currentTask && cs.currentTask.goal) || '新任务'}`);
    // Trigger/dispatch lineage is owned by `turn`; no session-global origin flag
    // is written here, so a stale finalize cannot leak ancestry into a new turn.
    setSessionStatus(sessionName, { status: 'thinking', currentFile: null });

    const provider = providerFor(cs);
    // For claude: first turn → --session-id <uuid>, subsequent → --resume <uuid>.
    // For codex:  first turn → exec --json, subsequent → exec resume <id> --json.
    const isFirstTurn = turnRequest.execution.isFirstTurn;

    // Unified message assembly (src/message-composer.js — message-builder Phase 2).
    // composeMessage builds the prompt text (cross-agent notes → gateway/dispatch →
    // goal-limit → user text → ultracode suffix) AND fires the notes-delivered side
    // effects, byte-for-byte identical to the former inline assembly that lived here
    // (regression-gated by tests/test-message-composer-golden.js suite 1). The
    // notes side effects now live INSIDE composeMessage, so they are intentionally
    // NOT duplicated here. renderPrompt() also provides stable text for retry and
    // continuation turns; every process invocation is built by the adapter.
    let envelope;
    try {
      envelope = composeMessage({
        text, persisted, sessionName,
        // taskContextSeed: a task-bound session's compiled ledger, injected as
        // a prompt layer for its first turn. It rides the send options (not the
        // record) so it is one-shot by construction — nothing to consume, and a
        // turn that never reached the provider simply gets it again.
        opts: {
          isFirstTurn, goalLimits, taskContextSeed: opts.taskContextSeed,
          mode: cs.cli === 'claude' ? 'streaming' : 'per-turn',
        },
        deps: {
          resolveRolePrompt: folderMemory.resolveRolePrompt, multiccImgHint: MULTICC_IMG_HINT,
          buildCliHandoffPrompt: (session) => renderHandoffPrompt(session && session.pendingCliHandoff),
          buildGatewayPrompt, buildDispatchContextPrompt, buildGoalLimitNote,
          pendingNotesFor, saveNotes, appendEvent, workspaceBroadcast, chatBroadcast,
          normalizeEffort, cliEffortLevel,
        },
      });
    } catch (e) {
      // composeMessage.validateEnvelope THROWS when NODE_ENV !== 'production', and
      // the multicc server is started via nohup/launchd without NODE_ENV set. Valid
      // turns never produce a violating envelope, so this catch is defense-in-depth:
      // a future envelope-construction bug degrades to a clean, visible per-turn abort
      // instead of an uncaught throw that could crash the process through the
      // synchronous trigger path (bus.emit('chat:run')).
      console.error(`[multicc/chat] [${sessionName}] composeMessage failed, aborting turn: ${e && e.message ? e.message : e}`);
      preparationFailure = 'message-compose-failed';
      try { chatBroadcast(sessionName, { type: 'error', error: `消息组装失败：${e && e.message ? e.message : e}` }); } catch (_) {}
      setSessionStatus(sessionName, { status: 'idle', currentFile: null });
      cs.isStreaming = false;
      return false;
    }
    const promptText = renderPrompt(envelope);
    const invocationFactory = createProviderInvocationFactory({
      providerRouterRuntime, providerAttemptRuntime: attemptRuntime, effectiveSessionModel,
    });
    const autoTurn = autoProviderRuntime.beginTurn({ session: persisted, turnId: turn.turnId });
    let providerAttemptNo = 0;
    const prepareInvocation = (attemptOptions = {}) => invocationFactory.prepare({
      request: turnRequest, turn, session: persisted, provider, envelope,
      attemptNo: ++providerAttemptNo,
      ...attemptOptions,
    });
    const initialInvocation = prepareInvocation({ reasonCode: 'route_resolved', ...autoTurn.initial() });
    preparationAttempt = initialInvocation.attempt;
    const {
      resolution: provEnv, invocationEnvelope, invocation,
      routeProof: providerRouteProof,
    } = initialInvocation;
    bindTurnUsageAttribution(turn, initialInvocation.baseUsageAttribution);
    const routeMarked = chatTurnPreparationRuntime.markProviderRouteResolved(sessionName, turnId, {
      resolved: true, proof: providerRouteProof,
    });
    if (!routeMarked.ok) {
      preparationFailure = routeMarked.code || 'provider-route-proof-rejected';
      throw new Error(`provider route proof rejected: ${preparationFailure}`);
    }
    const spawnGuard = evaluateSpawnGuard(turnRequest, {
      message: durableMessageProof,
      route: providerRouteProof,
      runtime: chatTurnPreparationRuntime.claimProof(sessionName, turnId),
    });
    if (!spawnGuard.ok) {
      preparationFailure = spawnGuard.code || 'spawn-proof-missing';
      throw new Error(`turn spawn refused: ${(spawnGuard.missing || []).join(', ')}`);
    }
    const started = chatTurnPreparationRuntime.start(sessionName, turnId);
    if (!started.ok) {
      preparationFailure = started.code || 'runtime-start-rejected';
      throw new Error(`turn runtime start rejected: ${preparationFailure}`);
    }

    // ── Streaming path (claude only — always on) ──
    // Persistent process kept warm across turns so a turn that ends in a
    // "waiting for external data" state leaves a live, in-context process ready
    // to continue (fed by the next message / the waiting-injector) instead of a
    // dead one needing a cold --resume. Streaming is now claude chat's only mode
    // (the per-turn toggle was removed); non-claude CLIs use the per-turn spawn
    // path below, unchanged.
    if (cs.cli === 'claude') {
      const accepted = runChatTurnStreaming(
        sessionName, cs, persisted, initialInvocation, provider, turn, prepareInvocation, autoTurn,
      );
      if (!accepted) {
        preparationFailure = 'stream-runner-rejected';
        return false;
      }
      runnerHandedOff = true;
      const released = chatTurnPreparationRuntime.settle(sessionName, turnId, {
        status: 'delegated', reason: 'claude-stream',
      });
      preparationOpen = false;
      if (!released.ok) {
        logger.error('chat_turn_preparation_release_failed_after_handoff', {
          sessionId: sessionName, turnId, runner: 'claude-stream', code: released.code,
        });
      }
      return true;
    }

    const args = [...invocation.args, invocation.payload];
    console.log(`[multicc/chat] Spawning ${cs.cli} (turn ${cs.chatTurnCount}, first=${isFirstTurn}${provEnv.providerName ? `, provider=${provEnv.providerName}` : ''}): ${invocation.cmd} ${args.join(' ').slice(0, 200)}...`);

    // Every physical retry resolves a fresh immutable invocation attempt without
    // replaying composeMessage's note-delivery side effects.
    const spawnChat = (prepared, isRetry, apiRetryAttempt = 0) => {
      const { invocation: physicalInvocation, attempt, routeOverrides, binding, proxySessionId } = prepared;
      const spawnArgs = [...physicalInvocation.args, physicalInvocation.payload];
      let childEnv;
      try {
        ({ env: childEnv } = providerRouterRuntime.buildChildEnv(process.env, persisted, {
          TERM: 'dumb', NO_COLOR: '1',
          // Let the bundled multicc-trigger skill know who it is and where the
          // localhost API lives, so it can register/manage triggers for us.
          MULTICC_SESSION_ID: sessionName,
          MULTICC_DIR_ID: persisted.dirId || '',
          MULTICC_BASE_URL: `http://127.0.0.1:${getPort()}`,
        }, routeOverrides));
      } catch (error) {
        attemptRuntime.finishAttempt(attempt, {
          outcome: 'failed', errorCategory: 'spawn_env', reasonCode: 'child_env_failed',
        });
        throw error;
      }
      try {
        if (persisted.cli === 'claude') providers.applyClaudeProxyEnv(childEnv, {
          providerId: binding.providerId, sessionId: proxySessionId,
          subagent: persisted.subagent, port: getPort(), enabled: getClaudeProxyEnabled(),
          officialOAuth: getClaudeOfficialViaProxy(),
        });
        if (persisted.cli === 'codex') {
          const proxyRequired = providers.codexProxyConfigRequired({
            providerId: binding.providerId,
            subagent: persisted.subagent,
          });
          const proxyApplied = providers.applyCodexProxyConfig(childEnv, {
            providerId: binding.providerId, sessionId: proxySessionId,
            subagent: persisted.subagent, port: getPort(),
            logicalSessionId: sessionName, nativeSessionId: persisted.cliSessionId,
            allowMissingNativeSession: prepared.invocationEnvelope.historyHandle.isFirstTurn === true,
          });
          providers.assertCodexProxyConfigApplied({ required: proxyRequired, applied: proxyApplied });
        }
      } catch (error) {
        providers.releaseCodexProxyConfig(childEnv);
        attemptRuntime.finishAttempt(attempt, {
          outcome: 'failed', errorCategory: 'proxy_config', reasonCode: 'proxy_config_failed',
        });
        throw error;
      }
      const runner = createRunnerOwnership(turn, {
        runnerId: `proc_${crypto.randomBytes(8).toString('hex')}`,
        kind: 'process', providerAttempt: attempt,
        routeProof: prepared.routeProof,
        usageAttribution: prepared.usageAttribution,
      });
      runner.freshNativeSession = prepared.invocationEnvelope.historyHandle.isFirstTurn === true;
      let proc;
      try {
        proc = routerToolHost.spawnProcess({
        cli: persisted.cli, spawn, command: physicalInvocation.cmd,
        args: spawnArgs, cwd: cs.cwd, env: childEnv,
        sessionId: sessionName, turnId: turn.turnId, originDispatchId,
        // Correlation key for post-admission receipts addressed to this turn.
        requestId: turn.requestId || '',
        userText: turn.userText,
        taskId: turn.task?.id,
        taskStart: turn.task?.start,
        taskSource: turn.task?.source,
        baseUrl: `http://127.0.0.1:${getPort()}`,
      });
      } catch (error) {
        providers.releaseCodexProxyConfig(childEnv);
        finishProviderAttempt(runner, 'failed', {
          errorCategory: 'spawn_failed', reasonCode: 'process_spawn_failed',
        });
        throw error;
      }
      runner.apiRetryAttempt = Math.max(0, Number(apiRetryAttempt) || 0);
      cs._activeTurn = turn;
      cs._activeRunner = runner;
      cs.claudeProc = proc;

      const spawnTs = Date.now();
      console.log(`[multicc/chat] [${sessionName}] ${cs.cli} spawned pid=${proc.pid} turn=${cs.chatTurnCount} isRetry=${!!isRetry} clients=${cs.clients.size}`);
      // Timing t1 = child spawned, t2 = prompt sent. On this path the prompt
      // travels as argv at spawn time (stdio is ['ignore','pipe','pipe'] — no
      // stdin), so t2 === t1. The real upstream HTTP request happens INSIDE the
      // CLI process and is not observable from the server; t2 is our boundary.
      turnTiming.markSpawned(sessionName, turn.turnId, spawnTs);
      turnTiming.markSent(sessionName, turn.turnId, spawnTs);
      let stderrBuf = '';
      let stderrPending = '';
      const isActiveProc = () => cs.claudeProc === proc && isCurrentTurnRunner(cs, turn, runner);

      // Normalize a single JSONL line into the claude-shaped event stream the frontend
      // already consumes. Returns an array of events to forward (may be empty), or null
      // to forward the original event as-is (claude path).
      const handleLine = (line) => {
        if (!attemptRuntime.acceptEvent(runner.providerAttempt)) return;
        let evt;
        try { evt = JSON.parse(line); }
        catch {
          // A malformed JSONL line is a dropped event (M5) - count it and log
          // the first few so adapter output corruption is observable.
          cs._jsonlParseErrors = (cs._jsonlParseErrors || 0) + 1;
          if (cs._jsonlParseErrors <= 5) {
            logger.warn('chat_jsonl_parse_failed', {
              sessionId: sessionName,
              provider: cs.cli,
              count: cs._jsonlParseErrors,
              bytes: line.length,
            });
          }
          return;
        }

        applyAdapterChatEvent(provider, cs, persisted, sessionName, evt, forward, turn, runner);
      };

      const forward = (evt) => {
        forwardProviderEvent(sessionName, cs, turn, runner, evt);
      };

      proc.stdout.on('data', (chunk) => {
        if (!isActiveProc()) return;
        // Timing t3 = first reply byte (earliest observable stdout signal).
        turnTiming.markFirstByte(sessionName, turn.turnId);
        cs.lineBuf += chunk.toString();
        const lines = cs.lineBuf.split('\n');
        cs.lineBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { handleLine(line); } catch (_) {}
        }
      });

      proc.stderr.on('data', (chunk) => {
        if (!isActiveProc()) return;
        // Buffer to whole lines before judging: a harmless-looking prefix must
        // not be dropped when the rest of the line (possibly the real error)
        // has not arrived yet. Known-harmless provider chatter (codex skill
        // load warnings, model-refresh timeouts, …) never enters the warn log
        // or the close-time stderr tail.
        stderrPending += chunk.toString();
        const lines = stderrPending.split('\n');
        stderrPending = lines.pop();
        for (const line of lines) {
          if (isKnownHarmlessStderrLine(line)) continue;
          stderrBuf += line + '\n';
          logger.warn('chat_provider_stderr', {
            sessionId: sessionName,
            provider: cs.cli,
            message: sanitizeApiErrorMessage(line),
          });
        }
      });

      proc.on('error', (err) => {
        if (!isActiveProc()) return;
        turnTiming.abort(sessionName, turn.turnId, `spawn_error:${(err && err.code) || 'unknown'}`);
        runner.apiErrorRaw = {
          source: 'process_stderr',
          provider: cs.cli,
          code: err && err.code || 'spawn_failed',
          message: err && err.message,
        };
        logger.error('chat_provider_spawn_error', {
          sessionId: sessionName,
          provider: cs.cli,
          code: err && err.code || 'spawn_failed',
        });
      });

      proc.on('close', (code, signal) => {
        providers.releaseCodexProxyConfig(childEnv);
        if (!isActiveProc()) {
          console.log(`[multicc/chat] [${sessionName}] stale proc pid=${proc.pid} closed after replacement (code=${code}, signal=${signal || ''})`);
          return;
        }
        if (cs.lineBuf.trim()) {
          try { handleLine(cs.lineBuf); } catch (_) {}
        }
        cs.lineBuf = '';
        if (stderrPending.trim() && !isKnownHarmlessStderrLine(stderrPending)) {
          stderrBuf += stderrPending + '\n';
        }
        stderrPending = '';
        const durMs = Date.now() - spawnTs;
        const killReason = runner.killReason || null;
        const pendingStreamError = cs._codexPendingStreamError || '';
        const pendingTransportError = cs._codexTransportError || '';
        const pendingStreamErrorCount = cs._codexPendingStreamErrorCount || 0;
        const hasTurnOutput = !!(cs._resultSaved || cs.currentAssistantText || cs.currentToolCalls.length);
        if (pendingStreamError && !hasTurnOutput && !cs._adapterError) {
          cs._adapterError = pendingStreamError;
          forward({ type: 'error', error: `Codex 出错：${pendingStreamError}` });
        }
        const recoveredCodexDisconnect = (!!cs._codexRecoveredDisconnect || !!pendingStreamError) && hasTurnOutput;
        const sanitizedStderrTail = sanitizeApiErrorMessage(stderrBuf.slice(-300).trim(), '');
        const diag = {
          session: sessionName, cli: cs.cli, pid: proc.pid, code, signal, durMs, killReason,
          resultSaved: !!turn.resultDurable,
          gotText: (cs.currentAssistantText || '').length,
          toolCalls: cs.currentToolCalls.length,
          liveClients: cs.clients.size,
          isRetry: !!isRetry,
          recoveredCodexDisconnect,
          pendingTransportError: pendingTransportError.slice(0, 200),
          pendingStreamErrorCount,
          stderrTail: sanitizedStderrTail,
        };
        let kind = 'normal';
        if (signal) kind = killReason ? `killed(${killReason})` : `signaled(${signal})`;
        else if (code !== 0 && !recoveredCodexDisconnect) kind = 'nonzero_exit';
        else if (!turn.resultDurable && !cs.currentAssistantText && !cs.currentToolCalls.length) kind = 'empty_exit';
        console.log(`[multicc/chat] [${sessionName}] close kind=${kind} ${JSON.stringify(diag)}`);
        const attemptFacts = attemptRuntime.snapshot(sessionName);
        const partialOutput = meaningfulTurnOutput(cs) || !!attemptFacts?.visibleOutputObserved;
        const sideEffects = turnHasSideEffects(cs)
          || !!attemptFacts?.toolIntentObserved || !!attemptFacts?.sideEffectObserved;
        // A durable result + clean close proves the turn succeeded; any error
        // flagged mid-stream (codex emits internal housekeeping failures as
        // stream error items, then finishes fine) was recovered from and must
        // not classify this turn as an API error.
        if (clearErrorFlagsForSucceededTurn(turn, runner, cs, { code, killReason })) {
          logger.info?.('chat_error_flags_cleared_after_success', {
            sessionId: sessionName,
            provider: cs.cli,
          });
        }
        const shouldClassifyApiError = !!(
          runner.apiErrorRaw
          || runner.sawApiError
          || runner.adapterError
          || pendingTransportError
          || killReason
          || code !== 0
          || (!turn.resultDurable && !hasTurnOutput)
        );
        const rawApiError = killReason ? {
          source: 'process_stderr',
          provider: cs.cli,
          code: killReason,
          message: 'turn cancelled',
        } : runner.apiErrorRaw || {
          source: 'process_stderr',
          provider: cs.cli,
          code: killReason || (code !== 0 ? `process_exit_${code}` : 'empty_exit'),
          message: pendingTransportError || sanitizedStderrTail || (killReason ? 'turn cancelled' : 'provider returned no result'),
        };
        const apiErrorDecision = shouldClassifyApiError
          ? evaluateTurnApiError({
            sessionName,
            cs,
            persisted,
            turn,
            runner,
            raw: rawApiError,
            attempt: runner.apiRetryAttempt || 0,
            phase: partialOutput || sideEffects ? 'stream' : 'before_first_token',
            partialOutput,
            sideEffects,
            deferNotice: autoTurn.enabled,
          })
          : null;
        // A Codex transport continuation must stay on the physical route whose
        // native conversation is being resumed. Do not consume an Auto pool
        // candidate before the finalizer gives that continuation precedence.
        const deferAutoToCodexContinuation = cs.cli === 'codex' && !!pendingStreamError;
        const autoFailover = apiErrorDecision && !deferAutoToCodexContinuation
          ? autoTurn.failover(apiErrorDecision, attemptFacts) : null;
        const effectiveApiErrorDecision = autoFailover?.decision || apiErrorDecision;
        if (autoFailover?.invocationOptions) chatBroadcast(sessionName, {
          type: 'system', subtype: 'warning',
          message: `Auto Provider：${autoFailover.fromProviderName} 不可用，正在切换到 ${autoFailover.toProviderName}。`,
        });
        else if (autoTurn.enabled && apiErrorDecision && !deferAutoToCodexContinuation) chatBroadcast(sessionName, {
          type: 'system', subtype: 'warning', message: retryNotice(effectiveApiErrorDecision),
        });
        const closeCheckpointKey = assistantCheckpointKey(cs);
        const finalizePlan = planTurnFinalization({
          current: true,
          runnerKind: 'process',
          cli: cs.cli,
          code,
          signal,
          killReason,
          apiError: !!effectiveApiErrorDecision || !!runner.sawApiError,
          apiErrorDecision: effectiveApiErrorDecision,
          adapterError: !!runner.adapterError,
          retryBlockedByAdapterError: !!cs._adapterError,
          retryPlanned: !!runner.retryPlanned,
          resultEvent: !!runner.resultEvent,
          resultDurable: !!turn.resultDurable,
          hasOutput: hasTurnOutput,
          sameDurablePartial: hasMatchingPartialCheckpoint(runner, closeCheckpointKey),
          isRetry: !!isRetry,
          recoveredTransport: recoveredCodexDisconnect,
          pendingStreamError,
          nativeSession: !!persisted.cliSessionId,
          codexDisconnectAttempt: cs._codexStreamContinuationCount || 0,
          freshStartAttempt: isRetry ? 1 : 0,
          handoff: persisted.pendingCliHandoff,
          auxUnhealthy: auxQueue.isUnhealthy(),
        }, {
          retry: { limits: { codexDisconnect: CODEX_STREAM_DISCONNECT_CONTINUE_MAX } },
        });

        // Timing: a terminal close with no first reply byte gets one abort line.
        // Retry/continuation plans keep the record open — the next attempt may
        // still deliver the first byte under the same turnId.
        if (!['continue-codex', 'retry-api', 'retry-fresh'].includes(finalizePlan.action)) {
          turnTiming.abort(sessionName, turn.turnId,
            `closed_before_first_byte:code=${code}${signal ? `:signal=${signal}` : ''}`);
        }

        const executeBlockedRetry = (error) => {
          runner.retryPlanned = false;
          logger.warn('provider_attempt_retry_blocked', {
            sessionId: sessionName,
            providerId: runner.providerAttempt && runner.providerAttempt.providerId,
            routeAttemptId: runner.providerAttempt && runner.providerAttempt.routeAttemptId,
            code: error && error.code || 'attempt_prepare_failed',
          });
          const blockedPlan = planTurnFinalization({
            ...finalizePlan.facts,
            apiError: true,
            apiErrorDecision: null,
            retryPlanned: false,
            handoff: persisted.pendingCliHandoff,
          });
          turnProgressHeartbeat.stop(sessionName, turn.turnId);
          turnFinalizationExecutor.execute(blockedPlan, {
            runnerKind: 'process', sessionName, cs, persisted, turn, runner,
            code, signal, stderrTail: sanitizedStderrTail, pendingTransportError,
          });
        };

        const prepareRetryAttempt = (options) => {
          finishProviderAttempt(runner, 'failed', {
            errorCategory: apiErrorDecision?.error?.category || 'retry',
            reasonCode: options.reasonCode,
          });
          try { return prepareInvocation(options); }
          catch (error) { executeBlockedRetry(error); return null; }
        };

        const currentRouteOptions = () => providerRetryRouteOptions(runner.providerAttempt);

        if (finalizePlan.action === 'continue-codex') {
          cs._codexStreamContinuationCount = finalizePlan.retry.attempt;
          cs._codexRecoveredDisconnect = false;
          cs._codexPendingStreamError = '';
          cs._codexPendingStreamErrorCount = 0;
          cs.isStreaming = true;
          cs.lastStreamAt = Date.now();  // watchdog: fresh baseline for the continuation spawn (turnStartedAt may be >10min old)
          const continuePrompt = codexStreamDisconnectContinuePrompt();
          const continueInvocation = prepareRetryAttempt({
            bareText: continuePrompt, firstTurn: false, continuation: true,
            reasonCode: 'codex_transport_continuation', ...currentRouteOptions(),
          });
          if (!continueInvocation) return;
          const msg = isGlm52Session(persisted)
            ? `正在使用 GLM-5.2 最高档：检测到连接中断，正在自动续跑剩余任务（${cs._codexStreamContinuationCount}/${CODEX_STREAM_DISCONNECT_CONTINUE_MAX}）。`
            : `检测到 Codex 连接中断，正在自动续跑剩余任务（${cs._codexStreamContinuationCount}/${CODEX_STREAM_DISCONNECT_CONTINUE_MAX}）。`;
          chatBroadcast(sessionName, { type: 'system', subtype: 'warning', message: msg });
          setSessionStatus(sessionName, { status: 'running', currentFile: null });
          console.warn(`[multicc/chat] [${sessionName}] auto-continuing codex after response.completed disconnect #${cs._codexStreamContinuationCount}`);
          runner.retryPlanned = true;
          try { cs.claudeProc = spawnChat(continueInvocation, true); }
          catch (error) { executeBlockedRetry(error); }
          return;
        }

        if (finalizePlan.action === 'retry-fresh') {
          const stderrTail = stderrBuf.slice(-300).trim();
          const reason = pendingTransportError ? 'codex transport disconnected'
            : stderrTail.includes('already in use') ? 'session-id conflict'
            : stderrTail.includes('No conversation found') || stderrTail.includes('session not found') ? 'resume target missing'
            : `exit ${code}${signal ? '/' + signal : ''}`;
          logger.warn('chat_empty_exit_fresh_retry', {
            sessionId: sessionName,
            provider: cs.cli,
            reason,
            stderr: sanitizeApiErrorMessage(stderrTail),
          });
          // Reset session id so the retry starts a brand-new conversation
          if (cs.cli === 'claude') persisted.cliSessionId = crypto.randomUUID();
          else persisted.cliSessionId = null;  // codex will allocate on first turn
          rememberActiveCliState(persisted);
          savePersistedSessionsBestEffort('runtime.chat-session-retry-reset');
          cs.chatTurnCount = 0;
          cs.isStreaming = true;
          cs.lastStreamAt = Date.now();  // watchdog: fresh baseline for the retry spawn (turnStartedAt may be >10min old)
          cs.streamReplay = [];
          cs._codexTransportError = '';
          const fallbackInvocation = prepareRetryAttempt({
            bareText: promptText, firstTurn: true, reasonCode: 'fresh_retry', ...currentRouteOptions(),
          });
          if (!fallbackInvocation) return;
          chatBroadcast(sessionName, {
            type: 'system', subtype: 'warning',
            message: `${cs.cli} 启动失败（${reason}），已用新会话重试`,
          });
          runner.retryPlanned = true;
          try { cs.claudeProc = spawnChat(fallbackInvocation, true); }
          catch (error) { executeBlockedRetry(error); }
          return;
        }
        if (finalizePlan.action === 'retry-api') {
          cs.claudeProc = null;
          finishProviderAttempt(runner, 'failed', {
            errorCategory: apiErrorDecision?.error?.category || 'api_error',
            reasonCode: 'api_retry_scheduled',
          });
          scheduleOwnedRetry({
            sessionName, cs, persisted, turn, runner,
            decision: finalizePlan.retry, provider: cs.cli,
            start: () => {
              let retryInvocation;
              try {
                retryInvocation = prepareInvocation(autoFailover?.invocationOptions
                  || { reasonCode: 'same_provider_retry', ...currentRouteOptions() });
              } catch (error) {
                executeBlockedRetry(error);
                return null;
              }
              try { return spawnChat(retryInvocation, true, finalizePlan.retry.attempt); }
              catch (error) { executeBlockedRetry(error); return null; }
            },
          });
          return;
        }
        if (turn.resultDurable && !apiErrorDecision) autoTurn.recordSuccess(runner.providerAttempt);
        finishProviderAttempt(runner, turn.resultDurable && !apiErrorDecision ? 'succeeded' : 'failed', {
          errorCategory: apiErrorDecision?.error?.category || null,
          reasonCode: finalizePlan.action,
        });
        turnProgressHeartbeat.stop(sessionName, turn.turnId);
        turnFinalizationExecutor.execute(finalizePlan, {
          runnerKind: 'process', sessionName, cs, persisted, turn, runner,
          code,
          signal,
          stderrTail: sanitizedStderrTail,
          pendingTransportError,
        });
      });

      return proc;
    };

    cs.claudeProc = spawnChat(initialInvocation, false);
    if (!cs.claudeProc) {
      preparationFailure = 'process-runner-rejected';
      return false;
    }
    runnerHandedOff = true;
    const released = chatTurnPreparationRuntime.settle(sessionName, turnId, {
      status: 'delegated', reason: 'cli-process',
    });
    preparationOpen = false;
    if (!released.ok) {
      logger.error('chat_turn_preparation_release_failed_after_handoff', {
        sessionId: sessionName, turnId, runner: 'cli-process', code: released.code,
      });
    }
    return true;
    } catch (error) {
      if (preparationFailure === 'preparation-failed') preparationFailure = 'preparation-exception';
      if (runnerHandedOff) {
        logger.error('chat_turn_host_error_after_runner_handoff', {
          sessionId: sessionName, turnId, error: error && error.message,
        });
        preparationOpen = false;
        return true;
      }
      if (preparationAttempt) {
        attemptRuntime.finishAttempt(preparationAttempt, {
          outcome: 'failed', errorCategory: 'preparation', reasonCode: preparationFailure,
        });
      }
      console.error(`[multicc/chat] [${sessionName}] turn preparation failed before runner handoff: ${error && error.message ? error.message : error}`);
      const publicError = messageDurable
        ? '消息已保存，但本轮准备失败，尚未启动新的 CLI 请求。'
        : '本轮准备失败，尚未启动新的 CLI 请求。';
      try { chatBroadcast(sessionName, { type: 'error', error: publicError }); } catch (_) {}
      if (cs && preparationStateActivated) cs.isStreaming = false;
      if (preparationStateActivated) {
        setSessionStatus(sessionName, { status: 'idle', currentFile: null });
      }
      return false;
    } finally {
      // Record the runner-handoff outcome for this delivery identity so the
      // outbox's persisted-delivery recovery can distinguish "persisted and
      // executed" from "persisted but aborted before the runner took over".
      // See the delivery-probe block near the factory top.
      recordDeliveryProbe(sessionName, clientMsgId, deliveryId, {
        handedOff: runnerHandedOff,
        turnId,
      });
      if (preparationOpen) {
        turnProgressHeartbeat.stop(sessionName, turnId);
        chatTurnPreparationRuntime.settle(sessionName, turnId, {
          status: 'failed', reason: preparationFailure,
        });
        turnTiming.abort(sessionName, turnId, `preparation:${preparationFailure}`);
        turnTiming.drop(sessionName, turnId);
      }
    }
  }

  // ── Wait injector: continue a session when external data arrives (A/B/D) ──
  function orchestrationChatBusy(session) {
    const cs = chatSessions.get(session);
    if (cs && cs.claudeProc) return true;
    const st = chatStream.status(session);
    return !!(st && st.busy);
  }

  function persistedOrchestrationDelivery(session, deliveryId) {
    if (!deliveryId) return false;
    try {
      return getChatHistoryService().hasPersistedDelivery(session, deliveryId);
    } catch (_) {
      return false;
    }
  }

  function probeExplicitWait(metadata) {
    if (metadata.pollUrl) {
      return fetch(metadata.pollUrl).then(response => response.text());
    }
    return new Promise(resolve => {
      require('child_process').exec(
        metadata.pollCmd,
        { cwd: metadata.cwd, timeout: 20000, maxBuffer: 1024 * 1024, env: process.env },
        (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`),
      );
    });
  }

  function recoverDispatchOperation(operation) {
    return recoverDispatchFromHistory(loadChatHistory(operation.spec.chatId), operation);
  }

  function deliverOrchestrationOutbox({ item, sessionId, text, opts }) {
    if (item.payload?.type === 'dispatch.request' && isNetworkUnhealthy()) return false;
    if (item.payload?.type === 'dispatch.result' && item.payload.gateway) {
      // The result sink is the gateway that owns the dispatch (item.sessionId is
      // the operation's resultSessionId), not a hardcoded WeChat thread.
      const gatewaySessionId = sessionId || GATEWAY_ID;
      const saved = appendChatMessage(gatewaySessionId, {
        role: 'assistant',
        content: text,
        ts: Date.now(),
        clientMsgId: opts.clientMsgId,
        deliveryId: opts.deliveryId,
      });
      if (saved) pushToGateway(text, { persist: false, sessionId: gatewaySessionId });
      return saved;
    }
    return runChatTurn(sessionId, text, opts);
  }

  // ── Streaming chat turn (persistent process; see runChatTurn's streaming branch) ──
  // Feeds the prompt into the session's long-lived `claude` process and forwards
  // events through the SAME applyClaudeChatEvent() the per-turn path uses, so the
  // UI sees identical events. The turn boundary is the `result` event (handled
  // inside applyClaudeChatEvent); finalizeStreamingTurn() then does the
  // process-independent cleanup (stream_end, gateway回流) WITHOUT killing the proc.
  function runChatTurnStreaming(
    sessionName, cs, persisted, prepared, provider, turn, prepareInvocation, autoTurn, apiRetryAttempt = 0,
  ) {
    const { invocation, attempt, routeOverrides, binding, proxySessionId } = prepared;
    // Per-session provider env. buildChildEnv strips inherited ANTHROPIC_* routing
    // vars before applying the provider env, so the provider choice is always
    // authoritative — see providers.CLAUDE_ROUTING_KEYS. The full computed env is
    // passed through; chat-stream uses it verbatim (no second process.env merge).
    const { env: childEnv } = providerRouterRuntime.buildChildEnv(process.env, persisted, {
      TERM: 'dumb', NO_COLOR: '1',
      MULTICC_SESSION_ID: sessionName,
      MULTICC_DIR_ID: persisted.dirId || '',
      MULTICC_BASE_URL: `http://127.0.0.1:${getPort()}`,
    }, routeOverrides);
    providers.applyClaudeProxyEnv(childEnv, {
      providerId: binding.providerId, sessionId: proxySessionId,
      subagent: persisted.subagent, port: getPort(), enabled: getClaudeProxyEnabled(),
      officialOAuth: getClaudeOfficialViaProxy(),
    });
    const resumeExistingStream = !!persisted._streamSessionId;
    if (!persisted._streamSessionId) {
      persisted._streamSessionId = crypto.randomUUID();
      rememberActiveCliState(persisted);
      savePersistedSessionsBestEffort('runtime.streaming-session-id-allocate');
    }
    chatStream.ensure(sessionName, {
      cmd: invocation.cmd,
      cwd: cs.cwd,
      sessionId: persisted._streamSessionId,
      resume: resumeExistingStream,
      baseArgs: invocation.args,
      onNewSessionId: (newId) => {
        persisted._streamSessionId = newId;
        rememberActiveCliState(persisted);
        savePersistedSessionsBestEffort('runtime.streaming-session-id-capture');
      },
      beforeSpawn: ({ sessionId }) => {
        routerToolHost.refreshPersistentProcess(cs, childEnv,
          { sessionId: sessionName, baseUrl: `http://127.0.0.1:${getPort()}` });
        const cleaned = typeof provider.prepareSpawn === 'function'
          ? provider.prepareSpawn({ sessionId })
          : 0;
        if (cleaned > 0) {
          getChatHistoryService().invalidate(sessionName);
          console.log(`[multicc/chat] [${sessionName}] sanitized ${cleaned} empty thinking block(s) from session JSONL`);
        }
      },
      env: childEnv,
      onDispose: () => routerToolHost.releasePersistentProcess(cs),
      onBackgroundEvent: (evt) => getBackgroundTaskRuntime().handleEvent(sessionName, cs, evt),
      isBackgroundActive: () => getBackgroundTaskRuntime().hasLiveBackgroundTasks(sessionName),
      onExit: () => {
        try {
          const reaped = getBackgroundTaskRuntime().reapSessionShadows(sessionName, { reason: 'stream_exit' });
          if (reaped > 0) console.log(`[multicc/chat] [${sessionName}] stream exited; reaped ${reaped} background task(s)`);
        } catch (error) {
          logger.warn('bg_reap_on_exit_failed', { sessionId: sessionName, error: error.message });
        }
      },
    });

    // An in-flight turn (if any) was already interrupted at the top of
    // runChatTurn. Claim this turn's sequence number so a late finalize from a
    // superseded turn can't clobber us.
    const mySeq = cs._streamTurnSeq = (cs._streamTurnSeq || 0) + 1;
    const runner = createRunnerOwnership(turn, {
      runnerId: `stream_${mySeq}_${crypto.randomBytes(6).toString('hex')}`,
      kind: 'stream', sequence: mySeq, providerAttempt: attempt,
      routeProof: prepared.routeProof,
      usageAttribution: prepared.usageAttribution,
    });
    runner.apiRetryAttempt = Math.max(0, Number(apiRetryAttempt) || 0);
    cs._activeTurn = turn;
    cs._activeRunner = runner;

    const forward = (evt) => {
      forwardProviderEvent(sessionName, cs, turn, runner, evt);
    };

    console.log(`[multicc/chat] [${sessionName}] (streaming) send turn=${cs.chatTurnCount} model=${persisted.model || 'default'} status=${JSON.stringify(chatStream.status(sessionName))}`);
    // Timing hooks owned by chat-stream's pump(): 'spawned' fires when the
    // process is ready for this message (fresh spawn or warm reuse), 'sent'
    // after the prompt line is written to stdin. t3 is the first decoded
    // stream event — the earliest reply signal observable on this path.
    chatStream.send(sessionName, invocation.payload, (evt) => {
      if (!isCurrentTurnRunner(cs, turn, runner)
          || !attemptRuntime.acceptEvent(runner.providerAttempt)) return;
      turnTiming.markFirstByte(sessionName, turn.turnId);
      applyAdapterChatEvent(provider, cs, persisted, sessionName, evt, forward, turn, runner);
    }, {
      onTiming: (phase) => {
        if (phase === 'spawned') turnTiming.markSpawned(sessionName, turn.turnId);
        else if (phase === 'sent') turnTiming.markSent(sessionName, turn.turnId);
        else if (phase === 'firstByte') turnTiming.markFirstByte(sessionName, turn.turnId);
      },
    })
      .then(() => finalizeStreamingTurn(
        sessionName, cs, persisted, mySeq, turn, runner, prepared, provider, prepareInvocation, autoTurn,
      ))
      .catch((err) => {
        turnTiming.abort(sessionName, turn.turnId,
          `stream_ended_before_first_byte:${(err && err.code) || 'exit'}`);
        if (!runner.killReason) {
          runner.sawApiError = true;
          runner.apiErrorRaw = {
            source: 'anthropic_event',
            provider: provider.name,
            code: err && err.code,
            message: err && err.message,
          };
        }
        logger.warn('chat_stream_ended_early', {
          sessionId: sessionName,
          provider: provider.name,
          code: err && err.code || null,
          killed: !!runner.killReason,
        });
        finalizeStreamingTurn(
          sessionName, cs, persisted, mySeq, turn, runner, prepared, provider, prepareInvocation, autoTurn,
        );
      });

    return true;
  }

  // The pure planner describes both runner endings; this injected host adapter is
  // the only place that maps those effects back to MultiCC runtime services.
  const turnFinalizationExecutor = createTurnFinalizationExecutor({
    persistAssistant(context, append) {
      return persistFinalAssistantResult(context.sessionName, context.cs, context.turn, context.runner, {
        role: 'assistant',
        content: context.cs.currentAssistantText,
        tools: context.cs.currentToolCalls.length ? context.cs.currentToolCalls : undefined,
        cost: context.cs.currentCost,
        ts: Date.now(),
        turnTimings: turnTimingsField(context.sessionName, context.turn.turnId),
        ...(append.partial ? { partial: true } : {}),
      }, { final: append.final });
    },
    commitUsage(context) {
      return recordDurableTurnUsage(
        context.sessionName,
        context.runner,
        context.runner.pendingUsage,
      );
    },
    broadcast: chatBroadcast,
    cancelClassify,
    clearIncrementalSave: sessionName => getChatHistoryRuntime().clearIncrementalSave(sessionName),
    setStatus(sessionName, status) {
      setSessionStatus(sessionName, { status, currentFile: null });
    },
    completeSessionTurn: s => getSessionWorkHost().turnSucceeded(s),
    classifyTurnEnd,
    resetInterrupted: sessionName => waitInjector.resetInterrupted(sessionName),
    resumeInterrupted: sessionName => waitInjector.resumeInterrupted(sessionName),
    freezeInterrupted(sessionName, reason) {
      Promise.resolve(getSessionWorkHost().turnFailed(sessionName, reason)).catch(() => {});
    },
    emitTurnOutcome,
    runPostTurn(context, entry) {
      runDurablePostTurn(
        context.sessionName,
        context.cs,
        context.persisted,
        context.turn,
        context.runner,
        context.finalText || '',
        {
          interrupted: entry.interrupted,
          apiError: entry.apiError,
          retryPlanned: entry.retryPlanned,
          handoffResumeFailure: entry.handoffResumeFailure,
        },
      );
    },
    log(event, fields) {
      if (event === 'interrupted-resume') {
        console.log(`[multicc/chat] [${fields.sessionName}] (streaming) 非正常中断 (no result event, kill=none) → resume`);
      }
    },
    logError(event, fields) {
      if (event === 'post-turn-failed') console.error('[multicc/dispatch] post-turn hook failed:', fields.error.message);
    },
  });

  // Process-independent end-of-turn cleanup for the streaming path. Guarded by
  // the turn sequence so a superseded (interrupted) turn's late completion can't
  // clobber the turn that replaced it.
  function finalizeStreamingTurn(
    sessionName, cs, persisted, seq, turn, runner, prepared, provider, prepareInvocation, autoTurn,
  ) {
    if (seq !== undefined && cs._streamTurnSeq !== seq) return; // superseded by a newer turn
    if (!isCurrentTurnRunner(cs, turn, runner)) return;
    const attemptFacts = attemptRuntime.snapshot(sessionName);
    const partialOutput = meaningfulTurnOutput(cs) || !!attemptFacts?.visibleOutputObserved;
    const sideEffects = turnHasSideEffects(cs)
      || !!attemptFacts?.toolIntentObserved || !!attemptFacts?.sideEffectObserved;
    // Same success veto as the process close path: a durable result proves a
    // mid-stream error was recovered from (see the close handler above).
    clearErrorFlagsForSucceededTurn(turn, runner, cs, { killReason: runner.killReason });
    const shouldClassifyApiError = !!(
      runner.apiErrorRaw
      || runner.sawApiError
      || runner.adapterError
      || runner.killReason
      || (!runner.resultEvent && !turn.resultDurable)
    );
    const rawApiError = runner.killReason
      ? {
        source: 'anthropic_event',
        provider: persisted.cli || 'claude',
        code: runner.killReason,
        message: 'turn cancelled',
      }
      : runner.apiErrorRaw || {
        source: 'host_interruption',
        provider: persisted.cli || 'claude',
        code: 'stream_ended_without_result',
        message: 'stream ended without a result event',
      };
    const apiErrorDecision = shouldClassifyApiError
      ? evaluateTurnApiError({
        sessionName,
        cs,
        persisted,
        turn,
        runner,
        raw: rawApiError,
        attempt: runner.apiRetryAttempt || 0,
        phase: partialOutput || sideEffects ? 'stream' : 'before_first_token',
        partialOutput,
        sideEffects,
        deferNotice: autoTurn.enabled,
      })
      : null;
    const autoFailover = apiErrorDecision ? autoTurn.failover(apiErrorDecision, attemptFacts) : null;
    const effectiveApiErrorDecision = autoFailover?.decision || apiErrorDecision;
    if (autoFailover?.invocationOptions) chatBroadcast(sessionName, {
      type: 'system', subtype: 'warning',
      message: `Auto Provider：${autoFailover.fromProviderName} 不可用，正在切换到 ${autoFailover.toProviderName}。`,
    });
    else if (autoTurn.enabled && apiErrorDecision) chatBroadcast(sessionName, {
      type: 'system', subtype: 'warning', message: retryNotice(effectiveApiErrorDecision),
    });
    const finalizeCheckpointKey = assistantCheckpointKey(cs);
    const plan = planTurnFinalization({
      current: true,
      runnerKind: 'stream',
      cli: persisted.cli || 'claude',
      killReason: runner.killReason || null,
      apiError: !!effectiveApiErrorDecision || !!runner.sawApiError,
      apiErrorDecision: effectiveApiErrorDecision,
      adapterError: !!runner.adapterError,
      retryPlanned: !!runner.retryPlanned,
      resultEvent: !!runner.resultEvent,
      resultDurable: !!turn.resultDurable,
      hasOutput: !!(cs.currentAssistantText || cs.currentToolCalls.length),
      sameDurablePartial: hasMatchingPartialCheckpoint(runner, finalizeCheckpointKey),
      handoff: persisted.pendingCliHandoff,
    });
    turnProgressHeartbeat.stop(sessionName, turn.turnId);
    if (plan.action === 'retry-api') {
      finishProviderAttempt(runner, 'failed', {
        errorCategory: apiErrorDecision?.error?.category || 'api_error',
        reasonCode: 'api_retry_scheduled',
      });
      scheduleOwnedRetry({
        sessionName, cs, persisted, turn, runner,
        decision: plan.retry, provider: persisted.cli || 'claude',
        start: () => {
          let retryInvocation;
          try {
            retryInvocation = prepareInvocation(autoFailover?.invocationOptions || {
              reasonCode: 'same_provider_retry',
              ...providerRetryRouteOptions(runner.providerAttempt),
            });
            const accepted = runChatTurnStreaming(
              sessionName, cs, persisted, retryInvocation, provider, turn,
              prepareInvocation, autoTurn, plan.retry.attempt,
            );
            if (!accepted) throw new Error('stream retry was not accepted');
            return accepted;
          }
          catch (error) {
            if (retryInvocation) attemptRuntime.finishAttempt(retryInvocation.attempt, {
              outcome: 'failed', errorCategory: 'spawn_failed', reasonCode: 'stream_retry_failed',
            });
            logger.warn('provider_attempt_retry_blocked', {
              sessionId: sessionName,
              providerId: runner.providerAttempt && runner.providerAttempt.providerId,
              routeAttemptId: runner.providerAttempt && runner.providerAttempt.routeAttemptId,
              code: error && error.code || 'attempt_prepare_failed',
            });
            runner.retryPlanned = false;
            const blockedPlan = planTurnFinalization({
              ...plan.facts, apiError: true, apiErrorDecision: null,
              retryPlanned: false, handoff: persisted.pendingCliHandoff,
            });
            turnFinalizationExecutor.execute(blockedPlan, {
              runnerKind: 'stream', sessionName, cs, persisted, turn, runner,
            });
            return null;
          }
        },
      });
      return;
    }
    if (turn.resultDurable && !apiErrorDecision) autoTurn.recordSuccess(runner.providerAttempt);
    finishProviderAttempt(runner, turn.resultDurable && !apiErrorDecision ? 'succeeded' : 'failed', {
      errorCategory: apiErrorDecision?.error?.category || null,
      reasonCode: plan.action,
    });
    turnFinalizationExecutor.execute(plan, {
      runnerKind: 'stream', sessionName, cs, persisted, turn, runner,
    });
  }

  // ── Chat mode: stream-json WebSocket ──
  function handleChatWs(ws, req, urlObj) {
    const sessionName = urlObj.searchParams.get('session') || '_default';
    const persisted = persistedSessions.get(sessionName);
    if (!persisted || isInternalExecutionSlot(persisted)) {
      sendWs(ws, { type: 'error', error:
        `Chat session "${sessionName}" does not exist. Create it via the dashboard first.` });
      ws.close();
      return;
    }
    if (persisted.kind && persisted.kind !== 'chat') {
      sendWs(ws, { type: 'error', error:
        `Session "${sessionName}" is not a chat session (kind=${persisted.kind}).` });
      ws.close();
      return;
    }
    if (invalidSessions.has(sessionName)) {
      sendWs(ws, { type: 'error', error:
        `会话已失效（${invalidSessions.get(sessionName)}），请删除后重建。` });
      ws.close();
      return;
    }
    const experimentalRuntime = getExperimentalTuiChatRuntime?.();
    if (persisted.experimentalMode && experimentalRuntime) {
      return experimentalRuntime.handleWs(ws, req, urlObj);
    }
    const cli = persisted.cli || 'claude';
    const cwd = cwdForSession(persisted);

    // Get or create session-level state
    let cs = chatSessions.get(sessionName);
    if (!cs) {
      // For claude: pre-allocate the session UUID (needed for --session-id on first turn).
      // For codex: leave null; captured from `thread.started` event on first turn.
      if (cli === 'claude' && !persisted.cliSessionId) {
        persisted.cliSessionId = crypto.randomUUID();
        savePersistedSessionsBestEffort('websocket.chat-session-id-allocate');
      }

      const history = loadChatHistory(sessionName);
      cs = {
        clients: new Set(),
        claudeProc: null,   // (kept name for backwards compat in rest of handler; holds any cli child proc)
        lineBuf: '',
        cli,
        chatTurnCount: history.filter(m => m.role === 'assistant').length,
        cwd,
        currentAssistantText: '',
        currentToolCalls: [],
        currentCost: null,
        isStreaming: false,
        streamReplay: [],
        _classifyTimer: null,
        _classifyTaskId: null,
        _currentTaskId: taskContextHost.restore(history),
      };
      chatSessions.set(sessionName, cs);
    }

    cs.clients.add(ws);

    // Resolve Provider identity and the shared cumulative/daily window view from
    // the token runtime so initial WS state and post-turn broadcasts cannot drift.
    const { providerId: provId, windows: provWindows } = providerTokenWindows(sessionName);
    let provName = null;
    if (provId) {
      try { provName = providers.getProvider(undefined, provId)?.name || null; } catch (_) {}
    }
    const activeRoute = attemptRuntime.snapshot(sessionName);
    const autoProvider = persisted.providerSelection?.mode === 'auto'
      ? autoProviderRuntime.snapshot(sessionName) : null;
    const reconnectRoute = activeRoute && activeRoute.outcome === 'running'
      ? providerAttemptFields(activeRoute) : null;

    sendWs(ws, {
      type: 'system', subtype: 'init',
      cwd: cs.cwd, session: sessionName, session_id: sessionName,
      cli: cs.cli,
      is_streaming: cs.isStreaming,
      model: persisted.model || null,
      effectiveModel: effectiveSessionModel(persisted),
      effort: persisted.effort || null,
      effectiveEffort: effectiveSessionEffort(persisted),
      agent: persisted.agent || null,
      providerRouteProtocolVersion: 1,
      providerRoute: reconnectRoute,
      providerId: reconnectRoute ? reconnectRoute.providerId : (autoProvider?.providerId || provId),
      providerName: reconnectRoute ? activeRoute.providerName : (autoProvider?.providerName || provName),
      providerSelection: providerSelectionDto(persisted.providerSelection),
      autoProvider,
      providerTokenWindows: provWindows,
      cliStates: cliStateSummary(persisted),
      cliAvailability: cliAvailabilitySummary(),
      pendingCliHandoff: cliHandoffSummary(persisted),
    });

    // Replay saved history + in-progress assistant response (if any).
    // Send only the newest page over WS on connect; older messages are fetched
    // on demand via GET /history?before=<id> as the user scrolls up.
    // The replay helper also recognizes the crash-safety `_interim` record. It
    // promotes that stable-id entry to the one live streaming tail, rather than
    // sending both the persisted first batch and a cumulative id-less copy.
    const canonicalPage = getChatHistoryRuntime().paginate(sessionName, { limit: CHAT_HISTORY_PAGE });
    const page = { messages: canonicalPage.messages, hasMore: canonicalPage.hasMore };
    const replayMessages = buildReplayMessages(page.messages, cs);
    // Include authoritative cumulative token usage from the persistent
    // accumulator so the frontend doesn't need to reconstruct it from the
    // rolling chat_history window (which trims old messages).
    const tokenUsage = getTokenUsage();
    // Existing Codex ledgers contain cumulative snapshots added once per turn.
    // Until an operator performs a controlled on-disk rebuild, derive the chat
    // header from non-mutating history projection so it agrees with the fixed
    // per-message footers immediately after upgrade.
    // summarizeHistoryUsage only totals numbers, so it reads the transcript
    // rather than cloning it: this runs on every WS connect, and reconnects
    // arrive at a few per second across a fleet.
    const sessionTokenUsage = persisted.cli === 'codex'
      ? summarizeHistoryUsage(viewChatHistory(sessionName))
      : tokenUsage[sessionName] || null;
    if (replayMessages.length > 0 || sessionTokenUsage) {
      sendWs(ws, { type: 'chat_history', messages: replayMessages, tokenUsage: sessionTokenUsage, hasMore: page.hasMore });
      // Seed the aux classify bar with the current task snapshot on connect, so
      // the goal/phase shows immediately (not only after the next classify).
      try {
        const ts0 = getTaskState(persistedSessions.get(sessionName));
        if (ts0 && (ts0.goal || (ts0.phase && ts0.phase !== 'idle'))) {
          sendWs(ws, { type: 'task_state', goal: ts0.goal || '', taskShortCode: taskShortCode(ts0.taskId), phase: ts0.phase || 'idle', classifyState: ts0.classifyState || null });
        }
      } catch (_) {}
      // If chat_history already includes the in-progress assistant message
      // (appended just above), skip the streamReplay so the client doesn't
      // receive duplicate events that would create a second bubble.
      if (replayMessages.length > 0) {
        const lastMsg = replayMessages[replayMessages.length - 1];
        if (lastMsg.role === 'assistant' && cs.isStreaming && cs.streamReplay.length > 0) {
          cs.streamReplay = [];
        }
      }
    }

    // If a stream is in progress, replay buffered events so reconnected client
    // catches up. This is a synchronous burst of up to streamReplay.length
    // (capped at 500) frames — it must bypass the backpressure MESSAGE-count cap
    // via sendImmediate(), or the burst trips queue_overflow → 1013 close → the
    // client reconnects → re-floods → infinite reconnect loop (the bug that hit
    // long streaming turns). sendImmediate still honours the byte cap + congestion
    // timer, so a genuinely slow client is still protected. Falls back to sendWs
    // if backpressure isn't installed (defensive; it always is here).
    if (cs.isStreaming && cs.streamReplay.length > 0) {
      const bp = ws._multiccBackpressure;
      for (const evt of cs.streamReplay) {
        try {
          if (bp && typeof bp.sendImmediate === 'function') {
            bp.sendImmediate(JSON.stringify(createWsEnvelope(evt)));
          } else {
            sendWs(ws, evt);
          }
        } catch (_) {}
      }
    }

    // On (re)connect, push the authoritative live background-task set so the
    // frontend can settle any danmaku spinner whose one-shot `monitor_done` was
    // lost during a disconnect (it never enters streamReplay).
    try {
      const activeTasks = getBackgroundTaskRuntime().listActiveBackgroundTasks(sessionName);
      sendWs(ws, { type: 'background_tasks', tasks: activeTasks });
      // After a restart the in-memory runtime is empty and those processes
      // died with the old server. The turn event journal is the only record
      // of what was still open — replay each as an honest `interrupted` row
      // instead of letting the danmaku go silent. Bounded to tasks whose last
      // journal witness is recent, so this fades out instead of replaying
      // ancient history on every page refresh.
      if (activeTasks.length === 0 && turnEventJournal && typeof turnEventJournal.readAll === 'function') {
        const cutoff = Date.now() - RECONNECT_REPLAY_WINDOW_MS;
        for (const task of deriveOpenTasks(turnEventJournal.readAll(sessionName))) {
          if (!Number.isFinite(task.lastTs) || task.lastTs < cutoff) continue;
          sendWs(ws, {
            type: 'monitor_done', task_id: task.task_id, status: 'interrupted',
            summary: `重启前运行中 · 已随服务重启中断${task.description ? '：' + task.description : ''}`,
            background: true, replayed: true,
          });
        }
      }
    } catch (_) {}
    try {
      getSessionWorkHost().replayState(sessionName, event => sendWs(ws, event));
    } catch (_) {}

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Heartbeat is always allowed.
        if (msg.type === 'ping') {
          try { sendWs(ws, { type: 'pong' }); } catch (_) {}
          return;
        }
        // ── Share-scope gate ──
        // view  = read-only: drop everything except ping.
        // operate = read-write: allow user_message/cancel/typing, but block
        //   admin/destructive ops (clear_history, etc.) — shares never get those.
        if (ws._sharePerm === 'view') return;
        if (ws._sharePerm === 'operate' && !['user_message', 'cancel', 'typing'].includes(msg.type)) return;

        // Typing signal: user is composing → cancel pending intent classify
        if (msg.type === 'typing') {
          cancelClassify(cs);
          return;
        }

        if (msg.type === 'cancel') {
          // Web/App stop button. operationId (when the client sends one) makes a
          // reconnect-retry join the same cancel operation instead of starting a
          // second one; without it the in-flight map still dedupes by session.
          await getSessionWorkHost().cancelActiveTurn(sessionName, {
            resolveQueue: true,
            source: 'manual_cancel',
            operationId: typeof msg.operationId === 'string' ? msg.operationId : null,
          });
          return;
        }

        if (msg.type === 'clear_history') {
          if (msg.preserveHistory !== true) {
            let backgroundActive = true;
            try {
              backgroundActive = getBackgroundTaskRuntime().hasLiveBackgroundTasks(sessionName) === true;
            } catch (_) {}
            if (backgroundActive) {
              chatBroadcast(sessionName, {
                type: 'error',
                code: 'background_tasks_running',
                error: '后台任务仍在运行；请等待完成或先取消后台任务，再清空历史。',
              });
              return;
            }
          }
          let streamBusy = false;
          try { streamBusy = chatStream.status(sessionName)?.busy === true; } catch (_) {}
          if (msg.preserveHistory !== true
              && !!(cs._activeRunner || cs.claudeProc || cs.isStreaming || streamBusy)) {
            await getSessionWorkHost().cancelActiveTurn(sessionName, {
              resolveQueue: true, source: 'clear_history', reason: 'clear_history', killReason: 'clear_history',
            });
          }
          await getChatHistoryRuntime().clearHistory(sessionName, msg, cs);
          return;
        }

        if (msg.type === 'user_message' && msg.text) {
          // Gateway: a bare 确认/取消 resolves a pending dispatch without running the LLM.
          if (persisted.type === 'gateway' && handleGatewayControl(msg.text, sessionName)) return;
          // Non-browser clients may still send the input-box control as a
          // user_message. Treat it exactly like the cancel transport event so
          // it resets the active scheduler slot to classify E without reaching
          // the model or joining FIFO.
          if (/^cancel$/i.test(String(msg.text).trim())) {
            await getSessionWorkHost().cancelActiveTurn(sessionName, {
              resolveQueue: true,
              source: 'manual_cancel',
            });
            return;
          }
          const turnOpts = msg.goal ? { goalLimits: resolveGoalLimits(msg.goalLimits) } : {};
          if (typeof msg.clientMsgId === 'string' && msg.clientMsgId.trim()) turnOpts.clientMsgId = msg.clientMsgId;
          if (typeof msg.userInputRequestId === 'string' && msg.userInputRequestId.trim()) {
            turnOpts.userInputRequestId = msg.userInputRequestId.trim();
          }
          const pendingMemory = getPendingMemoryDistill(sessionName);
          const deliver = () => taskContextHost.deliverSessionMessage(sessionName, msg.text, turnOpts);
          // A pending memory distill delays delivery so the new turn sees the
          // distilled memory. It must never EAT the message: the old shape
          // (pendingMemory.finally(deliver)) left both the distill rejection and
          // deliver's rejection unhandled, and returned from the handler before
          // delivery - a failed distill silently dropped the user's message.
          // Await through it, let a failed distill pass, and let deliver's own
          // errors reach the handler's catch. The single-statement branches keep
          // the 'else await deliver()' shape test-task-context-host.js pins.
          if (pendingMemory) await Promise.resolve(pendingMemory).catch(() => {}).then(deliver);
          else await deliver();
          return;
        }
      } catch (e) {
        console.error('[multicc/chat] Bad message:', e.message);
      }
    });

    ws.on('close', () => {
      cs.clients.delete(ws);
      // Do NOT kill claudeProc on disconnect — it may still be streaming to other clients
      // or the user may reconnect (lock screen, tab switch, etc.)
      // Process is only killed on explicit cancel or new user_message
    });
  }

  return {
    applyClaudeChatEvent,
    applyAdapterChatEvent,
    admitChatWork,
    runChatTurn,
    orchestrationChatBusy,
    persistedOrchestrationDelivery,
    probeExplicitWait,
    recoverDispatchOperation,
    deliverOrchestrationOutbox,
    runnerDeliveryHandoff,
    runChatTurnStreaming,
    finalizeStreamingTurn,
    handleChatWs,
  };
}

module.exports = {
  adapterReasoningProgressEvent,
  appendAdapterAssistantText,
  createChatTurnEngine,
  createDeliveryProbeRegistry,
  markReplaySafeAssistantEnvelope,
  normalizeClaudeAssistantSnapshot,
  normalizeClaudeToolResultContent,
  recoverDispatchFromHistory,
  shouldReexecutePersistedDelivery,
};
