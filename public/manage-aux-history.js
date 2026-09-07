// AI Assistant (AuxQueue) history UI — extracted from manage.js to pay down
// its line-budget debt. Loaded right after manage.js: every host symbol it
// touches (escapeHtml, tt, _focusedSessionId, focusId/focusCwd, closeFocusPanel,
// focusSession, …) is already defined, and the closeFocusPanel/focusSession
// overrides below re-bind before any user interaction can fire.
/* ── AuxQueue: history viewer + WebSocket ── */
let _auxWs = null;
let _auxHistory = [];
let _auxConnected = false;
let _auxHealth = null;          // { unhealthy, consecutiveFails, lastFailMsg, sinceAt }
let _auxToastTimer = null;      // recurring 5-min reminder while unhealthy

// Aux health stays visible and re-alerts until the server reports recovery.
function handleAuxHealth(h) {
  const prev = _auxHealth;
  _auxHealth = h || null;
  const unhealthy = !!(h && h.unhealthy);
  if (unhealthy) {
    // Toast once per transition (not every 5s — the 5-min recurring timer handles re-remind).
    if (!prev || !prev.unhealthy) {
      showToast(`⚠️ 摘要服务异常（${h.consecutiveFails || 0} 次失败）：${(h.lastFailMsg || '未知错误').slice(0, 50)} — 状态判定暂停，修复后自动恢复`, true);
    }
    // Start the recurring reminder if not already running.
    if (!_auxToastTimer) {
      const remind = () => {
        showToast(`⚠️ 摘要服务异常：${(h.lastFailMsg || '未知错误').slice(0, 60)} — 已用规则判定，请修复`, true);
      };
      // Don't fire immediately on transition — the banner already says it. The
      // 5-min cadence is for "user walked away, task stalled, come fix it".
      _auxToastTimer = setTimeout(function loop() {
        if (!(_auxHealth && _auxHealth.unhealthy)) { _auxToastTimer = null; return; }
        remind();
        _auxToastTimer = setTimeout(loop, 5 * 60 * 1000);
      }, 5 * 60 * 1000);
    }
  } else if (prev && prev.unhealthy) {
    // Just recovered.
    if (_auxToastTimer) { clearTimeout(_auxToastTimer); _auxToastTimer = null; }
    showToast('摘要服务已恢复', false);
  }
}

async function auxConnect() {
  if (_auxWs && _auxWs.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url;
  try { url = await window.multiccWsUrl(`${proto}//${location.host}/ws/aux`); }
  catch (_) { setTimeout(auxConnect, 5000); return; }
  if (_auxWs && _auxWs.readyState <= 1) return;
  _auxWs = new WebSocket(url);

  _auxWs.onopen = () => { _auxConnected = true; };

  _auxWs.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'aux_history') {
        _auxHistory = msg.messages || [];
        if (_focusedSessionId === '__aux__') renderAuxPanel();
        if (_auxModalOpen()) renderAuxModal();
        renderAuxClassifyGrid();
      } else if (msg.type === 'aux_init') {
        // status info on connect — will be refreshed via /api/sessions
        if (msg.health) handleAuxHealth(msg.health);
      } else if (msg.type === 'aux_health') {
        handleAuxHealth(msg.health || {});
      } else if (msg.type === 'aux_event') {
        // Real-time task event — refresh history on completion
        if (msg.status === 'done' || msg.status === 'error') {
          // Fetch latest history from API so _auxHistory stays current
          fetch('/api/aux/history').then(r => r.json()).then(data => {
            _auxHistory = Array.isArray(data) ? data : _auxHistory;
            if (_focusedSessionId === '__aux__') renderAuxPanel();
            if (_auxModalOpen()) renderAuxModal();
            renderAuxClassifyGrid();
          }).catch(() => {});
          loadSessions();
        }
        if (_focusedSessionId === '__aux__') renderAuxTaskEvent(msg);
        if (_auxModalOpen()) renderAuxModal();
      }
    } catch (_) {}
  };

  _auxWs.onclose = () => {
    _auxConnected = false;
    setTimeout(auxConnect, 5000);
  };
  _auxWs.onerror = () => {};
}

