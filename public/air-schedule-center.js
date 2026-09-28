'use strict';

// ── 定时任务中心（public/air-schedule-center.js）───────────────────────────────
// 「这台机器上排了哪些活」那整块：规则列表、唯一那张新建/编辑表单、以及运行/暂停/
// 重绑/删除四个动作。原先长在 air.js 里（renderSchedules 那一族），air.js 顶在
// scripts/check-source-line-budget.js 的行数天花板上，那条登记的注释自己写着「下一次
// 动定时中心应把 renderSchedules 整块抽成独立模块」—— 脚本任务类型这一轮就是那次拆分。
//
// 两种规则（服务端 plugins/cron/cron-tasks.js 的 kind 字段）：
//   · agent（默认）：建一个固定 Air 任务，每次触发把 prompt 投给它，跑的是大模型；
//   · script：不建任务、不经过任何模型，直接在工作目录里跑一条本地命令（通常是
//     python 脚本），退出码与输出末尾进执行记录。像「盯任务板、出错就往微信发一条」
//     这种纯粹的轮询脚本，没必要为此养一个常驻大模型会话。
// 表单里两者的格子是同一批（见 air.html #schedule-kind 那几个 id）：切换类型只切
// 可见性与 required —— 隐藏的必填格会让浏览器静默拒绝提交（invalid form control
// 不可聚焦），所以 required 必须跟着一起摘。
//
// 这里只画 DOM、只发请求，不认识 air.js 内部：拿得到的东西（t / MultiCCApi /
// getLocale）直接读全局，air.js 私有的四个（notice / navigate / refresh / 目录快照）
// 由 air.js 在 bind() 时递进来 —— 同 air-dir-schedules.js 的分工。
(function initAirScheduleCenter(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const client = root.MultiCCApi;
  const $ = id => document.getElementById(id);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const errorText = error => (client && typeof client.errorText === 'function'
    ? client.errorText(error)
    : (error && error.message) || String(error));
  const request = (path, options) => client.json(path, options);

  let ctx = {};
  let rules = [];
  let loading = false;

  const notice = text => { if (typeof ctx.notice === 'function') ctx.notice(text); };
  const refreshPage = () => (typeof ctx.refresh === 'function' ? ctx.refresh() : undefined);
  const directories = () => (typeof ctx.directories === 'function' ? ctx.directories() : []);
  const clis = () => (typeof ctx.clis === 'function' ? ctx.clis() : []);
  const locale = () => (typeof root.getLocale === 'function' ? root.getLocale() : undefined);
  const laneLabel = (cli, route) => (typeof ctx.laneRouteLabel === 'function' ? ctx.laneRouteLabel(cli, route) : cli);
  const cliChoices = () => (typeof ctx.clis === 'function' ? ctx.clis() : []);
  const cliInChat = cli => (typeof ctx.cliOffersInChat === 'function' ? ctx.cliOffersInChat(cli) : true);
  const firstChatCli = () => (typeof ctx.firstChatCli === 'function' ? ctx.firstChatCli() : 'claude-exp');
  const cliOptionLabel = cli => (typeof ctx.cliOptionLabel === 'function' ? ctx.cliOptionLabel(cli) : cli);

  const isScript = task => task.kind === 'script';

  function scheduleTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat(locale(), {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  }

  function scheduleRuntime(task) {
    const lane = task.cli ? laneLabel(task.cli, task.provider) : '';
    return [lane, task.model, task.effort].filter(Boolean).join(' · ') || t('airScheduleFollowTask');
  }

  function scheduleAction(text, action, className = '') {
    const button = node('button', text, className);
    button.type = 'button';
    button.onclick = action;
    return button;
  }

  // ── 卡片 ────────────────────────────────────────────────────────────────────
  function scriptPanel(task) {
    const panel = node('div', null, 'schedule-script');
    const head = node('div', null, 'schedule-script-head');
    head.append(node('span', '⌘', 'schedule-task-mark'), node('small', t('airScheduleScriptPanelNote')));
    panel.append(head, node('code', task.command || '', 'schedule-script-command'));
    if (task.lastExitCode !== null && task.lastExitCode !== undefined) {
      panel.append(node('small', t('airScheduleScriptExit', { code: task.lastExitCode }),
        task.lastExitCode === 0 ? 'schedule-script-exit' : 'schedule-script-exit error'));
    }
    return panel;
  }

  function runHistory(task) {
    const runs = Array.isArray(task.recentRuns) ? task.recentRuns : [];
    const history = node('details', null, 'schedule-runs');
    const head = node('summary');
    head.append(node('span', t('airScheduleRuns')),
      node('span', String(task.runCount || runs.length), 'schedule-runs-badge'));
    history.append(head);
    if (!runs.length) {
      history.append(node('p', t('airScheduleRunsEmpty'), 'schedule-runs-empty'));
      return history;
    }
    const list = node('ul', null, 'schedule-runs-list');
    for (const run of runs) {
      const item = node('li', null, `schedule-run ${run.status === 'error' ? 'error' : ''}`);
      const outcome = run.status === 'queued' ? t('airScheduleQueued')
        : run.status === 'ok' ? t('airScheduleLastAccepted')
          : (run.error || t('airScheduleLastFailed'));
      item.append(node('time', scheduleTime(run.at)),
        node('span', run.reason === 'manual' ? t('airScheduleRunsManual') : t('airScheduleRunsScheduled'), 'schedule-run-source'),
        node('span', outcome, 'schedule-run-status'));
      // 脚本那一次到底印了什么 —— 只看「失败」两个字没法判断是脚本报错还是环境
      // 不对，所以把服务端裁好的输出末尾附在这一次下面。
      if (run.output) item.append(node('code', run.output, 'schedule-run-output'));
      list.append(item);
    }
    history.append(list, node('small', t('airScheduleRunsHint', { n: runs.length }), 'schedule-runs-hint'));
    return history;
  }

  function card(task) {
    const script = isScript(task);
    const article = node('article', null, `schedule-card ${script ? 'script' : ''}`.trim());
    const head = node('header', null, 'schedule-card-head');
    const title = node('div');
    title.append(node('span', script ? 'SCRIPT' : 'SCHEDULE', 'eyebrow'), node('h3', task.name));
    head.append(title, node('span', task.enabled ? t('airScheduleEnabled') : t('airScheduleDisabled'), `schedule-badge ${task.enabled ? 'enabled' : ''}`));

    const timing = node('div', null, 'schedule-timing');
    const next = node('div');
    next.append(node('small', t('airScheduleNextRun')), node('strong', task.enabled ? scheduleTime(task.nextRunAt) : t('airSchedulePaused')));
    const previous = node('div');
    previous.append(node('small', t('airScheduleLastFired')), node('strong', task.lastRunAt ? scheduleTime(task.lastRunAt) : t('airScheduleNeverRan')));
    timing.append(node('code', task.cron), next, previous);

    const middle = script ? scriptPanel(task) : node('button', null, `schedule-fixed-task ${task.taskBindingError || !task.taskId ? 'broken' : ''}`);
    if (!script) {
      middle.type = 'button';
      middle.disabled = !task.taskId;
      const fixedCopy = node('span');
      fixedCopy.append(node('small', t('airScheduleFixedTask')), node('strong', task.taskTitle || task.name),
        node('small', task.taskBindingError || (task.taskId ? `${task.taskId} · ${scheduleRuntime(task)}` : t('airScheduleBinding'))));
      middle.append(node('span', task.taskBindingError ? '!' : '↗', 'schedule-task-mark'), fixedCopy);
      if (task.taskId) middle.onclick = () => ctx.navigate?.(task.dirId, task.taskId);
    }

    const state = node('div', null, `schedule-state ${task.lastStatus === 'error' ? 'error' : ''}`);
    const stateLabel = task.lastStatus === 'queued' ? t('airScheduleQueued')
      : task.lastStatus === 'ok' ? t('airScheduleLastAccepted')
        : task.lastStatus === 'error' ? (task.lastError || t('airScheduleLastFailed')) : t('airScheduleAwaitingFirstRun');
    state.append(node('span', stateLabel), node('small', t('airScheduleFiredCount', { dir: task.dirName, n: task.runCount || 0 })));

    const actions = node('footer', null, 'schedule-actions');
    // A rule whose fixed task was archived stops executing until a new fixed
    // task is bound; that repair is explicit, never automatic.
    const rebind = !script && task.taskBindingError
      ? scheduleAction(t('airScheduleRebind'), () => rebindRule(task.id), 'primary subtle')
      : null;
    actions.append(
      scheduleAction(t('airScheduleRunNow'), () => runRule(task.id), 'primary subtle'),
      ...(rebind ? [rebind] : []),
      scheduleAction(task.enabled ? t('airSchedulePause') : t('airScheduleEnable'), () => toggleRule(task.id, !task.enabled)),
      scheduleAction(t('airScheduleEdit'), () => open(task.id)),
      node('span'),
      scheduleAction(t('airScheduleDelete'), () => remove(task.id), 'danger'),
    );
    // 固定任务那一格与 prompt 都只对 agent 有意义；脚本那一行换成命令 + 上次退出码。
    article.append(head, timing, middle, state, runHistory(task),
      script ? node('code', task.command || '', 'schedule-prompt schedule-script-line')
        : node('p', task.prompt, 'schedule-prompt'), actions);
    return article;
  }

  function render() {
    const list = $('schedule-list');
    if (!list) return;
    const enabled = rules.filter(task => task.enabled).length;
    const errors = rules.filter(task => task.lastStatus === 'error' || task.taskBindingError).length;
    $('schedule-summary').replaceChildren(
      node('span', t('airScheduleRuleCount', { n: rules.length })),
      node('span', t('airScheduleEnabledCount', { n: enabled })),
      node('span', errors ? t('airScheduleErrorCount', { n: errors }) : t('airScheduleAllHealthy'), errors ? 'warning' : 'healthy'),
    );
    list.replaceChildren();
    if (!rules.length) {
      const empty = node('div', null, 'schedule-empty');
      empty.append(node('strong', t('airScheduleNoneYet')), node('p', t('airScheduleNoneHint')));
      list.append(empty);
      return;
    }
    for (const task of rules) list.append(card(task));
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const value = await request('/api/cron');
      rules = Array.isArray(value) ? value : [];
      render();
    } catch (error) {
      if (ctx.mode && ctx.mode() === 'schedules') notice(t('airScheduleLoadFailed', { msg: errorText(error) }));
    } finally { loading = false; }
  }

  // ── 表单 ────────────────────────────────────────────────────────────────────
  // 切换规则类型：可见性 + required 一起切（隐藏的必填格会让提交静默失败）。
  function applyKind(kind, current) {
    const form = $('schedule-form');
    if (!form) return;
    const script = kind === 'script';
    const bound = !!current?.taskId;
    const fields = {
      agent: $('schedule-agent-intro'), script: $('schedule-script-intro'),
      cli: $('schedule-cli-field'), prompt: $('schedule-prompt-field'), command: $('schedule-command-field'),
    };
    if (fields.agent) fields.agent.hidden = script;
    if (fields.script) fields.script.hidden = !script;
    if (fields.cli) fields.cli.hidden = script;
    if (fields.prompt) fields.prompt.hidden = script;
    if (fields.command) fields.command.hidden = !script;
    form.elements.cli.required = !script;
    form.elements.prompt.required = !script;
    form.elements.command.required = script;
    // 已绑定固定任务的规则不能改目录与 CLI（它们属于那个任务）。
    form.elements.dirId.disabled = bound;
    form.elements.cli.disabled = script || bound;
  }

  function open(id = null) {
    const current = id ? rules.find(task => task.id === id) : null;
    const form = $('schedule-form');
    if (!form) return;
    form.reset();
    form.elements.id.value = current?.id || '';
    form.elements.name.value = current?.name || '';
    form.elements.cron.value = current?.cron || '0 9 * * *';
    form.elements.prompt.value = current?.prompt || '';
    form.elements.command.value = current?.command || '';
    form.elements.enabled.checked = current ? current.enabled : true;
    const dirs = directories();
    form.elements.dirId.replaceChildren(...dirs.map(directory => {
      const option = node('option', directory.name);
      option.value = directory.id;
      option.selected = directory.id === (current?.dirId || ctx.directoryId?.() || dirs[0]?.id);
      return option;
    }));
    // 定时任务跑的是 chat 线路：一次性车道（`claude -p` / `codex exec`）不在这里。
    // 已绑定某条线路的任务例外 —— 编辑它时得能看见自己在用哪条。
    form.elements.cli.replaceChildren(...cliChoices().filter(cli => cli === current?.cli || cliInChat(cli)).map(cli => {
      const option = node('option', cliOptionLabel(cli));
      option.value = cli;
      option.selected = cli === (current?.cli || firstChatCli());
      return option;
    }));
    form.elements.kind.value = current?.kind === 'script' ? 'script' : 'agent';
    applyKind(form.elements.kind.value, current);
    $('schedule-fixed-note').hidden = !current?.taskId;
    $('schedule-dialog-title').textContent = current ? t('airScheduleEditTitle') : t('airNewScheduledTask');
    $('schedule-save').textContent = current ? t('airScheduleSaveRule')
      : (form.elements.kind.value === 'script' ? t('airScheduleCreateScript') : t('airScheduleCreateAndBind'));
    $('schedule-error').textContent = '';
    $('schedule-dialog').showModal();
  }

  async function save(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    const script = form.elements.kind.value === 'script';
    const body = {
      name: form.elements.name.value.trim(),
      cron: form.elements.cron.value.trim(),
      enabled: form.elements.enabled.checked,
      kind: script ? 'script' : 'agent',
    };
    if (script) body.command = form.elements.command.value.trim();
    else body.prompt = form.elements.prompt.value.trim();
    // 目录与 CLI 只在新建时发给服务端；改规则时 PATCH 不看它们（都属于固定任务）。
    if (!id) {
      body.dirId = form.elements.dirId.value;
      if (!script) body.cli = form.elements.cli.value;
    }
    $('schedule-save').disabled = true;
    $('schedule-error').textContent = '';
    try {
      await request('/api/cron' + (id ? `/${encodeURIComponent(id)}` : ''), {
        method: id ? 'PATCH' : 'POST', json: body,
      });
      $('schedule-dialog').close();
      await Promise.all([load(), refreshPage()]);
      notice(id ? t('airScheduleRuleUpdated') : t('airScheduleCreated'));
    } catch (error) { $('schedule-error').textContent = errorText(error); }
    finally { $('schedule-save').disabled = false; }
  }

  // ── 动作 ────────────────────────────────────────────────────────────────────
  async function runRule(id) {
    try {
      const result = await request(`/api/cron/${encodeURIComponent(id)}/run`, { method: 'POST' });
      await Promise.all([load(), refreshPage()]);
      // 脚本没有「入队/已投递」这回事：它当场跑完，说的是退出码。失败时服务端的
      // error 已经把「脚本退出码 N」和输出末尾拼好了，别在这儿再套一层。
      if (result.exitCode !== null && result.exitCode !== undefined) {
        notice(result.exitCode === 0
          ? t('airScheduleScriptRan')
          : (result.error || t('airScheduleScriptRunFailed', { code: result.exitCode })));
      } else notice(result.decision === 'queued' ? t('airScheduleBusyQueued') : t('airScheduleSentToTask'));
    } catch (error) { notice(t('airScheduleRunFailed', { msg: errorText(error) })); }
  }

  async function rebindRule(id) {
    if (!root.confirm(t('airScheduleRebindConfirm'))) return;
    try {
      const result = await request(`/api/cron/${encodeURIComponent(id)}/rebind`, { method: 'POST' });
      await Promise.all([load(), refreshPage()]);
      notice(t('airScheduleRebound', { id: result.taskId }));
    } catch (error) {
      notice(error?.code === 'binding_healthy' ? t('airScheduleBindingHealthy') : t('airScheduleRebindFailed', { msg: errorText(error) }));
    }
  }

  async function toggleRule(id, enabled) {
    try {
      await request(`/api/cron/${encodeURIComponent(id)}`, { method: 'PATCH', json: { enabled } });
      await load();
    } catch (error) { notice(t('airScheduleUpdateFailed', { msg: errorText(error) })); }
  }

  async function remove(id) {
    if (!root.confirm(t('airScheduleDeleteConfirm'))) return;
    try {
      await request(`/api/cron/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
      notice(t('airScheduleDeleted'));
    } catch (error) { notice(t('airScheduleDeleteFailed', { msg: errorText(error) })); }
  }

  function bind(context) {
    ctx = context || {};
    const create = $('schedule-create');
    if (create) create.onclick = () => open();
    $('schedule-close').onclick = () => $('schedule-dialog').close();
    $('schedule-cancel').onclick = () => $('schedule-dialog').close();
    $('schedule-form').onsubmit = save;
    $('schedule-kind').onchange = event => {
      applyKind(event.target.value, rules.find(task => task.id === $('schedule-form').elements.id.value) || null);
      $('schedule-save').textContent = $('schedule-form').elements.id.value
        ? t('airScheduleSaveRule')
        : (event.target.value === 'script' ? t('airScheduleCreateScript') : t('airScheduleCreateAndBind'));
    };
    $('schedule-presets').onclick = event => {
      const preset = event.target.closest('[data-cron]');
      if (preset) $('schedule-form').elements.cron.value = preset.dataset.cron;
    };
  }

  root.MultiCCAirSchedules = Object.freeze({
    bind,
    refresh: load,
    open,
    tasks: () => rules,
  });
})(typeof window !== 'undefined' ? window : null);
