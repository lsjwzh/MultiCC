(function initMultiCCTaskPlanner() {
  'use strict';

  const STAGES = Object.freeze(['inbox', 'ready', 'doing', 'review', 'done']);
  const MODES = Object.freeze(['todo', 'board', 'activity']);
  const ORIGINS = Object.freeze(['all', 'board', 'session']);
  const WORK_BUCKETS = Object.freeze(['todo', 'attention', 'running', 'next', 'review']);
  const ORIGIN_STORAGE_KEY = 'multicc_task_center_origin';
  const PRIORITIES = Object.freeze(['urgent', 'high', 'medium', 'low']);
  const api = window.MultiCCApi;
  const boardUi = window.MultiCCTaskBoardUi;
  const statusUi = window.MultiCCStatusPresentation;

  const COPY = {
    zh: {
      plannerTaskCenter: '任务中心',
      plannerSubtitle: 'TODO、执行与验收',
      plannerTodoList: 'TODO',
      plannerBoard: '看板',
      plannerHistory: '活动记录',
      plannerSource: '来源',
      plannerSourceAll: '全部',
      plannerSourceBoard: '独立任务',
      plannerSourceSession: '会话任务',
      plannerWorkOverview: 'TODO / 任务',
      plannerBucketTodo: 'TODO',
      plannerBucketAttention: '需要我处理',
      plannerBucketRunning: '正在执行',
      plannerBucketNext: '接下来',
      plannerBucketReview: '待验收',
      plannerBucketTodoHint: '已记录，尚未安排',
      plannerBucketAttentionHint: '等待回答或需要处理异常',
      plannerBucketRunningHint: 'Agent 正在处理',
      plannerBucketNextHint: '已安排，可随时启动',
      plannerBucketReviewHint: '查看结果并确认完成',
      plannerTodoEmptyTitle: '当前没有待处理任务',
      plannerTodoEmptyBody: '可以新建 TODO，或切换来源查看会话任务。',
      plannerActivitySummary: '{modules} 个模块 · {tasks} 条活动记录',
      plannerStartQuick: '开始',
      plannerCompleteQuick: '完成',
      plannerViewTask: '查看任务',
      plannerNeedsMe: '需要我',
      plannerNewTask: '＋ 新建任务',
      plannerNewTodo: '＋ 新建 TODO',
      plannerStartNewNow: '▶ 立即开始新 TODO',
      plannerAllFleets: '全部工作区',
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
      plannerNoPlannedBody: '可以先记一条 TODO，或直接输入任务并立即开始。',
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
      plannerFleet: '工作区',
      plannerCreated: '创建于 {date}',
      plannerUpdated: '更新于 {date}',
      plannerHistorySummary: '{modules} 个模块 · {tasks} 条历史记录',
      plannerPromote: '提升为待办',
      plannerPromoted: '已复制到收件箱，原历史记录保持不变',
      plannerOpenChat: '打开任务 Chat',
      plannerAnswerQuestion: '回答问题',
      plannerInspectError: '查看异常',
      plannerNewTodoTitle: '新建 TODO',
      plannerNewTodoSubtitle: '快速记下一件事；详细计划可以稍后再补。',
      plannerTodoInput: '要做什么',
      plannerTodoPlaceholder: '记下要做的事…',
      plannerTodoHint: 'Enter 添加 · Shift+Enter 换行',
      plannerAddTodo: '添加 TODO',
      plannerStartNowTitle: '立即开始新 TODO',
      plannerStartNowSubtitle: '像发送消息一样描述任务，发送后 Agent 会立即开始处理。',
      plannerStartNowPlaceholder: '描述要立即完成的任务…（Enter 发送，Shift+Enter 换行）',
      plannerComposerUnavailable: '任务输入组件未加载',
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
      plannerCreateRequired: '请输入 TODO 并选择工作区',
      plannerCreatedInbox: 'TODO 已添加',
      plannerCreatedStarted: '新任务已开始',
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
      plannerUnknownFleet: '未知工作区',
      plannerNoDescription: '暂无补充描述',
      plannerDragLabel: '拖动任务：{title}',
      plannerOpenTaskLabel: '打开任务：{title}',
    },
    en: {
      plannerTaskCenter: 'Task Center',
      plannerSubtitle: 'TODOs, execution, and review',
      plannerTodoList: 'TODO',
      plannerBoard: 'Board',
      plannerHistory: 'Activity',
      plannerSource: 'Source',
      plannerSourceAll: 'All',
      plannerSourceBoard: 'Independent',
      plannerSourceSession: 'Chat tasks',
      plannerWorkOverview: 'TODO / Tasks',
      plannerBucketTodo: 'TODO',
      plannerBucketAttention: 'Needs me',
      plannerBucketRunning: 'Running',
      plannerBucketNext: 'Up next',
      plannerBucketReview: 'Review',
      plannerBucketTodoHint: 'Captured but not scheduled',
      plannerBucketAttentionHint: 'Waiting for a reply or error handling',
      plannerBucketRunningHint: 'An agent is working on it',
      plannerBucketNextHint: 'Scheduled and ready to start',
      plannerBucketReviewHint: 'Inspect the result and confirm completion',
      plannerTodoEmptyTitle: 'No tasks need action here',
      plannerTodoEmptyBody: 'Create a TODO or switch sources to inspect chat tasks.',
      plannerActivitySummary: '{modules} modules · {tasks} activity records',
      plannerStartQuick: 'Start',
      plannerCompleteQuick: 'Complete',
      plannerViewTask: 'View task',
      plannerNeedsMe: 'Needs me',
      plannerNewTask: '+ New task',
      plannerNewTodo: '+ New TODO',
      plannerStartNewNow: '▶ Start new TODO now',
      plannerAllFleets: 'All workspaces',
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
      plannerNoPlannedBody: 'Capture a TODO for later, or type a task and start it now.',
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
      plannerFleet: 'Workspace',
      plannerCreated: 'Created {date}',
      plannerUpdated: 'Updated {date}',
      plannerHistorySummary: '{modules} modules · {tasks} history items',
      plannerPromote: 'Promote to todo',
      plannerPromoted: 'Copied to Inbox; the original history item was preserved',
      plannerOpenChat: 'Open task chat',
      plannerAnswerQuestion: 'Answer question',
      plannerInspectError: 'Inspect error',
      plannerNewTodoTitle: 'New TODO',
      plannerNewTodoSubtitle: 'Capture one thing quickly. You can add planning details later.',
      plannerTodoInput: 'What needs doing?',
      plannerTodoPlaceholder: 'Write down a TODO...',
      plannerTodoHint: 'Enter to add · Shift+Enter for a new line',
      plannerAddTodo: 'Add TODO',
      plannerStartNowTitle: 'Start new TODO now',
      plannerStartNowSubtitle: 'Describe the task like a message. The agent starts as soon as you send it.',
      plannerStartNowPlaceholder: 'Describe the task to start now... (Enter to send, Shift+Enter for a new line)',
      plannerComposerUnavailable: 'Task composer is unavailable',
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
      plannerCreateRequired: 'Enter a TODO and choose a workspace',
      plannerCreatedInbox: 'TODO added',
      plannerCreatedStarted: 'New task started',
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
      plannerUnknownFleet: 'Unknown workspace',
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
    mode: 'todo',
    dirId: '',
    query: '',
    origin: 'board',
    bucket: '',
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
    query: state.query,
    origin: state.origin,
    bucket: state.bucket,
  };
  let pendingRenderState = null;
  const boundRoots = new WeakSet();

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
    state.origin = ORIGINS.includes(origin) ? origin : 'board';
    try { localStorage.setItem(ORIGIN_STORAGE_KEY, state.origin); } catch (_) {}
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
    if (!task || task.status === 'archived' || task.status === 'done' || stage === 'done') return '';
    const status = taskStatus(task);
    if (status === 'waiting' || status === 'error' || status === 'blocked') return 'attention';
    if (status === 'running' || status === 'queued') return 'running';
    if (task.recordType !== 'planned') return '';
    // A user reopening a succeeded task moves it to ready. Honour that explicit
    // planning transition instead of letting an old run projection bounce it
    // straight back into Review.
    if (stage === 'review' || (status === 'succeeded' && stage !== 'ready')) return 'review';
    if (stage === 'ready' || stage === 'doing') return 'next';
    return 'todo';
  }

  function taskMatchesScope(task, options) {
    const opts = options || {};
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

  function operationalTasks(options) {
    const opts = options || {};
    const scope = { ...opts, moduleMap: opts.moduleMap || modulesById() };
    return state.board.tasks.filter(task => {
      const bucket = workBucket(task);
      if (!bucket || !taskMatchesScope(task, scope)) return false;
      return opts.ignoreBucket || !state.bucket || bucket === state.bucket;
    });
  }

  function activityTasks(options) {
    const opts = options || {};
    const scope = { ...opts, moduleMap: opts.moduleMap || modulesById() };
    return state.board.tasks.filter(task => taskMatchesScope(task, scope));
  }

  function filteredTasks(mode) {
    return mode === 'activity' ? activityTasks() : operationalTasks();
  }

  function originCounts(mode) {
    const source = mode === 'activity'
      ? activityTasks({ ignoreOrigin: true })
      : operationalTasks({ ignoreOrigin: true, ignoreBucket: true });
    const counts = { all: source.length, board: 0, session: 0 };
    for (const task of source) counts[taskOrigin(task).key] += 1;
    return counts;
  }

  function bucketCounts() {
    const counts = Object.fromEntries(WORK_BUCKETS.map(bucket => [bucket, 0]));
    for (const task of operationalTasks({ ignoreBucket: true })) counts[workBucket(task)] += 1;
    return counts;
  }

  function stageKey(stage) {
    return `plannerStage${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
  }

  function bucketKey(bucket) {
    return `plannerBucket${bucket.charAt(0).toUpperCase()}${bucket.slice(1)}`;
  }

  function bucketHintKey(bucket) {
    return `${bucketKey(bucket)}Hint`;
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
    const dirId = taskContextDirId(task, moduleMap);
    const directory = dirMap.get(dirId);
    const title = taskTitle(task);
    const description = taskDescription(task);
    const origin = taskOrigin(task);
    const planned = task.recordType === 'planned';
    const bucket = context.bucket || workBucket(task);
    const due = duePresentation(task);
    const priority = String(task.priority || '').toLowerCase();
    const attention = attentionKind(task);
    const attentionAction = attention === 'waiting'
      ? tr('plannerAnswerQuestion')
      : attention === 'error' ? tr('plannerInspectError') : '';
    const updated = task.updatedAt || task.lastTs || task.createdAt;
    const quickAction = attentionAction
      ? `<button class="planner-card-attention-action" type="button" data-action="open-chat" data-task-id="${esc(task.id)}">${esc(attentionAction)} <span aria-hidden="true">↗</span></button>`
      : planned && (bucket === 'todo' || bucket === 'next')
        ? `<button class="planner-card-quick-action" type="button" data-action="start-task" data-task-id="${esc(task.id)}">▶ ${esc(tr('plannerStartQuick'))}</button>`
        : planned && bucket === 'review'
          ? `<button class="planner-card-quick-action complete" type="button" data-action="complete-task" data-task-id="${esc(task.id)}">✓ ${esc(tr('plannerCompleteQuick'))}</button>`
          : '';
    return `<article class="planner-card${attention ? ` attention-${attention}` : ''} origin-${esc(origin.key)}"
      data-task-id="${esc(task.id)}" data-action="${planned ? 'open-task' : 'open-chat'}" tabindex="0"
      aria-label="${esc(tr('plannerOpenTaskLabel', { title }))}" title="${esc(tr('plannerOpenTaskLabel', { title }))}">
      <div class="planner-card-title">${esc(title)}</div>
      ${description && description !== title ? `<div class="planner-card-description">${esc(description)}</div>` : ''}
      <div class="planner-card-badges">
        ${priority ? `<span class="planner-badge priority-${esc(priority)}">◆ ${esc(priorityLabel(priority))}</span>` : ''}
        ${due ? `<span class="planner-badge ${esc(due.className)}">◷ ${esc(due.label)}</span>` : ''}
        <span class="planner-badge origin origin-${esc(origin.key)}" title="${esc(origin.title)}">${esc(origin.icon)} ${esc(origin.label)}</span>
        <span class="planner-badge module" title="${esc(module && module.name || tr('plannerNoModule'))}"># ${esc(module && module.name || tr('plannerNoModule'))}</span>
        ${statusHtml(task, true)}
        ${quickAction}
      </div>
      <div class="planner-card-footer">
        <span title="${esc(tr('plannerFleet'))}">${esc(directory && directory.name || tr('plannerUnknownFleet'))}</span>
        <span>${esc(updated ? tr('plannerUpdated', { date: localDate(updated, true) }) : '')}</span>
      </div>
    </article>`;
  }

  function todoRowHtml(task, context) {
    const module = context.moduleMap.get(String(task.moduleId || ''));
    const dirId = taskContextDirId(task, context.moduleMap);
    const directory = context.dirMap.get(dirId);
    const title = taskTitle(task);
    const description = taskDescription(task);
    const origin = taskOrigin(task);
    const planned = task.recordType === 'planned';
    const bucket = workBucket(task);
    const attention = attentionKind(task);
    const updated = task.updatedAt || task.lastTs || task.createdAt;
    const primaryAction = planned ? 'open-task' : 'open-chat';
    const actions = [];
    if (attention) {
      actions.push(`<button class="btn btn-sm planner-todo-primary" type="button" data-action="open-chat" data-task-id="${esc(task.id)}">${esc(attention === 'waiting' ? tr('plannerAnswerQuestion') : tr('plannerInspectError'))} ↗</button>`);
    } else if (planned && (bucket === 'todo' || bucket === 'next')) {
      actions.push(`<button class="btn btn-sm planner-todo-primary" type="button" data-action="start-task" data-task-id="${esc(task.id)}">▶ ${esc(tr('plannerStartQuick'))}</button>`);
    } else if (planned && bucket === 'review') {
      actions.push(`<button class="btn btn-sm planner-todo-primary complete" type="button" data-action="complete-task" data-task-id="${esc(task.id)}">✓ ${esc(tr('plannerCompleteQuick'))}</button>`);
    } else {
      actions.push(`<button class="btn btn-sm" type="button" data-action="open-chat" data-task-id="${esc(task.id)}">${esc(tr('plannerOpenChat'))}</button>`);
    }
    if (!planned) {
      actions.push(`<button class="btn btn-sm" type="button" data-action="promote" data-task-id="${esc(task.id)}">${esc(tr('plannerPromote'))}</button>`);
    }
    return `<article class="planner-todo-row${attention ? ` attention-${attention}` : ''}" data-task-id="${esc(task.id)}" data-action="${primaryAction}" tabindex="0" aria-label="${esc(tr('plannerOpenTaskLabel', { title }))}">
      <span class="planner-todo-state" aria-hidden="true"></span>
      <div class="planner-todo-content">
        <div class="planner-todo-title">${esc(title)}</div>
        ${description && description !== title ? `<div class="planner-todo-description">${esc(description)}</div>` : ''}
        <div class="planner-todo-meta">
          <span class="planner-badge origin origin-${esc(origin.key)}" title="${esc(origin.title)}">${esc(origin.icon)} ${esc(origin.label)}</span>
          <span class="planner-badge module"># ${esc(module && module.name || tr('plannerNoModule'))}</span>
          ${statusHtml(task, true)}
          <span>${esc(directory && directory.name || tr('plannerUnknownFleet'))}</span>
          <span>·</span><span>${esc(updated ? tr('plannerUpdated', { date: localDate(updated, true) }) : '')}</span>
        </div>
      </div>
      <div class="planner-todo-actions">${actions.join('')}</div>
    </article>`;
  }

  function todoListHtml() {
    const tasks = filteredTasks('todo').sort(rankCompare);
    if (!tasks.length) {
      return `<div class="planner-empty"><div><strong>${esc(tr('plannerTodoEmptyTitle'))}</strong>${esc(tr('plannerTodoEmptyBody'))}</div></div>`;
    }
    const context = { moduleMap: modulesById(), dirMap: directoriesById() };
    const buckets = state.bucket ? [state.bucket] : WORK_BUCKETS;
    return `<div class="planner-todo-list">${buckets.map(bucket => {
      const list = tasks.filter(task => workBucket(task) === bucket);
      if (!list.length) return '';
      return `<section class="planner-todo-group" data-bucket="${bucket}">
        <header><span class="planner-column-dot" aria-hidden="true"></span><strong>${esc(tr(bucketKey(bucket)))}</strong><span>${esc(tr(bucketHintKey(bucket)))}</span><b>${list.length}</b></header>
        <div>${list.map(task => todoRowHtml(task, context)).join('')}</div>
      </section>`;
    }).join('')}</div>`;
  }

  function boardHtml() {
    const tasks = filteredTasks('board').sort(rankCompare);
    const moduleMap = modulesById();
    const dirMap = directoriesById();
    const context = { moduleMap, dirMap };
    const buckets = state.bucket ? [state.bucket] : WORK_BUCKETS;
    return `<div class="planner-board-scroll"><div class="planner-board${state.bucket ? ' is-filtered' : ''}">
      ${buckets.map(bucket => {
        const list = tasks.filter(task => workBucket(task) === bucket);
        return `<section class="planner-column" data-bucket="${bucket}">
          <header class="planner-column-head">
            <span class="planner-column-dot" aria-hidden="true"></span>
            <span class="planner-column-title">${esc(tr(bucketKey(bucket)))}</span>
            <span class="planner-column-hint">${esc(tr(bucketHintKey(bucket)))}</span>
            <span class="planner-column-count">${list.length}</span>
          </header>
          <div class="planner-card-list" data-bucket="${bucket}" data-empty="${esc(tr('plannerColumnEmpty'))}">
            ${list.map(task => cardHtml(task, { ...context, bucket })).join('')}
          </div>
        </section>`;
      }).join('')}
    </div></div>`;
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
            const editable = planned && task.status !== 'archived';
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
                ${planned ? '' : `<button class="btn btn-sm" type="button" data-action="promote" data-task-id="${esc(task.id)}">${esc(tr('plannerPromote'))}</button>`}
              </div>
            </div>`;
          }).join('')}
        </details>`;
      }).join('')}
    </div>`;
  }

  function workOverviewHtml() {
    const counts = bucketCounts();
    return `<div class="planner-work-overview">
      <strong>${esc(tr('plannerWorkOverview'))}</strong>
      <div class="planner-work-buckets" role="group" aria-label="${esc(tr('plannerWorkOverview'))}">
        ${WORK_BUCKETS.map(bucket => `<button type="button" class="planner-work-bucket${state.bucket === bucket ? ' active' : ''}" aria-pressed="${state.bucket === bucket}" data-action="bucket" data-bucket="${bucket}"><span>${esc(tr(bucketKey(bucket)))}</span><strong>${counts[bucket]}</strong></button>`).join('')}
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
    const boardScroll = root.querySelector('.planner-board-scroll');
    const historyScroll = root.querySelector('.planner-history');
    const todoScroll = root.querySelector('.planner-todo-list');
    const columnScroll = {};
    root.querySelectorAll('.planner-card-list').forEach(list => {
      if (list.dataset && list.dataset.bucket) columnScroll[list.dataset.bucket] = list.scrollTop;
    });
    const active = document.activeElement;
    const searchFocused = !!(active && typeof active.matches === 'function'
      && active.matches('[data-control="search"]')
      && (typeof root.contains !== 'function' || root.contains(active)));
    return {
      boardLeft: boardScroll ? boardScroll.scrollLeft : 0,
      boardTop: boardScroll ? boardScroll.scrollTop : 0,
      historyTop: historyScroll ? historyScroll.scrollTop : 0,
      todoTop: todoScroll ? todoScroll.scrollTop : 0,
      columnScroll,
      searchFocused,
      selectionStart: searchFocused ? active.selectionStart : null,
      selectionEnd: searchFocused ? active.selectionEnd : null,
    };
  }

  function restoreRenderState(saved) {
    if (!saved) return;
    const boardScroll = root.querySelector('.planner-board-scroll');
    if (boardScroll) {
      boardScroll.scrollLeft = saved.boardLeft;
      boardScroll.scrollTop = saved.boardTop;
    }
    const historyScroll = root.querySelector('.planner-history');
    if (historyScroll) historyScroll.scrollTop = saved.historyTop;
    const todoScroll = root.querySelector('.planner-todo-list');
    if (todoScroll) todoScroll.scrollTop = saved.todoTop;
    root.querySelectorAll('.planner-card-list').forEach(list => {
      const bucket = list.dataset && list.dataset.bucket;
      if (bucket && Number.isFinite(saved.columnScroll[bucket])) list.scrollTop = saved.columnScroll[bucket];
    });
    if (!saved.searchFocused) return;
    const search = root.querySelector('[data-control="search"]');
    if (!search) return;
    try { search.focus({ preventScroll: true }); } catch (_) { search.focus(); }
    if (Number.isFinite(saved.selectionStart) && typeof search.setSelectionRange === 'function') {
      search.setSelectionRange(saved.selectionStart, Number.isFinite(saved.selectionEnd) ? saved.selectionEnd : saved.selectionStart);
    }
  }

  function render() {
    const savedRenderState = pendingRenderState || captureRenderState();
    pendingRenderState = null;
    const embedded = surface === 'fleet';
    const globalWork = state.board.tasks.filter(task => !!workBucket(task));
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
        : state.mode === 'todo' ? todoListHtml()
          : state.mode === 'board' ? boardHtml() : activityHtml();

    const directory = directoriesById().get(lockedDirId);
    const fleetControl = embedded
      ? `<div class="planner-fleet-lock" title="${esc(directory && directory.name || lockedDirId)}"><span aria-hidden="true">◆</span><strong>${esc(directory && directory.name || lockedDirId || tr('plannerUnknownFleet'))}</strong><span>${esc(tr('plannerTaskCenter'))}</span></div>`
      : `<label class="planner-sr-only" for="planner-fleet-filter">${esc(tr('plannerFleet'))}</label>
          <select class="planner-control planner-select" id="planner-fleet-filter" data-control="fleet">
            <option value="">${esc(tr('plannerAllFleets'))}</option>${directoryOptions()}
          </select>`;
    const modeControl = `<div class="planner-segment" role="tablist">
          <button id="planner-mode-todo" type="button" role="tab" aria-selected="${state.mode === 'todo'}" aria-controls="planner-content" class="${state.mode === 'todo' ? 'active' : ''}" data-action="mode" data-mode="todo">${esc(tr('plannerTodoList'))}</button>
          <button id="planner-mode-board" type="button" role="tab" aria-selected="${state.mode === 'board'}" aria-controls="planner-content" class="${state.mode === 'board' ? 'active' : ''}" data-action="mode" data-mode="board">${esc(tr('plannerBoard'))}</button>
          <button id="planner-mode-activity" type="button" role="tab" aria-selected="${state.mode === 'activity'}" aria-controls="planner-content" class="${state.mode === 'activity' ? 'active' : ''}" data-action="mode" data-mode="activity">${esc(tr('plannerHistory'))}</button>
        </div>`;
    const mainA11y = `role="tabpanel" aria-labelledby="planner-mode-${state.mode}"`;

    root.classList.toggle('planner-fleet-embedded', embedded);
    root.innerHTML = `<div class="planner-shell${embedded ? ' embedded' : ''}">
      <div class="planner-toolbar">
        <div class="planner-toolbar-group">
          ${fleetControl}
          <label class="planner-search"><span class="planner-sr-only">${esc(tr('plannerSearchPlaceholder'))}</span><input class="planner-control" type="search" value="${esc(state.query)}" placeholder="${esc(tr('plannerSearchPlaceholder'))}" data-control="search"></label>
        </div>
        ${originFilterHtml(state.mode)}
        <div class="planner-grow"></div>
        ${modeControl}
        <div class="planner-toolbar-group actions">
          <button class="icon-btn" type="button" data-action="refresh" title="${esc(tr('plannerRefresh'))}" aria-label="${esc(tr('plannerRefresh'))}">⟳</button>
          <button class="btn" type="button" data-action="new-todo">${esc(tr('plannerNewTodo'))}</button>
          <button class="btn btn-green" type="button" data-action="start-new-now">${esc(tr('plannerStartNewNow'))}</button>
        </div>
      </div>
      ${workOverviewHtml()}
      <div class="planner-sr-only" role="status" aria-live="polite" aria-atomic="true">${busy ? esc(tr('plannerLoading')) : state.error ? esc(tr('plannerLoadFailed', { error: state.error })) : ''}</div>
      <div class="planner-main" id="planner-content" ${mainA11y}>${main}</div>
    </div>`;
    restoreRenderState(savedRenderState);
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

  function taskTitleFromText(value) {
    const text = String(value || '').trim();
    const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || text;
    return firstLine.slice(0, 40);
  }

  function dialogDirectoryPicker(id, selectedDir) {
    const directory = directoriesById().get(String(selectedDir || ''));
    if (surface === 'fleet' && lockedDirId) {
      return `<div class="planner-dialog-fleet planner-dialog-fleet-locked"><span>${esc(tr('plannerFleet'))}</span><strong>${esc(directory && directory.name || lockedDirId)}</strong></div>`;
    }
    return `<label class="planner-dialog-fleet" for="${esc(id)}"><span>${esc(tr('plannerFleet'))}</span><select id="${esc(id)}" data-planner-dir required><option value=""></option>${panelOptions(selectedDir)}</select></label>`;
  }

  function dialogDirectoryId(overlay, fallback) {
    const picker = overlay.querySelector('[data-planner-dir]');
    // A locked Fleet surface has no picker and legitimately uses its fallback.
    // If a picker exists, preserve an explicit empty value so validation can
    // reject it instead of silently routing the task to the initial Fleet.
    return String(picker ? picker.value : fallback || '').trim();
  }

  function openNewTodoDialog() {
    closePlannerOverlay();
    const selectedDir = initialTaskDirId();
    const overlay = document.createElement('div');
    overlay.className = 'planner-overlay centered';
    overlay.__plannerReturnFocus = document.activeElement;
    overlay.innerHTML = `<form class="planner-dialog planner-quick-dialog" id="planner-new-form" role="dialog" aria-modal="true" aria-labelledby="planner-new-todo-heading">
      <div class="planner-panel-head">
        <div class="planner-panel-title"><h2 id="planner-new-todo-heading">${esc(tr('plannerNewTodoTitle'))}</h2><p>${esc(tr('plannerNewTodoSubtitle'))}</p></div>
        <button class="icon-btn" type="button" data-overlay-close aria-label="${esc(tr('plannerCancel'))}">×</button>
      </div>
      <div class="planner-panel-body planner-quick-body">
        <label class="planner-quick-input" for="planner-new-todo"><span>${esc(tr('plannerTodoInput'))}</span><textarea id="planner-new-todo" name="text" maxlength="20000" required placeholder="${esc(tr('plannerTodoPlaceholder'))}"></textarea><small>${esc(tr('plannerTodoHint'))}</small></label>
        ${dialogDirectoryPicker('planner-new-dir', selectedDir)}
      </div>
      <div class="planner-panel-actions">
        <button class="btn" type="button" data-overlay-close>${esc(tr('plannerCancel'))}</button><span class="spacer"></span>
        <button class="btn btn-green" type="submit">${esc(tr('plannerAddTodo'))}</button>
      </div>
    </form>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-overlay-close]')) closePlannerOverlay();
    });
    const form = overlay.querySelector('form');
    form.addEventListener('submit', event => {
      event.preventDefault();
      createTodoFromDialog(overlay, selectedDir);
    });
    form.querySelector('[name="text"]').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    activateOverlay(overlay, '[name="text"]');
  }

  async function createTodoFromDialog(overlay, fallbackDirId) {
    const form = overlay.querySelector('form');
    const values = new FormData(form);
    const text = String(values.get('text') || '').trim();
    const dirId = dialogDirectoryId(overlay, fallbackDirId);
    if (!text || !dirId) {
      notify(tr('plannerCreateRequired'), true);
      form.reportValidity();
      return;
    }
    const buttons = [...overlay.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    try {
      const created = await requestJson('/api/task-board/tasks', {
        method: 'POST',
        json: {
          recordType: 'planned',
          title: taskTitleFromText(text),
          description: text,
          dirId,
          workflowStage: 'inbox',
          priority: null,
          dueAt: null,
          acceptanceCriteria: null,
        },
      });
      updateTaskFromResponse(created);
      state.mode = 'todo';
      state.bucket = '';
      selectOrigin('board');
      closePlannerOverlay(overlay);
      await loadPlanner({ quiet: true });
      notify(tr('plannerCreatedInbox'));
    } catch (error) {
      notify(tr('plannerActionFailed', { error: errorText(error) }), true);
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  function openStartNowDialog() {
    closePlannerOverlay();
    const composerApi = window.MultiCCTaskBoardComposer;
    if (!composerApi || typeof composerApi.mount !== 'function') {
      notify(tr('plannerActionFailed', { error: tr('plannerComposerUnavailable') }), true);
      return;
    }
    const selectedDir = initialTaskDirId();
    const overlay = document.createElement('div');
    overlay.className = 'planner-overlay centered';
    overlay.__plannerReturnFocus = document.activeElement;
    overlay.innerHTML = `<section class="planner-dialog planner-start-dialog" role="dialog" aria-modal="true" aria-labelledby="planner-start-now-heading">
      <div class="planner-panel-head">
        <div class="planner-panel-title"><h2 id="planner-start-now-heading">${esc(tr('plannerStartNowTitle'))}</h2><p>${esc(tr('plannerStartNowSubtitle'))}</p></div>
        <button class="icon-btn" type="button" data-overlay-close aria-label="${esc(tr('plannerCancel'))}">×</button>
      </div>
      <div class="planner-panel-body planner-start-body">
        ${dialogDirectoryPicker('planner-start-dir', selectedDir)}
        <div class="planner-start-composer"></div>
      </div>
    </section>`;
    document.body.appendChild(overlay);
    const composer = composerApi.mount(overlay.querySelector('.planner-start-composer'), {
      contextKey: selectedDir,
      placeholder: tr('plannerStartNowPlaceholder'),
      onSendingChange: sending => {
        overlay.dataset.plannerSending = sending ? 'true' : 'false';
        const picker = overlay.querySelector('[data-planner-dir]');
        if (picker) picker.disabled = sending;
        overlay.querySelectorAll('[data-overlay-close]').forEach(button => {
          button.disabled = sending;
        });
      },
      submit: async payload => {
        const dirId = dialogDirectoryId(overlay, selectedDir);
        if (!dirId) throw new Error(tr('plannerCreateRequired'));
        const result = await requestJson('/api/task-board/send', {
          method: 'POST',
          json: { ...payload, dirId },
        });
        state.mode = 'todo';
        state.bucket = '';
        selectOrigin('board');
        await loadPlanner({ quiet: true });
        closePlannerOverlay(overlay);
        notify(tr('plannerCreatedStarted'));
        return result && result.queued ? tr('plannerCreatedStarted') : tr('plannerStarted');
      },
    });
    overlay.__plannerCleanup = () => composer.destroy();
    overlay.addEventListener('click', event => {
      if (overlay.dataset.plannerSending === 'true') return;
      if (event.target === overlay || event.target.closest('[data-overlay-close]')) closePlannerOverlay();
    });
    const fleetSelect = overlay.querySelector('[data-planner-dir]');
    if (fleetSelect) {
      fleetSelect.addEventListener('change', () => {
        // Destination changes must not erase text, attachments, or Goal
        // settings the user has already entered in this short-lived dialog.
        composer.setContext(fleetSelect.value, { preserveDraft: true });
      });
    }
    activateOverlay(overlay, '.tb-input');
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
          dirId: taskContextDirId(task, moduleMap),
          workflowStage: 'inbox',
          priority: null,
          dueAt: null,
          acceptanceCriteria: null,
        },
      });
      updateTaskFromResponse(data);
      state.mode = 'todo';
      state.bucket = '';
      selectOrigin('board');
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
    if (kind === 'new-todo') openNewTodoDialog();
    else if (kind === 'start-new-now') openStartNowDialog();
    else if (kind === 'refresh') loadPlanner({ refreshDirectories: true });
    else if (kind === 'mode') {
      state.mode = MODES.includes(action.dataset.mode) ? action.dataset.mode : 'todo';
      if (state.mode === 'activity') state.bucket = '';
      render();
    } else if (kind === 'origin') {
      selectOrigin(action.dataset.origin);
      render();
    } else if (kind === 'bucket') {
      const bucket = WORK_BUCKETS.includes(action.dataset.bucket) ? action.dataset.bucket : '';
      state.bucket = state.bucket === bucket ? '' : bucket;
      if (state.mode === 'activity') state.mode = 'todo';
      render();
    } else if (kind === 'open-task') {
      const taskId = action.dataset.taskId || action.closest('[data-task-id]')?.dataset.taskId;
      const task = findTask(taskId);
      if (task && task.recordType === 'planned' && task.status !== 'archived') openTaskDrawer(taskId);
      else window.open(`/chat.html?task=${encodeURIComponent(taskId)}`, '_blank');
    } else if (kind === 'open-chat') {
      window.open(`/chat.html?task=${encodeURIComponent(action.dataset.taskId)}`, '_blank');
    } else if (kind === 'start-task') {
      startTaskDirect(action.dataset.taskId, action);
    } else if (kind === 'complete-task') {
      completeTaskDirect(action.dataset.taskId, action);
    } else if (kind === 'promote') {
      promoteObserved(action.dataset.taskId, action);
    }
  }

  function handleRootChange(event) {
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
    const card = event.target.closest('.planner-card,.planner-todo-row');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      const task = findTask(card.dataset.taskId);
      if (task && task.recordType === 'planned') openTaskDrawer(card.dataset.taskId);
      else window.open(`/chat.html?task=${encodeURIComponent(card.dataset.taskId)}`, '_blank');
    }
  }

  function uiStateSnapshot() {
    return {
      mode: state.mode,
      dirId: state.dirId,
      query: state.query,
      origin: state.origin,
      bucket: state.bucket,
      renderState: captureRenderState(),
    };
  }

  function applyUiState(value) {
    const next = value || {};
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
    state.mode = MODES.includes(next.mode) ? next.mode : 'todo';
    state.dirId = String(next.dirId || '');
    state.query = String(next.query || '');
    selectOrigin(ORIGINS.includes(next.origin) ? next.origin : state.origin);
    state.bucket = WORK_BUCKETS.includes(next.bucket) ? next.bucket : '';
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
      if (root !== globalRoot) root.innerHTML = '';
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
    if (root !== element || !sameFleet) root.innerHTML = '';
    root = element;
    surface = 'fleet';
    lockedDirId = nextDirId;
    const saved = sameFleet ? currentSurfaceState : fleetUiStates.get(nextDirId);
    applyUiState({
      ...(saved || {}),
      mode: saved && MODES.includes(saved.mode) ? saved.mode : 'todo',
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
    if (root !== globalRoot) root.innerHTML = '';
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
