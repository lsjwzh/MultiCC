'use strict';

// ── 目录首页「本目录定时任务」入口（public/air-dir-schedules.js）────────────────
// 侧栏那颗「定时任务」是**全局**中心：它回答「这台机器上排了哪些活」。目录首页要
// 回答的是另一个问题 —— 「我正看着的**这个**目录排了哪些活」。两者不是两份数据，
// 是同一条规则的两种视角：这一层只按地址栏里的 ?dir= 过滤 GET /api/cron，服务端
// 一个字节都不用改（dirId / dirName 早就在返回里了）。
//
// 入口摆在「备忘」「本目录产物」后面（目录工具条最右那颗），点开是**页内弹层**
// （<dialog>），不是新页面 —— 它只是把这一列规则摊开看一眼、顺手点点，看完就收。
// 手机上这层弹层从底部升起来（见 air.css 里那段 @media）。
//
// 为什么不自己再写一遍表单：规则的新建 / 编辑全在 air.js 那个唯一的编辑器
// （#schedule-dialog）里。这一层因此只点一下 #schedule-create 把那个表单叫出来，
// 再把字段填成这一条的值 —— air.js 保存时看表单里那个隐藏 id：有 id 就 PATCH，
// 没有才 POST。于是「编辑一条规则」在整个产品里仍然只有一个表单实现，改字段不用
// 两处同步。卡片的样式同理，全部复用 .schedule-*（air.js 的 renderSchedules 那一族），
// 这个模块只画 DOM，不新增一套外观。
//
// 它同样不改 air.js 一个字节 —— air.js 卡在 scripts/check-source-line-budget.js
// 登记的行数天花板上，一行也加不了。可见性与「备忘」「本目录产物」一致：air.js 每次
// 渲染都会写 #directory-memo.hidden，盯住这个属性就够了，不轮询（同 air-artifacts.js）。
(function initAirDirectorySchedules(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const client = root.MultiCCApi;
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const errorText = error => (client && typeof client.errorText === 'function'
    ? client.errorText(error)
    : (error && error.message) || String(error));

  const dirIdOf = () => new URLSearchParams(root.location.search).get('dir');
  const dirNameOf = () => document.getElementById('directory-name')?.textContent
    || t('airDirectoryFallback');

  // 时间与状态那句话都跟 air.js 的 scheduleTime / 状态分支一一对应；air.js 是 IIFE，
  // 这份小东西只能照着写一遍（两处都只认「服务端折好的那一列取值」，不自己编故事）。
  const stamp = value => (value
    ? new Intl.DateTimeFormat(
      typeof root.getLocale === 'function' ? root.getLocale() : undefined,
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false },
    ).format(new Date(value))
    : '—');

  function stateLabel(task) {
    if (task.lastStatus === 'queued') return t('airScheduleQueued');
    if (task.lastStatus === 'ok') return t('airScheduleLastAccepted');
    if (task.lastStatus === 'error') return task.lastError || t('airScheduleLastFailed');
    return t('airScheduleAwaitingFirstRun');
  }

  // 车道名同样走共享 CLI 目录：规则里存的 `claude` 在屏幕上叫「Claude」（Claude
  // Agent SDK 那条常驻车道）—— air.js 的 scheduleRuntime 读的也是这份表。目录不在
  // 时回落到 id 本身，不编一个别的产品名（未知 id 显示成 Claude 是旧代码的坑）。
  const laneName = cli => {
    const catalog = root.MultiCCProviderCatalog;
    return (catalog && typeof catalog.cliDisplayName === 'function' ? catalog.cliDisplayName(cli) : '') || cli;
  };
  const runtimeOf = task => [task.cli ? laneName(task.cli) : '', task.model, task.effort].filter(Boolean).join(' · ')
    || t('airScheduleFollowTask');

  let toggle = null;
  let shell = null;

  // ── 弹层骨架：一次建好，之后只换里面的列表 ──────────────────────────────────
  function ensureShell() {
    if (shell) return shell;
    const dialog = node('dialog', null, 'dir-schedule-dialog');
    dialog.id = 'dir-schedule-dialog';

    const head = node('header', null, 'dir-schedule-head');
    const heading = node('div');
    const title = node('h2', null, '');
    heading.append(node('span', 'SCHEDULED TASKS', 'eyebrow'), title);
    const close = node('button', '×', null);
    close.type = 'button';
    close.id = 'dir-schedule-close';
    close.setAttribute('aria-label', t('airDlgClose'));
    close.setAttribute('data-i18n-aria-label', 'airDlgClose');
    close.onclick = () => dialog.close();
    head.append(heading, close);

    const summary = node('p', null, 'dir-schedule-summary');
    summary.id = 'dir-schedule-summary';
    const status = node('p', null, 'dir-schedule-status');
    status.id = 'dir-schedule-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const list = node('div', null, 'dir-schedule-list');
    list.id = 'dir-schedule-list';
    list.setAttribute('aria-live', 'polite');

    const foot = node('footer', null, 'dir-schedule-foot');
    const create = node('button', t('airNewScheduledTask'), 'primary');
    create.type = 'button';
    create.id = 'dir-schedule-create';
    create.setAttribute('data-i18n', 'airNewScheduledTask');
    create.onclick = () => openEditor(null);
    const center = node('button', t('airDirSchedulesOpenCenter'), null);
    center.type = 'button';
    center.id = 'dir-schedule-center';
    center.setAttribute('data-i18n', 'airDirSchedulesOpenCenter');
    center.onclick = openCenter;
    foot.append(create, center);

    dialog.append(head, summary, status, list, foot);
    // 点遮罩（也就是点 dialog 自己）收起：里面每一层都占满宽度，点不到它。
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
    shell = { dialog, title, summary, status, list };
    return shell;
  }

  function close() {
    if (shell && shell.dialog.open) shell.dialog.close();
  }

  function setStatus(text, tone = '') {
    if (!shell) return;
    shell.status.textContent = text || '';
    shell.status.className = `dir-schedule-status ${tone}`.trim();
  }

  // ── 一条规则 ────────────────────────────────────────────────────────────────
  function action(text, handler, className = '') {
    const button = node('button', text, className);
    button.type = 'button';
    button.onclick = handler;
    return button;
  }

  function runHistory(task) {
    const runs = Array.isArray(task.recentRuns) ? task.recentRuns : [];
    const details = node('details', null, 'schedule-runs');
    const head = node('summary');
    head.append(node('span', t('airScheduleRuns')), node('span', String(task.runCount || runs.length), 'schedule-runs-badge'));
    details.append(head);
    if (!runs.length) {
      details.append(node('p', t('airScheduleRunsEmpty'), 'schedule-runs-empty'));
      return details;
    }
    const list = node('ul', null, 'schedule-runs-list');
    for (const run of runs) {
      const item = node('li', null, `schedule-run ${run.status === 'error' ? 'error' : ''}`);
      const outcome = run.status === 'queued' ? t('airScheduleQueued')
        : run.status === 'ok' ? t('airScheduleLastAccepted')
          : (run.error || t('airScheduleLastFailed'));
      item.append(node('time', stamp(run.at)),
        node('span', run.reason === 'manual' ? t('airScheduleRunsManual') : t('airScheduleRunsScheduled'), 'schedule-run-source'),
        node('span', outcome, 'schedule-run-status'));
      list.append(item);
    }
    details.append(list, node('small', t('airScheduleRunsHint', { n: runs.length }), 'schedule-runs-hint'));
    return details;
  }

  function card(task) {
    const broken = !!task.taskBindingError || !task.taskId;
    const article = node('article', null, 'schedule-card');
    const head = node('header', null, 'schedule-card-head');
    const title = node('div');
    title.append(node('span', 'SCHEDULE', 'eyebrow'), node('h3', task.name));
    head.append(title, node('span', task.enabled ? t('airScheduleEnabled') : t('airScheduleDisabled'),
      `schedule-badge ${task.enabled ? 'enabled' : ''}`));

    const timing = node('div', null, 'schedule-timing');
    const next = node('div');
    next.append(node('small', t('airScheduleNextRun')),
      node('strong', task.enabled ? stamp(task.nextRunAt) : t('airSchedulePaused')));
    const previous = node('div');
    previous.append(node('small', t('airScheduleLastFired')),
      node('strong', task.lastRunAt ? stamp(task.lastRunAt) : t('airScheduleNeverRan')));
    timing.append(node('code', task.cron), next, previous);

    const fixed = node('button', null, `schedule-fixed-task ${broken ? 'broken' : ''}`);
    fixed.type = 'button';
    fixed.disabled = !task.taskId;
    const copy = node('span');
    copy.append(node('small', t('airScheduleFixedTask')), node('strong', task.taskTitle || task.name),
      node('small', task.taskBindingError
        || (task.taskId ? `${task.taskId} · ${runtimeOf(task)}` : t('airScheduleBinding'))));
    fixed.append(node('span', task.taskBindingError ? '!' : '↗', 'schedule-task-mark'), copy);
    if (task.taskId) fixed.onclick = () => openTask(task.dirId, task.taskId);

    const state = node('div', null, `schedule-state ${task.lastStatus === 'error' ? 'error' : ''}`);
    state.append(node('span', stateLabel(task)),
      node('small', t('airScheduleFiredCount', { dir: task.dirName, n: task.runCount || 0 })));

    const actions = node('footer', null, 'schedule-actions');
    // 绑定坏掉的规则到点也不会有人接，修复是明说的一件事（同 air.js：只有坏了才给这颗）。
    actions.append(
      action(t('airScheduleRunNow'), () => doRun(task), 'primary subtle'),
      ...(task.taskBindingError ? [action(t('airScheduleRebind'), () => doRebind(task), 'primary subtle')] : []),
      action(task.enabled ? t('airSchedulePause') : t('airScheduleEnable'), () => doToggle(task)),
      action(t('airScheduleEdit'), () => openEditor(task)),
      node('span'),
      action(t('airScheduleDelete'), () => doDelete(task), 'danger'),
    );
    article.append(head, timing, fixed, state, runHistory(task), node('p', task.prompt, 'schedule-prompt'), actions);
    return article;
  }

  function render(rules) {
    const enabled = rules.filter(task => task.enabled).length;
    const issues = rules.filter(task => task.lastStatus === 'error' || task.taskBindingError).length;
    const health = issues
      ? node('span', t('airScheduleErrorCount', { n: issues }), 'warning')
      : node('span', t('airScheduleAllHealthy'), 'healthy');
    shell.summary.replaceChildren(
      node('span', t('airScheduleRuleCount', { n: rules.length })),
      node('span', t('airScheduleEnabledCount', { n: enabled })),
      health,
    );
    shell.list.replaceChildren();
    if (!rules.length) {
      const empty = node('div', null, 'schedule-empty');
      empty.append(node('strong', t('airDirSchedulesEmpty')), node('p', t('airScheduleNoneHint')));
      shell.list.append(empty);
      return;
    }
    for (const task of rules) shell.list.append(card(task));
  }

  // ── 取数与动作 ──────────────────────────────────────────────────────────────
  // 返回值是「这一趟读成功没有」：动作要拿它决定那句话说不说 —— 刷新结尾会把状态
  // 行清空，先说就会被自己刷掉，而读失败时更不该拿一句成功话盖掉错误。
  let loading = false;
  async function load() {
    if (loading || !shell) return false;
    const dirId = dirIdOf();
    if (!dirId) return false;
    loading = true;
    setStatus(t('loading'), 'pending');
    try {
      const all = await client.json('/api/cron');
      if (!shell.dialog.open) return false;
      render((Array.isArray(all) ? all : []).filter(rule => (rule.dirId || '') === dirId));
      setStatus('');
      return true;
    } catch (error) {
      if (!shell.dialog.open) return false;
      setStatus(t('airScheduleLoadFailed', { msg: errorText(error) }), 'error');
      return false;
    } finally { loading = false; }
  }

  async function doRun(task) {
    setStatus('');
    try {
      const result = await client.json(`/api/cron/${encodeURIComponent(task.id)}/run`, { method: 'POST' });
      if (await load()) {
        setStatus(result.decision === 'queued' ? t('airScheduleBusyQueued') : t('airScheduleSentToTask'), 'ok');
      }
    } catch (error) { setStatus(t('airScheduleRunFailed', { msg: errorText(error) }), 'error'); }
  }

  async function doRebind(task) {
    if (!root.confirm(t('airScheduleRebindConfirm'))) return;
    setStatus('');
    try {
      const result = await client.json(`/api/cron/${encodeURIComponent(task.id)}/rebind`, { method: 'POST' });
      if (await load()) setStatus(t('airScheduleRebound', { id: result.taskId }), 'ok');
    } catch (error) {
      setStatus(error && error.code === 'binding_healthy'
        ? t('airScheduleBindingHealthy')
        : t('airScheduleRebindFailed', { msg: errorText(error) }), 'error');
    }
  }

  async function doToggle(task) {
    setStatus('');
    try {
      await client.json(`/api/cron/${encodeURIComponent(task.id)}`, { method: 'PATCH', json: { enabled: !task.enabled } });
      await load();
    } catch (error) { setStatus(t('airScheduleUpdateFailed', { msg: errorText(error) }), 'error'); }
  }

  async function doDelete(task) {
    if (!root.confirm(t('airScheduleDeleteConfirm'))) return;
    setStatus('');
    try {
      await client.json(`/api/cron/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      if (await load()) setStatus(t('airScheduleDeleted'), 'ok');
    } catch (error) { setStatus(t('airScheduleDeleteFailed', { msg: errorText(error) }), 'error'); }
  }

  // 新建 / 编辑都走 air.js 那个唯一的编辑器：先把它叫出来（新建态），编辑再多填几格。
  function openEditor(task) {
    const trigger = document.getElementById('schedule-create');
    const form = document.getElementById('schedule-form');
    const editor = document.getElementById('schedule-dialog');
    if (!trigger || !form || !editor) return;
    trigger.click();
    // air.js 的 openScheduleDialog 在快照还没到手时直接 return —— 那就什么都没发生，
    // 这里也就不该往下填字段（填一个没打开的弹窗只会让人以为点了没反应）。
    if (!editor.open) return;
    if (!task) return;
    form.elements.id.value = task.id;
    form.elements.name.value = task.name;
    form.elements.cron.value = task.cron;
    form.elements.prompt.value = task.prompt;
    form.elements.enabled.checked = task.enabled;
    // 目录与 CLI 只在新建（没有 id）时才发给服务端，改规则时 PATCH 不看它们；但格子
    // 里仍要摆这条规则自己的值，不然显示的是「当前目录 + 第一条 chat 线路」，会误导。
    // CLI 可能压根不在选项里（一次性车道不进 chat 列表），那就保持原样。
    select(form.elements.dirId, task.dirId);
    select(form.elements.cli, task.cli);
    form.elements.dirId.disabled = !!task.taskId;
    form.elements.cli.disabled = !!task.taskId;
    const note = document.getElementById('schedule-fixed-note');
    if (note) note.hidden = !task.taskId;
    const title = document.getElementById('schedule-dialog-title');
    if (title) title.textContent = t('airScheduleEditTitle');
    const save = document.getElementById('schedule-save');
    if (save) save.textContent = t('airScheduleSaveRule');
  }

  function select(element, value) {
    if (!element || !value) return;
    if ([...element.options].some(option => option.value === value)) element.value = value;
  }

  /** 进那条固定 Air 任务。air.js 的 navigate() 是 IIFE 内部的，叫不到；但它的
   *  popstate 处理函数就是「从地址栏重读一遍再渲染」，所以写同样的地址再派一次
   *  popstate，落点与它内部那条路完全一致（不必整页重载：目录页的任务行就是这么
   *  切换的，重载反而会白屏一下）。 */
  function openTask(dirId, taskId) {
    close();
    const params = new URLSearchParams(root.location.search);
    params.set('dir', dirId);
    params.set('task', taskId);
    params.delete('view');
    const url = `/air?${params}`;
    if (typeof root.PopStateEvent !== 'function') { root.location.assign(url); return; }
    root.history.pushState({}, '', url);
    root.dispatchEvent(new root.PopStateEvent('popstate'));
  }

  /** 「全部定时任务」：切到侧栏那颗「定时任务」的那个视图（setMode('schedules')，
   *  地址里保留 ?dir=）。点它等于点那一行，不复刻它的逻辑。 */
  function openCenter() {
    const entry = document.getElementById('schedules');
    if (!entry) return;
    close();
    entry.click();
  }

  function open() {
    if (!dirIdOf()) return;
    ensureShell();
    shell.title.textContent = t('airDirSchedulesTitle', { dir: dirNameOf() });
    setStatus('');
    shell.dialog.showModal();
    void load();
  }

  // ── 工具条那颗入口 ──────────────────────────────────────────────────────────
  function mount() {
    const memo = document.getElementById('directory-memo');
    if (!memo || !memo.parentElement || document.getElementById('directory-schedules')) return;
    toggle = node('button', null, null);
    toggle.type = 'button';
    toggle.id = 'directory-schedules';
    toggle.setAttribute('data-i18n-title', 'airDirSchedulesOpen');
    toggle.setAttribute('data-i18n-aria-label', 'airDirSchedulesOpen');
    toggle.title = t('airDirSchedulesOpen');
    toggle.setAttribute('aria-label', t('airDirSchedulesOpen'));
    const glyph = node('span', '⏰');
    glyph.setAttribute('aria-hidden', 'true');
    // data-i18n 挂在内层标签上，不挂按钮：applyI18n() 给带 data-i18n 的元素写
    // textContent，挂在按钮上会把前面的图标一起冲掉（同 air-artifacts.js）。
    const label = node('span', t('airScheduledTasks'));
    label.setAttribute('data-i18n', 'airScheduledTasks');
    toggle.append(glyph, document.createTextNode(' '), label);
    toggle.onclick = open;
    // 插在「本目录产物」后面（工具条最右那颗）。产物那个模块先加载，正常都在；
    // 万一不在（它没挂上），就挨着「备忘」—— 总之不能丢了这颗入口。
    (document.getElementById('directory-artifacts') || memo).after(toggle);

    const observer = new root.MutationObserver(() => {
      if (!toggle) return;
      const memoNow = document.getElementById('directory-memo');
      toggle.hidden = !memoNow || memoNow.hidden;
      // 入口藏起来就等于「这一页现在没有目录」：弹层留在屏幕上会比它背后的入口还长寿。
      if (toggle.hidden) close();
    });
    observer.observe(memo, { attributes: true, attributeFilter: ['hidden'] });
    toggle.hidden = memo.hidden;

    // air.js 那个编辑器关掉之后把这张表重画一遍：新建出来的、改过的规则都在这时候
    // 才落地。保存那条路 air.js 自己会刷新它的中心，这一层有自己的取数，各刷各的。
    const editor = document.getElementById('schedule-dialog');
    if (editor) {
      editor.addEventListener('close', () => {
        if (shell && shell.dialog.open) void load();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})(typeof window !== 'undefined' ? window : null);
