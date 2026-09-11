'use strict';

(function initAirAdmin(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const legacyPanels = {
    planner: ['任务看板', '按模块查看、筛选与规划全部任务', 'PLANNER'],
    memory: ['记忆图谱', '项目记忆、会话记忆与文件编辑', 'MEMORY'],
    voice: ['语音设置', '识别、转写与实时语音能力', 'VOICE'],
    goal: ['Goal 预检', '任务目标与自动分类规则', 'GOAL'],
    provider: ['Provider 配置', '全局供应商、账号与线路管理', 'PROVIDERS'],
    global: ['全局配置', '语言、执行与通用偏好', 'SETTINGS'],
    push: ['推送通知', 'Web Push 与备用提醒通道', 'NOTIFICATIONS'],
    tunnel: ['外网穿透', 'Tailscale 与隧道服务状态', 'NETWORK'],
    bridges: ['消息桥接', '微信、飞书及其他消息入口', 'BRIDGES'],
    resources: ['Agent 资源', 'Skills 与历史资源管理', 'RESOURCES'],
    skillsync: ['技能同步', '跨 CLI 的 Skills 同步状态', 'SKILLS'],
    storage: ['临时上传', '上传缓存、空间占用与清理', 'STORAGE'],
  };
  const settingGroups = [
    ['AI 与执行', ['provider', 'goal', 'voice', 'global']],
    ['连接与通知', ['push', 'tunnel', 'bridges']],
    ['资源与存储', ['resources', 'skillsync', 'storage']],
  ];
  let activeMode = null;
  let currentContext = null;

  function action(text, handler, className = '') {
    const button = make('button', text, className);
    button.type = 'button';
    button.onclick = handler;
    return button;
  }

  function setHeading(eyebrow, title, description, actions = []) {
    el('admin-eyebrow').textContent = eyebrow;
    el('admin-title').textContent = title;
    el('admin-description').textContent = description;
    el('admin-actions').replaceChildren(...actions);
  }

  function taskState(task) {
    const resource = task.resource || {};
    if (resource.capacityReason) return '等待资源';
    if (resource.lease && resource.lease !== 'idle') return resource.lease === 'uncertain' ? '等待核实' : '执行中';
    if (task.status === 'done') return '已完成';
    if (task.status === 'archived') return '已归档';
    return task.recordType === 'planned' ? '尚未执行' : '进行中';
  }

  function statCard(label, value, detail, tone, onClick) {
    const card = make(onClick ? 'button' : 'article', null, `admin-stat ${tone || ''}`);
    if (onClick) { card.type = 'button'; card.onclick = onClick; }
    card.append(make('span', label), make('strong', String(value)), make('small', detail));
    return card;
  }

  function renderOverview(context) {
    const { data, scheduleTasks, setMode, navigate } = context;
    const tasks = data?.tasks || [];
    const directories = data?.directories || [];
    const active = tasks.filter(task => task.status !== 'done' && task.status !== 'archived');
    const executing = active.filter(task => {
      const lease = task.resource?.lease;
      return ['reserved', 'materializing', 'starting', 'running', 'uncertain'].includes(lease);
    });
    const waiting = active.filter(task => task.resource?.capacityReason || task.status === 'waiting');
    const enabledSchedules = (scheduleTasks || []).filter(task => task.enabled);
    setHeading('MULTICC AIR · CONTROL', '控制台', '目录、任务、自动运行和系统工具汇总在同一个 Air 入口。', [
      action('浏览工作目录', () => setMode('library')),
      action('＋ 新建任务', () => { setMode('tasks'); setTimeout(() => el('create')?.click(), 0); }, 'primary'),
    ]);

    const content = el('admin-content');
    const stats = make('div', null, 'admin-stats');
    stats.append(
      statCard('工作目录', directories.length, '统一目录库', 'blue', () => setMode('library')),
      statCard('进行中任务', active.length, `${executing.length} 个正在执行或核实`, 'green', () => setMode('tasks')),
      statCard('等待处理', waiting.length, waiting.length ? '等待回答或执行资源' : '当前没有资源阻塞', waiting.length ? 'amber' : ''),
      statCard('定时任务', enabledSchedules.length, `共 ${(scheduleTasks || []).length} 条规则`, 'purple', () => setMode('schedules')),
    );

    const split = make('div', null, 'admin-overview-grid');
    const recent = make('section', null, 'admin-panel');
    const recentHead = make('div', null, 'admin-panel-head');
    recentHead.append(make('div', null));
    recentHead.firstChild.append(make('span', 'RECENT TASKS', 'eyebrow'), make('h3', '最近任务'));
    recentHead.append(action('查看全部', () => setMode('tasks')));
    const recentList = make('div', null, 'admin-recent-list');
    const rows = [...tasks].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 7);
    for (const task of rows) {
      const row = action('', () => navigate(task.dirId, task.id), 'admin-recent-row');
      const copy = make('span');
      copy.append(make('strong', task.title || '未命名任务'), make('small', `${context.directoryName(task.dirId)} · ${taskState(task)}`));
      row.append(make('span', '›', 'admin-row-mark'), copy, make('time', task.updatedAt ? new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''));
      recentList.append(row);
    }
    if (!rows.length) recentList.append(make('p', '还没有任务记录。', 'admin-empty'));
    recent.append(recentHead, recentList);

    const workspacePanel = make('section', null, 'admin-panel admin-directory-panel');
    const workspaceHead = make('div', null, 'admin-panel-head');
    workspaceHead.append(make('div'));
    workspaceHead.firstChild.append(make('span', 'WORK DIRECTORIES', 'eyebrow'), make('h3', '工作目录'));
    workspaceHead.append(action('目录库与搜索', () => setMode('library')));
    const workspaceList = make('div', null, 'admin-directory-list');
    for (const directory of directories) {
      const directoryTasks = tasks.filter(task => task.dirId === directory.id);
      const unfinished = directoryTasks.filter(task => !['done', 'archived'].includes(task.status));
      const executingCount = unfinished.filter(task => ['reserved', 'materializing', 'starting', 'running', 'uncertain']
        .includes(task.resource?.lease)).length;
      const row = action('', () => navigate(directory.id), 'admin-directory-row');
      const copy = make('span');
      copy.append(make('strong', directory.name || directory.id), make('small', directory.path || ''));
      const counts = make('span', null, 'admin-directory-counts');
      counts.append(make('b', `${unfinished.length} 进行中`), make('small', executingCount ? `${executingCount} 执行中` : `${directoryTasks.length} 个任务`));
      row.append(make('span', '▣', 'admin-directory-mark'), copy, counts, make('span', '›', 'admin-directory-arrow'));
      workspaceList.append(row);
    }
    if (!directories.length) workspaceList.append(make('p', '还没有工作目录。', 'admin-empty'));
    workspacePanel.append(workspaceHead, workspaceList);

    const tools = make('section', null, 'admin-panel');
    const toolHead = make('div', null, 'admin-panel-head');
    toolHead.append(make('div'));
    toolHead.firstChild.append(make('span', 'SYSTEM TOOLS', 'eyebrow'), make('h3', '服务与设置'));
    const toolGrid = make('div', null, 'admin-tool-grid');
    const shortcuts = [
      ['docs', '▤', '服务与文档', '本地服务、网页和文件'],
      ['memory', '◇', '记忆图谱', '项目与会话记忆'],
      ['settings', '⚙', '设置中心', 'Provider、通知与连接'],
      ['schedules', '◴', '自动运行', '固定任务定时规则'],
    ];
    for (const [mode, icon, title, detail] of shortcuts) {
      const button = action('', () => setMode(mode), 'admin-tool-card');
      button.append(make('span', icon, 'admin-tool-icon'), make('strong', title), make('small', detail));
      toolGrid.append(button);
    }
    tools.append(toolHead, toolGrid);
    split.append(recent, tools);
    content.replaceChildren(stats, workspacePanel, split);
  }

  function isLoopback(hostname) {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname || '').toLowerCase());
  }

  function serviceUrl(raw) {
    const value = String(raw || '');
    if (isLoopback(location.hostname)) return value;
    try {
      const url = new URL(value, location.href);
      if (isLoopback(url.hostname)) url.hostname = location.hostname;
      return url.toString();
    } catch (_) { return value; }
  }

  async function serviceAction(entry, actionName) {
    try {
      await currentContext.api(`/api/docs-registry/${encodeURIComponent(entry.id)}/${actionName}`, {}, 'POST');
      currentContext.notice(actionName === 'start' ? '服务启动指令已发送。' : '服务停止指令已发送。');
      await loadDocs();
    } catch (error) { currentContext.notice(error.message); }
  }

  async function togglePin(entry) {
    try {
      await currentContext.api(`/api/docs-registry/${encodeURIComponent(entry.id)}`, { pinned: !entry.pinned }, 'PATCH');
      await loadDocs();
    } catch (error) { currentContext.notice(error.message); }
  }

  async function removeEntry(entry) {
    if (!confirm(`删除“${entry.title}”的登记记录？`)) return;
    try {
      await currentContext.api(`/api/docs-registry/${encodeURIComponent(entry.id)}`, undefined, 'DELETE');
      currentContext.notice('登记记录已删除。');
      await loadDocs();
    } catch (error) { currentContext.notice(error.message); }
  }

  function renderDocEntry(entry) {
    const card = make('article', null, `air-doc-card ${entry.expired ? 'expired' : ''}`);
    const icon = make('span', entry.kind === 'service' ? '◎' : entry.kind === 'file' ? '⌑' : '▤', 'air-doc-icon');
    const copy = make('div', null, 'air-doc-copy');
    const titleRow = make('div', null, 'air-doc-title');
    const link = make('a', entry.title || entry.url || '未命名');
    link.href = serviceUrl(entry.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    titleRow.append(link);
    if (entry.pinned) titleRow.append(make('span', '置顶', 'air-doc-tag pin'));
    if (entry.expired) titleRow.append(make('span', '已过期', 'air-doc-tag expired'));
    const status = entry.kind === 'service' ? `${entry.status === 'up' ? '运行中' : entry.status === 'starting' ? '启动中' : entry.status === 'down' ? '已停止' : '状态未知'} · ` : '';
    copy.append(titleRow, make('small', `${status}${entry.url || ''}`), make('small', [entry.source, entry.sessionId, entry.createdAt ? new Date(entry.createdAt).toLocaleString('zh-CN') : ''].filter(Boolean).join(' · ')));
    const actions = make('div', null, 'air-doc-actions');
    if (entry.kind === 'service') {
      const log = make('a', '日志');
      log.href = `/api/docs-registry/${encodeURIComponent(entry.id)}/log`;
      log.target = '_blank'; log.rel = 'noopener noreferrer';
      actions.append(log);
      if (entry.status === 'up' || entry.status === 'starting') actions.append(action('停止', () => serviceAction(entry, 'stop'), 'danger'));
      else {
        const start = action(entry.startCmd ? '启动' : '无启动命令', () => serviceAction(entry, 'start'), 'subtle');
        start.disabled = !entry.startCmd;
        actions.append(start);
      }
    }
    actions.append(action(entry.pinned ? '取消置顶' : '置顶', () => togglePin(entry), 'subtle'), action('删除', () => removeEntry(entry), 'danger'));
    card.append(icon, copy, actions);
    return card;
  }

  async function loadDocs() {
    const list = el('air-doc-list');
    if (!list) return;
    list.replaceChildren(make('p', '正在读取服务与文档…', 'admin-empty'));
    try {
      const entries = await currentContext.api('/api/docs-registry');
      const summary = el('air-doc-summary');
      if (summary) {
        const services = entries.filter(entry => entry.kind === 'service');
        summary.textContent = `${entries.length} 条登记 · ${services.filter(entry => entry.status === 'up').length}/${services.length} 个服务运行中`;
      }
      list.replaceChildren(...entries.map(renderDocEntry));
      if (!entries.length) list.append(make('p', '还没有登记服务或文档。', 'admin-empty'));
    } catch (error) {
      list.replaceChildren(make('p', `读取失败：${error.message}`, 'admin-empty error'));
    }
  }

  function renderDocs(context) {
    setHeading('MULTICC AIR · REGISTRY', '服务与文档', '集中管理 Agent 产物、本地页面和可启动服务。', [
      action('↻ 刷新', () => loadDocs()),
      action('＋ 登记服务', () => el('service-dialog').showModal(), 'primary'),
    ]);
    const wrap = make('div', null, 'air-docs');
    const top = make('div', null, 'air-docs-meta');
    top.append(make('span', '服务状态按登记信息实时读取；临时产物到期后会明确标记。'), make('strong', '正在读取…'));
    top.lastChild.id = 'air-doc-summary';
    const list = make('div', null, 'air-doc-list');
    list.id = 'air-doc-list';
    wrap.append(top, list);
    el('admin-content').replaceChildren(wrap);
    void loadDocs();
  }

  function renderSettings(context) {
    setHeading('MULTICC AIR · SETTINGS', '设置中心', '旧管理页的能力已经收进 Air 导航，接下来按模块逐页替换内部界面。');
    const content = el('admin-content');
    const groups = make('div', null, 'air-settings-groups');
    for (const [title, modes] of settingGroups) {
      const section = make('section', null, 'admin-panel air-settings-group');
      section.append(make('h3', title));
      const grid = make('div', null, 'air-settings-grid');
      for (const mode of modes) {
        const [name, description, eyebrow] = legacyPanels[mode];
        const card = action('', () => context.setMode(mode), 'air-setting-card');
        card.append(make('span', eyebrow, 'eyebrow'), make('strong', name), make('small', description), make('em', '进入设置  ›'));
        grid.append(card);
      }
      section.append(grid);
      groups.append(section);
    }
    content.replaceChildren(groups);
  }

  function renderLegacy(mode, context) {
    const [title, description, eyebrow] = legacyPanels[mode] || [mode, '兼容管理功能', 'TOOLS'];
    const legacyView = mode === 'planner' ? 'tasks' : mode;
    const homeMode = ['planner', 'memory'].includes(mode) ? 'overview' : 'settings';
    setHeading(`MULTICC AIR · ${eyebrow}`, title, description, [
      action(homeMode === 'overview' ? '返回控制台' : '返回设置中心', () => context.setMode(homeMode)),
      action('在独立页打开', () => window.open(`/manage.html?view=${encodeURIComponent(legacyView)}`, '_blank', 'noopener')),
    ]);
    const note = make('div', null, 'air-migration-note');
    note.append(make('strong', 'Air 迁移中'), make('span', '当前功能已经纳入 Air 外壳；内部表单暂用兼容实现，数据与操作能力保持不变。'));
    const frame = make('iframe', null, 'air-legacy-frame');
    frame.title = title;
    frame.src = `/manage.html?view=${encodeURIComponent(legacyView)}&embed=air`;
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads');
    el('admin-content').replaceChildren(note, frame);
  }

  function renderProvider(context) {
    const provider = root.MultiCCAirProvider;
    if (!provider) return renderLegacy('provider', context);
    setHeading('MULTICC AIR · PROVIDERS', 'CLI 与 Provider', '管理全局默认线路、协议、模型目录与 API 连接。', [
      action('返回设置中心', () => context.setMode('settings')),
      action('高级账号与借道', () => provider.toggleAdvanced()),
      action('↻ 刷新', () => provider.refresh()),
      action('＋ 新增 Provider', () => provider.openEditor(), 'primary'),
    ]);
    provider.render(context);
  }

  function render(mode, context, force = false) {
    currentContext = context;
    if (mode === 'overview') {
      activeMode = mode;
      renderOverview(context);
      return;
    }
    if (!force && activeMode === mode) return;
    activeMode = mode;
    if (mode === 'docs') return renderDocs(context);
    if (mode === 'settings') return renderSettings(context);
    if (mode === 'provider') return renderProvider(context);
    renderLegacy(mode, context);
  }

  function bindServiceDialog(context) {
    const form = el('service-form');
    if (!form || form.__airBound) return;
    form.__airBound = true;
    el('service-close').onclick = () => el('service-dialog').close();
    el('service-cancel').onclick = () => el('service-dialog').close();
    form.onsubmit = async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const body = { kind: 'service', title: values.title.trim(), url: values.url.trim(), source: 'user' };
      if (values.startCmd.trim()) body.startCmd = values.startCmd.trim();
      if (values.cwd.trim()) body.cwd = values.cwd.trim();
      el('service-save').disabled = true;
      el('service-error').textContent = '';
      try {
        await context.api('/api/docs-registry', body, 'POST');
        form.reset();
        el('service-dialog').close();
        context.notice('服务已登记。');
        await loadDocs();
      } catch (error) { el('service-error').textContent = error.message; }
      finally { el('service-save').disabled = false; }
    };
  }

  root.MultiCCAirAdmin = Object.freeze({
    modes: new Set(['overview', 'docs', 'memory', 'settings', ...Object.keys(legacyPanels)]),
    render,
    refresh: context => render(activeMode || 'overview', context, true),
    bindServiceDialog,
  });
})(typeof window !== 'undefined' ? window : null);
