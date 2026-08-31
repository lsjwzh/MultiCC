(function initMultiCCTaskPlanner() {
  'use strict';

  const STAGES = Object.freeze(['inbox', 'ready', 'doing', 'review', 'done']);
  const PRIORITIES = Object.freeze(['urgent', 'high', 'medium', 'low']);
  const api = window.MultiCCApi;
  const boardUi = window.MultiCCTaskBoardUi;
  const statusUi = window.MultiCCStatusPresentation;

  const COPY = {
    zh: {
      plannerTaskCenter: '任务中心',
      plannerSubtitle: '主动计划、执行与验收',
      plannerBoard: '看板',
      plannerHistory: '历史记录',
      plannerNeedsMe: '需要我',
      plannerNewTask: '＋ 新建任务',
      plannerAllFleets: '全部 Fleet',
      plannerSearchPlaceholder: '搜索任务、描述或模块…',
      plannerRefresh: '刷新任务中心',
      plannerNeedsAttention: '需要你处理',
      plannerWaitingCount: '等待回答 {n}',
      plannerErrorCount: '执行异常 {n}',
      plannerAttentionEmpty: '当前没有需要你处理的任务',
      plannerAttentionAll: '全部提醒',
      plannerStageInbox: '收件箱',
      plannerStageReady: '待执行',
      plannerStageDoing: '进行中',
      plannerStageReview: '待验收',
      plannerStageDone: '已完成',
      plannerStageInboxHint: '先收集，后梳理',
      plannerStageReadyHint: '计划明确，可启动',
      plannerStageDoingHint: '限制在制任务',
      plannerStageReviewHint: '检查结果与 Diff',
      plannerStageDoneHint: '已明确验收',
      plannerColumnEmpty: '把任务拖到这里',
      plannerLoading: '正在加载任务计划…',
      plannerLoadFailed: '任务中心加载失败：{error}',
      plannerRetry: '重试',
      plannerNoPlannedTitle: '还没有主动计划任务',
      plannerNoPlannedBody: '点击“新建任务”，先保存到收件箱，再决定何时启动。',
      plannerNoHistoryTitle: '没有匹配的历史记录',
      plannerNoHistoryBody: '会话中自动归类的 observed 任务会保留在这里。',
      plannerUntitled: '未命名任务',
      plannerNoModule: '未分模块',
      plannerPriority: '优先级',
      plannerPriorityNone: '无优先级',
      plannerPriorityUrgent: '紧急',
      plannerPriorityHigh: '高',
      plannerPriorityMedium: '中',
      plannerPriorityLow: '低',
      plannerDue: '截止时间',
      plannerDueNone: '无截止时间',
      plannerDueOverdue: '已逾期 {date}',
      plannerDueSoon: '即将到期 {date}',
      plannerDueDate: '截止 {date}',
      plannerModule: '模块',
      plannerFleet: 'Fleet',
      plannerCreated: '创建于 {date}',
      plannerUpdated: '更新于 {date}',
      plannerHistorySummary: '{modules} 个模块 · {tasks} 条历史记录',
      plannerPromote: '提升为待办',
      plannerPromoted: '已复制到收件箱，原历史记录保持不变',
      plannerOpenChat: '打开任务 Chat',
      plannerNewTitle: '新建计划任务',
      plannerNewSubtitle: '先记录 TODO；只有“保存并启动”才会创建执行轮次。',
      plannerTitle: '任务标题',
      plannerTitlePlaceholder: '一句话描述要完成的结果',
      plannerTitleLimit: '最多 40 个字符',
      plannerDescription: '任务描述',
      plannerDescriptionPlaceholder: '补充背景、范围和重要约束…',
      plannerAcceptance: '验收标准',
      plannerAcceptancePlaceholder: '怎样才算完成？每行可写一条标准。',
      plannerSaveInbox: '保存到收件箱',
      plannerSaveStart: '保存并启动',
      plannerCancel: '取消',
      plannerCreateRequired: '请填写标题并选择 Fleet',
      plannerCreatedInbox: '任务已保存到收件箱',
      plannerCreatedStarted: '任务已创建并开始执行',
      plannerCreatedStartFailed: '任务已保存，但启动失败：{error}',
      plannerTaskDetails: '任务计划',
      plannerStage: '工作流阶段',
      plannerSaveChanges: '保存修改',
      plannerStart: '开始执行',
      plannerComplete: '完成',
      plannerReopen: '重开',
      plannerArchive: '归档',
      plannerArchiveConfirm: '归档这个任务？它会从看板中移除，但历史数据仍会保留。',
      plannerSaved: '任务计划已保存',
      plannerStarted: '任务已开始执行',
      plannerCompleted: '任务已标记完成',
      plannerReopened: '任务已重新打开',
      plannerArchived: '任务已归档',
      plannerBusy: '任务当前正在执行或等待，不能重复启动',
      plannerConflict: '任务计划已被其他页面更新，已刷新为最新版本',
      plannerMoveFailed: '移动任务失败：{error}',
      plannerSaveFailed: '保存失败：{error}',
      plannerActionFailed: '操作失败：{error}',
      plannerRunIndependent: '运行状态只表示 Agent 当前情况，不会自动改变看板阶段。',
      plannerObserved: '会话记录',
      plannerLifecycleDone: '已完成',
      plannerLifecycleArchived: '已归档',
      plannerLifecycleActive: '活跃',
      plannerUnknownFleet: '未知 Fleet',
      plannerNoDescription: '暂无补充描述',
      plannerDragLabel: '拖动任务：{title}',
      plannerOpenTaskLabel: '打开任务：{title}',
    },
    en: {
      plannerTaskCenter: 'Task Center',
      plannerSubtitle: 'Plan, execute, and review proactively',
      plannerBoard: 'Board',
      plannerHistory: 'History',
      plannerNeedsMe: 'Needs me',
      plannerNewTask: '+ New task',
      plannerAllFleets: 'All fleets',
      plannerSearchPlaceholder: 'Search tasks, descriptions, or modules...',
      plannerRefresh: 'Refresh task center',
      plannerNeedsAttention: 'Needs your attention',
      plannerWaitingCount: '{n} waiting for reply',
      plannerErrorCount: '{n} execution errors',
      plannerAttentionEmpty: 'Nothing needs your attention right now',
      plannerAttentionAll: 'All alerts',
      plannerStageInbox: 'Inbox',
      plannerStageReady: 'Ready',
      plannerStageDoing: 'Doing',
      plannerStageReview: 'Review',
      plannerStageDone: 'Done',
      plannerStageInboxHint: 'Capture before planning',
      plannerStageReadyHint: 'Planned and ready to start',
      plannerStageDoingHint: 'Keep work in progress focused',
      plannerStageReviewHint: 'Check results and diffs',
      plannerStageDoneHint: 'Explicitly accepted',
      plannerColumnEmpty: 'Drop a task here',
      plannerLoading: 'Loading task plans...',
      plannerLoadFailed: 'Could not load Task Center: {error}',
      plannerRetry: 'Retry',
      plannerNoPlannedTitle: 'No planned tasks yet',
      plannerNoPlannedBody: 'Create a task, save it to the Inbox, and start it when you are ready.',
      plannerNoHistoryTitle: 'No matching history',
      plannerNoHistoryBody: 'Observed tasks classified from chats stay here.',
      plannerUntitled: 'Untitled task',
      plannerNoModule: 'No module',
      plannerPriority: 'Priority',
      plannerPriorityNone: 'No priority',
      plannerPriorityUrgent: 'Urgent',
      plannerPriorityHigh: 'High',
      plannerPriorityMedium: 'Medium',
      plannerPriorityLow: 'Low',
      plannerDue: 'Due date',
      plannerDueNone: 'No due date',
      plannerDueOverdue: 'Overdue {date}',
      plannerDueSoon: 'Due soon {date}',
      plannerDueDate: 'Due {date}',
      plannerModule: 'Module',
      plannerFleet: 'Fleet',
      plannerCreated: 'Created {date}',
      plannerUpdated: 'Updated {date}',
      plannerHistorySummary: '{modules} modules · {tasks} history items',
      plannerPromote: 'Promote to todo',
      plannerPromoted: 'Copied to Inbox; the original history item was preserved',
      plannerOpenChat: 'Open task chat',
      plannerNewTitle: 'New planned task',
      plannerNewSubtitle: 'Save a TODO first. Only “Save & start” creates an execution turn.',
      plannerTitle: 'Task title',
      plannerTitlePlaceholder: 'Describe the outcome in one sentence',
      plannerTitleLimit: '40 characters maximum',
      plannerDescription: 'Description',
      plannerDescriptionPlaceholder: 'Add context, scope, and important constraints...',
      plannerAcceptance: 'Acceptance criteria',
      plannerAcceptancePlaceholder: 'What does done mean? You can put one criterion per line.',
      plannerSaveInbox: 'Save to Inbox',
      plannerSaveStart: 'Save & start',
      plannerCancel: 'Cancel',
      plannerCreateRequired: 'Enter a title and choose a fleet',
      plannerCreatedInbox: 'Task saved to Inbox',
      plannerCreatedStarted: 'Task created and started',
      plannerCreatedStartFailed: 'Task was saved, but start failed: {error}',
      plannerTaskDetails: 'Task plan',
      plannerStage: 'Workflow stage',
      plannerSaveChanges: 'Save changes',
      plannerStart: 'Start execution',
      plannerComplete: 'Complete',
      plannerReopen: 'Reopen',
      plannerArchive: 'Archive',
      plannerArchiveConfirm: 'Archive this task? It will leave the board, but its history will be preserved.',
      plannerSaved: 'Task plan saved',
      plannerStarted: 'Task execution started',
      plannerCompleted: 'Task marked complete',
      plannerReopened: 'Task reopened',
      plannerArchived: 'Task archived',
      plannerBusy: 'This task is already running or waiting and cannot be started again',
      plannerConflict: 'This plan changed elsewhere. The board has been refreshed.',
      plannerMoveFailed: 'Could not move task: {error}',
      plannerSaveFailed: 'Could not save: {error}',
      plannerActionFailed: 'Action failed: {error}',
      plannerRunIndependent: 'Agent run status is informational and never moves the card automatically.',
      plannerObserved: 'Chat record',
      plannerLifecycleDone: 'Completed',
      plannerLifecycleArchived: 'Archived',
      plannerLifecycleActive: 'Active',
      plannerUnknownFleet: 'Unknown fleet',
      plannerNoDescription: 'No additional description',
      plannerDragLabel: 'Drag task: {title}',
      plannerOpenTaskLabel: 'Open task: {title}',
    },
  };

  if (window.I18N) {
    for (const lang of ['zh', 'en']) Object.assign(window.I18N[lang] || (window.I18N[lang] = {}), COPY[lang]);
  }

  const state = {
    board: { modules: [], tasks: [] },
    directories: [],
    revision: 0,
    loaded: false,
    loading: false,
    error: '',
    mode: 'board',
    dirId: '',
    query: '',
    attention: '',
    mobileStage: 'inbox',
    draggingId: '',
    loadEpoch: 0,
    searchTimer: null,
    // A failed/ambiguous send must retry with the same idempotency key. The key
    // is cleared only after the server acknowledges the task turn.
    sendIds: new Map(),
  };

  const root = document.getElementById('task-planner-root');
  if (!root) return;

  function tr(key, params) {
    if (typeof window.t === 'function') return window.t(key, params);
    const lang = localStorage.getItem('multicc_lang') === 'en' ? 'en' : 'zh';
    let text = COPY[lang][key] || COPY.zh[key] || key;
    return params ? text.replace(/\{(\w+)\}/g, (_, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`
    )) : text;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function notify(message, isError) {
    if (typeof window.showToast === 'function') window.showToast(message, !!isError);
    else if (isError) console.error(message);
    else console.info(message);
  }

  function errorText(error) {
    if (api && typeof api.errorDisplay === 'function') {
      const display = api.errorDisplay(error);
      if (display && display.message) return display.message;
    }
    return String(error && error.message ? error.message : error || 'Request failed');
  }

  async function requestJson(path, options) {
    if (api && typeof api.json === 'function') return api.json(path, options || {});
    const opts = { ...(options || {}) };
    if (Object.prototype.hasOwnProperty.call(opts, 'json')) {
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
      opts.headers = { ...(opts.headers || {}), 'Content-Type': 'application/json' };
    }
    const response = await fetch(path, opts);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || data.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.details = data;
      throw error;
    }
    return data;
  }

  function isConflict(error) {
    const detailCode = String(error && error.details && error.details.error || '');
    if (detailCode) return detailCode === 'revision_conflict';
    return Number(error && error.status) === 409 || Number(error && error.details && error.details.status) === 409;
  }

  function normalizeBoard(snapshot) {
    const value = boardUi && typeof boardUi.reconcileSnapshot === 'function'
      ? boardUi.reconcileSnapshot(snapshot)
      : snapshot;
    return {
      ...(value && typeof value === 'object' ? value : {}),
      modules: Array.isArray(value && value.modules) ? value.modules : [],
      tasks: Array.isArray(value && value.tasks) ? value.tasks : [],
    };
  }

  async function loadPlanner(options) {
    const quiet = !!(options && options.quiet);
    const epoch = ++state.loadEpoch;
    if (!quiet || !state.loaded) {
      state.loading = true;
      state.error = '';
      render();
    }
    try {
      const requests = [requestJson('/api/task-board')];
      if (!state.directories.length) requests.push(requestJson('/api/directories'));
      const results = await Promise.all(requests);
      if (epoch !== state.loadEpoch) return;
      const snapshot = results[0] || {};
      if (snapshot.ok === false) throw new Error(snapshot.error || 'Invalid task board snapshot');
      const incomingRevision = Number(snapshot.revision) || 0;
      // A websocket refresh and a user-triggered refresh can overlap. The epoch
      // rejects responses from an older request; this monotonic check also
      // rejects a stale replica/cache response that was requested later.
      if (state.loaded && incomingRevision && incomingRevision < state.revision) {
        state.loading = false;
        return;
      }
      state.board = normalizeBoard(snapshot);
      state.revision = Math.max(state.revision, incomingRevision);
      if (results[1]) state.directories = Array.isArray(results[1]) ? results[1].filter(item => !item.external) : [];
      state.loaded = true;
      state.loading = false;
      state.error = '';
      render();
    } catch (error) {
      if (epoch !== state.loadEpoch) return;
      state.loading = false;
      state.error = errorText(error);
      render();
    }
  }

  function modulesById() {
    return new Map(state.board.modules.map(module => [String(module.id), module]));
  }

  function directoriesById() {
    return new Map(state.directories.map(directory => [String(directory.id), directory]));
  }

  function taskDirId(task, moduleMap) {
    const direct = String(task && task.dirId || '').trim();
    if (direct) return direct;
    const first = String(task && task.dirIds && task.dirIds[0] || '').trim();
    if (first) return first;
    const module = moduleMap.get(String(task && task.moduleId || ''));
    return String(module && module.dirId || '').trim();
  }

  function taskTitle(task) {
    const direct = String(task && task.title || '').trim();
    if (direct) return direct;
    const description = String(task && (task.description || task.body) || '').trim();
    return description.split(/\r?\n/)[0].slice(0, 160) || tr('plannerUntitled');
  }

  function taskDescription(task) {
    return String(task && (task.description != null ? task.description : task.body) || '').trim();
  }

  function taskStage(task) {
    const stage = String(task && task.workflowStage || '').toLowerCase();
    if (STAGES.includes(stage)) return stage;
    return task && task.status === 'done' ? 'done' : 'inbox';
  }

  function taskStatus(task) {
    if (statusUi && typeof statusUi.taskStatus === 'function') return statusUi.taskStatus(task || {});
    if (task && ['done', 'archived'].includes(task.status)) return task.status;
    return String(task && task.runState || 'idle');
  }

  function attentionKind(task) {
    const status = taskStatus(task);
    if (status === 'error' || status === 'blocked') return 'error';
    if (status === 'waiting') return 'waiting';
    return '';
  }

  function rankCompare(first, second) {
    const a = Number(first && first.rank);
    const b = Number(second && second.rank);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
    const text = String(first && first.rank || '').localeCompare(String(second && second.rank || ''), 'en', { numeric: true });
    if (text) return text;
    const time = (Number(first && (first.createdAt || first.lastTs)) || 0)
      - (Number(second && (second.createdAt || second.lastTs)) || 0);
    return time || taskTitle(first).localeCompare(taskTitle(second));
  }

  function baseTasks(mode) {
    const planned = mode === 'board';
    return state.board.tasks.filter(task => (
      planned ? task.recordType === 'planned' && task.status !== 'archived' : task.recordType !== 'planned'
    ));
  }

  function filteredTasks(mode) {
    const moduleMap = modulesById();
    const query = state.query.trim().toLocaleLowerCase();
    return baseTasks(mode).filter(task => {
      if (state.dirId && taskDirId(task, moduleMap) !== state.dirId) return false;
      if (state.attention) {
        const kind = attentionKind(task);
        if (state.attention === 'all' ? !kind : kind !== state.attention) return false;
      }
      if (!query) return true;
      const module = moduleMap.get(String(task.moduleId || ''));
      const haystack = [taskTitle(task), taskDescription(task), module && module.name, task.acceptanceCriteria]
        .join('\n').toLocaleLowerCase();
      return haystack.includes(query);
    });
  }

  function allAttention(mode) {
    const moduleMap = modulesById();
    const query = state.query.trim().toLocaleLowerCase();
    return baseTasks(mode).filter(task => {
      if (state.dirId && taskDirId(task, moduleMap) !== state.dirId) return false;
      if (query) {
        const module = moduleMap.get(String(task.moduleId || ''));
        const haystack = [taskTitle(task), taskDescription(task), module && module.name, task.acceptanceCriteria]
          .join('\n').toLocaleLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return !!attentionKind(task);
    });
  }

  function stageKey(stage) {
    return `plannerStage${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
  }

  function stageHintKey(stage) {
    return `${stageKey(stage)}Hint`;
  }

  function priorityLabel(priority) {
    if (!PRIORITIES.includes(priority)) return tr('plannerPriorityNone');
    return tr(`plannerPriority${priority.charAt(0).toUpperCase()}${priority.slice(1)}`);
  }

  function localDate(value, withTime) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const locale = (typeof window.getLang === 'function' && window.getLang() === 'en') ? 'en-US' : 'zh-CN';
    return new Intl.DateTimeFormat(locale, withTime
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' }).format(date);
  }

  function duePresentation(task) {
    if (!task || !task.dueAt) return null;
    const timestamp = Date.parse(task.dueAt);
    if (!Number.isFinite(timestamp)) return null;
    const date = localDate(timestamp, false);
    const diff = timestamp - Date.now();
    if (diff < 0 && taskStage(task) !== 'done') {
      return { className: 'due-overdue', label: tr('plannerDueOverdue', { date }) };
    }
    if (diff < 48 * 60 * 60 * 1000 && taskStage(task) !== 'done') {
      return { className: 'due-soon', label: tr('plannerDueSoon', { date }) };
    }
    return { className: '', label: tr('plannerDueDate', { date }) };
  }

  function statusHtml(task, showLabel) {
    const status = taskStatus(task);
    if (statusUi && typeof statusUi.statusBadgeHtml === 'function') {
      return statusUi.statusBadgeHtml('task', status, { translate: tr, showLabel: showLabel !== false });
    }
    return `<span class="planner-badge">${esc(status)}</span>`;
  }

  function cardHtml(task, context) {
    const moduleMap = context.moduleMap;
    const dirMap = context.dirMap;
    const module = moduleMap.get(String(task.moduleId || ''));
    const dirId = taskDirId(task, moduleMap);
    const directory = dirMap.get(dirId);
    const title = taskTitle(task);
    const description = taskDescription(task);
    const due = duePresentation(task);
    const priority = String(task.priority || '').toLowerCase();
    const attention = attentionKind(task);
    const updated = task.updatedAt || task.lastTs || task.createdAt;
    return `<article class="planner-card${attention ? ` attention-${attention}` : ''}"
      data-task-id="${esc(task.id)}" data-action="open-task" draggable="true" tabindex="0"
      aria-label="${esc(tr('plannerOpenTaskLabel', { title }))}" title="${esc(tr('plannerDragLabel', { title }))}">
      <div class="planner-card-title">${esc(title)}</div>
      ${description && description !== title ? `<div class="planner-card-description">${esc(description)}</div>` : ''}
      <div class="planner-card-badges">
        ${priority ? `<span class="planner-badge priority-${esc(priority)}">◆ ${esc(priorityLabel(priority))}</span>` : ''}
        ${due ? `<span class="planner-badge ${esc(due.className)}">◷ ${esc(due.label)}</span>` : ''}
        <span class="planner-badge module" title="${esc(module && module.name || tr('plannerNoModule'))}"># ${esc(module && module.name || tr('plannerNoModule'))}</span>
        ${statusHtml(task, true)}
      </div>
      <div class="planner-card-footer">
        <span title="${esc(tr('plannerFleet'))}">${esc(directory && directory.name || tr('plannerUnknownFleet'))}</span>
        <span>${esc(updated ? tr('plannerUpdated', { date: localDate(updated, true) }) : '')}</span>
      </div>
    </article>`;
  }

  function boardHtml() {
    const tasks = filteredTasks('board').sort(rankCompare);
    const moduleMap = modulesById();
    const dirMap = directoriesById();
    const context = { moduleMap, dirMap };
    return `<div class="planner-board-scroll"><div class="planner-board">
      ${STAGES.map(stage => {
        const list = tasks.filter(task => taskStage(task) === stage);
        return `<section class="planner-column${state.mobileStage === stage ? ' is-mobile-active' : ''}" data-stage="${stage}">
          <header class="planner-column-head">
            <span class="planner-column-dot" aria-hidden="true"></span>
            <span class="planner-column-title">${esc(tr(stageKey(stage)))}</span>
            <span class="planner-column-hint">${esc(tr(stageHintKey(stage)))}</span>
            <span class="planner-column-count">${list.length}</span>
          </header>
          <div class="planner-card-list" data-stage="${stage}" data-empty="${esc(tr('plannerColumnEmpty'))}">
            ${list.map(task => cardHtml(task, context)).join('')}
          </div>
        </section>`;
      }).join('')}
    </div></div>`;
  }

  function historyHtml() {
    const tasks = filteredTasks('history');
    if (!tasks.length) {
      return `<div class="planner-empty"><div><strong>${esc(tr('plannerNoHistoryTitle'))}</strong>${esc(tr('plannerNoHistoryBody'))}</div></div>`;
    }
    const moduleMap = modulesById();
    const dirMap = directoriesById();
    const groups = new Map();
    for (const task of tasks) {
      const key = String(task.moduleId || '__none__');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    }
    const ordered = [...groups.entries()].sort((first, second) => {
      const firstName = moduleMap.get(first[0]) && moduleMap.get(first[0]).name || tr('plannerNoModule');
      const secondName = moduleMap.get(second[0]) && moduleMap.get(second[0]).name || tr('plannerNoModule');
      return firstName.localeCompare(secondName);
    });
    return `<div class="planner-history">
      <div class="planner-history-summary">${esc(tr('plannerHistorySummary', { modules: ordered.length, tasks: tasks.length }))}</div>
      ${ordered.map(([moduleId, list]) => {
        const module = moduleMap.get(moduleId);
        const moduleName = module && module.name || tr('plannerNoModule');
        return `<details class="planner-history-group" open>
          <summary><span>${esc(moduleName)}</span><span class="planner-history-count">${list.length}</span></summary>
          ${list.sort((a, b) => (Number(b.lastTs || b.updatedAt) || 0) - (Number(a.lastTs || a.updatedAt) || 0)).map(task => {
            const directory = dirMap.get(taskDirId(task, moduleMap));
            const lifecycleKey = task.status === 'archived' ? 'plannerLifecycleArchived'
              : task.status === 'done' ? 'plannerLifecycleDone' : 'plannerLifecycleActive';
            return `<div class="planner-history-row">
              <div>
                <div class="planner-history-title" title="${esc(taskTitle(task))}">${esc(taskTitle(task))}</div>
                <div class="planner-history-meta">
                  <span>${esc(directory && directory.name || tr('plannerUnknownFleet'))}</span>
                  <span>·</span><span>${esc(tr(lifecycleKey))}</span>
                  ${statusHtml(task, true)}
                </div>
              </div>
              <div class="planner-history-actions">
                <button class="btn btn-sm" type="button" data-action="open-task" data-task-id="${esc(task.id)}">${esc(tr('plannerOpenChat'))}</button>
                <button class="btn btn-sm" type="button" data-action="promote" data-task-id="${esc(task.id)}">${esc(tr('plannerPromote'))}</button>
              </div>
            </div>`;
          }).join('')}
        </details>`;
      }).join('')}
    </div>`;
  }

  function attentionBarHtml() {
    const attention = allAttention(state.mode);
    const waiting = attention.filter(task => attentionKind(task) === 'waiting').length;
    const errors = attention.filter(task => attentionKind(task) === 'error').length;
    return `<div class="planner-attention-bar">
      <strong>${esc(tr('plannerNeedsAttention'))}</strong>
      ${waiting || errors ? `
        <button class="planner-attention-chip waiting${state.attention === 'waiting' ? ' active' : ''}" type="button" aria-pressed="${state.attention === 'waiting'}" data-action="attention" data-kind="waiting">⏸ <strong>${waiting}</strong> ${esc(tr('plannerWaitingCount', { n: waiting }).replace(String(waiting), '').trim())}</button>
        <button class="planner-attention-chip error${state.attention === 'error' ? ' active' : ''}" type="button" aria-pressed="${state.attention === 'error'}" data-action="attention" data-kind="error">⚠ <strong>${errors}</strong> ${esc(tr('plannerErrorCount', { n: errors }).replace(String(errors), '').trim())}</button>
      ` : `<span>${esc(tr('plannerAttentionEmpty'))}</span>`}
    </div>`;
  }

  function mobileTabsHtml() {
    if (state.mode !== 'board') return '<div class="planner-mobile-tabs"></div>';
    const tasks = filteredTasks('board');
    return `<div class="planner-mobile-tabs" role="tablist">
      ${STAGES.map(stage => `<button type="button" role="tab" aria-selected="${state.mobileStage === stage}" class="${state.mobileStage === stage ? 'active' : ''}" data-action="mobile-stage" data-stage="${stage}">${esc(tr(stageKey(stage)))} <span>${tasks.filter(task => taskStage(task) === stage).length}</span></button>`).join('')}
    </div>`;
  }

  function directoryOptions() {
    const selectedIds = new Set(state.directories.map(item => String(item.id)));
    const moduleMap = modulesById();
    for (const task of state.board.tasks) {
      const id = taskDirId(task, moduleMap);
      if (id && !selectedIds.has(id)) {
        state.directories.push({ id, name: id, synthetic: true });
        selectedIds.add(id);
      }
    }
    return state.directories.map(directory => `<option value="${esc(directory.id)}"${state.dirId === String(directory.id) ? ' selected' : ''}>${esc(directory.name || directory.id)}</option>`).join('');
  }

  function render() {
    const plannedCount = baseTasks('board').length;
    const plannedAttention = baseTasks('board').filter(task => !!attentionKind(task)).length;
    const navBadge = document.getElementById('nav-planner-count');
    if (navBadge) {
      navBadge.textContent = String(plannedCount);
      navBadge.title = plannedAttention ? tr('plannerNeedsAttention') + ': ' + plannedAttention : '';
    }

    const busy = state.loading && !state.loaded;
    const main = busy
      ? `<div class="planner-loading">${esc(tr('plannerLoading'))}</div>`
      : state.error
        ? `<div class="planner-error"><div>${esc(tr('plannerLoadFailed', { error: state.error }))}<div style="margin-top:12px"><button class="btn" type="button" data-action="refresh">${esc(tr('plannerRetry'))}</button></div></div></div>`
        : state.mode === 'board' ? boardHtml() : historyHtml();

    root.innerHTML = `<div class="planner-shell">
      <div class="planner-toolbar">
        <div class="planner-toolbar-group">
          <label class="planner-sr-only" for="planner-fleet-filter">${esc(tr('plannerFleet'))}</label>
          <select class="planner-control planner-select" id="planner-fleet-filter" data-control="fleet">
            <option value="">${esc(tr('plannerAllFleets'))}</option>${directoryOptions()}
          </select>
          <label class="planner-search"><span class="planner-sr-only">${esc(tr('plannerSearchPlaceholder'))}</span><input class="planner-control" type="search" value="${esc(state.query)}" placeholder="${esc(tr('plannerSearchPlaceholder'))}" data-control="search"></label>
        </div>
        <div class="planner-grow"></div>
        <div class="planner-segment" role="tablist">
          <button type="button" role="tab" aria-selected="${state.mode === 'board'}" aria-controls="planner-content" class="${state.mode === 'board' ? 'active' : ''}" data-action="mode" data-mode="board">${esc(tr('plannerBoard'))}</button>
          <button type="button" role="tab" aria-selected="${state.mode === 'history'}" aria-controls="planner-content" class="${state.mode === 'history' ? 'active' : ''}" data-action="mode" data-mode="history">${esc(tr('plannerHistory'))}</button>
        </div>
        <div class="planner-toolbar-group actions">
          <button class="btn planner-attention-toggle${state.attention ? ' active' : ''}" type="button" aria-pressed="${!!state.attention}" data-action="attention" data-kind="all">⚑ ${esc(tr('plannerNeedsMe'))}</button>
          <button class="icon-btn" type="button" data-action="refresh" title="${esc(tr('plannerRefresh'))}" aria-label="${esc(tr('plannerRefresh'))}">⟳</button>
          <button class="btn btn-green" type="button" data-action="new-task">${esc(tr('plannerNewTask'))}</button>
        </div>
      </div>
      ${attentionBarHtml()}
      ${mobileTabsHtml()}
      <div class="planner-main" id="planner-content" role="tabpanel">${main}</div>
    </div>`;
  }

  function findTask(taskId) {
    return state.board.tasks.find(task => String(task.id) === String(taskId)) || null;
  }

  function updateTaskFromResponse(data) {
    if (data && data.task && data.task.id) {
      const index = state.board.tasks.findIndex(task => task.id === data.task.id);
      if (index >= 0) state.board.tasks[index] = data.task;
      else state.board.tasks.push(data.task);
    }
    if (data && Number.isFinite(Number(data.revision))) state.revision = Number(data.revision);
  }

  function expectedRevisionBody(task, extra, override) {
    const captured = Number(override);
    const revision = Number.isSafeInteger(captured) && captured > 0
      ? captured : Math.max(1, Number(task && task.planningRevision) || 1);
    return { ...(extra || {}), expectedRevision: revision };
  }

  function clientMessageId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `planner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function sendIdForTask(taskId) {
    const id = String(taskId || '');
    if (!state.sendIds.has(id)) state.sendIds.set(id, clientMessageId());
    return state.sendIds.get(id);
  }

  async function handleConflict(error) {
    if (!isConflict(error)) return false;
    closePlannerOverlay();
    await loadPlanner({ quiet: true });
    notify(tr('plannerConflict'), true);
    return true;
  }

  async function moveTask(taskId, stage, placement, options) {
    const task = findTask(taskId);
    if (!task || !STAGES.includes(stage)) return null;
    const previousStage = taskStage(task);
    task.workflowStage = stage;
    render();
    try {
      const data = await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}/move`, {
        method: 'POST',
        json: expectedRevisionBody(task, {
          workflowStage: stage,
          ...(placement && placement.beforeTaskId ? { beforeTaskId: placement.beforeTaskId } : {}),
          ...(placement && placement.afterTaskId ? { afterTaskId: placement.afterTaskId } : {}),
        }, options && options.expectedRevision),
      });
      updateTaskFromResponse(data);
      if (!(options && options.skipReload)) await loadPlanner({ quiet: true });
      return data;
    } catch (error) {
      task.workflowStage = previousStage;
      if (!(await handleConflict(error))) {
        await loadPlanner({ quiet: true });
        notify(tr('plannerMoveFailed', { error: errorText(error) }), true);
      }
      return null;
    }
  }

  function criteriaText(value) {
    return Array.isArray(value) ? value.join('\n') : String(value || '');
  }

  function datetimeLocalValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function isoFromLocal(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function closePlannerOverlay() {
    const overlay = document.querySelector('.planner-overlay');
    if (overlay) {
      const returnFocus = overlay.__plannerReturnFocus;
      overlay.remove();
      if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
    }
  }

  function activateOverlay(overlay, initialSelector) {
    overlay.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')]
        .filter(element => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
    setTimeout(() => overlay.querySelector(initialSelector)?.focus(), 0);
  }

  function panelOptions(selected) {
    return state.directories.map(directory => `<option value="${esc(directory.id)}"${selected === String(directory.id) ? ' selected' : ''}>${esc(directory.name || directory.id)}</option>`).join('');
  }

  function priorityOptions(selected) {
    return `<option value=""${selected ? '' : ' selected'}>${esc(tr('plannerPriorityNone'))}</option>`
      + PRIORITIES.map(priority => `<option value="${priority}"${selected === priority ? ' selected' : ''}>${esc(priorityLabel(priority))}</option>`).join('');
  }

  function stageOptions(selected) {
    return STAGES.map(stage => `<option value="${stage}"${selected === stage ? ' selected' : ''}>${esc(tr(stageKey(stage)))}</option>`).join('');
  }

  function openNewTaskDialog() {
    closePlannerOverlay();
    const selectedDir = state.dirId || String(state.directories[0] && state.directories[0].id || '');
    const overlay = document.createElement('div');
    overlay.className = 'planner-overlay centered';
    overlay.__plannerReturnFocus = document.activeElement;
    overlay.innerHTML = `<form class="planner-dialog" id="planner-new-form">
      <div class="planner-panel-head">
        <div class="planner-panel-title"><h2>${esc(tr('plannerNewTitle'))}</h2><p>${esc(tr('plannerNewSubtitle'))}</p></div>
        <button class="icon-btn" type="button" data-overlay-close aria-label="${esc(tr('plannerCancel'))}">×</button>
      </div>
      <div class="planner-panel-body"><div class="planner-form-grid">
        <div class="planner-field full"><label for="planner-new-title">${esc(tr('plannerTitle'))}</label><input id="planner-new-title" name="title" maxlength="40" required placeholder="${esc(tr('plannerTitlePlaceholder'))}"><span class="planner-help">${esc(tr('plannerTitleLimit'))}</span></div>
        <div class="planner-field full"><label for="planner-new-description">${esc(tr('plannerDescription'))}</label><textarea id="planner-new-description" name="description" placeholder="${esc(tr('plannerDescriptionPlaceholder'))}"></textarea></div>
        <div class="planner-field"><label for="planner-new-dir">${esc(tr('plannerFleet'))}</label><select id="planner-new-dir" name="dirId" required><option value=""></option>${panelOptions(selectedDir)}</select></div>
        <div class="planner-field"><label for="planner-new-priority">${esc(tr('plannerPriority'))}</label><select id="planner-new-priority" name="priority">${priorityOptions('')}</select></div>
        <div class="planner-field"><label for="planner-new-due">${esc(tr('plannerDue'))}</label><input id="planner-new-due" name="dueAt" type="datetime-local"></div>
        <div class="planner-field full"><label for="planner-new-acceptance">${esc(tr('plannerAcceptance'))}</label><textarea class="acceptance" id="planner-new-acceptance" name="acceptanceCriteria" placeholder="${esc(tr('plannerAcceptancePlaceholder'))}"></textarea></div>
      </div></div>
      <div class="planner-panel-actions">
        <button class="btn" type="button" data-overlay-close>${esc(tr('plannerCancel'))}</button><span class="spacer"></span>
        <button class="btn" type="submit" data-create-mode="inbox">${esc(tr('plannerSaveInbox'))}</button>
        <button class="btn btn-green" type="button" data-create-mode="start">${esc(tr('plannerSaveStart'))}</button>
      </div>
    </form>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-overlay-close]')) closePlannerOverlay();
      const startButton = event.target.closest('[data-create-mode="start"]');
      if (startButton) createFromDialog(overlay, true);
    });
    overlay.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      createFromDialog(overlay, false);
    });
    activateOverlay(overlay, '[name="title"]');
  }

  async function createFromDialog(overlay, startImmediately) {
    const form = overlay.querySelector('form');
    const values = new FormData(form);
    const title = String(values.get('title') || '').trim();
    const dirId = String(values.get('dirId') || '').trim();
    if (!title || !dirId) {
      notify(tr('plannerCreateRequired'), true);
      form.reportValidity();
      return;
    }
    const buttons = [...overlay.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    const description = String(values.get('description') || '').trim();
    try {
      const created = await requestJson('/api/task-board/tasks', {
        method: 'POST',
        json: {
          recordType: 'planned',
          title,
          description: description || title,
          dirId,
          workflowStage: 'inbox',
          priority: String(values.get('priority') || '') || null,
          dueAt: isoFromLocal(String(values.get('dueAt') || '')),
          acceptanceCriteria: String(values.get('acceptanceCriteria') || '').trim() || null,
        },
      });
      updateTaskFromResponse(created);
      const task = created && created.task;
      if (startImmediately && task && task.id) {
        try {
          await requestJson(`/api/task-board/tasks/${encodeURIComponent(task.id)}/send`, {
            method: 'POST',
            json: {
              text: description || title,
              clientMsgId: sendIdForTask(task.id),
              expectedRevision: Math.max(1, Number(task.planningRevision) || 1),
            },
          });
          state.sendIds.delete(String(task.id));
          notify(tr('plannerCreatedStarted'));
        } catch (error) {
          notify(tr('plannerCreatedStartFailed', { error: errorText(error) }), true);
        }
      } else notify(tr('plannerCreatedInbox'));
      closePlannerOverlay();
      state.mode = 'board';
      state.attention = '';
      await loadPlanner({ quiet: true });
    } catch (error) {
      if (!(await handleConflict(error))) notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  function openTaskDrawer(taskId) {
    const task = findTask(taskId);
    if (!task) return;
    closePlannerOverlay();
    const moduleMap = modulesById();
    const dirMap = directoriesById();
    const dirId = taskDirId(task, moduleMap);
    const directory = dirMap.get(dirId);
    const module = moduleMap.get(String(task.moduleId || ''));
    const stage = taskStage(task);
    const priority = String(task.priority || '');
    // Keep the form and its concurrency token as one snapshot. A websocket
    // refresh may update the board behind this drawer, but must not let stale
    // fields save against the newer revision.
    const openRevision = Math.max(1, Number(task.planningRevision) || 1);
    const busy = ['running', 'queued', 'waiting'].includes(taskStatus(task));
    const done = task.status === 'done' || stage === 'done';
    const overlay = document.createElement('div');
    overlay.className = 'planner-overlay';
    overlay.__plannerReturnFocus = document.activeElement;
    overlay.innerHTML = `<aside class="planner-drawer" role="dialog" aria-modal="true" aria-labelledby="planner-drawer-title">
      <div class="planner-panel-head">
        <div class="planner-panel-title"><h2 id="planner-drawer-title">${esc(taskTitle(task))}</h2><p>${esc(directory && directory.name || tr('plannerUnknownFleet'))} · ${esc(module && module.name || tr('plannerNoModule'))}</p></div>
        <button class="icon-btn" type="button" data-overlay-close aria-label="${esc(tr('plannerCancel'))}">×</button>
      </div>
      <div class="planner-panel-body"><form id="planner-edit-form" class="planner-form-grid">
        <div class="planner-field full"><label for="planner-edit-title">${esc(tr('plannerTitle'))}</label><input id="planner-edit-title" name="title" maxlength="40" required value="${esc(taskTitle(task))}"><span class="planner-help">${esc(tr('plannerTitleLimit'))}</span></div>
        <div class="planner-field full"><label for="planner-edit-description">${esc(tr('plannerDescription'))}</label><textarea id="planner-edit-description" name="description" placeholder="${esc(tr('plannerDescriptionPlaceholder'))}">${esc(taskDescription(task))}</textarea></div>
        <div class="planner-field"><label for="planner-edit-dir">${esc(tr('plannerFleet'))}</label><select id="planner-edit-dir" name="dirId" required>${panelOptions(dirId)}</select></div>
        <div class="planner-field"><label for="planner-edit-stage">${esc(tr('plannerStage'))}</label><select id="planner-edit-stage" name="workflowStage">${stageOptions(stage)}</select></div>
        <div class="planner-field"><label for="planner-edit-priority">${esc(tr('plannerPriority'))}</label><select id="planner-edit-priority" name="priority">${priorityOptions(priority)}</select></div>
        <div class="planner-field full"><label for="planner-edit-due">${esc(tr('plannerDue'))}</label><input id="planner-edit-due" name="dueAt" type="datetime-local" value="${esc(datetimeLocalValue(task.dueAt))}"></div>
        <div class="planner-field full"><label for="planner-edit-acceptance">${esc(tr('plannerAcceptance'))}</label><textarea class="acceptance" id="planner-edit-acceptance" name="acceptanceCriteria" placeholder="${esc(tr('plannerAcceptancePlaceholder'))}">${esc(criteriaText(task.acceptanceCriteria))}</textarea></div>
      </form>
      <div class="planner-save-hint">ⓘ <span>${esc(tr('plannerRunIndependent'))}</span></div>
      </div>
      <div class="planner-panel-actions">
        <button class="btn btn-green" type="button" data-drawer-action="save">${esc(tr('plannerSaveChanges'))}</button>
        <button class="btn" type="button" data-drawer-action="start"${busy ? ' disabled' : ''}>▶ ${esc(tr('plannerStart'))}</button>
        <button class="btn" type="button" data-drawer-action="chat">↗ ${esc(tr('plannerOpenChat'))}</button>
        <span class="spacer"></span>
        <button class="btn" type="button" data-drawer-action="lifecycle" data-status="${done ? 'active' : 'done'}">${done ? '♻ ' + esc(tr('plannerReopen')) : '✓ ' + esc(tr('plannerComplete'))}</button>
        <button class="btn planner-action-danger" type="button" data-drawer-action="archive">${esc(tr('plannerArchive'))}</button>
      </div>
    </aside>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-overlay-close]')) {
        closePlannerOverlay();
        return;
      }
      const action = event.target.closest('[data-drawer-action]');
      if (!action) return;
      handleDrawerAction(task.id, action.dataset.drawerAction, action, openRevision);
    });
    activateOverlay(overlay, '[name="title"]');
  }

  async function saveDrawer(taskId, button, openRevision) {
    const task = findTask(taskId);
    const form = document.getElementById('planner-edit-form');
    if (!task || !form) return;
    button.disabled = true;
    const values = new FormData(form);
    const targetStage = String(values.get('workflowStage') || 'inbox');
    const title = String(values.get('title') || '').trim();
    const dirId = String(values.get('dirId') || '').trim();
    if (!title || !dirId) {
      form.reportValidity();
      button.disabled = false;
      return;
    }
    try {
      const data = await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}/update`, {
        method: 'POST',
        json: expectedRevisionBody(task, {
          title,
          dirId,
          workflowStage: targetStage,
          description: String(values.get('description') || '').trim() || null,
          priority: String(values.get('priority') || '') || null,
          dueAt: isoFromLocal(String(values.get('dueAt') || '')),
          acceptanceCriteria: String(values.get('acceptanceCriteria') || '').trim() || null,
        }, openRevision),
      });
      updateTaskFromResponse(data);
      closePlannerOverlay();
      await loadPlanner({ quiet: true });
      notify(tr('plannerSaved'));
    } catch (error) {
      if (!(await handleConflict(error))) notify(tr('plannerSaveFailed', { error: errorText(error) }), true);
      button.disabled = false;
    }
  }

  async function startTask(taskId, button, openRevision) {
    const task = findTask(taskId);
    if (!task) return;
    if (['running', 'queued', 'waiting'].includes(taskStatus(task))) {
      notify(tr('plannerBusy'), true);
      return;
    }
    button.disabled = true;
    try {
      await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}/send`, {
        method: 'POST',
        json: {
          text: taskDescription(task) || taskTitle(task),
          clientMsgId: sendIdForTask(taskId),
          expectedRevision: openRevision,
        },
      });
      state.sendIds.delete(String(taskId));
      closePlannerOverlay();
      await loadPlanner({ quiet: true });
      notify(tr('plannerStarted'));
    } catch (error) {
      notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      button.disabled = false;
    }
  }

  async function setLifecycle(taskId, status, button, openRevision) {
    button.disabled = true;
    // Completion/reopen are planning transitions, so they use the same
    // per-card optimistic concurrency path as drag-and-drop.
    if (status === 'done' || status === 'active') {
      const moved = await moveTask(taskId, status === 'done' ? 'done' : 'ready', null, { expectedRevision: openRevision });
      if (!moved) { button.disabled = false; return; }
      closePlannerOverlay();
      notify(status === 'done' ? tr('plannerCompleted') : tr('plannerReopened'));
      return;
    }
    const task = findTask(taskId);
    if (!task) { button.disabled = false; return; }
    try {
      await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}/status`, {
        method: 'POST',
        json: { status, expectedRevision: openRevision },
      });
      closePlannerOverlay();
      await loadPlanner({ quiet: true });
      notify(tr('plannerArchived'));
    } catch (error) {
      if (!(await handleConflict(error))) notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      button.disabled = false;
    }
  }

  async function handleDrawerAction(taskId, action, button, openRevision) {
    if (action === 'save') return saveDrawer(taskId, button, openRevision);
    if (action === 'start') return startTask(taskId, button, openRevision);
    if (action === 'chat') {
      window.open(`/chat.html?task=${encodeURIComponent(taskId)}`, '_blank');
      return;
    }
    if (action === 'lifecycle') return setLifecycle(taskId, button.dataset.status, button, openRevision);
    if (action === 'archive' && window.confirm(tr('plannerArchiveConfirm'))) {
      return setLifecycle(taskId, 'archived', button, openRevision);
    }
  }

  async function promoteObserved(taskId, button) {
    const task = findTask(taskId);
    if (!task) return;
    button.disabled = true;
    const moduleMap = modulesById();
    try {
      const data = await requestJson('/api/task-board/tasks', {
        method: 'POST',
        json: {
          recordType: 'planned',
          sourceTaskId: task.id,
          title: taskTitle(task),
          description: taskDescription(task) || taskTitle(task),
          dirId: taskDirId(task, moduleMap),
          workflowStage: 'inbox',
          priority: null,
          dueAt: null,
          acceptanceCriteria: null,
        },
      });
      updateTaskFromResponse(data);
      state.mode = 'board';
      state.attention = '';
      await loadPlanner({ quiet: true });
      notify(tr('plannerPromoted'));
    } catch (error) {
      if (!(await handleConflict(error))) notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      button.disabled = false;
    }
  }

  function handleRootClick(event) {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const kind = action.dataset.action;
    if (kind === 'new-task') openNewTaskDialog();
    else if (kind === 'refresh') loadPlanner();
    else if (kind === 'mode') {
      state.mode = action.dataset.mode === 'history' ? 'history' : 'board';
      state.attention = '';
      render();
    } else if (kind === 'attention') {
      const selected = action.dataset.kind || 'all';
      state.attention = state.attention === selected ? '' : selected;
      render();
    } else if (kind === 'mobile-stage') {
      state.mobileStage = STAGES.includes(action.dataset.stage) ? action.dataset.stage : 'inbox';
      render();
    } else if (kind === 'open-task') {
      const taskId = action.dataset.taskId || action.closest('[data-task-id]')?.dataset.taskId;
      if (state.mode === 'history' && action.closest('.planner-history-actions')) {
        window.open(`/chat.html?task=${encodeURIComponent(taskId)}`, '_blank');
      } else openTaskDrawer(taskId);
    } else if (kind === 'promote') {
      promoteObserved(action.dataset.taskId, action);
    }
  }

  function handleRootChange(event) {
    if (event.target.matches('[data-control="fleet"]')) {
      state.dirId = event.target.value;
      render();
    }
  }

  function handleRootInput(event) {
    if (!event.target.matches('[data-control="search"]')) return;
    state.query = event.target.value;
    const selection = event.target.selectionStart;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      render();
      const next = root.querySelector('[data-control="search"]');
      if (next) {
        next.focus();
        if (Number.isFinite(selection)) next.setSelectionRange(selection, selection);
      }
    }, 90);
  }

  function handleRootKeydown(event) {
    const card = event.target.closest('.planner-card');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openTaskDrawer(card.dataset.taskId);
    }
  }

  function clearDragClasses() {
    root.querySelectorAll('.dragging,.drag-over').forEach(element => element.classList.remove('dragging', 'drag-over'));
  }

  function handleDragStart(event) {
    const card = event.target.closest('.planner-card');
    if (!card) return;
    state.draggingId = card.dataset.taskId;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', state.draggingId);
  }

  function handleDragOver(event) {
    const list = event.target.closest('.planner-card-list');
    if (!list || !state.draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('.planner-column.drag-over').forEach(column => column.classList.remove('drag-over'));
    list.closest('.planner-column')?.classList.add('drag-over');
  }

  async function handleDrop(event) {
    const list = event.target.closest('.planner-card-list');
    const taskId = state.draggingId || event.dataTransfer.getData('text/plain');
    if (!list || !taskId) return;
    event.preventDefault();
    const cards = [...list.querySelectorAll('.planner-card')].filter(card => card.dataset.taskId !== taskId);
    const before = cards.find(card => event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
    const placement = before
      ? { beforeTaskId: before.dataset.taskId }
      : cards.length ? { afterTaskId: cards[cards.length - 1].dataset.taskId } : {};
    const stage = list.dataset.stage;
    state.draggingId = '';
    clearDragClasses();
    await moveTask(taskId, stage, placement);
  }

  function handleDragEnd() {
    state.draggingId = '';
    clearDragClasses();
  }

  root.addEventListener('click', handleRootClick);
  root.addEventListener('change', handleRootChange);
  root.addEventListener('input', handleRootInput);
  root.addEventListener('keydown', handleRootKeydown);
  root.addEventListener('dragstart', handleDragStart);
  root.addEventListener('dragover', handleDragOver);
  root.addEventListener('drop', handleDrop);
  root.addEventListener('dragend', handleDragEnd);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.querySelector('.planner-overlay')) closePlannerOverlay();
  });

  const originalSetView = window.setView;
  window.setView = function setPlannerAwareView(view) {
    if (typeof originalSetView === 'function') originalSetView(view);
    if (view === 'tasks') {
      const crumb = document.getElementById('crumb');
      if (crumb && crumb.firstChild) {
        // The generic shell marks this node as i18n="overview". Remove that
        // stale marker so its DOMContentLoaded translation pass cannot overwrite
        // a deep-linked Task Center title after this view is selected.
        if (crumb.firstElementChild) crumb.firstElementChild.removeAttribute('data-i18n');
        crumb.firstChild.textContent = tr('plannerTaskCenter') + ' ';
      }
      const sub = document.getElementById('crumb-sub');
      if (sub) sub.textContent = tr('plannerSubtitle');
      if (!state.loaded && !state.loading) loadPlanner();
      else render();
    }
  };

  const previousBoardUpdate = window.onTaskBoardUpdate;
  window.onTaskBoardUpdate = function plannerBoardUpdate(event) {
    if (typeof previousBoardUpdate === 'function') previousBoardUpdate(event);
    clearTimeout(window.__plannerBoardUpdateTimer);
    window.__plannerBoardUpdateTimer = setTimeout(() => loadPlanner({ quiet: true }), 250);
  };

  render();
  if (new URLSearchParams(location.search).get('view') === 'tasks') window.setView('tasks');
})();
