'use strict';

// Task board widget for the directory-detail modal (manage.html).
// Renders the AI-tagged module→task tree inside #dir-detail-body plus the
// panel-level composer that auto-routes. Task details open the unified chat
// view (chat.html?task=, design D3); the legacy stacked modal is retired.
//
// Self-contained: own fetch/cache/escape helpers, no load-order dependency
// on manage-dashboard.js beyond being called from renderDirectoryDetailBody.

let _tbBoard = { modules: [], tasks: [], sessionLabels: {} };
let _tbFetchedAt = 0;
let _tbTimer = null;
const _tbCollapsed = new Set();     // module ids collapsed in the tree
let _tbGatheringFloat = null;       // 归拢中浮窗 DOM
let _tbPendingTaskIds = [];         // 等待定位的新任务 id
let _tbMergeMode = false;
let _tbMergeDirId = null;
const _tbMergeTaskIds = new Set();  // insertion order: first id is the survivor
const _tbOriginFilters = new Set(['all', 'board', 'session']);
let _tbOriginFilter = 'all';

const _tbEsc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Status glyph for a task row. Delegates to the shared registry so the icon,
// tone and "may it animate" policy are the same here, on the fleet cards, in the
// chat bars and in the app — and so an errored task always renders ❌ with an
// accessible name instead of a bare colour.
function _tbStatusIcon(display) {
  return window.MultiCCStatusPresentation.statusBadgeHtml('task', display.status, {
    translate: window.t,
    showLabel: false,
    className: 'tb-icon',
  });
}

function _tbTimeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

function _tbTaskDirId(task) {
  return window.MultiCCTaskBoardUi.taskHomeDirId(task, _tbBoard.modules);
}

function _tbMergeSelectedTasks() {
  const byId = new Map(_tbBoard.tasks.map(task => [task.id, task]));
  return [..._tbMergeTaskIds].map(id => byId.get(id)).filter(Boolean);
}

function _tbMergePlan() {
  return window.MultiCCTaskBoardUi.taskMergePlan(_tbMergeSelectedTasks(), {
    dirIdOf: _tbTaskDirId,
  });
}

function _tbMergeBlockText(reason) {
  const messages = {
    task_busy: '任务正在执行、排队或等待，暂不能合并',
    task_classifying: '任务正在归类，完成后才能合并',
    source_workspace: '该任务仍有 worktree/分支；请先清理，或先勾选它作为保留任务',
    origin_mismatch: '暂不支持独立任务与会话任务互相合并',
    directory_mismatch: '暂不支持跨 Fleet 合并任务',
    too_few: '至少选择 2 个任务',
    empty: '请先选择要保留的任务',
  };
  return messages[reason] || '该任务暂不能合并';
}

function _tbMergeCandidateState(task) {
  if (_tbMergeTaskIds.has(task.id)) return { ok: true, reason: null };
  const target = _tbMergeSelectedTasks()[0];
  if (!target) return window.MultiCCTaskBoardUi.taskMergeEligibility(task);
  return window.MultiCCTaskBoardUi.taskMergeCompatibility(target, task, {
    targetDirId: _tbTaskDirId(target),
    candidateDirId: _tbTaskDirId(task),
  });
}

function _tbHasMergePair(tasks) {
  for (const target of tasks) {
    for (const source of tasks) {
      if (target.id === source.id) continue;
      if (window.MultiCCTaskBoardUi.taskMergeCompatibility(target, source, {
        targetDirId: _tbTaskDirId(target),
        candidateDirId: _tbTaskDirId(source),
      }).ok) return true;
    }
  }
  return false;
}

function _tbPruneMergeSelection(visibleTasks) {
  const visibleIds = new Set((Array.isArray(visibleTasks) ? visibleTasks : []).map(task => task.id));
  for (const id of _tbMergeTaskIds) {
    if (!visibleIds.has(id)) _tbMergeTaskIds.delete(id);
  }
}

function _tbExitMergeMode() {
  _tbMergeMode = false;
  _tbMergeDirId = null;
  _tbMergeTaskIds.clear();
}

function _tbRenderVisibleBoard() {
  if (typeof renderDirectoryDetailBody === 'function' && typeof _detailDirId !== 'undefined' && _detailDirId) {
    renderDirectoryDetailBody(_detailDirId);
  }
}

// ── Auto Provider (composer picks) ──────────────────────────────────────────
// Chat and Task Board share one candidate editor + one default-selection policy.
// Auto remains a virtual selection: it never becomes session.provider — the
// server resolves one concrete provider per invocation. The board stores the
// user's committed candidate snapshot before the first task turn starts.
const TB_AUTO_PREFIX = '__auto__:';
const TB_PROTOCOL_LABELS = {
  anthropic: 'Anthropic Messages',
  openai_responses: 'OpenAI Responses',
  openai_chat: 'OpenAI Chat Completions',
};
function _tbProtocolOf(provider) {
  const value = provider && (provider.protocol || provider.apiFormat);
  return TB_PROTOCOL_LABELS[value] ? value : null;
}

function _tbAutoEditor() {
  const editor = window.MultiCCAutoProviderEditor;
  if (!editor) throw new Error('Auto Provider 编辑器未加载');
  return editor;
}

// Auto entries are offered only when a safe, no-consent default exists: at
// least two user-managed providers on one protocol. Official providers remain
// available inside the shared editor and require explicit cross-trust consent
// before they can be mixed with a managed provider.
function _tbAutoPool(list, protocol) {
  const editor = window.MultiCCAutoProviderEditor;
  const pool = editor && typeof editor.providersForProtocol === 'function'
    ? editor.providersForProtocol(list, protocol)
    : (Array.isArray(list) ? list : []).filter(p => p && p.id && _tbProtocolOf(p) === protocol);
  return pool.filter(provider => provider.isOfficial !== true);
}

function _tbAutoSelection(list, protocol) {
  const editor = _tbAutoEditor();
  return editor.defaultSelection(list, protocol);
}

function _tbModuleAssignmentHtml(task) {
  const assignment = task && task.moduleAssignment;
  if (!assignment) return '';
  const title = assignment.lastError ? ` title="${_tbEsc(assignment.lastError)}"` : '';
  const label = assignment.running ? '归类中…' : assignment.lastError ? '重新归类' : '归类';
  return `<button class="btn btn-sm tb-reclassify" onclick="reclassifyTaskBoardTask(event,'${_tbEsc(task.id)}')"${assignment.running ? ' disabled' : ''}${title}>${label}</button>`;
}

function _tbQuickArchiveHtml(task) {
  return `<button class="btn btn-sm tb-quick-archive" onclick="archiveTaskBoardTask(event,'${_tbEsc(task.id)}',this)" title="快捷归档该任务">归档</button>`;
}

function _tbWorkspaceHtml(task) {
  return task?.workspaceState === 'hibernated'
    ? `<span class="tb-dim tb-workspace-state" title="连续 7 天无真实工作后自动回收工作区；下一条消息会恢复同一会话">💤 已休眠</span>`
    : '';
}

// M4 (design D3): the operations the retired detail modal owned live on the
// row. Completion/reopen and — once the task owns a worktree (M3) — one-click
// merge-back + worktree cleanup. Row click still opens the chat view; every
// button handler stops propagation itself.
function _tbTaskActionsHtml(task) {
  const lifecycle = task.status !== 'active'
    ? `<button class="btn btn-sm" onclick="setTaskBoardStatus('${_tbEsc(task.id)}','active',event)" title="重新激活该任务">♻️ 重开</button>`
    : `<button class="btn btn-sm" onclick="setTaskBoardStatus('${_tbEsc(task.id)}','done',event)" title="标记完成">✅ 完成</button>`;
  const worktree = task.worktreePath
    ? `<button class="btn btn-sm" title="把任务分支合并回基分支并删除任务 worktree（运行中的任务会被拒绝）" onclick="cleanupTaskWorktree(event,'${_tbEsc(task.id)}',this)">🧹</button>`
    : '';
  return `${lifecycle}${worktree}`;
}

