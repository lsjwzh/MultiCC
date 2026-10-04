(function attachMultiCCChatEventController(global) {
  'use strict';

  // 数字格式的唯一来源（shared/format.js，页面里先于本文件加载）。Node 侧的沙箱里
  // 没有页面全局，也没有 require，所以三种取法都留着 —— 测试要么注入
  // MultiCCFormat，要么让它落到 require 上。
  const FMT = (typeof window !== 'undefined' && window.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || (typeof require === 'function' ? require('./shared/format.js') : null);

  function isRecoverableCodexReconnectErrorText(text) {
    const value = String(text || '');
    // 前缀是车道的展示名（turn-engine 用 `${label} 出错：…` 拼），而 2026-09-24 给
    // 两条车道改了名：这条文本来自一次性车道，它的 label 现在是 "Codex Exec"（原来
    // 是 "Codex"）。三种拼法都收：新名、旧名，以及 turn-engine / finalize-host 里
    // 硬编码的 "Codex 出错："。只认一种拼法的话，一次瞬时重连会被当成真错误弹给用户。
    return /^(?:Codex|Codex Exp|Codex Exec) 出错：Reconnecting\.\.\.\s*\d+\/\d+\s*\(/i.test(value)
      && /stream disconnected before completion|response\.completed/i.test(value);
  }

  function isCodexCli(cli) {
    return cli === 'codex' || cli === 'codex-exp';
  }

  // 内置官方供应商的名字是服务端数据（'Codex 官方'），展示时按身份翻译。
  function displayProviderName(value) {
    const api = global && global.MultiCCProviderCatalog;
    return api && api.providerDisplayName
      ? api.providerDisplayName(value || '') : (value || '');
  }

  // 下面三张表存的是目录键，不是文案：心跳和准入进度都是界面 chrome，字样必须
  // 跟着 t() 走（服务端只发 phase / toolKind 这类枚举，语言由这里决定）。
  const PROGRESS_PHASES = Object.freeze({
    starting: 'progressPhaseStarting',
    thinking: 'progressPhaseThinking',
    tool: 'progressPhaseTool',
    recovering: 'progressPhaseRecovering',
    finalizing: 'progressPhaseFinalizing',
  });
  const PROGRESS_TOOLS = Object.freeze({
    subagent: 'progressToolSubagent',
    monitor: 'progressToolMonitor',
    process: 'progressToolProcess',
    filesystem: 'progressToolFilesystem',
    search: 'progressToolSearch',
    network: 'progressToolNetwork',
  });
  const ATTEMPT_OWNED_EVENT_TYPES = Object.freeze({
    part_delta: true,
    stream_event: true,
    assistant: true,
    user: true,
    result: true,
    api_error_policy: true,
    provider_token_stats: true,
    rate_limit_event: true,
  });
  const TERMINAL_PROVIDER_ROUTE_PHASES = Object.freeze({
    failed: true,
    succeeded: true,
    released: true,
  });
  // 这几个键 App 端也用（admission_notes.dart），两边别各写一份文案。
  const ADMISSION_PROGRESS_LABELS = Object.freeze({
    waiting: 'admissionMemoryWaiting',
    ready: 'admissionMemoryReady',
    memory_distill_failed: 'admissionMemoryFailed',
    memory_distill_skipped: 'admissionMemorySkipped',
    starting: 'admissionStarting',
    processing: 'admissionProcessing',
  });

  function admissionDetail(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  function visibleProviderModel(value) {
    if (typeof value !== 'string') return '';
    const model = value.trim();
    if (!model || model === '_default_' || model.length > 256
        || /[\u0000-\u001f\u007f]/.test(model)) return '';
    return model;
  }

  // The translator is an argument rather than a host lookup: this is called from
  // the danmaku path and from the unit tests, and neither owns the page global.
  function formatProgressHeartbeat(message, translate) {
    const tr = typeof translate === 'function' ? translate : (key => key);
    const source = message && typeof message === 'object' ? message : {};
    const phase = tr(PROGRESS_PHASES[source.heartbeatPhase] || 'progressPhaseRunning');
    // 一段测出来的时间走全站唯一那份（shared/format.js）。原来这里把秒以下抹掉、
    // 又把零秒说成「0s」—— 一个 900ms 的工具调用会被记成 0。
    const elapsed = FMT.formatDuration(Number(source.elapsedMs) || 0);
    const tool = source.toolKind ? tr(PROGRESS_TOOLS[source.toolKind] || '') : '';
    return [phase, elapsed, tool].filter(Boolean).join(' · ');
  }

  // Difficulty routing note: the one line a chat shows for "Jev judged this
  // message, so this line/model answers it". Built from the provider_auto_route
  // `selected` event alone; '' means there is nothing worth saying.
  const AUTO_ROUTE_WHY = Object.freeze({
    jev_key_missing: 'autoRouteWhyKey',
    jev_timeout: 'autoRouteWhyTimeout',
    jev_http_401: 'autoRouteWhyAuth',
    jev_http_403: 'autoRouteWhyAuth',
    jev_network: 'autoRouteWhyNetwork',
    jev_not_prepared: 'autoRouteWhyNotJudged',
  });
  const AUTO_ROUTE_ACTION = Object.freeze({
    strong: 'autoRouteUseStrong', weak: 'autoRouteUseWeak', priority: 'autoRouteUsePriority',
  });

  function formatAutoRouteNote(event, translate) {
    const tr = typeof translate === 'function' ? translate : (key => key);
    const routing = event && event.routing;
    if (!routing || event.routePhase !== 'selected' || !event.providerName) return '';
    const tierName = (index, count) => {
      if (!Number.isInteger(index) || !Number.isInteger(count) || count < 2) return '';
      if (count > 3) return tr('autoRouteTierNth', { n: index + 1, count });
      if (index === 0) return tr('autoRouteTierSimple');
      return tr(index >= count - 1 ? 'autoRouteTierComplex' : 'autoRouteTierMedium');
    };
    const name = displayProviderName(event.providerName);
    const model = visibleProviderModel(event.model);
    let target = model ? tr('autoRouteTarget', { name, model }) : name;
    const preferred = tierName(routing.tierIndex, routing.tierCount);
    // Every line of the judged tier was out of quota or already tried.
    if (preferred && event.tier && event.preferredTier && event.tier !== event.preferredTier) {
      target += tr('autoRouteTierBusy', { tier: preferred });
    }
    if (routing.source === 'jev') {
      if (!preferred) return '';
      const raised = routing.code && routing.code !== 'jev_choice' ? tr('autoRouteRaised') : '';
      const seconds = Number(routing.latencyMs) > 0
        ? tr('autoRouteLatency', { sec: (Number(routing.latencyMs) / 1000).toFixed(1) }) : '';
      return tr('autoRouteDecided', { tier: preferred + raised, target }) + seconds;
    }
    if (routing.source !== 'fallback') return '';
    const code = String(routing.code || '');
    const whyKey = AUTO_ROUTE_WHY[code] || (/^jev_http_\d+$/.test(code) ? 'autoRouteWhyHttp' : 'autoRouteWhyOther');
    const reason = tr(whyKey, { status: code.slice('jev_http_'.length) });
    const action = tr(AUTO_ROUTE_ACTION[routing.onUnknown] || AUTO_ROUTE_ACTION.strong);
    return tr('autoRouteFallback', { reason, action, target });
  }

  function taskAwareCompletionVoice(message, fallback) {
    const source = message && typeof message === 'object' ? message : {};
    const code = String(source.taskShortCode || '').trim();
    const goal = String(source.taskGoal || '').trim();
    const identity = [code, goal].filter(Boolean).join('，');
    if (identity) return `${identity}，${fallback}`;
    const serverVoice = typeof source.voiceMessage === 'string' ? source.voiceMessage.trim() : '';
    return serverVoice || fallback;
  }

  function createEventController(options) {
    const opts = options || {};
    const state = opts.state || {};
    const host = opts.host || {};
    const liveUi = opts.liveUi;
    const historyStore = opts.historyStore;
    const historyView = opts.historyView;
    let generation = 0;
    let activeProgressTurnId = null;
    let providerRouteProtocolVersion = 0;
    let activeProviderRoute = null;
    let providerRouteHighWater = null;
    let providerRouteTerminal = false;
    let activeProviderModelRoute = null;
    let activeProviderModelSource = '';
    const pendingAdmissionIds = new Set();
    // The "Jev is judging…" line of the message being admitted; the turn's
    // selected route rewrites it in place into the verdict.
    let autoRouteNoteEl = null;
    // Every label this controller paints is chrome, so it goes through the
    // page's t() (i18n.js). The host owns the page; a Node caller without one
    // gets the key back, which is what the unit tests assert against.
    const tr = (key, params) => (typeof host.translate === 'function' ? host.translate(key, params) : key);

    function resetProviderRouteGate() {
      providerRouteProtocolVersion = 0;
      activeProviderRoute = null;
      providerRouteHighWater = null;
      providerRouteTerminal = false;
      activeProviderModelRoute = null;
      activeProviderModelSource = '';
      state.providerRouteProtocolVersion = 0;
      state.activeProviderRoute = null;
      state.providerRouteHighWater = null;
    }
    function beginGeneration() { generation += 1; resetProviderRouteGate(); return generation; }
    function invalidateGeneration() { generation += 1; resetProviderRouteGate(); return generation; }
    // Dead-socket defense: a user_input_resolved broadcast sent while we were
    // disconnected is lost, so drop the stale card — the server's connect-time
    // replay re-delivers the authoritative state (required or resolved).
    function dropStaleUserInput() {
      const id = host.getUserInputRequestId?.();
      if (id) host.consumeUserInputRequestId?.(id);
    }
    function isOwned(expectedGeneration) {
      return Number.isInteger(expectedGeneration) && expectedGeneration === generation;
    }

    function providerRouteIdentity(message) {
      const source = message && typeof message === 'object' ? message : {};
      const routeField = (value) => {
        if (typeof value !== 'string') return '';
        const text = value.trim();
        return text && text.length <= 256 && !/[\u0000-\u001f\u007f]/.test(text) ? text : '';
      };
      const routeGeneration = source.routeGeneration;
      const identity = {
        providerRouteScope: routeField(source.providerRouteScope),
        runtimeEpoch: routeField(source.runtimeEpoch),
        turnId: routeField(source.turnId),
        decisionId: routeField(source.decisionId),
        routeAttemptId: routeField(source.routeAttemptId),
        routeGeneration,
        attemptNo: source.attemptNo,
        providerId: routeField(source.providerId),
        providerRevision: routeField(source.providerRevision),
      };
      if (identity.providerRouteScope !== 'attempt'
          || !Number.isSafeInteger(routeGeneration) || routeGeneration < 1
          || !identity.runtimeEpoch || !identity.turnId
          || !identity.decisionId || !identity.routeAttemptId || !identity.providerId
          || !Number.isSafeInteger(identity.attemptNo) || identity.attemptNo < 1
          || !identity.providerRevision) return null;
      return identity;
    }

    function sameProviderRoute(left, right) {
      return !!(left && right
        && left.providerRouteScope === right.providerRouteScope
        && left.runtimeEpoch === right.runtimeEpoch
        && left.turnId === right.turnId
        && left.decisionId === right.decisionId
        && left.routeAttemptId === right.routeAttemptId
        && left.routeGeneration === right.routeGeneration
        && left.attemptNo === right.attemptNo
        && left.providerId === right.providerId
        && left.providerRevision === right.providerRevision);
    }

    function acceptProviderRouteEvent(message) {
      if (providerRouteProtocolVersion !== 1) return true;
      if (!message || message.version !== 1) return false;
      const next = providerRouteIdentity(message);
      if (!next) return false;
      if (providerRouteHighWater) {
        if (next.runtimeEpoch !== providerRouteHighWater.runtimeEpoch) return false;
        if (next.routeGeneration < providerRouteHighWater.routeGeneration) return false;
        if (next.routeGeneration === providerRouteHighWater.routeGeneration) {
          if (!sameProviderRoute(next, providerRouteHighWater)) return false;
          if (providerRouteTerminal && !TERMINAL_PROVIDER_ROUTE_PHASES[message.routePhase]) return false;
        }
      }
      if (!providerRouteHighWater || next.routeGeneration > providerRouteHighWater.routeGeneration) {
        providerRouteHighWater = Object.freeze(next);
        providerRouteTerminal = false;
      }
      if (TERMINAL_PROVIDER_ROUTE_PHASES[message.routePhase]) providerRouteTerminal = true;
      activeProviderRoute = providerRouteTerminal ? null : providerRouteHighWater;
      state.providerRouteHighWater = providerRouteHighWater;
      state.activeProviderRoute = activeProviderRoute;
      return true;
    }

    function acceptAttemptOwnedEvent(message) {
      if (providerRouteProtocolVersion !== 1) return true;
      const scope = message.providerRouteScope;
      const routeOwnable = ATTEMPT_OWNED_EVENT_TYPES[message.type] || message.type === 'error';
      if (!routeOwnable) return true;
      if (scope === 'host') return message.type !== 'part_delta' && message.type !== 'stream_event';
      if (scope !== 'attempt') return false;
      return sameProviderRoute(providerRouteIdentity(message), activeProviderRoute);
    }

    function applyProviderRouteModel(message) {
      const route = providerRouteIdentity(message);
      const model = visibleProviderModel(message?.model);
      if (!route) {
        if (message?.model !== undefined) state.activeProviderModel = model;
        return;
      }
      if (!sameProviderRoute(route, activeProviderModelRoute)) {
        activeProviderModelRoute = Object.freeze(route);
        activeProviderModelSource = 'route';
        state.activeProviderModel = model;
      } else if (model && activeProviderModelSource !== 'assistant') {
        state.activeProviderModel = model;
      }
    }

    function applyAssistantProviderModel(message) {
      if (state.sessionProviderSelection?.mode !== 'auto' || providerRouteProtocolVersion !== 1) return;
      const route = providerRouteIdentity(message);
      if (!sameProviderRoute(route, activeProviderRoute)
          || !sameProviderRoute(route, activeProviderModelRoute)) return;
      const model = visibleProviderModel(message?.message?.model);
      if (!model) return;
      activeProviderModelSource = 'assistant';
      if (state.activeProviderModel === model) return;
      state.activeProviderModel = model;
      host.updateProviderBtn?.();
    }

    function debugEvent(message) {
      let summary = message.type;
      if (message.type === 'system') {
        summary += `/${message.subtype || '?'}` + ('is_streaming' in message ? ` is_streaming=${message.is_streaming}` : '');
      } else if (message.type === 'stream_event') summary += `/${message.event?.type || '?'}`;
      else if (message.type === 'assistant') {
        const kinds = (message.message?.content || []).map(block => block.type).join(',');
        if (kinds) summary += ` [${kinds}]`;
      } else if (message.type === 'result') summary += ` cost=${message.total_cost_usd ?? 'null'}`;
      else if (message.type === 'error') summary += ' [redacted]';
      host.debug?.('event', `WS ◀ ${summary}`);
    }

    function finishTurnProgress(kind, key) {
      if (!activeProgressTurnId) return;
      liveUi.pushDanmaku(kind || 'done', tr(key || 'turnProgressDone'), `turn:${activeProgressTurnId}`);
      activeProgressTurnId = null;
    }

    function applySystemInit(message) {
      if (!('is_streaming' in message)) return;
      state.sessionId = message.session_id || message.session || state.sessionId;
      host.refreshNotifyPreference?.();
      if (!host.getSessionName?.() && state.sessionId) host.updateTabIdentity?.(state.sessionId);
      if (message.cwd) host.updateCwdDisplay?.(message.cwd);
      if (message.cli) host.applyCliUi?.(message.cli);
      const parts = [];
      if (state.sessionId) parts.push(`Session: ${state.sessionId.slice(0, 8)}...`);
      if (message.cli) parts.push(message.cli);
      // Auto mode: the session model is only the first candidate's; name the
      // line that actually answered (running route, else the last routed one).
      const initAuto = (message.providerSelection !== undefined
        ? message.providerSelection : state.sessionProviderSelection)?.mode === 'auto';
      const autoLine = initAuto ? (message.providerRoute || message.autoProvider || null) : null;
      const infoModel = visibleProviderModel(autoLine?.model) || message.model;
      if (infoModel) parts.push(infoModel);
      const infoLine = parts.join(' | ');
      if (infoLine && infoLine !== state.lastInitInfoLine) {
        state.lastInitInfoLine = infoLine;
        host.addSystemMsg?.(infoLine);
      }
      if (message.effort !== undefined) {
        state.sessionEffort = message.effort || '';
        state.sessionEffectiveEffort = message.effectiveEffort || state.sessionEffort || 'medium';
      }
      if (message.providerSelection !== undefined) state.sessionProviderSelection = message.providerSelection || null;
      const autoMode = state.sessionProviderSelection?.mode === 'auto';
      if (message.providerId !== undefined) {
        if (autoMode) state.activeProviderId = message.providerRoute ? (message.providerId || '') : (message.autoProvider?.providerId || '');
        else state.sessionProvider = message.providerId || '';
      }
      if (message.providerName !== undefined) {
        if (autoMode) state.activeProviderName = displayProviderName(message.providerRoute ? message.providerName : message.autoProvider?.providerName || '');
        else state.sessionProviderDisplayName = displayProviderName(message.providerName);
      }
      if (autoMode) state.activeProviderModel = visibleProviderModel(message.providerRoute?.model || message.autoProvider?.model);
      if (message.cliStates) state.sessionCliStates = message.cliStates;
      if (message.cliAvailability) state.cliAvailability = message.cliAvailability;
      if (message.agent !== undefined) state.sessionAgent = message.agent || '';
      state.pendingCliHandoff = message.pendingCliHandoff || null;
      if (message.effectiveModel !== undefined) {
        state.sessionEffectiveModel = message.effectiveModel || '';
        if (message.model !== undefined) state.sessionModel = message.model || '';
      }
      if (message.effort !== undefined || message.providerName || message.effectiveModel !== undefined
          || message.providerId !== undefined || message.providerSelection !== undefined
          || message.autoProvider || message.agent !== undefined) {
        host.updateEffortBtn?.();
        host.updateProviderBtn?.();
      }
      if (message.is_streaming && state.pendingCancel) {
        state.pendingCancel = false;
        host.transportSend?.({ type: 'cancel' });
      } else if (message.is_streaming && !state.isStreaming) {
        state.isStreaming = true;
        liveUi.showThinking(tr(ADMISSION_PROGRESS_LABELS.processing));
        host.startTitleAnimation?.();
        host.updateUI?.();
      } else if (!message.is_streaming && state.isStreaming) {
        state.isStreaming = false;
        liveUi.hideThinking();
        finishStreaming();
        host.stopTitleAnimation?.();
        host.addSystemMsg?.('⚠️ Response completed while disconnected. Check history above.');
        host.updateUI?.();
        finishTurnProgress('done', 'turnProgressDone');
      }
      if (message.providerId !== undefined) state.providerId = message.providerId;
      if (message.providerName !== undefined) state.providerName = message.providerName;
      if (message.providerTokenWindows) {
        state.providerTokenWindows = message.providerTokenWindows;
        host.updateContextBar?.();
      }
    }

    function handleResult(message) {
      state.isStreaming = false;
      state.contextTrace = message.contextTrace && typeof message.contextTrace === 'object'
        ? message.contextTrace
        : null;
      const resultBubble = state.currentMsgEl;
      // finishStreaming() clears the tool-card registry, so snapshot the
      // measured spans first — the trajectory strip is the turn's tool timing
      // made visible, and it only exists for live turns (replay has no stamps).
      settleThinkingCards();
      const trajTools = Array.from(state.currentToolCards.values())
        .map(t => ({ name: t.name, startedAt: t.startedAt, endedAt: t.endedAt, isError: t.isError }));
      finishStreaming();
      if (message.usage || state.roleTokens.main) liveUi.attachUsageLine(resultBubble, message.usage, state.roleTokens);
      if (resultBubble) {
        const content = resultBubble.querySelector('.msg-content');
        if (content && !content.querySelector('.msg-timing')) {
          const duration = Number.isFinite(message.durationMs)
            ? message.durationMs : (state.turnStartMs ? Date.now() - state.turnStartMs : NaN);
          const timing = liveUi.buildTimingLine({ role: 'assistant', ts: Date.now(), durationMs: duration });
          if (timing) content.appendChild(timing);
        }
        if (content) historyView.renderToolTrajectory?.(content, trajTools,
          Number.isFinite(message.durationMs)
            ? message.durationMs
            : (state.turnStartMs ? Date.now() - state.turnStartMs : undefined));
        // 归属行是这条消息的页脚最后一行：result 里的字段和随后落库的同名字段出自
        // 服务端同一次计算，所以流式中的气泡与刷新后的历史逐字一致。
        if (content && message.modelAttribution) {
          liveUi.attachModelAttribution?.(resultBubble, message.modelAttribution);
        }
      }
      state.turnStartMs = 0;
      host.stopTitleAnimation?.();
      // total_cost_usd is deliberately dropped: the CLI prices every turn with
      // Anthropic's table even when the request was routed elsewhere, so it is
      // not this session's cost and nothing here can make it into one.
      const durationText = Number.isFinite(message.durationMs)
        ? liveUi.fmtDuration(message.durationMs)
        : (message.duration_ms ? `${message.duration_ms}ms` : '');
      if (durationText || message.num_turns) {
        state.turnMeta = { durationText, turns: message.num_turns || 0 };
      }
      if (message.usage) {
        state.sessionTokens.input += message.usage.input_tokens || 0;
        state.sessionTokens.output += message.usage.output_tokens || 0;
      }
      host.updateContextBar?.(message.usage, message.modelUsage);
      host.updateUI?.();
      finishTurnProgress('done', 'turnProgressCompleted');
    }

    function handleHistoryReset(message) {
      host.resetHistoryPagination?.();
      historyView.clearMessages();
      const plan = historyStore.acceptHistory({
        messages: Array.isArray(message.messages) ? message.messages : [],
        hasMore: message.hasMore === true,
      }, []);
      host.applyHistoryPlan?.(plan);
      if ((Number(message.keep) || 0) > 0) {
        if ((Number(message.removedCount) || 0) > 0) {
          host.addSystemMsg?.(host.translate('contextKept', {
            removed: Number(message.removedCount) || 0,
            kept: Number(message.retainedCount) || 0,
          }));
        } else host.addSystemMsg?.(host.translate('contextResetKept'));
      } else host.addSystemMsg?.(host.translate('contextCleared'));
    }

    function handleCommittedMessage(event) {
      const committed = event && event.message;
      // A user message that settles a wait_for_user_answer prompt carries the
      // prompt's requestId as answeredQuestionId. Treat it as a card-teardown
      // signal — the message-carried backup for the user_input_resolved event,
      // so a window that missed the event (or a fresh tab) still closes the card
      // when the answer message reaches it. consumeUserInputRequestId is
      // idempotent, so the answering window's own copy is a harmless no-op.
      if (committed && committed.answeredQuestionId) {
        host.consumeUserInputRequestId?.(committed.answeredQuestionId);
      }
      if (committed && committed.id && committed.role && typeof historyView.commitMessage === 'function') {
        const result = historyView.commitMessage(committed, {
          currentElement: state.currentMsgEl,
          lastUserElement: state.lastUserBubble,
          currentText: state.currentTextContent,
        });
        state.currentMsgEl = result.currentElement;
        state.lastUserBubble = result.lastUserElement;
        host.maybeScrollToBottom?.();
        return;
      }
      if (event.id && event.role) {
        historyView.tagLatestMessage(event.role, event.id, event.clientMsgId, event);
      }
    }

    function handleEvent(message, expectedGeneration) {
      if (!message || !isOwned(expectedGeneration)) return false;
      if (message.type === 'system' && message.subtype === 'init'
          && message.providerRouteProtocolVersion === 1) {
        providerRouteProtocolVersion = 1;
        state.providerRouteProtocolVersion = 1;
        const reconnectRoute = providerRouteIdentity(message.providerRoute || message);
        if (reconnectRoute) {
          providerRouteHighWater = Object.freeze(reconnectRoute);
          activeProviderRoute = providerRouteHighWater;
          activeProviderModelRoute = providerRouteHighWater;
          activeProviderModelSource = 'route';
          providerRouteTerminal = false;
          state.providerRouteHighWater = providerRouteHighWater;
          state.activeProviderRoute = activeProviderRoute;
        }
      }
      if (message.type === 'provider_route_event') {
        if (!acceptProviderRouteEvent(message)) return false;
      } else if (!acceptAttemptOwnedEvent(message)) return false;
      debugEvent(message);
      switch (message.type) {
        case 'provider_route_event':
          if (message.providerId) state.activeProviderId = message.providerId;
          if (message.providerName) state.activeProviderName = displayProviderName(message.providerName);
          applyProviderRouteModel(message);
          host.updateProviderBtn?.();
          break;
        case 'provider_auto_route': {
          // Policy selection is only a reservation. The attempt-owned route
          // event above is the authority that a physical provider actually began;
          // this only narrates the difficulty verdict behind the reservation.
          if (message.routePhase !== 'selected' || !message.routing) break;
          const pendingNote = autoRouteNoteEl && autoRouteNoteEl.isConnected ? autoRouteNoteEl : null;
          autoRouteNoteEl = null;
          // Turns nobody asked Jev about (continuations, nudges) stay silent.
          if (!pendingNote && message.routing.code === 'jev_not_prepared') break;
          const note = formatAutoRouteNote(message, host.translate);
          if (!note) { pendingNote?.remove?.(); break; }
          const noteEl = pendingNote || host.addSystemMsg?.(note);
          if (pendingNote) pendingNote.textContent = note;
          // Same key as the persisted history record, so a replay adopts this line.
          if (noteEl?.dataset && message.noteClientMsgId) noteEl.dataset.clientMsgId = message.noteClientMsgId;
          break;
        }
        case 'system':
          if (message.subtype === 'init') applySystemInit(message);
          else if (message.subtype === 'cli_handoff_applied' && message.fromCli && message.toCli) {
            // The server cannot know this page's language, so it sends the lane
            // pair and the reason and lets us write the sentence. `message.message`
            // stays the fallback: history persisted before these fields existed
            // only carries that string.
            host.addSystemMsg?.(tr(
              ['history_clear_keep', 'manual_native_context_rotate', 'auto_native_context_rotate'].includes(message.reason)
                ? 'cliHandoffAppliedCheckpoint'
                : 'cliHandoffAppliedTransfer',
              { from: message.fromCli, to: message.toCli },
            ));
          } else if (message.subtype === 'agent_notes' && Array.isArray(message.notes)) host.addAgentNotes?.(message.notes);
          else if (message.message) {
            const handled = !!(message.authAction && typeof host.addAuthActionMsg === 'function'
              && host.addAuthActionMsg(message.message, message.authAction) === true);
            if (!handled) host.addSystemMsg?.(message.message);
          }
          break;
        case 'session_id':
          if (message.id) {
            state.sessionId = message.id;
            host.refreshNotifyPreference?.();
            if (!host.getSessionName?.()) host.updateTabIdentity?.(message.id);
          }
          break;
        case 'session_configuration_pending':
        case 'session_configuration_applied':
          host.loadSessionModel?.();
          break;
        case 'cli_switched':
          host.applyCliSwitchState?.(message);
          // Same keys the App renders (chat_provider.dart) — one wording, two
          // clients. The lane labels themselves are catalog data, not text.
          host.addSystemMsg?.('⇄ ' + tr('cliSwitched', {
            from: host.cliMeta?.[message.fromCli]?.label || message.fromCli,
            to: host.cliMeta?.[message.cli]?.label || message.cli,
            resumed: message.reusedTarget ? tr('cliSessionResumedSuffix') : '',
          }));
          host.loadSessionModel?.();
          break;
        case 'stream_event': handleStreamEvent(message.event, expectedGeneration); break;
        case 'assistant':
          applyAssistantProviderModel(message);
          finalizeAssistantMsg(message.message);
          break;
      case 'part_delta': handlePartDelta(message); break;
        case 'user':
          if (message.tool_use_result || message.message?.content) handleToolResult(message);
          break;
        case 'result': handleResult(message); break;
        case 'provider_token_stats':
          if (message.windows) { state.providerTokenWindows = message.windows; host.updateContextBar?.(); }
          break;
        case 'role_token_stats':
          if (message.role) {
            state.roleTokens = {
              main: message.role.main || null,
              sub: message.role.sub || null,
              subByProvider: message.role.subByProvider || [],
              mainByProvider: message.role.mainByProvider || [],
            };
            if (state.currentMsgEl && state.isStreaming) {
              liveUi.attachUsageLine(state.currentMsgEl, null, state.roleTokens);
            }
            host.updateContextBar?.();
          }
          break;
        case 'monitor_started':
          if (message.background !== false) liveUi.pushDanmaku('start', message.description || message.command || tr('backgroundTaskUnnamed'), message.task_id);
          break;
        case 'monitor_done':
          if (message.background !== false) {
            // Interrupted (restart killed the process, reap, or the
            // post-restart journal replay) is not success and not failure —
            // render it as the neutral historical state, never a spinner.
            liveUi.pushDanmaku(
              message.status === 'error' || message.status === 'failed' ? 'fail'
                : message.status === 'interrupted' ? 'stale' : 'done',
              message.summary || message.description || tr('backgroundTaskUnnamed'), message.task_id,
            );
          }
          break;
        case 'monitor_progress':
          if (message.background !== false) {
            liveUi.pushDanmaku('progress', message.description || tr('backgroundTaskStillRunning'), message.task_id);
          }
          break;
        case 'progress_heartbeat':
          activeProgressTurnId = String(message.turnId || 'active');
          liveUi.pushDanmaku('progress', formatProgressHeartbeat(message, host.translate), `turn:${activeProgressTurnId}`);
          break;
        case 'background_tasks':
          liveUi.reconcileDanmakuTasks?.((message.tasks || []).map(t => t && (t.id || t.task_id)).filter(Boolean));
          break;
        case 'chat_msg_meta':
          handleCommittedMessage(message);
          break;
        case 'chat_msg_deleted':
          if (message.id) host.removeHistoryMessageById?.(message.id);
          break;
        case 'chat_history':
          host.applyHistoryPlan?.(historyStore.acceptHistory(message, historyView.visibleIds()));
          break;
        case 'chat_history_reset': handleHistoryReset(message); break;
        // A turn's task attribution is decided when the turn ends, which is
        // after its bubbles are already on screen. Patch those bubbles rather
        // than reload the page: the quote action reads the attribution off the
        // DOM, and a re-render would drop the live tail mid-answer.
        case 'chat_history_annotation':
          historyView.annotateAttribution?.(message.messages);
          break;
        case 'native_context_rotated':
          host.addSystemMsg?.(message.reused
            ? host.translate?.('rotateNativeContextReused')
            : host.translate?.('rotateNativeContextDone'));
          host.showNotifyToast?.(
            message.reused
              ? host.translate?.('rotateNativeContextReused')
              : host.translate?.('rotateNativeContextDone'),
            'completed',
          );
          break;
        case 'native_context_rotation_rejected':
          host.showNotifyToast?.(
            message.code === 'background_tasks_running'
              ? host.translate?.('rotateNativeContextBackgroundBusy')
              : host.translate?.('rotateNativeContextBusy'),
            'waiting',
          );
          break;
        case 'task_state':
          liveUi.renderAuxClassify(message.goal, message.phase, message.classifyState, message.taskShortCode, {
            auxUnhealthy: message.auxUnhealthy, auxUnhealthySince: message.auxUnhealthySince,
            goalState: message.goalState || null,
          });
          break;
        // Aux health flipped while this page was open. The judgement on the bar
        // is the one Aux stopped revising, so the bar has to be repainted — no
        // further task_state is coming for this session.
        case 'aux_verdict_staleness':
          liveUi.applyAuxVerdictStaleness?.(message);
          break;
        case 'user_input_required':
          state.pendingUserInputRequestId = message.requestId || null;
          if (host.renderPendingUserInput?.(message) !== true) {
            host.addSystemMsg?.([
              tr('pendingInputNeedsConfirm') + (message.question || tr('pendingInputFallback')),
              Array.isArray(message.options) && message.options.length
                ? message.options.map((option, index) => `${index + 1}. ${option}`).join('\n')
                : '',
            ].filter(Boolean).join('\n'));
          }
          break;
        case 'user_input_resolved':
          // Another window (or this one) consumed the wait_user prompt. Tear the
          // card down everywhere — consumeUserInputRequestId is idempotent, so the
          // answering window's own copy is a harmless no-op.
          host.consumeUserInputRequestId?.(message.requestId);
          break;
        case 'message_admission_progress': {
          const clientMsgId = typeof message.clientMsgId === 'string' ? message.clientMsgId.trim() : '';
          const text = typeof message.message === 'string' ? message.message : '';
          if (clientMsgId) pendingAdmissionIds.add(clientMsgId);
          if (clientMsgId && text && !historyView.findByClientMsgId?.(clientMsgId)) {
            host.addUserMessage?.(text, clientMsgId);
          }
          if (message.stage === 'auto_provider_routing' && message.state === 'waiting') {
            // Behind a live turn the message only queues; its verdict line lands
            // when its own turn starts instead of inside the running answer.
            if (!state.isStreaming && !(autoRouteNoteEl && autoRouteNoteEl.isConnected)) {
              autoRouteNoteEl = host.addSystemMsg?.(host.translate?.('autoRouteJudging')) || null;
            }
            if (!state.isStreaming) liveUi.showThinking(host.translate?.('autoRouteJudging'));
            break;
          }
          if (message.state === 'failed') {
            autoRouteNoteEl?.remove?.();
            autoRouteNoteEl = null;
            if (clientMsgId) pendingAdmissionIds.delete(clientMsgId);
            if (!state.isStreaming) {
              if (pendingAdmissionIds.size) liveUi.showThinking(tr(ADMISSION_PROGRESS_LABELS.waiting));
              else liveUi.hideThinking();
            }
            const detail = admissionDetail(message.rootCause) || admissionDetail(message.code);
            host.addSystemMsg?.(detail
              ? tr('admissionDeliveryFailedWithCause', { cause: detail })
              : tr('admissionDeliveryFailed'));
            host.showNotifyToast?.(tr('admissionDeliveryFailedToast'), 'error');
            break;
          }
          const baseLabel = message.state === 'skipped'
            ? ADMISSION_PROGRESS_LABELS[message.reason] || ADMISSION_PROGRESS_LABELS.memory_distill_skipped
            : ADMISSION_PROGRESS_LABELS[message.state] || ADMISSION_PROGRESS_LABELS.waiting;
          const rootCause = message.reason === 'memory_distill_failed'
            ? admissionDetail(message.rootCause)
            : '';
          const label = rootCause
            ? tr('admissionMemoryFailedWithCause', { cause: rootCause })
            : tr(baseLabel);
          if (message.state === 'skipped' && message.reason === 'memory_distill_failed') {
            host.showNotifyToast?.(label, 'running');
            host.addSystemMsg?.(label);
          }
          if (!state.isStreaming) liveUi.showThinking(label);
          break;
        }
        case 'session_queue': {
          const items = Array.isArray(message.items) ? message.items : [];
          // A claimed message has left `items` and its transcript record only
          // appears when the turn starts. Until then the snapshot's `active`
          // carries the sender's text, so any reload/reconnect can re-render
          // the user bubble the optimistic send copy lost.
          const activeInput = message.active && !message.active.startedAt
            && typeof message.active.clientMsgId === 'string'
            && message.active.clientMsgId.trim()
            && typeof message.active.text === 'string'
            && message.active.text
            ? message.active : null;
          if (activeInput && !historyView.findByClientMsgId?.(activeInput.clientMsgId)) {
            host.addUserMessage?.(activeInput.text, activeInput.clientMsgId);
          }
          const visibleItems = message.event === 'queued' && message.queued === false
            ? items.filter(item => item?.entryId !== message.entryId)
            : items;
          // Insert user bubble now if queued=false (immediate). A queued=true
          // message stays off-screen until its turn runs (the queued entry is
          // visible in the queue strip below); the old stagedUserBubbles side
          // map had no reader and grew unboundedly (M6) - nothing is staged.
          if (message.event === 'queued') {
            const text = message.message;
            const clientMsgId = message.clientMsgId;
            if (message.queued === false && text && clientMsgId) {
              if (!historyView.findByClientMsgId?.(clientMsgId)) host.addUserMessage?.(text, clientMsgId);
            }
            if (clientMsgId && pendingAdmissionIds.delete(clientMsgId) && !state.isStreaming) {
              if (message.queued === false) liveUi.showThinking(tr(ADMISSION_PROGRESS_LABELS.starting));
              else if (pendingAdmissionIds.size === 0) liveUi.hideThinking();
            }
          }
          host.renderSessionQueue?.(
            visibleItems,
            {
              state: message.state,
              freezeReason: message.freezeReason || null,
            },
          );
          if (message.event === 'queued' && message.queued !== false) {
            host.showNotifyToast?.(
              message.queuePosition
                ? tr('queuedMessagePosition', { n: message.queuePosition })
                : tr('queuedMessagePersisted'),
              'running',
            );
          } else if (message.event === 'frozen') {
            host.addSystemMsg?.(tr('sessionQueueFrozen', {
              reason: message.freezeReason || tr('sessionQueueFrozenDefault'),
            }));
          } else if (message.event === 'started') {
            host.showNotifyToast?.(tr('sessionQueueHeadStarted'), 'running');
          }
          break;
        }
        case 'api_error_policy': {
          // Structured upstream error state from the centralized policy — the
          // same event the App renders via ApiErrorPolicyState. The bar is
          // turn-scoped: the next stream_start clears it, and a failed retry
          // re-shows it with the fresh decision.
          liveUi.renderApiError?.(message);
          break;
        }
        case 'rate_limit_event': {
          const limit = global.MultiCCChatRateLimit?.consumeRateLimitEvent(
            message.rate_limit_info,
            host.getSessionName?.(),
            message.bar,
          );
          if (limit) {
            state.claudeFiveHourRateLimit = limit;
          }
          break;
        }
        case 'usage_balance_event': {
          global.MultiCCChatRateLimit?.consumeBalanceEvent(
            message.balance_info,
            host.getSessionName?.(),
            message.bar,
          );
          break;
        }
        case 'stream_start':
          // Server-broadcast turn begin (all CLIs; adapter CLIs like opencode
          // have no native message_start, so without this their isStreaming
          // stayed false all turn and isStreaming-gated guards misfired).
          // A new turn supersedes any stale upstream-error bar; if the turn
          // fails again a fresh api_error_policy event re-shows it.
          liveUi.clearApiError?.();
          pendingAdmissionIds.clear();
          state.isStreaming = true;
          state.lastFinishedText = '';
          liveUi.showThinking(tr(ADMISSION_PROGRESS_LABELS.processing));
          host.startTitleAnimation?.();
          host.updateUI?.();
          break;
        case 'stream_end':
          if (state.isStreaming) {
            state.isStreaming = false;
            finishStreaming();
            host.stopTitleAnimation?.();
            host.updateUI?.();
          }
          liveUi.settleTurnScopedDanmaku?.();
          finishTurnProgress('done', 'turnProgressDone');
          // Refresh OpenCode Go quota after every turn end (debounced 60s
          // inside refreshOpenCodeQuota on error, no-op under non-opencode CLIs).
          // Skip when streaming was cancelled (pendingCancel) to avoid spurious
          // fetches right after the user aborts a turn.
          if (!state.pendingCancel) {
            global.MultiCCChatRateLimit?.refreshOpenCodeQuota?.();
            global.MultiCCChatRateLimit?.refreshQoderQuota?.();
            global.MultiCCChatRateLimit?.refreshCodexQuota?.();
            global.MultiCCChatRateLimit?.refreshArkQuota?.();
            global.MultiCCChatRateLimit?.refreshKimiQuota?.();
          }
          break;
        case 'notify': {
          // A frame carries the classify LETTER when the server had one; the
          // coarse state (succeeded/waiting/error) otherwise. Both resolve
          // through the shared copy table (liveUi.classifyDisplay), so a
          // letter-less frame speaks exactly what the bar shows — no second,
          // hand-written fallback that drifts from it. C is retired (the parser
          // collapses it to W) and P is mid-turn: neither has anything to
          // announce, and the table is what says so (`voice === null`).
          const classifyState = message.classifyState || null;
          const display = liveUi.classifyDisplay(classifyState || message.state);
          if (message.state === 'running' || !display.voice) {
            host.showNotifyToast?.(message.message || tr('taskInProgress'), 'running');
            break;
          }
          const completionVoice = classifyState === 'D'
            ? taskAwareCompletionVoice(message, display.voice) : '';
          host.speakNotify?.(completionVoice || display.voice, display.ding);
          break;
        }
        case 'error':
          if (isRecoverableCodexReconnectErrorText(message.error || '')) {
            host.warn?.('[multicc/chat] suppressed recoverable codex reconnect');
            break;
          }
          // A refusal that carries its own reason is shown as prose: the bare
          // code tells the person waiting to send nothing they can act on.
          host.addSystemMsg?.(`Error: ${message.error === 'task_switching'
            ? host.translate?.('taskSwitchingRefused') || message.error
            : (message.error || 'Unknown chat error')}`);
          state.isStreaming = false;
          finishStreaming();
          host.stopTitleAnimation?.();
          host.updateUI?.();
          liveUi.settleTurnScopedDanmaku?.();
          finishTurnProgress('fail', 'turnProgressFailed');
          break;
        default: break;
      }
      return true;
    }

    function createAssistantBubble() {
      const bubble = historyView.createAssistantBubble(true);
      host.maybeScrollToBottom?.();
      return bubble;
    }

    function handleStreamEvent(event, expectedGeneration) {
      if (!event || !isOwned(expectedGeneration)) return false;
      switch (event.type) {
        case 'message_start':
          state.isStreaming = true;
          state.lastFinishedText = '';
          liveUi.hideThinking();
          if (!state.currentMsgEl) state.currentMsgEl = createAssistantBubble();
          else if (state.currentTextContent && !state.currentTextContent.endsWith('\n\n')) state.currentTextContent += '\n\n';
          host.startTitleAnimation?.();
          host.updateUI?.();
          if (event.message?.usage) {
            // One request's own prompt accounting — the exact context size.
            host.noteRequestUsage?.(event.message.usage);
            state.liveStreamUsage = liveUi.accumulateLiveUsage(event.message.usage, state.liveStreamUsage);
            liveUi.attachUsageLine(state.currentMsgEl, null, state.roleTokens.main
              ? state.roleTokens : { main: state.liveStreamUsage, sub: null, subByProvider: [] });
          }
          break;
        case 'content_block_start':
          state.activeContentIndex = event.index;
          if (event.content_block?.type === 'text') state.activeContentType = 'text';
          else if (event.content_block?.type === 'tool_use') {
            state.activeContentType = 'tool_use';
            // Out-of-order/replayed frames can deliver tool_use before
            // message_start created the bubble - without this the querySelector
            // below is a TypeError that kills the whole event switch.
            if (!state.currentMsgEl) state.currentMsgEl = createAssistantBubble();
            const card = historyView.createToolCard(event.content_block.name, event.content_block.id);
            state.currentToolCards.set(event.index, {
              card, inputJson: '', name: event.content_block.name, id: event.content_block.id,
              startedAt: Date.now(),
            });
            historyView.appendToolCard(state.currentMsgEl.querySelector('.msg-content'), card);
          }
          break;
        case 'content_block_delta':
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            state.currentTextContent += event.delta.text;
            host.renderCurrentText?.();
            host.maybeScrollToBottom?.();
          } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            const tool = state.currentToolCards.get(event.index);
            if (tool) { tool.inputJson += event.delta.partial_json; historyView.updateToolInput(tool); }
          }
          break;
        case 'content_block_stop':
          state.activeContentType = null;
          state.activeContentIndex = -1;
          break;
        case 'message_delta':
          if (event.usage) {
            host.updateContextBar?.(event.usage);
            state.liveStreamUsage = liveUi.accumulateLiveUsage(event.usage, state.liveStreamUsage);
            if (state.currentMsgEl) {
              liveUi.attachUsageLine(state.currentMsgEl, null, state.roleTokens.main
                ? state.roleTokens : { main: state.liveStreamUsage, sub: null, subByProvider: [] });
            }
          }
          break;
        case 'message_stop': break;
        default: break;
      }
      return true;
    }

    function handleToolResult(message) {
      const content = message.message?.content;
      if (!content) return;
      // A tool result means the model finished reasoning and acted: close the
      // open Thinking span before the cards are read for the trajectory.
      settleThinkingCards();
      for (const result of (Array.isArray(content) ? content : [content])) {
        if (result.type !== 'tool_result') continue;
        for (const tool of state.currentToolCards.values()) {
          if (tool.id !== result.tool_use_id) continue;
          const text = typeof result.content === 'string' ? result.content
            : Array.isArray(result.content)
              ? result.content.map(item => item.text || '').join('')
              : JSON.stringify(result.content);
          tool.endedAt = Date.now();
          tool.isError = !!result.is_error;
          historyView.addToolResult(tool, text, result.is_error);
          break;
        }
      }
      host.maybeScrollToBottom?.();
    }

    function findCurrentToolCardById(id) {
      for (const tool of state.currentToolCards.values()) if (tool.id === id) return tool;
      return null;
    }

    function finalizeAssistantMsg(message) {      if (!message?.content) return;
      liveUi.hideThinking();
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          if (!state.currentMsgEl) {
            // Late/replayed full snapshot arriving after the turn finalized:
            // the just-finished bubble already shows this exact text, so a
            // fresh bubble here would render the reply twice (live-only
            // duplicate; history stays clean).
            if (message.textSnapshot === true && !state.isStreaming
                && state.lastFinishedText && block.text === state.lastFinishedText) continue;
            state.currentMsgEl = createAssistantBubble();
          }
          if (message.textSnapshot === true) state.currentTextContent = block.text;
          else if (isCodexCli(state.currentCli)) {
            // A duplicated WS frame appends the same block twice; codex blocks
            // are complete items, so an exact repeat of a long block at the
            // current tail is a replay artifact, not new content.
            if (block.text.length >= 16
                && (state.currentTextContent || '').endsWith(block.text)) continue;
            state.currentTextContent += block.text;
          }
          else if (!state.currentTextContent) state.currentTextContent = block.text;
          host.renderCurrentText?.();
          host.maybeScrollToBottom?.();
        } else if (isCodexCli(state.currentCli) && block.type === 'tool_use' && block.id) {
          if (!state.currentMsgEl) state.currentMsgEl = createAssistantBubble();
          let tool = findCurrentToolCardById(block.id);
          if (!tool) {
            const card = historyView.createToolCard(block.name || 'Tool', block.id);
            tool = {
              card, inputJson: block.input ? JSON.stringify(block.input) : '',
              name: block.name || 'Tool', id: block.id,
              // Codex/opencode tools skip content_block_start, so this creation
              // site is their startedAt — the paired tool_result stamps endedAt.
              startedAt: Date.now(),
            };
            state.currentToolCards.set(`id:${block.id}`, tool);
            historyView.appendToolCard(state.currentMsgEl.querySelector('.msg-content'), card);
          } else if (block.input) tool.inputJson = JSON.stringify(block.input);
          historyView.updateToolInput(tool);
          host.maybeScrollToBottom?.();
        }
      }
    }

    // Token-level delta sidecar from the provider proxy (see server.js onDelta).
    // Claude already emits the same text/tool deltas through native stream-json,
    // so consuming this sidecar too would render every fragment twice. Codex and
    // OpenCode use the sidecar to render upstream deltas incrementally —
    // text streams token-by-token, reasoning shows live, tools update as they
    // run — instead of everything appearing at once at item.completed. This
    // mirrors opencode's part-stream model. Deltas are pure UX; the authoritative
    // blocks still arrive via finalizeAssistantMsg, which will overwrite/complete
    // whatever these deltas previewed.
    // Reasoning is a measured span like any tool: startedAt at the first
    // reasoning delta, endedAt the moment reasoning stops — the next text/tool
    // delta, a tool result, or the turn's result. Without the end stamp the
    // Thinking segment could never enter the wall-clock trajectory, so think
    // time was missing from every live strip.
    function settleThinkingCards() {
      const at = Date.now();
      for (const tool of state.currentToolCards.values()) {
        if (tool && tool.name === 'Thinking' && tool.startedAt && !tool.endedAt) tool.endedAt = at;
      }
    }

    function handlePartDelta(message) {
      if (state.currentCli === 'claude') return;
      const d = message && message.delta;
      if (!d) return;
      if (!state.currentMsgEl) state.currentMsgEl = createAssistantBubble();
      liveUi.hideThinking?.();
      if (d.type === 'text' && d.text) {
        settleThinkingCards();
        state.currentTextContent = (state.currentTextContent || '') + d.text;
        host.renderCurrentText?.();
        host.maybeScrollToBottom?.();
      } else if (d.type === 'reasoning' && d.text) {
        // Reasoning streams into a dedicated "Thinking" tool card keyed by a
        // stable sidecar id, accumulating verbatim — readable live, not as JSON.
        const rid = `sidecar-reasoning-${message.sessionId || ''}`;
        let tool = state.currentToolCards.get(`id:${rid}`);
        if (!tool) {
          const card = historyView.createToolCard('Thinking', rid);
          tool = { card, inputJson: '{}', name: 'Thinking', id: rid, reasoning: '', startedAt: Date.now() };
          state.currentToolCards.set(`id:${rid}`, tool);
          historyView.appendToolCard(state.currentMsgEl.querySelector('.msg-content'), card);
        }
        tool.reasoning = (tool.reasoning || '') + d.text;
        tool.inputJson = JSON.stringify({ text: tool.reasoning });
        historyView.updateToolInput(tool);
        host.maybeScrollToBottom?.();
      } else if (d.type === 'tool' && d.tool && d.toolId) {
        settleThinkingCards();
        let tool = findCurrentToolCardById(d.toolId);
        if (!tool) {
          const card = historyView.createToolCard(d.tool.name || 'Tool', d.toolId);
          tool = { card, inputJson: '{}', name: d.tool.name || 'Tool', id: d.toolId, args: '', startedAt: Date.now() };
          state.currentToolCards.set(`id:${d.toolId}`, tool);
          historyView.appendToolCard(state.currentMsgEl.querySelector('.msg-content'), card);
        }
        // Tool arguments arrive in fragments (like codex function_call_arguments);
        // accumulate and surface what's parsed so far.
        tool.args = (tool.args || '') + (d.tool.arguments || '');
        try { tool.inputJson = JSON.stringify(JSON.parse(tool.args)); }
        catch (_) { tool.inputJson = JSON.stringify({ arguments: tool.args }); }
        historyView.updateToolInput(tool);
        host.maybeScrollToBottom?.();
      }
    }

    function finishStreaming() {
      liveUi.hideThinking();
      state.liveStreamUsage = null;
      if (state.currentMsgEl) {
        state.currentMsgEl.querySelector('.streaming-dot')?.classList.remove('streaming-dot');
        try { host.renderCurrentText?.(true); }
        catch (error) {
          host.warn?.('Failed to render final assistant text');
          host.debug?.('event', 'render final failed [redacted]');
        }
      }
      // Remember what the finalized bubble shows so a late/replayed snapshot of
      // this same text can be recognized as a duplicate instead of opening a
      // second bubble (cleared when the next turn starts streaming).
      state.lastFinishedText = state.currentTextContent || state.lastFinishedText || '';
      state.currentMsgEl = null;
      state.currentTextContent = '';
      state.currentToolCards = new Map();
      host.rearmUnread?.();
      host.maybeScrollToBottom?.();
    }

    return Object.freeze({
      beginGeneration,
      invalidateGeneration,
      dropStaleUserInput,
      currentGeneration: () => generation,
      handleEvent,
      handleStreamEvent,
      handleToolResult,
      finalizeAssistantMsg,
      finishStreaming,
    });
  }

  const api = Object.freeze({
    createEventController,
    isRecoverableCodexReconnectErrorText,
    formatAutoRouteNote,
    formatProgressHeartbeat,
    taskAwareCompletionVoice,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatEventController = api;
})(typeof window !== 'undefined' ? window : globalThis);
