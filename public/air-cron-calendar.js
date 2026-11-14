'use strict';

// ── 定时任务月历（public/air-cron-calendar.js）────────────────────────────────
// 定时任务面板的第二个视图：把「这个月每天会有哪些任务跑」画成月历。数据来自
// GET /api/cron/calendar（按天展开的运行点 + 高频任务聚合名单），本模块只画 DOM、
// 只发请求，与 air-schedule-center.js 平级 —— 编辑入口复用它暴露的 open(id)，
// 所以这里不碰那张表单。视图切换（列表 ↔ 月历）的按钮和容器在 air.html
// #cron-view-bar / #cron-calendar；air.js 在切到 schedules 页时同时 refresh 本模块。
(function initAirCronCalendar(root) {
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
  const locale = () => (typeof root.getLocale === 'function' ? root.getLocale() : undefined);

  let ctx = {};
  let visible = false;
  let loading = false;
  // 当前展示的月份 {year, month}；null = 跟随当前月。
  let cursor = null;
  let data = null;
  // 展开了「+N」的那一天（重画后保留展开态）。
  let expandedDay = null;

  const notice = text => { if (typeof ctx.notice === 'function') ctx.notice(text); };

  function monthKey(of) {
    const d = of || new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` };
  }

  function monthTitle() {
    const current = cursor || monthKey();
    return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'long' })
      .format(new Date(current.year, current.month - 1, 1));
  }

  // 周一开头的星期行（zh 习惯；locale 化由 Intl 完成）。
  function weekdayLabels() {
    const fmt = new Intl.DateTimeFormat(locale(), { weekday: 'short' });
    // 1970-01-05 是周一。
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(1970, 0, 5 + i)));
  }

  function monthMatrix() {
    const current = cursor || monthKey();
    const first = new Date(current.year, current.month - 1, 1);
    const lead = (first.getDay() + 6) % 7; // 周一=0
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    const days = new Date(current.year, current.month, 0).getDate();
    for (let day = 1; day <= days; day++) cells.push(day);
    while (cells.length % 7) cells.push(null);
    return cells;
  }

  // 同一天同一任务的多个运行点聚成一颗（高频任务整月聚合也靠它）。
  function chipsFor(day) {
    const points = (data && data.days && data.days[String(day)]) || [];
    const order = [];
    const byTask = new Map();
    for (const point of points) {
      if (!byTask.has(point.id)) { byTask.set(point.id, { id: point.id, name: point.name, dense: point.dense, times: [] }); order.push(point.id); }
      byTask.get(point.id).times.push(new Date(point.at));
    }
    return order.map(id => byTask.get(id));
  }

  function timeLabel(date) {
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  function chip(entry) {
    const button = node('button', null, `cron-cal-chip ${entry.dense ? 'dense' : ''}`);
    button.type = 'button';
    button.title = entry.name;
    const label = entry.dense
      ? t('cronCalDense', { name: entry.name })
      : `${timeLabel(entry.times[0])} ${entry.name}`;
    button.append(node('span', entry.dense ? '⏱' : '🕘', 'cron-cal-chip-icon'), node('span', label, 'cron-cal-chip-text'));
    button.onclick = () => (root.MultiCCAirSchedules?.open ? root.MultiCCAirSchedules.open(entry.id) : undefined);
    return button;
  }

  function dayCell(day) {
    const today = monthKey();
    const current = cursor || monthKey();
    const cell = node('div', null, `cron-cal-day ${day === today.day && current.month === today.month && current.year === today.year ? 'today' : ''}`);
    if (day == null) { cell.className = 'cron-cal-day blank'; return cell; }
    cell.append(node('span', String(day), 'cron-cal-daynum'));
    const entries = chipsFor(day);
    const box = node('div', null, 'cron-cal-chips');
    const max = day === expandedDay ? Infinity : 3;
    for (const entry of entries.slice(0, max)) box.append(chip(entry));
    if (entries.length > 3) {
      const more = node('button', day === expandedDay
        ? t('cronCalLess')
        : t('cronCalMore', { n: entries.length - 3 }), 'cron-cal-more');
      more.type = 'button';
      more.onclick = () => { expandedDay = day === expandedDay ? null : day; render(); };
      box.append(more);
    }
    cell.append(box);
    return cell;
  }

  function render() {
    const box = $('cron-calendar');
    if (!box) return;
    box.replaceChildren();
    const head = node('div', null, 'cron-cal-head');
    const nav = node('div', null, 'cron-cal-nav');
    const prev = node('button', '‹', 'cron-cal-nav-btn');
    prev.type = 'button';
    prev.setAttribute('aria-label', t('cronCalPrevMonth'));
    prev.onclick = () => shiftMonth(-1);
    const next = node('button', '›', 'cron-cal-nav-btn');
    next.type = 'button';
    next.setAttribute('aria-label', t('cronCalNextMonth'));
    next.onclick = () => shiftMonth(1);
    const today = node('button', t('cronCalToday'), 'cron-cal-nav-btn');
    today.type = 'button';
    today.onclick = () => { cursor = null; void load(); };
    nav.append(prev, node('strong', monthTitle(), 'cron-cal-title'), next, today);
    head.append(nav);
    const legend = node('div', null, 'cron-cal-legend');
    const flat = data ? Object.values(data.days).flat() : [];
    legend.append(
      node('span', t('cronCalPointsCount', { n: flat.length }), 'cron-cal-stat'),
      node('span', t('cronCalDenseHint'), 'cron-cal-stat dense'),
    );
    head.append(legend);
    box.append(head);

    const grid = node('div', null, 'cron-cal-grid');
    const week = node('div', null, 'cron-cal-weekdays');
    for (const label of weekdayLabels()) week.append(node('span', label));
    box.append(week);
    for (const day of monthMatrix()) grid.append(dayCell(day));
    box.append(grid);
  }

  async function load() {
    if (loading || !visible) return;
    loading = true;
    try {
      const key = (cursor || monthKey()).key;
      data = await request(`/api/cron/calendar?month=${encodeURIComponent(key)}`);
      render();
    } catch (error) {
      notice(t('cronCalLoadFailed', { msg: errorText(error) }));
    } finally { loading = false; }
  }

  function shiftMonth(delta) {
    const current = cursor || monthKey();
    const d = new Date(current.year, current.month - 1 + delta, 1);
    cursor = monthKey(d);
    void load();
  }

  // 列表 ↔ 月历切换：air.html 里两颗按钮 + 两个容器的可见性都归这里管。
  function applyView() {
    const list = $('schedule-list');
    const summary = $('schedule-summary');
    const cal = $('cron-calendar');
    const btnList = $('cron-view-list');
    const btnCal = $('cron-view-cal');
    if (!list || !cal || !btnList || !btnCal) return;
    list.hidden = visible;
    if (summary) summary.hidden = visible;
    cal.hidden = !visible;
    btnList.classList.toggle('active', !visible);
    btnCal.classList.toggle('active', visible);
    btnList.setAttribute('aria-selected', String(!visible));
    btnCal.setAttribute('aria-selected', String(visible));
    if (visible) void load();
  }

  function bind(context) {
    ctx = context || {};
    const btnList = $('cron-view-list');
    const btnCal = $('cron-view-cal');
    if (!btnList || !btnCal) return;
    btnList.onclick = () => { visible = false; applyView(); };
    btnCal.onclick = () => { visible = true; applyView(); };
  }

  root.MultiCCAirCronCalendar = Object.freeze({
    bind,
    refresh: load,
    show: () => { visible = true; applyView(); },
  });
})(typeof window !== 'undefined' ? window : null);