function _tbOriginHtml(task) {
  const origin = window.MultiCCTaskBoardUi.taskOrigin(task);
  return `<span class="tb-origin tb-origin-${origin.key}" title="${_tbEsc(origin.title)}">${origin.icon} ${_tbEsc(origin.label)}</span>`;
}

function _tbRoutingHtml(task) {
  const label = window.MultiCCTaskBoardUi.taskRoutingLabel(task);
  return label ? `<span class="tb-route-state">🫡 ${_tbEsc(label)}</span>` : '';
}

function _tbMergeSelectionHtml(task) {
  if (!_tbMergeMode) return '';
  const selected = _tbMergeTaskIds.has(task.id);
  const state = _tbMergeCandidateState(task);
  const disabled = !selected && !state.ok;
  const title = disabled ? _tbMergeBlockText(state.reason)
    : selected ? '取消选择'
      : _tbMergeTaskIds.size ? '选择为待并入任务' : '选择为保留任务';
  return `<span class="tb-merge-select" title="${_tbEsc(title)}" onclick="event.stopPropagation()">
    <input type="checkbox" aria-label="${_tbEsc(title)}"${selected ? ' checked' : ''}${disabled ? ' disabled' : ''}
      onclick="event.stopPropagation()" onchange="toggleTaskBoardMergeSelection(event,'${_tbEsc(task.id)}')">
  </span>`;
}

function _tbMergeRoleHtml(task) {
  if (!_tbMergeMode || !_tbMergeTaskIds.has(task.id)) return '';
  const target = _tbMergeSelectedTasks()[0];
  const keeper = target?.id === task.id;
  return `<span class="tb-merge-role${keeper ? ' keeper' : ''}">${keeper ? '保留' : '并入'}</span>`;
}

function _tbMergeRowTitle(task) {
  if (!_tbMergeMode) return '在聊天视图中打开';
  if (_tbMergeTaskIds.has(task.id)) return '点击取消选择';
  const state = _tbMergeCandidateState(task);
  if (!state.ok) return _tbMergeBlockText(state.reason);
  return _tbMergeTaskIds.size ? '点击选择为待并入任务' : '点击选择为保留任务';
}

function _tbMergeStartButtonHtml(dirId, tasks) {
  const available = _tbHasMergePair(tasks);
  const title = available ? '手动选择同类任务进行合并'
    : '当前没有两个可合并的同类任务';
  return `<button class="btn btn-sm tb-merge-start" onclick="toggleTaskBoardMergeMode(event,'${_tbEsc(dirId)}')" title="${title}"${available ? '' : ' disabled'}>合并任务</button>`;
}

function _tbMergeBarHtml() {
  if (!_tbMergeMode) return '';
  const tasks = _tbMergeSelectedTasks();
  const plan = _tbMergePlan();
  const target = tasks[0];
  const origin = target ? window.MultiCCTaskBoardUi.taskOrigin(target) : null;
  const summary = target
    ? `已选 ${tasks.length} 个${origin.label}；保留「${target.title}」，其余并入`
    : '请先勾选要保留的任务，再勾选要并入的同类任务';
  const disabledTitle = plan.ok ? '执行合并' : _tbMergeBlockText(plan.reason);
  return `<div class="tb-merge-bar">
    <span class="tb-merge-summary">${_tbEsc(summary)}</span>
    <span class="tb-merge-actions">
      <button class="btn btn-sm" onclick="submitTaskBoardMerge(event,this)" title="${_tbEsc(disabledTitle)}"${plan.ok ? '' : ' disabled'}>合并${tasks.length >= 2 ? ` ${tasks.length} 个` : ''}</button>
      <button class="btn btn-sm" onclick="toggleTaskBoardMergeMode(event,'${_tbEsc(_tbMergeDirId)}')">取消</button>
    </span>
  </div>`;
}

async function refreshTaskBoard(force) {
  if (!force && Date.now() - _tbFetchedAt < 3000) return;   // debounce bursts
  try {
    const r = await fetch('/api/task-board');
    const d = await r.json();
    if (!d || !d.ok) return;
    _tbBoard = window.MultiCCTaskBoardUi.reconcileSnapshot(d);
    if (typeof window.MultiCCTaskPlanner?.reconcileSnapshot === 'function') {
      window.MultiCCTaskPlanner.reconcileSnapshot(d);
    }
    if (_tbMergeMode) _tbPruneMergeSelection(_tbTasksForDir(_tbMergeDirId));
    _tbFetchedAt = Date.now();
    // A task-bound chat is deliberately absent from the ordinary Fleet session
    // list, so task activity has to refresh the outer Fleet state explicitly.
    if (typeof refreshTaskBoardFleetActivity === 'function') refreshTaskBoardFleetActivity();
    else if (typeof refreshAllCardBorders === 'function') refreshAllCardBorders();
    // The unified task surface reconciles the snapshot above. Keep its DOM
    // stable so search/scroll/focus survive, but refresh the outer Fleet tab's
    // count and running marker from the same snapshot.
    if (typeof _detailModalOpen === 'function' && _detailModalOpen()) {
      if (typeof _dirDetailTab !== 'undefined' && _dirDetailTab === 'tasks') {
        if (typeof refreshDirectoryDetailTaskTab === 'function') refreshDirectoryDetailTaskTab(_detailDirId);
      } else if (typeof renderDirectoryDetailBody === 'function') {
        renderDirectoryDetailBody(_detailDirId);
      }
    }
    // 刷新后定位新任务（若有待定位的）
    if (_tbPendingTaskIds.length) {
      const tid = _tbPendingTaskIds[0];
      _tbPendingTaskIds = [];
      setTimeout(() => _tbScrollToTask(tid), 100);
    }
  } catch (_) {}
}

// Debounced entry point for WS task_board_update events (manage.js).
// evt = { type:'task_board_update', taskIds:[], kind?:'created' }
function onTaskBoardUpdate(evt) {
  clearTimeout(_tbTimer);
  if (evt && evt.kind === 'created' && evt.taskIds && evt.taskIds.length) {
    _tbPendingTaskIds = evt.taskIds;
    _tbHideGatheringFloat();
  }
  _tbTimer = setTimeout(() => refreshTaskBoard(true), 400);
}

// Tasks that belong to a directory: any turn ref recorded in it, or the
// module anchored there (covers fresh tasks whose refs lost dirId).
function _tbTasksForDir(dirId) {
  const modDir = new Map(_tbBoard.modules.map(m => [m.id, m.dirId]));
  return _tbBoard.tasks.filter(t => t.status !== 'archived'
    && ((t.dirIds || []).includes(dirId) || modDir.get(t.moduleId) === dirId));
}

function _tbTasksForOrigin(tasks, origin = _tbOriginFilter) {
  const source = _tbOriginFilters.has(origin) ? origin : 'all';
  if (source === 'all') return [...(Array.isArray(tasks) ? tasks : [])];
  return (Array.isArray(tasks) ? tasks : []).filter(task =>
    window.MultiCCTaskBoardUi.taskOrigin(task).key === source);
}

