(function attachMultiCCChatEventController(global) {
  'use strict';

  function isRecoverableCodexReconnectErrorText(text) {
    const value = String(text || '');
    return /^Codex 出错：Reconnecting\.\.\.\s*\d+\/\d+\s*\(/i.test(value)
      && /stream disconnected before completion|response\.completed/i.test(value);
  }

  const PROGRESS_PHASES = Object.freeze({
    starting: '正在启动',
    thinking: '正在处理',
    tool: '正在调用工具',
    recovering: '正在恢复连接',
    finalizing: '正在收尾',
  });
  const PROGRESS_TOOLS = Object.freeze({
    subagent: '子 Agent',
    monitor: '后台监控',
    process: '命令执行',
    filesystem: '文件操作',
    search: '代码检索',
    network: '网络请求',
  });

  function formatProgressHeartbeat(message) {
    const source = message && typeof message === 'object' ? message : {};
    const phase = PROGRESS_PHASES[source.phase] || '仍在执行';
    const elapsedSeconds = Math.max(0, Math.floor((Number(source.elapsedMs) || 0) / 1000));
    const elapsed = elapsedSeconds >= 60
      ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
      : `${elapsedSeconds}s`;
    const tool = PROGRESS_TOOLS[source.toolKind];
    return [phase, elapsed, tool].filter(Boolean).join(' · ');
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

    function beginGeneration() { generation += 1; return generation; }
    function invalidateGeneration() { generation += 1; return generation; }
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

    function finishTurnProgress(kind, text) {
      if (!activeProgressTurnId) return;
      liveUi.pushDanmaku(kind || 'done', text || '本轮已结束', `turn:${activeProgressTurnId}`);
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
      if (message.model) parts.push(message.model);
      const infoLine = parts.join(' | ');
      if (infoLine && infoLine !== state.lastInitInfoLine) {
        state.lastInitInfoLine = infoLine;
        host.addSystemMsg?.(infoLine);
      }
      if (message.effort !== undefined) {
        state.sessionEffort = message.effort || '';
        state.sessionEffectiveEffort = message.effectiveEffort || state.sessionEffort || 'medium';
      }
      if (message.providerId !== undefined) state.sessionProvider = message.providerId || '';
      if (message.providerName !== undefined) state.sessionProviderDisplayName = message.providerName || '';
      if (message.cliStates) state.sessionCliStates = message.cliStates;
      if (message.cliAvailability) state.cliAvailability = message.cliAvailability;
      if (message.agent !== undefined) state.sessionAgent = message.agent || '';
      state.pendingCliHandoff = message.pendingCliHandoff || null;
      if (message.effectiveModel !== undefined) {
        state.sessionEffectiveModel = message.effectiveModel || '';
        if (message.model !== undefined) state.sessionModel = message.model || '';
      }
      if (message.effort !== undefined || message.providerName || message.effectiveModel !== undefined
          || message.providerId !== undefined || message.agent !== undefined) {
        host.updateEffortBtn?.();
        host.updateModelBtn?.();
      }
      if (message.is_streaming && state.pendingCancel) {
        state.pendingCancel = false;
        host.transportSend?.({ type: 'cancel' });
      } else if (message.is_streaming && !state.isStreaming) {
        state.isStreaming = true;
        liveUi.showThinking();
        host.startTitleAnimation?.();
        host.updateUI?.();
      } else if (!message.is_streaming && state.isStreaming) {
        state.isStreaming = false;
        liveUi.hideThinking();
        finishStreaming();
        host.stopTitleAnimation?.();
        host.addSystemMsg?.('⚠️ Response completed while disconnected. Check history above.');
        host.updateUI?.();
        finishTurnProgress('done', '本轮已结束');
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
      const resultBubble = state.currentMsgEl;
      // finishStreaming() clears the tool-card registry, so snapshot the
      // measured spans first — the trajectory strip is the turn's tool timing
      // made visible, and it only exists for live turns (replay has no stamps).
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
        if (content) historyView.renderToolTrajectory?.(content, trajTools);
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
      host.autoCommitIfNeeded?.(state.lastUserBubble);
      finishTurnProgress('done', '本轮已完成');
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
        historyView.tagLatestMessage(event.role, event.id, event.clientMsgId);
      }
    }

    function handleEvent(message, expectedGeneration) {
      if (!message || !isOwned(expectedGeneration)) return false;
      debugEvent(message);
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') applySystemInit(message);
          else if (message.subtype === 'agent_notes' && Array.isArray(message.notes)) host.addAgentNotes?.(message.notes);
          else if (message.message) host.addSystemMsg?.(message.message);
          break;
        case 'session_id':
          if (message.id) {
            state.sessionId = message.id;
            host.refreshNotifyPreference?.();
            if (!host.getSessionName?.()) host.updateTabIdentity?.(message.id);
          }
          break;
        case 'cli_switched':
          host.applyCliSwitchState?.(message);
          host.addSystemMsg?.(`⇄ CLI 已从 ${host.cliMeta?.[message.fromCli]?.label || message.fromCli} 切换到 ${host.cliMeta?.[message.cli]?.label || message.cli}；下一条消息会携带结构化上下文交接${message.reusedTarget ? '并恢复该 CLI 原会话' : ''}`);
          host.loadSessionModel?.();
          break;
        case 'stream_event': handleStreamEvent(message.event, expectedGeneration); break;
        case 'assistant': finalizeAssistantMsg(message.message); break;
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
            };
            if (state.currentMsgEl && state.isStreaming) {
              liveUi.attachUsageLine(state.currentMsgEl, null, state.roleTokens);
            }
            host.updateContextBar?.();
          }
          break;
        case 'monitor_started':
          if (message.background !== false) liveUi.pushDanmaku('start', message.description || message.command || '后台任务', message.task_id);
          break;
        case 'monitor_done':
          if (message.background !== false) {
            liveUi.pushDanmaku(
              message.status === 'error' || message.status === 'failed' ? 'fail' : 'done',
              message.summary || message.description || '后台任务', message.task_id,
            );
          }
          break;
        case 'monitor_progress':
          if (message.background !== false) {
            liveUi.pushDanmaku('progress', message.description || '后台任务仍在执行', message.task_id);
          }
          break;
        case 'progress_heartbeat':
          activeProgressTurnId = String(message.turnId || 'active');
          liveUi.pushDanmaku('progress', formatProgressHeartbeat(message), `turn:${activeProgressTurnId}`);
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
        case 'task_state': liveUi.renderAuxClassify(message.goal, message.phase, message.classifyState); break;
        case 'user_input_required':
          state.pendingUserInputRequestId = message.requestId || null;
          if (host.renderPendingUserInput?.(message) !== true) {
            host.addSystemMsg?.([
              '需要你的确认：' + (message.question || '请补充必要信息'),
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
        case 'session_queue': {
          const items = Array.isArray(message.items) ? message.items : [];
          const visibleItems = message.event === 'queued' && message.queued === false
            ? items.filter(item => item?.entryId !== message.entryId)
            : items;
          // Insert user bubble now if queued=false (immediate), otherwise stage it
          if (message.event === 'queued') {
            const text = message.message;
            const clientMsgId = message.clientMsgId;
            if (message.queued === false && text && clientMsgId) {
              if (typeof host.addUserMessage === 'function') host.addUserMessage(text, clientMsgId);
            } else if (message.queued && text && clientMsgId) {
              if (window.stagedUserBubbles) window.stagedUserBubbles.set(clientMsgId, text);
            }
          }
          host.renderSessionQueue?.(
            visibleItems,
            { state: message.state, freezeReason: message.freezeReason || null },
          );
          if (message.event === 'queued' && message.queued !== false) {
            host.showNotifyToast?.(
              message.queuePosition ? `消息已排队（第 ${message.queuePosition} 位）` : '消息已持久排队',
              'running',
            );
          } else if (message.event === 'frozen') {
            host.addSystemMsg?.(`队列已冻结：${message.freezeReason || '当前任务尚未成功完成'}`);
          } else if (message.event === 'started') {
            host.showNotifyToast?.('已开始执行队首任务', 'running');
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
          state.isStreaming = true;
          state.lastFinishedText = '';
          liveUi.showThinking();
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
          finishTurnProgress('done', '本轮已结束');
          // Refresh OpenCode Go quota after every turn end (debounced 60s
          // inside refreshOpenCodeQuota on error, no-op under non-opencode CLIs).
          // Skip when streaming was cancelled (pendingCancel) to avoid spurious
          // fetches right after the user aborts a turn.
          if (!state.pendingCancel) {
            global.MultiCCChatRateLimit?.refreshOpenCodeQuota?.();
            global.MultiCCChatRateLimit?.refreshQoderQuota?.();
            global.MultiCCChatRateLimit?.refreshCodexQuota?.();
            global.MultiCCChatRateLimit?.refreshArkQuota?.();
            global.MultiCCChatRateLimit?.refreshZhipuQuota?.();
            global.MultiCCChatRateLimit?.refreshKimiQuota?.();
          }
          break;
        case 'notify': {
          const classifyState = message.classifyState || null;
          if (message.state === 'running' || classifyState === 'P' || classifyState === 'C') {
            host.showNotifyToast?.(message.message || '任务进行中', 'running');
          } else {
            const display = liveUi.classifyDisplay(classifyState);
            if (display.voice) host.speakNotify?.(display.voice, display.ding);
            else {
              const waiting = message.state === 'waiting';
              host.speakNotify?.(waiting ? '等待操作' : '任务已完成', waiting ? 'waiting' : 'completed');
            }
          }
          break;
        }
        case 'error':
          if (isRecoverableCodexReconnectErrorText(message.error || '')) {
            host.warn?.('[multicc/chat] suppressed recoverable codex reconnect');
            break;
          }
          host.addSystemMsg?.(`Error: ${message.error || 'Unknown chat error'}`);
          state.isStreaming = false;
          finishStreaming();
          host.stopTitleAnimation?.();
          host.updateUI?.();
          liveUi.settleTurnScopedDanmaku?.();
          finishTurnProgress('fail', '本轮执行失败');
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
          else if (state.currentCli === 'codex') {
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
        } else if (state.currentCli === 'codex' && block.type === 'tool_use' && block.id) {
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
    function handlePartDelta(message) {
      if (state.currentCli === 'claude') return;
      const d = message && message.delta;
      if (!d) return;
      if (!state.currentMsgEl) state.currentMsgEl = createAssistantBubble();
      liveUi.hideThinking?.();
      if (d.type === 'text' && d.text) {
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
          tool = { card, inputJson: '{}', name: 'Thinking', id: rid, reasoning: '' };
          state.currentToolCards.set(`id:${rid}`, tool);
          historyView.appendToolCard(state.currentMsgEl.querySelector('.msg-content'), card);
        }
        tool.reasoning = (tool.reasoning || '') + d.text;
        tool.inputJson = JSON.stringify({ text: tool.reasoning });
        historyView.updateToolInput(tool);
        host.maybeScrollToBottom?.();
      } else if (d.type === 'tool' && d.tool && d.toolId) {
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
    formatProgressHeartbeat,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatEventController = api;
})(typeof window !== 'undefined' ? window : globalThis);
