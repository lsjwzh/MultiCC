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
      }
      state.turnStartMs = 0;
      host.stopTitleAnimation?.();
      if (message.total_cost_usd) {
        const duration = Number.isFinite(message.durationMs)
          ? liveUi.fmtDuration(message.durationMs)
          : (message.duration_ms ? `${message.duration_ms}ms` : '');
        state.costText = `$${message.total_cost_usd.toFixed(4)}`;
        if (duration) state.costText += ` | ${duration}`;
        if (message.num_turns) state.costText += ` | ${message.num_turns} turn(s)`;
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
        case 'background_tasks': break;
        case 'chat_msg_meta':
          if (message.id && message.role) historyView.tagLatestMessage(message.role, message.id);
          break;
        case 'chat_msg_deleted':
          if (message.id) host.removeHistoryMessageById?.(message.id);
          break;
        case 'chat_history':
          host.applyHistoryPlan?.(historyStore.acceptHistory(message, historyView.visibleIds()));
          break;
        case 'chat_history_reset': handleHistoryReset(message); break;
        case 'task_state': liveUi.renderAuxClassify(message.goal, message.phase, message.classifyState); break;
        case 'rate_limit_event': break;
        case 'stream_end':
          if (state.isStreaming) {
            state.isStreaming = false;
            finishStreaming();
            host.stopTitleAnimation?.();
            host.updateUI?.();
          }
          finishTurnProgress('done', '本轮已结束');
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
          liveUi.hideThinking();
          if (!state.currentMsgEl) state.currentMsgEl = createAssistantBubble();
          else if (state.currentTextContent && !state.currentTextContent.endsWith('\n\n')) state.currentTextContent += '\n\n';
          host.startTitleAnimation?.();
          host.updateUI?.();
          if (event.message?.usage) {
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

    function finalizeAssistantMsg(message) {
      if (!message?.content) return;
      liveUi.hideThinking();
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          if (!state.currentMsgEl) state.currentMsgEl = createAssistantBubble();
          if (state.currentCli === 'codex') state.currentTextContent += block.text;
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
            };
            state.currentToolCards.set(`id:${block.id}`, tool);
            historyView.appendToolCard(state.currentMsgEl.querySelector('.msg-content'), card);
          } else if (block.input) tool.inputJson = JSON.stringify(block.input);
          historyView.updateToolInput(tool);
          host.maybeScrollToBottom?.();
        }
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
      state.currentMsgEl = null;
      state.currentTextContent = '';
      state.currentToolCards = new Map();
      host.rearmUnread?.();
      host.maybeScrollToBottom?.();
    }

    return Object.freeze({
      beginGeneration,
      invalidateGeneration,
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
