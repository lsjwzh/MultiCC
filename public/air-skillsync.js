'use strict';

// Air 原生「技能同步」面板 —— 共享技能往三端（Claude / Codex / Hermes）分发的状态与手动触发
// （原生 DOM，不再嵌旧 manage 页）。后端契约见 src/routes/skill-sync.js：
//   GET  /api/skill-sync/status → 引擎上一次跑完留下的状态快照，本身就是状态对象
//   POST /api/skill-sync/run    → { ok, result }，**result 才是新的状态对象**
//
// 第二条这个「状态藏在 result 里」的形状是旧页留下的坑。context.api 只在响应
// ok === false 时抛错（见 air.js 的 request），所以 ok:true 的响应它会原样交回来 ——
// 把响应当状态用，画出来每格都是零、ts 也是空的，还得再打一次 status 才对得上。
// 取 result 是调用方的责任，这里就取。
//
// 这一页只读快照、只按需触发，不猜同步进度：面板不轮询（同步由启动时、定时器、
// 目录变化三处各自触发，进度不在这一页上反映），想知道「现在什么样」就按工具条上的刷新。
// 唯一会自己刷的是「立即同步」——它拿到的那份 result 就是最新快照。
(function initAirSkillsync(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  // 三端是这套引擎的主场：先按这个顺序画，别的键（以后加的第四端）按原顺序跟在后面。
  const PROVIDER_ORDER = ['claude', 'codex', 'hermes'];

  // render(host, ctx) 每进一次面板就重建 DOM，拿到的快照和 context 只能存在模块上
  // （context 由 air.js 每次渲染递进来）。过滤框里的字是纯本地的事，跟快照一起留着：
  // 重画列表不该为了一次过滤再打一遍接口。
  let context = null;
  let snapshot = null;
  let filter = '';

  function styleSheet() {
    const style = document.createElement('style');
    // 样式跟着面板走，不塞进 air.css：这一格的颜色/圆角全用 Air 的 v2 词汇，
    // 哪天这一格下线，删掉这个文件就干净了，不会在 air.css 里留一段孤儿规则。
    style.textContent = `
      .air-skillsync-stack { display: grid; gap: 15px; }
      .air-skillsync-intro { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.65; }
      .air-skillsync-rows { display: grid; }
      .air-skillsync-row { display: flex; align-items: baseline; gap: 10px; padding: 9px 0; border-top: 1px solid var(--hairline); font-size: 11.5px; }
      /* 行是 flex，[hidden] 那条 UA 规则压不过它 —— 错误行要能真的收起来，得自己再写一遍。 */
      .air-skillsync-row[hidden] { display: none; }
      .air-skillsync-row > span:first-child { flex: 0 0 84px; color: var(--faint); font-size: 10.5px; }
      /* 错误串是路径 + errno，没有空格可断。anywhere 才保证它换行而不是把卡片撑破。 */
      .air-skillsync-value { min-width: 0; color: var(--text); word-break: break-word; overflow-wrap: anywhere; }
      .air-skillsync-value.is-mono { color: var(--muted); font-family: var(--mono, monospace); font-size: 10.5px; }
      .air-skillsync-value.is-error { color: var(--danger); }
      .air-skillsync-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
      .air-skillsync-state { min-width: 0; color: var(--muted); font-size: 10.5px; word-break: break-word; }
      .air-skillsync-state.is-ok { color: var(--accent); }
      .air-skillsync-state.is-err { color: var(--danger); }
      .air-skillsync-providers, .air-skillsync-list { display: grid; gap: 8px; }
      .air-skillsync-provider { min-width: 0; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--hairline); border-radius: 12px; background: #fff; box-shadow: var(--shadow-1); }
      .air-skillsync-badge { flex: 0 0 auto; padding: 2px 8px; color: var(--accent); border-radius: 999px; background: #eaf3ff; font-size: 10px; }
      .air-skillsync-provider-meta { min-width: 0; color: var(--muted); font-size: 10.5px; }
      .air-skillsync-toolbar { margin-bottom: 10px; }
      .air-skillsync-filter { width: 100%; max-width: 320px; min-height: 34px; padding: 6px 11px; border: 1px solid var(--hairline); border-radius: 12px; background: #fff; font-size: 11.5px; }
      .air-skillsync-skill { min-width: 0; display: flex; align-items: center; gap: 8px; padding: 9px 12px; border: 1px solid var(--hairline); border-radius: 12px; background: #fff; }
      .air-skillsync-skill-name { min-width: 0; color: var(--text); font-size: 11.5px; word-break: break-all; }
      .air-skillsync-queue-tag { flex: 0 0 auto; margin-left: auto; color: var(--muted); font-size: 10px; }
    `;
    return style;
  }

  // 旧页 _ssRelTime 的搬迁。相对时间是给人的，不是给机器算的：一分钟内说「刚刚」，
  // 之后逐级退到分钟 / 小时 / 天。ts 缺失说的是「还没同步过」，不是「零秒前」。
  function relTime(ts) {
    if (!ts) return t('airSkillsyncNever');
    const diff = Date.now() - ts;
    if (diff < 60000) return t('airSkillsyncJustNow');
    if (diff < 3600000) return t('airSkillsyncMinutesAgo', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('airSkillsyncHoursAgo', { n: Math.floor(diff / 3600000) });
    return t('airSkillsyncDaysAgo', { n: Math.floor(diff / 86400000) });
  }

  // 绝对时间给「到底是哪一刻」，相对时间给「多久以前」—— 两个都留着，少一个就得自己换算。
  function lastRunText(ts) {
    if (!ts) return t('airSkillsyncNeverSynced');
    const when = new Date(ts);
    if (Number.isNaN(when.getTime())) return t('airSkillsyncNeverSynced');
    return `${when.toLocaleString(getLocale())} · ${relTime(ts)}`;
  }

  function set(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
  }

  function providerRows(providers) {
    const keys = PROVIDER_ORDER.filter(key => providers[key])
      .concat(Object.keys(providers).filter(key => !PROVIDER_ORDER.includes(key)));
    if (!keys.length) return [make('p', t('airSkillsyncNoProviders'), 'admin-empty')];
    return keys.map(key => {
      const entry = providers[key] || {};
      const row = make('div', null, 'air-skillsync-provider');
      row.append(make('span', key, 'air-skillsync-badge'));
      row.append(make('span', t('airSkillsyncProviderMeta', {
        linked: entry.linked || 0,
        skipped: entry.skipped || 0,
        converted: entry.converted || 0,
      }), 'air-skillsync-provider-meta'));
      return row;
    });
  }

  function skillRows(source) {
    const list = el('air-skillsync-list');
    if (!list) return;
    const names = source.sharedSkillNames || [];
    if (!names.length) {
      list.replaceChildren(make('p', t('airSkillsyncNoSkills'), 'admin-empty'));
      return;
    }
    const query = filter.trim().toLowerCase();
    const shown = names.filter(name => !query || String(name).toLowerCase().includes(query));
    if (!shown.length) {
      // 空列表分两种：一个都没共享，和「有，但被过滤框筛没了」。说的不是同一件事，
      // 所以不共用一句话 —— 后者该让人知道是过滤的条件在起作用。
      list.replaceChildren(make('p', t('airSkillsyncNoMatch'), 'admin-empty'));
      return;
    }
    // 正在排队等 AI 转换的技能名跟着一起标出来：同一个名字在列表里是「共享技能」，
    // 在队列里是「还没转好」，一眼能对上比让人自己去比对两个列表强。
    const queued = new Set((((source.aiQueue || {}).items) || []).map(item => item && item.skillName));
    list.replaceChildren(...shown.map(name => {
      const row = make('div', null, 'air-skillsync-skill');
      row.append(make('span', name, 'air-skillsync-skill-name'));
      if (queued.has(name)) row.append(make('span', t('airSkillsyncAiConverting'), 'air-skillsync-queue-tag'));
      return row;
    }));
  }

  function paint() {
    const source = snapshot || {};
    const queue = source.aiQueue || {};
    const pending = Number(queue.queueLength) || 0;
    set('air-skillsync-summary', t('airSkillsyncSummary', {
      count: source.sharedSkillCount || 0,
      rel: relTime(source.ts),
    }));
    set('air-skillsync-last', lastRunText(source.ts));
    set('air-skillsync-shared', t('airSkillsyncSharedCount', { n: source.sharedSkillCount || 0 }));
    set('air-skillsync-run', t('airSkillsyncRunSummary', {
      linked: source.linkCount || 0,
      skipped: source.skipCount || 0,
      converted: source.convCount || 0,
      reverse: source.reverseImportCount || 0,
    }));
    set('air-skillsync-queue', pending === 0
      ? t('airSkillsyncQueueIdle')
      : t('airSkillsyncQueuePending', { n: pending }) + (queue.timerActive ? t('airSkillsyncQueueBusy') : ''));
    // 错误行有值才露面：没出错时留一行「错误 —」只会让人以为哪里坏了。
    const errorRow = el('air-skillsync-error-row');
    if (errorRow) {
      errorRow.hidden = !source.error;
      if (source.error) set('air-skillsync-error', source.error);
    }
    const providers = el('air-skillsync-providers');
    if (providers) providers.replaceChildren(...providerRows(source.providers || {}));
    set('air-skillsync-list-count', t('airSkillsyncListCount', { n: source.sharedSkillCount || 0 }));
    skillRows(source);
  }

  async function load() {
    const list = el('air-skillsync-list');
    if (list) list.replaceChildren(make('p', t('loading'), 'admin-empty'));
    try {
      const data = await context.api('/api/skill-sync/status');
      snapshot = data && typeof data === 'object' ? data : {};
      paint();
    } catch (error) {
      // 读不到快照时两份列表都说同一句话：卡在「加载中…」和留一堆破折号，
      // 看着都像这一页还在慢慢加载，而不是它已经失败了。
      const message = t('airAdminLoadFailed', { message: error.message || String(error) });
      for (const id of ['air-skillsync-providers', 'air-skillsync-list']) {
        const node = el(id);
        if (node) node.replaceChildren(make('p', message, 'admin-empty error'));
      }
    }
  }

  async function syncNow() {
    const button = el('air-skillsync-run-btn');
    const state = el('air-skillsync-state');
    if (button) { button.disabled = true; button.textContent = t('airSkillsyncSyncing'); }
    if (state) { state.className = 'air-skillsync-state'; state.textContent = ''; }
    try {
      const payload = await context.api('/api/skill-sync/run', {});
      // 旧页的判定顺序：先看 ok，再把 result 当状态。ok === false 时 context.api
      // 已经抛了，所以走到这里只剩「真的跑完并交了新快照」这一种可能。
      const next = payload && payload.result;
      if (!next || typeof next !== 'object') throw new Error(t('airSkillsyncRunNoResult'));
      snapshot = next;
      paint();
      if (state) { state.className = 'air-skillsync-state is-ok'; state.textContent = t('airSkillsyncSyncDone'); }
    } catch (error) {
      // 失败就说失败。按钮和文案照常恢复，但这一行绝不能画成「同步完成」——
      // 同步没跑成的时候，屏幕上唯一说真话的地方就是它。
      if (state) {
        state.className = 'air-skillsync-state is-err';
        state.textContent = t('airSkillsyncSyncFailed', { error: error.message || String(error) });
      }
    } finally {
      if (button) { button.disabled = false; button.textContent = t('airSkillsyncSyncNow'); }
    }
  }

  function statusPanel() {
    const panel = make('section', null, 'admin-panel');
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    title.append(make('span', 'SKILLS', 'eyebrow'), make('h3', t('airSkillsyncStatusTitle')));
    const summary = make('span', '', 'admin-panel-note');
    summary.id = 'air-skillsync-summary';
    head.append(title, summary);

    const rows = make('div', null, 'air-skillsync-rows');
    const row = (labelText, valueId, valueClass) => {
      const line = make('div', null, 'air-skillsync-row');
      const value = make('span', '—', `air-skillsync-value${valueClass ? ' ' + valueClass : ''}`);
      value.id = valueId;
      line.append(make('span', labelText), value);
      return line;
    };
    const errorRow = row(t('airSkillsyncErrorLabel'), 'air-skillsync-error', 'is-error');
    errorRow.id = 'air-skillsync-error-row';
    errorRow.hidden = true;
    rows.append(
      row(t('airSkillsyncLastRun'), 'air-skillsync-last'),
      row(t('airSkillsyncSharedSkills'), 'air-skillsync-shared'),
      row(t('airSkillsyncRunResult'), 'air-skillsync-run', 'is-mono'),
      row(t('airSkillsyncQueue'), 'air-skillsync-queue'),
      errorRow,
    );

    const run = make('button', t('airSkillsyncSyncNow'), 'primary');
    run.type = 'button';
    // id 不能和「本轮结果」那格同名（air-skillsync-run）：同一页两个同名 id 会让
    // getElementById 认哪个变成看谁先出现，两边都变成「有时对有时错」。
    run.id = 'air-skillsync-run-btn';
    run.onclick = () => syncNow();
    const state = make('span', '', 'air-skillsync-state');
    state.id = 'air-skillsync-state';
    const foot = make('div', null, 'air-skillsync-foot');
    foot.append(run, state);

    panel.append(head, rows, foot);
    return panel;
  }

  function providersPanel() {
    const panel = make('section', null, 'admin-panel');
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    title.append(make('span', 'PROVIDERS', 'eyebrow'), make('h3', t('airSkillsyncProviders')));
    head.append(title);
    const list = make('div', null, 'air-skillsync-providers');
    list.id = 'air-skillsync-providers';
    panel.append(head, list);
    return panel;
  }

  function skillsPanel() {
    const panel = make('section', null, 'admin-panel');
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    title.append(make('span', 'SHARED', 'eyebrow'), make('h3', t('airSkillsyncSharedTitle')));
    const count = make('span', '', 'admin-panel-note');
    count.id = 'air-skillsync-list-count';
    head.append(title, count);

    const input = make('input', null, 'air-skillsync-filter');
    input.type = 'search';
    input.id = 'air-skillsync-filter';
    input.placeholder = t('airSkillsyncFilterPlaceholder');
    input.autocomplete = 'off';
    input.spellcheck = false;
    // 过滤是本地过滤：名字已经在手里了，为了一次筛选再打一趟接口，
    // 只会让输入框跟着网络一顿一顿的。
    input.oninput = () => { filter = input.value; skillRows(snapshot || {}); };
    const toolbar = make('div', null, 'air-skillsync-toolbar');
    toolbar.append(input);

    const list = make('div', null, 'air-skillsync-list');
    list.id = 'air-skillsync-list';
    panel.append(head, toolbar, list);
    return panel;
  }

  function render(host, ctx) {
    context = ctx;
    snapshot = null;
    filter = '';
    const stack = make('div', null, 'air-skillsync-stack');
    stack.append(
      make('p', t('airSkillsyncIntro'), 'air-skillsync-intro'),
      statusPanel(),
      providersPanel(),
      skillsPanel(),
    );
    host.replaceChildren(styleSheet(), stack);
    return load();
  }

  function refresh() { return load(); }

  root.MultiCCAirSkillsync = Object.freeze({ render, refresh });
})(typeof window !== 'undefined' ? window : null);