function _tbOriginFilterHtml(tasks, dirId) {
  const all = Array.isArray(tasks) ? tasks : [];
  const independent = _tbTasksForOrigin(all, 'board').length;
  const session = _tbTasksForOrigin(all, 'session').length;
  const buttons = [
    { key: 'all', label: '全部', count: all.length, title: '显示全部任务来源' },
    { key: 'board', label: '独立任务', count: independent, title: '任务板直接发起、拥有独立任务会话' },
    { key: 'session', label: '会话任务', count: session, title: '普通会话中产生的任务记录' },
  ];
  return `<div class="tb-origin-filter" role="group" aria-label="任务来源">
    <span class="tb-origin-filter-label">来源</span>
    ${buttons.map(item => `<button type="button" class="tb-origin-filter-btn${_tbOriginFilter === item.key ? ' active' : ''}" aria-pressed="${_tbOriginFilter === item.key}" title="${_tbEsc(item.title)}" onclick="setTaskBoardOriginFilter(event,'${item.key}','${_tbEsc(dirId)}')">${_tbEsc(item.label)} <strong>${item.count}</strong></button>`).join('')}
  </div>`;
}

function setTaskBoardOriginFilter(ev, origin, dirId) {
  if (ev) ev.stopPropagation();
  const next = _tbOriginFilters.has(origin) ? origin : 'all';
  if (next === _tbOriginFilter) return;
  _tbOriginFilter = next;
  if (_tbMergeMode) _tbExitMergeMode();
  const targetDirId = String(dirId || (typeof _detailDirId !== 'undefined' ? _detailDirId : '') || '');
  if (targetDirId && typeof renderDirectoryDetailBody === 'function') {
    renderDirectoryDetailBody(targetDirId);
  }
}

// Cross-module read port used by manage-dashboard.js. Keep the aggregation on
// the board side so both the detail tab and the outer Fleet card consume the
// same directory membership and shared status-presentation policy.
function taskBoardRunningCountForDir(dirId) {
  return window.MultiCCTaskBoardUi.runningTaskCount(_tbTasksForDir(dirId));
}

function _tbTaskRowHtml(task) {
  const display = window.MultiCCTaskBoardUi.taskDisplayState(task);
  const clsRun = display.running ? ' running' : '';
  const attempt = Number(task.attemptCount) > 1
    ? `<span class="tb-dim">${Number(task.attemptCount)} 次投递</span>` : '';
  const body = task.body
    ? `<details class="tb-body-fold" onclick="event.stopPropagation()"><summary>任务正文</summary><pre>${_tbEsc(task.body)}</pre></details>`
    : task.identityState === 'orphaned_admission' || task.identityState === 'legacy_unresolved'
      ? '<span class="tb-body-pending">旧记录缺少 canonical 正文，未自动合并</span>'
      : '<span class="tb-body-pending">正文等待目标会话持久化…</span>';
  return `
    <div class="tb-task${display.done ? ' done' : ''}${clsRun}${_tbMergeMode ? ' merge-mode' : ''}" data-task-id="${_tbEsc(task.id)}" title="${_tbEsc(_tbMergeRowTitle(task))}" onclick="handleTaskBoardRowClick(event,'${_tbEsc(task.id)}')">
      ${_tbMergeSelectionHtml(task)}
      ${_tbStatusIcon(display)}
      <span class="tb-title-cell">
        <span class="tb-title">${_tbOriginHtml(task)}${_tbEsc(task.title)}${_tbMergeRoleHtml(task)}</span>
        ${body}
      </span>
      <span class="tb-task-meta"><span class="tb-run-state st-tone-${display.tone}">${_tbEsc(display.label)}</span>${_tbWorkspaceHtml(task)}${_tbRoutingHtml(task)}${attempt}${_tbModuleAssignmentHtml(task)}${_tbTaskActionsHtml(task)}${_tbQuickArchiveHtml(task)}<span class="tb-dim">${task.refCount}轮 · ${_tbEsc(_tbTimeAgo(task.lastTs))}</span></span>
    </div>`;
}

// Synchronous section HTML for renderDirectoryDetailBody (data from cache;
// openDirectoryDetail triggers the async refresh). With {tabbed:true} the
// board fills its own tab, so the section chrome (border + "任务板" head that
// would duplicate the tab label) is dropped.
function renderTaskBoardSection(dirId, opts) {
  const allTasks = _tbTasksForDir(dirId);
  const tasks = _tbTasksForOrigin(allTasks);
  if (_tbMergeMode && _tbMergeDirId !== dirId) _tbExitMergeMode();
  if (_tbMergeMode) _tbPruneMergeSelection(tasks);
  const completedCount = allTasks.filter(t =>
    window.MultiCCTaskBoardUi.taskDisplayState(t).done).length;
  const cleanupButton = `<button class="btn btn-sm tb-clean-completed" onclick="archiveCompletedTaskBoard(event,'${_tbEsc(dirId)}',this)" title="归档 Fleet 内全部已完成任务（不受来源筛选影响）"${completedCount ? '' : ' disabled'}>🧹 一键清理${completedCount ? ` (${completedCount})` : ''}</button>`;
  const mergeStartButton = _tbMergeMode ? '' : _tbMergeStartButtonHtml(dirId, tasks);
  const mergeBar = _tbMergeBarHtml();
  const originFilter = _tbOriginFilterHtml(allTasks, dirId);
  const rowsHtml = [];
  const byModule = new Map();
  for (const t of tasks) {
    if (!byModule.has(t.moduleId)) byModule.set(t.moduleId, []);
    byModule.get(t.moduleId).push(t);
  }
  const mods = window.MultiCCTaskBoardUi.sortModules(
    _tbBoard.modules.filter(m => byModule.has(m.id)),
  );
  for (const mod of mods) {
    const list = window.MultiCCTaskBoardUi.sortTasks(byModule.get(mod.id));
    const identity = window.MultiCCTaskBoardUi.partitionTaskIdentity(list);
    const collapsed = _tbCollapsed.has(mod.id);
    const batch = mod.source === 'classify'
      ? `<button class="btn btn-sm tb-reclassify-all" onclick="reclassifyPendingTaskBoard(event,'${_tbEsc(dirId)}')">全部重新归类</button>`
      : '';
    rowsHtml.push(`
      <div class="tb-mod" onclick="toggleTaskBoardModule('${_tbEsc(mod.id)}')">
        <span>${collapsed ? '▸' : '▾'} <b>${_tbEsc(mod.name)}</b> · ${list.length}</span>
        <span class="tb-mod-actions">${batch}<span class="tb-dim">${_tbEsc(_tbTimeAgo(mod.lastTs))}</span></span>
      </div>`);
    if (collapsed) continue;
    for (const task of identity.canonical) rowsHtml.push(_tbTaskRowHtml(task));
    if (identity.unresolved.length) {
      rowsHtml.push(`<details class="tb-legacy-group" onclick="event.stopPropagation()">
        <summary>历史身份待确认 · ${identity.unresolved.length}（未自动合并）</summary>
        ${identity.unresolved.map(_tbTaskRowHtml).join('')}
      </details>`);
    }
  }
  // Orphans (module list pruned or filtered out) still need to be reachable.
  const seen = new Set(mods.map(m => m.id));
  for (const task of window.MultiCCTaskBoardUi.sortTasks(tasks.filter(x => !seen.has(x.moduleId)))) {
    rowsHtml.push(_tbTaskRowHtml(task));
  }
  const body = rowsHtml.length
    ? rowsHtml.join('')
    : `<div class="tb-empty">${_tbOriginFilter === 'all'
      ? '还没有任务。从任务面板或 Commander 发起新任务后会显示在这里。'
      : '当前来源筛选下没有任务。'}</div>`;
  const moduleCount = mods.length || (tasks.length ? 1 : 0);
  const statText = _tbOriginFilter === 'all'
    ? `${moduleCount} 模块 · ${tasks.length} 任务`
    : `${moduleCount} 模块 · 显示 ${tasks.length}/${allTasks.length} 任务`;
  if (opts && opts.tabbed) {
    const stat = `<div class="tb-stat" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <span>${allTasks.length ? statText : '暂无任务'}</span>
      <div class="tb-stat-controls">${originFilter}<span class="tb-head-actions">${mergeStartButton}${cleanupButton}<button class="btn-icon" onclick="event.stopPropagation();refreshTaskBoard(true)" title="刷新任务板">🔄</button></span></div>
    </div>`;
    return `<div class="tb-section tb-tabbed">${stat}${mergeBar}${body}</div>`;
  }
  return `
    <div class="tb-section">
      <div class="tb-section-head">
        <span>📋 任务板 <span class="tb-dim">${allTasks.length ? statText : ''}</span></span>
        <div class="tb-stat-controls">${originFilter}<span class="tb-head-actions">${mergeStartButton}${cleanupButton}</span></div>
      </div>
      ${mergeBar}
      ${body}
    </div>`;
}

