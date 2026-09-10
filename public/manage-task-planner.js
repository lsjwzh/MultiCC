(function initMultiCCTaskPlanner() {
  'use strict';

  const STAGES = Object.freeze(['inbox', 'ready', 'doing', 'review', 'done']);
  const MODES = Object.freeze(['tasks', 'activity']);
  const ORIGINS = Object.freeze(['all', 'board', 'session']);
  const STATUS_FILTERS = Object.freeze(['attention', 'running', 'review', 'error']);
  const ORIGIN_STORAGE_KEY = 'multicc_task_center_origin';
  const PRIORITIES = Object.freeze(['urgent', 'high', 'medium', 'low']);
  const api = window.MultiCCApi;
  const boardUi = window.MultiCCTaskBoardUi;
  const statusUi = window.MultiCCStatusPresentation;

  const COPY = {
    zh: {
      plannerTaskCenter: '任务中心',
      plannerSubtitle: '按模块查看、筛选与派发任务',
      plannerTasks: '任务',
      plannerHistory: '全部记录',
      plannerSource: '来源',
      plannerSourceAll: '全部',
      plannerSourceBoard: '独立任务',
      plannerSourceSession: '会话任务',
      plannerStatusFilter: '状态',
      plannerFilterAttention: '需要我',
      plannerFilterRunning: '运行中',
      plannerFilterReview: '待验收',
      plannerFilterError: '错误',
      plannerTaskEmptyTitle: '没有匹配的任务',
      plannerTaskEmptyBody: '可以调整来源或状态筛选，也可以直接在下方派发新任务。',
      plannerTaskSummary: '{modules} 个模块 · {tasks} 个任务',
      plannerRelatedTasks: '关联任务',
      plannerLegacyTasks: '历史身份待确认',
      plannerActivitySummary: '{modules} 个模块 · {tasks} 条记录',
      plannerStartQuick: '开始',
      plannerCompleteQuick: '完成',
      plannerViewTask: '查看任务',
      plannerQuickCreate: '快速新建任务',
      plannerQuickCreateHint: '像发消息一样描述任务，Enter 发送，Shift+Enter 换行',
      plannerQuickCreatePlaceholder: '描述要完成的任务…（支持粘贴图片或文件）',
      plannerQuickCreateWorkspace: '派发到',
      plannerAllFleets: '全部工作区',
      plannerSearchPlaceholder: '搜索任务、描述或模块…',
      plannerRefresh: '刷新任务中心',
      plannerNeedsAttention: '需要你处理',
      plannerStageInbox: '收件箱',
      plannerStageReady: '待执行',
      plannerStageDoing: '进行中',
      plannerStageReview: '待验收',
      plannerStageDone: '已完成',
      plannerLoading: '正在加载任务计划…',
      plannerLoadFailed: '任务中心加载失败：{error}',
      plannerRetry: '重试',
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
      plannerDueOverdue: '已逾期 {date}',
      plannerDueSoon: '即将到期 {date}',
      plannerDueDate: '截止 {date}',
      plannerFleet: '工作区',
      plannerUpdated: '更新于 {date}',
      plannerOpenChat: '打开任务 Chat',
      plannerAnswerQuestion: '回答问题',
      plannerInspectError: '查看异常',
      plannerComposerUnavailable: '任务输入组件未加载',
      plannerTitle: '任务标题',
      plannerTitleLimit: '最多 40 个字符',
      plannerDescription: '任务描述',
      plannerDescriptionPlaceholder: '补充背景、范围和重要约束…',
      plannerAcceptance: '验收标准',
      plannerAcceptancePlaceholder: '怎样才算完成？每行可写一条标准。',
      plannerCancel: '取消',
      plannerCreateRequired: '请选择任务工作区',
      plannerCreatedStarted: '新任务已开始',
      plannerStage: '工作流阶段',
      plannerSaveChanges: '保存修改',
      plannerStart: '开始执行',
      plannerComplete: '完成',
      plannerReopen: '重开',
      plannerArchive: '归档',
      plannerArchiveConfirm: '归档这个任务？归档后只读，只有选择归档过滤器才会显示。',
      plannerCurrentTasks: '当前任务',
      plannerArchiveFilter: '归档',
      plannerDelete: '永久删除',
      plannerDeleteConfirm: '永久删除这个任务、执行记录及专属会话？无法恢复。原壳中其他任务的内容会保留。',
      plannerDeleted: '任务已永久删除',
      plannerRestore: '取消归档',
      plannerTaskBusy: '任务仍在执行、排队或等待回复，请先结束当前工作。',
      plannerTaskWorkspace: '任务工作区还有未提交或未合并的代码，请先提交并合并，再重试删除。',
      plannerTaskShared: '任务会话仍被其他任务共享，请先处理关联任务。',
      plannerSaved: '任务计划已保存',
      plannerStarted: '任务已开始执行',
      plannerCompleted: '任务已标记完成',
      plannerReopened: '任务已重新打开',
      plannerArchived: '任务已归档',
      plannerBusy: '任务当前正在执行或等待，不能重复启动',
      plannerConflict: '任务已被其他页面更新，已刷新为最新版本',
      plannerMoveFailed: '移动任务失败：{error}',
      plannerSaveFailed: '保存失败：{error}',
      plannerActionFailed: '操作失败：{error}',
      plannerRunIndependent: '运行状态只表示 Agent 当前情况，不会自动改变看板阶段。',
      plannerLifecycleDone: '已完成',
      plannerLifecycleArchived: '已归档',
      plannerLifecycleActive: '活跃',
      plannerUnknownFleet: '未知工作区',
      plannerOpenTaskLabel: '打开任务：{title}',
    },
    en: {
      plannerTaskCenter: 'Task Center',
      plannerSubtitle: 'Tasks grouped by module, ready to filter and dispatch',
      plannerTasks: 'Tasks',
      plannerHistory: 'All records',
      plannerSource: 'Source',
      plannerSourceAll: 'All',
      plannerSourceBoard: 'Independent',
      plannerSourceSession: 'Chat tasks',
      plannerStatusFilter: 'Status',
      plannerFilterAttention: 'Needs me',
      plannerFilterRunning: 'Running',
      plannerFilterReview: 'Review',
      plannerFilterError: 'Error',
      plannerTaskEmptyTitle: 'No matching tasks',
      plannerTaskEmptyBody: 'Adjust the source or status filters, or dispatch a new task below.',
      plannerTaskSummary: '{modules} modules · {tasks} tasks',
      plannerRelatedTasks: 'Related tasks',
      plannerLegacyTasks: 'Legacy identity review',
      plannerActivitySummary: '{modules} modules · {tasks} records',
      plannerStartQuick: 'Start',
      plannerCompleteQuick: 'Complete',
      plannerViewTask: 'View task',
      plannerQuickCreate: 'Quick task',
      plannerQuickCreateHint: 'Describe it like a message. Enter sends; Shift+Enter adds a line.',
      plannerQuickCreatePlaceholder: 'Describe the task… (paste images or files here)',
      plannerQuickCreateWorkspace: 'Dispatch to',
      plannerAllFleets: 'All workspaces',
      plannerSearchPlaceholder: 'Search tasks, descriptions, or modules...',
      plannerRefresh: 'Refresh task center',
      plannerNeedsAttention: 'Needs your attention',
      plannerStageInbox: 'Inbox',
      plannerStageReady: 'Ready',
      plannerStageDoing: 'Doing',
      plannerStageReview: 'Review',
      plannerStageDone: 'Done',
      plannerLoading: 'Loading task plans...',
      plannerLoadFailed: 'Could not load Task Center: {error}',
      plannerRetry: 'Retry',
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
      plannerDueOverdue: 'Overdue {date}',
      plannerDueSoon: 'Due soon {date}',
      plannerDueDate: 'Due {date}',
      plannerFleet: 'Workspace',
      plannerUpdated: 'Updated {date}',
      plannerOpenChat: 'Open task chat',
      plannerAnswerQuestion: 'Answer question',
      plannerInspectError: 'Inspect error',
      plannerComposerUnavailable: 'Task composer is unavailable',
      plannerTitle: 'Task title',
      plannerTitleLimit: '40 characters maximum',
      plannerDescription: 'Description',
      plannerDescriptionPlaceholder: 'Add context, scope, and important constraints...',
      plannerAcceptance: 'Acceptance criteria',
      plannerAcceptancePlaceholder: 'What does done mean? You can put one criterion per line.',
      plannerCancel: 'Cancel',
      plannerCreateRequired: 'Choose a task workspace',
      plannerCreatedStarted: 'New task started',
      plannerStage: 'Workflow stage',
      plannerSaveChanges: 'Save changes',
      plannerStart: 'Start execution',
      plannerComplete: 'Complete',
      plannerReopen: 'Reopen',
      plannerArchive: 'Archive',
      plannerArchiveConfirm: 'Archive this task? It becomes read-only and appears only in the archive filter.',
      plannerCurrentTasks: 'Current tasks',
      plannerArchiveFilter: 'Archived',
      plannerDelete: 'Delete permanently',
      plannerDeleteConfirm: 'Permanently delete this task, its execution records and dedicated conversation? This cannot be undone. Other tasks in the source conversation are preserved.',
      plannerDeleted: 'Task permanently deleted',
      plannerRestore: 'Unarchive',
      plannerTaskBusy: 'The task is running, queued or waiting for a reply. Finish its current work first.',
      plannerTaskWorkspace: 'The task workspace has uncommitted or unmerged code. Commit and merge it before retrying deletion.',
      plannerTaskShared: 'Other tasks still share this conversation. Resolve those references first.',
      plannerSaved: 'Task plan saved',
      plannerStarted: 'Task execution started',
      plannerCompleted: 'Task marked complete',
      plannerReopened: 'Task reopened',
      plannerArchived: 'Task archived',
      plannerBusy: 'This task is already running or waiting and cannot be started again',
      plannerConflict: 'This task changed elsewhere. The task list has been refreshed.',
      plannerMoveFailed: 'Could not move task: {error}',
      plannerSaveFailed: 'Could not save: {error}',
      plannerActionFailed: 'Action failed: {error}',
      plannerRunIndependent: 'Agent run status is informational and never moves the card automatically.',
      plannerLifecycleDone: 'Completed',
      plannerLifecycleArchived: 'Archived',
      plannerLifecycleActive: 'Active',
      plannerUnknownFleet: 'Unknown workspace',
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
    mode: 'tasks',
    dirId: '',
    composerDirId: '',
    query: '',
    archived: false,
    origin: 'all',
    statusFilters: new Set(),
    loadEpoch: 0,
    directoryLoadEpoch: 0,
    searchTimer: null,
    // A failed/ambiguous send must retry with the same idempotency key. The key
    // is cleared only after the server acknowledges the task turn.
    sendIds: new Map(),
  };
  try {
    const savedOrigin = localStorage.getItem(ORIGIN_STORAGE_KEY);
    if (ORIGINS.includes(savedOrigin)) state.origin = savedOrigin;
  } catch (_) {}

  const globalRoot = document.getElementById('task-planner-root');
  if (!globalRoot) return;
  let root = globalRoot;
  let surface = 'global';
  let lockedDirId = '';
  let globalUiState = {
    mode: state.mode,
    dirId: state.dirId,
    composerDirId: state.composerDirId,
    query: state.query,
    origin: state.origin,
    statusFilters: [...state.statusFilters],
  };
  let pendingRenderState = null;
  const boundRoots = new WeakSet();
  let quickComposer = null;
  let quickComposerHost = null;
  let quickComposerContext = '';

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

  function selectOrigin(origin) {
    state.origin = ORIGINS.includes(origin) ? origin : 'all';
    try { localStorage.setItem(ORIGIN_STORAGE_KEY, state.origin); } catch (_) {}
  }

  function errorText(error) {
    const code = error?.details?.error || error?.payload?.error || error?.code || error?.message;
    if (code === 'task_busy') return tr('plannerTaskBusy');
    if (['task_workspace_dirty', 'task_workspace_unmerged', 'dirty', 'unmerged'].includes(code)) return tr('plannerTaskWorkspace');
    if (code === 'task_session_shared' || code === 'shell_workspace_referenced') return tr('plannerTaskShared');
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
    const refreshDirectories = !!(options && options.refreshDirectories);
    const shouldLoadDirectories = refreshDirectories || !state.directories.length;
    const epoch = ++state.loadEpoch;
    const directoryEpoch = shouldLoadDirectories ? ++state.directoryLoadEpoch : 0;
    if (!quiet || !state.loaded) {
      state.loading = true;
      state.error = '';
      render();
    }
    try {
      const requests = [requestJson('/api/task-board')];
      if (shouldLoadDirectories) requests.push(requestJson('/api/directories'));
      const results = await Promise.all(requests);
      let directoriesApplied = false;
      if (shouldLoadDirectories && directoryEpoch === state.directoryLoadEpoch && Array.isArray(results[1])) {
        state.directories = results[1].filter(item => !item.external);
        directoriesApplied = true;
      }
      if (epoch !== state.loadEpoch) {
        if (directoriesApplied && state.loaded) render();
        return;
      }
      const snapshot = results[0] || {};
      if (snapshot.ok === false) throw new Error(snapshot.error || 'Invalid task board snapshot');
      const incomingRevision = Number(snapshot.revision) || 0;
      // A websocket refresh and a user-triggered refresh can overlap. The epoch
      // rejects responses from an older request; this monotonic check also
      // rejects a stale replica/cache response that was requested later.
      if (state.loaded && incomingRevision && incomingRevision < state.revision) {
        state.loading = false;
        if (shouldLoadDirectories) render();
        return;
      }
      state.board = normalizeBoard(snapshot);
      state.revision = Math.max(state.revision, incomingRevision);
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

  function taskBelongsToDir(task, dirId, moduleMap) {
    const target = String(dirId || '').trim();
    if (!target) return true;
    if (String(task && task.dirId || '').trim() === target) return true;
    if ((Array.isArray(task && task.dirIds) ? task.dirIds : []).some(id => String(id || '').trim() === target)) return true;
    const module = moduleMap.get(String(task && task.moduleId || ''));
    return String(module && module.dirId || '').trim() === target;
  }

  function taskContextDirId(task, moduleMap) {
    return state.dirId && taskBelongsToDir(task, state.dirId, moduleMap)
      ? state.dirId
      : taskDirId(task, moduleMap);
  }

  function taskTitle(task) {
    const direct = String(task && task.title || '').trim();
    if (direct) return direct;
    const description = String(task && (task.description || task.body) || '').trim();
    return description.split(/\r?\n/)[0].slice(0, 160) || tr('plannerUntitled');
  }

  function taskDescription(task) {
    const description = String(task && task.description || '').trim();
    return description || String(task && task.body || '').trim();
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

  function taskOrigin(task) {
    const detected = boardUi && typeof boardUi.taskOrigin === 'function'
      ? boardUi.taskOrigin(task || {})
      : { key: task && task.origin === 'board' ? 'board' : 'session' };
    const key = detected && detected.key === 'board' ? 'board' : 'session';
    const label = tr(key === 'board' ? 'plannerSourceBoard' : 'plannerSourceSession');
    return {
      key,
      icon: detected && detected.icon || (key === 'board' ? '📋' : '💬'),
      label,
      title: label,
    };
  }

  function workBucket(task) {
    const stage = taskStage(task);
    if (!task || task.status === 'archived') return '';
    // Completion is a durable, user-controlled workflow stage. Keep it visible
    // in the operational surface until the user explicitly archives it; the
    // record view is an audit projection, not the destination of a task.
    if (task.status === 'done' || stage === 'done') return 'done';
    const status = taskStatus(task);
    if (status === 'waiting' || status === 'error' || status === 'blocked') return 'attention';
    if (status === 'running' || status === 'queued') return 'running';
    if (task.recordType !== 'planned') return '';
    // A user reopening a succeeded task moves it to ready. Honour that explicit
    // planning transition instead of letting an old run projection bounce it
    // straight back into Review.
    if (stage === 'review' || (status === 'succeeded' && stage !== 'ready')) return 'review';
    if (stage === 'ready' || stage === 'doing') return 'next';
    return 'idle';
  }

  function statusFilterKey(task) {
    const status = taskStatus(task);
    const bucket = workBucket(task);
    // Keep the existing status/work-bucket projection authoritative. Errors
    // get their own filter; every other attention state (waiting or blocked)
    // remains actionable under “Needs me”.
    if (status === 'error') return 'error';
    if (bucket === 'attention') return 'attention';
    if (bucket === 'running') return 'running';
    if (bucket === 'review') return 'review';
    return '';
  }

  function taskMatchesScope(task, options) {
    const opts = options || {};
    if ((task.status === 'archived') !== state.archived) return false;
    const moduleMap = opts.moduleMap || modulesById();
    const query = state.query.trim().toLocaleLowerCase();
    if (!taskBelongsToDir(task, state.dirId, moduleMap)) return false;
    if (!opts.ignoreOrigin && state.origin !== 'all' && taskOrigin(task).key !== state.origin) return false;
    if (!query) return true;
    const module = moduleMap.get(String(task.moduleId || ''));
    const haystack = [taskTitle(task), taskDescription(task), module && module.name, task.acceptanceCriteria]
      .join('\n').toLocaleLowerCase();
    return haystack.includes(query);
  }

  function taskListTasks(options) {
    const opts = options || {};
    const scope = { ...opts, moduleMap: opts.moduleMap || modulesById() };
    return state.board.tasks.filter(task => {
      if (!taskMatchesScope(task, scope)) return false;
      if (opts.ignoreStatus || !state.statusFilters.size) return true;
      return state.statusFilters.has(statusFilterKey(task));
    });
  }

  function activityTasks(options) {
    const opts = options || {};
    const scope = { ...opts, moduleMap: opts.moduleMap || modulesById() };
    return state.board.tasks.filter(task => taskMatchesScope(task, scope));
  }

  function filteredTasks(mode) {
    return mode === 'activity' ? activityTasks() : taskListTasks();
  }

  function originCounts(mode) {
    const source = mode === 'activity'
      ? activityTasks({ ignoreOrigin: true })
      : taskListTasks({ ignoreOrigin: true });
    const counts = { all: source.length, board: 0, session: 0 };
    for (const task of source) counts[taskOrigin(task).key] += 1;
    return counts;
  }

  function statusFilterCounts() {
    const counts = Object.fromEntries(STATUS_FILTERS.map(filter => [filter, 0]));
    for (const task of taskListTasks({ ignoreStatus: true })) {
      const key = statusFilterKey(task);
      if (key) counts[key] += 1;
    }
    return counts;
  }

  function stageKey(stage) {
    return `plannerStage${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
  }

  function statusFilterLabelKey(filter) {
    return `plannerFilter${filter.charAt(0).toUpperCase()}${filter.slice(1)}`;
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

  function lifecycleActionsHtml(task) {
    const archived = task.status === 'archived';
    return `${task.deleting ? '' : `<button class="btn btn-sm" type="button" data-action="task-${archived ? 'restore' : 'archive'}" data-task-id="${esc(task.id)}">${esc(tr(archived ? 'plannerRestore' : 'plannerArchive'))}</button>`}
      <button class="btn btn-sm planner-action-danger" type="button" data-action="task-delete" data-task-id="${esc(task.id)}">${esc(tr('plannerDelete'))}</button>`;
  }

  async function manageTaskLifecycle(taskId, action, button) {
    const task = findTask(taskId);
    if (!task) return;
    const confirmKey = action === 'delete' ? 'plannerDeleteConfirm' : action === 'archive' ? 'plannerArchiveConfirm' : null;
    if (confirmKey && !window.confirm(tr(confirmKey))) return;
    button.disabled = true;
    try {
      const deletion = action === 'delete';
      await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}${deletion ? '' : '/status'}`, {
        method: deletion ? 'DELETE' : 'POST', json: {
          ...(deletion ? {} : { status: action === 'archive' ? 'archived' : 'active' }),
          ...(task.recordType === 'planned' ? { expectedRevision: task.planningRevision } : {}),
        },
      });
      closePlannerOverlay();
      await loadPlanner({ quiet: true });
      notify(tr(deletion ? 'plannerDeleted' : action === 'archive' ? 'plannerArchived' : 'plannerReopened'));
    } catch (error) {
      await loadPlanner({ quiet: true });
      notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      button.disabled = false;
    }
  }

  function taskRowHtml(task, context) {
    const dirId = taskContextDirId(task, context.moduleMap);
    const directory = context.dirMap.get(dirId);
    const title = taskTitle(task);
    const description = taskDescription(task);
    const origin = taskOrigin(task);
    const planned = task.recordType === 'planned';
    const bucket = workBucket(task);
    const attention = attentionKind(task);
    const filterKey = statusFilterKey(task);
    const displayState = filterKey || bucket || 'idle';
    const updated = task.updatedAt || task.lastTs || task.createdAt;
    const primaryAction = planned ? 'open-task' : 'open-chat';
    const actions = [];
    if (attention) {
      actions.push(`<button class="btn btn-sm planner-task-primary" type="button" data-action="open-chat" data-task-id="${esc(task.id)}">${esc(attention === 'waiting' ? tr('plannerAnswerQuestion') : tr('plannerInspectError'))} ↗</button>`);
    } else if (!task.deleting && planned && (bucket === 'idle' || bucket === 'next')) {
      actions.push(`<button class="btn btn-sm planner-task-primary" type="button" data-action="start-task" data-task-id="${esc(task.id)}">▶ ${esc(tr('plannerStartQuick'))}</button>`);
    } else if (!task.deleting && planned && bucket === 'review') {
      actions.push(`<button class="btn btn-sm planner-task-primary complete" type="button" data-action="complete-task" data-task-id="${esc(task.id)}">✓ ${esc(tr('plannerCompleteQuick'))}</button>`);
    } else {
      actions.push(`<button class="btn btn-sm" type="button" data-action="open-chat" data-task-id="${esc(task.id)}">${esc(tr('plannerOpenChat'))}</button>`);
    }
    return `<article class="planner-task-row${attention ? ` attention-${attention}` : ''}" data-task-id="${esc(task.id)}" data-action="${primaryAction}" data-status="${esc(displayState)}" tabindex="0" aria-label="${esc(tr('plannerOpenTaskLabel', { title }))}">
      <span class="planner-task-state" aria-hidden="true"></span>
      <div class="planner-task-content">
        <div class="planner-task-title">${esc(title)}</div>
        ${description && description !== title ? `<div class="planner-task-description">${esc(description)}</div>` : ''}
        <div class="planner-task-meta">
          <span class="planner-badge origin origin-${esc(origin.key)}" title="${esc(origin.title)}">${esc(origin.icon)} ${esc(origin.label)}</span>
          ${statusHtml(task, true)}
          <span>${esc(directory && directory.name || tr('plannerUnknownFleet'))}</span>
          <span>·</span><span>${esc(updated ? tr('plannerUpdated', { date: localDate(updated, true) }) : '')}</span>
        </div>
      </div>
      <div class="planner-task-actions">${actions.join('')}${lifecycleActionsHtml(task)}</div>
    </article>`;
  }

  function sortedTasks(tasks) {
    return boardUi && typeof boardUi.sortTasks === 'function'
      ? boardUi.sortTasks(tasks)
      : [...tasks].sort(rankCompare);
  }

  function moduleTaskGroups(tasks, moduleMap) {
    const byModule = new Map();
    for (const task of tasks) {
      const rawId = String(task.moduleId || '');
      const moduleId = moduleMap.has(rawId) ? rawId : '__unassigned__';
      if (!byModule.has(moduleId)) byModule.set(moduleId, []);
      byModule.get(moduleId).push(task);
    }
    const populatedModules = state.board.modules.filter(module => byModule.has(String(module.id)));
    const orderedModules = boardUi && typeof boardUi.sortModules === 'function'
      ? boardUi.sortModules(populatedModules)
      : [...populatedModules].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const groups = orderedModules.map(module => ({
      id: String(module.id),
      name: module.name || tr('plannerNoModule'),
      tasks: byModule.get(String(module.id)) || [],
    }));
    if (byModule.has('__unassigned__')) groups.push({
      id: '__unassigned__', name: tr('plannerNoModule'), tasks: byModule.get('__unassigned__'),
    });
    return groups;
  }

  function moduleTaskRowsHtml(tasks, context) {
    const sorted = sortedTasks(tasks);
    const related = boardUi && typeof boardUi.partitionTaskGroups === 'function'
      ? boardUi.partitionTaskGroups(sorted, state.board.taskGroups)
      : { groups: [], ungrouped: sorted };
    const identity = boardUi && typeof boardUi.partitionTaskIdentity === 'function'
      ? boardUi.partitionTaskIdentity(related.ungrouped)
      : { canonical: related.ungrouped, unresolved: [] };
    const relatedHtml = related.groups.map(group => `<details class="planner-related-group" open>
      <summary><span>🧩 ${esc(group.title || tr('plannerRelatedTasks'))}</span><span class="planner-module-count">${group.tasks.length}</span></summary>
      <div>${group.tasks.map(task => taskRowHtml(task, context)).join('')}</div>
    </details>`).join('');
    const canonicalHtml = identity.canonical.map(task => taskRowHtml(task, context)).join('');
    const unresolvedHtml = identity.unresolved.length ? `<details class="planner-related-group planner-legacy-group">
      <summary><span>${esc(tr('plannerLegacyTasks'))}</span><span class="planner-module-count">${identity.unresolved.length}</span></summary>
      <div>${identity.unresolved.map(task => taskRowHtml(task, context)).join('')}</div>
    </details>` : '';
    return relatedHtml + canonicalHtml + unresolvedHtml;
  }

  function taskListHtml() {
    const tasks = filteredTasks('tasks');
    if (!tasks.length) {
      return `<div class="planner-empty"><div><strong>${esc(tr('plannerTaskEmptyTitle'))}</strong>${esc(tr('plannerTaskEmptyBody'))}</div></div>`;
    }
    const context = { moduleMap: modulesById(), dirMap: directoriesById() };
    const groups = moduleTaskGroups(tasks, context.moduleMap);
    return `<div class="planner-task-list">
      <div class="planner-task-summary">${esc(tr('plannerTaskSummary', { modules: groups.length, tasks: tasks.length }))}</div>
      ${groups.map(group => `<details class="planner-module-group" data-module-id="${esc(group.id)}" open>
        <summary><span class="planner-module-name">${esc(group.name)}</span><span class="planner-module-count">${group.tasks.length}</span></summary>
        <div class="planner-module-tasks">${moduleTaskRowsHtml(group.tasks, context)}</div>
      </details>`).join('')}
    </div>`;
  }

  function activityHtml() {
    const tasks = filteredTasks('activity');
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
      <div class="planner-history-summary">${esc(tr('plannerActivitySummary', { modules: ordered.length, tasks: tasks.length }))}</div>
      ${ordered.map(([moduleId, list]) => {
        const module = moduleMap.get(moduleId);
        const moduleName = module && module.name || tr('plannerNoModule');
        return `<details class="planner-history-group" open>
          <summary><span>${esc(moduleName)}</span><span class="planner-history-count">${list.length}</span></summary>
          ${list.sort((a, b) => (Number(b.lastTs || b.updatedAt) || 0) - (Number(a.lastTs || a.updatedAt) || 0)).map(task => {
            const directory = dirMap.get(taskContextDirId(task, moduleMap));
            const origin = taskOrigin(task);
            const planned = task.recordType === 'planned';
            const editable = planned && task.status !== 'archived' && !task.deleting;
            const lifecycleKey = task.status === 'archived' ? 'plannerLifecycleArchived'
              : task.status === 'done' ? 'plannerLifecycleDone' : 'plannerLifecycleActive';
            return `<div class="planner-history-row">
              <div>
                <div class="planner-history-title" title="${esc(taskTitle(task))}">${esc(taskTitle(task))}</div>
                <div class="planner-history-meta">
                  <span>${esc(directory && directory.name || tr('plannerUnknownFleet'))}</span>
                  <span>·</span><span>${esc(tr(lifecycleKey))}</span>
                  <span class="planner-badge origin origin-${esc(origin.key)}" title="${esc(origin.title)}">${esc(origin.icon)} ${esc(origin.label)}</span>
                  ${statusHtml(task, true)}
                </div>
              </div>
              <div class="planner-history-actions">
                ${editable ? `<button class="btn btn-sm" type="button" data-action="open-task" data-task-id="${esc(task.id)}">${esc(tr('plannerViewTask'))}</button>` : ''}
                <button class="btn btn-sm" type="button" data-action="open-chat" data-task-id="${esc(task.id)}">${esc(tr('plannerOpenChat'))}</button>
                ${lifecycleActionsHtml(task)}
              </div>
            </div>`;
          }).join('')}
        </details>`;
      }).join('')}
    </div>`;
  }

  function statusFilterHtml() {
    const counts = statusFilterCounts();
    return `<div class="planner-status-filter">
      <strong>${esc(tr('plannerStatusFilter'))}</strong>
      <div class="planner-status-chips" role="group" aria-label="${esc(tr('plannerStatusFilter'))}">
        ${STATUS_FILTERS.map(filter => `<button type="button" class="planner-status-chip${state.statusFilters.has(filter) ? ' active' : ''}" aria-pressed="${state.statusFilters.has(filter)}" data-action="status-filter" data-status-filter="${filter}"><span>${esc(tr(statusFilterLabelKey(filter)))}</span><strong>${counts[filter]}</strong></button>`).join('')}
      </div>
    </div>`;
  }

  function originFilterHtml(mode) {
    const counts = originCounts(mode);
    return `<div class="planner-origin-filter" role="group" aria-label="${esc(tr('plannerSource'))}">
      <span>${esc(tr('plannerSource'))}</span>
      ${ORIGINS.map(origin => `<button type="button" class="${state.origin === origin ? 'active' : ''}" aria-pressed="${state.origin === origin}" data-action="origin" data-origin="${origin}">${esc(tr(`plannerSource${origin === 'all' ? 'All' : origin === 'board' ? 'Board' : 'Session'}`))} <strong>${counts[origin]}</strong></button>`).join('')}
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

  function captureRenderState() {
    const historyScroll = root.querySelector('.planner-history');
    const taskScroll = root.querySelector('.planner-task-list');
    const active = document.activeElement;
    const searchFocused = !!(active && typeof active.matches === 'function'
      && active.matches('[data-control="search"]')
      && (typeof root.contains !== 'function' || root.contains(active)));
    return {
      historyTop: historyScroll ? historyScroll.scrollTop : 0,
      taskTop: taskScroll ? taskScroll.scrollTop : 0,
      searchFocused,
      selectionStart: searchFocused ? active.selectionStart : null,
      selectionEnd: searchFocused ? active.selectionEnd : null,
    };
  }

  function restoreRenderState(saved) {
    if (!saved) return;
    const historyScroll = root.querySelector('.planner-history');
    if (historyScroll) historyScroll.scrollTop = saved.historyTop;
    const taskScroll = root.querySelector('.planner-task-list');
    if (taskScroll) taskScroll.scrollTop = saved.taskTop;
    if (!saved.searchFocused) return;
    const search = root.querySelector('[data-control="search"]');
    if (!search) return;
    try { search.focus({ preventScroll: true }); } catch (_) { search.focus(); }
    if (Number.isFinite(saved.selectionStart) && typeof search.setSelectionRange === 'function') {
      search.setSelectionRange(saved.selectionStart, Number.isFinite(saved.selectionEnd) ? saved.selectionEnd : saved.selectionStart);
    }
  }

  // The quick-create composer owns live DOM state (draft text, attachments,
  // voice, provider pickers). It must NOT live inside the re-rendered shell —
  // render() rebuilds the shell from string HTML on every board update, which
  // would wipe a half-written message. The composer bar is a persistent
  // sibling; only the shell host is re-rendered.
  let shellHost = null;

  function destroyQuickComposer() {
    if (!quickComposer) return;
    try { quickComposer.destroy(); } catch (_) {}
    quickComposer = null;
    quickComposerContext = '';
  }

  function ensureLayout() {
    if (shellHost && shellHost.parentNode === root && quickComposerHost
        && quickComposerHost.parentNode === root) return;
    destroyQuickComposer();
    root.innerHTML = '';
    shellHost = document.createElement('div');
    shellHost.className = 'planner-shell-host';
    root.appendChild(shellHost);
    quickComposerHost = document.createElement('div');
    quickComposerHost.className = 'planner-quick-create-host';
    root.appendChild(quickComposerHost);
  }

  // The composer target: the Fleet picker next to it is authoritative once
  // mounted (what you see is where the task goes); before mount it defaults to
  // the toolbar Fleet filter, the same default the old start-now dialog used.
  // The toolbar filter does not retarget a composer the user may already have
  // drafted into.
  function quickCreateDirId() {
    if (surface === 'fleet' && lockedDirId) return lockedDirId;
    const picker = quickComposerHost && quickComposerHost.querySelector('[data-control="composer-fleet"]');
    if (picker) return String(picker.value || '').trim();
    return state.composerDirId || state.dirId || initialTaskDirId();
  }

  function syncQuickComposer(busy) {
    if (!quickComposerHost) return;
    const visible = state.mode === 'tasks' && !busy && !state.error;
    quickComposerHost.style.display = visible ? '' : 'none';
    if (!visible) return;
    const composerApi = window.MultiCCTaskBoardComposer;
    if (!composerApi || typeof composerApi.mount !== 'function') {
      destroyQuickComposer();
      quickComposerHost.innerHTML = `<div class="planner-quick-create"><div class="planner-quick-create-missing">${esc(tr('plannerComposerUnavailable'))}</div></div>`;
      return;
    }
    const embedded = surface === 'fleet';
    if (!quickComposer) {
      const dirId = quickCreateDirId();
      quickComposerHost.innerHTML = `<div class="planner-quick-create">
        <div class="planner-quick-create-head">
          <strong>${esc(tr('plannerQuickCreate'))}</strong>
          <span class="planner-quick-create-hint">${esc(tr('plannerQuickCreateHint'))}</span>
          <span class="planner-grow"></span>
          ${embedded ? '' : `<label class="planner-quick-create-workspace"><span>${esc(tr('plannerQuickCreateWorkspace'))}</span><select class="planner-control planner-select" data-control="composer-fleet"><option value=""></option>${panelOptions(dirId)}</select></label>`}
        </div>
        <div class="planner-quick-composer"></div>
      </div>`;
      quickComposerContext = dirId;
      quickComposer = composerApi.mount(quickComposerHost.querySelector('.planner-quick-composer'), {
        contextKey: dirId,
        placeholder: tr('plannerQuickCreatePlaceholder'),
        onSendingChange: sending => {
          if (quickComposerHost) quickComposerHost.dataset.plannerSending = sending ? 'true' : 'false';
          const picker = quickComposerHost && quickComposerHost.querySelector('[data-control="composer-fleet"]');
          if (picker) picker.disabled = sending;
        },
        submit: async payload => {
          const picker = quickComposerHost && quickComposerHost.querySelector('[data-control="composer-fleet"]');
          // An explicit empty picker value must fail validation, never silently
          // reroute the task to the default Fleet.
          const targetDir = embedded ? lockedDirId : String(picker ? picker.value : quickComposerContext).trim();
          if (!targetDir) throw new Error(tr('plannerCreateRequired'));
          const result = await requestJson('/api/task-board/send', {
            method: 'POST',
            json: { ...payload, dirId: targetDir },
          });
          await loadPlanner({ quiet: true });
          notify(tr('plannerCreatedStarted'));
          return result && result.queued ? tr('plannerCreatedStarted') : tr('plannerStarted');
        },
      });
      return;
    }
    // An explicit empty picker pick stays empty and is rejected by submit
    // validation instead of silently rerouting the draft.
    const nextDirId = quickCreateDirId();
    if (nextDirId && nextDirId !== quickComposerContext) {
      quickComposerContext = nextDirId;
      quickComposer.setContext(nextDirId, { preserveDraft: true });
    }
  }

  function render() {
    const savedRenderState = pendingRenderState || captureRenderState();
    pendingRenderState = null;
    const embedded = surface === 'fleet';
    // The navigation badge is an actionable-work count. Completed cards stay
    // visible on the board but do not inflate the outstanding-work indicator.
    const globalWork = state.board.tasks.filter(task => {
      const bucket = workBucket(task);
      return !!bucket && bucket !== 'done';
    });
    const workCount = globalWork.length;
    const workAttention = globalWork.filter(task => workBucket(task) === 'attention').length;
    const navBadge = document.getElementById('nav-planner-count');
    if (navBadge) {
      navBadge.textContent = String(workCount);
      navBadge.title = workAttention ? tr('plannerNeedsAttention') + ': ' + workAttention : '';
    }

    const busy = state.loading && !state.loaded;
    const main = busy
      ? `<div class="planner-loading">${esc(tr('plannerLoading'))}</div>`
      : state.error
        ? `<div class="planner-error"><div>${esc(tr('plannerLoadFailed', { error: state.error }))}<div style="margin-top:12px"><button class="btn" type="button" data-action="refresh">${esc(tr('plannerRetry'))}</button></div></div></div>`
        : state.mode === 'activity' ? activityHtml() : taskListHtml();

    const directory = directoriesById().get(lockedDirId);
    const fleetControl = embedded
      ? `<div class="planner-fleet-lock" title="${esc(directory && directory.name || lockedDirId)}"><span aria-hidden="true">◆</span><strong>${esc(directory && directory.name || lockedDirId || tr('plannerUnknownFleet'))}</strong><span>${esc(tr('plannerTaskCenter'))}</span></div>`
      : `<label class="planner-sr-only" for="planner-fleet-filter">${esc(tr('plannerFleet'))}</label>
          <select class="planner-control planner-select" id="planner-fleet-filter" data-control="fleet">
            <option value="">${esc(tr('plannerAllFleets'))}</option>${directoryOptions()}
          </select>`;
    const modeControl = `<div class="planner-segment" role="tablist">
          <button id="planner-mode-tasks" type="button" role="tab" aria-selected="${state.mode === 'tasks'}" aria-controls="planner-content" class="${state.mode === 'tasks' ? 'active' : ''}" data-action="mode" data-mode="tasks">${esc(tr('plannerTasks'))}</button>
          <button id="planner-mode-activity" type="button" role="tab" aria-selected="${state.mode === 'activity'}" aria-controls="planner-content" class="${state.mode === 'activity' ? 'active' : ''}" data-action="mode" data-mode="activity">${esc(tr('plannerHistory'))}</button>
        </div>`;
    const mainA11y = `role="tabpanel" aria-labelledby="planner-mode-${state.mode}"`;

    root.classList.toggle('planner-fleet-embedded', embedded);
    ensureLayout();
    shellHost.innerHTML = `<div class="planner-shell${embedded ? ' embedded' : ''}">
      <div class="planner-toolbar">
        <div class="planner-toolbar-group">
          ${fleetControl}
          <label class="planner-search"><span class="planner-sr-only">${esc(tr('plannerSearchPlaceholder'))}</span><input class="planner-control" type="search" value="${esc(state.query)}" placeholder="${esc(tr('plannerSearchPlaceholder'))}" data-control="search"></label>
        </div>
        ${originFilterHtml(state.mode)}
        <div class="planner-segment" role="group" aria-label="${esc(tr('plannerArchiveFilter'))}">
          <button type="button" data-action="archive-filter" data-archived="0" aria-pressed="${!state.archived}" class="${state.archived ? '' : 'active'}">${esc(tr('plannerCurrentTasks'))}</button>
          <button type="button" data-action="archive-filter" data-archived="1" aria-pressed="${state.archived}" class="${state.archived ? 'active' : ''}">${esc(tr('plannerArchiveFilter'))}</button>
        </div>
        <div class="planner-grow"></div>
        ${modeControl}
        <div class="planner-toolbar-group actions">
          <button class="icon-btn" type="button" data-action="refresh" title="${esc(tr('plannerRefresh'))}" aria-label="${esc(tr('plannerRefresh'))}">⟳</button>
        </div>
      </div>
      ${state.mode === 'tasks' ? statusFilterHtml() : ''}
      <div class="planner-sr-only" role="status" aria-live="polite" aria-atomic="true">${busy ? esc(tr('plannerLoading')) : state.error ? esc(tr('plannerLoadFailed', { error: state.error })) : ''}</div>
      <div class="planner-main" id="planner-content" ${mainA11y}>${main}</div>
    </div>`;
    restoreRenderState(savedRenderState);
    syncQuickComposer(busy);
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

  function reconcilePlannerSnapshot(snapshot) {
    if (!snapshot || snapshot.ok === false) return false;
    const incomingRevision = Number(snapshot.revision) || 0;
    if (state.loaded && incomingRevision && incomingRevision <= state.revision) return false;
    // An accepted external snapshot supersedes every older in-flight planner
    // request. Otherwise a late rejection could replace this fresh board with
    // an error screen even though reconciliation already succeeded.
    state.loadEpoch += 1;
    state.board = normalizeBoard(snapshot);
    state.revision = Math.max(state.revision, incomingRevision);
    state.loaded = true;
    state.loading = false;
    state.error = '';
    render();
    return true;
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

  function closePlannerOverlay(expectedOverlay) {
    const overlay = expectedOverlay || document.querySelector('.planner-overlay');
    if (overlay) {
      // Async task creation may finish after its dialog was dismissed and a
      // different dialog was opened. Only ever close the overlay owned by the
      // caller; never let the stale completion tear down the newer draft.
      if (expectedOverlay && overlay.isConnected === false) return;
      const returnFocus = overlay.__plannerReturnFocus;
      const cleanup = overlay.__plannerCleanup;
      overlay.__plannerCleanup = null;
      if (typeof cleanup === 'function') {
        try { cleanup(); } catch (_) {}
      }
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
    const directories = surface === 'fleet' && lockedDirId
      ? state.directories.filter(directory => String(directory.id) === lockedDirId)
      : state.directories;
    return directories.map(directory => `<option value="${esc(directory.id)}"${selected === String(directory.id) ? ' selected' : ''}>${esc(directory.name || directory.id)}</option>`).join('');
  }

  function priorityOptions(selected) {
    return `<option value=""${selected ? '' : ' selected'}>${esc(tr('plannerPriorityNone'))}</option>`
      + PRIORITIES.map(priority => `<option value="${priority}"${selected === priority ? ' selected' : ''}>${esc(priorityLabel(priority))}</option>`).join('');
  }

  function stageOptions(selected) {
    return STAGES.map(stage => `<option value="${stage}"${selected === stage ? ' selected' : ''}>${esc(tr(stageKey(stage)))}</option>`).join('');
  }

  function initialTaskDirId() {
    return lockedDirId || state.dirId
      || String(state.directories[0] && state.directories[0].id || '');
  }

  function drawerFormPayload() {
    const form = document.getElementById('planner-edit-form');
    if (!form) return null;
    const values = new FormData(form);
    return {
      form,
      payload: {
        title: String(values.get('title') || '').trim(),
        dirId: String(values.get('dirId') || '').trim(),
        workflowStage: String(values.get('workflowStage') || 'inbox'),
        description: String(values.get('description') || '').trim() || null,
        priority: String(values.get('priority') || '') || null,
        dueAt: isoFromLocal(String(values.get('dueAt') || '')),
        acceptanceCriteria: String(values.get('acceptanceCriteria') || '').trim() || null,
      },
    };
  }

  function drawerPayloadSnapshot(payload) {
    return JSON.stringify(payload || {});
  }

  async function persistDrawerChanges(taskId, context) {
    const task = findTask(taskId);
    const current = drawerFormPayload();
    if (!task || !current) return null;
    const { form, payload } = current;
    if (!payload.title || !payload.dirId) {
      form.reportValidity();
      return null;
    }
    const snapshot = drawerPayloadSnapshot(payload);
    if (snapshot === context.formSnapshot) return { task, changed: false };
    try {
      const data = await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}/update`, {
        method: 'POST',
        json: expectedRevisionBody(task, payload, context.revision),
      });
      updateTaskFromResponse(data);
      const updated = findTask(taskId) || data && data.task || task;
      context.revision = Math.max(1, Number(updated.planningRevision) || context.revision);
      context.formSnapshot = snapshot;
      return { task: updated, changed: true };
    } catch (error) {
      if (!(await handleConflict(error))) notify(tr('plannerSaveFailed', { error: errorText(error) }), true);
      return null;
    }
  }

  function openTaskDrawer(taskId) {
    const task = findTask(taskId);
    if (!task) return;
    closePlannerOverlay();
    const moduleMap = modulesById();
    const dirMap = directoriesById();
    const dirId = taskContextDirId(task, moduleMap);
    const directory = dirMap.get(dirId);
    const module = moduleMap.get(String(task.moduleId || ''));
    const stage = taskStage(task);
    const priority = String(task.priority || '');
    // Keep the form and its concurrency token as one snapshot. A websocket
    // refresh may update the board behind this drawer, but must not let stale
    // fields save against the newer revision.
    const drawerContext = {
      revision: Math.max(1, Number(task.planningRevision) || 1),
      formSnapshot: '',
    };
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
        <button class="btn planner-action-danger" type="button" data-drawer-action="delete">${esc(tr('plannerDelete'))}</button>
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
      handleDrawerAction(task.id, action.dataset.drawerAction, action, drawerContext);
    });
    const initialForm = drawerFormPayload();
    drawerContext.formSnapshot = drawerPayloadSnapshot(initialForm && initialForm.payload);
    activateOverlay(overlay, '[name="title"]');
  }

  async function saveDrawer(taskId, button, context) {
    button.disabled = true;
    const saved = await persistDrawerChanges(taskId, context);
    if (!saved) { button.disabled = false; return; }
    closePlannerOverlay();
    await loadPlanner({ quiet: true });
    notify(tr('plannerSaved'));
  }

  async function startTask(taskId, button, context) {
    let task = findTask(taskId);
    if (!task) return;
    if (['running', 'queued', 'waiting'].includes(taskStatus(task))) {
      notify(tr('plannerBusy'), true);
      return;
    }
    button.disabled = true;
    const saved = await persistDrawerChanges(taskId, context);
    if (!saved) { button.disabled = false; return; }
    task = saved.task;
    try {
      await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}/send`, {
        method: 'POST',
        json: {
          text: taskDescription(task) || taskTitle(task),
          clientMsgId: sendIdForTask(taskId),
          expectedRevision: context.revision,
        },
      });
      state.sendIds.delete(String(taskId));
      closePlannerOverlay();
      await loadPlanner({ quiet: true });
      notify(tr('plannerStarted'));
    } catch (error) {
      if (!(await handleConflict(error))) notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      button.disabled = false;
    }
  }

  async function startTaskDirect(taskId, button) {
    const task = findTask(taskId);
    if (!task || task.recordType !== 'planned') return;
    if (['running', 'queued', 'waiting'].includes(taskStatus(task))) {
      notify(tr('plannerBusy'), true);
      return;
    }
    if (button) button.disabled = true;
    try {
      const data = await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}/send`, {
        method: 'POST',
        json: {
          text: taskDescription(task) || taskTitle(task),
          clientMsgId: sendIdForTask(taskId),
          expectedRevision: Math.max(1, Number(task.planningRevision) || 1),
        },
      });
      updateTaskFromResponse(data);
      state.sendIds.delete(String(taskId));
      await loadPlanner({ quiet: true });
      notify(tr('plannerStarted'));
    } catch (error) {
      if (!(await handleConflict(error))) notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      if (button) button.disabled = false;
    }
  }

  async function completeTaskDirect(taskId, button) {
    const task = findTask(taskId);
    if (!task || task.recordType !== 'planned') return;
    if (button) button.disabled = true;
    const moved = await moveTask(taskId, 'done', null, {
      expectedRevision: Math.max(1, Number(task.planningRevision) || 1),
    });
    if (moved) notify(tr('plannerCompleted'));
    else if (button) button.disabled = false;
  }

  async function setLifecycle(taskId, status, button, context) {
    button.disabled = true;
    const saved = await persistDrawerChanges(taskId, context);
    if (!saved) { button.disabled = false; return; }
    const task = saved.task;
    // Completion/reopen are planning transitions, so they use the same
    // per-card optimistic concurrency path as drag-and-drop.
    if (status === 'done' || status === 'active') {
      const targetStage = status === 'done' ? 'done' : 'ready';
      if (taskStage(task) === targetStage) {
        closePlannerOverlay();
        await loadPlanner({ quiet: true });
        notify(status === 'done' ? tr('plannerCompleted') : tr('plannerReopened'));
        return;
      }
      const moved = await moveTask(taskId, targetStage, null, { expectedRevision: context.revision });
      if (!moved) { button.disabled = false; return; }
      closePlannerOverlay();
      notify(status === 'done' ? tr('plannerCompleted') : tr('plannerReopened'));
      return;
    }
    try {
      await requestJson(`/api/task-board/tasks/${encodeURIComponent(taskId)}/status`, {
        method: 'POST',
        json: { status, expectedRevision: context.revision },
      });
      closePlannerOverlay();
      await loadPlanner({ quiet: true });
      notify(tr('plannerArchived'));
    } catch (error) {
      if (!(await handleConflict(error))) notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      button.disabled = false;
    }
  }

  async function handleDrawerAction(taskId, action, button, context) {
    if (action === 'delete') return manageTaskLifecycle(taskId, 'delete', button);
    if (action === 'save') return saveDrawer(taskId, button, context);
    if (action === 'start') return startTask(taskId, button, context);
    if (action === 'chat') {
      window.open(`/chat.html?task=${encodeURIComponent(taskId)}`, '_blank');
      return;
    }
    if (action === 'lifecycle') return setLifecycle(taskId, button.dataset.status, button, context);
    if (action === 'archive' && window.confirm(tr('plannerArchiveConfirm'))) {
      return setLifecycle(taskId, 'archived', button, context);
    }
  }

  function handleRootClick(event) {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const kind = action.dataset.action;
    if (kind === 'task-archive' || kind === 'task-delete' || kind === 'task-restore') {
      manageTaskLifecycle(action.dataset.taskId, kind.slice(5), action);
    } else if (kind === 'archive-filter') {
      state.archived = action.dataset.archived === '1';
      if (state.archived) state.mode = 'activity';
      render();
    } else if (kind === 'refresh') loadPlanner({ refreshDirectories: true });
    else if (kind === 'mode') {
      state.archived = false;
      state.mode = MODES.includes(action.dataset.mode) ? action.dataset.mode : 'tasks';
      render();
    } else if (kind === 'origin') {
      selectOrigin(action.dataset.origin);
      render();
    } else if (kind === 'status-filter') {
      const filter = STATUS_FILTERS.includes(action.dataset.statusFilter) ? action.dataset.statusFilter : '';
      if (filter) {
        if (state.statusFilters.has(filter)) state.statusFilters.delete(filter);
        else state.statusFilters.add(filter);
      }
      if (state.mode === 'activity') state.mode = 'tasks';
      render();
    } else if (kind === 'open-task') {
      const taskId = action.dataset.taskId || action.closest('[data-task-id]')?.dataset.taskId;
      const task = findTask(taskId);
      if (task && task.recordType === 'planned' && task.status !== 'archived' && !task.deleting) openTaskDrawer(taskId);
      else window.open(`/chat.html?task=${encodeURIComponent(taskId)}`, '_blank');
    } else if (kind === 'open-chat') {
      window.open(`/chat.html?task=${encodeURIComponent(action.dataset.taskId)}`, '_blank');
    } else if (kind === 'start-task') {
      startTaskDirect(action.dataset.taskId, action);
    } else if (kind === 'complete-task') {
      completeTaskDirect(action.dataset.taskId, action);
    }
  }

  function handleRootChange(event) {
    if (event.target.matches('[data-control="composer-fleet"]')) {
      state.composerDirId = String(event.target.value || '');
      // An empty pick keeps the current context (and draft): submit validation
      // rejects it instead of silently rerouting the task being written.
      if (quickComposer && state.composerDirId && quickComposerContext !== state.composerDirId) {
        quickComposerContext = state.composerDirId;
        quickComposer.setContext(state.composerDirId, { preserveDraft: true });
      }
      return;
    }
    if (event.target.matches('[data-control="fleet"]')) {
      if (surface === 'fleet') return;
      state.dirId = event.target.value;
      render();
    }
  }

  function handleRootInput(event) {
    if (!event.target.matches('[data-control="search"]')) return;
    state.query = event.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(render, 90);
  }

  function handleRootKeydown(event) {
    if (event.target.closest('button,a,input,select,textarea')) return;
    const card = event.target.closest('.planner-task-row');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      const task = findTask(card.dataset.taskId);
      if (task && task.recordType === 'planned') openTaskDrawer(card.dataset.taskId);
      else window.open(`/chat.html?task=${encodeURIComponent(card.dataset.taskId)}`, '_blank');
    }
  }

  function uiStateSnapshot() {
    return {
      archived: state.archived,
      mode: state.mode,
      dirId: state.dirId,
      query: state.query,
      origin: state.origin,
      statusFilters: [...state.statusFilters],
      composerDirId: state.composerDirId,
      renderState: captureRenderState(),
    };
  }

  function applyUiState(value) {
    const next = value || {};
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
    state.mode = MODES.includes(next.mode) ? next.mode : 'tasks';
    state.dirId = String(next.dirId || '');
    state.query = String(next.query || '');
    state.archived = next.archived === true;
    selectOrigin(ORIGINS.includes(next.origin) ? next.origin : state.origin);
    state.statusFilters = new Set(
      Array.isArray(next.statusFilters)
        ? next.statusFilters.filter(filter => STATUS_FILTERS.includes(filter))
        : [],
    );
    state.composerDirId = String(next.composerDirId || '');
    pendingRenderState = next.renderState || null;
  }

  const fleetUiStates = new Map();

  function bindPlannerRoot(element) {
    if (!element || boundRoots.has(element)) return;
    element.addEventListener('click', handleRootClick);
    element.addEventListener('change', handleRootChange);
    element.addEventListener('input', handleRootInput);
    element.addEventListener('keydown', handleRootKeydown);
    boundRoots.add(element);
  }

  function activateGlobalSurface() {
    if (surface === 'fleet') {
      closePlannerOverlay();
      fleetUiStates.set(lockedDirId, uiStateSnapshot());
      if (root !== globalRoot) {
        // Wiping the root would orphan the live quick-create composer (draft,
        // attachments, pickers). Destroy it before the DOM goes away.
        destroyQuickComposer();
        root.innerHTML = '';
      }
      applyUiState(globalUiState);
    }
    root = globalRoot;
    surface = 'global';
    lockedDirId = '';
    bindPlannerRoot(root);
    if (!state.loaded && !state.loading) loadPlanner({ refreshDirectories: true });
    else {
      render();
      if (state.loaded) loadPlanner({ quiet: true, refreshDirectories: true });
    }
  }

  function mountFleetSurface(element, dirId) {
    const nextDirId = String(dirId || '').trim();
    if (!element || !nextDirId) return;
    const sameFleet = surface === 'fleet' && lockedDirId === nextDirId;
    if (!sameFleet) closePlannerOverlay();
    let currentSurfaceState = null;
    if (surface === 'global') {
      currentSurfaceState = uiStateSnapshot();
      globalUiState = currentSurfaceState;
    } else if (surface === 'fleet') {
      currentSurfaceState = uiStateSnapshot();
      fleetUiStates.set(lockedDirId, currentSurfaceState);
    }
    if (root !== element || !sameFleet) {
      destroyQuickComposer();
      root.innerHTML = '';
    }
    root = element;
    surface = 'fleet';
    lockedDirId = nextDirId;
    const saved = sameFleet ? currentSurfaceState : fleetUiStates.get(nextDirId);
    applyUiState({
      ...(saved || {}),
      mode: saved && MODES.includes(saved.mode) ? saved.mode : 'tasks',
      dirId: nextDirId,
    });
    bindPlannerRoot(root);
    if (!state.loaded && !state.loading) loadPlanner({ refreshDirectories: true });
    else {
      render();
      if (state.loaded) loadPlanner({ quiet: true, refreshDirectories: true });
    }
  }

  function unmountFleetSurface() {
    if (surface !== 'fleet') return;
    closePlannerOverlay();
    fleetUiStates.set(lockedDirId, uiStateSnapshot());
    if (root !== globalRoot) {
      destroyQuickComposer();
      root.innerHTML = '';
    }
    root = globalRoot;
    surface = 'global';
    lockedDirId = '';
    applyUiState(globalUiState);
    bindPlannerRoot(root);
    if (!state.loaded && !state.loading) loadPlanner();
    else render();
  }

  bindPlannerRoot(root);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key !== 'Escape') return;
    if (document.querySelector('.tb-auto-picker-overlay')) return;
    const overlay = document.querySelector('.planner-overlay');
    if (overlay && overlay.dataset.plannerSending !== 'true') closePlannerOverlay(overlay);
  });

  window.MultiCCTaskPlanner = Object.freeze({
    mountFleet: mountFleetSurface,
    unmountFleet: unmountFleetSurface,
    refresh: () => loadPlanner({ refreshDirectories: true }),
    reconcileSnapshot: reconcilePlannerSnapshot,
  });

  const originalSetView = window.setView;
  const topbarRefresh = document.getElementById('topbar-refresh');
  const dashboardRefresh = topbarRefresh && topbarRefresh.onclick;
  const dashboardRefreshTitle = topbarRefresh && topbarRefresh.title;
  const dashboardRefreshI18n = topbarRefresh && topbarRefresh.getAttribute('data-i18n-title');

  function syncTopbarRefresh(plannerActive) {
    if (!topbarRefresh) return;
    if (plannerActive) {
      topbarRefresh.onclick = () => loadPlanner({ refreshDirectories: true });
      topbarRefresh.removeAttribute('data-i18n-title');
      topbarRefresh.title = tr('plannerRefresh');
      topbarRefresh.setAttribute('aria-label', tr('plannerRefresh'));
      return;
    }
    topbarRefresh.onclick = dashboardRefresh || (() => window.loadDashboard && window.loadDashboard());
    if (dashboardRefreshI18n) topbarRefresh.setAttribute('data-i18n-title', dashboardRefreshI18n);
    else topbarRefresh.removeAttribute('data-i18n-title');
    topbarRefresh.title = dashboardRefreshTitle || '';
    topbarRefresh.removeAttribute('aria-label');
  }

  window.setView = function setPlannerAwareView(view) {
    if (typeof originalSetView === 'function') originalSetView(view);
    syncTopbarRefresh(view === 'tasks');
    if (view === 'tasks') {
      activateGlobalSurface();
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
