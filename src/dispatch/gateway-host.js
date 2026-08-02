'use strict';

// Gateway/dispatch orchestration host: gateway prompts, canonical dispatch
// admission, pending bookkeeping and result completion. Cross-session routing
// is MCP-only; assistant text is never parsed as an executable instruction.
// Mutable
// host state is reached through injected getters or function wrappers only —
// orchestrationRuntime and sessionDelivery are host `let`/`const`
// bindings resolved after this factory runs (getters), appendChatMessage /
// chatBroadcast wrap host functions that resolve their own
// late-bound dependencies per call, and createSessionRecord / taskContextHost /
// setSessionStatus are likewise resolved per call through getters. The

const bus = require('../bus');
const { sanitizeVoiceSpeech } = require('../voice-speech');

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[gateway-host] ${name} must be a function`);
  }
}

function createGatewayHost(rawDeps) {
  const deps = rawDeps || {};
  const {
    persistedSessions,
    chatSessions,
    directories,
    logger,
    appendEvent,
    getSessionDelivery,
    normalizeEffort,
    dispatchTargetHintFor,
    cwdForSession,
    getSetSessionStatus,
    isTargetBusy,
    getOrchestrationRuntime,
    getTaskContextHost,
    getCreateSessionRecord,
    appendChatMessage,
    chatBroadcast,
  } = deps;

  if (!persistedSessions || typeof persistedSessions.get !== 'function') {
    throw new TypeError('[gateway-host] persistedSessions map is required');
  }
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[gateway-host] chatSessions map is required');
  }
  if (!directories || typeof directories.get !== 'function') {
    throw new TypeError('[gateway-host] directories map is required');
  }
  if (!logger || typeof logger.warn !== 'function') {
    throw new TypeError('[gateway-host] logger.warn is required');
  }
  for (const [fn, name] of [
    [appendEvent, 'appendEvent'], [getSessionDelivery, 'getSessionDelivery'],
    [normalizeEffort, 'normalizeEffort'], [dispatchTargetHintFor, 'dispatchTargetHintFor'],
    [cwdForSession, 'cwdForSession'], [getSetSessionStatus, 'getSetSessionStatus'],
    [isTargetBusy, 'isTargetBusy'],
    [getOrchestrationRuntime, 'getOrchestrationRuntime'],
    [getTaskContextHost, 'getTaskContextHost'],
    [getCreateSessionRecord, 'getCreateSessionRecord'],
    [appendChatMessage, 'appendChatMessage'], [chatBroadcast, 'chatBroadcast'],
  ]) assertFunction(fn, name);

  function addressableSessions() {
    return [...persistedSessions.values()]
      .filter(s => s.type !== 'aux' && s.type !== 'gateway' && s.type !== 'commander')
      .slice(0, 30);
  }

  // The voice router needs two fields the WeChat prompt does not carry: `type`
  // (so it can prefer a Fleet's Commander) and `dirId` (so "这个项目" resolves to
  // one Fleet instead of a guess).
  function voiceRouterPrompt(userText) {
    const context = JSON.stringify(addressableSessions().map(s => ({
      id: s.id,
      label: s.label || '',
      type: s.type || 'worker',
      dirId: s.dirId || '',
      cli: s.cli || 'claude',
      kind: s.kind || 'terminal',
      cwd: cwdForSession(s),
      active: !!isTargetBusy(s.id),
    })));
    return [
      '[MultiCC 实时语音 Router system prompt]',
      '你是 MultiCC 的全局实时语音 Router 会话。用户通过实时语音发起、且没有指定来源会话的请求都进入这里。',
      '你负责判断如何回应：可以直接回答、追问澄清，或把任务投给某个具体 session。',
      '当用户确实要求执行、修改、检查或推进某项工作时，调用 dispatch_master，mode 必须是 async；target_session_id 必须逐字使用下面列表里的真实 id，message 必须完整、自包含。',
      '不要输出 <<dispatch>> 或 <<route>> 文本；文本不会触发任何投递。不要调用旧 HTTP dispatch 接口。',
      '语音场景没有二次确认，所以只有用户确实要求干活时才调用工具。工具返回 admitted 后才可声称已提交。',
      '如果用户没说清是哪个项目或哪个会话，而请求又必须落到某一个上，就只用一句话反问，不要自己挑一个 id 投出去。',
      '纯聊天、答疑、澄清类回复不要调用分派工具。',
      `当前可见 sessions: ${context}`,
      '[Voice router system prompt end]',
      '',
      userText,
    ].join('\n');
  }

  // Byte-identical to the pre-multi-gateway version for `__gateway__`; the voice
  // router takes the branch above. Both are pinned by tests.
  function buildGatewayPrompt(userText, sessionId = GATEWAY_ID) {
    if (sessionId === VOICE_ROUTER_ID) return voiceRouterPrompt(userText);
    const sessionsForPrompt = addressableSessions()
      .map(s => ({
        id: s.id,
        label: s.label || '',
        cli: s.cli || 'claude',
        kind: s.kind || 'terminal',
        cwd: cwdForSession(s),
        // Same classify-derived answer the requireIdle gate below uses, so the
        // routing LLM and the admission check cannot disagree. Never isStreaming
        // or connected-client count — a watching browser is not busy work.
        active: !!isTargetBusy(s.id),
      }));
    const context = JSON.stringify(sessionsForPrompt);
    return [
      '[MultiCC Gateway system prompt]',
      '你是 MultiCC 的微信 Gateway 会话。所有微信消息都统一进入这个会话。',
      '你负责基于用户消息和可用 session 上下文判断如何回应：可以直接回答、追问澄清，或把任务分发给某个具体 session。',
      '需要 session 执行任务时，先用自然语言复述目标与任务并等待用户明确回复「确认」；确认后的下一轮才调用 dispatch_master，mode 必须是 async。',
      'target_session_id 必须逐字使用下面列表里的真实 id，message 必须完整、自包含；工具返回 admitted 后才可声称已投递。',
      '不要输出 <<dispatch>> 或 <<route>> 文本；文本不会触发任何投递。不要调用旧 HTTP dispatch 接口。',
      '纯聊天、答疑、澄清类回复不要调用分派工具。',
      '当用户问 Gateway/Router/会话管理相关问题时，直接以 Gateway 身份回答，不要输出标记。',
      `当前可见 sessions: ${context}`,
      '[Gateway system prompt end]',
      '',
      userText,
    ].join('\n');
  }

  // ── Gateway dispatch ──
  const GATEWAY_ID = '__gateway__';
  // The realtime-voice router is a second gateway instance. Every piece of
  // gateway state below is therefore keyed by session id: two gateways must
  // never share a pending confirmation, a history sink or a result sink.
  const VOICE_ROUTER_ID = '__voice_router__';
  // Structured terminal outcome of one voice-router turn. `cancelled`/`unknown`
  // are part of the contract but are decided by the caller (a hung or aborted
  // call), never claimed by the Host — the Host only reports what it did.
  const VOICE_ADMISSION_VERSION = 1;
  const VOICE_ADMISSION_OUTCOMES = new Set([
    'no_dispatch', 'admitted', 'rejected', 'failed', 'cancelled', 'unknown',
  ]);
  const VOICE_ADMISSION_MEMORY = 256;
  const voiceAdmissionsEmitted = new Set();      // `${sessionId}\0${turnId}\0${requestId}`
  const dispatchRuns = new Map();                // hot cache; durable source of truth is orchestrationRuntime
  const TERMINAL_DISPATCH_STATUS = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

  function isPlaceholderTarget(targetId) {
    const value = String(targetId || '').trim().toLowerCase();
    return !value || /^(\.{2,}|…+|xxx|yyy|zzz|sid|session[-_ ]?id|target[-_ ]?id|worker[-_ ]?\d*)$/i.test(value)
      || value.includes('<') || value.includes('>');
  }


  // Push a server-originated assistant message into the gateway chat. Web clients
  // render it; the WeChat bridge (a gateway WS client) forwards it on `result`.
  function pushToGateway(text, { persist = true, sessionId = GATEWAY_ID } = {}) {
    if (!text) return;
    if (persist) appendChatMessage(sessionId, { role: 'assistant', content: text, ts: Date.now() });
    chatBroadcast(sessionId, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
    chatBroadcast(sessionId, { type: 'result', total_cost_usd: null });
  }

  // A dispatch target must be a real, non-system session.
  function validateDispatchTarget(targetId, fromSessionId = null, allowCommander = false) {
    const hint = fromSessionId ? `；${dispatchTargetHintFor(fromSessionId)}` : '';
    if (isPlaceholderTarget(targetId)) {
      return { ok: false, error: `「${targetId}」是占位符，不是真实 session id；请从可用目标 sessions 中选择一个真实 id${hint}` };
    }
    const rec = persistedSessions.get(targetId);
    if (!rec) return { ok: false, error: `目标 session「${targetId}」不存在${hint}` };
    if (rec.type === 'aux' || rec.type === 'gateway') return { ok: false, error: `不能把任务分发给系统会话「${targetId}」` };
    if (rec.type === 'commander' && !allowCommander) return { ok: false, error: `不能把任务分发给指挥官会话「${targetId}」；只有任务面板自动路由可进入指挥队列` };
    return { ok: true, rec };
  }

  // Exactly one structured terminal frame per voice-router turn.
  //
  // A live call cannot infer durable admission from assistant prose. The Host
  // therefore states the MCP admission outcome out of band, exactly once.
  //
  // The payload is deliberately narrow. It carries the outcome, admission's
  // proof and the speakable text — never the dispatched instruction, the
  // gateway prompt, a token, a cwd, a target label or a target session id.
  function emitVoiceAdmission(sessionId, turnId, requestId, fields = {}) {
    const key = `${sessionId}\0${turnId}\0${requestId}`;
    if (voiceAdmissionsEmitted.has(key)) return;
    if (voiceAdmissionsEmitted.size >= VOICE_ADMISSION_MEMORY) {
      voiceAdmissionsEmitted.delete(voiceAdmissionsEmitted.values().next().value);
    }
    voiceAdmissionsEmitted.add(key);
    let outcome = VOICE_ADMISSION_OUTCOMES.has(fields.outcome) ? fields.outcome : 'unknown';
    let publicError = fields.error || null;
    if (outcome === 'admitted' && !String(fields.operationId || '').trim()) {
      outcome = 'failed';
      publicError = {
        code: 'operation_id_missing',
        retryable: true,
        publicMessage: '任务提交结果不完整，请稍后重试。',
      };
    }
    const privateValues = [
      sessionId,
      turnId,
      requestId,
      ...(Array.isArray(fields.privateValues) ? fields.privateValues : []),
    ];
    const speechText = sanitizeVoiceSpeech(fields.speechText, { privateValues });
    const error = publicError && typeof publicError === 'object'
      ? {
          code: String(publicError.code || 'voice_admission_failed'),
          retryable: publicError.retryable === true,
          publicMessage: sanitizeVoiceSpeech(publicError.publicMessage, { privateValues })
            || '这条语音任务没有提交成功。',
        }
      : null;
    // An operation id is what "admitted" means. Nothing else may carry one, and
    // an admission without one is not an admission.
    const admitted = outcome === 'admitted';
    chatBroadcast(sessionId, {
      type: 'voice_admission',
      version: VOICE_ADMISSION_VERSION,
      requestId: String(requestId || ''),
      turnId: String(turnId || ''),
      outcome,
      operationId: admitted ? String(fields.operationId || '') || null : null,
      // A deduped replay landed on the same durable operation. That is still an
      // admission — the work is submitted exactly once, not lost.
      duplicate: fields.duplicate === true,
      queueStatus: admitted ? String(fields.queueStatus || '') || null : null,
      speechText,
      error,
    });
  }

  // MCP admission is authoritative. The voice bridge still needs one narrow,
  // structured terminal frame; emit it when the router tool has durably admitted
  // work, never by inspecting assistant prose.
  function recordRouterAdmission(admission = {}) {
    if (admission.callerSessionId !== VOICE_ROUTER_ID) return;
    const turn = chatSessions.get(VOICE_ROUTER_ID)?._activeTurn;
    if (!turn?.turnId) return;
    const target = persistedSessions.get(admission.targetSessionId);
    emitVoiceAdmission(VOICE_ROUTER_ID, turn.turnId, turn.requestId || '', {
      outcome: 'admitted',
      operationId: admission.operationId,
      duplicate: admission.duplicate === true,
      queueStatus: admission.status || 'admitted',
      speechText: '任务已提交，完成后结果会发回这里。',
      privateValues: [
        admission.targetSessionId,
        target ? cwdForSession(target) : '',
      ],
    });
  }

  // A gateway turn that made no MCP admission is explicitly classified as
  // no_dispatch for the voice caller. WeChat needs no out-of-band frame.
  function handleGatewayTurnComplete(finalText, sessionId = GATEWAY_ID, turnId = '', requestId = '') {
    if (sessionId !== VOICE_ROUTER_ID) return;
    const privateValues = [];
    for (const target of addressableSessions()) {
      privateValues.push(target.id, cwdForSession(target));
    }
    emitVoiceAdmission(sessionId, turnId, requestId, {
      outcome: 'no_dispatch',
      speechText: String(finalText || '').trim(),
      privateValues,
    });
  }
  // Gateway domain owns this handler; chat emits after a gateway session's own turn.
  bus.on('chat:gateway-turn-complete', handleGatewayTurnComplete);

  // Confirmation now stays in the Gateway conversation: the model asks first,
  // then calls MCP only after the user's next explicit confirmation.
  function handleGatewayControl() { return false; }

  // Deliver a confirmed dispatch; terminal targets receive an ephemeral chat.
  async function dispatchToSession(targetId, message, opts = {}) {
    let v = validateDispatchTarget(targetId, opts.replyTo || null, opts.allowCommander === true && opts.queueIfBusy === true && opts.requireIdle === false);
    // Create matching *-ultra-NN workers on demand from the dispatcher's config.
    if (!v.ok) {
      const m = targetId.match(/-ultra-(\d{2})$/);
      if (m && opts.replyTo) {
        const dispatcher = persistedSessions.get(opts.replyTo);
        if (dispatcher && normalizeEffort(dispatcher?.effort) === 'ultracode') {
          const dir = directories.get(dispatcher.dirId);
          if (dir) {
            const created = await getCreateSessionRecord()({
              dir, cli: dispatcher.cli || 'claude', kind: 'chat',
              label: `⚡ Ultra Worker ${String(parseInt(m[1], 10))}`,
              id: targetId, ephemeral: true,
              model: dispatcher.model || null,
              provider: dispatcher.provider || '',
              effort: 'xhigh',
              rolePrompt: '你是 MultiCC Ultracode worker。只执行派给你的自包含子任务；先同步 worktree，完成后验证、提交并尽量合并回基分支，最后用精简结构汇报改动、验证结果和风险。',
              persistence: 'bestEffort', persistenceSource: 'runtime.dispatch-worker-create',
            });
            if (created.ok) v = validateDispatchTarget(targetId, opts.replyTo || null, opts.allowCommander === true && opts.queueIfBusy === true && opts.requireIdle === false);
          }
        }
      }
    }
    if (!v.ok) return { ok: false, error: v.error };
    const rec = v.rec;

    let chatId;
    if (rec.kind === 'chat') {
      chatId = targetId;
    } else {
      // terminal-only target → create/reuse an ephemeral chat in the same directory.
      const created = await getCreateSessionRecord()({
        dir: directories.get(rec.dirId),
        cli: rec.cli || 'claude',
        kind: 'chat',
        label: `${rec.label || targetId} (gw)`,
        id: `${targetId}-gw-chat`,
        ephemeral: true,
        persistence: 'bestEffort', persistenceSource: 'runtime.gateway-chat-create',
      });
      if (!created.ok) return { ok: false, error: `创建临时 chat 失败：${created.error}` };
      chatId = created.id;
    }

    if (opts.requireIdle && isTargetBusy(chatId)) {
      return { ok: false, error: 'target_busy', code: 'target_busy', chatId };
    }
    const ownerSessionId = opts.ownerSessionId || opts.replyTo || GATEWAY_ID;
    const runtime = getOrchestrationRuntime();
    const admitted = await getOrchestrationRuntime().admitDispatch({
      ownerSessionId,
      resultSessionId: ownerSessionId,
      idempotencyKey: opts.idempotencyKey || null,
      spec: {
        targetId,
        targetLabel: rec.label || '',
        chatId,
        message,
        replyTo: opts.replyTo || null,
        gateway: !opts.replyTo && !opts.oneWay,
        oneWay: !!opts.oneWay,
        ...getTaskContextHost().dispatchSpec(opts),
      },
    });
    const dispatchId = admitted.id;
    dispatchRuns.set(dispatchId, {
      targetId,
      chatSessionId: chatId,
      replyTo: opts.replyTo || null,
      createdAt: admitted.createdAt,
    });
    // Only a synchronous master is actually blocked on the worker. Async mode
    // deliberately releases the master to finish independent work and end its
    // turn; its eventual dispatch.result is the new message that wakes it.
    if (opts.replyTo && opts.resultMode === 'sync'
        && !TERMINAL_DISPATCH_STATUS.has(admitted.status)) {
      addPendingDispatch(opts.replyTo, dispatchId, targetId);
    }
    // Dispatch admission owns its wake-up just like direct chat admission does.
    // Await one canonical scheduler pass so a never-opened chat is claimed and
    // lazily initialized/spawned before route_task reports success. Busy targets
    // remain durably queued; no process is pre-spawned and no parallel turn starts.
    //
    // The admission is already durable by this point. A scheduler pass that
    // throws costs the immediate wake-up and nothing else — the operation stays
    // queued and the next tick claims it — so the failure rides along with the
    // admission rather than replacing it. Reporting failure here would be a
    // false negative: the caller would resubmit work that is already committed
    // and the user would get it twice.
    let wakeupError = admitted.wakeupError || null;
    try {
      await runtime.tick();
    } catch (error) {
      wakeupError = error?.message || String(error);
    }
    if (wakeupError) {
      logger.warn('dispatch_wakeup_deferred', { operationId: dispatchId, targetId, error: wakeupError });
    }
    return {
      ok: true,
      chatId,
      operationId: dispatchId,
      status: admitted.status,
      duplicate: !!admitted.idempotent,
      ...(wakeupError ? { wakeupError } : {}),
    };
  }

  // ── Dispatch ↔ currentTask bridge (step 2, idle fix) ──────────────────────────
  // A sync dispatcher is blocked inside dispatch_master, so expose that narrow
  // dependency on its current task. Async dispatches never enter this list:
  // they finish the current master turn and are later woken by a result message.
  function addPendingDispatch(dispatcherId, dispatchId, targetId) {
    if (!dispatcherId) return;
    const cs = chatSessions.get(dispatcherId);
    if (!cs || !cs.currentTask) return;
    cs.currentTask.pendingDispatches = cs.currentTask.pendingDispatches || [];
    if (cs.currentTask.pendingDispatches.some(entry => entry.dispatchId === dispatchId)) return;
    cs.currentTask.pendingDispatches.push({ dispatchId, targetId, sentAt: Date.now() });
    // Phase: still working, but now blocked on workers. Surface as waiting.
    if (cs.currentTask.phase !== 'done') cs.currentTask.phase = 'awaiting_workers';
    // Nudge the dispatcher's status to waiting right away (its own turn may have
    // just ended → it would otherwise flicker to idle before the next status tick).
    // setSessionStatus arrives late in the host (const, after this factory runs),
    // so resolve it through the getter exactly like orchestrationRuntime.
    getSetSessionStatus()(dispatcherId, { status: 'waiting' });
  }
  function removePendingDispatch(dispatcherId, dispatchId) {
    if (!dispatcherId) return 0;
    const cs = chatSessions.get(dispatcherId);
    if (!cs || !cs.currentTask || !cs.currentTask.pendingDispatches) return 0;
    const before = cs.currentTask.pendingDispatches.length;
    cs.currentTask.pendingDispatches = cs.currentTask.pendingDispatches
      .filter(p => p.dispatchId !== dispatchId);
    const remaining = cs.currentTask.pendingDispatches.length;
    // All workers回流 → phase moves on (next turn will re-classify). Don't touch
    // status here; the incoming回流 turn will drive status naturally.
    if (remaining === 0 && cs.currentTask.phase === 'awaiting_workers') {
      cs.currentTask.phase = 'implementing';
    }
    return before - remaining;
  }

  // A dispatched turn finished. Sync and one-way operations complete from the
  // worker's final output. Async success is authoritative only when the worker
  // called dispatch_slave; a normal final response without that tool is a
  // protocol failure, never an implicit success/backflow.
  async function finalizeDispatch(dispatchId, sessionName, finalText) {
    const run = dispatchRuns.get(dispatchId);
    dispatchRuns.delete(dispatchId);
    const operation = await getOrchestrationRuntime().operations.get(dispatchId);
    const targetId = operation?.spec?.targetId || (run ? run.targetId : sessionName);
    const replyTo = operation?.spec?.replyTo || (run && run.replyTo);
    // A worker finished → drop it from the dispatcher's pending list (so the
    // dispatcher's status can leave 'waiting' once all workers回流).
    if (replyTo) removePendingDispatch(replyTo, dispatchId);
    if (operation && TERMINAL_DISPATCH_STATUS.has(operation.status)) return;
    const resultMode = operation?.spec?.resultMode || null;
    if (resultMode === 'async') {
      await getOrchestrationRuntime().completeDispatch(dispatchId, {
        status: 'failed',
        sessionName,
        text: 'worker 已结束，但没有调用 dispatch_slave 提交 async 回执。',
        error: 'worker 已结束，但没有调用 dispatch_slave 提交 async 回执。',
        source: 'missing_dispatch_slave',
      });
      return;
    }
    const completed = await getOrchestrationRuntime().completeDispatch(dispatchId, {
      status: 'completed',
      sessionName,
      text: (finalText || '').trim() || '（本次运行没有产生文本输出）',
      source: resultMode === 'sync' ? 'sync_final_output' : 'turn_final_output',
    });
    // Compatibility fallback for a dispatch that began before this deployment
    // and therefore has no durable operation record.
    if (!completed.ok && completed.code === 'not_found') {
      const text = (finalText || '').trim() || '（本次运行没有产生文本输出）';
      if (replyTo && persistedSessions.get(replyTo)) {
        getSessionDelivery().deliverContinuation(replyTo, `【${targetId} 回复】\n${text}`);
      } else {
        // Route the legacy fallback back to whichever gateway owns this
        // dispatch, so a voice result never surfaces in the WeChat thread.
        pushToGateway(`【${targetId} 回复】\n${text}`, { sessionId: operation?.resultSessionId || GATEWAY_ID });
      }
    }
  }
  // Gateway domain owns this handler; chat emits when a dispatched turn finishes.
  bus.on('chat:dispatch-complete', (dispatchId, sessionName, finalText) => {
    finalizeDispatch(dispatchId, sessionName, finalText)
      .catch(error => console.error(`[multicc/dispatch] finalize ${dispatchId} failed: ${error.message}`));
  });

  return {
    GATEWAY_ID,
    VOICE_ROUTER_ID,
    buildGatewayPrompt,
    pushToGateway,
    validateDispatchTarget,
    handleGatewayTurnComplete,
    handleGatewayControl,
    recordRouterAdmission,
    dispatchToSession,
    finalizeDispatch,
  };
}

module.exports = { createGatewayHost };
