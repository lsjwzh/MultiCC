'use strict';

// Gateway/dispatch orchestration host: the WeChat gateway system prompt, the
// confirm/cancel control path, dispatch admission + pending bookkeeping, and
// the turn-end marker sweep that turns <<dispatch>>/<<route>> markers into real
// cross-session deliveries.
//
// Extracted verbatim from server.js. Behaviour is preserved exactly; mutable
// host state is reached through injected getters or function wrappers only —
// orchestrationRuntime, chatHistoryService and sessionDelivery are host `let`/`const`
// bindings resolved after this factory runs (getters), appendChatMessage /
// chatBroadcast / loadChatHistory wrap host functions that resolve their own
// late-bound dependencies per call, and createSessionRecord / taskContextHost /
// setSessionStatus are likewise resolved per call through getters. The
// cross-fleet double gate in maybeDispatchFromChatTurn (same-dir unless
// commander, for BOTH dispatch and legacy route markers) is pinned
// byte-for-byte by tests.

const crypto = require('crypto');
const bus = require('../bus');
const {
  DISPATCH_RE,
  DISPATCH_CONFIRM_RE,
  DISPATCH_CANCEL_RE,
  parseDispatchMarker,
  parseAllDispatchMarkers,
  parseAllRouteMarkers,
  ROUTE_RE_G,
  isDispatchPlaceholderTarget,
} = require('./markers');
const { routeLegacyCommanderMarkers } = require('./legacy-commander-route');

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
    getChatHistoryService,
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
    loadChatHistory,
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
    [appendEvent, 'appendEvent'], [getSessionDelivery, 'getSessionDelivery'], [getChatHistoryService, 'getChatHistoryService'],
    [normalizeEffort, 'normalizeEffort'], [dispatchTargetHintFor, 'dispatchTargetHintFor'],
    [cwdForSession, 'cwdForSession'], [getSetSessionStatus, 'getSetSessionStatus'],
    [isTargetBusy, 'isTargetBusy'],
    [getOrchestrationRuntime, 'getOrchestrationRuntime'],
    [getTaskContextHost, 'getTaskContextHost'],
    [getCreateSessionRecord, 'getCreateSessionRecord'],
    [appendChatMessage, 'appendChatMessage'], [chatBroadcast, 'chatBroadcast'],
    [loadChatHistory, 'loadChatHistory'],
  ]) assertFunction(fn, name);

  function addressableSessions() {
    return [...persistedSessions.values()]
      .filter(s => s.type !== 'aux' && s.type !== 'gateway')
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
      '当用户确实要求执行、修改、检查或推进某项工作时，在回复的最后单独输出一行分发标记：',
      '<<dispatch target="真实 session id">要交给该 session 执行的完整、自包含指令</dispatch>>',
      '其中 target 必须逐字使用上面可见 sessions 列表里的某个 id；不要使用 ...、SID、SESSION_ID、<目标会话id> 等占位符。dispatch 内的指令要完整到该 session 无需追问即可执行。',
      '优先投给目标项目的 Commander（type 为 commander）会话，由它再挑选合适的 Worker；只有用户明确点名了某个会话时才直接投给那个会话。',
      '语音场景没有二次确认：标记一旦输出就会立即投递，所以只有用户确实要求干活时才输出。',
      '如果用户没说清是哪个项目或哪个会话，而请求又必须落到某一个上，就只用一句话反问，不要自己挑一个 id 投出去。',
      '纯聊天、答疑、澄清类回复不要输出标记。每条回复最多一个 dispatch 标记。',
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
      '当你判断需要某个 session 来处理任务时，在回复的最后单独输出一行分发标记：',
      '<<dispatch target="真实 session id">要交给该 session 执行的完整、自包含指令</dispatch>>',
      '其中 target 必须逐字使用上面可见 sessions 列表里的某个 id；不要使用 ...、SID、SESSION_ID、<目标会话id> 等占位符。dispatch 内的指令要完整到该 session 无需追问即可执行。',
      '分发不会立即生效——系统会先向用户复述并等待用户回复「确认」后才真正投递，所以你可以在标记前用自然语言说明你打算交给谁、做什么。',
      '只有真的需要某个 session 干活时才输出该标记；纯聊天、答疑、澄清类回复不要输出标记。每条回复最多一个 dispatch 标记。',
      '当用户问 Gateway/Router/会话管理相关问题时，直接以 Gateway 身份回答，不要输出标记。',
      `当前可见 sessions: ${context}`,
      '[Gateway system prompt end]',
      '',
      userText,
    ].join('\n');
  }

  // ── Gateway dispatch (auto-dispatch v1) ──
  // The gateway LLM can emit a <<dispatch target="ID">...</dispatch>> marker; we
  // hold it as a pending request, ask the WeChat user to confirm, and only then
  // drive the target session via runChatTurn. The target's result is pushed back.
  const GATEWAY_ID = '__gateway__';
  // The realtime-voice router is a second gateway instance. Every piece of
  // gateway state below is therefore keyed by session id: two gateways must
  // never share a pending confirmation, a history sink or a result sink.
  const VOICE_ROUTER_ID = '__voice_router__';
  const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;   // pending confirmation expires after 10 min
  const pendingDispatches = new Map();           // gatewaySessionId → { id, targetId, message, createdAt }
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
    if (isDispatchPlaceholderTarget(targetId)) {
      return { ok: false, error: `「${targetId}」是占位符，不是真实 session id；请从可用目标 sessions 中选择一个真实 id${hint}` };
    }
    const rec = persistedSessions.get(targetId);
    if (!rec) return { ok: false, error: `目标 session「${targetId}」不存在${hint}` };
    if (rec.type === 'aux' || rec.type === 'gateway') return { ok: false, error: `不能把任务分发给系统会话「${targetId}」` };
    if (rec.type === 'commander' && !allowCommander) return { ok: false, error: `不能把任务分发给指挥官会话「${targetId}」；只有任务面板自动路由可进入指挥队列` };
    return { ok: true, rec };
  }

  // Remove the raw marker from the most recent persisted gateway assistant message.
  function stripMarkerFromGatewayHistory(sessionId = GATEWAY_ID) {
    const hist = loadChatHistory(sessionId);
    for (let i = hist.length - 1; i >= 0; i--) {
      const m = hist[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string' && DISPATCH_RE.test(m.content)) {
        m.content = m.content.replace(DISPATCH_RE, '').replace(/\n{3,}/g, '\n\n').trim();
        try { getChatHistoryService().replace(sessionId, hist, { reason: 'strip-dispatch-marker' }); }
        catch (error) {
          logger.warn('chat_history_marker_strip_failed', { sessionId, error: error.message });
        }
      }
      return;   // only inspect the latest assistant message
    }
  }

  function stripRouteMarkerFromHistory(sessionId) {
    const hist = loadChatHistory(sessionId);
    for (let i = hist.length - 1; i >= 0; i--) {
      const m = hist[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string' && ROUTE_RE_G.test(m.content)) {
        ROUTE_RE_G.lastIndex = 0;
        m.content = m.content.replace(ROUTE_RE_G, '').replace(/\n{3,}/g, '\n\n').trim();
        try { getChatHistoryService().replace(sessionId, hist, { reason: 'strip-route-marker' }); }
        catch (error) {
          logger.warn('chat_history_route_marker_strip_failed', { sessionId, error: error.message });
        }
      }
      ROUTE_RE_G.lastIndex = 0;
      return;   // only inspect the latest assistant message
    }
  }

  // Exactly one structured terminal frame per voice-router turn.
  //
  // A live call cannot learn the outcome from the assistant stream: the marker
  // arrives fragmented character by character, and the turn's `result` frame
  // lands before the durable admission has an answer. So the Host states the
  // outcome itself, out of band, once.
  //
  // The payload is deliberately narrow. It carries the outcome, admission's
  // proof and the speakable text — never the dispatched instruction, the
  // gateway prompt, a token, a cwd, or a target session id. A target appears at
  // most as its human label, so a hot microphone can never become a channel for
  // reading the Fleet's internals back out.
  function emitVoiceAdmission(sessionId, turnId, requestId, fields = {}) {
    const key = `${sessionId} ${turnId} ${requestId}`;
    if (voiceAdmissionsEmitted.has(key)) return;
    if (voiceAdmissionsEmitted.size >= VOICE_ADMISSION_MEMORY) {
      voiceAdmissionsEmitted.delete(voiceAdmissionsEmitted.values().next().value);
    }
    voiceAdmissionsEmitted.add(key);
    const outcome = VOICE_ADMISSION_OUTCOMES.has(fields.outcome) ? fields.outcome : 'unknown';
    // An operation id is what "admitted" means. Nothing else may carry one, and
    // an admission without one is not an admission.
    const admitted = outcome === 'admitted';
    chatBroadcast(sessionId, {
      type: 'voice_admission',
      version: VOICE_ADMISSION_VERSION,
      requestId: String(requestId || ''),
      turnId: String(turnId || ''),
      gatewaySessionId: sessionId,
      outcome,
      operationId: admitted ? String(fields.operationId || '') || null : null,
      // A deduped replay landed on the same durable operation. That is still an
      // admission — the work is submitted exactly once, not lost.
      duplicate: fields.duplicate === true,
      queueStatus: admitted ? String(fields.queueStatus || '') || null : null,
      speechText: typeof fields.speechText === 'string' ? fields.speechText : '',
      targetLabel: String(fields.targetLabel || ''),
      error: fields.error || null,
    });
  }

  // Called when a gateway turn completes: detect a dispatch marker, stage it as a
  // pending request, and ask the user to confirm. Does NOT deliver yet.
  function handleGatewayTurnComplete(finalText, sessionId = GATEWAY_ID, turnId = '', requestId = '') {
    const voice = sessionId === VOICE_ROUTER_ID;
    const parsed = parseDispatchMarker(finalText);
    if (!parsed) {
      // Deciding not to dispatch is an outcome. Without saying so, a caller
      // cannot tell "there was nothing to submit" from "the answer never came".
      if (voice) {
        emitVoiceAdmission(sessionId, turnId, requestId, {
          outcome: 'no_dispatch',
          speechText: String(finalText || '').trim(),
        });
      }
      return;
    }
    stripMarkerFromGatewayHistory(sessionId);
    // Voice may address a Fleet's Commander directly; WeChat may not.
    const v = validateDispatchTarget(parsed.target, null, voice);
    if (!v.ok) {
      // The frame states the class of failure rather than v.error, which names
      // the rejected target id verbatim.
      if (voice) {
        emitVoiceAdmission(sessionId, turnId, requestId, {
          outcome: 'rejected',
          speechText: parsed.cleanText,
          error: {
            code: 'dispatch_target_rejected',
            publicMessage: '这次语音请求没有可以执行它的目标会话。',
            retryable: false,
          },
        });
      }
      pushToGateway(`⚠️ 无法分发：${v.error}`, { sessionId });
      return;
    }
    const label = (v.rec.label && v.rec.label !== parsed.target) ? `${parsed.target}（${v.rec.label}）` : parsed.target;
    if (voice) {
      // A live voice call has nowhere to park a 确认 state, and borrowing
      // WeChat's would let one channel resolve the other's pending dispatch.
      // An explicit spoken execution request is admitted directly instead —
      // and only reported as submitted once admission actually succeeds.
      // The turn id keys idempotency, so a replayed turn cannot double-deliver.
      const targetLabel = String(v.rec.label || '');
      return dispatchToSession(parsed.target, parsed.message, {
        ownerSessionId: sessionId,
        idempotencyKey: `voice:${sessionId}:${turnId || crypto.randomUUID()}`,
        allowCommander: true,
        queueIfBusy: true,
        requireIdle: false,
      })
        .then(r => {
          const admitted = r.ok === true && !!r.operationId;
          // The structured frame goes out before the prose push: the prose push
          // also broadcasts a `result`, and a caller that is still waiting for
          // its outcome must have it in hand by then.
          emitVoiceAdmission(sessionId, turnId, requestId, {
            outcome: admitted ? 'admitted' : 'failed',
            operationId: admitted ? r.operationId : null,
            duplicate: r.duplicate === true,
            queueStatus: admitted ? r.status : null,
            speechText: parsed.cleanText,
            targetLabel,
            error: admitted ? null : {
              code: r.ok === true ? 'operation_id_missing' : String(r.code || 'dispatch_not_admitted'),
              publicMessage: '这条语音任务没有提交成功。',
              retryable: true,
            },
          });
          pushToGateway(
            r.ok ? `✅ 已提交给 ${label}，完成后会把结果发回这里。` : `⚠️ 投递失败：${r.error}`,
            { sessionId },
          );
        })
        .catch(e => {
          emitVoiceAdmission(sessionId, turnId, requestId, {
            outcome: 'failed',
            speechText: parsed.cleanText,
            targetLabel,
            error: { code: 'dispatch_error', publicMessage: '这条语音任务投递时出错了。', retryable: true },
          });
          pushToGateway(`⚠️ 投递异常：${e.message}`, { sessionId });
        });
    }
    pendingDispatches.set(sessionId, {
      id: crypto.randomUUID(), targetId: parsed.target, message: parsed.message, createdAt: Date.now(),
    });
    const summary = parsed.message.length > 80 ? parsed.message.slice(0, 80) + '…' : parsed.message;
    pushToGateway(`📨 准备把任务投给 ${label}：\n「${summary}」\n回复「确认」执行，回复「取消」放弃。`, { sessionId });
  }
  // Gateway domain owns this handler; chat emits after a gateway session's own turn.
  bus.on('chat:gateway-turn-complete', handleGatewayTurnComplete);

  // Intercept gateway inbound messages for confirm/cancel of a pending dispatch.
  // Returns true if the message was consumed (caller should NOT run the LLM).
  function handleGatewayControl(rawText, sessionId = GATEWAY_ID) {
    const pendingDispatch = pendingDispatches.get(sessionId);
    if (!pendingDispatch) return false;
    if (Date.now() - pendingDispatch.createdAt > DISPATCH_TIMEOUT_MS) {
      pendingDispatches.delete(sessionId);   // expired → fall through to the LLM
      return false;
    }
    const text = (rawText || '').trim();
    if (DISPATCH_CONFIRM_RE.test(text)) {
      const pd = pendingDispatch; pendingDispatches.delete(sessionId);
      appendChatMessage(sessionId, { role: 'user', content: rawText, ts: Date.now() });
      dispatchToSession(pd.targetId, pd.message, {
        ownerSessionId: sessionId,
        idempotencyKey: `gateway:${pd.id}`,
      })
        .then(r => pushToGateway(r.ok ? `✅ 已投递给 ${pd.targetId}，完成后会把结果发回这里。` : `⚠️ 投递失败：${r.error}`, { sessionId }))
        .catch(e => pushToGateway(`⚠️ 投递异常：${e.message}`, { sessionId }));
      return true;
    }
    if (DISPATCH_CANCEL_RE.test(text)) {
      pendingDispatches.delete(sessionId);
      appendChatMessage(sessionId, { role: 'user', content: rawText, ts: Date.now() });
      pushToGateway('已取消分发。', { sessionId });
      return true;
    }
    return false;   // anything else → let the LLM handle (user may revise/add)
  }

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
    // Keep the dispatcher's card waiting while its worker runs.
    if (opts.replyTo && !opts.oneWay && !TERMINAL_DISPATCH_STATUS.has(admitted.status)) {
      addPendingDispatch(opts.replyTo, dispatchId, targetId);
    }
    // Dispatch admission owns its wake-up just like direct chat admission does.
    // Await one canonical scheduler pass so a never-opened chat is claimed and
    // lazily initialized/spawned before route_task reports success. Busy targets
    // remain durably queued; no process is pre-spawned and no parallel turn starts.
    await runtime.tick();
    return {
      ok: true,
      chatId,
      operationId: dispatchId,
      status: admitted.status,
      duplicate: !!admitted.idempotent,
    };
  }

  // ── Dispatch ↔ currentTask bridge (step 2, idle fix) ──────────────────────────
  // When a dispatcher sends work out to a worker and waits for回流, we track the
  // pending dispatch on the dispatcher's currentTask so setSessionStatus can keep
  // the dispatcher at 'waiting' instead of 'idle'. Best-effort: if the dispatcher
  // has no currentTask (e.g. a gateway), these are no-ops.
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

  // A dispatched turn finished → route its final text back to whoever dispatched
  // it: a normal session (the commander) gets it injected as a new turn so it can
  // aggregate; a gateway/WeChat dispatch falls back to pushToGateway.
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
    const completed = await getOrchestrationRuntime().completeDispatch(dispatchId, {
      status: 'completed',
      sessionName,
      text: (finalText || '').trim() || '（本次运行没有产生文本输出）',
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

  // Cross-session dispatch is driven only by structured evidence: a parsed
  // <<dispatch>> marker here, or the dispatch HTTP API. Assistant prose is never
  // interpreted as routing intent.
  function maybeDispatchFromChatTurn(dispatcherId, finalText) {
    const dispatchMarkers = parseAllDispatchMarkers(finalText);
    const routeMarkers = parseAllRouteMarkers(finalText);
    if (!dispatchMarkers.length && !routeMarkers.length) return;
    const from = persistedSessions.get(dispatcherId);
    if (!from) return;
    const deliveries = [];
    const history = loadChatHistory(dispatcherId);
    const sourceMessage = [...history].reverse().find(entry => entry && entry.role === 'assistant');
    const sourceUserMessage = [...history].reverse().find(entry => entry && entry.role === 'user');
    const sourceUserText = String(sourceUserMessage?.content || '');
    const sourceKey = sourceMessage?.id || crypto.createHash('sha256').update(String(finalText || '')).digest('hex').slice(0, 24);

    // <<dispatch>> markers: two-way (worker results flow back to dispatcher)
    for (const [markerIndex, mk] of dispatchMarkers.entries()) {
      if (mk.target === dispatcherId) continue;
      const v = validateDispatchTarget(mk.target, dispatcherId);
      if (!v.ok) { getSessionDelivery().deliverSystem(dispatcherId, `⚠️ 无法分发给 ${mk.target}：${v.error}`); continue; }
      if (v.rec.dirId !== from.dirId && from.type !== 'commander') { getSessionDelivery().deliverSystem(dispatcherId, `⚠️ 只能分发给同目录会话，已跳过 ${mk.target}`); continue; }
      appendEvent(from.dirId, 'dispatch', `→ ${v.rec.label || mk.target}`, dispatcherId);
      deliveries.push(dispatchToSession(mk.target, mk.message, {
        replyTo: dispatcherId,
        oneWay: false,
        idempotencyKey: `marker:${dispatcherId}:${sourceKey}:${markerIndex}`,
      })
        .then(r => { if (!r.ok) getSessionDelivery().deliverSystem(dispatcherId, `⚠️ 分发给 ${mk.target} 失败：${r.error}`); })
        .catch(e => getSessionDelivery().deliverSystem(dispatcherId, `⚠️ 分发 ${mk.target} 异常：${e.message}`)));
    }

    deliveries.push(...routeLegacyCommanderMarkers({
      markers: routeMarkers, dispatcherId, from, sourceUserText, sourceKey,
      records: persistedSessions, crypto, isPlaceholder: isDispatchPlaceholderTarget,
      validateTarget: target => validateDispatchTarget(target, dispatcherId),
      appendEvent, dispatch: dispatchToSession,
      inject: text => getSessionDelivery().deliverSystem(dispatcherId, text),
    }));

    // Strip <<route>> markers from displayed history (like Gateway strips <<dispatch>>)
    if (routeMarkers.length) stripRouteMarkerFromHistory(dispatcherId);

    return Promise.all(deliveries);
  }
  return {
    GATEWAY_ID,
    VOICE_ROUTER_ID,
    buildGatewayPrompt,
    pushToGateway,
    validateDispatchTarget,
    handleGatewayTurnComplete,
    handleGatewayControl,
    dispatchToSession,
    finalizeDispatch,
    maybeDispatchFromChatTurn,
  };
}

module.exports = { createGatewayHost };
