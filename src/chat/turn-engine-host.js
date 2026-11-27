'use strict';

// Rust drives admission, preparation, runner ownership and finalization in
// native/addon/src/turn_engine. This adapter binds live server objects, Node
// streams, child processes, SDK callbacks and Promise continuations. Each port
// can be removed when its resource and callers move into the Rust host.

const { assignHostProperty } = require('../native/binding');
const crypto = require('crypto');
const { createTurnTimingRecorder, createDeliveryProbeRegistry, createTurnTimelinePort,
  shouldReexecutePersistedDelivery } = require('../native/binding').getTurnProgress();
const { apiNetworkContinuePrompt, API_NETWORK_CONTINUE_MAX } = require('../cli/session-policy');
const { createSessionNotices } = require('../native/binding').getSessionNotices();
const { createAdapterCompletion } = require('../native/binding').cliCompletion;
const { finalizeCompletionStream } = require('../native/binding').adapterCompletion;
const { getWriterGroup, getNative, gatewayPath, deliveryClassForItem, historyFrame: { fitHistoryFrame } } = require('../native/binding');
const {
  TurnRequestError,
  normalizeTurnRequest,
  createDurableMessageProof,
  evaluateSpawnGuard,
  createTurnLifecycle,
  bindTurnTask,
  bindTurnUsageAttribution,
  createRunnerOwnership,
  createTurnFinalizationExecutor,
  isKnownHarmlessStderrLine,
  sanitizeMessage: sanitizeApiErrorMessage,
} = require('../native/binding').chatApi;
const { createProviderAttemptRuntime, markHostErrorEnvelope, providerAttemptFields,
  tagProviderAttemptEvent } = require('../native/binding').providerAttemptRuntime;
const { createProviderInvocationFactory } = require('../native/binding').providerInvocation;
const { createAutoProviderRuntime } = require('./auto-provider-runtime');
const { createAutoRouteNotes } = require('./auto-route-notes');
const { deliverAfterPendingMemory, createQueuedTurnPreparation } = require('./admission-progress');
const { createAutoProviderHandoff } = require('../native/binding');
const { redactProviderRouteCapability } = require('../native/binding').observability;
const { taskIdForShortCode } = require('../native/binding').taskDomainHost;
const { taskStateSeed } = require('../native/binding');
const { recordAdapterQuestion, prepareQuestionReplay } = require('./host-coordinator');
const { buildSubagentProviderHint } = require('../native/binding').getHostPrompts();
const managedContext = require('../native/binding').managedContext;
const {
  rememberActiveCliState, renderHandoffPrompt, stateSummary: cliStateSummary,
  buildHandoffCheckpoint,
} = require('../cli-switch');
const { cliHandoffSummary } = require('../cli/switch-runtime');
const { summarizeHistoryUsage } = require('../codex/usage');
const { buildReplayMessages } = require('../routes/chat-history/index');
const chatStream = require('./chat-stream');
const { spawnContractOf } = require('./held-turn-injection');
const secretsVault = require('../secrets-vault');
const waitInjector = require('../wait/injector');
const providers = require('../providers/host');
const { claudeSettingsExtra, appendAdapterAssistantText, adapterReasoningProgressEvent,
  normalizeClaudeToolResultContent, normalizeClaudeAssistantSnapshot, closeOpenThinkingTool,
  markReplaySafeAssistantEnvelope, reconcileBoundaryErrorEnvelope } = getNative().chatTurnEventHelpers({
    providers, markHostErrorEnvelope, redactProviderRouteCapability,
  });

const { checkEgressIpAllowed } = require('../native/binding').egressIpPolicy;
const { deriveOpenTasks } = require('../native/binding').getTurnEventReplay();
const { createCodexRolloutGuard, enforceCodexRolloutForTurn } = require('./codex-rollout-guard');
const hasNativeHistory = (record, options) => getNative().claudeExpHasNativeHistory(record, options);
const { createOpencodeContextGuard, enforceOpencodeContextForTurn } = require('./opencode-context');
const { providerSelectionDto } = require('../native/binding').autoProviderConfig;
const { isResident, isResidentSession } = require('../native/binding').cliCapability;

