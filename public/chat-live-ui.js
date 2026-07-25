(function attachMultiCCChatLiveUi(global) {
  'use strict';

  function bindHeaderMoreMenu(options) {
    const opts = options || {};
    const win = opts.window || global;
    const doc = opts.document || win.document;
    const button = opts.button;
    const menu = opts.menu;
    const wrap = opts.wrap;
    const ids = opts.ids || [];
    let backdrop = null;

    function close() {
      menu?.classList.remove('open');
      if (!backdrop) return;
      wrap?.appendChild(menu);
      backdrop.remove();
      backdrop = null;
    }

    function open() {
      close();
      if (win.innerWidth <= 760) {
        backdrop = doc.createElement('div');
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.appendChild(menu);
        doc.body.appendChild(backdrop);
        backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
      }
      menu?.classList.add('open');
    }

    function sync() {
      if (!menu || !wrap) return;
      const header = doc.getElementById('header');
      if (!header) return;
      if (win.innerWidth <= 760) {
        for (const id of ids) {
          const element = doc.getElementById(id);
          if (element && element.parentElement !== menu) menu.appendChild(element);
        }
      } else {
        for (const id of ids) {
          const element = doc.getElementById(id);
          if (element && element.parentElement !== header) header.insertBefore(element, wrap);
        }
        close();
      }
    }

    button?.addEventListener('click', event => {
      event.stopPropagation();
      if (!menu?.classList.contains('open')) open();
    });
    menu?.addEventListener('click', event => { if (event.target.closest('.hdr-btn')) close(); });
    doc.addEventListener('click', event => {
      if (wrap && !wrap.contains(event.target) && (!backdrop || !backdrop.contains(event.target))) close();
    });
    win.addEventListener('resize', sync);
    win.setTimeout(sync, 0);
    return Object.freeze({ sync, open, close });
  }

  function accumulateLiveUsage(usage, bucket) {
    if (!usage) return bucket;
    const next = bucket || { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0 };
    if (typeof usage.input_tokens === 'number') next.inputTokens += usage.input_tokens;
    if (typeof usage.output_tokens === 'number' && usage.output_tokens > next.outputTokens) {
      next.outputTokens = usage.output_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === 'number') next.cacheWrite += usage.cache_creation_input_tokens;
    if (typeof usage.cache_read_input_tokens === 'number') next.cacheRead += usage.cache_read_input_tokens;
    return next;
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m${Math.round(seconds % 60)}s`;
  }

  function createLiveUi(options) {
    const opts = options || {};
    const doc = opts.document || global.document;
    const messagesEl = opts.messagesEl;
    const translate = opts.translate || (key => key);
    const maybeScroll = opts.maybeScrollToBottom || (() => {});
    const retryTransport = opts.retryTransport || (() => {});
    const isRestarting = opts.isRestarting || (() => false);
    const debug = opts.debug || (() => {});
    const setTimer = opts.setTimeout || global.setTimeout.bind(global);
    const clearTimer = opts.clearTimeout || global.clearTimeout.bind(global);
    // Optional host hook: when the user manually dismisses a background-task
    // danmaku row, notify the host with its task id so it can (best-effort)
    // request a real cancel. Absent → the ✕ button just clears the row locally.
    const onDanmakuDismiss = opts.onDanmakuDismiss || null;
    // Optional host hook: manual "mark task done" from the classify bar. The bar
    // only reveals the button while the aux state is waiting-for-user (W).
    const onMarkTaskDone = opts.onMarkTaskDone || null;
    const onCancelTask = opts.onCancelTask || null;
    const _markDoneBtn = doc.getElementById('ac-mark-done');
    if (_markDoneBtn) {
      _markDoneBtn.addEventListener('click', () => {
        _markDoneBtn.disabled = true;
        try { if (onMarkTaskDone) onMarkTaskDone(); } catch (_) {}
      });
    }
    const _cancelTaskBtn = doc.getElementById('ac-cancel-task');
    if (_cancelTaskBtn) {
      _cancelTaskBtn.addEventListener('click', () => {
        _cancelTaskBtn.disabled = true;
        try { if (onCancelTask) onCancelTask(); } catch (_) {}
      });
    }

    const danmaku = {
      collapsed: false,
      hideTimer: null,
      fadeTimer: null,
      initialized: false,
      rows: new Map(),
    };
    const DANMAKU_MAX_ROWS = 8;
    const DANMAKU_AUTOHIDE_MS = 5000;
    const DANMAKU_STALE_MS = 180000;
    let thinkingEl = null;
    let disconnectBannerEl = null;
    let titleTimer = null;
    let titleDots = 0;

    function metric(parent, className, text, title) {
      const span = doc.createElement('span');
      span.className = className;
      span.textContent = text;
      if (title) span.title = title;
      parent.appendChild(span);
      return span;
    }

    function buildUsageLine(usage, roleBreakdown) {
      if (!usage && !roleBreakdown) return null;
      const input = (usage && usage.input_tokens) || 0;
      const output = (usage && usage.output_tokens) || 0;
      const cacheRead = (usage && usage.cache_read_input_tokens) || 0;
      const cacheWrite = (usage && usage.cache_creation_input_tokens) || 0;
      const number = value => Number(value || 0).toLocaleString('en-US');
      const short = value => value > 1e6
        ? `${(value / 1e6).toFixed(2)}M`
        : value > 1e3 ? `${(value / 1e3).toFixed(1)}k` : Number(value || 0).toLocaleString('en-US');

      if (roleBreakdown && (roleBreakdown.main || roleBreakdown.sub)) {
        const summarize = value => value ? {
          input: value.inputTokens || 0,
          output: value.outputTokens || 0,
          cacheRead: value.cacheRead || 0,
          cacheWrite: value.cacheWrite || 0,
          total: (value.inputTokens || 0) + (value.outputTokens || 0)
            + (value.cacheRead || 0) + (value.cacheWrite || 0),
        } : null;
        const main = summarize(roleBreakdown.main);
        const sub = summarize(roleBreakdown.sub);
        const totals = {
          input: (main?.input || 0) + (sub?.input || 0),
          output: (main?.output || 0) + (sub?.output || 0),
          cacheRead: (main?.cacheRead || 0) + (sub?.cacheRead || 0),
          cacheWrite: (main?.cacheWrite || 0) + (sub?.cacheWrite || 0),
        };
        const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
        if (!total) return null;
        const line = doc.createElement('div');
        line.className = 'msg-usage';
        let tooltip = '本条消息 token 用量（非会话累计）\n';
        if (main) {
          tooltip += `— 主 — 输入 ${number(main.input)} 输出 ${number(main.output)} 缓存读 ${number(main.cacheRead)} 缓存写 ${number(main.cacheWrite)}\n`;
        }
        if (sub) {
          tooltip += `— 辅 — 输入 ${number(sub.input)} 输出 ${number(sub.output)} 缓存读 ${number(sub.cacheRead)} 缓存写 ${number(sub.cacheWrite)}\n`;
          for (const provider of (roleBreakdown.subByProvider || [])) {
            tooltip += `    · ${provider.name || provider.providerId} / ${provider.model || '?'}: ↑入 ${number(provider.inputTokens)} ↓出 ${number(provider.outputTokens)}\n`;
          }
        }
        line.title = tooltip.trim();
        metric(line, 'u-in', `↑入 ${number(totals.input)}`);
        metric(line, 'u-out', `↓出 ${number(totals.output)}`);
        if (totals.cacheRead) metric(line, 'u-cache', `♻读 ${number(totals.cacheRead)}`);
        if (totals.cacheWrite) metric(line, 'u-cache', `♻写 ${number(totals.cacheWrite)}`);
        if (main) metric(
          line, 'u-role', `主 ↑${short(main.input)} ↓${short(main.output)}`,
          `本条消息主循环：输入 ${number(main.input)} / 输出 ${number(main.output)}`,
        );
        if (sub) metric(
          line, 'u-role', `辅 ↑${short(sub.input)} ↓${short(sub.output)}`,
          `本条消息子任务：输入 ${number(sub.input)} / 输出 ${number(sub.output)}`,
        );
        return line;
      }

      if (input + output + cacheRead + cacheWrite === 0) return null;
      const line = doc.createElement('div');
      line.className = 'msg-usage';
      line.title = `本条消息 token 用量（非会话累计）\n输入 ${number(input)}\n输出 ${number(output)}\n缓存读 ${number(cacheRead)}\n缓存写 ${number(cacheWrite)}`;
      metric(line, 'u-in', `↑入 ${number(input)}`);
      metric(line, 'u-out', `↓出 ${number(output)}`);
      if (cacheRead) metric(line, 'u-cache', `♻读 ${number(cacheRead)}`);
      if (cacheWrite) metric(line, 'u-cache', `♻写 ${number(cacheWrite)}`);
      return line;
    }

    function buildTimingLine(message) {
      const timestamp = Number(message && message.ts);
      const hasTimestamp = Number.isFinite(timestamp) && timestamp > 0;
      const duration = Number(message && message.durationMs);
      const hasDuration = Number.isFinite(duration) && duration >= 0;
      if (!hasTimestamp && !hasDuration) return null;
      const line = doc.createElement('div');
      line.className = 'msg-timing';
      line.style.cssText = 'font-size:11px;color:#6e7681;display:flex;gap:10px;padding:1px 0;';
      if (hasTimestamp) {
        const date = new Date(timestamp);
        const clock = [date.getHours(), date.getMinutes(), date.getSeconds()]
          .map(value => String(value).padStart(2, '0')).join(':');
        metric(line, '', `🕰 ${clock}`, '回复时间');
      }
      if (hasDuration) metric(line, '', `⏱ ${fmtDuration(duration)}`, '本次交互耗时');
      return line;
    }

    function attachUsageLine(bubbleEl, usage, roleBreakdown) {
      if (!bubbleEl) return;
      const content = bubbleEl.querySelector('.msg-content');
      if (!content) return;
      content.querySelector('.msg-usage')?.remove();
      const line = buildUsageLine(usage, roleBreakdown);
      if (line) content.appendChild(line);
    }

    function classifyDisplay(classifyState) {
      const map = {
        D: { label: translate('classifyDone'), barTint: 'completed', voice: translate('voiceTaskCompleted'), ding: 'completed' },
        C: { label: translate('classifyContinuing'), barTint: 'running', voice: null, ding: null },
        W: { label: translate('classifyWaitingUser'), barTint: 'waiting', voice: translate('voiceWaitingAction'), ding: 'waiting' },
        B: { label: translate('classifyWaitingBackground'), barTint: 'waiting', voice: translate('voiceWaitingBackground'), ding: 'waiting' },
        E: { label: translate('classifyApiError'), barTint: 'error', voice: translate('voiceApiInterrupted'), ding: 'error' },
        P: { label: translate('classifyProcessing'), barTint: 'running', voice: null, ding: null },
      };
      return map[classifyState] || map.W;
    }

    function renderAuxClassify(goal, phase, classifyState) {
      const bar = doc.getElementById('aux-classify-bar');
      if (!bar) return;
      const normalizedGoal = String(goal || '').trim();
      if (!normalizedGoal) { bar.classList.remove('show', 'can-mark-done', 'can-cancel-task'); return; }
      const goalEl = doc.getElementById('ac-goal');
      const phaseEl = doc.getElementById('ac-phase');
      const stateEl = doc.getElementById('ac-state');
      if (goalEl) { goalEl.textContent = normalizedGoal; goalEl.title = normalizedGoal; }
      const phaseLabels = {
        planning: translate('phasePlanning'), implementing: translate('phaseImplementing'),
        verifying: translate('phaseVerifying'), wrapping: translate('phaseWrapping'), done: translate('phaseDone'),
      };
      const phaseLabel = phaseLabels[String(phase || '').toLowerCase()] || '';
      if (phaseEl) { phaseEl.textContent = phaseLabel; phaseEl.style.display = phaseLabel ? '' : 'none'; }
      const display = classifyDisplay(classifyState || 'P');
      bar.classList.remove('lc-running', 'lc-completed', 'lc-waiting', 'lc-interrupted',
        'st-running', 'st-completed', 'st-waiting', 'st-error');
      if (stateEl) { stateEl.textContent = display.label; stateEl.style.display = ''; }
      bar.classList.add(`st-${display.barTint}`);
      bar.classList.toggle('can-mark-done', (classifyState || 'P') === 'W');
      bar.classList.toggle('can-cancel-task', (classifyState || 'P') === 'P');
      if ((classifyState || 'P') !== 'P' && _cancelTaskBtn) _cancelTaskBtn.disabled = false;
      bar.classList.add('show');
    }

    // Persistent transport-level liveness pill in the chat header. `verdict` is
    // the JSON from GET /api/sessions/:id/liveness. A falsy verdict hides it.
    function renderLiveness(verdict) {
      const pill = doc.getElementById('liveness-pill');
      if (!pill) return;
      if (!verdict || !verdict.state) { pill.style.display = 'none'; return; }
      const disp = livenessDisplay(verdict.state);
      const dotEl = doc.getElementById('liveness-pill-dot');
      const labelEl = doc.getElementById('liveness-pill-label');
      let label = translate(disp.labelKey);
      // Show the silent duration on a stalled/quiet turn so "stuck for 3m" reads
      // at a glance instead of a bare state word.
      const silentMs = Number(verdict.silentMs);
      if ((verdict.state === 'stalled' || verdict.state === 'working') && Number.isFinite(silentMs) && silentMs >= 5000) {
        label += ` · ${fmtDuration(silentMs)}`;
      }
      if (labelEl) labelEl.textContent = label;
      if (dotEl) {
        dotEl.classList.remove('lv-working', 'lv-idle', 'lv-stalled', 'lv-unknown');
        dotEl.classList.add(`lv-${disp.dot}`);
      }
      pill.title = verdict.reason ? `liveness: ${verdict.state} (${verdict.reason})` : `liveness: ${verdict.state}`;
      pill.style.display = '';
    }

    function danmakuElements() {
      return {
        panel: doc.getElementById('danmaku-panel'), head: doc.getElementById('danmaku-head'),
        body: doc.getElementById('danmaku-body'), title: doc.getElementById('danmaku-title'),
        count: doc.getElementById('danmaku-count'), dot: doc.getElementById('danmaku-dot'),
        button: doc.getElementById('danmaku-collapse-btn'),
      };
    }

    function hasRunningDanmaku() {
      for (const row of danmaku.rows.values()) if (row.state === 'start') return true;
      return false;
    }

    function refreshDanmakuMeta() {
      const elements = danmakuElements();
      if (!elements.panel) return;
      elements.dot.className = hasRunningDanmaku() ? 'dm-dot-running' : 'dm-dot-idle';
      elements.count.textContent = (danmaku.collapsed || !danmaku.rows.size) ? '' : String(danmaku.rows.size);
      elements.title.textContent = danmaku.collapsed ? `${danmaku.rows.size} 后台任务` : '后台任务';
    }

    function showDanmaku() {
      const elements = danmakuElements();
      if (!elements.panel) return;
      clearTimer(danmaku.fadeTimer);
      elements.panel.style.display = 'flex';
      elements.panel.style.opacity = '1';
    }

    function scheduleDanmakuHide() {
      clearTimer(danmaku.hideTimer);
      danmaku.hideTimer = null;
      if (danmaku.collapsed || hasRunningDanmaku()) return;
      danmaku.hideTimer = setTimer(() => {
        const elements = danmakuElements();
        if (!elements.panel) return;
        elements.panel.style.opacity = '0';
        danmaku.fadeTimer = setTimer(() => {
          elements.panel.style.display = 'none';
          for (const row of danmaku.rows.values()) clearTimer(row.staleTimer);
          danmaku.rows.clear();
          if (elements.body) elements.body.textContent = '';
          refreshDanmakuMeta();
        }, 320);
      }, DANMAKU_AUTOHIDE_MS);
    }

    function setDanmakuRowState(row, state) {
      clearTimer(row.staleTimer);
      row.staleTimer = null;
      row.state = state;
      row.element.className = `dm-row dm-${state}`;
      row.icon.className = 'dm-ic';
      row.icon.textContent = '';
      if (state === 'start') {
        const spinner = doc.createElement('span');
        spinner.className = 'dm-spin';
        row.icon.appendChild(spinner);
        row.staleTimer = setTimer(() => {
          if (row.state !== 'start') return;
          setDanmakuRowState(row, 'stale');
          refreshDanmakuMeta();
          scheduleDanmakuHide();
        }, DANMAKU_STALE_MS);
      } else if (state === 'stale') row.icon.textContent = '·';
      else row.icon.textContent = state === 'fail' ? '✗' : '✓';
    }

    function toggleDanmakuCollapse() {
      const elements = danmakuElements();
      if (!elements.panel) return;
      danmaku.collapsed = !danmaku.collapsed;
      elements.panel.classList.toggle('dm-collapsed', danmaku.collapsed);
      elements.button.textContent = danmaku.collapsed ? '▸' : '▾';
      refreshDanmakuMeta();
      if (danmaku.collapsed) { clearTimer(danmaku.hideTimer); showDanmaku(); }
      else scheduleDanmakuHide();
    }

    function initDanmaku() {
      if (danmaku.initialized) return;
      const elements = danmakuElements();
      if (!elements.panel) return;
      danmaku.initialized = true;
      elements.button.addEventListener('click', event => { event.stopPropagation(); toggleDanmakuCollapse(); });
      elements.head.addEventListener('click', () => { if (danmaku.collapsed) toggleDanmakuCollapse(); });
    }

    function pushDanmaku(kind, description, taskId) {
      initDanmaku();
      const elements = danmakuElements();
      if (!elements.panel) return;
      const text = String(description || '').trim() || '后台任务';
      const key = taskId ? `t:${taskId}` : `d:${text}`;
      const rowState = kind === 'progress' ? 'start' : kind;
      const existing = danmaku.rows.get(key);
      if (existing) {
        if (kind === 'start') { showDanmaku(); return; }
        setDanmakuRowState(existing, rowState);
        existing.text.textContent = text;
        refreshDanmakuMeta(); showDanmaku(); scheduleDanmakuHide();
        return;
      }
      if (danmaku.rows.size >= DANMAKU_MAX_ROWS) {
        const oldestKey = danmaku.rows.keys().next().value;
        const oldest = danmaku.rows.get(oldestKey);
        if (oldest) { clearTimer(oldest.staleTimer); oldest.element.remove(); }
        danmaku.rows.delete(oldestKey);
      }
      const rowEl = doc.createElement('div');
      const icon = doc.createElement('span');
      const textEl = doc.createElement('span');
      textEl.className = 'dm-txt';
      textEl.textContent = text;
      // Manual dismiss: a ✕ the user can click to stop/hide a stuck row without
      // waiting out the 180s stale timer. It also asks the host to cancel the
      // underlying task when one is known.
      const closeBtn = doc.createElement('button');
      closeBtn.className = 'dm-close';
      closeBtn.type = 'button';
      closeBtn.textContent = '✕';
      closeBtn.title = '停掉这条后台任务提示';
      closeBtn.addEventListener('click', event => { event.stopPropagation(); dismissDanmakuRow(key); });
      rowEl.append(icon, textEl, closeBtn);
      const row = { element: rowEl, icon, text: textEl, key, state: rowState, staleTimer: null, confirmedBg: false };
      setDanmakuRowState(row, rowState);
      elements.body.prepend(rowEl);
      danmaku.rows.set(key, row);
      showDanmaku(); refreshDanmakuMeta(); scheduleDanmakuHide();
    }

    function danmakuOnDisconnect() {
      let changed = false;
      for (const row of danmaku.rows.values()) {
        if (row.state === 'start') { setDanmakuRowState(row, 'stale'); changed = true; }
      }
      if (changed) { refreshDanmakuMeta(); scheduleDanmakuHide(); }
    }

    // User-initiated dismiss of a single danmaku row (the ✕ button). Clears its
    // timers, removes it, and — if it is a task-keyed row — asks the host to
    // cancel the underlying background task. Always local-safe: with no host
    // hook it simply stops showing the row.
    function dismissDanmakuRow(key) {
      const row = danmaku.rows.get(key);
      if (!row) return;
      clearTimer(row.staleTimer);
      row.staleTimer = null;
      try { row.element.remove(); } catch (_) {}
      danmaku.rows.delete(key);
      if (typeof onDanmakuDismiss === 'function' && key.startsWith('t:')) {
        try { onDanmakuDismiss(key.slice(2)); } catch (_) {}
      }
      refreshDanmakuMeta();
      scheduleDanmakuHide();
    }

    // Reconcile spinning rows against the authoritative active-task set from the
    // server's `background_tasks` snapshot. A task-keyed row seen in the snapshot
    // is confirmed as a real background task; once it later drops out of the set
    // (i.e. it finished) we settle it, so a lost `monitor_done` can't leave the
    // spinner running forever.
    function reconcileDanmakuTasks(activeTaskIds) {
      const active = new Set((activeTaskIds || []).map(String));
      let changed = false;
      for (const [key, row] of danmaku.rows) {
        if (!key.startsWith('t:')) continue;
        const taskId = key.slice(2);
        if (active.has(taskId)) { row.confirmedBg = true; continue; }
        if (row.confirmedBg && row.state === 'start') { setDanmakuRowState(row, 'stale'); changed = true; }
      }
      if (changed) { refreshDanmakuMeta(); scheduleDanmakuHide(); }
    }

    // Called when a chat turn fully ends. Any row still spinning that was never
    // confirmed as a real background task is a turn-scoped/synchronous tool (or
    // one whose `monitor_done` was lost); settle it now instead of waiting out
    // the 180s stale timer. Confirmed background tasks legitimately outlive the
    // turn and are left untouched (they re-arm on their next progress event).
    function settleTurnScopedDanmaku() {
      let changed = false;
      for (const row of danmaku.rows.values()) {
        if (row.state === 'start' && !row.confirmedBg) { setDanmakuRowState(row, 'stale'); changed = true; }
      }
      if (changed) { refreshDanmakuMeta(); scheduleDanmakuHide(); }
    }

    function showThinking() {
      if (thinkingEl) { debug('think', 'showThinking() — 已在显示，忽略'); return; }
      thinkingEl = doc.createElement('div');
      thinkingEl.className = 'thinking-bubble';
      const dots = doc.createElement('div');
      dots.className = 'thinking-dots';
      dots.append(doc.createElement('span'), doc.createElement('span'), doc.createElement('span'));
      thinkingEl.append(dots, doc.createTextNode(' Thinking...'));
      messagesEl.appendChild(thinkingEl);
      maybeScroll();
      debug('think', 'showThinking() — 气泡已显示');
    }

    function hideThinking() {
      if (!thinkingEl) return;
      thinkingEl.remove();
      thinkingEl = null;
      debug('think', 'hideThinking() — 气泡已移除');
    }

    function showDisconnectBanner(seconds) {
      if (isRestarting()) return;
      if (!disconnectBannerEl) {
        disconnectBannerEl = doc.createElement('div');
        disconnectBannerEl.className = 'msg system-msg disconnect-banner';
        disconnectBannerEl.addEventListener('click', retryTransport);
        messagesEl.appendChild(disconnectBannerEl);
      }
      disconnectBannerEl.textContent = `⚠️ 连接断开，${seconds}s 后自动重连（点此立即重试）`;
      maybeScroll();
    }

    function clearDisconnectBanner() {
      if (!disconnectBannerEl) return false;
      disconnectBannerEl.remove();
      disconnectBannerEl = null;
      return true;
    }

    function startTitleAnimation() {
      if (titleTimer) return;
      titleDots = 0;
      titleTimer = global.setInterval(() => {
        titleDots = (titleDots % 3) + 1;
        doc.title = `${opts.getBaseTitle?.() || 'MultiCC Chat'} ${'.'.repeat(titleDots)}`;
      }, 500);
    }

    function stopTitleAnimation() {
      if (titleTimer) { global.clearInterval(titleTimer); titleTimer = null; }
      doc.title = opts.getBaseTitle?.() || 'MultiCC Chat';
    }

    function renderDiff(container, text) {
      if (!container) return;
      container.textContent = '';
      const source = String(text || '');
      if (!source.trim()) {
        const empty = doc.createElement('div');
        empty.className = 'diff-line diff-meta';
        empty.style.cssText = 'text-align:center;padding:24px;';
        empty.textContent = '（无变更）';
        container.appendChild(empty);
        return;
      }
      const lines = source.split('\n');
      const visible = lines.slice(0, 5000);
      for (const raw of visible) {
        const line = doc.createElement('span');
        line.className = 'diff-line';
        if (/^[+\- ]*(<<<<<<<|=======|>>>>>>>)/.test(raw)) line.classList.add('diff-conflict');
        else if (/^(diff --git|diff --cc|index |\+\+\+ |--- |new file|deleted file|rename |similarity )/.test(raw)) line.classList.add('diff-head');
        else if (raw.startsWith('@@')) line.classList.add('diff-hunk');
        else if (raw.startsWith('+')) line.classList.add('diff-add');
        else if (raw.startsWith('-')) line.classList.add('diff-del');
        line.textContent = raw || '\u00a0';
        container.appendChild(line);
      }
      if (lines.length > visible.length) {
        const omitted = doc.createElement('span');
        omitted.className = 'diff-line diff-meta';
        omitted.textContent = `… 行数过多已截断（${lines.length - visible.length} 行省略）`;
        container.appendChild(omitted);
      }
    }

    function dialog(message, dialogOptions, alertOnly) {
      const settings = dialogOptions || {};
      return new Promise(resolve => {
        const overlay = doc.createElement('div');
        overlay.className = 'chat-dialog-backdrop';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';
        const box = doc.createElement('div');
        box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;width:420px;max-width:94vw;color:#c9d1d9;box-shadow:0 18px 60px rgba(0,0,0,.45);';
        if (settings.title) {
          const heading = doc.createElement('div');
          heading.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:10px;color:#f2f4f7;';
          heading.textContent = String(settings.title);
          box.appendChild(heading);
        }
        const text = doc.createElement('div');
        text.style.cssText = 'font-size:14px;line-height:1.6;white-space:pre-wrap;margin-bottom:12px;';
        text.textContent = String(message || '');
        const actions = doc.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        const cancel = alertOnly ? null : doc.createElement('button');
        if (cancel) { cancel.className = 'btn'; cancel.textContent = settings.cancelText || translate('cancel'); actions.appendChild(cancel); }
        const ok = doc.createElement('button');
        ok.className = settings.danger ? 'btn btn-red' : 'btn btn-green';
        ok.textContent = settings.okText || (alertOnly ? translate('acknowledge') : translate('confirm'));
        actions.appendChild(ok);
        box.append(text, actions); overlay.appendChild(box); doc.body.appendChild(overlay);
        const finish = result => {
          doc.removeEventListener('keydown', onKey, true);
          overlay.remove();
          resolve(result);
        };
        function onKey(event) {
          if (event.key === 'Escape') { event.preventDefault(); finish(alertOnly ? undefined : false); }
          else if (alertOnly && event.key === 'Enter') { event.preventDefault(); finish(); }
          else if (!alertOnly && settings.enterConfirms && event.key === 'Enter') { event.preventDefault(); finish(true); }
        }
        if (cancel) cancel.addEventListener('click', () => finish(false));
        ok.addEventListener('click', () => finish(alertOnly ? undefined : true));
        overlay.addEventListener('click', event => {
          if (event.target === overlay) finish(alertOnly ? undefined : false);
        });
        doc.addEventListener('keydown', onKey, true);
        setTimer(() => ok.focus(), 0);
      });
    }

    function prompt(title, defaultValue, promptOptions) {
      const settings = promptOptions || {};
      return new Promise(resolve => {
        const backdrop = doc.createElement('div');
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:12000;background:#0009;display:flex;align-items:center;justify-content:center;padding:18px;';
        const card = doc.createElement('div');
        card.style.cssText = 'width:min(92vw,440px);background:#0f1115;border:1px solid #30363d;border-radius:10px;box-shadow:0 18px 60px #000c;color:#e7eaee;overflow:hidden;';
        const heading = doc.createElement('div');
        heading.textContent = String(title || '');
        heading.style.cssText = 'padding:14px 16px;border-bottom:1px solid #20242b;font-size:15px;font-weight:700;color:#f2f4f7;';
        const body = doc.createElement('div');
        body.style.cssText = 'padding:16px;';
        const input = doc.createElement('input');
        input.type = 'text';
        input.value = defaultValue || '';
        input.maxLength = settings.maxLength || 80;
        input.placeholder = settings.placeholder || '';
        input.style.cssText = 'width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:7px;padding:9px 11px;font-size:14px;color:#e7eaee;outline:none;';
        body.appendChild(input);
        const actions = doc.createElement('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #20242b;';
        const cancel = doc.createElement('button');
        cancel.textContent = settings.cancelText || translate('cancel');
        cancel.style.cssText = 'border:1px solid #30363d;background:#161b22;color:#c9d1d9;border-radius:7px;padding:7px 13px;font-weight:700;cursor:pointer;';
        const ok = doc.createElement('button');
        ok.textContent = settings.okText || translate('save');
        ok.style.cssText = 'border:1px solid #58a6ff;background:#1f6feb;color:#fff;border-radius:7px;padding:7px 13px;font-weight:700;cursor:pointer;';
        actions.append(cancel, ok);
        card.append(heading, body, actions);
        backdrop.appendChild(card);
        doc.body.appendChild(backdrop);
        const finish = value => { doc.removeEventListener('keydown', onKey); backdrop.remove(); resolve(value); };
        function onKey(event) {
          if (event.key === 'Escape') { event.preventDefault(); finish(null); }
          else if (event.key === 'Enter') { event.preventDefault(); finish(input.value.trim()); }
        }
        cancel.addEventListener('click', () => finish(null));
        ok.addEventListener('click', () => finish(input.value.trim()));
        backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(null); });
        doc.addEventListener('keydown', onKey);
        setTimer(() => { input.focus(); input.select(); }, 0);
      });
    }

    function showCliSwitchPicker(current, states, availability, cliMeta, hooks) {
      const hk = hooks || {};
      const hasHooks = !!(hk.fetchSpecs && hk.installCli && hk.pollInstall);
      return new Promise(resolve => {
        // 本地可用性快照: 安装完成后就地更新, 既刷新 option 文案也放行确认切换
        const availLocal = Object.assign({}, availability || {});
        const optionMap = {};
        let specs = null;            // {<cli>:{auto,command?,display?,manual?}}
        let specsLoading = false;
        let installJob = null;       // {cli, jobId, status, logTail, error, command}
        let pollTimer = null;
        let closed = false;          // 弹窗关闭后阻止 in-flight 安装/轮询回调再排定时器

        const overlay = doc.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
        const box = doc.createElement('div');
        box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;width:460px;max-width:94vw;color:#c9d1d9;box-shadow:0 18px 60px rgba(0,0,0,.45);';
        const title = doc.createElement('div');
        title.style.cssText = 'font-size:17px;font-weight:700;margin-bottom:8px;';
        title.textContent = '切换 CLI';
        const description = doc.createElement('div');
        description.style.cssText = 'font-size:12px;color:#8b949e;line-height:1.65;margin-bottom:14px;';
        description.textContent = '切换后，目标 CLI 会接着当前任务继续工作。每个 CLI 的原对话都会单独保留。';
        const select = doc.createElement('select');
        select.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:7px;color:#c9d1d9;font-size:14px;padding:9px 10px;outline:none;margin-bottom:10px;';
        for (const [value, meta] of Object.entries(cliMeta || {})) {
          const sessionState = states && states[value];
          const installed = availLocal[value]?.available !== false;
          const option = doc.createElement('option');
          option.value = value;
          // hooks 缺省时退化为旧行为: 未安装 option 禁用; 有 hooks 时可选, 文案仍带 "· 未安装"
          option.disabled = !installed && value !== current && !hasHooks;
          option.textContent = `${meta.label}${value === current ? '（当前）' : ''}${installed ? (sessionState?.hasNativeSession ? ' · 继续上次对话' : ' · 开始新对话') : ' · 未安装'}`;
          optionMap[value] = option;
          select.appendChild(option);
        }
        select.value = current;
        const targetInfo = doc.createElement('div');
        targetInfo.style.cssText = 'min-height:34px;font-size:12px;color:#8b949e;line-height:1.5;margin-bottom:8px;';
        const resetRow = doc.createElement('label');
        resetRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#c9d1d9;background:#0d1117;border:1px solid #30363d;border-radius:7px;padding:9px;margin-bottom:14px;cursor:pointer;';
        const reset = doc.createElement('input');
        reset.type = 'checkbox';
        reset.style.marginTop = '2px';
        const resetText = doc.createElement('span');
        resetText.textContent = '重新开始目标 CLI（仅在切换后无法继续时勾选，当前任务信息会保留）';
        resetRow.append(reset, resetText);
        const warning = doc.createElement('div');
        warning.style.cssText = 'font-size:12px;color:#d29922;line-height:1.55;margin-bottom:14px;';
        warning.textContent = '如果当前回复仍在运行，确认切换会直接终止该回复并清空排队消息；已保存的历史与任务上下文会保留。';
        const actions = doc.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        const cancel = doc.createElement('button');
        cancel.textContent = '取消';
        cancel.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 15px;cursor:pointer;';
        const ok = doc.createElement('button');
        ok.textContent = '确认切换';
        ok.style.cssText = 'background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:7px 15px;cursor:pointer;';
        actions.append(cancel, ok);

        const stopPolling = () => { if (pollTimer) { clearTimer(pollTimer); pollTimer = null; } };
        const isInstalled = cli => availLocal[cli]?.available !== false
          || (installJob && installJob.cli === cli && installJob.status === 'done');
        const setOkEnabled = on => {
          ok.disabled = !on;
          ok.style.opacity = on ? '1' : '0.55';
          ok.style.cursor = on ? 'pointer' : 'not-allowed';
        };
        const refreshOptionLabel = cli => {
          const option = optionMap[cli];
          if (!option) return;
          const meta = cliMeta?.[cli];
          const sessionState = states && states[cli];
          const installed = isInstalled(cli);
          option.textContent = `${meta.label}${cli === current ? '（当前）' : ''}${installed ? (sessionState?.hasNativeSession ? ' · 继续上次对话' : ' · 开始新对话') : ' · 未安装'}`;
        };

        // 渲染进行中/完成/失败状态的安装面板(写入 targetInfo)
        const renderInstallState = () => {
          const job = installJob;
          const meta = cliMeta?.[job.cli];
          const label = meta?.label || job.cli;
          if (job.status === 'done') {
            setOkEnabled(true);
            const done = doc.createElement('div');
            done.style.cssText = 'color:#3fb950;';
            done.textContent = `安装完成, 可以切换到 ${label}。`;
            targetInfo.appendChild(done);
            return;
          }
          if (job.status === 'error') {
            setOkEnabled(false);
            const err = doc.createElement('div');
            err.style.cssText = 'color:#f85149;white-space:pre-wrap;margin-bottom:6px;';
            err.textContent = job.error || '安装失败。';
            targetInfo.appendChild(err);
            if (job.hint) {
              const hint = doc.createElement('div');
              hint.style.cssText = 'color:#d29922;white-space:pre-wrap;margin-bottom:6px;';
              hint.textContent = job.hint;
              targetInfo.appendChild(hint);
            }
            if (job.logTail) {
              const log = doc.createElement('div');
              log.style.cssText = 'font-family:ui-monospace,monospace;font-size:11px;color:#8b949e;white-space:pre-wrap;max-height:140px;overflow:auto;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:6px;margin-bottom:6px;';
              log.textContent = job.logTail;
              targetInfo.appendChild(log);
            }
            const spec = specs?.[job.cli];
            const cmdText = spec?.display || spec?.command || job.command || '';
            if (cmdText) {
              const cmd = doc.createElement('div');
              cmd.style.cssText = 'font-family:ui-monospace,monospace;font-size:11px;color:#8b949e;white-space:pre-wrap;margin-bottom:6px;word-break:break-all;';
              cmd.textContent = cmdText;
              targetInfo.appendChild(cmd);
            }
            const retry = doc.createElement('button');
            retry.textContent = '重试';
            retry.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:5px 11px;cursor:pointer;';
            retry.addEventListener('click', () => startInstall(job.cli));
            targetInfo.appendChild(retry);
            return;
          }
          // running: spinner + 状态 + 最近 logTail
          setOkEnabled(false);
          const row = doc.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
          const spinner = doc.createElement('span');
          spinner.textContent = '⏳';
          const status = doc.createElement('span');
          status.style.cssText = 'color:#c9d1d9;';
          status.textContent = '安装中...';
          row.append(spinner, status);
          targetInfo.appendChild(row);
          if (job.logTail) {
            const log = doc.createElement('div');
            log.style.cssText = 'font-family:ui-monospace,monospace;font-size:11px;color:#8b949e;white-space:pre-wrap;max-height:120px;overflow:auto;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:6px;';
            log.textContent = job.logTail;
            targetInfo.appendChild(log);
            log.scrollTop = log.scrollHeight;
          }
        };

        const updateInfo = () => {
          targetInfo.textContent = '';
          const cli = select.value;
          const meta = cliMeta?.[cli];
          const label = meta?.label || cli;
          // 有进行中/已完成/失败的安装任务: 优先展示其状态面板(done 也显示"安装完成, 可以切换")
          if (installJob && installJob.cli === cli) {
            renderInstallState();
            return;
          }
          if (isInstalled(cli)) {
            const sessionState = states && states[cli];
            targetInfo.textContent = sessionState?.hasNativeSession
              ? `将继续 ${label} 上次的对话，并带上切换后新增的内容。`
              : `将打开新的 ${label} 对话，并带上当前任务信息。`;
            setOkEnabled(true);
            return;
          }
          // 未安装: 暂不允许确认切换
          setOkEnabled(false);
          if (!hasHooks) {
            targetInfo.textContent = `${label} 未安装。`;
            return;
          }
          if (specsLoading) {
            targetInfo.textContent = '正在加载安装信息...';
            return;
          }
          const spec = specs?.[cli];
          if (!spec) {
            targetInfo.textContent = `${label} 暂无可用的安装信息。`;
            return;
          }
          if (spec.auto === false) {
            const manual = doc.createElement('div');
            manual.style.cssText = 'white-space:pre-wrap;color:#c9d1d9;';
            manual.textContent = spec.manual || '需要手动安装。';
            targetInfo.appendChild(manual);
            return;
          }
          // auto: 一键安装按钮 + 将执行的命令
          const row = doc.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:10px;';
          const btn = doc.createElement('button');
          btn.textContent = '一键安装';
          btn.style.cssText = 'background:#1f6feb;border:1px solid #388bfd;border-radius:6px;color:#fff;font-size:12px;padding:6px 12px;cursor:pointer;white-space:nowrap;';
          const cmd = doc.createElement('div');
          cmd.style.cssText = 'flex:1;min-width:0;font-family:ui-monospace,monospace;color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          const cmdText = spec.display || spec.command || '';
          cmd.textContent = cmdText;
          cmd.title = cmdText;
          row.append(btn, cmd);
          targetInfo.appendChild(row);
          btn.addEventListener('click', () => startInstall(cli));
        };

        const startInstall = async cli => {
          if (!hasHooks) return;
          installJob = { cli, jobId: null, status: 'running', logTail: '', error: null, command: '' };
          updateInfo();
          try {
            const res = await hk.installCli(cli);
            if (closed) return;
            if (res && res.alreadyInstalled) {
              installJob = { cli, jobId: null, status: 'done', logTail: '', error: null, command: '' };
              availLocal[cli] = { available: true };
              if (hk.onAvailabilityChange) { try { hk.onAvailabilityChange(cli); } catch (_) {} }
              refreshOptionLabel(cli);
              stopPolling();
              updateInfo();
              return;
            }
            if (res && res.jobId) {
              // 202 新任务 / 409 已有 running 任务: 都拿 jobId 直接接管轮询
              installJob = { cli, jobId: res.jobId, status: 'running', logTail: '', error: null, command: '' };
              startPolling(cli);
              updateInfo();
              return;
            }
            installJob = { cli, jobId: null, status: 'error', logTail: '', error: (res && res.error) || '安装失败。', command: '' };
            updateInfo();
          } catch (e) {
            installJob = { cli, jobId: null, status: 'error', logTail: '', error: (e && e.message) || '安装失败。', command: '' };
            updateInfo();
          }
        };

        const startPolling = cli => {
          stopPolling();
          const tick = async () => {
            const job = installJob;
            if (!job || job.cli !== cli || !job.jobId) return;
            try {
              const res = await hk.pollInstall(job.jobId);
              if (closed) return;
              if (res && res.transient) { pollTimer = setTimer(tick, 2000); return; }
              const j = res && res.job;
              if (!j) {
                // 404/未知 jobId: 终态, 当失败处理, 不再轮询
                installJob = { cli, jobId: job.jobId, status: 'error', logTail: job.logTail || '', error: (res && res.error) || '安装任务已失效。', command: job.command || '' };
                stopPolling();
                updateInfo();
                return;
              }
              installJob = {
                cli, jobId: job.jobId,
                status: j.status || 'running',
                logTail: j.logTail || job.logTail || '',
                error: j.error || null,
                command: j.command || job.command || '',
              };
              if (installJob.status === 'done') {
                availLocal[cli] = { available: true };
                if (hk.onAvailabilityChange) { try { hk.onAvailabilityChange(cli); } catch (_) {} }
                refreshOptionLabel(cli);
                stopPolling();
                updateInfo();
                return;
              }
              if (installJob.status === 'error') {
                stopPolling();
                updateInfo();
                return;
              }
              updateInfo();
              pollTimer = setTimer(tick, 2000);
            } catch (_) {
              // 瞬时网络错误: 继续轮询, 不打断
              if (closed) return;
              pollTimer = setTimer(tick, 2000);
            }
          };
          pollTimer = setTimer(tick, 2000);
        };

        select.addEventListener('change', updateInfo);
        updateInfo();
        box.append(title, description, select, targetInfo, resetRow, warning, actions);
        overlay.appendChild(box);
        doc.body.appendChild(overlay);
        // 弹窗关闭(取消/确认/遮罩)一律停轮询; 置 closed 阻断 in-flight 回调重排
        const close = value => { closed = true; stopPolling(); overlay.remove(); resolve(value); };
        cancel.addEventListener('click', () => close(null));
        ok.addEventListener('click', () => { if (ok.disabled) return; close({ cli: select.value, fresh: reset.checked }); });
        overlay.addEventListener('click', event => { if (event.target === overlay) close(null); });

        // 打开弹窗即拉取安装规格; 仅在 hooks 可用时
        if (hasHooks) {
          specsLoading = true;
          Promise.resolve().then(() => hk.fetchSpecs()).then(res => {
            specs = (res && res.specs) ? res.specs : res;
          }).catch(() => { specs = null; }).then(() => {
            specsLoading = false;
            if (doc.body.contains(overlay)) updateInfo();
          });
        }
      });
    }

    return Object.freeze({
      accumulateLiveUsage,
      fmtDuration,
      buildUsageLine,
      buildTimingLine,
      attachUsageLine,
      classifyDisplay,
      renderAuxClassify,
      renderLiveness,
      pushDanmaku,
      danmakuOnDisconnect,
      reconcileDanmakuTasks,
      settleTurnScopedDanmaku,
      dismissDanmakuRow,
      toggleDanmakuCollapse,
      showThinking,
      hideThinking,
      getThinkingElement: () => thinkingEl,
      showDisconnectBanner,
      clearDisconnectBanner,
      startTitleAnimation,
      stopTitleAnimation,
      renderDiff,
      confirm: (message, settings) => dialog(message, settings, false),
      alert: (message, settings) => dialog(message, settings, true),
      prompt,
      showCliSwitchPicker,
    });
  }

  // Pure liveness-state → display descriptor. Mirrors classifyDisplay but for the
  // transport-level liveness verdict (working / idle / stalled) from
  // GET /api/sessions/:id/liveness. Kept module-level and translate-free so it is
  // unit-testable; the label is localized at render time.
  function livenessDisplay(state) {
    switch (state) {
      case 'working': return { tint: 'running', dot: 'working', labelKey: 'livenessWorking' };
      case 'stalled': return { tint: 'error', dot: 'stalled', labelKey: 'livenessStalled' };
      case 'idle': return { tint: 'idle', dot: 'idle', labelKey: 'livenessIdle' };
      default: return { tint: 'idle', dot: 'unknown', labelKey: 'livenessUnknown' };
    }
  }

  const api = Object.freeze({ createLiveUi, accumulateLiveUsage, fmtDuration, bindHeaderMoreMenu, livenessDisplay });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatLiveUi = api;
})(typeof window !== 'undefined' ? window : globalThis);
