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
  const ROUNDS_HARD_MAX = 200;
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
    let limits = { maxRoundsDefault: 30, maxRoundsMax: ROUNDS_HARD_MAX };
    let mounted = false;
    let panelOpen = false;
    let formDirty = false;
    let busy = false;
    let precheckBusy = false;
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
    const humanReason = el('p', 'unat-human');
    humanReason.hidden = true;
    // pausedBy（v2）：用户接管 / 输入触发 / 取消，三种暂停原因都落在状态块里。
    const pausedLine = el('p', 'unat-paused');
    pausedLine.hidden = true;
    const verdictLine = el('p', 'unat-verdict');
    verdictLine.hidden = true;
    statusCard.append(statusLine, humanReason, pausedLine, verdictLine);

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

    const roundsField = el('label', 'unat-field unat-rounds-field');
    roundsField.append(el('span', 'unat-label', tr('unattendedMaxRounds')));
    const roundsInput = el('input', 'unat-rounds');
    roundsInput.type = 'number';
    roundsInput.min = '1';
    roundsInput.max = String(ROUNDS_HARD_MAX);
    roundsInput.value = '30';
    const roundsHint = el('span', 'unat-hint', tr('unattendedMaxRoundsRange'));
    const roundsRow = el('span', 'unat-rounds-row');
    roundsRow.append(roundsInput, roundsHint);
    roundsField.append(roundsRow);

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

    body.append(statusCard, goalField, criteriaField, roundsField, draftBtn, precheckBox, historyBox, errorLine);

    const footer = el('div', 'unat-actions');
    const startBtn = el('button', 'unat-primary', tr('unattendedStart'));
    const updateBtn = el('button', '', tr('unattendedSave'));
    const stopBtn = el('button', 'unat-stop', tr('unattendedStop'));
    const resumeBtn = el('button', 'unat-primary', tr('unattendedResume'));
    for (const button of [startBtn, updateBtn, stopBtn, resumeBtn]) button.type = 'button';
    startBtn.dataset.action = 'start';
    updateBtn.dataset.action = 'update';
    stopBtn.dataset.action = 'stop';
    resumeBtn.dataset.action = 'resume';
    footer.append(stopBtn, updateBtn, resumeBtn, startBtn);

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
    banner.append(bannerMain, bannerReason, bannerBtn);

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

    // banner 的「为什么暂停」：需要人工时优先给 humanReason，其余看 pausedBy。
    function bannerReasonText() {
      const status = state && state.status;
      if (status === 'needs_human') {
        const reason = String(state.lastVerdict?.humanReason || state.lastVerdict?.reason || '');
        return reason ? tr('unattendedHumanReason', { reason }) : statusWord();
      }
      return pausedByText();
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
      const label = tr('unattendedFabTooltip') + ' · ' + statusWord()
        + (state?.evaluating ? ' · ' + tr('unattendedJudging') : '');
      fab.title = label;
      fab.setAttribute('aria-label', label);
    }

    function renderStatus() {
      statusLabel.textContent = statusWord();
      statusLabel.className = 'unat-status-label unat-status-' + (state && state.status ? state.status : 'idle');
      evaluating.hidden = !(state && state.evaluating);
      if (state) {
        roundLabel.textContent = tr('unattendedRoundProgress', {
          round: Number(state.rounds) || 0,
          max: Number(state.maxRounds) || limits.maxRoundsDefault,
        });
        roundLabel.hidden = false;
      } else {
        roundLabel.textContent = '';
        roundLabel.hidden = true;
      }
      const needsHuman = state && state.status === 'needs_human';
      const reason = needsHuman ? String(state.lastVerdict?.humanReason || state.lastVerdict?.reason || '') : '';
      humanReason.hidden = !reason;
      humanReason.textContent = reason ? tr('unattendedHumanReason', { reason }) : '';
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
      for (const button of [startBtn, updateBtn, stopBtn, resumeBtn]) button.disabled = busy;
      draftBtn.disabled = busy || precheckBusy;
      addCriterion.disabled = busy;
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
      bannerBtn.disabled = busy;
      if (active) {
        bannerText.textContent = tr('unattendedBannerActive', {
          round: Number(state.rounds) || 0,
          max: Number(state.maxRounds) || limits.maxRoundsDefault,
        });
        bannerSpinner.hidden = !state.evaluating;
        bannerReason.hidden = true;
        bannerReason.textContent = '';
        bannerBtn.textContent = tr('unattendedPauseTakeover');
        bannerBtn.dataset.action = 'stop';
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
        banner.hidden = false;
        return;
      }
      bannerReason.hidden = true;
      bannerReason.textContent = '';
      banner.hidden = true;
    }

    function render(syncForm) {
      renderFab();
      renderStatus();
      renderActions();
      renderBanner();
      position();
      if (syncForm) {
        goalInput.value = state && state.goal ? String(state.goal) : '';
        const criteria = state && Array.isArray(state.criteria) ? state.criteria : [];
        renderCriteria(criteria.length ? criteria : ['']);
        roundsInput.value = String(
          state && state.maxRounds ? state.maxRounds : (limits.maxRoundsDefault || 30),
        );
        roundsInput.max = String(limits.maxRoundsMax || ROUNDS_HARD_MAX);
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
    roundsInput.addEventListener('input', () => { formDirty = true; });
    addCriterion.addEventListener('click', () => { addCriterionRow(''); formDirty = true; });

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
        maxRounds: clampInt(roundsInput.value, 1, limits.maxRoundsMax || ROUNDS_HARD_MAX,
          limits.maxRoundsDefault || 30),
      };
    }

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
        limits = {
          maxRoundsDefault: Number(data.limits.maxRoundsDefault) || limits.maxRoundsDefault,
          maxRoundsMax: Number(data.limits.maxRoundsMax) || limits.maxRoundsMax,
        };
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
      busy = true;
      showError('');
      render(false);
      try {
        const data = await request(path, { method: 'POST', json: { action, ...(extra || {}) } });
        formDirty = false;
        applyPayload(data, true);
      } catch (error) {
        showError(errorMessage(error));
      } finally {
        busy = false;
        render(false);
      }
    }

    function start() {
      const form = collectForm();
      if (!form.goal) {
        showError(tr('unattendedGoalRequired'));
        goalInput.focus();
        return;
      }
      void act('start', { ...form, evaluateNow: true });
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
    function renderPrecheck(data) {
      precheckBox.replaceChildren();
      precheckBox.hidden = false;
      const ok = data && data.verdict === 'ok';
      const summary = el('div', 'unat-precheck-verdict ' + (ok ? 'ok' : 'warn'),
        ok ? tr('unattendedPrecheckOk') : tr('unattendedPrecheckWarn'));
      precheckBox.append(summary);
      if (data && data.score != null) {
        summary.append(' · ' + tr('unattendedPrecheckScore', { score: data.score }));
      }
      const issues = Array.isArray(data && data.issues) ? data.issues.filter(Boolean) : [];
      if (issues.length) {
        precheckBox.append(el('p', 'unat-precheck-issues', tr('unattendedPrecheckIssues', { items: issues.join('；') })));
      }
      const revised = data && typeof data.revised === 'string' ? data.revised.trim() : '';
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
        renderPrecheck(data || {});
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
    draftBtn.addEventListener('click', () => void draft());
    bannerBtn.addEventListener('click', () => {
      const action = bannerBtn.dataset.action;
      if (action === 'stop' || action === 'resume') void act(action);
    });

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
      },
      refresh: () => refresh(true),
      open,
      close,
      position,
      isOpen: () => panelOpen,
    });
  }

  global.MultiCCChatUnattended = Object.freeze({ create });
})(window);