// ── AI Assistant (aux) history — simple popup modal ──
// Replaces the old focus-panel side view: just pops a modal and renders the
// aux task history straight into it. No iframe, no panel juggling.
function openAuxHistoryModal() {
  acknowledgeSession('__aux__');
  const modal = document.getElementById('aux-history-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  auxConnect();                 // ensure the /ws/aux socket is live for updates
  renderAuxModal();             // paint whatever history we already have
}

function closeAuxHistoryModal() {
  const modal = document.getElementById('aux-history-modal');
  if (modal) modal.style.display = 'none';
}

function _auxModalOpen() {
  const m = document.getElementById('aux-history-modal');
  return m && m.style.display !== 'none';
}

// Render the aux task history into the modal body (newest first).
// Manual refresh of aux history (no WS push for the detail panel).
function refreshAuxHistory() {
  fetch('/api/aux/history?limit=100').then(r => r.json()).then(data => {
    if (Array.isArray(data)) {
      _auxHistory = data;
      if (_focusedSessionId === '__aux__') renderAuxPanel();
      if (_auxModalOpen()) renderAuxModal();
      renderAuxClassifyGrid();
    }
  }).catch(() => {});
}

function renderAuxModal() {
  const body = document.getElementById('aux-modal-body');
  if (!body) return;
  if (_auxHistory.length === 0) {
    body.innerHTML = '<div style="text-align:center;color:#484f58;padding:40px 0;">暂无任务记录</div>';
    return;
  }
  const tasks = [];
  for (let i = 0; i < _auxHistory.length; i++) {
    const msg = _auxHistory[i];
    if (msg.role === 'user' && i + 1 < _auxHistory.length && _auxHistory[i + 1].role === 'assistant') {
      tasks.push({ input: msg, output: _auxHistory[i + 1] });
      i++;
    } else if (msg.role === 'user') {
      tasks.push({ input: msg, output: null });
    }
  }
  tasks.reverse();
  const refreshBtn = '<div style=\'margin-bottom:10px;text-align:right;\'><button onclick=\'refreshAuxHistory()\' style=\'background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;\'>🔄 刷新</button></div>';
  body.innerHTML = refreshBtn + tasks.map((t, idx) => {
    const time = new Date(t.input.ts);
    const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
    const taskType = t.input.taskType || 'unknown';
    const meta = t.input.meta || {};
    const metaStr = meta.sessionName ? `session=${escapeHtml(meta.sessionName)}` : '';
    // Result column: the registry decides glyph and tone. A finished job shows its
    // own text next to ✅ instead of relying on green alone, an errored one gets ❌
    // (it used to be the bare word "ERR" in red), and a cancelled one gets 🚫
    // instead of sharing "pending"'s amber.
    const _reg = window.MultiCCStatusPresentation;
    let resultHtml = _reg.statusBadgeHtml('task', 'running', { translate: tt });
    let durationHtml = '';
    if (t.output) {
      const outStatus = t.output.error ? 'error' : (t.output.cancelled ? 'cancelled' : 'done');
      const text = (t.output.content || '').trim();
      resultHtml = _reg.statusBadgeHtml('task', outStatus, {
        translate: tt,
        label: outStatus === 'done' && text ? text : undefined,
      });
      if (t.output.durationMs) durationHtml = `<span style="color:#484f58;margin-left:8px;">${(t.output.durationMs / 1000).toFixed(1)}s</span>`;
    }
    const promptPreview = escapeHtml((t.input.content || '').split('\n').pop().slice(0, 80));
    const detailId = 'aux-modal-detail-' + idx;
    const inputFull = escapeHtml(t.input.content || '');
    const outputFull = t.output ? escapeHtml(t.output.content || '') : '';
    const o = t.output || {};
    const _fmt = (ms) => { if (!ms) return '-'; const d = new Date(ms); const p = (n,l=2) => String(n).padStart(l,'0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`; };
    const _sec = (ms) => (ms == null) ? '-' : (ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`);
    const tlCli = o.cli || t.input.cli || '';
    const tlTrans = o.transport || t.input.transport || '';
    const timeline = `<div style="color:#8b949e;margin-bottom:10px;font-size:11px;line-height:1.7;">
        <span style="color:#58a6ff;font-weight:600;">⏱ Timeline</span><br>
        入队: <span style="color:#c9d1d9;">${_fmt(o.enqueuedAt || t.input.ts)}</span> ·
        开始: <span style="color:#c9d1d9;">${_fmt(o.startedAt)}</span> ·
        完毕: <span style="color:#c9d1d9;">${_fmt(o.ts)}</span><br>
        排队: <span style="color:#d29922;">${_sec(o.queueMs)}</span> ·
        执行: <span style="color:#3fb950;">${_sec(o.durationMs)}</span>` +
        (tlCli ? ` · cli: <span style="color:#d2a8ff;">${escapeHtml(tlCli)}</span>` : '') +
        (tlTrans ? ` · transport: <span style="color:#d2a8ff;">${escapeHtml(tlTrans)}</span>` : '') + `
      </div>`;
    const detailHtml = `<div style="margin-top:8px;padding:8px;background:#0d1117;border-radius:6px;font-family:monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;">
        ${timeline}
        <div style="color:#58a6ff;font-weight:600;margin-bottom:4px;">📥 Input</div>
        <div style="color:#c9d1d9;margin-bottom:10px;">${inputFull}</div>
        <div style="color:#3fb950;font-weight:600;margin-bottom:4px;">📤 Output</div>
        <div style="color:#c9d1d9;">${outputFull || '<span style="color:#484f58;">(no output yet)</span>'}</div>
      </div>`;
    return `
      <div id="${detailId}-card" style="border-left:2px solid #8957e5;padding:6px 10px;margin-bottom:8px;background:#161b22;border-radius:0 6px 6px 0;cursor:pointer;" onclick="var d=document.getElementById('${detailId}');var c=document.getElementById('${detailId}-card');if(d.style.display==='none'){d.style.display='';c.style.background='#1c2128';}else{d.style.display='none';c.style.background='#161b22';}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="color:#484f58;">${timeStr}</span>
          <span style="color:#d2a8ff;font-weight:600;">${escapeHtml(taskType)}</span>
          <span style="color:#6e7681;">${metaStr}</span>
          <span style="margin-left:auto;">${resultHtml}${durationHtml}</span>
        </div>
        <div style="color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${promptPreview}</div>
        <div id="${detailId}" style="display:none;">${detailHtml}</div>
      </div>`;
  }).join('');
}

// Compact "latest classify tasks" grid on the right side of the overview's
// AI Assistant band (#aux-row). Same task-pair grouping as renderAuxModal,
// trimmed to 6 rows; clicking through opens the full history modal.
function renderAuxClassifyGrid() {
  const grid = document.getElementById('aux-cls-grid');
  if (!grid) return;
  const tasks = [];
  for (let i = 0; i < _auxHistory.length; i++) {
    const msg = _auxHistory[i];
    if (msg.role === 'user' && i + 1 < _auxHistory.length && _auxHistory[i + 1].role === 'assistant') {
      tasks.push({ input: msg, output: _auxHistory[i + 1] });
      i++;
    } else if (msg.role === 'user') {
      tasks.push({ input: msg, output: null });
    }
  }
  tasks.reverse();
  const recent = tasks.slice(0, 6);
  if (!recent.length) {
    grid.innerHTML = '<div class="aux-cls-empty">暂无任务记录</div>';
    return;
  }
  const _reg = window.MultiCCStatusPresentation;
  grid.innerHTML = recent.map(t => {
    const d = new Date(t.input.ts);
    const p = n => String(n).padStart(2, '0');
    const timeStr = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const sessName = (t.input.meta && t.input.meta.sessionName) || '';
    const preview = escapeHtml((t.input.content || '').split('\n').pop().slice(0, 60));
    let badge = _reg ? _reg.statusBadgeHtml('task', 'running', { translate: tt }) : '';
    let dur = '';
    if (t.output) {
      const outStatus = t.output.error ? 'error' : (t.output.cancelled ? 'cancelled' : 'done');
      badge = _reg ? _reg.statusBadgeHtml('task', outStatus, { translate: tt }) : '';
      if (t.output.durationMs) dur = `<span class="aux-cls-d">${(t.output.durationMs / 1000).toFixed(1)}s</span>`;
    }
    const title = escapeHtml((t.input.content || '') + (t.output ? '\n→ ' + (t.output.content || '') : ''));
    return `<span class="aux-cls-t">${timeStr}</span><span class="aux-cls-m" title="${title}"><b>${escapeHtml(t.input.taskType || 'classify')}</b>${sessName ? ' · ' + escapeHtml(sessName) : ''} · ${preview}</span><span class="aux-cls-v">${badge}${dur}</span>`;
  }).join('');
}

function focusAux() {
  acknowledgeSession('__aux__');
  if (_focusedSessionId === '__aux__') return;
  _focusedSessionId = '__aux__';

  document.body.classList.add('has-focus');
  focusId.textContent = 'AI Assistant';
  focusId.style.color = '#d2a8ff';
  focusCwd.textContent = 'AuxQueue — Intent Classification Service';

  // Hide all cached iframes + the original placeholder
  focusIframe.style.display = 'none';
  for (const [, frame] of _iframeCache) frame.style.display = 'none';

  // Show aux history panel
  let auxPanel = document.getElementById('aux-panel');
  if (!auxPanel) {
    auxPanel = document.createElement('div');
    auxPanel.id = 'aux-panel';
    auxPanel.style.cssText = 'flex:1;overflow-y:auto;padding:16px;font-family:monospace;font-size:12px;background:#0d1117;';
    focusContainer.appendChild(auxPanel);
  }
  auxPanel.style.display = '';
  renderAuxPanel();
  renderSessions(_cachedSessions);

  // Ensure WS connected
  auxConnect();
}

function renderAuxPanel() {
  const panel = document.getElementById('aux-panel');
  if (!panel) return;

  if (_auxHistory.length === 0) {
    panel.innerHTML = '<div style="text-align:center;color:#484f58;padding:40px 0;">No tasks yet</div>';
    return;
  }

  // Group history into task pairs (user prompt + assistant result)
  const tasks = [];
  for (let i = 0; i < _auxHistory.length; i++) {
    const msg = _auxHistory[i];
    if (msg.role === 'user' && i + 1 < _auxHistory.length && _auxHistory[i + 1].role === 'assistant') {
      tasks.push({ input: msg, output: _auxHistory[i + 1] });
      i++; // skip assistant
    } else if (msg.role === 'user') {
      tasks.push({ input: msg, output: null });
    }
  }

  // Reverse to show newest first
  tasks.reverse();

  const html = tasks.map((t, idx) => {
    const time = new Date(t.input.ts);
    const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
    const taskType = t.input.taskType || 'unknown';
    const meta = t.input.meta || {};
    const metaStr = meta.sessionName ? `session=${escapeHtml(meta.sessionName)}` : '';

    // Result column: the registry decides glyph and tone. A finished job shows its
    // own text next to ✅ instead of relying on green alone, an errored one gets ❌
    // (it used to be the bare word "ERR" in red), and a cancelled one gets 🚫
    // instead of sharing "pending"'s amber.
    const _reg = window.MultiCCStatusPresentation;
    let resultHtml = _reg.statusBadgeHtml('task', 'running', { translate: tt });
    let durationHtml = '';
    if (t.output) {
      const outStatus = t.output.error ? 'error' : (t.output.cancelled ? 'cancelled' : 'done');
      const text = (t.output.content || '').trim();
      resultHtml = _reg.statusBadgeHtml('task', outStatus, {
        translate: tt,
        label: outStatus === 'done' && text ? text : undefined,
      });
      if (t.output.durationMs) durationHtml = `<span style="color:#484f58;margin-left:8px;">${(t.output.durationMs / 1000).toFixed(1)}s</span>`;
    }

    // Truncated prompt preview
    const promptPreview = escapeHtml((t.input.content || '').split('\n').pop().slice(0, 80));
    const detailId = 'aux-panel-detail-' + idx;
    const inputFull = escapeHtml(t.input.content || '');
    const outputFull = t.output ? escapeHtml(t.output.content || '') : '';
    const detailHtml = `<div style="margin-top:8px;padding:8px;background:#0d1117;border-radius:6px;font-family:monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;">
        <div style="color:#58a6ff;font-weight:600;margin-bottom:4px;">📥 Input</div>
        <div style="color:#c9d1d9;margin-bottom:10px;">${inputFull}</div>
        <div style="color:#3fb950;font-weight:600;margin-bottom:4px;">📤 Output</div>
        <div style="color:#c9d1d9;">${outputFull || '<span style="color:#484f58;">(no output yet)</span>'}</div>
      </div>`;

    return `
      <div id="${detailId}-card" style="border-left:2px solid #8957e5;padding:6px 10px;margin-bottom:8px;background:#161b22;border-radius:0 6px 6px 0;cursor:pointer;" onclick="var d=document.getElementById('${detailId}');var c=document.getElementById('${detailId}-card');if(d.style.display==='none'){d.style.display='';c.style.background='#1c2128';}else{d.style.display='none';c.style.background='#161b22';}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="color:#484f58;">${timeStr}</span>
          <span style="color:#d2a8ff;font-weight:600;">${escapeHtml(taskType)}</span>
          <span style="color:#6e7681;">${metaStr}</span>
          <span style="margin-left:auto;">${resultHtml}${durationHtml}</span>
        </div>
        <div style="color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${promptPreview}</div>
        <div id="${detailId}" style="display:none;">${detailHtml}</div>
      </div>`;
  }).join('');

  panel.innerHTML = html;
}

function renderAuxTaskEvent(msg) {
  // For real-time events, just show a transient notification at top of panel
  const panel = document.getElementById('aux-panel');
  if (!panel) return;
  // Aux jobs are task-domain work: same registry, same glyphs as the task board.
  // It used to render the raw upper-cased status with a colour-only border.
  const reg = window.MultiCCStatusPresentation;
  const status = reg.coerceStatus('task', msg.status);
  const spec = reg.presentation('task', status);
  const existing = document.getElementById('aux-live-status');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'aux-live-status';
  div.className = `st-tone-${spec.tone}`;
  div.style.cssText = 'padding:8px 12px;margin-bottom:12px;background:#21262d;border-radius:6px;'
    + 'border:1px solid currentColor;font-weight:600;display:flex;align-items:center;gap:6px;';
  div.innerHTML = reg.statusBadgeHtml('task', status, { translate: tt })
    + '<span class="aux-live-detail" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>';
  div.querySelector('.aux-live-detail').textContent = [
    msg.task?.type || '',
    msg.result ? '→ ' + msg.result : '',
    // Job errors are backend strings: sanitize before showing (no tokens/paths).
    msg.error ? '→ ' + reg.sanitizeReason(msg.error) : '',
  ].filter(Boolean).join(' ');
  panel.prepend(div);
  // Auto-remove after 10s
  setTimeout(() => { if (div.parentNode) div.remove(); }, 10000);
}

// Override closeFocusPanel to also hide aux panel
const _origCloseFocus = closeFocusPanel;
closeFocusPanel = function() {
  const auxPanel = document.getElementById('aux-panel');
  if (auxPanel) auxPanel.style.display = 'none';
  focusId.style.color = ''; // reset color
  _origCloseFocus();
};

// Also hide aux panel when focusing a regular session
const _origFocusSession = focusSession;
focusSession = function(id) {
  const auxPanel = document.getElementById('aux-panel');
  if (auxPanel) auxPanel.style.display = 'none';
  focusId.style.color = ''; // reset color
  _origFocusSession(id);
};

// ── Init (moved from manage.js: must run after this script's declarations,
//    so the synchronous connect lives here, not in the host init block) ──
auxConnect();
// Fallback for the overview classify grid: /ws/aux pushes aux_history on
// connect, but if the socket is slow this still paints the grid once.
setTimeout(() => { if (_auxHistory.length === 0) refreshAuxHistory(); }, 1500);

