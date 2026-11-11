'use strict';

// 无人值守（unattended）面板 —— 老 Goal 模式那套「先预检、再以 Goal 模式发一条」的
// 入口已经整体退场，改由这个模块承担会话中的接管入口。契约见 docs/unattended-mode.md：
//   GET  /api/sessions/:id/unattended            → { ok, unattended, limits }
//   POST /api/sessions/:id/unattended            body { action, ... } → 同 GET
//   POST /api/goal/precheck { task }             → 预检（复用既有接口）
//   WS   { type: 'unattended_state', unattended }
// 状态是服务端那份 record.unattended；这里只负责画、收集输入、发动作。图标状态：
// 未启用灰、运行中绿（呼吸）、需要人工琥珀、已达成对勾、停止/轮次用尽/出错灰红。
//
// 面板放在独立模块里，是为了不动 chat.js 那 3000 行棘轮 / chat.html 的迁移线；
// chat.js 只负责 create() 一次，并把 WS 事件转发给 applyState()。
(function attachMultiCCChatUnattended(global) {
  'use strict';

  const MAX_CRITERIA = 12;
  const CRITERION_MAX_LENGTH = 300;
  const GOAL_MAX_LENGTH = 2000;
  // 服务端 limits 缺失时（老服务端 / 测试夹具）的兜底：最长值守时间 5 分钟 – 24 小时。
  const DURATION_LIMITS = Object.freeze({
    maxDurationMinutesDefault: 120,
    maxDurationMinutesMin: 5,
    maxDurationMinutesMax: 1440,
  });
  // 剩余时间只按 30 秒刷新，且只在 active 时挂表：定时器不许在终态泄漏。
  const TICK_INTERVAL_MS = 30000;
  // 距离下次自动重试不足一分钟就不报具体时刻，改说「即将自动重试」。
  const RETRY_SOON_MS = 60000;
  // setTimeout 的 32 位上限；退避最长 15 分钟，这里只是防御异常帧。
  const MAX_TIMEOUT_MS = 2147483000;
  // 预检是一次真 Aux 推理，服务端 owns 等待预算（/api/settings/goal 的 precheckWaitMs）。
  // 这里只加一层兜底，别让客户端 15s 的通用预算先把预检掐死。
  const PRECHECK_FALLBACK_WAIT_MS = 180000;
  const PRECHECK_SLACK_MS = 30000;
  const STATUS_KEY = Object.freeze({
    active: 'unattendedStatusActive',
    achieved: 'unattendedStatusAchieved',
    needs_human: 'unattendedStatusNeedsHuman',
    exhausted: 'unattendedStatusExhausted',
    stopped: 'unattendedStatusStopped',
    error: 'unattendedStatusError',
  });
  const VERDICT_KEY = Object.freeze({
    achieved: 'unattendedVerdictAchieved',
    continue: 'unattendedVerdictContinue',
    needs_human: 'unattendedVerdictNeedsHuman',
  });
  const PAUSED_KEY = Object.freeze({
    user: 'unattendedPausedByUser',
    input: 'unattendedPausedByInput',
    cancel: 'unattendedPausedByCancel',
  });
  const ICON = Object.freeze({
    idle: '◎', active: '◉', achieved: '✓', needs_human: '!',
    exhausted: '⊘', stopped: '■', error: '✕',
  });
  const RESUMABLE = new Set(['needs_human', 'exhausted', 'stopped', 'error']);
  // Terminal states with a persisted record: the panel footer (and the paused
  // banner for the RESUMABLE subset) can end the run and delete the record.
  const CLEARABLE = new Set(['needs_human', 'exhausted', 'stopped', 'error', 'achieved']);
  const EDITABLE = new Set(['active', 'needs_human']);

  function clampInt(value, min, max, fallback) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function create(options) {
    const opts = options || {};
    const doc = opts.document || global.document;
    const win = opts.window || global;
    const tr = typeof opts.translate === 'function' ? opts.translate : (key => key);
    const getSessionId = typeof opts.getSessionId === 'function' ? opts.getSessionId : (() => '');
    const request = typeof opts.request === 'function' ? opts.request : null;
    const errorText = typeof opts.errorText === 'function'
      ? opts.errorText
      : (error => String((error && error.message) || error || ''));
    // 宿主（chat.js）用这一个回调把锁合成进它自己的 updateUI 逻辑：连接态、
    // 流式态和无人值守锁只有一个入口，绝不会出现「锁解除后输入框还灰着」。
    const applyInputLock = typeof opts.applyInputLock === 'function' ? opts.applyInputLock : null;
    if (!doc || !doc.body || typeof request !== 'function') return null;

    let state = null;
    let limits = { ...DURATION_LIMITS };
    let mounted = false;
    let panelOpen = false;
    let formDirty = false;
    // After clearing, the panel keeps the last goal/criteria/duration as a draft
    // so the user can restart quickly; every other state change still syncs.
    let keepDraft = false;
    let busy = false;
    let precheckBusy = false;
    let tickTimer = null;
    // 精确到 retryAt 的一次性重画：30 秒的剩余时间表可能还要等十几秒才跳，
    // 重试那一行不能卡在「HH:MM 自动重试」上。终态/状态变化时立刻清掉。
    let retryTimer = null;
    const tickMs = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : TICK_INTERVAL_MS;
    // 服务端拥有预检的等待预算（/api/settings/goal 的 precheckWaitMs）。客户端只读
    // 它，再加一点余量，让服务端自己的 AUX_TIMEOUT 先到，而不是被通用 15s 预算掐死。
    // 读不到（老服务端 / 网络抖）才用兜底值。
    let precheckWaitMs = 0;
    function goalPrecheckTimeoutMs() {
      return (precheckWaitMs || PRECHECK_FALLBACK_WAIT_MS) + PRECHECK_SLACK_MS;
    }
    async function loadPrecheckBudget() {
      try {
        const data = await request('/api/settings/goal', { method: 'GET' });
        const wait = Number(data && data.precheckWaitMs);
        precheckWaitMs = Number.isFinite(wait) && wait > 0 ? wait : 0;
      } catch (_) { /* 保持兜底值 */ }
    }

    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }
    function byId(id) { return doc.getElementById(id); }
    const matches = (node, selector) => (node && typeof node.matches === 'function' ? node.matches(selector) : false);

    // ── DOM ─────────────────────────────────────────────────────────────────
    const fab = el('button', 'unat-fab unat-state-idle');
    fab.id = 'unattended-fab';
    fab.type = 'button';
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 'unattended-panel');
    const fabIcon = el('span', 'unat-fab-icon', ICON.idle);
    fabIcon.setAttribute('aria-hidden', 'true');
    fab.append(fabIcon);

    const root = el('div', 'unat-root');
    const scrim = el('div', 'unat-scrim');
    // 遮罩必须和面板一样初始隐藏：它是全屏 pointer-events:auto 的，一旦可见就会
    // 盖住整页并吃掉所有点击（close() 在面板没开时直接返回，救不了它）。
    scrim.hidden = true;
    const panel = el('section', 'unat-panel');
    panel.id = 'unattended-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'unattended-panel-title');

    const head = el('div', 'unat-head');
    const title = el('h3', 'unat-title', tr('unattendedPanelTitle'));
    title.id = 'unattended-panel-title';
    const closeBtn = el('button', 'unat-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = tr('close');
    closeBtn.setAttribute('aria-label', tr('close'));
    head.append(title, closeBtn);

    const body = el('div', 'unat-body');
    body.append(el('p', 'unat-intro', tr('unattendedSheetHint')));

    const statusCard = el('div', 'unat-status-card');
    const statusLine = el('div', 'unat-status-line');
    const statusLabel = el('span', 'unat-status-label', tr('unattendedNotStarted'));
    // 判定中：服务端每次 start/apply 都广播 evaluating 的两条边，面板与图标
    // 同时转起来，用户才知道「暂停」之前 AI 正在想什么。
    const evaluating = el('span', 'unat-evaluating');
    const evaluatingDot = el('span', 'unat-spinner');
    evaluatingDot.setAttribute('aria-hidden', 'true');
    const evaluatingLabel = el('span', '', tr('unattendedJudging'));
    evaluating.append(evaluatingDot, evaluatingLabel);
    evaluating.hidden = true;
    const roundLabel = el('span', 'unat-round');
    statusLine.append(statusLabel, evaluating, roundLabel);
    // active 时补一行「截止 HH:MM」：剩余时间已经在上面的 roundLabel 里，这一行
    // 是给需要对齐日程的人看的绝对时间。终态隐藏。
    const deadlineLine = el('p', 'unat-deadline');
    deadlineLine.hidden = true;
    // 故障恢复退避期间，状态块和输入栏上方的 banner 说同一句话：何时、第几次自动重试。
    const retryLine = el('p', 'unat-retry');
    retryLine.hidden = true;
    const humanReason = el('p', 'unat-human');
    humanReason.hidden = true;
    // pausedBy（v2）：用户接管 / 输入触发 / 取消，三种暂停原因都落在状态块里。
    const pausedLine = el('p', 'unat-paused');
    pausedLine.hidden = true;
    const verdictLine = el('p', 'unat-verdict');
    verdictLine.hidden = true;
    statusCard.append(statusLine, deadlineLine, retryLine, humanReason, pausedLine, verdictLine);

    const goalField = el('label', 'unat-field');
    goalField.append(el('span', 'unat-label', tr('unattendedGoal')));
    const goalInput = el('textarea', 'unat-goal');
    goalInput.rows = 3;
    goalInput.maxLength = GOAL_MAX_LENGTH;
    goalInput.placeholder = tr('unattendedGoalHint');
    goalField.append(goalInput);

    const criteriaField = el('div', 'unat-field');
    const criteriaLabel = el('span', 'unat-label', tr('unattendedCriteria'));
    const criteriaHint = el('span', 'unat-hint', tr('unattendedCriterionHint'));
    const criteriaList = el('div', 'unat-criteria');
    criteriaList.id = 'unattended-criteria-list';
    const addCriterion = el('button', 'unat-add-criterion', tr('unattendedCriteriaAdd'));
    addCriterion.type = 'button';
    criteriaField.append(criteriaLabel, criteriaHint, criteriaList, addCriterion);

    // 最长值守时间：数字 + 单位选择（分钟/小时）。旧版的「轮次上限」已经退场，
    // 服务端只认 maxDurationMinutes；面板默认 2 小时，按 limits 夹取。
    const durationField = el('label', 'unat-field unat-duration-field');
    durationField.append(el('span', 'unat-label', tr('unattendedMaxDuration')));
    const durationInput = el('input', 'unat-duration');
    durationInput.type = 'number';
    durationInput.min = '1';
    durationInput.step = '1';
    durationInput.value = '2';
    const durationUnit = el('select', 'unat-duration-unit');
    const durationHourOption = el('option', '', tr('unattendedDurationUnitHours'));
    durationHourOption.value = 'h';
    const durationMinuteOption = el('option', '', tr('unattendedDurationUnitMinutes'));
    durationMinuteOption.value = 'm';
    durationUnit.append(durationHourOption, durationMinuteOption);
    durationUnit.value = 'h';
    const durationHint = el('span', 'unat-hint', tr('unattendedMaxDurationRange'));
    const durationRow = el('span', 'unat-duration-row');
    durationRow.append(durationInput, durationUnit, durationHint);
    durationField.append(durationRow);

    const draftBtn = el('button', 'unat-draft', tr('unattendedDraftCriteria'));
    draftBtn.type = 'button';
    const precheckBox = el('div', 'unat-precheck');
    precheckBox.hidden = true;

    const historyBox = el('div', 'unat-history');
    const historyTitle = el('div', 'unat-history-title', tr('unattendedHistory'));
    const historyList = el('div', 'unat-history-list');
    historyBox.append(historyTitle, historyList);

    const errorLine = el('p', 'unat-error');
    errorLine.hidden = true;

    body.append(statusCard, goalField, criteriaField, durationField, draftBtn, precheckBox, historyBox, errorLine);

    const footer = el('div', 'unat-actions');
    const startBtn = el('button', 'unat-primary', tr('unattendedStart'));
    const updateBtn = el('button', '', tr('unattendedSave'));
    const stopBtn = el('button', 'unat-stop', tr('unattendedStop'));
    const resumeBtn = el('button', 'unat-primary', tr('unattendedResume'));
    const clearBtn = el('button', 'unat-clear', tr('unattendedClear'));
    clearBtn.title = tr('unattendedClearHint');
    clearBtn.dataset.action = 'clear';
    for (const button of [startBtn, updateBtn, stopBtn, resumeBtn, clearBtn]) button.type = 'button';
    startBtn.dataset.action = 'start';
    updateBtn.dataset.action = 'update';
    stopBtn.dataset.action = 'stop';
    resumeBtn.dataset.action = 'resume';
    footer.append(stopBtn, updateBtn, resumeBtn, clearBtn, startBtn);

    panel.append(head, body, footer);

    // ── composer banner ─────────────────────────────────────────────────────
    // active 时输入框被锁住（v2 产品决定），banner 就在输入栏正上方说明原因
    // 并给出「暂停并接管」；终态则缩成一行「继续无人值守」。它是 chat.html
    // 里 #input-bar 的前一个兄弟节点，Air iframe 里同样如此。
    const banner = el('div', 'unat-banner');
    banner.id = 'unattended-banner';
    banner.hidden = true;
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    const bannerMain = el('div', 'unat-banner-main');
    const bannerSpinner = el('span', 'unat-spinner');
    bannerSpinner.setAttribute('aria-hidden', 'true');
    bannerSpinner.hidden = true;
    const bannerText = el('span', 'unat-banner-text');
    bannerMain.append(bannerSpinner, bannerText);
    const bannerReason = el('span', 'unat-banner-reason');
    bannerReason.hidden = true;
    const bannerBtn = el('button', 'unat-banner-btn', tr('unattendedPauseTakeover'));
    bannerBtn.type = 'button';
    // Quiet secondary action next to the primary resume / pause button.
    const bannerClearBtn = el('button', 'unat-banner-clear', tr('unattendedClear'));
    bannerClearBtn.type = 'button';
    bannerClearBtn.title = tr('unattendedClearHint');
    bannerClearBtn.dataset.action = 'clear';
    banner.append(bannerMain, bannerReason, bannerClearBtn, bannerBtn);

    // ── rendering ───────────────────────────────────────────────────────────
    function fmtVerdict(verdict) {
      return tr(VERDICT_KEY[verdict] || 'unattendedVerdictContinue');
    }

    // v2：服务端用 pausedBy 说明是谁让监督器停下的。stop 按钮 = user，
    // 真人输入触发 = input，轮次取消 = cancel。
    function pausedByText() {
      const key = state && PAUSED_KEY[state.pausedBy];
      return key ? tr(key) : '';
    }

    // banner 的「为什么暂停」：需要人工时优先给 humanReason；到时间时给
    // 「已达到最长值守时间」；其余看 pausedBy。
    function bannerReasonText() {
      const status = state && state.status;
      if (status === 'needs_human') {
        const reason = String(state.lastVerdict?.humanReason || state.lastVerdict?.reason || '');
        return reason ? tr('unattendedHumanReason', { reason }) : statusWord();
      }
      if (status === 'exhausted') return exhaustedReasonText();
      return pausedByText();
    }

    // 到时间退场：服务端会写一条 human reason「已达到最长值守时间」。中文原文在
    // 英文界面里会露中文，所以认识这句（以及旧的「轮次用尽」）就换成本地文案；
    // 其它原因原样展示。
    function exhaustedReasonText() {
      const raw = String((state && (state.lastVerdict?.humanReason || state.lastVerdict?.reason)) || '');
      if (!raw || /已达到最长值守时间|轮次用尽|rounds?\s*(?:exhausted|run out)/i.test(raw)) {
        return tr('unattendedMaxDurationReached');
      }
      return raw;
    }

    // ── 剩余时间 / 截止时间 ──────────────────────────────────────────────────
    // 契约的主时钟是 deadlineAt（epoch ms）；老服务端只给 startedAt + 时长时按
    // 二者推算，别让面板因此空着。没有 deadline 的老状态就只显示判定次数。
    function deadlineMs() {
      if (!state) return 0;
      const direct = Number(state.deadlineAt);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const started = Number(state.startedAt);
      const minutes = Number(state.maxDurationMinutes);
      if (Number.isFinite(started) && started > 0 && Number.isFinite(minutes) && minutes > 0) {
        return started + minutes * 60000;
      }
      return 0;
    }

    // 紧凑格式：1小时20分 / 45分 / <1分。向下取整，避免把「还剩 59 秒」写成 1分。
    function formatRemaining(ms) {
      if (!Number.isFinite(ms)) return '';
      const totalMinutes = Math.floor(ms / 60000);
      if (totalMinutes < 1) return tr('unattendedRemainingLessMinute');
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours > 0) {
        return minutes > 0
          ? tr('unattendedRemainingHourMinute', { hours, minutes })
          : tr('unattendedRemainingHour', { hours });
      }
      return tr('unattendedRemainingMinute', { minutes });
    }

    function remainingText() {
      const deadline = deadlineMs();
      return deadline ? formatRemaining(deadline - Date.now()) : '';
    }

    function clockText(epochMs) {
      const date = new Date(epochMs);
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }

    // ── 故障恢复自动重试 ────────────────────────────────────────────────────
    // 上游限流 / 线路暂不可用 / 准备失败时，监督器不再「3 次即放弃」，而是退避后
    // 自动重试。状态帧给出 retryAt（下次重试的 epoch ms）与 retryCategory
    // （capacity = 额度/线路/预检失败，fault = 其它故障）。active 且 retryAt 仍在
    // 未来时，banner 与状态块必须说明「何时、第几次重试」，否则用户只看到
    // 「无人值守进行中」却什么都没发生。字段缺失（老服务端）时 retryAt=0，走老文案。
    function retryAtMs() {
      const raw = state && Number(state.retryAt);
      return Number.isFinite(raw) && raw > 0 ? raw : 0;
    }

    function retryPending() {
      return !!(state && state.status === 'active' && retryAtMs() > Date.now());
    }

    function retryCategoryKey() {
      return state && state.retryCategory === 'capacity'
        ? 'unattendedRetryCapacity'
        : 'unattendedRetryFault';
    }

    // n = stall.consecutiveFaults；缺字段时按「第 1 次」说，别给用户看「第 0 次」。
    function retryAttempt() {
      const n = Number(state && state.stall && state.stall.consecutiveFaults);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    }

    function retryText() {
      const at = retryAtMs();
      const n = retryAttempt();
      let line;
      if (at - Date.now() <= RETRY_SOON_MS) {
        // unattendedRetrySoon（即将自动重试 / retrying shortly）本身就是完整短语；
        // 直接塞进句子的 {time} 会把动词说两遍，所以拼好后折掉重复的那一段。
        const soon = tr('unattendedRetrySoon');
        line = tr(retryCategoryKey(), { time: soon, n })
          .split(soon + ' 自动重试').join(soon)
          .split('retrying at ' + soon).join(soon);
      } else {
        line = tr(retryCategoryKey(), { time: clockText(at), n });
      }
      const remaining = remainingText();
      return remaining ? line + ' · ' + tr('unattendedRemaining', { remaining }) : line;
    }

    function activeBannerText() {
      if (retryPending()) return retryText();
      const remaining = remainingText();
      return remaining
        ? tr('unattendedBannerActive', { remaining })
        : tr('unattendedBannerActiveNoTime');
    }

    // 一个 30 秒定时器，只在 active 且有 deadline 时存在；终态立刻清掉。
    // 它只改剩余时间那几处文本，不整块 render（否则会打断正在输入的焦点）。
    function renderTiming() {
      const active = !!(state && state.status === 'active');
      if (state) {
        const rounds = Number(state.rounds) || 0;
        const remaining = active ? remainingText() : '';
        roundLabel.textContent = remaining
          ? tr('unattendedStatusMeta', { rounds, remaining })
          : tr('unattendedRoundsOnly', { rounds });
        roundLabel.hidden = false;
      } else {
        roundLabel.textContent = '';
        roundLabel.hidden = true;
      }
      const clock = active && deadlineMs() ? clockText(deadlineMs()) : '';
      deadlineLine.hidden = !clock;
      deadlineLine.textContent = clock ? tr('unattendedDeadline', { time: clock }) : '';
      const retry = active && retryPending() ? retryText() : '';
      retryLine.hidden = !retry;
      retryLine.textContent = retry;
      // 30 秒表也会跨过 retryAt：文本与琥珀色必须一起撤掉，不能只换字还在闪。
      banner.classList.toggle('unat-banner-retry', active && retryPending());
      if (active) bannerText.textContent = activeBannerText();
      renderFab();
    }

    function syncTimer() {
      const shouldTick = !!(state && state.status === 'active' && deadlineMs());
      if (shouldTick && !tickTimer) {
        tickTimer = win.setInterval(renderTiming, tickMs);
      } else if (!shouldTick && tickTimer) {
        win.clearInterval(tickTimer);
        tickTimer = null;
      }
    }

    function clearRetryTimer() {
      if (retryTimer) {
        win.clearTimeout(retryTimer);
        retryTimer = null;
      }
    }

    // retryAt 到了就立刻重画一次，把「HH:MM 自动重试 / 即将自动重试」换回正常文案；
    // 只挂一个一次性表，状态每次变化都重算（终态/无 retryAt 直接清掉）。
    function syncRetryTimer() {
      clearRetryTimer();
      if (!state || state.status !== 'active') return;
      const delay = retryAtMs() - Date.now();
      if (!(delay > 0)) return;
      retryTimer = win.setTimeout(() => {
        retryTimer = null;
        render(false);
      }, Math.min(delay + 20, MAX_TIMEOUT_MS));
    }

    function position() {
      const bar = byId('input-bar');
      if (!bar || typeof bar.getBoundingClientRect !== 'function') return;
      const rect = bar.getBoundingClientRect();
      // banner 可见时它才是「输入区」的最上沿：浮动图标跟着一起上移，
      // 免得压住暂停/继续按钮。
      const bannerRect = !banner.hidden && typeof banner.getBoundingClientRect === 'function'
        ? banner.getBoundingClientRect() : null;
      const top = bannerRect && bannerRect.height > 0 ? Math.min(rect.top, bannerRect.top) : rect.top;
      const right = Math.max(10, Math.round((win.innerWidth || 0) - rect.right + 12));
      // Above the composer, not inside it: the send button keeps its thumb target
      // even when the textarea grows to many lines.
      const bottom = Math.max(10, Math.round((win.innerHeight || 0) - top + 8));
      doc.documentElement.style.setProperty('--unat-right', right + 'px');
      doc.documentElement.style.setProperty('--unat-bottom', bottom + 'px');
    }

    function statusWord() {
      return state && state.status ? tr(STATUS_KEY[state.status] || 'unattendedNotStarted') : tr('unattendedNotStarted');
    }

    function renderFab() {
      const current = state && state.status ? state.status : 'idle';
      fab.className = 'unat-fab unat-state-' + current;
      fab.classList.toggle('unat-evaluating', !!state?.evaluating);
      fabIcon.textContent = ICON[current] || ICON.idle;
      const remaining = state && state.status === 'active' ? remainingText() : '';
      const label = tr('unattendedFabTooltip') + ' · ' + statusWord()
        + (remaining ? ' · ' + tr('unattendedRemaining', { remaining }) : '')
        + (state?.evaluating ? ' · ' + tr('unattendedJudging') : '');
      fab.title = label;
      fab.setAttribute('aria-label', label);
    }

    function renderStatus() {
      statusLabel.textContent = statusWord();
      statusLabel.className = 'unat-status-label unat-status-' + (state && state.status ? state.status : 'idle');
      evaluating.hidden = !(state && state.evaluating);
      renderTiming();
      const needsHuman = state && state.status === 'needs_human';
      const expired = state && state.status === 'exhausted';
      const reason = needsHuman
        ? String(state.lastVerdict?.humanReason || state.lastVerdict?.reason || '')
        : (expired ? exhaustedReasonText() : '');
      humanReason.hidden = !reason;
      humanReason.textContent = !reason ? ''
        : (needsHuman ? tr('unattendedHumanReason', { reason }) : reason);
      const paused = pausedByText();
      pausedLine.hidden = !paused;
      pausedLine.textContent = paused;
      const last = state && state.lastVerdict;
      verdictLine.hidden = !last;
      if (last) {
        verdictLine.textContent = tr('unattendedLastVerdict', {
          verdict: fmtVerdict(last.verdict),
          reason: last.reason || '',
        });
      }
      renderHistory();
    }

    function renderHistory() {
      historyList.replaceChildren();
      const history = state && Array.isArray(state.history) ? state.history.slice(-5).reverse() : [];
      if (!history.length) {
        historyList.append(el('div', 'unat-history-empty', tr('unattendedHistoryEmpty')));
        return;
      }
      for (const item of history) {
        const row = el('div', 'unat-history-row');
        row.append(
          el('span', 'unat-history-verdict', fmtVerdict(item && item.verdict)),
          el('span', 'unat-history-reason', String((item && item.reason) || '')),
        );
        historyList.append(row);
      }
    }

    function renderActions() {
      const status = state && state.status;
      // active/needs_human 用 Update 或 Resume 接着跑；其余终态（achieved /
      // exhausted / stopped / error）除了 Resume 之外还允许用表单里的新目标
      // 重新 Start —— 契约里 start 随时可以接管，达成之后不能是死路。
      startBtn.hidden = status === 'active' || status === 'needs_human';
      updateBtn.hidden = !(state && EDITABLE.has(status));
      stopBtn.hidden = !(state && EDITABLE.has(status));
      resumeBtn.hidden = !(state && RESUMABLE.has(status));
      clearBtn.hidden = !(state && CLEARABLE.has(status));
      clearBtn.textContent = tr('unattendedClear');
      clearBtn.title = tr('unattendedClearHint');
      for (const button of [startBtn, updateBtn, stopBtn, resumeBtn, clearBtn]) button.disabled = busy || precheckBusy;
      draftBtn.disabled = busy || precheckBusy;
      addCriterion.disabled = busy;
      durationInput.disabled = busy || precheckBusy;
      durationUnit.disabled = busy || precheckBusy;
    }

    // ── 输入锁 + 输入栏上方 banner ────────────────────────────────────────────
    // 锁只在 active 时生效，而且只在布尔值真的翻转时通知宿主一次 —— 宿主那边
    // 只有一片 updateUI，断开/重连、流式、无人值守共用同一条 disabled 计算。
    // 终态（含 achieved）与 null 都会立刻解锁：所谓「卡在 disabled」没有路径。
    let inputLocked = false;
    function syncInputLock(locked) {
      const next = !!locked;
      if (next === inputLocked) return;
      inputLocked = next;
      if (applyInputLock) {
        try { applyInputLock(next); } catch (_) { /* 宿主异常不能把面板拖死 */ }
      }
    }

    function renderBanner() {
      const status = state && state.status;
      const active = status === 'active';
      const resumable = !!(state && RESUMABLE.has(status));
      syncInputLock(active);
      banner.classList.toggle('unat-banner-active', active);
      banner.classList.toggle('unat-banner-paused', !active && resumable);
      // 退避重试期间换成琥珀色：仍然是「进行中」（绿色）之外的第三种平静状态，
      // 不能让用户把它当成正常推进，也不能红得像报错。
      banner.classList.toggle('unat-banner-retry', active && retryPending());
      bannerBtn.disabled = busy;
      bannerClearBtn.disabled = busy;
      if (active) {
        bannerText.textContent = activeBannerText();
        bannerSpinner.hidden = !state.evaluating;
        bannerReason.hidden = true;
        bannerReason.textContent = '';
        bannerBtn.textContent = tr('unattendedPauseTakeover');
        bannerBtn.dataset.action = 'stop';
        bannerClearBtn.hidden = true;
        banner.hidden = false;
        return;
      }
      bannerSpinner.hidden = true;
      if (resumable) {
        // 小号 banner：一句状态词 + 暂停原因，主按钮是「继续无人值守」。
        bannerText.textContent = statusWord();
        const reason = bannerReasonText();
        bannerReason.hidden = !reason;
        bannerReason.textContent = reason;
        bannerBtn.textContent = tr('unattendedBannerResume');
        bannerBtn.dataset.action = 'resume';
        bannerClearBtn.textContent = tr('unattendedClear');
        bannerClearBtn.title = tr('unattendedClearHint');
        bannerClearBtn.hidden = false;
        banner.hidden = false;
        return;
      }
      bannerReason.hidden = true;
      bannerReason.textContent = '';
      bannerClearBtn.hidden = true;
      banner.hidden = true;
    }

    function render(syncForm) {
      renderFab();
      renderStatus();
      renderActions();
      renderBanner();
      syncTimer();
      syncRetryTimer();
      position();
      if (syncForm) {
        if (keepDraft) return;
        goalInput.value = state && state.goal ? String(state.goal) : '';
        const criteria = state && Array.isArray(state.criteria) ? state.criteria : [];
        renderCriteria(criteria.length ? criteria : ['']);
        setDurationFromMinutes(
          state && state.maxDurationMinutes
            ? Number(state.maxDurationMinutes)
            : limits.maxDurationMinutesDefault,
        );
        formDirty = false;
      }
    }

    function addCriterionRow(value) {
      if (criteriaList.children.length >= MAX_CRITERIA) return;
      const row = el('div', 'unat-criterion');
      row.dataset.criterionRow = '1';
      const input = el('input', 'unat-criterion-input');
      input.type = 'text';
      input.maxLength = CRITERION_MAX_LENGTH;
      input.placeholder = tr('unattendedCriterionPlaceholder');
      input.value = value ? String(value).slice(0, CRITERION_MAX_LENGTH) : '';
      input.dataset.criterion = '1';
      input.addEventListener('input', () => { formDirty = true; });
      const remove = el('button', 'unat-criterion-remove', '×');
      remove.type = 'button';
      remove.title = tr('unattendedCriterionRemove');
      remove.setAttribute('aria-label', tr('unattendedCriterionRemove'));
      remove.onclick = () => {
        row.remove();
        // Always keep one row to type into, mirroring the old criteria editor.
        if (!criteriaList.children.length) addCriterionRow('');
        formDirty = true;
        addCriterion.disabled = criteriaList.children.length >= MAX_CRITERIA;
      };
      row.append(input, remove);
      criteriaList.append(row);
      addCriterion.disabled = criteriaList.children.length >= MAX_CRITERIA;
    }

    function renderCriteria(items) {
      criteriaList.replaceChildren();
      const values = (Array.isArray(items) ? items : []).slice(0, MAX_CRITERIA);
      for (const value of values) addCriterionRow(value);
      if (!values.length) addCriterionRow('');
    }

    // ── form input ──────────────────────────────────────────────────────────
    goalInput.addEventListener('input', () => { formDirty = true; });
    durationInput.addEventListener('input', () => { formDirty = true; });
    durationUnit.addEventListener('change', () => { syncDurationBounds(); formDirty = true; });
    addCriterion.addEventListener('click', () => { addCriterionRow(''); formDirty = true; });

    function durationUnitMinutes() { return durationUnit.value === 'h' ? 60 : 1; }

    // 输入框的 min/max 跟着单位走（小时模式下 1–24），发送前再按 limits 夹一次。
    function syncDurationBounds() {
      const perUnit = durationUnitMinutes();
      durationInput.min = String(Math.max(1, Math.ceil(limits.maxDurationMinutesMin / perUnit)));
      durationInput.max = String(Math.max(1, Math.floor(limits.maxDurationMinutesMax / perUnit)));
    }

    function collectDurationMinutes() {
      const parsed = parseInt(durationInput.value, 10);
      if (!Number.isFinite(parsed)) return limits.maxDurationMinutesDefault;
      return clampInt(parsed * durationUnitMinutes(), limits.maxDurationMinutesMin,
        limits.maxDurationMinutesMax, limits.maxDurationMinutesDefault);
    }

    // 从服务端状态回填：整小时用小时显示（2 小时），否则用分钟（90 分）。
    function setDurationFromMinutes(minutes) {
      const total = clampInt(minutes, limits.maxDurationMinutesMin, limits.maxDurationMinutesMax,
        limits.maxDurationMinutesDefault);
      if (total >= 60 && total % 60 === 0) {
        durationUnit.value = 'h';
        durationInput.value = String(total / 60);
      } else {
        durationUnit.value = 'm';
        durationInput.value = String(total);
      }
      syncDurationBounds();
    }

    function collectCriteria() {
      const values = [...criteriaList.querySelectorAll('input[data-criterion]')]
        .map(input => String(input.value || '').trim())
        .filter(Boolean)
        .slice(0, MAX_CRITERIA)
        .map(value => value.slice(0, CRITERION_MAX_LENGTH));
      return values;
    }

    function collectForm() {
      const goal = String(goalInput.value || '').trim().slice(0, GOAL_MAX_LENGTH);
      return {
        goal,
        criteria: collectCriteria(),
        maxDurationMinutes: collectDurationMinutes(),
      };
    }
    syncDurationBounds();

    // ── API ─────────────────────────────────────────────────────────────────
    function sessionPath() {
      const id = getSessionId();
      return id ? `/api/sessions/${encodeURIComponent(id)}/unattended` : '';
    }

    function showError(message) {
      errorLine.textContent = message || '';
      errorLine.hidden = !message;
    }

    function errorMessage(error, fallbackKey) {
      const code = (error && (error.code || (error.envelope && error.envelope.code))) || '';
      if (code === 'goal_required') return tr('unattendedGoalRequired');
      return tr(fallbackKey || 'unattendedActionFailed', { error: errorText(error) });
    }

    function applyPayload(data, syncForm) {
      if (data && data.limits && typeof data.limits === 'object') {
        const next = {
          maxDurationMinutesDefault: Number(data.limits.maxDurationMinutesDefault),
          maxDurationMinutesMin: Number(data.limits.maxDurationMinutesMin),
          maxDurationMinutesMax: Number(data.limits.maxDurationMinutesMax),
        };
        // 缺 limits（老服务端）就保留兜底值；maxDurationMinutes* 的 limits 是新的
        // 唯一一组，旧的 maxRounds* 即使还在也不再读。
        limits = {
          maxDurationMinutesDefault: Number.isFinite(next.maxDurationMinutesDefault) && next.maxDurationMinutesDefault > 0
            ? next.maxDurationMinutesDefault : DURATION_LIMITS.maxDurationMinutesDefault,
          maxDurationMinutesMin: Number.isFinite(next.maxDurationMinutesMin) && next.maxDurationMinutesMin > 0
            ? next.maxDurationMinutesMin : DURATION_LIMITS.maxDurationMinutesMin,
          maxDurationMinutesMax: Number.isFinite(next.maxDurationMinutesMax) && next.maxDurationMinutesMax > 0
            ? next.maxDurationMinutesMax : DURATION_LIMITS.maxDurationMinutesMax,
        };
        if (limits.maxDurationMinutesMax < limits.maxDurationMinutesMin) {
          limits.maxDurationMinutesMax = limits.maxDurationMinutesMin;
        }
      }
      state = data && data.unattended != null ? data.unattended : null;
      if (!panelOpen) formDirty = false;
      render(syncForm && (!formDirty || !panelOpen));
    }

    async function refresh(syncForm) {
      const path = sessionPath();
      if (!path) {
        state = null;
        render(false);
        return;
      }
      try {
        const data = await request(path, { method: 'GET' });
        applyPayload(data, syncForm !== false);
      } catch (_) {
        // 读不到就先按未启用画；面板里的动作会给出具体错误。
        render(false);
      }
    }

    async function act(action, extra) {
      if (busy) return;
      const path = sessionPath();
      if (!path) {
        showError(tr('unattendedNoSession'));
        return;
      }
      // Only clear keeps the typed form as a draft; every other action adopts
      // the state the server returns.
      keepDraft = action === 'clear';
      busy = true;
      showError('');
      render(false);
      try {
        const data = await request(path, { method: 'POST', json: { action, ...(extra || {}) } });
        formDirty = keepDraft;
        applyPayload(data, !keepDraft);
      } catch (error) {
        keepDraft = false;
        showError(errorMessage(error));
      } finally {
        busy = false;
        render(false);
      }
    }

    function startWithForm() {
      const form = collectForm();
      if (!form.goal) {
        showError(tr('unattendedGoalRequired'));
        goalInput.focus();
        return;
      }
      void act('start', { ...form, evaluateNow: true });
    }

    // 启动前自动预检（只有 start 走这条路，update/resume 不预检）：目标不清楚或
    // 判断标准缺失时先给一张可编辑的「目标预检」卡，让用户采用建议或按原样启动。
    async function start() {
      if (busy || precheckBusy) return;
      const form = collectForm();
      if (!form.goal) {
        showError(tr('unattendedGoalRequired'));
        goalInput.focus();
        return;
      }
      precheckBusy = true;
      showError('');
      closePrecheck();
      startBtn.textContent = tr('unattendedCheckingGoal');
      render(false);
      let launch = false;
      try {
        if (!precheckWaitMs) await loadPrecheckBudget();
        const data = await request('/api/goal/precheck', {
          method: 'POST',
          json: { task: form.goal },
          timeoutMs: goalPrecheckTimeoutMs(),
        });
        if (data && data.ok === false) throw data;
        const issues = Array.isArray(data && data.issues) ? data.issues.filter(Boolean) : [];
        if (data && data.verdict === 'ok' && !issues.length && form.criteria.length) {
          // (a) 目标清晰、标准也在：直接启动，不打断。
          launch = true;
        } else {
          // (b) 有疑点 / 缺标准：不启动，展示可编辑的建议与三个动作。
          renderPrecheck(data || {}, { mode: 'start', criteria: form.criteria });
        }
      } catch (_) {
        // (c) 预检挂了也不能把人堵死：给「仍然启动 / 取消」，绝不静默启动。
        renderPrecheckUnavailable();
      } finally {
        precheckBusy = false;
        startBtn.textContent = tr('unattendedStart');
        render(false);
      }
      if (launch) await act('start', { ...form, evaluateNow: true });
    }

    function update() {
      const form = collectForm();
      if (!form.goal) {
        showError(tr('unattendedGoalRequired'));
        goalInput.focus();
        return;
      }
      void act('update', form);
    }

    // ── precheck ────────────────────────────────────────────────────────────
    // 预检结果卡：手动「AI 补全判断标准」与启动前自动预检共用同一套渲染。
    //   mode=draft：只展示结论 + 「采用改写版」（标准已直接填进上方各行）。
    //   mode=start：展示结论 + 可编辑的建议目标/标准 + 三个动作。
    function precheckIssueList(data, criteria) {
      const issues = Array.isArray(data && data.issues) ? data.issues.filter(Boolean).map(String) : [];
      const has = text => issues.some(item => item.includes(text));
      if (!issues.length && data && data.verdict !== 'ok') issues.push(tr('unattendedGoalUnclear'));
      if (!criteria.length && !has(tr('unattendedMissingCriteria'))) {
        issues.push(tr('unattendedMissingCriteria'));
      }
      return issues;
    }

    function precheckSummary(data) {
      const ok = data && data.verdict === 'ok';
      const summary = el('div', 'unat-precheck-verdict ' + (ok ? 'ok' : 'warn'),
        ok ? tr('unattendedPrecheckOk') : tr('unattendedPrecheckWarn'));
      if (data && data.score != null) {
        summary.append(' · ' + tr('unattendedPrecheckScore', { score: data.score }));
      }
      return summary;
    }

    function parseCriteriaText(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, MAX_CRITERIA)
        .map(line => line.slice(0, CRITERION_MAX_LENGTH));
    }

    function closePrecheck() {
      precheckBox.hidden = true;
      precheckBox.replaceChildren();
    }

    function adoptRecommendation(goalNode, criteriaNode) {
      const goal = String(goalNode.value || '').trim().slice(0, GOAL_MAX_LENGTH);
      if (!goal) {
        showError(tr('unattendedGoalRequired'));
        goalNode.focus();
        return;
      }
      void act('start', {
        goal,
        criteria: parseCriteriaText(criteriaNode.value),
        maxDurationMinutes: collectDurationMinutes(),
        evaluateNow: true,
      });
    }

    function renderStartCard(data, criteria, revised) {
      const goalText = revised || String(goalInput.value || '').trim();
      const suggested = Array.isArray(data && data.criteria) && data.criteria.length
        ? data.criteria
        : criteria;
      const goalField = el('label', 'unat-field');
      goalField.append(el('span', 'unat-label', tr('unattendedRecommendGoal')));
      const goalNode = el('textarea', 'unat-revised-goal');
      goalNode.rows = 2;
      goalNode.maxLength = GOAL_MAX_LENGTH;
      goalNode.value = String(goalText || '').slice(0, GOAL_MAX_LENGTH);
      goalField.append(goalNode);
      const criteriaField = el('label', 'unat-field');
      criteriaField.append(el('span', 'unat-label', tr('unattendedRecommendCriteria')));
      const criteriaNode = el('textarea', 'unat-revised-criteria');
      criteriaNode.rows = 3;
      criteriaNode.value = parseCriteriaText(suggested.join('\n')).join('\n');
      criteriaField.append(criteriaNode);
      const actions = el('div', 'unat-precheck-actions');
      const adopt = el('button', 'unat-precheck-adopt unat-primary', tr('unattendedPrecheckAdopt'));
      const original = el('button', 'unat-precheck-original', tr('unattendedPrecheckStartOriginal'));
      const cancel = el('button', 'unat-precheck-cancel', tr('unattendedPrecheckCancel'));
      for (const button of [adopt, original, cancel]) button.type = 'button';
      // 注意：这里不能按 precheckBusy 禁用 —— 这张卡就是预检返回时（busy 仍为 true）
      // 画出来的，禁用会让主按钮永远点不动。重复点击由 start/act 的 busy 守卫兜住。
      adopt.onclick = () => adoptRecommendation(goalNode, criteriaNode);
      original.onclick = () => { closePrecheck(); startWithForm(); };
      cancel.onclick = closePrecheck;
      actions.append(adopt, original, cancel);
      precheckBox.append(goalField, criteriaField, actions);
    }

    function renderPrecheck(data, options) {
      const mode = options && options.mode === 'start' ? 'start' : 'draft';
      const criteria = options && Array.isArray(options.criteria) ? options.criteria : collectCriteria();
      precheckBox.replaceChildren();
      precheckBox.hidden = false;
      if (mode === 'start') precheckBox.append(el('div', 'unat-precheck-title', tr('unattendedPrecheckTitle')));
      precheckBox.append(precheckSummary(data));
      const issues = precheckIssueList(data, criteria);
      if (issues.length) {
        precheckBox.append(el('p', 'unat-precheck-issues', tr('unattendedPrecheckIssues', { items: issues.join('；') })));
      }
      const revised = data && typeof data.revised === 'string' ? data.revised.trim() : '';
      if (mode === 'start') {
        renderStartCard(data, criteria, revised);
        return;
      }
      if (revised && revised !== String(goalInput.value || '').trim()) {
        const row = el('div', 'unat-revised');
        row.append(el('span', 'unat-revised-text', revised.slice(0, 600)));
        const use = el('button', 'unat-use-revised', tr('unattendedUseRevised'));
        use.type = 'button';
        use.onclick = () => {
          goalInput.value = revised.slice(0, GOAL_MAX_LENGTH);
          formDirty = true;
          row.remove();
        };
        row.append(use);
        precheckBox.append(row);
      }
    }

    // 预检不可用（超时 / 辅助模型故障）：说明情况，给出「仍然启动 / 取消」。
    function renderPrecheckUnavailable() {
      precheckBox.replaceChildren();
      precheckBox.hidden = false;
      precheckBox.append(el('div', 'unat-precheck-verdict warn', tr('unattendedPrecheckUnavailable')));
      precheckBox.append(el('p', 'unat-precheck-issues', tr('unattendedPrecheckUnavailableHint')));
      const actions = el('div', 'unat-precheck-actions');
      const still = el('button', 'unat-precheck-adopt unat-primary', tr('unattendedStillStart'));
      const cancel = el('button', 'unat-precheck-cancel', tr('unattendedPrecheckCancel'));
      still.type = 'button';
      cancel.type = 'button';
      still.onclick = () => { closePrecheck(); startWithForm(); };
      cancel.onclick = closePrecheck;
      actions.append(still, cancel);
      precheckBox.append(actions);
    }

    async function draft() {
      if (precheckBusy || busy) return;
      const goal = String(goalInput.value || '').trim();
      if (!goal) {
        showError(tr('unattendedGoalRequired'));
        goalInput.focus();
        return;
      }
      precheckBusy = true;
      draftBtn.disabled = true;
      draftBtn.textContent = tr('unattendedDrafting');
      showError('');
      render(false);
      try {
        if (!precheckWaitMs) await loadPrecheckBudget();
        const data = await request('/api/goal/precheck', {
          method: 'POST',
          json: { task: goal },
          timeoutMs: goalPrecheckTimeoutMs(),
        });
        if (data && data.ok === false) throw data;
        const criteria = Array.isArray(data && data.criteria) ? data.criteria : [];
        if (criteria.length) {
          renderCriteria(criteria);
          formDirty = true;
        }
        renderPrecheck(data || {}, { mode: 'draft', criteria: criteria.length ? criteria : collectCriteria() });
      } catch (error) {
        showError(errorMessage(error, 'unattendedDraftFailed'));
      } finally {
        precheckBusy = false;
        draftBtn.disabled = false;
        draftBtn.textContent = tr('unattendedDraftCriteria');
        render(false);
      }
    }

    // ── open / close ────────────────────────────────────────────────────────
    function open() {
      if (panelOpen) return;
      panelOpen = true;
      panel.hidden = false;
      scrim.hidden = false;
      fab.setAttribute('aria-expanded', 'true');
      formDirty = false;
      position();
      showError('');
      void refresh(true);
    }

    function close() {
      if (!panelOpen) return;
      panelOpen = false;
      panel.hidden = true;
      scrim.hidden = true;
      fab.setAttribute('aria-expanded', 'false');
    }

    function toggle() { if (panelOpen) close(); else open(); }

    fab.addEventListener('click', event => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      toggle();
    });
    closeBtn.addEventListener('click', close);
    scrim.addEventListener('click', close);
    doc.addEventListener('keydown', event => {
      if (panelOpen && event && event.key === 'Escape') close();
    });
    startBtn.addEventListener('click', start);
    updateBtn.addEventListener('click', update);
    stopBtn.addEventListener('click', () => void act('stop'));
    resumeBtn.addEventListener('click', () => void act('resume'));
    clearBtn.addEventListener('click', () => void act('clear'));
    draftBtn.addEventListener('click', () => void draft());
    bannerBtn.addEventListener('click', () => {
      const action = bannerBtn.dataset.action;
      if (action === 'stop' || action === 'resume') void act(action);
    });
    bannerClearBtn.addEventListener('click', () => void act('clear'));

    function mount() {
      if (mounted) return;
      mounted = true;
      root.append(scrim, panel);
      doc.body.append(root, fab);
      // banner 贴在输入栏正上方；chat.html/Air iframe 里 #input-bar 都有父节点。
      const bar = byId('input-bar');
      if (bar && bar.parentNode) bar.parentNode.insertBefore(banner, bar);
      else doc.body.append(banner);
      position();
      if (typeof win.ResizeObserver === 'function') {
        if (bar) new win.ResizeObserver(() => position()).observe(bar);
        new win.ResizeObserver(() => position()).observe(banner);
      }
      win.addEventListener('resize', position);
      if (win.visualViewport) win.visualViewport.addEventListener('resize', position);
      const input = byId('input');
      if (input) input.addEventListener('input', () => position());
    }

    mount();
    render(false);
    void refresh(true);

    return Object.freeze({
      // WS { type: 'unattended_state' } —— 服务端每次变更都广播，连接时也会重放一次。
      applyState(value) {
        state = value == null ? null : value;
        if (!panelOpen) formDirty = false;
        render(!formDirty || !panelOpen);
        syncTimer();
      },
      refresh: () => refresh(true),
      open,
      close,
      position,
      isOpen: () => panelOpen,
      // 仅为测试/宿主清理暴露：30 秒倒计时表是否还挂着。
      isTicking: () => !!tickTimer,
      destroy() {
        if (tickTimer) {
          win.clearInterval(tickTimer);
          tickTimer = null;
        }
        clearRetryTimer();
        try {
          fab.remove();
          root.remove();
          banner.remove();
        } catch (_) { /* 节点可能已被宿主移走 */ }
        mounted = false;
        state = null;
        inputLocked = false;
      },
    });
  }

  global.MultiCCChatUnattended = Object.freeze({ create });
})(window);
