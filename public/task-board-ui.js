(function attachMultiCCTaskBoardUi(global) {
  'use strict';

  function sessionChatUrl(sessionId, messageId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const params = new URLSearchParams();
    params.set('session', id);
    const target = String(messageId || '').trim();
    if (target) params.set('message', target);
    return `/chat.html?${params.toString()}`;
  }

  function compareText(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });
  }

  function sortModules(modules) {
    return [...(Array.isArray(modules) ? modules : [])].sort((a, b) => {
      const aPending = a?.source === 'classify' || a?.name === '待归类';
      const bPending = b?.source === 'classify' || b?.name === '待归类';
      if (aPending !== bPending) return aPending ? -1 : 1;
      return compareText(a?.name, b?.name) || compareText(a?.id, b?.id);
    });
  }

  function sortTasks(tasks) {
    return [...(Array.isArray(tasks) ? tasks : [])].sort((a, b) => {
      const byActivity = (Number(b?.lastTs) || 0) - (Number(a?.lastTs) || 0);
      return byActivity || compareText(a?.title, b?.title) || compareText(a?.id, b?.id);
    });
  }

  // Full snapshots replace local state. Indexing by canonical taskId makes WS
  // delta replay/reconnect idempotent and automatically prunes cards absent
  // from the latest authoritative snapshot. It deliberately never compares
  // titles or bodies: two explicit user admissions with the same text remain
  // two tasks.
  function reconcileSnapshot(snapshot) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const byId = (items) => {
      const map = new Map();
      for (const item of Array.isArray(items) ? items : []) {
        const id = String(item?.id || '').trim();
        if (!id) continue;
        const existing = map.get(id);
        const currentTs = Number(item?.lastTs || item?.updatedAt || item?.createdAt) || 0;
        const existingTs = Number(existing?.lastTs || existing?.updatedAt || existing?.createdAt) || 0;
        if (!existing || currentTs >= existingTs) map.set(id, item);
      }
      return [...map.values()];
    };
    return {
      ...source,
      modules: byId(source.modules),
      tasks: byId(source.tasks),
    };
  }

  function partitionTaskIdentity(tasks) {
    const result = { canonical: [], unresolved: [] };
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (task?.identityState === 'orphaned_admission'
          || task?.identityState === 'legacy_unresolved') {
        result.unresolved.push(task);
      } else {
        result.canonical.push(task);
      }
    }
    return result;
  }

  function statusRegistry() {
    return global.MultiCCStatusPresentation || (typeof require === 'function'
      ? require('./status-presentation.js')
      : null);
  }

  function translate(key) {
    return typeof global.t === 'function' ? global.t(key) : key;
  }

  // Task-card status. The vocabulary, icons, tones and animation policy all come
  // from the shared registry (public/status-presentation.js) — this only keeps the
  // legacy `{done, running}` shape the existing card templates and CSS bind to.
  function taskDisplayState(task) {
    const registry = statusRegistry();
    const status = registry.taskStatus({ status: task?.status, runState: task?.runState });
    const spec = registry.presentation('task', status);
    return {
      key: status,
      status,
      icon: spec.icon,
      tone: spec.tone,
      label: translate(spec.labelKey),
      ariaLabel: translate(spec.ariaKey),
      // `running` gates the blink/spin CSS, so it must follow the registry's
      // spinner policy rather than the status name: error never animates.
      running: spec.spinner,
      done: spec.terminal && status === 'done',
    };
  }

  function taskRoutingLabel(task) {
    // The task card intentionally hides the Commander→worker routing chip: a card
    // should read as just "新任务 · 进行中" and let its title/runState sync from the
    // worker's own classify. The routing data itself is kept on task.routing (it
    // anchors runState to the worker and drives the detail composer) — this only
    // suppresses the display. Return the old label below to re-enable the chip.
    return '';
    /* eslint-disable no-unreachable */
    const routing = task?.routing;
    if (!routing || routing.mode !== 'commander' || !routing.targetSessionId) return '';
    const id = routing.targetSessionId;
    const label = routing.targetLabel || id;
    const commander = `已交给 Commander · ${label}${label === id ? '' : ` (${id})`}`;
    if (!routing.workerSessionId) return commander;
    const workerId = routing.workerSessionId;
    const workerLabel = routing.workerLabel || workerId;
    const elastic = routing.elasticWorkerCreated ? ' · 动态扩容' : '';
    return `${commander} → ${workerLabel}${workerLabel === workerId ? '' : ` (${workerId})`}${elastic}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));
  }

  function tokenCount(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  }

  function runStateLabel(state) {
    return ({
      queued: '排队中',
      leasing: '分配执行槽',
      context_building: '构建上下文',
      running: '执行中',
      finalizing: '保存结果',
      usage_sealing: '结算用量',
      cleaning: '清理中',
      succeeded: '已完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已中断',
    })[state] || '状态未知';
  }

  function cleanupLabel(state) {
    if (state === 'done') return '已清理';
    if (state === 'deleting' || state === 'cleaning' || state === 'running') return '清理中';
    return '待清理';
  }

  function renderUsageDimension(dimension) {
    const providerId = String(dimension?.providerId || 'unknown');
    const providerName = String(dimension?.providerName || providerId || '未知 Provider');
    const model = String(dimension?.model || '').trim();
    const observedEvents = tokenCount(dimension?.observedEvents);
    const unobservableEvents = tokenCount(dimension?.unobservableEvents);
    const known = observedEvents > 0;
    const freshInput = tokenCount(dimension?.freshInput);
    const cacheRead = tokenCount(dimension?.cacheRead);
    const cacheWrite = tokenCount(dimension?.cacheWrite);
    const output = tokenCount(dimension?.output);
    const reasoning = tokenCount(dimension?.reasoning);
    const tokenDetail = known
      ? `输入 ${freshInput} · 缓存读 ${cacheRead} · 缓存写 ${cacheWrite} · 输出 ${output} · 推理 ${reasoning}`
      : '未观测';
    return `<div class="tb-run-provider" data-testid="task-run-provider" data-provider-id="${escapeHtml(providerId)}" data-observed-events="${observedEvents}" data-unobservable-events="${unobservableEvents}">
      <span class="tb-run-provider-name">${escapeHtml(providerName)}</span>${model ? ` <span class="tb-run-model">${escapeHtml(model)}</span>` : ''}
      <span class="tb-run-token-detail">${tokenDetail}</span>
    </div>`;
  }

  function pendingQuestion(run) {
    const source = run?.pendingQuestion;
    if (!source || typeof source !== 'object') return null;
    const requestId = String(source.requestId || '').trim().slice(0, 160);
    const question = String(source.question || '').trim().slice(0, 16 * 1024);
    if (!requestId || !question) return null;
    const options = [];
    const seen = new Set();
    for (const raw of Array.isArray(source.options) ? source.options : []) {
      const option = String(raw == null ? '' : raw).trim().slice(0, 512);
      if (!option || seen.has(option)) continue;
      seen.add(option);
      options.push(option);
      if (options.length >= 12) break;
    }
    return {
      requestId,
      question,
      reason: String(source.reason || '').trim().slice(0, 4 * 1024),
      options,
      allowMultiple: source.allowMultiple === true && options.length >= 2,
      createdAt: Math.max(0, Number(source.createdAt) || 0),
    };
  }

  function renderPendingQuestion(run) {
    const pending = pendingQuestion(run);
    if (!pending) return '';
    const options = pending.options.map(option => (
      `<button type="button" class="tb-run-answer-option" data-testid="task-run-answer-option" data-answer-value="${escapeHtml(option)}" aria-pressed="false">${escapeHtml(option)}</button>`
    )).join('');
    return `<section class="tb-run-question" data-testid="task-run-pending-question" data-request-id="${escapeHtml(pending.requestId)}" data-allow-multiple="${pending.allowMultiple ? '1' : '0'}">
      <div class="tb-run-question-label">需要你的回答</div>
      <div class="tb-run-question-text">${escapeHtml(pending.question)}</div>
      ${pending.reason ? `<div class="tb-run-question-reason">${escapeHtml(pending.reason)}</div>` : ''}
      ${options ? `<div class="tb-run-answer-options">${options}</div>` : ''}
      <div class="tb-run-answer-compose">
        <textarea rows="2" data-testid="task-run-answer-text" placeholder="也可以输入自定义回答"></textarea>
        <button type="button" data-testid="task-run-answer-submit">回答</button>
      </div>
      <div class="tb-run-answer-result" data-testid="task-run-answer-result" aria-live="polite"></div>
    </section>`;
  }

  function answerClientId(requestId) {
    const uuid = global.crypto?.randomUUID?.();
    return `tb-answer-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}-${String(requestId || '').slice(-12)}`;
  }

  function bindPendingQuestionAnswers(root, onAnswer) {
    if (!root || typeof root.querySelectorAll !== 'function' || typeof onAnswer !== 'function') return 0;
    let bound = 0;
    for (const card of root.querySelectorAll('[data-testid="task-run-pending-question"]')) {
      if (card.dataset.answerBound === '1') continue;
      const requestId = String(card.dataset.requestId || '').trim();
      const multiple = card.dataset.allowMultiple === '1';
      const optionButtons = [...card.querySelectorAll('[data-testid="task-run-answer-option"]')];
      const textInput = card.querySelector('[data-testid="task-run-answer-text"]');
      const submitButton = card.querySelector('[data-testid="task-run-answer-submit"]');
      const result = card.querySelector('[data-testid="task-run-answer-result"]');
      if (!requestId || !textInput || !submitButton || !result) continue;
      card.dataset.answerBound = '1';
      bound += 1;
      let submitting = false;
      let lastAnswer = '';
      let clientMsgId = '';
      const selected = new Set();
      const controls = [...optionButtons, textInput, submitButton];
      const setDisabled = value => controls.forEach(control => { control.disabled = value; });
      const submit = async rawAnswer => {
        const text = String(rawAnswer || '').trim();
        if (!text || submitting || card.dataset.resolved === '1') return false;
        if (!clientMsgId || lastAnswer !== text) clientMsgId = answerClientId(requestId);
        lastAnswer = text;
        submitting = true;
        setDisabled(true);
        result.textContent = '发送中…';
        result.dataset.state = 'sending';
        try {
          const response = await onAnswer({ requestId, text, clientMsgId });
          if (!response || response.ok !== true) throw new Error(response?.error || 'answer failed');
          card.dataset.resolved = '1';
          result.textContent = response.duplicate === true ? '已回答' : '回答已发送';
          result.dataset.state = 'success';
          return true;
        } catch (error) {
          result.textContent = String(error?.message || error || '回答失败');
          result.dataset.state = 'error';
          submitting = false;
          setDisabled(false);
          return false;
        }
      };
      for (const button of optionButtons) {
        button.addEventListener('click', () => {
          const value = String(button.dataset.answerValue || '').trim();
          if (!multiple) { void submit(value); return; }
          if (selected.has(value)) selected.delete(value); else selected.add(value);
          button.setAttribute('aria-pressed', selected.has(value) ? 'true' : 'false');
        });
      }
      submitButton.addEventListener('click', () => {
        const custom = String(textInput.value || '').trim();
        const answers = [...selected];
        if (custom) answers.push(custom);
        void submit(answers.join(', '));
      });
      textInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          submitButton.click();
        }
      });
    }
    return bound;
  }

  // Durable TaskRun summary. It deliberately accepts task-owned run/usage data
  // only: slotId, nativeSessionId and any other execution-pool internals are not
  // rendered and can never turn into a legacy chat link.
  function renderTaskRunSummary(run) {
    const source = run && typeof run === 'object' ? run : {};
    const runId = String(source.runId || source.id || '');
    const state = String(source.executionStatus || source.state || 'unknown');
    const cleanupState = String(source.cleanupState || 'pending');
    const usage = source.usage && typeof source.usage === 'object' ? source.usage : {};
    const usageStatus = String(source.usageStatus || usage.usageStatus || 'collecting');
    const coverage = String(usage.coverage || (usageStatus === 'unobservable' ? 'unobservable' : 'unknown'));
    const known = usageStatus !== 'unobservable'
      && coverage !== 'unobservable'
      && usage.hasKnownUsage !== false
      && usage.tokens
      && typeof usage.tokens === 'object';
    const tokens = known ? usage.tokens : null;
    const total = tokens
      ? tokenCount(tokens.total ?? (
        tokenCount(tokens.consumedInput ?? (
          tokenCount(tokens.freshInput) + tokenCount(tokens.cacheRead) + tokenCount(tokens.cacheWrite)
        )) + tokenCount(tokens.output)
      ))
      : null;
    const dimensions = Array.isArray(usage.dimensions) ? usage.dimensions : [];
    const totalHtml = known ? `${total} tokens` : '未观测';
    const usageHtml = `<span data-testid="task-run-token-total">${totalHtml}</span>${dimensions
      .map(dimension => renderUsageDimension(dimension)).join('')}`;

    return `<section class="tb-run-summary" data-testid="task-run-summary" data-run-id="${escapeHtml(runId)}" data-state="${escapeHtml(state)}" data-cleanup-state="${escapeHtml(cleanupState)}">
      <header class="tb-run-summary-head">
        <span data-testid="task-run-state">${escapeHtml(runStateLabel(state))}</span>
        <span data-testid="task-run-cleanup">${escapeHtml(cleanupLabel(cleanupState))}</span>
      </header>
      <div class="tb-run-usage" data-testid="task-run-usage" data-usage-status="${escapeHtml(usageStatus)}" data-coverage="${escapeHtml(coverage)}">${usageHtml}</div>
      ${renderPendingQuestion(source)}
    </section>`;
  }

  // Rolling-upgrade tolerant detail DTO reader. The server currently emits
  // `runs`; aliases let clients survive either side of a staggered rollout
  // without making Task Board details fail to open.
  function recentTaskRuns(detail) {
    const source = detail && typeof detail === 'object' ? detail : {};
    const nested = source.task && typeof source.task === 'object' ? source.task : {};
    const raw = [
      source.recentRuns,
      source.taskRuns,
      source.runs,
      nested.recentRuns,
      nested.taskRuns,
      nested.runs,
    ].find(Array.isArray) || [];
    return raw
      .map((run, index) => ({ run, index }))
      .filter(item => item.run && typeof item.run === 'object')
      .sort((a, b) => {
        const aTs = Number(a.run.startedAt || a.run.createdAt || a.run.terminalAt) || 0;
        const bTs = Number(b.run.startedAt || b.run.createdAt || b.run.terminalAt) || 0;
        return (bTs - aTs) || (a.index - b.index);
      })
      .slice(0, 5)
      .map(item => item.run);
  }

  const api = Object.freeze({
    sessionChatUrl,
    sortModules,
    sortTasks,
    reconcileSnapshot,
    partitionTaskIdentity,
    taskDisplayState,
    taskRoutingLabel,
    renderTaskRunSummary,
    recentTaskRuns,
    pendingQuestion,
    bindPendingQuestionAnswers,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCTaskBoardUi = api;
})(typeof window !== 'undefined' ? window : globalThis);