function toggleTaskBoardModule(modId) {
  if (event) event.stopPropagation();
  _tbCollapsed.has(modId) ? _tbCollapsed.delete(modId) : _tbCollapsed.add(modId);
  if (typeof renderDirectoryDetailBody === 'function' && typeof _detailDirId !== 'undefined' && _detailDirId) {
    renderDirectoryDetailBody(_detailDirId);
  }
}

// ── Composer (chat-parity input: attach/paste, voice, goal) ─────────────────
// One factory for the board-tab composer (dir-level routing). Fire-and-forget
// by design: no streaming/cancel state — a sent message is sent. Task-level
// follow-ups live in the unified chat view (chat.html?task=) since M4.
//
// Feature parity with the chat composer:
//   attach/paste → POST /api/upload (FormData 'file') → absolute path appended
//   to the message text (same convention the chat composer uses);
//   voice → MediaRecorder → POST /api/voice/stt → transcript into the input;
//   goal → goal:true + goalLimits{maxRounds,maxBudget}, note prepended
//   server-side via buildGoalLimitNote (byte-equal to chat's goal mode).

function createTbComposer(host, opts) {
  host.innerHTML = `
    <div class="tb-compose">
      <div class="tb-chiprow" style="display:none"></div>
      <textarea class="tb-input" placeholder="${_tbEsc(opts.placeholder || '输入消息…（支持粘贴图片/文件，Enter 发送，Shift+Enter 换行）')}"></textarea>
      <div class="tb-goalrow" style="display:none">
        <span class="tb-dim">🎯 Goal 模式</span>
        <label class="tb-dim">轮次上限 <input type="number" class="tb-goal-rounds" value="200" min="0" max="200"></label>
        <label class="tb-dim">token 预算 <input type="number" class="tb-goal-budget" step="1000" min="0" placeholder="不限"></label>
      </div>
      <div class="tb-compose-row">
        <select class="tb-cli" title="CLI（默认跟随最近活跃）"><option value="">CLI…</option></select>
        <select class="tb-provider" title="Provider（默认跟随最近活跃）"><option value="">Provider…</option></select>
        <button class="btn btn-sm tb-attach-btn" title="上传图片/文件">📎</button>
        <button class="btn btn-sm tb-mic-btn" title="语音输入">🎙</button>
        <button class="btn btn-sm tb-goal-btn" title="以 Goal 模式发送（自主任务，带轮次/预算上限）">🎯</button>
        <button class="btn btn-sm tb-send-btn">🚀 发送</button>
        <span class="tb-result"></span>
      </div>
      <div class="tb-auto-summary-row tb-auto-provider-editor" aria-live="polite">
        <span class="tb-auto-summary"></span>
        <button type="button" class="btn btn-sm tb-auto-config-btn" title="发送前选择 Auto Provider 候选、顺序和模型">⚙ 配置候选</button>
      </div>
      ${opts.hint ? `<div class="tb-dim" style="margin-top:4px">${_tbEsc(opts.hint)}</div>` : ''}
      <input type="file" multiple hidden class="tb-file-input">
    </div>`;
  const $q = (sel) => host.querySelector(sel);
  const input = $q('.tb-input');
  const chiprow = $q('.tb-chiprow');
  const sendBtn = $q('.tb-send-btn');
  const micBtn = $q('.tb-mic-btn');
  const goalBtn = $q('.tb-goal-btn');
  const goalRow = $q('.tb-goalrow');
  const fileInput = $q('.tb-file-input');
  const resultEl = $q('.tb-result');
  const autoSummaryRow = $q('.tb-auto-summary-row');
  const autoSummary = $q('.tb-auto-summary');
  const autoConfigBtn = $q('.tb-auto-config-btn');
  let pendingClientMsgId = '';
  let pendingText = '';
  let composerContextKey = String(opts.contextKey || '');

  const setResult = (text, cls) => { resultEl.textContent = text || ''; resultEl.className = 'tb-result' + (cls ? ' ' + cls : ''); };

  // Attachments — upload immediately, keep the returned path on a chip.
  async function uploadFile(file) {
    const uploadContextKey = composerContextKey;
    const chip = document.createElement('span');
    chip.className = 'tb-fchip';
    chip.textContent = `⏳ ${file.name || '文件'}`;
    chiprow.style.display = '';
    chiprow.appendChild(chip);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'pasted');
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok || !d.path) throw new Error(d.error || r.status);
      if (uploadContextKey !== composerContextKey) {
        chip.remove();
        if (!chiprow.children.length) chiprow.style.display = 'none';
        return;
      }
      chip.dataset.path = d.path;
      chip.textContent = `📄 ${d.name || file.name}`;
      const x = document.createElement('span');
      x.className = 'tb-fchip-x';
      x.textContent = ' ✕';
      x.onclick = () => { chip.remove(); if (!chiprow.children.length) chiprow.style.display = 'none'; };
      chip.appendChild(x);
    } catch (e) {
      if (uploadContextKey !== composerContextKey) {
        chip.remove();
        return;
      }
      chip.textContent = `⚠️ ${file.name || '文件'} 上传失败`;
      setTimeout(() => { chip.remove(); if (!chiprow.children.length) chiprow.style.display = 'none'; }, 3000);
    }
  }
  $q('.tb-attach-btn').onclick = () => fileInput.click();
  fileInput.onchange = () => { for (const f of fileInput.files) uploadFile(f); fileInput.value = ''; };
  input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); for (const f of files) uploadFile(f); }
  });

  // Voice — simplest press-to-toggle MediaRecorder → one-shot STT.
  let recorder = null;
  let recChunks = [];
  micBtn.onclick = async () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    const recordContextKey = composerContextKey;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (_) { setResult('无法访问麦克风', 'err'); return; }
    if (recordContextKey !== composerContextKey) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    recChunks = [];
    const mime = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : undefined;
    try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (_) { stream.getTracks().forEach(t => t.stop()); setResult('浏览器不支持录音', 'err'); return; }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      micBtn.classList.remove('rec');
      const blob = new Blob(recChunks, { type: 'audio/webm' });
      if (!blob.size) return;
      setResult('转写中…');
      try {
        const fd = new FormData();
        fd.append('file', blob, 'recording.webm');
        const r = await fetch('/api/voice/stt', { method: 'POST', body: fd });
        const d = await r.json();
        if (!r.ok || !d.text) throw new Error(d.error || '无转写结果');
        if (recordContextKey !== composerContextKey) return;
        input.value = input.value ? `${input.value} ${d.text.trim()}` : d.text.trim();
        input.focus();
        setResult('');
      } catch (e) {
        if (recordContextKey === composerContextKey) setResult(`转写失败：${e.message}`, 'err');
      }
    };
    recorder.start();
    micBtn.classList.add('rec');
    setResult('录音中，点 🎙 结束…');
  };

  // Goal toggle — show the limits row while armed.
  goalBtn.onclick = () => {
    const on = goalBtn.classList.toggle('on');
    goalRow.style.display = on ? '' : 'none';
  };

  // Runtime picks (#34): cli + provider policy are pinned onto the task's bound
  // chat session at creation. Manual picks carry one concrete provider; Auto
  // carries the committed candidate snapshot. Explicit picks apply at creation
  // only — an already-bound session changes through its ordinary Chat surface.
  const cliSel = $q('.tb-cli');
  const provSel = $q('.tb-provider');
  const TB_CLI_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode', qoder: 'Qoder CN' };
  let runtimeSuggest = null;           // {cli, provider} from the host
  const providerCache = new Map();     // cli -> [{appType,id,name}]
  const autoDrafts = new Map();        // fleet + cli + protocol -> committed selection
  let provListCli = '';                // the cli the visible list was filtered by
  let lastProviderValue = '';
  let pickerEpoch = 0;
  let runtimeLoadEpoch = 0;
  let closeActivePicker = null;
  let providerLoading = false;
  let autoConfigLoading = false;
  let sending = false;

  const syncRuntimeControls = () => {
    cliSel.disabled = sending;
    provSel.disabled = sending || providerLoading;
    sendBtn.disabled = sending || providerLoading;
    if (autoConfigBtn) autoConfigBtn.disabled = sending || providerLoading || autoConfigLoading;
  };

  const loadProviderOptions = async (cli, force) => {
    if (!cli || (!force && providerCache.has(cli))) return providerCache.get(cli) || [];
    try {
      const r = await fetch(`/api/providers?cli=${encodeURIComponent(cli)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status || 'error'}`);
      const d = await r.json();
      const list = Array.isArray(d.providers) ? d.providers : [];
      providerCache.set(cli, list);
      return list;
    } catch (error) {
      if (!providerCache.has(cli)) throw error;
      return providerCache.get(cli);
    }
  };

  const renderCliOptions = () => {
    const sugCli = runtimeSuggest?.cli || '';
    const clis = [...new Set([sugCli, 'claude', 'codex', 'opencode', 'zcode', 'qoder'].filter(Boolean))];
    cliSel.innerHTML = `<option value="">CLI · ${sugCli ? `最近活跃 ${_tbEsc(TB_CLI_LABELS[sugCli] || sugCli)}` : '默认'}</option>`
      + clis.map(c => `<option value="${_tbEsc(c)}">${_tbEsc(TB_CLI_LABELS[c] || c)}</option>`).join('');
  };

  const renderProviderOptions = () => {
    const list = providerCache.get(provListCli) || [];
    const keep = provSel.value;
    const sugCli = runtimeSuggest?.cli || '';
    const sugName = provListCli === sugCli && runtimeSuggest?.provider
      ? ((providerCache.get(sugCli) || []).find(p => p.id === runtimeSuggest.provider)?.name || runtimeSuggest.provider)
      : '';
    // Auto entries first: one per protocol that has at least two managed
    // providers to fail over between.
    const autoHtml = [...new Set(list.map(_tbProtocolOf).filter(Boolean))]
      .map(protocol => ({ protocol, pool: _tbAutoPool(list, protocol) }))
      .filter(entry => entry.pool.length >= 2)
      .map(entry => `<option value="${TB_AUTO_PREFIX}${_tbEsc(entry.protocol)}" title="选择后会在发送前确认候选、顺序和模型；默认仅启用前两个自管 Provider">⚡ Auto · ${_tbEsc(TB_PROTOCOL_LABELS[entry.protocol])}（${entry.pool.length} 个自管可选）</option>`)
      .join('');
    provSel.innerHTML = `<option value="">Provider · ${sugName ? `最近活跃 ${_tbEsc(sugName)}` : '默认'}</option>`
      + autoHtml
      + list.map(p => `<option value="${_tbEsc(p.id)}">${_tbEsc(p.name || p.id)}</option>`).join('');
    if (keep && [...provSel.options].some(option => option.value === keep)) provSel.value = keep;
    lastProviderValue = provSel.value;
    syncAutoSummary();
  };

  const cloneAutoSelection = selection => selection
    ? JSON.parse(JSON.stringify(selection)) : null;
  const autoProtocolFromPicker = () => {
    const editor = window.MultiCCAutoProviderEditor;
    return editor && typeof editor.protocolFromValue === 'function'
      ? editor.protocolFromValue(provSel.value)
      : (provSel.value.startsWith(TB_AUTO_PREFIX) ? provSel.value.slice(TB_AUTO_PREFIX.length) : null);
  };
  const autoDraftKey = protocol => `${composerContextKey}\u0000${provListCli}\u0000${protocol}`;

  function syncAutoSummary() {
    if (!autoSummaryRow || !autoSummary) return;
    const protocol = autoProtocolFromPicker();
    const selection = protocol ? autoDrafts.get(autoDraftKey(protocol)) : null;
    if (!selection) {
      autoSummaryRow.classList.remove('visible');
      autoSummaryRow.classList.remove('cross-trust');
      autoSummary.textContent = '';
      autoSummary.title = '';
      return;
    }
    const list = providerCache.get(provListCli) || [];
    const byId = new Map(list.map(provider => [String(provider.id), provider]));
    let hasOfficial = false;
    const names = selection.candidates.map(candidate => {
      const provider = byId.get(String(candidate.providerId));
      if (provider?.isOfficial === true) hasOfficial = true;
      const name = provider?.name || candidate.providerId;
      return provider?.isOfficial === true ? `${name}（Official）` : name;
    });
    const label = TB_PROTOCOL_LABELS[protocol] || protocol;
    const route = names.slice(0, 2).join(' → ');
    const trustWarning = selection.allowCrossTrust === true
      ? ' · ⚠ 跨上游已授权' : (hasOfficial ? ' · 含 Official' : '');
    autoSummary.textContent = `⚡ Auto · ${label} · ${names.length} 个候选${route ? ` · ${route}` : ''} · 最多 ${selection.maxAttempts} 次${trustWarning}`;
    autoSummary.title = `${names.join(' → ')}；仅用于新任务绑定会话，首轮立即生效${selection.allowCrossTrust === true ? '；同一上下文可能发送到 Official 与自管上游' : ''}`;
    autoSummaryRow.classList.add('visible');
    autoSummaryRow.classList.toggle('cross-trust', selection.allowCrossTrust === true);
  }

  function showAutoProviderPicker(protocol, initialSelection, providers) {
    const editorApi = _tbAutoEditor();
    return new Promise(resolve => {
      if (closeActivePicker) closeActivePicker();
      const overlay = document.createElement('div');
      overlay.className = 'tb-auto-picker-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'width:640px;max-width:94vw;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);display:flex;flex-direction:column;background:var(--panel,#161b22);border:1px solid var(--line-strong,#30363d);border-radius:12px;color:var(--text,#c9d1d9);';
      const body = document.createElement('div');
      body.style.cssText = 'padding:16px;overflow:auto;min-height:0;';
      const title = document.createElement('div');
      title.textContent = `发送前配置 Auto · ${TB_PROTOCOL_LABELS[protocol] || protocol}`;
      title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:4px;';
      const note = document.createElement('div');
      note.textContent = '本配置会作为新任务首轮的固定候选 allowlist；新增 Provider 不会自动加入。';
      note.style.cssText = 'font-size:11px;color:var(--muted,#8b949e);line-height:1.5;margin-bottom:10px;';
      const editorHost = document.createElement('div');
      body.append(title, note, editorHost);
      const footer = document.createElement('div');
      footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--line,#21262d);';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = '取消';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-green';
      save.textContent = '确认候选';
      footer.append(cancel, save);
      box.append(body, footer);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const controller = editorApi.mount({
        document,
        container: editorHost,
        providers,
        protocol,
        initialSelection,
        formatProvider(provider) {
          const trust = provider.isOfficial === true ? ' · Official' : '';
          return `${provider.name || provider.id}${trust}`;
        },
      });
      let closed = false;
      const close = value => {
        if (closed) return;
        closed = true;
        controller.destroy();
        overlay.remove();
        if (closeActivePicker === dismiss) closeActivePicker = null;
        resolve(value);
      };
      const dismiss = () => close(null);
      closeActivePicker = dismiss;
      cancel.onclick = dismiss;
      save.onclick = () => {
        const result = controller.read();
        if (result.ok) close(result.value);
      };
      overlay.onclick = event => { if (event.target === overlay) dismiss(); };
    });
  }

  async function configureAutoProvider({ initial = false, previousValue = '' } = {}) {
    const protocol = autoProtocolFromPicker();
    if (!protocol) return false;
    const contextAtOpen = composerContextKey;
    const cliAtOpen = provListCli;
    const epoch = ++pickerEpoch;
    const draftKey = autoDraftKey(protocol);
    const restoreUncommittedInitial = () => {
      if (!initial || contextAtOpen !== composerContextKey || cliAtOpen !== provListCli
          || provSel.value !== `${TB_AUTO_PREFIX}${protocol}` || autoDrafts.has(draftKey)) return;
      provSel.value = previousValue;
      lastProviderValue = previousValue;
      syncAutoSummary();
    };
    providerLoading = true;
    autoConfigLoading = true;
    syncRuntimeControls();
    try {
      await loadProviderOptions(cliAtOpen, true);
    } catch (_) {
      if (epoch !== pickerEpoch || contextAtOpen !== composerContextKey || cliAtOpen !== provListCli) {
        restoreUncommittedInitial();
        return false;
      }
      if (epoch === pickerEpoch) {
        autoConfigLoading = false;
        providerLoading = false;
        syncRuntimeControls();
      }
      setResult('刷新 Provider 列表失败，请稍后重试', 'err');
      if (initial) provSel.value = previousValue;
      syncAutoSummary();
      return false;
    }
    if (epoch !== pickerEpoch || contextAtOpen !== composerContextKey || cliAtOpen !== provListCli) {
      restoreUncommittedInitial();
      return false;
    }
    providerLoading = false;
    autoConfigLoading = false;
    syncRuntimeControls();
    const list = providerCache.get(cliAtOpen) || [];
    const selection = autoDrafts.get(draftKey) || _tbAutoSelection(list, protocol);
    if (!selection) {
      setResult('该协议下至少需要两个自管 Provider', 'err');
      if (initial) provSel.value = previousValue;
      syncAutoSummary();
      return false;
    }
    const picked = typeof opts.pickAutoProvider === 'function'
      ? await opts.pickAutoProvider({
        protocol,
        providers: list.slice(),
        selection: cloneAutoSelection(selection),
      })
      : await showAutoProviderPicker(protocol, cloneAutoSelection(selection), list);
    if (epoch !== pickerEpoch || contextAtOpen !== composerContextKey || cliAtOpen !== provListCli) {
      restoreUncommittedInitial();
      return false;
    }
    if (!picked) {
      if (initial) provSel.value = previousValue;
      lastProviderValue = provSel.value;
      syncAutoSummary();
      return false;
    }
    autoDrafts.set(draftKey, cloneAutoSelection(picked));
    provSel.value = `${TB_AUTO_PREFIX}${protocol}`;
    lastProviderValue = provSel.value;
    syncAutoSummary();
    setResult('Auto 候选已确认', 'ok');
    return true;
  }

  provSel.onchange = async () => {
    const previousValue = lastProviderValue;
    pickerEpoch += 1;
    if (closeActivePicker) closeActivePicker();
    autoConfigLoading = false;
    providerLoading = false;
    syncRuntimeControls();
    const protocol = autoProtocolFromPicker();
    if (!protocol) {
      lastProviderValue = provSel.value;
      syncAutoSummary();
      return;
    }
    if (autoDrafts.has(autoDraftKey(protocol))) {
      lastProviderValue = provSel.value;
      syncAutoSummary();
      return;
    }
    await configureAutoProvider({ initial: true, previousValue });
  };
  if (autoConfigBtn) autoConfigBtn.onclick = () => configureAutoProvider();

  cliSel.onchange = async () => {
    pickerEpoch += 1;
    if (closeActivePicker) closeActivePicker();
    autoConfigLoading = false;
    const loadEpoch = ++runtimeLoadEpoch;
    const requestedCli = cliSel.value || runtimeSuggest?.cli || 'claude';
    providerLoading = true;
    provSel.innerHTML = '<option value="">Provider · 加载中…</option>';
    lastProviderValue = '';
    syncAutoSummary();
    provListCli = requestedCli;
    syncRuntimeControls();
    try {
      await loadProviderOptions(requestedCli);
      if (loadEpoch === runtimeLoadEpoch && provListCli === requestedCli) {
        providerLoading = false;
        renderProviderOptions();
        syncRuntimeControls();
      }
    } catch (_) {
      if (loadEpoch === runtimeLoadEpoch && provListCli === requestedCli) {
        providerLoading = false;
        renderProviderOptions();
        syncRuntimeControls();
        setResult('Provider 列表加载失败', 'err');
      }
    }
  };

  (async () => {
    const initEpoch = ++runtimeLoadEpoch;
    providerLoading = true;
    syncRuntimeControls();
    try {
      const r = await fetch('/api/task-board/suggested-runtime');
      const d = await r.json();
      if (initEpoch !== runtimeLoadEpoch) return;
      if (d && d.ok) runtimeSuggest = d;
    } catch (_) { /* picks stay manual */ }
    if (initEpoch !== runtimeLoadEpoch) return;
    provListCli = runtimeSuggest?.cli || 'claude';
    try { await loadProviderOptions(provListCli); }
    catch (_) { setResult('Provider 列表加载失败', 'err'); }
    if (initEpoch !== runtimeLoadEpoch) return;
    providerLoading = false;
    renderCliOptions();
    renderProviderOptions();
    syncRuntimeControls();
  })();

  async function doSend() {
    if (providerLoading) { setResult('Provider 列表仍在加载，请稍候', 'err'); return; }
    if (sending) return;
    let text = input.value.trim();
    const paths = [...chiprow.querySelectorAll('.tb-fchip[data-path]')].map(c => c.dataset.path);
    if (paths.length) text = (text ? text + ' ' : '') + paths.join(' ');
    if (!text) { setResult('请输入内容', 'err'); return; }
    const payload = { text };
    if (!pendingClientMsgId || pendingText !== text) {
      pendingClientMsgId = window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : `tb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      pendingText = text;
    }
    payload.clientMsgId = pendingClientMsgId;
    if (goalBtn.classList.contains('on')) {
      payload.goal = true;
      payload.goalLimits = {};
      const rounds = $q('.tb-goal-rounds').value;
      const budget = $q('.tb-goal-budget').value;
      if (rounds !== '') payload.goalLimits.maxRounds = rounds;
      if (budget !== '') payload.goalLimits.maxBudget = budget;
    }
    // Runtime picks: placeholders resolve to the "recently active" suggestion
    // so the new task's session follows it by default; a provider picked
    // without a cli rides the cli its list was filtered by (provListCli),
    // never the commander's cli from under a foreign provider.
    const picked = provSel.value;
    const autoProtocol = autoProtocolFromPicker();
    const explicitCli = cliSel.value;
    const effCli = explicitCli || runtimeSuggest?.cli || (picked ? provListCli : '');
    if (effCli) payload.cli = effCli;
    if (autoProtocol) {
      // Send the exact allowlist the user confirmed before this first turn.
      // Never regenerate it from the live catalog at click time: newly added
      // providers have not been authorized for this task.
      const selection = autoDrafts.get(autoDraftKey(autoProtocol));
      if (!selection) { setResult('请先配置并确认 Auto Provider 候选', 'err'); return; }
      payload.providerSelection = cloneAutoSelection(selection);
    } else {
      // A provider suggestion belongs to its CLI. Once the user explicitly
      // switches CLI, leaving Provider blank means that CLI's own default — it
      // must not inherit a stale provider from the previous CLI.
      const suggestedProvider = !explicitCli || explicitCli === runtimeSuggest?.cli
        ? runtimeSuggest?.provider || '' : '';
      const effProvider = picked || suggestedProvider;
      if (effProvider) payload.provider = effProvider;
    }
    sending = true;
    syncRuntimeControls();
    setResult('路由中…');
    const sendContextKey = composerContextKey;
    try {
      const okText = await opts.submit(payload);
      if (sendContextKey !== composerContextKey) return;
      setResult(okText || '已发送', 'ok');
      input.value = '';
      chiprow.innerHTML = '';
      chiprow.style.display = 'none';
      pendingClientMsgId = '';
      pendingText = '';
    } catch (e) {
      if (sendContextKey === composerContextKey) setResult(String(e.message || e), 'err');
    }
    finally {
      sending = false;
      syncRuntimeControls();
    }
  }
  sendBtn.onclick = doSend;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });

  function clearMessageDraft() {
    input.value = '';
    chiprow.innerHTML = '';
    chiprow.style.display = 'none';
    fileInput.value = '';
    goalBtn.classList.remove('on');
    goalRow.style.display = 'none';
    pendingClientMsgId = '';
    pendingText = '';
    setResult('');
  }

  return {
    reset() { clearMessageDraft(); },
    focus() { input.focus(); },
    setContext(contextKey) {
      const next = String(contextKey || '');
      if (next === composerContextKey) return;
      composerContextKey = next;
      pickerEpoch += 1;
      const loadEpoch = ++runtimeLoadEpoch;
      if (closeActivePicker) closeActivePicker();
      autoConfigLoading = false;
      if (recorder && recorder.state === 'recording') recorder.stop();
      clearMessageDraft();
      cliSel.value = '';
      provSel.innerHTML = '<option value="">Provider · 加载中…</option>';
      lastProviderValue = '';
      syncAutoSummary();
      provListCli = runtimeSuggest?.cli || 'claude';
      providerLoading = true;
      syncRuntimeControls();
      loadProviderOptions(provListCli)
        .then(() => {
          if (loadEpoch !== runtimeLoadEpoch || next !== composerContextKey) return;
          providerLoading = false;
          renderProviderOptions();
          syncRuntimeControls();
        })
        .catch(() => {
          if (loadEpoch !== runtimeLoadEpoch || next !== composerContextKey) return;
          providerLoading = false;
          renderProviderOptions();
          syncRuntimeControls();
          setResult('Provider 列表加载失败', 'err');
        });
    },
    dismissOverlays() {
      pickerEpoch += 1;
      if (closeActivePicker) closeActivePicker();
      if (autoConfigLoading) {
        autoConfigLoading = false;
        providerLoading = false;
        syncRuntimeControls();
      }
    },
  };
}

// Board-tab composer (dir-level routing) — lives in the static #tb-dir-composer
// container so WS-driven re-renders of #dir-detail-body never wipe its state.
let _tbDirComposer = null;
let _tbDirComposerDirId = null;

function syncTaskBoardDirComposer(dirId, visible) {
  const host = document.getElementById('tb-dir-composer');
  if (!host) return;
  host.style.display = visible ? '' : 'none';
  if (!visible) {
    if (_tbDirComposer) _tbDirComposer.dismissOverlays();
    return;
  }
  _tbDirComposerDirId = dirId;
  if (!_tbDirComposer) {
    _tbDirComposer = createTbComposer(host, {
      contextKey: dirId,
      placeholder: '向该 Fleet 派发消息…（Commander 单向路由到空闲 worker）',
      submit: async (payload) => {
        const r = await fetch('/api/task-board/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, dirId: _tbDirComposerDirId }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.note || d.error || r.status);
        if (d.taskId) _tbPendingTaskIds = [d.taskId];
        await refreshTaskBoard(true);
        return d.taskRunId || d.routingMode === 'commander'
          ? `已创建「新任务」并交给 Commander「${d.commanderLabel || d.targetLabel}」${d.queued ? '（已安全排队）' : ''}`
          : `已创建「新任务」并路由到「${d.targetLabel}」`;
      },
    });
  } else _tbDirComposer.setContext(dirId);
}

// ── Task entry + row actions ────────────────────────────────────────────────

function handleTaskBoardRowClick(ev, taskId) {
  if (ev) ev.stopPropagation();
  if (!_tbMergeMode) {
    openTaskChatView(taskId, ev);
    return;
  }
  const task = _tbBoard.tasks.find(item => item.id === taskId);
  if (!task) return;
  if (_tbMergeTaskIds.has(taskId)) {
    _tbMergeTaskIds.delete(taskId);
    _tbRenderVisibleBoard();
    return;
  }
  const state = _tbMergeCandidateState(task);
  if (!state.ok) {
    if (typeof showToast === 'function') showToast(_tbMergeBlockText(state.reason), true);
    return;
  }
  _tbMergeTaskIds.add(taskId);
  _tbRenderVisibleBoard();
}

function toggleTaskBoardMergeMode(ev, dirId) {
  if (ev) ev.stopPropagation();
  if (_tbMergeMode) {
    _tbExitMergeMode();
  } else {
    _tbMergeMode = true;
    _tbMergeDirId = dirId;
    _tbMergeTaskIds.clear();
  }
  _tbRenderVisibleBoard();
}

function toggleTaskBoardMergeSelection(ev, taskId) {
  if (ev) ev.stopPropagation();
  if (!_tbMergeMode) return;
  const task = _tbBoard.tasks.find(item => item.id === taskId);
  if (!task) return;
  const checked = !!ev?.currentTarget?.checked;
  if (!checked) {
    _tbMergeTaskIds.delete(taskId);
    _tbRenderVisibleBoard();
    return;
  }
  const state = _tbMergeCandidateState(task);
  if (!state.ok) {
    if (ev?.currentTarget) ev.currentTarget.checked = false;
    if (typeof showToast === 'function') showToast(_tbMergeBlockText(state.reason), true);
    return;
  }
  _tbMergeTaskIds.add(taskId);
  _tbRenderVisibleBoard();
}

async function submitTaskBoardMerge(ev, button) {
  if (ev) ev.stopPropagation();
  const plan = _tbMergePlan();
  if (!plan.ok) {
    if (typeof showToast === 'function') showToast(_tbMergeBlockText(plan.reason), true);
    return;
  }
  const sourceLines = plan.sources.map(task => `  • ${task.title}`).join('\n');
  const confirmed = confirm(`合并 ${plan.sources.length + 1} 个${plan.origin.label}？\n\n保留任务：「${plan.target.title}」\n将以下任务并入它：\n${sourceLines}\n\n合并后，被并入的任务将不再单独显示。`);
  if (!confirmed) return;
  if (button) button.disabled = true;
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(plan.targetId)}/merge-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceTaskIds: plan.sourceTaskIds }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      throw new Error(window.MultiCCTaskBoardUi.taskMergeErrorMessage({ ...d, status: r.status }));
    }
    const mergedCount = Array.isArray(d.mergedTaskIds)
      ? d.mergedTaskIds.length : plan.sourceTaskIds.length;
    _tbExitMergeMode();
    await refreshTaskBoard(true);
    if (typeof showToast === 'function') {
      showToast(mergedCount
        ? `已合并 ${mergedCount} 个任务到「${plan.target.title}」`
        : `「${plan.target.title}」已是合并后的最新状态`);
    }
  } catch (e) {
    const message = window.MultiCCTaskBoardUi.taskMergeErrorMessage(e);
    if (typeof showToast === 'function') showToast(`合并失败：${message}`, true);
    if (button) button.disabled = false;
  }
}

// M2 · the default task entry: the unified chat view in a new tab (the same
// window.open pattern manage.js uses for chat sessions). M4 (design D3) made
// it the only entry — the legacy stacked modal is gone.
function openTaskChatView(taskId, ev) {
  if (ev) ev.stopPropagation();
  window.open(`/chat.html?task=${encodeURIComponent(taskId)}`, '_blank');
}

async function setTaskBoardStatus(taskId, status, ev) {
  if (ev) ev.stopPropagation();
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    refreshTaskBoard(true);
    return true;
  } catch (e) {
    if (typeof showToast === 'function') showToast(`操作失败：${e.message}`, true);
    return false;
  }
}

// M3 · one-click task worktree cleanup (D2): merge the task branch back, then
// remove the worktree and clear the ledger fields. Each server-side step is
// idempotent; a refusal (run active, conflicts, dirty tree) leaves everything
// untouched and tells the user why.
async function cleanupTaskWorktree(ev, taskId, button) {
  if (ev) ev.stopPropagation();
  if (!confirm('把任务分支合并回基分支并删除任务 worktree？（正在执行的任务会被拒绝）')) return;
  if (button) button.disabled = true;
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/cleanup-worktree`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      const notes = {
        run_active: '任务正在执行，结束后再清理',
        merge_failed: '合并失败：请先在任务 chat 中处理冲突再试',
        worktree_remove_refused: 'worktree 有未提交或未合并改动，已安全拒绝',
      };
      throw new Error(notes[d.code] || d.error || d.code || r.status);
    }
    if (typeof showToast === 'function') {
      showToast(d.merged ? '已合并并清理任务 worktree' : '无新提交，worktree 已清理');
    }
    setTimeout(() => refreshTaskBoard(true), 0);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`清理失败：${e.message}`, true);
    if (button) button.disabled = false;
  }
}

