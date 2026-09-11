(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const initialParams = new URLSearchParams(location.search);
  const adminModes = window.MultiCCAirAdmin?.modes || new Set();
  const modeFrom = params => {
    const requested = params.get('view');
    if (requested === 'directories') return 'library';
    if (requested === 'activity') return 'activity';
    if (requested === 'schedules') return 'schedules';
    if (adminModes.has(requested)) return requested;
    return 'tasks';
  };
  let data = null;
  let directoryId = initialParams.get('dir');
  let taskId = initialParams.get('task');
  let entry = null;
  let mode = modeFrom(initialParams);
  let scheduleTasks = [];
  let scheduleLoading = false;
  let timer;
  let epoch = 0;
  let stopped = false;
  let loading = false;
  let createAttempt = null;
  let quickCreateAttempt = null;
  let quickCliSignature = '';

  const stateNames = {
    active: '进行中', succeeded: '成功', unknown: '结果待核验', failed: '失败', error: '失败', cancelled: '已取消',
    workspace_execution_capacity: '等待执行名额', workspace_resident_capacity: '等待目录容量',
    workspace_restore_capacity: '等待目录准备名额', planned: '执行时准备目录', resident: '目录已准备',
    retained: '目录已保留', hibernated: '目录已休眠', reserved: '准备执行', materializing: '正在准备目录',
    starting: '正在启动', running: '执行中', uncertain: '等待核实执行状态', idle: '空闲', queued: '排队中',
    waiting: '等待回答', inbox: '待处理', doing: '进行中', done: '已完成', archived: '已归档', stale: '建议已过期',
  };
  const blockerNames = {
    view_changed: '已有新输入或视图变化，旧建议不能迟到改投。',
    final_run_result_required: '等待本轮最终执行结果。',
    run_not_succeeded: '本轮失败、取消或仍在等待回答。',
    code_observation_required: '本轮最终代码版本尚未核实。',
    integration_receipt_required: '等待本轮代码按项目流程合入基分支。',
    baseline_revalidation_required: '基分支已变化，需要重新核验交付记录。',
    source_writer_barrier_required: '尚不能确认源工作目录持续停写。',
  };

  const label = value => stateNames[value] || value || '';
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const stored = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value == null ? fallback : value;
    } catch (_) { return fallback; }
  };
  let favorites = stored('air:favorites', []);
  if (!Array.isArray(favorites)) favorites = [];

  async function api(path, body, requestedMethod = null) {
    const method = requestedMethod || (body === undefined ? 'GET' : 'POST');
    const hasBody = body !== undefined;
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      cache: method === 'GET' ? 'no-store' : 'default',
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : {}; }
    catch (_) {
      const message = /<!doctype|<html/i.test(raw)
        ? 'Air 服务接口尚未加载。请重启 MultiCC 服务后刷新页面。'
        : `Air 服务返回了无法识别的数据（HTTP ${response.status}）。`;
      throw Object.assign(new Error(message), { code: 'air_invalid_response', status: response.status });
    }
    if (!response.ok || result.ok === false) {
      throw Object.assign(new Error(result.message || result.error || result.code || `HTTP ${response.status}`), result);
    }
    return result;
  }

  function notice(text = '') { $('notice').textContent = text; }
  function closeNav() {
    document.body.classList.remove('nav-open');
    $('mobile-nav').setAttribute('aria-expanded', 'false');
  }
  function toggleNav() {
    const open = !document.body.classList.contains('nav-open');
    document.body.classList.toggle('nav-open', open);
    $('mobile-nav').setAttribute('aria-expanded', String(open));
  }
  function closeDetails() {
    $('task-details').hidden = true;
    $('details-toggle').setAttribute('aria-expanded', 'false');
    $('task-state').setAttribute('aria-expanded', 'false');
  }
  function toggleDetails(value = $('task-details').hidden) {
    if (!taskId) return;
    $('task-details').hidden = !value;
    $('details-toggle').setAttribute('aria-expanded', String(value));
    $('task-state').setAttribute('aria-expanded', String(value));
  }
  function saveDraft() {
    const doc = $('conversation').contentDocument;
    const input = doc?.getElementById('input') || doc?.getElementById('message');
    if (taskId && input) sessionStorage.setItem(`air:draft:${taskId}`, input.value);
  }
  function routeUrl(nextMode = mode) {
    const params = new URLSearchParams();
    if (nextMode === 'library') params.set('view', 'directories');
    if (nextMode === 'activity') params.set('view', 'activity');
    if (nextMode === 'schedules') params.set('view', 'schedules');
    if (adminModes.has(nextMode)) params.set('view', nextMode);
    const external = initialParams.get('external');
    if (external) params.set('external', external);
    if (directoryId) params.set('dir', directoryId);
    if (taskId && nextMode === 'tasks') params.set('task', taskId);
    return '/air' + (params.size ? '?' + params : '');
  }
  function navigate(dir, task = null) {
    saveDraft();
    directoryId = dir;
    taskId = task;
    mode = 'tasks';
    entry = null;
    closeDetails();
    history.pushState({}, '', routeUrl());
    closeNav();
    render();
    void refreshEntry();
  }
  function setMode(next) {
    saveDraft();
    mode = next;
    taskId = null;
    entry = null;
    closeDetails();
    history.pushState({}, '', routeUrl(next));
    closeNav();
    render();
    if (next === 'library') requestAnimationFrame(() => $('directory-search').focus());
    if (next === 'schedules') void refreshSchedules();
    if (next === 'overview') void refreshSchedules().then(render);
  }
  function resourceText(resource) {
    if (resource?.capacityReason) return label(resource.capacityReason);
    if (resource?.lease && resource.lease !== 'idle') return label(resource.lease);
    return label(resource?.residency);
  }
  function directoryName(id) { return data?.directories.find(directory => directory.id === id)?.name || '未知目录'; }

  function renderDirectories() {
    if (!data) return;
    const query = $('directory-search').value.trim().toLowerCase();
    const directories = data.directories.filter(directory => `${directory.name} ${directory.path}`.toLowerCase().includes(query));
    $('directory-grid').replaceChildren(...directories.map(directory => {
      const button = node('button');
      const taskCount = data.tasks.filter(task => task.dirId === directory.id).length;
      button.append(node('strong', '▣ ' + directory.name), node('small', directory.path), node('small', `${taskCount} 个任务${favorites.includes(directory.id) ? ' · 已收藏' : ''}`));
      button.onclick = () => navigate(directory.id);
      return button;
    }));
    if (!directories.length) $('directory-grid').append(node('p', query ? '没有匹配的工作目录。' : '还没有工作目录。', 'empty-list'));
  }

  function renderDirectoryOverview() {
    const dir = data?.directories.find(directory => directory.id === directoryId);
    const tasks = (data?.tasks || []).filter(task => task.dirId === directoryId);
    const current = tasks.filter(task => !['done', 'archived'].includes(task.status));
    const running = current.filter(task => ['reserved', 'materializing', 'starting', 'running', 'uncertain']
      .includes(task.resource?.lease));
    const planned = current.filter(task => task.recordType === 'planned' && !running.includes(task));
    $('directory-overview-title').textContent = dir ? `${dir.name} · 任务概览` : '先添加工作目录';
    $('directory-overview-path').textContent = dir?.path || '目录创建后，任务与对话会固定归属到这里。';
    $('directory-open-planner').disabled = !dir;
    const stat = (name, value, detail, tone = '') => {
      const card = node('article', null, `directory-stat ${tone}`);
      card.append(node('span', name), node('strong', String(value)), node('small', detail));
      return card;
    };
    $('directory-stats').replaceChildren(
      stat('进行中', current.length, `${running.length} 个正在执行`, 'blue'),
      stat('计划任务', planned.length, '待开始或继续规划'),
      stat('已完成', tasks.filter(task => task.status === 'done').length, '仍保留在本目录', 'green'),
      stat('全部记录', tasks.length, `${tasks.filter(task => task.status === 'archived').length} 个已归档`),
    );
    $('directory-overview-count').textContent = `${tasks.length} 个任务`;
    const rows = [...tasks].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 10);
    $('directory-task-list').replaceChildren(...rows.map(task => {
      const button = node('button', null, 'directory-task-row');
      const copy = node('span');
      copy.append(node('strong', task.title || '未命名任务'), node('small', `${label(task.workflowStage || task.status)} · ${resourceText(task.resource)}`));
      button.append(node('span', task.recordType === 'planned' ? '◇' : '›', 'directory-task-mark'), copy,
        node('time', task.updatedAt ? new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''));
      button.onclick = () => navigate(directoryId, task.id);
      return button;
    }));
    if (!rows.length) $('directory-task-list').append(node('p', '这里还没有任务。可以直接在下方描述第一个目标。', 'directory-task-empty'));
    const cliSignature = JSON.stringify(data?.clis || []);
    if (cliSignature !== quickCliSignature) {
      const previous = $('quick-task-cli').value;
      $('quick-task-cli').replaceChildren(...(data?.clis || []).map(cli => {
        const option = node('option', cli); option.value = cli; return option;
      }));
      if ([...$('quick-task-cli').options].some(option => option.value === previous)) $('quick-task-cli').value = previous;
      quickCliSignature = cliSignature;
    }
    for (const element of [$('quick-task-input'), $('quick-task-cli'), $('quick-task-submit'), $('quick-task-attach')]) element.disabled = !dir;
  }

  function quickTaskId() {
    return crypto.randomUUID ? crypto.randomUUID() : `air-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function uploadQuickTaskFiles(files) {
    $('quick-task-attach').disabled = true;
    for (const file of Array.from(files || [])) {
      const chip = node('span', `上传中 · ${file.name}`, 'quick-task-file');
      $('quick-task-files').append(chip);
      try {
        const form = new FormData(); form.append('file', file, file.name);
        const response = await fetch('/api/upload', { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok || !result.path) throw new Error(result.error || `HTTP ${response.status}`);
        chip.textContent = file.name;
        chip.dataset.path = result.path;
        const remove = node('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${file.name}`);
        remove.onclick = () => chip.remove(); chip.append(remove);
      } catch (error) {
        chip.classList.add('error'); chip.textContent = `${file.name} · ${error.message}`;
      }
    }
    $('quick-task-file-input').value = '';
    $('quick-task-attach').disabled = !directoryId;
  }

  async function submitQuickTask(event) {
    event.preventDefault();
    if (!data || !directoryId) return;
    const typed = $('quick-task-input').value.trim();
    if (!typed) return;
    const paths = [...$('quick-task-files').querySelectorAll('[data-path]')].map(chip => chip.dataset.path);
    const text = typed + (paths.length ? `\n\n附件：${paths.join(' ')}` : '');
    const cli = $('quick-task-cli').value || data.clis[0] || 'claude';
    const goal = $('quick-task-goal').checked;
    const fingerprint = JSON.stringify([directoryId, text, cli, goal]);
    if (!quickCreateAttempt || quickCreateAttempt.fingerprint !== fingerprint) {
      quickCreateAttempt = { fingerprint, createId: quickTaskId(), sendId: quickTaskId() };
    }
    const attempt = quickCreateAttempt;
    let created = null;
    $('quick-task-submit').disabled = true;
    $('quick-task-status').textContent = '正在创建固定任务…';
    try {
      const title = typed.split(/\n/).find(Boolean).trim().slice(0, 120);
      created = await api('/api/air/tasks', { dirId: directoryId, title, cli, clientMsgId: attempt.createId });
      $('quick-task-status').textContent = '任务已创建，正在发送第一条消息…';
      await api(`/api/task-shell-tasks/${encodeURIComponent(created.taskId)}/messages`, {
        text, clientMsgId: attempt.sendId, intent: 'work', ...(goal ? { goal: true, goalLimits: {} } : {}),
      });
      quickCreateAttempt = null;
      $('quick-task-input').value = '';
      $('quick-task-goal').checked = false;
      $('quick-task-files').replaceChildren();
      await refresh();
      navigate(directoryId, created.taskId);
    } catch (error) {
      if (created?.taskId) {
        sessionStorage.setItem(`air:draft:${created.taskId}`, text);
        quickCreateAttempt = null;
        await refresh();
        navigate(directoryId, created.taskId);
        notice(`任务已创建，但第一条消息未确认送达：${error.message}。草稿已保留。`);
      } else $('quick-task-status').textContent = error.message;
    } finally { $('quick-task-submit').disabled = false; }
  }

  function scheduleTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  }

  function scheduleRuntime(task) {
    return [task.cli, task.provider, task.model, task.effort].filter(Boolean).join(' · ') || '跟随任务配置';
  }

  function scheduleAction(text, action, className = '') {
    const button = node('button', text, className);
    button.type = 'button';
    button.onclick = action;
    return button;
  }

  function renderSchedules() {
    const list = $('schedule-list');
    if (!list) return;
    const enabled = scheduleTasks.filter(task => task.enabled).length;
    const errors = scheduleTasks.filter(task => task.lastStatus === 'error' || task.taskBindingError).length;
    $('schedule-summary').replaceChildren(
      node('span', `${scheduleTasks.length} 条规则`),
      node('span', `${enabled} 条启用`),
      node('span', errors ? `${errors} 条需处理` : '固定任务均正常', errors ? 'warning' : 'healthy'),
    );
    list.replaceChildren();
    if (!scheduleTasks.length) {
      const empty = node('div', null, 'schedule-empty');
      empty.append(node('strong', '还没有定时任务'), node('p', '新建规则时会同时创建一个固定 Air 任务，后续运行都在该任务中继续。'));
      list.append(empty);
      return;
    }
    for (const task of scheduleTasks) {
      const card = node('article', null, 'schedule-card');
      const head = node('header', null, 'schedule-card-head');
      const title = node('div');
      title.append(node('span', 'SCHEDULE', 'eyebrow'), node('h3', task.name));
      head.append(title, node('span', task.enabled ? '已启用' : '已停用', `schedule-badge ${task.enabled ? 'enabled' : ''}`));

      const timing = node('div', null, 'schedule-timing');
      const expression = node('code', task.cron);
      const next = node('div');
      next.append(node('small', '下次运行'), node('strong', task.enabled ? scheduleTime(task.nextRunAt) : '已暂停'));
      const previous = node('div');
      previous.append(node('small', '最近触发'), node('strong', task.lastRunAt ? scheduleTime(task.lastRunAt) : '尚未运行'));
      timing.append(expression, next, previous);

      const fixed = node('button', null, `schedule-fixed-task ${task.taskBindingError || !task.taskId ? 'broken' : ''}`);
      fixed.type = 'button';
      fixed.disabled = !task.taskId;
      const fixedCopy = node('span');
      fixedCopy.append(node('small', '固定 Air 任务'), node('strong', task.taskTitle || task.name),
        node('small', task.taskBindingError || (task.taskId ? `${task.taskId} · ${scheduleRuntime(task)}` : '正在建立任务绑定')));
      fixed.append(node('span', task.taskBindingError ? '!' : '↗', 'schedule-task-mark'), fixedCopy);
      if (task.taskId) fixed.onclick = () => navigate(task.dirId, task.taskId);

      const state = node('div', null, `schedule-state ${task.lastStatus === 'error' ? 'error' : ''}`);
      const stateLabel = task.lastStatus === 'queued' ? '已进入固定任务队列'
        : task.lastStatus === 'ok' ? '最近一次已接收'
          : task.lastStatus === 'error' ? (task.lastError || '最近一次运行失败') : '等待首次运行';
      state.append(node('span', stateLabel), node('small', `${task.dirName} · 已触发 ${task.runCount || 0} 次`));

      const prompt = node('p', task.prompt, 'schedule-prompt');
      const actions = node('footer', null, 'schedule-actions');
      const run = scheduleAction('▶ 立即运行', () => runSchedule(task.id), 'primary subtle');
      const toggle = scheduleAction(task.enabled ? '暂停' : '启用', () => toggleSchedule(task.id, !task.enabled));
      const edit = scheduleAction('编辑规则', () => openScheduleDialog(task.id));
      const remove = scheduleAction('删除规则', () => deleteSchedule(task.id), 'danger');
      actions.append(run, toggle, edit, node('span'), remove);
      card.append(head, timing, fixed, state, prompt, actions);
      list.append(card);
    }
  }

  async function refreshSchedules() {
    if (scheduleLoading) return;
    scheduleLoading = true;
    try {
      scheduleTasks = await api('/api/cron');
      renderSchedules();
    } catch (error) {
      if (mode === 'schedules') notice(`定时任务读取失败：${error.message}`);
    } finally { scheduleLoading = false; }
  }

  function openScheduleDialog(id = null) {
    if (!data) return;
    const current = id ? scheduleTasks.find(task => task.id === id) : null;
    const form = $('schedule-form');
    form.reset();
    form.elements.id.value = current?.id || '';
    form.elements.name.value = current?.name || '';
    form.elements.cron.value = current?.cron || '0 9 * * *';
    form.elements.prompt.value = current?.prompt || '';
    form.elements.enabled.checked = current ? current.enabled : true;
    form.elements.dirId.replaceChildren(...data.directories.map(directory => {
      const option = node('option', directory.name);
      option.value = directory.id;
      option.selected = directory.id === (current?.dirId || directoryId || data.directories[0]?.id);
      return option;
    }));
    form.elements.cli.replaceChildren(...data.clis.map(cli => {
      const option = node('option', cli);
      option.value = cli;
      option.selected = cli === (current?.cli || 'claude');
      return option;
    }));
    form.elements.dirId.disabled = !!current?.taskId;
    form.elements.cli.disabled = !!current?.taskId;
    $('schedule-fixed-note').hidden = !current?.taskId;
    $('schedule-dialog-title').textContent = current ? '编辑定时规则' : '新建定时任务';
    $('schedule-save').textContent = current ? '保存规则' : '创建并绑定任务';
    $('schedule-error').textContent = '';
    $('schedule-dialog').showModal();
  }

  async function saveSchedule(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    const body = {
      name: form.elements.name.value.trim(),
      cron: form.elements.cron.value.trim(),
      prompt: form.elements.prompt.value.trim(),
      enabled: form.elements.enabled.checked,
    };
    if (!id) Object.assign(body, { dirId: form.elements.dirId.value, cli: form.elements.cli.value });
    $('schedule-save').disabled = true;
    $('schedule-error').textContent = '';
    try {
      await api('/api/cron' + (id ? `/${encodeURIComponent(id)}` : ''), body, id ? 'PATCH' : 'POST');
      $('schedule-dialog').close();
      await Promise.all([refreshSchedules(), refresh()]);
      notice(id ? '定时规则已更新；固定任务和历史保持不变。' : '定时任务已创建，并绑定到唯一的 Air 任务。');
    } catch (error) { $('schedule-error').textContent = error.message; }
    finally { $('schedule-save').disabled = false; }
  }

  async function runSchedule(id) {
    try {
      const result = await api(`/api/cron/${encodeURIComponent(id)}/run`, {});
      await Promise.all([refreshSchedules(), refresh()]);
      notice(result.decision === 'queued' ? '固定任务正在忙碌，本次执行已经排队。' : '执行指令已经送入固定 Air 任务。');
    } catch (error) { notice(`运行失败：${error.message}`); }
  }

  async function toggleSchedule(id, enabled) {
    try {
      await api(`/api/cron/${encodeURIComponent(id)}`, { enabled }, 'PATCH');
      await refreshSchedules();
    } catch (error) { notice(`更新失败：${error.message}`); }
  }

  async function deleteSchedule(id) {
    if (!window.confirm('删除这条定时规则？固定 Air 任务及其历史会继续保留。')) return;
    try {
      await api(`/api/cron/${encodeURIComponent(id)}`, undefined, 'DELETE');
      await refreshSchedules();
      notice('定时规则已删除；固定 Air 任务和历史没有删除。');
    } catch (error) { notice(`删除失败：${error.message}`); }
  }

  function visibleTasks() {
    const query = $('task-search').value.trim().toLowerCase();
    const filter = $('status-filter').value;
    return data.tasks.filter(task => {
      const inScope = mode === 'activity' ? task.resource?.lease !== 'idle' || task.resource?.capacityReason : task.dirId === directoryId;
      const matchesQuery = `${task.title || ''}`.toLowerCase().includes(query);
      const matchesStatus = filter === 'all' || (filter === 'archived' ? task.status === 'archived' : !['done', 'archived'].includes(task.status));
      return inScope && matchesQuery && matchesStatus;
    }).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function renderHeader(dir) {
    const selectedEntry = entry?.task?.id === taskId ? entry : null;
    const adminHeadings = {
      overview: ['MultiCC Air › 控制中心', '控制台', '目录、任务、自动运行和系统工具。'],
      planner: ['MultiCC Air › 工作管理', '任务看板', '按模块查看、筛选与规划全部任务。'],
      docs: ['MultiCC Air › 系统工具', '服务与文档', 'Agent 产物、本地页面和服务登记。'],
      memory: ['MultiCC Air › 系统工具', '记忆图谱', '项目记忆、会话记忆与文件编辑。'],
      settings: ['MultiCC Air › 系统设置', '设置中心', 'AI、连接、通知和资源配置。'],
      voice: ['MultiCC Air › 设置中心', '语音设置', '识别、转写与实时语音能力。'],
      goal: ['MultiCC Air › 设置中心', 'Goal 预检', '任务目标与自动分类规则。'],
      provider: ['MultiCC Air › 设置中心', 'CLI 与 Provider', '全局供应商、账号与线路管理。'],
      global: ['MultiCC Air › 设置中心', '全局配置', '语言、执行与通用偏好。'],
      push: ['MultiCC Air › 设置中心', '推送通知', 'Web Push 与备用提醒通道。'],
      tunnel: ['MultiCC Air › 设置中心', '外网穿透', 'Tailscale 与隧道服务状态。'],
      bridges: ['MultiCC Air › 设置中心', '消息桥接', '微信、飞书及其他消息入口。'],
      resources: ['MultiCC Air › 设置中心', 'Agent 资源', 'Skills 与历史资源管理。'],
      skillsync: ['MultiCC Air › 设置中心', '技能同步', '跨 CLI 的 Skills 同步状态。'],
      storage: ['MultiCC Air › 设置中心', '临时上传', '上传缓存、空间占用与清理。'],
    };
    $('library').classList.toggle('active', mode === 'library');
    $('overview').classList.toggle('active', mode === 'overview');
    $('activity').classList.toggle('active', mode === 'activity');
    $('schedules').classList.toggle('active', mode === 'schedules');
    document.querySelectorAll('[data-air-view]').forEach(button => button.classList.toggle('active', button.dataset.airView === mode));
    if (adminModes.has(mode)) {
      const heading = adminHeadings[mode] || ['MultiCC Air › 系统工具', mode, ''];
      $('task-breadcrumb').textContent = heading[0];
      $('task-title').textContent = heading[1];
      $('task-state').textContent = heading[2];
    } else if (mode === 'library') {
      $('task-breadcrumb').textContent = 'MultiCC Air';
      $('task-title').textContent = '工作目录';
      $('task-state').textContent = '目录组织项目，任务承接工作。';
    } else if (mode === 'activity' && !taskId) {
      $('task-breadcrumb').textContent = 'MultiCC Air';
      $('task-title').textContent = '跨目录活动';
      $('task-state').textContent = '只汇总正在执行、排队或等待资源的任务。';
    } else if (mode === 'schedules') {
      $('task-breadcrumb').textContent = 'MultiCC Air › 自动运行';
      $('task-title').textContent = '定时任务';
      $('task-state').textContent = '时间规则与固定任务分离；所有运行继续写入同一任务。';
    } else if (taskId) {
      $('task-breadcrumb').textContent = `目录库 › ${dir?.name || '工作目录'} › 任务`;
      $('task-title').textContent = selectedEntry?.task.title || '正在读取任务…';
      $('task-state').textContent = selectedEntry ? taskStateText(selectedEntry) : '正在读取本轮、任务与资源状态…';
    } else {
      $('task-breadcrumb').textContent = 'MultiCC Air › 工作目录';
      $('task-title').textContent = dir?.name || '先添加工作目录';
      $('task-state').textContent = dir?.path || '添加目录后即可创建任务。';
    }
    for (const id of ['quick-merge', 'quick-auto-commit', 'quick-share',
      'details-toggle', 'chat-more']) $(id).hidden = !taskId;
    $('task-state').disabled = !taskId;
    if (!taskId) { $('task-state').classList.remove('attention'); $('task-state').removeAttribute('title'); }
    renderComposerControls();
  }

  function render() {
    if (!data) return;
    if (!directoryId && taskId) directoryId = data.tasks.find(task => task.id === taskId)?.dirId;
    if (!directoryId || !data.directories.some(directory => directory.id === directoryId)) directoryId = data.directories[0]?.id || null;
    const dir = data.directories.find(directory => directory.id === directoryId);
    $('directory-name').textContent = dir?.name || '先添加工作目录';
    $('directory-path').textContent = dir?.path || '';
    $('create').disabled = !dir;
    $('favorite').disabled = !dir;
    $('favorite').textContent = favorites.includes(directoryId) ? '★' : '☆';
    $('favorites').replaceChildren(...data.directories.filter(directory => favorites.includes(directory.id)).slice(0, 5).map(directory => {
      const button = node('button', '▣ ' + directory.name, directory.id === directoryId && mode === 'tasks' ? 'selected' : '');
      button.onclick = () => navigate(directory.id);
      return button;
    }));
    renderHeader(dir);
    renderDirectories();
    renderDirectoryOverview();
    const adminMode = adminModes.has(mode);
    $('task-sidebar').hidden = adminMode;
    document.querySelector('.favorite-caption').hidden = adminMode;
    $('favorites').hidden = adminMode;
    $('directory-library').hidden = mode !== 'library';
    $('admin-center').hidden = !adminMode;
    $('schedule-center').hidden = mode !== 'schedules';
    $('task-layout').hidden = mode === 'library' || mode === 'schedules' || adminMode;
    if (adminMode) window.MultiCCAirAdmin?.render(mode, adminContext());

    const tasks = visibleTasks();
    $('task-list-title').textContent = mode === 'activity' ? '跨目录活动' : $('status-filter').selectedOptions[0]?.textContent || '任务';
    $('task-count').textContent = tasks.length;
    $('tasks').replaceChildren(...tasks.map(task => {
      const button = node('button', null, task.id === taskId ? 'selected' : '');
      const scope = mode === 'activity' ? `${directoryName(task.dirId)} · ` : '';
      const state = task.recordType === 'planned'
        ? `计划 · ${label(task.workflowStage || task.status)}` : label(task.status);
      button.append(node('strong', task.title), node('small', `${scope}${state} · ${resourceText(task.resource)}`));
      button.onclick = () => navigate(task.dirId, task.id);
      return button;
    }));
    if (!tasks.length) $('tasks').append(node('small', mode === 'activity' ? '当前没有跨目录活动。' : '这里还没有符合条件的任务。', 'empty-list'));
    $('legacy-sessions').replaceChildren(...data.sessions.filter(session => session.kind === 'terminal' && session.dirId === directoryId).map(session => {
      const link = node('a', `›_ ${session.label}`);
      link.href = `/?id=${encodeURIComponent(session.id)}`;
      return link;
    }));

    const hasTask = !!taskId;
    $('empty').hidden = hasTask;
    $('conversation').hidden = !hasTask;
    if (!hasTask) {
      $('conversation').removeAttribute('src');
      $('delivery-card').hidden = true;
      closeDetails();
    } else {
      // Task identity is resolved by chat-task-boot, but rendering stays on the
      // original full Chat page. Air only supplies a compact light theme.
      const target = `/chat.html?task=${encodeURIComponent(taskId)}&air=1`;
      if ($('conversation').getAttribute('src') !== target) $('conversation').src = target;
    }
  }

  function taskStateText(value) {
    const unstartedPlan = value.task?.recordType === 'planned' && !value.messages?.length
      && !value.execution?.busy && !value.execution?.pending;
    const execution = unstartedPlan ? '计划待执行'
      : label(value.execution?.pending ? 'waiting' : value.execution?.status || (value.execution?.busy ? 'running' : 'idle'));
    const lifecycle = label(value.task?.status || value.status);
    return [`本轮 ${execution}`, lifecycle && `任务 ${lifecycle}`].filter(Boolean).join(' · ');
  }

  function detailGroup(title, rows) {
    const section = node('section', null, 'detail-group');
    const heading = node('h3', title);
    const list = node('dl');
    for (const [key, value] of rows) list.append(node('dt', key), node('dd', value || '—'));
    section.append(heading, list);
    return section;
  }

  async function reconcileDelivery() {
    if (!taskId) return;
    const buttons = [...document.querySelectorAll('[data-action="reconcile"]')];
    buttons.forEach(button => { button.disabled = true; });
    try {
      await api(`/api/air/tasks/${encodeURIComponent(taskId)}/delivery/reconcile`, {});
      await refreshEntry();
      notice('合并记录已重新核验；任务归属仍以完整交付条件为准。');
    } catch (error) { notice(error.message); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }

  function actionButton(text, action, name) {
    const button = node('button', text);
    button.type = 'button';
    if (name) button.dataset.action = name;
    button.onclick = action;
    return button;
  }

  function renderDelivery(value) {
    const attribution = value.attribution || {};
    const candidate = attribution.candidate;
    const run = attribution.run;
    const integration = attribution.integration;
    const capacity = value.resource?.capacityReason;
    const pending = value.execution?.pending;
    const executionStatus = value.execution?.status || (value.execution?.busy ? 'running' : 'idle');
    const running = value.execution?.busy || ['starting', 'running', 'queued'].includes(executionStatus);
    const failed = ['error', 'failed', 'cancelled'].includes(executionStatus);
    const unstartedPlan = value.task?.recordType === 'planned' && !value.messages?.length && !run;
    const currentTitle = value.task.title;
    const targetTitle = candidate?.title || candidate?.taskName || '建议任务';
    const card = $('delivery-card');
    card.hidden = false;

    let eyebrow = 'MULTICC · 本轮状态';
    let title = '本轮状态已记录';
    let text = '任务保持当前归属，可以继续输入下一步。';
    let stage = 0;
    let currentStep = false;
    if (run?.outcome === 'succeeded' && !run.pendingInput) stage = 1;
    if (integration) stage = 2;
    if (integration?.baselineCurrent) stage = 3;

    if (capacity) {
      eyebrow = 'MULTICC · 执行资源';
      title = `${label(capacity)} · 现有工作现场正在保留`;
      text = '消息已绑定当前任务；资源可用后继续，不会停止其他服务或删除未交付修改。';
    } else if (pending) {
      eyebrow = 'MULTICC · 等待回答';
      title = '本轮需要你的回答';
      text = '回答仍提交给原任务与原请求，不会因为归属建议改变目标。';
    } else if (candidate?.state === 'stale') {
      eyebrow = 'MULTICC · 归属建议未应用';
      title = '本次归属建议已过期';
      text = '你已继续输入或切换视图，迟到的分类与合并事件不会改投已经接受的消息。';
    } else if (candidate && running) {
      eyebrow = 'MULTICC · 本轮执行中';
      title = '归属将在本轮交付后确认';
      text = `可能关联「${targetTitle}」，当前仍在「${currentTitle}」中执行。`;
      currentStep = true;
    } else if (candidate && (run?.outcome !== 'succeeded' || run?.pendingInput)) {
      eyebrow = 'MULTICC · 尚未满足归属条件';
      title = '本轮未成功或仍需回答';
      text = `建议目标仍是「${targetTitle}」，原问题继续绑定当前任务。`;
      currentStep = true;
    } else if (candidate && !integration) {
      eyebrow = 'MULTICC · 本轮成功，等待交付';
      title = `建议归入「${targetTitle}」`;
      text = '执行成功不等于任务完成或归属生效；相关代码按项目流程交付后再核验。';
      currentStep = true;
    } else if (candidate && !integration?.baselineCurrent) {
      eyebrow = 'MULTICC · 交付记录待核验';
      title = `建议归入「${targetTitle}」`;
      text = '已有合并记录，但基分支状态发生变化；重新核验前保持当前任务。';
      currentStep = true;
    } else if (candidate) {
      eyebrow = 'MULTICC · 交付已核验';
      title = `建议归入「${targetTitle}」· 等待源现场稳定`;
      text = '代码交付已核验；持续停写屏障与原子归属尚未完成，不提前转移工作区或消息。';
      currentStep = true;
    } else if (running) {
      eyebrow = 'MULTICC · 本轮执行中';
      title = '任务正在当前工作目录执行';
      text = '本轮结果、代码交付与任务完成会分别记录；执行期间下一条消息仍发送到当前任务。';
      currentStep = true;
    } else if (failed || (run && run.outcome !== 'succeeded')) {
      eyebrow = 'MULTICC · 本轮未成功';
      title = '任务保持进行中';
      text = '失败、取消或等待回答都不会被误写成任务完成，后续可以在当前任务重试或继续。';
    } else if (run) {
      eyebrow = 'MULTICC · 本轮结果';
      title = integration ? '本轮成功，交付记录已保存' : '本轮成功，任务仍保持当前归属';
      text = integration ? '代码交付与任务生命周期分别记录；完成一轮不会自动勾掉任务。' : '如果包含代码修改，仍需按项目流程完成交付。';
    } else {
      eyebrow = unstartedPlan ? 'MULTICC · 计划任务' : 'MULTICC · 等待下一步';
      title = unstartedPlan ? '计划尚未执行' : '任务已就绪';
      text = unstartedPlan
        ? '任务说明与验收标准已保存在计划卡中；发送第一条消息后才开始执行。'
        : '新消息将继续发送到当前任务；首次执行时才会准备所需工作目录。';
    }

    $('delivery-eyebrow').textContent = eyebrow;
    $('delivery-title').textContent = title;
    $('delivery-text').textContent = text;
    const summary = $('task-state');
    const attention = !!(capacity || pending || candidate || failed);
    summary.classList.toggle('attention', attention);
    summary.textContent = [taskStateText(value), capacity ? label(capacity) : candidate ? '归属待核验' : ''].filter(Boolean).join(' · ');
    summary.title = `${title}。${text} 点击查看详情。`;
    $('delivery-destination').textContent = `下一条消息仍发送到「${currentTitle}」`;
    const steps = [...$('delivery-steps').children];
    steps.forEach((step, index) => {
      step.classList.toggle('done', index < stage);
      step.classList.toggle('current', currentStep && index === stage);
    });
    const actions = [];
    if (integration) actions.unshift(actionButton('重新核验交付', reconcileDelivery, 'reconcile'));
    $('delivery-actions').replaceChildren(...actions);
  }

  function renderDetails(value) {
    const attribution = value.attribution || {};
    const roleText = value.roleBindings
      ? (value.roleBindings.bindings.map(binding => binding.name).join('、') || '无附加角色') + ` · 版本 ${value.roleBindings.version}`
      : value.configuration.rolePresetId || '本任务配置';
    const groups = [
      detailGroup('计划与任务生命周期', [
        ['任务 ID', value.task.id],
        ['任务类型', value.task.recordType === 'planned' ? '计划任务' : '执行任务'],
        ['工作阶段', value.task.recordType === 'planned' ? label(value.task.workflowStage) || '待处理' : '—'],
        ['任务状态', label(value.task.status || value.status)],
        ['访问方式', value.readOnly ? '只读；可显式 fork' : '可继续执行'],
      ]),
      detailGroup('代码与交付', [
        ['本轮结果', attribution.run ? `${label(attribution.run.outcome)}${attribution.run.pendingInput ? ' · 等待回答' : ''}` : '尚无已核验的本轮结果'],
        ['代码版本', attribution.run?.codeObserved ? '已观测最终版本' : '尚未核实'],
        ['交付状态', attribution.integration ? (attribution.integration.baselineCurrent ? '已合入基分支，版本有效' : '有合并记录，等待重新核验') : '尚无覆盖本轮代码的合并凭证'],
      ]),
      detailGroup('角色与上下文', [
        ['角色附件', roleText],
        ['生效边界', '修改只影响下一条新消息'],
        ['原生上下文', '角色变化时续接任务历史，不更换工作区'],
      ]),
      detailGroup('执行资源', [
        ['目录', value.resource.path || '首次执行时准备'],
        ['分支', value.resource.branch || '尚未创建'],
        ['资源状态', resourceText(value.resource)],
        ['运行来源', value.sessionId],
      ]),
    ];
    if (value.task.description || value.task.acceptanceCriteria) {
      const plan = node('div', null, 'detail-plan-copy');
      if (value.task.description) plan.append(node('strong', '任务说明'), node('p', value.task.description));
      if (value.task.acceptanceCriteria) plan.append(node('strong', '验收标准'), node('p', value.task.acceptanceCriteria));
      groups[0].append(plan);
    }
    const blockers = candidateBlockers(value);
    if (blockers.length) {
      const list = node('ul');
      blockers.forEach(reason => list.append(node('li', blockerNames[reason] || reason)));
      groups[1].append(list);
    }
    const actions = node('div', null, 'detail-actions');
    if (attribution.integration) actions.append(actionButton('重新核验合并记录', reconcileDelivery, 'reconcile'));
    if (value.roleBindings && !value.readOnly) {
      actions.append(actionButton('编辑角色上下文', () => window.MultiCCAirRoles.open({ taskId, roleBindings: value.roleBindings, api, onSaved: refreshEntry })));
    }
    if (actions.childElementCount) groups[groups.length - 1].append(actions);
    $('task-detail-groups').replaceChildren(...groups);
  }

  function candidateBlockers(value) {
    return value.attribution?.candidate ? value.attribution.candidate.blockers || value.attribution.blockers || [] : [];
  }

  // AI 配置 and 角色 render on the composer card inside the frame (see
  // chat-air.css). Their state, dialogs and handlers stay here in the host —
  // the frame only supplies the surface, so nothing about configuring a task
  // is duplicated in two pages. Frames reload per task, so the handler is
  // bound once per document and the labels are re-rendered on every sync.
  let frameComposerBound = null;
  // The strip is built here rather than in chat.html: it only exists while Air
  // hosts the page, and chat.html sits exactly on its migration line ceiling.
  function ensureComposerRow(doc) {
    const existing = doc.getElementById('air-composer-meta');
    if (existing) return existing;
    const input = doc.getElementById('input-bar');
    if (!input) return null;
    const row = doc.createElement('div');
    row.id = 'air-composer-meta';
    row.hidden = true;
    for (const id of ['air-ai-pill', 'air-role-pill']) {
      const pill = doc.createElement('button');
      pill.id = id;
      pill.type = 'button';
      pill.hidden = true;
      row.append(pill);
    }
    input.before(row);
    return row;
  }

  function composerControls() {
    const doc = $('conversation').contentDocument;
    if (!doc) return null;
    const row = ensureComposerRow(doc);
    const ai = doc.getElementById('air-ai-pill');
    const role = doc.getElementById('air-role-pill');
    if (!row || !ai || !role) return null;
    return { doc, row, ai, role };
  }

  function renderComposerControls() {
    const controls = composerControls();
    if (!controls) return;
    const { row, ai, role } = controls;
    row.hidden = !taskId;
    if (!taskId) {
      ai.hidden = true;
      role.hidden = true;
      return;
    }
    const pending = entry?.configuration?.pendingConfiguration;
    const shown = pending
      ? { ...entry.configuration, ...(pending.profile || {}), cli: pending.cli || entry.configuration.cli }
      : entry?.configuration;
    const routeName = shown?.providerSelection?.mode === 'auto'
      ? `Auto ${shown.providerSelection.protocol}`
      : (pending ? shown.provider : shown.providerName || shown.provider) || '默认线路';
    ai.hidden = !entry?.sessionId;
    ai.disabled = !entry || entry.readOnly;
    ai.textContent = shown
      ? [shown.cli, routeName,
        (pending ? shown.model : shown.effectiveModel || shown.model) || '默认模型',
        pending ? '下轮生效' : ''].filter(Boolean).join(' · ')
      : '';
    ai.title = '任务 AI 配置：CLI、路由与模型（下一轮生效）';
    const roleCount = entry?.roleBindings?.bindings?.length || 0;
    role.hidden = !entry?.roleBindings;
    role.disabled = !entry || entry.readOnly;
    role.textContent = roleCount ? `${roleCount} 个角色` : '＋ 角色';
    role.title = '任务角色上下文';
  }

  function bindComposerControls() {
    const controls = composerControls();
    if (!controls || frameComposerBound === controls.doc) return;
    frameComposerBound = controls.doc;
    controls.ai.onclick = () => {
      if (entry?.sessionId && !entry.readOnly) window.MultiCCAirSettings.configuration(entry, data.clis, refreshEntry);
    };
    controls.role.onclick = () => {
      if (entry?.roleBindings && !entry.readOnly) {
        window.MultiCCAirRoles.open({ taskId, roleBindings: entry.roleBindings, api, onSaved: refreshEntry });
      }
    };
  }

  // Draft restore + listener binding happen once per input element. syncFrame
  // also runs from the 4s poll loop; re-running it there restored a stale
  // draft into the freshly cleared input right after a send (the composer's
  // programmatic clear fires no input event, so the stored draft survived).
  let frameInputSynced = null;
  let frameInputSyncedTask = null;
  let frameInputHandler = null;
  function syncFrame() {
    const doc = $('conversation').contentDocument;
    bindComposerControls();
    renderComposerControls();
    syncQuickActions();
    const input = doc?.getElementById('input') || doc?.getElementById('message');
    if (!taskId || !input) return;
    // Rebind on element change (frame reload) AND on task change: right after
    // a task switch the old document can still be live for a poll tick, and
    // binding the new task's draft listener to that stale input would write
    // keystrokes to the wrong task's draft key. The handler reads `taskId`
    // live, so re-binding first detaches the previous one to avoid stacking.
    if (frameInputSynced !== input || frameInputSyncedTask !== taskId) {
      if (frameInputSynced && frameInputHandler) frameInputSynced.removeEventListener('input', frameInputHandler);
      frameInputSynced = input;
      frameInputSyncedTask = taskId;
      const draft = sessionStorage.getItem(`air:draft:${taskId}`);
      if (draft != null && !input.value) input.value = draft;
      frameInputHandler = () => sessionStorage.setItem(`air:draft:${taskId}`, input.value);
      input.addEventListener('input', frameInputHandler, { passive: true });
    }
    if (entry?.task?.title) {
      const unstartedPlan = entry.task.recordType === 'planned' && !entry.messages?.length;
      input.placeholder = unstartedPlan
        ? `补充或开始执行「${entry.task.title}」…`
        : `继续描述「${entry.task.title}」的下一步…`;
    }
  }

  async function refreshEntry() {
    const selected = taskId;
    if (!selected) return;
    try {
      const result = await api(`/api/air/tasks/${encodeURIComponent(selected)}`);
      if (taskId !== selected) return;
      entry = result;
      $('task-title').textContent = entry.task.title;
      $('task-state').textContent = taskStateText(entry);
      renderDelivery(entry);
      renderDetails(entry);
      syncFrame();
    } catch (error) {
      if (taskId === selected) notice(error.message);
    }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      data = await api('/api/air');
      notice(data.migration?.errors?.length ? `有 ${data.migration.errors.length} 份历史任务等待核验；原记录与工作区均已保留。` : '');
      render();
      await refreshEntry();
      if (mode === 'schedules' || mode === 'overview') await refreshSchedules();
      if (mode === 'overview') window.MultiCCAirAdmin?.render(mode, adminContext());
    } catch (error) { notice(error.message); }
    finally { loading = false; }
  }

  function adminContext() {
    return { data, scheduleTasks, api, setMode, navigate, notice, directoryName };
  }

  window.MultiCCAirAdmin?.bindServiceDialog(adminContext());
  $('library').onclick = () => setMode('library');
  $('overview').onclick = () => setMode('overview');
  $('activity').onclick = () => setMode('activity');
  $('schedules').onclick = () => setMode('schedules');
  document.querySelectorAll('[data-air-view]').forEach(button => { button.onclick = () => setMode(button.dataset.airView); });
  $('directory-search').oninput = renderDirectories;
  $('task-search').oninput = render;
  $('status-filter').onchange = render;
  $('refresh').onclick = async () => {
    await refresh();
    if (adminModes.has(mode)) await window.MultiCCAirAdmin?.refresh(adminContext());
    try { await $('conversation').contentWindow?.MultiCCTaskBoardEntry?.refresh?.(); }
    catch (error) { notice(error.message); }
  };
  $('favorite').onclick = () => {
    if (!directoryId) return;
    if (favorites.includes(directoryId)) favorites = favorites.filter(id => id !== directoryId);
    else if (favorites.length < 5) favorites.push(directoryId);
    else return notice('侧栏最多收藏 5 个目录，其余目录仍可从目录库搜索。');
    localStorage.setItem('air:favorites', JSON.stringify(favorites));
    render();
  };
  $('mobile-nav').onclick = toggleNav;
  $('nav-scrim').onclick = closeNav;
  $('add-directory').onclick = () => window.MultiCCAirSettings.directory(async directory => { await refresh(); navigate(directory.id); });
  $('directory-open-planner').onclick = () => setMode('planner');
  $('quick-task-form').onsubmit = submitQuickTask;
  $('quick-task-attach').onclick = () => $('quick-task-file-input').click();
  $('quick-task-file-input').onchange = event => void uploadQuickTaskFiles(event.target.files);
  $('quick-task-input').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('quick-task-form').requestSubmit();
    }
  };
  // The task header keeps the two or three actions that get used every round.
  // Each one clicks the chat page's own button, so its handler, its permission
  // check and its dialog stay in the frame; only the state readout (auto-commit
  // on/off, merge ready) is mirrored back onto the header icon.
  let quickSyncTimer = null;
  function frameButton(id) {
    return $('conversation').contentDocument?.getElementById(id) || null;
  }
  function syncQuickActions() {
    const source = frameButton('auto-commit-btn');
    const auto = $('quick-auto-commit');
    const on = source?.dataset.state === 'on';
    auto.classList.toggle('is-on', on);
    auto.setAttribute('aria-pressed', String(on));
    const merge = frameButton('merge-btn');
    const ready = merge?.classList.contains('merge-ready') === true;
    const mergeAction = $('quick-merge');
    mergeAction.classList.toggle('is-ready', ready);
    if (merge?.title) mergeAction.title = merge.title;
  }
  function clickFrameAction(sourceId) {
    frameButton(sourceId)?.click();
    // The toggle PATCHes and the merge check re-reads status asynchronously;
    // re-mirror shortly after so the icon does not lag the state by a poll.
    clearTimeout(quickSyncTimer);
    quickSyncTimer = setTimeout(syncQuickActions, 600);
  }
  $('quick-merge').onclick = () => clickFrameAction('merge-btn');
  $('quick-auto-commit').onclick = () => clickFrameAction('auto-commit-btn');
  $('quick-share').onclick = () => clickFrameAction('share-btn');
  $('details-toggle').onclick = () => toggleDetails();
  // The conversation frame's chat page owns the More menu (items, handlers,
  // popover layer). The task-header trigger just reaches into that same-origin
  // frame to open/close it; the menu anchors itself to the frame's top-right,
  // visually dropping from this header.
  function frameMoreController() {
    return $('conversation').contentWindow?.__multiccAirHeaderMore || null;
  }
  $('chat-more').onclick = event => {
    event.stopPropagation();
    const controller = frameMoreController();
    if (!controller) return;
    const wasOpen = controller.isOpen?.() === true;
    if (wasOpen) controller.close();
    else controller.open();
    $('chat-more').setAttribute('aria-expanded', String(!wasOpen));
  };
  document.addEventListener('click', event => {
    if (event.target.closest('#chat-more')) return;
    const controller = frameMoreController();
    if (controller?.close) controller.close();
    $('chat-more').setAttribute('aria-expanded', 'false');
  });
  $('task-state').onclick = () => toggleDetails();
  $('details-close').onclick = closeDetails;
  $('schedule-create').onclick = () => openScheduleDialog();
  $('schedule-close').onclick = () => $('schedule-dialog').close();
  $('schedule-cancel').onclick = () => $('schedule-dialog').close();
  $('schedule-form').onsubmit = saveSchedule;
  $('schedule-presets').onclick = event => {
    const preset = event.target.closest('[data-cron]');
    if (preset) $('schedule-form').elements.cron.value = preset.dataset.cron;
  };
  $('create').onclick = () => {
    if (!data || !directoryId) return;
    $('create-directory').textContent = data.directories.find(directory => directory.id === directoryId)?.path || '';
    $('cli').replaceChildren(...data.clis.map(cli => {
      const option = node('option', cli);
      option.value = cli;
      return option;
    }));
    $('new-task-dialog').showModal();
  };
  $('close-dialog').onclick = () => $('new-task-dialog').close();
  $('new-task-form').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    if (!values.model) delete values.model;
    if (!values.rolePrompt) delete values.rolePrompt;
    const fingerprint = JSON.stringify([directoryId, values]);
    if (!createAttempt || createAttempt.fingerprint !== fingerprint) createAttempt = { fingerprint, clientMsgId: crypto.randomUUID() };
    $('create-submit').disabled = true;
    $('create-error').textContent = '';
    try {
      const result = await api('/api/air/tasks', { dirId: directoryId, ...values, clientMsgId: createAttempt.clientMsgId });
      createAttempt = null;
      $('new-task-dialog').close();
      event.target.reset();
      await refresh();
      navigate(directoryId, result.taskId);
    } catch (error) { $('create-error').textContent = error.message; }
    finally { $('create-submit').disabled = false; }
  };
  $('conversation').onload = syncFrame;
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      setMode('library');
    }
    if (event.key === 'Escape') { closeNav(); closeDetails(); frameMoreController()?.close(); $('chat-more').setAttribute('aria-expanded', 'false'); }
  });
  window.addEventListener('popstate', () => {
    saveDraft();
    const params = new URLSearchParams(location.search);
    taskId = params.get('task');
    directoryId = params.get('dir');
    mode = modeFrom(params);
    entry = null;
    closeDetails();
    render();
    void refreshEntry();
    if (mode === 'schedules' || mode === 'overview') void refreshSchedules().then(render);
  });
  window.addEventListener('pagehide', () => { saveDraft(); stopped = true; epoch++; clearTimeout(timer); });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { stopped = false; epoch++; void poll(); }
  });

  async function poll(currentEpoch = epoch) {
    if (stopped || currentEpoch !== epoch) return;
    if (!document.hidden || !data) await refresh();
    if (!stopped && currentEpoch === epoch) timer = setTimeout(() => poll(currentEpoch), 4000);
  }
  void poll();
})();