const { chatRecoverDispatchFromHistory: recoverDispatchFromHistory,
  chatDeriveCloseTurnFacts: deriveCloseTurnFacts } = getNative();

function createChatTurnEngine(deps) {
  const {
    // ── Getters for reassigned / late-composed host bindings ──
    getBackgroundTaskRuntime,   // const in host, but composed after this cluster's original position
    getSessionWorkHost,         // let
    getChatHistoryRuntime,      // let
    getChatHistoryService,      // let
    getExperimentalTuiChatRuntime,
    getSessionHibernation,
    getWorkspaceAdmission,
    getSessionGitRuntime,       // const in host; auto-commit rides complete-session-turn
    isShuttingDown,             // let bool _shuttingDown
    getPort,                    // let PORT
    getClaudeOfficialViaProxy,  // let
    // ── Pass-by-reference: stable containers / hoisted fns / early consts ──
    persistedSessions,
    chatSessions,
    invalidSessions,
    logger,
    folderMemory,
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
    runClassifyNow,
    cancelClassify,
    emitRunningNotify,
    emitTurnOutcome,
    ensureCurrentTask,
    getTaskState,
    setTaskState,
    // Unattended mode: read-only state for the connect replay.
    getUnattendedState = () => null, getUnattendedHost = () => null,
    buildGatewayPrompt,
    buildDispatchContextPrompt,
    buildPlanPrompt,
    markPlanContextReset,
    appendChatMessage,
    loadChatHistory,
    // Read-only transcript view; see the WS replay below for why the cloning
    // load() is the wrong tool for a caller that only measures.
    viewChatHistory = loadChatHistory,
    scheduleIncrementalSave,
    chatBroadcast,
    sendWs,
    // Native /ws/chat replay buffer + live-client membership facade. Required:
    // the engine no longer owns `streamReplay`/`clients`, so a missing hub would
    // silently drop every reconnect frame.
    replay,
    // Turn event journal (#110): absent only in unit tests that never
    // exercise the reconnect replay.
    turnEventJournal = null,
    persistFinalAssistantResult,
    modelAttributionField,
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
    getTokenUsage,
    resetRoleTokenUsage,
    providerTokenWindows,
    getPendingMemoryDistill,
    effectiveSessionModel,
    effectiveSessionEffort,
    codexStreamDisconnectContinuePrompt,
    CODEX_STREAM_DISCONNECT_CONTINUE_MAX,
    GATEWAY_ID,
    MULTICC_IMG_HINT,
    CHAT_HISTORY_PAGE,
    // Turn progress (Rust owner). Production passes the process-wide recorder /
    // timeline port / probe registry; unit tests may omit them.
    turnTiming: injectedTurnTiming = null,
    turnTimeline: injectedTurnTimeline = null,
    deliveryProbeRegistry: injectedDeliveryProbeRegistry = null,
  } = deps;

  if (!replay || typeof replay.push !== 'function' || typeof replay.clear !== 'function'
      || typeof replay.size !== 'function' || typeof replay.burst !== 'function'
      || typeof replay.join !== 'function' || typeof replay.leave !== 'function'
      || typeof replay.clientsOf !== 'function') {
    throw new TypeError('[chat-turn-engine] deps.replay (native chat replay hub) is required');
  }

  // Fire-and-forget transcript notices. `say()` catches its own append
  // rejection and always resolves, so callers that cannot await are safe.
  const sessionNotices = createSessionNotices({ appendChatMessage, chatBroadcast, logger });

  // Shared [turn-timing] recorder: one instance for every adapter path (claude
  // stream + per-turn spawn). See native/core/src/turn_progress for the t0-t3
  // contract; the record lives in the Rust owner.
  const turnTiming = injectedTurnTiming || createTurnTimingRecorder();
  const turnTimeline = injectedTurnTimeline || createTurnTimelinePort();
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
  const deliveryProbeRegistry = injectedDeliveryProbeRegistry || createDeliveryProbeRegistry({
    maxIdentities: DELIVERY_PROBE_MAX_IDENTITIES,
  });
  const recordDeliveryProbe = deliveryProbeRegistry.record;
  const runnerDeliveryHandoff = deliveryProbeRegistry.lookup;
  const autoProviderRuntime = deps.autoProviderRuntime || createAutoProviderRuntime({
    providers, providerLimitCache, quotaGuard: deps.quotaGuard, logger, isCliAvailable: deps.isCliAvailable, emit: createAutoRouteNotes({ broadcast: chatBroadcast,
      append: appendChatMessage, records: persistedSessions, save: savePersistedSessionsBestEffort }),
    hasLiveBackgroundTasks: sessionId => {
      try { return getBackgroundTaskRuntime()?.hasProcessBackgroundTasks?.(sessionId) === true; }
      catch (_) { return true; }
    },
  });
  const autoProviderHandoff = deps.autoProviderHandoff || createAutoProviderHandoff({
    inject: (sessionId, text, _delayMs, metadata) => admitChatWork(sessionId, `🔇${text}`, metadata),
    hasLiveBackgroundTasks: sessionId => {
      try { return getBackgroundTaskRuntime()?.hasProcessBackgroundTasks?.(sessionId) === true; }
      catch (_) { return true; }
    },
    logger,
  });

  const services = getNative().chatTurnServices({
    persistedSessions, providerLimitCache, autoProviderRuntime, providers, autoProviderHandoff,
    getUnattendedHost, chatBroadcast, attemptRuntime, logger, tagProviderAttemptEvent,
    turnProgressHeartbeat, replay, turnTiming, taskContextHost, chatStream, cwdForSession,
    getTranscriptPruning: require('../native/binding').getTranscriptPruning,
    appendEvent, markPlanContextReset, chatSessions, getChatHistoryService, viewChatHistory,
    deliveryClassForItem, runChatTurn, GATEWAY_ID, appendChatMessage, pushToGateway,
  });
  const { prepareAutoProviderAdmission, forwardProviderEvent, finishProviderAttempt,
    turnTimingsField, contextTraceFor, pruneTranscript, orchestrationChatBusy,
    persistedOrchestrationDelivery, recoverDispatchOperation } = services;
  async function scheduleAutoProviderHandoff(sessionName, turn, preparation, supervised) {
    const step = services.beginHandoff(sessionName, turn, preparation);
    if (!step) return null;
    return services.endHandoff(sessionName, turn, preparation, supervised, await step.pending);
  }
  // Pre-resume size guard: archive an oversized codex rollout before the turn
  // resumes it (`codex exec resume` hangs internally on one — no request ever
  // leaves the process). See src/chat/codex-rollout-guard.js.
  const codexRolloutGuard = deps.codexRolloutGuard || createCodexRolloutGuard({
    logger, codexSessionHomeFor: providers.codexSessionHome,
    prepareCodexSessionHome: providers.prepareCodexSessionHome,
  });
  // Same archive contract for the other resume-capable CLI lanes.
  const nativeSessionGuard = deps.nativeSessionGuard || require('./native-session-guard').createNativeSessionGuard({ logger,
    zcodeSessionHomeFor: id => providers.zcodeSessionHome({ id }),
    kimiSessionHomeFor: id => providers.kimiSessionHome({ id }) });
  // Turn-admission water-level guard for OpenCode native sessions. Decision
  // only; rotation itself happens in runChatTurn via the shared
  // pendingCliHandoff machinery. See ./opencode-context.js.
  const opencodeContextGuard = deps.opencodeContextGuard || createOpencodeContextGuard({ logger });
  // One boot-time sweep so expired archives get pruned even if no turn ever
  // archives again; delayed so it never touches startup critical path.
  const rolloutArchiveSweepTimer = setTimeout(() => {
    try { codexRolloutGuard.sweepExpiredArchives({ force: true }); nativeSessionGuard.sweepExpiredArchives({ force: true }); } catch (_) {}
  }, 10000);
  rolloutArchiveSweepTimer.unref?.();
  // One native reducer owns every Claude stream-json decision (branch order,
  // redaction, API-error state, tool/result framing). These ports are only the
  // effects that still belong to Node owners; the object is built once per
  // engine and closes over the live bindings above.
  const nativeChatEventPorts = {
    isCurrent: (cs, turn, runner) => isCurrentTurnRunner(cs, turn, runner),
    scrub: (attempt, event) => attemptRuntime.scrubAttemptStructure(attempt, event),
    touchActivity: (sessionName, turnId) => turnProgressHeartbeat.touchActivity(sessionName, turnId),
    observeClaude: (cs, event, session) => turnTimeline.observeClaude(session, cs, event),
    observeAdapter: (cs, event, session) => turnTimeline.observeAdapter(session, cs, event),
    decodeEvent: (provider, rawEvent) => provider.decodeEvent(rawEvent),
    rememberActiveCliState: (record) => rememberActiveCliState(record),
    savePersistedSessions: (reason) => savePersistedSessionsBestEffort(reason),
    finishProviderAttempt: (runner, outcome, facts) => finishProviderAttempt(runner, outcome, facts),
    recordUserInput: (evt, sessionId, turnId) => recordAdapterQuestion({ evt, sessionId, turnId, work: getSessionWorkHost(), recordAdapterUserInput, chatSessions,
      isCurrentTurnRunner, logger, forwardFallback: (id, cs, turn, runner, text) => getNative().chatApplyAdapterDecodedEvent({ name: cs.cli }, cs, persistedSessions.get(id), id, { type: 'assistant_text', text },
        event => forwardProviderEvent(id, cs, turn, runner, event), turn, runner, nativeChatEventPorts) }),
    consoleWarn: (...args) => console.warn(...args),
    consoleLog: (...args) => console.log(...args),
    noteReportedModel: (sessionName, model) => noteReportedModel(sessionName, model),
    updatePhase: (sessionName, turnId, phase, name) => turnProgressHeartbeat.updatePhase(sessionName, turnId, phase, name),
    setSessionStatus: (sessionName, status) => setSessionStatus(sessionName, status),
    scheduleIncrementalSave: (sessionName, cs) => scheduleIncrementalSave(sessionName, cs),
    backgroundRecordToolUseId: (sessionName, id) => getBackgroundTaskRuntime().recordMainToolUseId(sessionName, id),
    backgroundMarkTaskOutputAwaiting: (sessionName, input) => getBackgroundTaskRuntime().markTaskOutputAwaiting(sessionName, input),
    clearIncrementalSave: (sessionName) => getChatHistoryRuntime().clearIncrementalSave(sessionName),
    contextTrace: (sessionName, cs) => contextTraceFor(sessionName, cs),
    isMapped: (sessionName, cs) => chatSessions?.get(sessionName) === cs,
    // Both of these start a durable write and return a synchronous "accepted"
    // flag; the reducer records its pending state and waits for the commit
    // entry (`chatCommitHeldAnswer` / `chatCommitFinalPersist`) before deciding
    // that the row or turn is durable.
    appendHeldAnswer: (sessionName, message, rowKey, cs, turn, runner) => requestHeldAnswerAppend(sessionName, message, rowKey, cs, turn, runner),
    requestFinalPersist: (sessionName, cs, turn, runner, message, options, forward, wasMapped, evt) => requestFinalPersist(sessionName, cs, turn, runner, message, options, forward, wasMapped, evt),
    // Rust passes the producing turn explicitly: a persisted answer can lose
    // its session to a replacement before this commit runs, and its usage must
    // still be recorded by (turnId, runnerId).
    recordDurableUsage: (sessionName, runner, usage, turn) => recordDurableTurnUsage(sessionName, runner, usage, {}, turn),
    proxyFailure: (attempt) => attemptRuntime.proxyFailure?.(attempt),
    onTurnComplete: (sessionName) => usageLimitPoller.onTurnComplete(sessionName),
    modelAttribution: (cs, turn, runner) => modelAttributionField(cs, turn, runner),
    timelineField: (cs, session) => turnTimeline.field(session, cs),
    turnTimings: (sessionName, turnId) => turnTimingsField(sessionName, turnId),
    markHostEnvelope: (event) => markHostErrorEnvelope(event),
    logger,
  };

  const { requestFinalPersist, requestHeldAnswerAppend, awaitPendingFinalPersist } =
    getNative().chatPersistCompletions(nativeChatEventPorts, persistFinalAssistantResult, appendChatMessage);

  // Apply one claude-shaped stream-json event to chat session state, then forward
  // it to clients; shared by handleLine and runChatTurnStreaming so they never drift.
  function applyClaudeChatEvent(cs, sessionName, evt, forward, turn, runner, providerName = 'claude') {
    return getNative().chatApplyClaudeEvent(cs, sessionName, evt, forward, turn, runner, providerName, nativeChatEventPorts);
  }

  // Apply adapter-neutral events to server-owned chat state. Wire-format parsing
  // belongs to each CLI adapter; this function owns persistence, status and the
  // Claude-shaped event contract consumed by existing clients.
  function applyAdapterChatEvent(provider, cs, persisted, sessionName, rawEvent, forward, turn, runner) {
    return getNative().chatApplyAdapterEvent(provider, cs, persisted, sessionName, rawEvent, forward, turn, runner, nativeChatEventPorts);
  }

  const workAdmission = getNative().chatWorkAdmission({
    taskContextHost, persistedSessions, getSessionWorkHost, getExperimentalTuiChatRuntime,
    getSessionHibernation, getWorkspaceAdmission, logger, chatBroadcast,
  });
  async function admitChatWork(sessionName, text, opts = {}) {
    const state = workAdmission.start(sessionName, text, opts);
    if (state.blocked) return state.blocked;
    let admitted;
    try {
      admitted = await workAdmission.dispatch(state, sessionName, async () => workAdmission.admit(sessionName, text, opts));
    } catch (error) {
      return workAdmission.failed(state, sessionName, error);
    }
    return workAdmission.finish(sessionName, admitted);
  }

  const execution = getNative().chatTurnExecution({
    deps, taskContextHost, persistedSessions, getSessionHibernation, providers, checkEgressIpAllowed,
    logger, chatBroadcast, runnerDeliveryHandoff, getWorkspaceAdmission, getExperimentalTuiChatRuntime,
    chatSessions, viewChatHistory, codexRolloutGuard, enforceCodexRolloutForTurn, nativeSessionGuard,
    opencodeContextGuard, enforceOpencodeContextForTurn, rememberActiveCliState, savePersistedSessionsBestEffort,
    appendEvent, normalizeTurnRequest, TurnRequestError, hasNativeHistory, getChatHistoryService,
    taskIdForShortCode, getTaskState, bindTurnTask, ensureCurrentTask, runClassifyNow, waitInjector,
    randomUUID: crypto.randomUUID, restoreLiveChatSession, cwdForSession, cancelClassify, apiErrorHost,
    setTaskState, appendChatMessage, createDurableMessageProof, setSessionStatus, userInputSignalHost,
    chatTurnPreparationRuntime, turnTimeline, replay, pruneTranscript, turnProgressHeartbeat,
    resetRoleTokenUsage, emitRunningNotify, isResidentSession, isResident, chatStream, providerRouterRuntime,
    getClaudeOfficialViaProxy, isShuttingDown, getBackgroundTaskRuntime, recordDeliveryProbe,
    issueTurnId: () => `turn_${crypto.randomBytes(12).toString('hex')}`, createTurnLifecycle, turnTiming,
    getSessionWorkHost, attemptRuntime, providerFor, managedContext, folderMemory, process, MULTICC_IMG_HINT,
    buildSubagentProviderHint, renderHandoffPrompt, buildGatewayPrompt, buildDispatchContextPrompt, buildPlanPrompt,
    pendingNotesFor, saveNotes, workspaceBroadcast, normalizeEffort, cliEffortLevel, createProviderInvocationFactory,
    effectiveSessionModel, providerLimitCache, autoProviderRuntime, bindTurnUsageAttribution, evaluateSpawnGuard,
    runChatTurnStreaming, spawnProcessTurn,
  });

  async function runChatTurn(sessionName, message, opts = {}) {
    const gate = await execution.gate(sessionName, message, opts);
    const { context, result } = execution.begin(sessionName, opts, gate);
    if (!context) return result;
    async function settle() {
      try { await execution.settle(context); }
      catch (error) { execution.settleFailed(context, error); }
    }
    try {
      let step = execution.next(context);
      while (step.waiting) step = execution.next(context, await step.pending);
      if (step.settle) await settle();
      return step.result;
    } catch (error) {
      if (execution.failed(context, error)) return true;
      await settle();
      return false;
    } finally {
      execution.release(context);
    }
  }

  function spawnProcessTurn(context, launch, autoTurn) {
    const { sessionName, cs, persisted, turn, opts, originDispatchId } = context;
    const { provider, initialInvocation, prepareInvocation, promptText } = launch;
    const spawnChat = (prepared, isRetry, apiRetryAttempt = 0) => {
      const state = getNative().chatSpawnProcess({
        env: process.env, crypto, providers, providerRouterRuntime, getPort, getClaudeOfficialViaProxy,
        attemptRuntime, claudeSettingsExtra, assignHostProperty,
        gatewayPath, rememberActiveCliState, savePersistedSessionsBestEffort, createRunnerOwnership,
        createAdapterCompletion, getWorkspaceAdmission, getWriterGroup, routerToolHost, spawn,
        finishProviderAttempt, turnTiming, managedContext, isCurrentTurnRunner, applyAdapterChatEvent,
        forwardProviderEvent, isKnownHarmlessStderrLine, sanitizeApiErrorMessage, logger, closeTurn,
      }, { sessionName, cs, persisted, provider, turn, prepared, opts, originDispatchId, isRetry, apiRetryAttempt });

      async function closeTurn(state, code, signal) {
        const { proc, runner, forward } = state;
        const closeContext = { sessionName, cs, persisted, turn, runner, proc, code, signal, isRetry, promptText,
          retryLimits: { codexDisconnect: CODEX_STREAM_DISCONNECT_CONTINUE_MAX, apiNetworkContinue: API_NETWORK_CONTINUE_MAX } };
        const closePorts = { providers, provider, mark: markHostErrorEnvelope, assignHostProperty, attemptRuntime, autoTurn, forward, logger, meaningfulTurnOutput, turnHasSideEffects,
          sanitizeApiErrorMessage, evaluateTurnApiError, chatBroadcast, assistantCheckpointKey,
          prepareInvocation, spawnChat, finishProviderAttempt, replay, turnProgressHeartbeat, turnTiming, turnFinalizationExecutor,
          rememberActiveCliState, savePersistedSessionsBestEffort, randomUUID: crypto.randomUUID,
          isGlm52Session, setSessionStatus, codexStreamDisconnectContinuePrompt, apiNetworkContinuePrompt,
          scheduleOwnedRetry, getUnattendedState };
        const native = getNative();
        if (!native.chatObserveProcessExit(closePorts, closeContext, state)) return;
        await commitAdapterResult(provider, sessionName, cs, persisted, turn, runner, forward, closeContext.boundaryErrorEnvelope);
        closeContext.stderrBuf = state.stderrBuf;
        const terminal = native.chatFinishProcessClose(closePorts, closeContext);
        if (terminal) {
          const finalization = await terminal.pending;
          if (finalization && !finalization.terminalBlocked) {
            await scheduleAutoProviderHandoff(sessionName, turn, terminal.handoff, terminal.supervised);
          }
        }
      }

      return state.proc;
    };

    return spawnChat(initialInvocation, false);
  }

  // ── Wait injector: continue a session when external data arrives (A/B/D) ──
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

  async function deliverOrchestrationOutbox(input) {
    const step = services.delivery(input);
    if (step.turn) return step.pending;
    return services.notifyDelivery(step, await step.pending);
  }

  // ── Streaming chat turn (persistent process; see runChatTurn's streaming branch) ──
  // The persistent process uses the same adapter/persistence path. A settled
  // send closes this turn while the native process stays available for reuse.
  function runChatTurnStreaming(
    sessionName, cs, persisted, prepared, provider, turn, prepareInvocation, autoTurn, apiRetryAttempt = 0, workspaceOpts = null,
  ) {
    return getNative().chatRunStreaming({
      env: process.env, crypto, providers, providerRouterRuntime, secretsVault, chatStream, routerToolHost,
      claudeSettingsExtra, rememberActiveCliState, savePersistedSessionsBestEffort, sessionNotices,
      spawnContractOf, getWorkspaceAdmission, getPort, getClaudeOfficialViaProxy, getChatHistoryService,
      clearSessionApiErrorState, turnProgressHeartbeat, setSessionStatus, chatBroadcast, logger,
      buildHandoffCheckpoint, renderHandoffPrompt, viewChatHistory, getBackgroundTaskRuntime,
      createAdapterCompletion, createRunnerOwnership, isCurrentTurnRunner, attemptRuntime, turnTiming,
      applyAdapterChatEvent, forwardProviderEvent, managedContext, finalizeCompletionStream,
      finalizeStreamingTurn, sanitizeApiErrorMessage, getSessionWorkHost, getChatHistoryRuntime,
    }, { sessionName, cs, persisted, prepared, provider, turn, prepareInvocation, autoTurn, apiRetryAttempt, workspaceOpts });
  }

  const streamPorts = {
    applyClaudeChatEvent, awaitPendingFinalPersist, attemptRuntime, recordApiSuccess,
    clearSessionApiErrorState, codexUsageHost, contextTraceFor, turnHasSideEffects, meaningfulTurnOutput,
    evaluateTurnApiError, chatBroadcast,
    assistantCheckpointKey, isCurrentTurnRunner, mark: markHostErrorEnvelope,
    forwardProviderEvent, finishProviderAttempt, turnProgressHeartbeat,
    runChatTurnStreaming, scheduleOwnedRetry, getUnattendedState, scheduleAutoProviderHandoff, logger,
    userInputSignalHost, managedContext, getWorkspaceAdmission, persistFinalAssistantResult,
    turnTimingsField, recordDurableTurnUsage, turnTimeline, cancelClassify, replay,
    getChatHistoryRuntime, setSessionStatus, getSessionWorkHost, getSessionGitRuntime,
    classifyTurnEnd, waitInjector, emitTurnOutcome, runDurablePostTurn,
  };
  const streamFinish = getNative().chatStreamFinishApi(streamPorts);
  const turnFinalizationExecutor = createTurnFinalizationExecutor(streamFinish.executorPorts);
  streamPorts.executor = turnFinalizationExecutor;
  async function commitAdapterResult(provider, sessionName, cs, persisted, turn, runner, forward, envelope) {
    const context = { provider, sessionName, cs, persisted, turn, runner, forward, envelope };
    const pending = streamFinish.pendingInputs(runner);
    if (pending) await pending;
    await streamFinish.buffered(context);
    const usage = streamFinish.commit(context);
    if (usage) await usage.pending;
  }
  async function finalizeStreamingTurn(
    sessionName, cs, persisted, seq, turn, runner, prepared, provider, prepareInvocation, autoTurn,
  ) {
    const context = streamFinish.start({ sessionName, cs, persisted, seq, turn, runner, provider, prepareInvocation, autoTurn });
    if (!context) return;
    await commitAdapterResult(provider, sessionName, cs, persisted, turn, runner, context.forward, context.envelope);
    const execution = streamFinish.execute(context);
    if (execution) {
      const handoff = streamFinish.handoff(context, await execution.pending);
      if (handoff) await handoff.pending;
    }
  }

  const socketPorts = {
    chatSessions, replay, taskContextHost, persistedSessions, sendWs, getTaskState, taskStateSeed,
    cancelClassify, getChatHistoryRuntime, getSessionWorkHost, handleGatewayControl,
    providerTokenWindows, providers, attemptRuntime, autoProviderRuntime, providerAttemptFields,
    invalidSessions, getExperimentalTuiChatRuntime, cwdForSession, randomUUID: crypto.randomUUID,
    savePersistedSessionsBestEffort, viewChatHistory, buildReplayMessages, fitHistoryFrame, getTokenUsage,
    historyPage: CHAT_HISTORY_PAGE, summarizeHistoryUsage, getBackgroundTaskRuntime, turnEventJournal, deriveOpenTasks,
    effectiveSessionModel, effectiveSessionEffort, providerSelectionDto, cliStateSummary, cliAvailabilitySummary, cliHandoffSummary,
    getUnattendedState, chatBroadcast,
    async awaitSocketEffect(invoke, finish, fail) {
      if (!fail) return finish(await invoke());
      try { return finish(await invoke()); } catch (error) { return fail(error); }
    },
  };

  function restoreLiveChatSession(sessionName, cli, cwd, history) {
    return getNative().chatRestoreLiveSession(socketPorts, sessionName, cli, cwd, history);
  }

  // ── Chat mode: stream-json WebSocket ──
  async function handleChatWs(ws, req, urlObj) {
    const native = getNative();
    const connection = native.chatOpenSocket(socketPorts, ws, req, urlObj);
    if (connection.closed) return connection.result;
    const { sessionName, shellId, persisted, cs } = connection;

    if (Number.isInteger(ws._multiccConnId)) replay.join(sessionName, ws._multiccConnId);
    const stopShellWatch = shellId && taskContextHost.watchTaskShellChat(shellId, sessionName, event => sendWs(ws, event));
    const replayGate = await prepareQuestionReplay({ ws, input: userInputSignalHost,
      sessionId: sessionName, persisted, sendWs, cleanup: () => {
        if (stopShellWatch) stopShellWatch();
        if (Number.isInteger(ws._multiccConnId)) replay.leave(sessionName, ws._multiccConnId);
      } });
    if (!replayGate) return;

    native.chatReplaySocket(socketPorts, ws, connection, replayGate, urlObj);
    try {
      await getSessionWorkHost().replayState(sessionName, event => sendWs(ws, event));
    } catch (_) {}
    native.chatReplayUnattended(socketPorts, ws, sessionName);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        await native.chatHandleSocketMessage(socketPorts, ws, sessionName, shellId, persisted, cs, msg);
      } catch (e) {
        console.error('[multicc/chat] Bad message:', e.message);
      }
    });

    replayGate.finish();
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
    prepareAutoProviderAdmission, autoProviderRuntime,
    prepareQueuedTurn: createQueuedTurnPreparation({ prepareRouting: prepareAutoProviderAdmission,
      getPendingMemory: getPendingMemoryDistill, broadcast: chatBroadcast }),
  };
}

module.exports = {
  adapterReasoningProgressEvent,
  appendAdapterAssistantText,
  claudeSettingsExtra,
  closeOpenThinkingTool,
  createChatTurnEngine,
  createDeliveryProbeRegistry,
  deliverAfterPendingMemory,
  deriveCloseTurnFacts,
  markReplaySafeAssistantEnvelope,
  reconcileBoundaryErrorEnvelope,
  normalizeClaudeAssistantSnapshot,
  normalizeClaudeToolResultContent,
  recoverDispatchFromHistory,
  shouldReexecutePersistedDelivery,
};