async function archiveTaskBoardTask(ev, taskId, button) {
  if (ev) ev.stopPropagation();
  if (!confirm('归档该任务？（从任务板隐藏，数据保留）')) return;
  if (button) button.disabled = true;
  const archived = await setTaskBoardStatus(taskId, 'archived', ev);
  if (!archived && button) button.disabled = false;
}

async function archiveCompletedTaskBoard(ev, dirId, button) {
  if (ev) ev.stopPropagation();
  if (button) button.disabled = true;
  try {
    const r = await fetch('/api/task-board/archive-completed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirId }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || r.status);
    if (typeof showToast === 'function') showToast(`已归档 ${d.archivedCount} 个已完成任务`);
    await refreshTaskBoard(true);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`一键清理失败：${e.message}`, true);
    if (button) button.disabled = false;
  }
}

async function reclassifyTaskBoardTask(ev, taskId) {
  if (ev) ev.stopPropagation();
  const btn = ev && ev.currentTarget;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/task-board/tasks/${encodeURIComponent(taskId)}/reclassify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.note || d.error || r.status);
    if (typeof showToast === 'function') {
      const params = { queued: d.queued ? 1 : 0, archived: d.archived ? 1 : 0, skipped: 0 };
      showToast(typeof window.t === 'function'
        ? window.t('reclassifyQueued', params)
        : `已加入 ${params.queued} 个任务，归档 ${params.archived} 个无上下文任务，跳过 0 个`);
    }
    await refreshTaskBoard(true);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`重新归类失败：${e.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function reclassifyPendingTaskBoard(ev, dirId) {
  if (ev) ev.stopPropagation();
  const btn = ev && ev.currentTarget;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/task-board/reclassify-pending', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirId }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.note || d.error || r.status);
    if (typeof showToast === 'function') {
      const params = { queued: d.queued || 0, archived: d.archived || 0, skipped: d.skipped || 0 };
      showToast(typeof window.t === 'function'
        ? window.t('reclassifyQueued', params)
        : `已加入 ${params.queued} 个任务，归档 ${params.archived} 个无上下文任务，跳过 ${params.skipped} 个`);
    }
    await refreshTaskBoard(true);
  } catch (e) {
    if (typeof showToast === 'function') showToast(`批量归类失败：${e.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// The overview Fleet cards are now board-state consumers too, so reconcile in
// every visible manage tab. This clears a stale running glow after a lost WS
// transition even when the directory-detail modal was never opened.
setInterval(() => {
  if (document.visibilityState !== 'hidden') refreshTaskBoard(true);
}, 60000);
refreshTaskBoard(true);

// ── 归拢中浮窗 + 定位高亮 ─────────────────────────────────────────────────
function _tbShowGatheringFloat() {
  if (_tbGatheringFloat) return;
  _tbGatheringFloat = document.createElement('div');
  _tbGatheringFloat.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(0,0,0,0.85);color:#fff;padding:12px 18px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
  _tbGatheringFloat.innerHTML = '<span style="display:inline-block;animation:spin 1s linear infinite">🔄</span> 任务归拢中…';
  document.body.appendChild(_tbGatheringFloat);
  const style = document.createElement('style');
  style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  // 1.5s 超时兜底
  setTimeout(() => _tbHideGatheringFloat(), 1500);
}

function _tbHideGatheringFloat() {
  if (_tbGatheringFloat) {
    _tbGatheringFloat.remove();
    _tbGatheringFloat = null;
  }
}

function _tbScrollToTask(taskId) {
  // dir-detail-body 是滚动容器（manage.html 的弹窗里）
  const container = document.getElementById('dir-detail-body');
  if (!container) return;
  const allTasks = container.querySelectorAll('.tb-task');
  for (const el of allTasks) {
    if (el.textContent.includes(taskId) || el.onclick?.toString().includes(taskId)) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.outline = '2px solid #f9c74f';
      el.style.outlineOffset = '2px';
      setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 3000);
      break;
    }
  }
}
