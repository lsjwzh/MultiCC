'use strict';

// Air 的「用量统计」。
//
// 这一块原先只存在于 /manage.html 的「Provider → 统计 / 用量」子页，Air 的
// Provider 页把它整个漏在了默认折叠的「高级连接」iframe 里 —— 打开 Provider 页
// 看不到任何 token 统计。这里把它原生搬回来，而且一条不减：
//
//   ① 全部 CLI 用量（Claude + Codex · 按模型）：直接读 ~/.claude/projects 与
//      ~/.codex/sessions 的会话转录，覆盖**本机全部** CLI 用量（含你在终端里
//      直接跑的、与 multicc 无关的）。今天 / 本周 / 本月 / 全部 × 新鲜 / 含缓存，
//      按模型明细 + 合计 + 近 14 个有活动的日子的趋势。
//   ② 省主模型 Token：子任务（Task/Agent/Workflow）替主模型跑掉的那部分，从
//      持久账本 token_by_role.json 读。今天 / 本周 / 本月 / 全部。
//
// 口径与旧页逐字一致。同一个数字在两处讲成两个说法，比少了这块更糟。
(function initAirUsage(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const catalogApi = root.MultiCCProviderCatalog;

  const WINDOWS = [
    ['today', t('airUsageToday')],
    ['week', t('airUsageWeek')],
    ['month', t('airUsageMonth')],
    ['all', t('airUsageAll')],
  ];
  const METRICS = [
    ['fresh', t('airUsageMetricFresh')],
    ['inclusive', t('airUsageMetricInclusive')],
  ];
  // Claude 官方模型在旧页里挑出来标琥珀色，这里沿用同一个判定，免得两边对不上。
  const OFFICIAL_MODEL = /claude|opus|haiku|sonnet|fable/i;

  let context = null;
  let globalUsage = null;
  let roleLedger = null;
  let globalError = '';
  let roleError = '';
  // 面板每次打开都会重建 DOM，所以选中的窗口与口径挂在模块上：翻回去看同一个
  // 时段不该要重挑一次（air-provider 的 activeProtocol 也是这个道理）。
  let activeWindow = 'month';
  let activeMetric = 'fresh';

  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, handler, className = '') => {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  };
  const tokens = value => (catalogApi && typeof catalogApi.formatCompactTokens === 'function'
    ? catalogApi.formatCompactTokens(Number(value) || 0)
    : String(Number(value) || 0));

  const bucketTotal = bucket => (bucket.inputTokens || 0) + (bucket.outputTokens || 0)
    + (bucket.cacheWrite || 0) + (bucket.cacheRead || 0);

  // 明细按**当前口径**降序。旧页排的是 `row.total`，而 total 跟着口径走 —— 切到
  // 新鲜口径时，缓存读得多的模型未必还排前面。写死按含缓存排会让两边的行序不一致，
  // 同一个窗口在两处看着像两份数据。
  const rowTotal = item => (activeMetric === 'inclusive'
    ? item.input + item.output + item.cacheWrite + item.cacheRead
    : item.input + item.output);

  function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // ── ① 全部 CLI 用量 ────────────────────────────────────────────────────

  function windowTabs() {
    const row = make('div', null, 'air-usage-tabs');
    for (const [value, label] of WINDOWS) {
      const tab = button(label, () => { activeWindow = value; renderGlobal(); }, 'air-usage-tab');
      tab.dataset.window = value;
      tab.classList.toggle('active', value === activeWindow);
      row.append(tab);
    }
    return row;
  }

  function metricTabs() {
    const row = make('div', null, 'air-usage-tabs');
    row.append(make('span', t('airUsageMetricLabel'), 'air-usage-tabs-label'));
    for (const [value, label] of METRICS) {
      const tab = button(label, () => { activeMetric = value; renderGlobal(); }, 'air-usage-tab');
      tab.dataset.metric = value;
      tab.classList.toggle('active', value === activeMetric);
      row.append(tab);
    }
    return row;
  }

  function modelRows(windowData) {
    const row = (cells, className) => {
      const tr = make('tr', null, className);
      cells.forEach((cell, index) => {
        const node = make('td', cell.text);
        if (index) node.className = 'num';
        if (cell.model) node.classList.add(OFFICIAL_MODEL.test(cell.model) ? 'official' : 'other');
        if (cell.dim) node.classList.add('dim');
        tr.append(node);
      });
      return tr;
    };
    const totalLabel = activeMetric === 'inclusive' ? t('airUsageInclusiveTotal') : t('airUsageFreshTotal');
    const table = make('table', null, 'air-usage-table');
    const head = make('tr');
    for (const [label, numeric] of [[t('airUsageModel'), false], [t('airUsageFreshInput'), true], [t('airUsageOutput'), true], [t('airUsageCacheWrite'), true], [t('airUsageCacheRead'), true], [totalLabel, true]]) {
      const th = make('th', label);
      if (numeric) th.className = 'num';
      head.append(th);
    }
    const thead = make('thead'); thead.append(head); table.append(thead);

    const sums = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 };
    const rows = Object.entries(windowData || {}).map(([model, bucket]) => ({
      model,
      input: bucket.inputTokens || 0,
      output: bucket.outputTokens || 0,
      cacheWrite: bucket.cacheWrite || 0,
      cacheRead: bucket.cacheRead || 0,
      msgs: bucket.msgs || 0,
    })).sort((a, b) => rowTotal(b) - rowTotal(a));

    const body = make('tbody');
    for (const item of rows) {
      sums.input += item.input; sums.output += item.output;
      sums.cacheWrite += item.cacheWrite; sums.cacheRead += item.cacheRead; sums.msgs += item.msgs;
      body.append(row([
        { text: item.model, model: item.model },
        { text: tokens(item.input) },
        { text: tokens(item.output) },
        { text: tokens(item.cacheWrite), dim: true },
        { text: tokens(item.cacheRead), dim: true },
        { text: tokens(activeMetric === 'inclusive'
          ? item.input + item.output + item.cacheWrite + item.cacheRead
          : item.input + item.output) },
      ]));
    }
    table.append(body);

    const freshTotal = sums.input + sums.output;
    const grandTotal = freshTotal + sums.cacheWrite + sums.cacheRead;
    const foot = make('tr');
    [[t('airUsageTotal'), false], [tokens(sums.input), true], [tokens(sums.output), true],
      [tokens(sums.cacheWrite), true], [tokens(sums.cacheRead), true],
      [tokens(activeMetric === 'inclusive' ? grandTotal : freshTotal), true]].forEach(([text, numeric]) => {
      const cell = make('td', text);
      if (numeric) cell.className = 'num';
      foot.append(cell);
    });
    const tfoot = make('tfoot'); tfoot.append(foot); table.append(tfoot);
    return { table, freshTotal, grandTotal, msgs: sums.msgs };
  }

  // 近 14 个**有活动的**日子。旧服务没有 byDayFresh 时退回含缓存序列，并把回退
  // 这件事写在标签里 —— 拿含缓存的数据冒称「新鲜」是最不该有的那种错。
  function trend() {
    const fresh = activeMetric === 'fresh';
    const hasFreshTrend = !!(globalUsage && globalUsage.byDayFresh);
    const byDay = (globalUsage && (fresh && hasFreshTrend ? globalUsage.byDayFresh : globalUsage.byDay)) || {};
    const days = Object.keys(byDay).sort().slice(-14);
    if (!days.length) return null;
    const totals = days.map(day => Object.values(byDay[day] || {}).reduce((sum, value) => sum + value, 0));
    const max = Math.max(...totals, 1);
    const box = make('div', null, 'air-usage-trend');
    const detail = fresh && hasFreshTrend
      ? t('airUsageTrendFreshDetail')
      : `${t('airUsageTrendInclusiveDetail')}${fresh ? t('airUsageTrendFallbackNote') : ''}`;
    box.append(make('div', t('airUsageTrendHead', { n: days.length, detail }), 'air-usage-trend-head'));
    days.forEach((day, index) => {
      const line = make('div', null, 'air-usage-trend-row');
      const bar = make('div', null, 'air-usage-trend-bar');
      const fill = make('div', null, 'air-usage-trend-fill');
      fill.style.width = `${Math.max(2, Math.round(totals[index] / max * 100))}%`;
      bar.append(fill);
      line.append(make('span', day.slice(5), 'air-usage-trend-day'), bar, make('span', tokens(totals[index]), 'air-usage-trend-value'));
      box.append(line);
    });
    return box;
  }

  function renderGlobal() {
    const body = el('air-usage-global');
    if (!body) return;
    body.replaceChildren(windowTabs(), metricTabs());
    if (globalError) {
      body.append(make('p', t('airUsageLoadFailed', { message: globalError }), 'air-usage-error'));
      return;
    }
    if (!globalUsage) {
      body.append(make('p', t('airUsageLoading'), 'air-usage-muted'));
      return;
    }
    const windowData = (globalUsage.windows || {})[activeWindow] || {};
    if (!Object.keys(windowData).length) {
      body.append(make('p', t('airUsageNoDataForWindow'), 'air-usage-muted'));
      return;
    }
    const { table, freshTotal, grandTotal, msgs } = modelRows(windowData);
    body.append(table);
    const selected = activeMetric === 'inclusive' ? grandTotal : freshTotal;
    const generated = globalUsage.generatedAt ? new Date(globalUsage.generatedAt).toLocaleTimeString(getLocale()) : '';
    const summary = make('p', null, 'air-usage-summary');
    summary.append(
      make('span', t('airUsageCurrentMetric', { label: activeMetric === 'inclusive' ? t('airUsageInclusiveTotal') : t('airUsageFreshTotal') })),
      make('strong', tokens(selected)),
      make('span', ` · ${t('airUsageSummaryFresh', { v: tokens(freshTotal) })} · ${t('airUsageSummaryInclusive', { v: tokens(grandTotal) })} · ${t('airUsageSummaryResponses', { n: msgs })}${generated ? ` · ${t('airUsageSummaryScanned', { time: generated })}` : ''}`),
    );
    body.append(summary);
    const graph = trend();
    if (graph) body.append(graph);
  }

  async function loadGlobal(force = false) {
    const body = el('air-usage-global');
    if (force && body) body.replaceChildren(make('p', t('airUsageRescanning'), 'air-usage-muted'));
    try {
      globalUsage = await context.api(`/api/token-usage/global${force ? '?refresh=1' : ''}`);
      globalError = '';
    } catch (error) {
      globalError = error && error.message ? error.message : String(error);
    }
    renderGlobal();
  }

  // ── ② 省主模型 Token ───────────────────────────────────────────────────

  function renderRole() {
    const body = el('air-usage-role');
    if (!body) return;
    if (roleError) {
      body.replaceChildren(make('p', t('airUsageLoadFailed', { message: roleError }), 'air-usage-error'));
      return;
    }
    if (!roleLedger || !Object.keys(roleLedger).length) {
      body.replaceChildren(make('p', t('airUsageNoData'), 'air-usage-muted'));
      return;
    }
    const now = new Date();
    const todayKey = dayKey(now);
    const monday = new Date(now);
    monday.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
    const mondayKey = dayKey(monday);
    const monthStart = dayKey(new Date(now.getFullYear(), now.getMonth(), 1));
    let today = 0; let week = 0; let month = 0; let all = 0;
    for (const [date, dayData] of Object.entries(roleLedger)) {
      if (!dayData || !dayData.sub) continue;
      let daySub = 0;
      for (const provider of Object.values(dayData.sub)) daySub += bucketTotal(provider);
      all += daySub;
      if (date === todayKey) today += daySub;
      if (date >= mondayKey) week += daySub;
      if (date >= monthStart) month += daySub;
    }
    const grid = make('div', null, 'air-usage-role-grid');
    for (const [label, value] of [[t('airUsageToday'), today], [t('airUsageWeek'), week], [t('airUsageMonth'), month], [t('airUsageAll'), all]]) {
      const tile = make('div', null, 'air-usage-role-tile');
      tile.append(make('small', label), make('strong', tokens(value)));
      grid.append(tile);
    }
    body.replaceChildren(grid);
  }

  async function loadRole() {
    try {
      roleLedger = await context.api('/api/token-usage/by-role');
      roleError = '';
    } catch (error) {
      roleError = error && error.message ? error.message : String(error);
    }
    renderRole();
  }

  // ── 外壳 ──────────────────────────────────────────────────────────────

  function card(title, description, extra) {
    const section = make('section', null, 'admin-panel air-usage-card');
    const head = make('div', null, 'admin-panel-head');
    head.append(make('h3', title));
    if (extra) head.append(extra);
    section.append(head);
    if (description) section.append(make('p', description, 'air-usage-desc'));
    return section;
  }

  function section(nextContext) {
    context = nextContext;
    const page = make('section', null, 'air-usage');
    // 这一块是只读参考，不是配置：跟上面的线路表单分开讲，免得看成「某条线路的用量」。
    page.append(make('span', 'TOKEN USAGE', 'eyebrow'));

    const global = card(
      t('airUsageGlobalTitle'),
      t('airUsageGlobalDesc'),
      button(t('airUsageRescan'), () => void loadGlobal(true), 'air-usage-action'),
    );
    const globalBody = make('div'); globalBody.id = 'air-usage-global';
    globalBody.append(make('p', t('airUsageLoading'), 'air-usage-muted'));
    global.append(globalBody);

    const role = card(
      t('airUsageRoleTitle'),
      t('airUsageRoleDesc'),
    );
    const roleBody = make('div'); roleBody.id = 'air-usage-role';
    roleBody.append(make('p', t('airUsageLoading'), 'air-usage-muted'));
    role.append(roleBody);

    page.append(global, role);
    return page;
  }

  function render(target, nextContext) {
    context = nextContext;
    const node = section(nextContext);
    if (target) target.append(node);
    // 已经有数就先画出来（重开面板不该闪一下空白），再去取最新的。
    renderGlobal();
    renderRole();
    return Promise.all([loadGlobal(false), loadRole()]);
  }

  // 顶栏的「刷新」走缓存读；「重新扫描」才强制重扫转录文件。
  function reload() {
    if (!context) return Promise.resolve();
    return Promise.all([loadGlobal(false), loadRole()]);
  }

  root.MultiCCAirUsage = Object.freeze({ render, reload, rescan: () => loadGlobal(true), section });
})(typeof window !== 'undefined' ? window : null);
