'use strict';

// Air 原生「Agent 资源」面板 —— 原来这一格嵌的是旧 manage 页的 resources view，
// 现在两块卡片都在这里画：已安装技能（只读清单 + 本地过滤）和 Claude 历史会话
// （可逐条删、也可按天龄批量清理）。
// 后端契约见 src/routes/agent-resources.js：
//   GET    /api/agent-resources/skills
//   GET    /api/agent-resources/claude-sessions
//   DELETE /api/agent-resources/claude-sessions/:project/:id
//   DELETE /api/agent-resources/claude-sessions?olderThanDays=N
//
// 删历史是这一页唯一会动磁盘的动作，所以规矩跟保险箱那页一样：先问一句、问句里带
// 具体对象和「不可撤销」，答「否」连请求都不发。linked 的那几条连问的机会都不给 ——
// 按钮直接禁用（服务端另有一道 409 兜底：两边都拦，才算真拦得住）。
//
// 技能名、路径、会话标题全都是从磁盘读来的字符串，可能带尖括号，所以整页只走
// make() + textContent，没有任何一处 innerHTML。
(function initAirResources(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  // 数字格式的唯一来源（shared/format.js，页面里先于本文件加载）。Node 侧的沙箱里
  // 没有页面全局，也没有 require，所以三种取法都留着 —— 测试要么注入
  // MultiCCFormat，要么让它落到 require 上。
  const FMT = (typeof window !== 'undefined' && window.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || (typeof require === 'function' ? require('./shared/format.js') : null);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  // 「清理早于」的档位跟旧页一致；30 是默认档（最常见的「喘口气」阈值）。
  const AGE_CHOICES = [7, 30, 90, 180];

  // 面板每次重开都会重建 DOM（air-admin.js 的 renderNative 走 render(host, ctx)），
  // 所以筛选条件和档位存在模块上：挑好的过滤不该比一次重绘活得短（同 air-admin.js
  // 的控制台筛选）。拉回来的数据也留在这儿，过滤/重画只重排数组，不再打接口。
  let context = null;
  let skills = [];
  let counts = { claude: 0, codex: 0 };
  let sessions = [];
  let totals = { count: 0, totalSize: 0, protectedCount: 0 };
  const filters = { skills: '', sessions: '' };
  // 技能按「从哪来」分层（服务端 src/skills.js 的 skillLayer 打的 layer）：先摆
  // MultiCC 内置与 CLI 自带，用户最常问的就是「哪些是预装的」。插件和 CLI 自带通常
  // 一长串且不归用户管，默认收起；展开/收起的选择跟过滤条件一样存在模块上。
  const SKILL_LAYERS = ['bundled', 'cli', 'plugin', 'user', 'project'];
  const LAYER_KEYS = { bundled: 'airResourcesLayerBundled', cli: 'airResourcesLayerCli', plugin: 'airResourcesLayerPlugin', user: 'airResourcesLayerUser', project: 'airResourcesLayerProject' };
  // 默认全收起：几百个技能摊开时，分组抬头会被第一组淹没，看不出「分了层」。
  const openLayers = { bundled: false, cli: false, plugin: false, user: false, project: false };
  let olderThanDays = 30;
  // 样式只建一次：它是这一页的私有词汇（air-resources-*），跟着面板节点走，
  // 不进 air.css —— 一格一份，删掉这一格就是删掉这个文件加这一行。
  let styleNode = null;

  function styleSheet() {
    if (styleNode) return styleNode;
    styleNode = document.createElement('style');
    styleNode.textContent = `
.air-resources { display: grid; gap: 15px; }
.air-resources-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.air-resources-count { flex: 0 0 auto; color: var(--muted); font-size: 10px; }
.air-resources-list { display: grid; gap: 8px; }
.air-resources-row { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 13px 15px; border: 1px solid var(--hairline); border-radius: 12px; background: #fff; box-shadow: var(--shadow-1); }
.air-resources-badge { flex: 0 0 auto; padding: 3px 7px; border-radius: 6px; background: #eaf3fb; color: #537ba0; font-size: 9px; letter-spacing: .3px; }
.air-resources-badge.is-claude { background: #fbeae4; color: #a6533c; }
.air-resources-badge.is-codex { background: #e8f1fb; color: #2f6ea8; }
.air-resources-badge.is-history { background: #eef3f8; color: #64798d; }
.air-resources-badge.is-protected { background: #e9f8f0; color: #2f7a54; }
.air-resources-copy { min-width: 0; flex: 1 1 200px; }
.air-resources-title { overflow: hidden; color: #2f536f; font-size: 12px; font-weight: 650; white-space: nowrap; text-overflow: ellipsis; }
.air-resources-desc { overflow: hidden; margin-top: 3px; color: #56718b; font-size: 10.5px; line-height: 1.45; }
.air-resources-meta { overflow: hidden; margin-top: 3px; color: var(--faint); font-size: 9.5px; white-space: nowrap; text-overflow: ellipsis; }
.air-resources-filter { width: auto; min-width: 0; flex: 1 1 220px; min-height: 32px; padding: 5px 10px; color: #2f536f; border-radius: 9px; font-size: 11px; }
.air-resources-age { width: auto; min-width: 0; flex: 0 0 auto; min-height: 32px; padding: 4px 8px; color: #2f536f; border-radius: 9px; font-size: 10px; }
.air-resources-clean { flex: 0 0 auto; min-height: 32px; padding: 4px 11px; color: #a6533c; border: 1px solid #eed9d1; border-radius: 9px; background: #fdf4f1; font-size: 9.5px; }
.air-resources-clean:hover:not(:disabled) { background: #fbeae4; }
.air-resources-danger { flex: 0 0 auto; min-height: 30px; padding: 4px 10px; color: #a6533c; border: 1px solid transparent; border-radius: 9px; background: transparent; font-size: 9.5px; }
.air-resources-danger:hover:not(:disabled) { border-color: #eed9d1; background: #fdf4f1; }
.air-resources-danger:disabled { cursor: not-allowed; color: var(--faint); }
.air-resources-group { display: grid; gap: 8px; }
.air-resources-group + .air-resources-group { margin-top: 8px; }
.air-resources-group-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; color: #2f536f; border: 1px solid var(--hairline); border-left: 4px solid #8fb3d3; border-radius: 12px; background: #f6f9fc; font-size: 12.5px; font-weight: 700; list-style: none; }
.air-resources-group-head::-webkit-details-marker { display: none; }
.air-resources-group-head::before { content: '▸'; color: #7d97ae; font-size: 11px; transition: transform .15s; }
.air-resources-group[open] > .air-resources-group-head::before { transform: rotate(90deg); }
.air-resources-group[data-layer="bundled"] > .air-resources-group-head { border-left-color: #3d8bd8; background: #eef5fd; }
.air-resources-group[data-layer="cli"] > .air-resources-group-head { border-left-color: #a6533c; }
.air-resources-group[data-layer="plugin"] > .air-resources-group-head { border-left-color: #8a6bc2; }
.air-resources-group[data-layer="project"] > .air-resources-group-head { border-left-color: #2f7a54; }
.air-resources-group-count { padding: 1px 8px; color: #2f536f; border-radius: 999px; background: #fff; font-size: 10.5px; font-weight: 650; }
.air-resources-group-hint { overflow: hidden; margin-left: auto; color: var(--muted); font-size: 10.5px; font-weight: 500; white-space: nowrap; text-overflow: ellipsis; }
.air-resources-status { margin-top: 10px; color: var(--muted); font-size: 10px; }
`;
    return styleNode;
  }

  function button(text, handler, className = '') {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  // 字节数走全站唯一那份（shared/format.js），本页只留自己的两处取舍：KB 一位小数、
  // MB 两位小数（MB 那个数是为了跟 du 出来的目录大小对账，少一位就对不上），以及
  // 没有值时画 0 B 而不是空白。故意不本地化：单位是符号，与界面语言无关。
  const RES_SIZE = Object.freeze({ unitDecimals: { MB: 2 }, placeholder: '0 B' });

  // 时间跟保险箱那页同一条口径：给了 getLocale()，英文界面里才不会冒出中文月日。
  function fmtWhen(value) {
    const when = new Date(value);
    return Number.isNaN(when.getTime()) ? '' : when.toLocaleString(getLocale());
  }

  function matches(query, fields) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return true;
    return fields.some(field => String(field == null ? '' : field).toLowerCase().includes(needle));
  }

  function visibleSkills() {
    return skills.filter(skill =>
      matches(filters.skills, [skill.provider, skill.source, skill.layer, skill.name, skill.description, skill.path]));
  }

  // preview 也进检索：它不进 DOM，但正是「我记得那句开头」时唯一能对上号的东西。
  function visibleSessions() {
    return sessions.filter(session =>
      matches(filters.sessions, [session.id, session.title, session.preview, session.cwd, session.project]));
  }

  function skillRow(skill) {
    const provider = String(skill.provider || '');
    const kind = provider === 'claude' ? ' is-claude' : provider === 'codex' ? ' is-codex' : '';
    const row = make('article', null, 'air-resources-row');
    const copy = make('div', null, 'air-resources-copy');
    copy.append(make('div', skill.name || t('airResourcesUnnamedSkill'), 'air-resources-title'));
    if (skill.description) copy.append(make('div', skill.description, 'air-resources-desc'));
    copy.append(make('div', `${skill.source || ''} · ${skill.path || ''}`, 'air-resources-meta'));
    row.append(make('span', provider || '?', 'air-resources-badge' + kind), copy);
    return row;
  }

  function sessionRow(session) {
    const linked = session.linked === true;
    const row = make('article', null, 'air-resources-row');
    const copy = make('div', null, 'air-resources-copy');
    copy.append(make('div', session.title || '', 'air-resources-title'));
    copy.append(make('div', session.cwd || session.project || '', 'air-resources-desc'));
    const when = fmtWhen(session.updatedAt);
    copy.append(make('div', [session.id, when, FMT.formatBytes(session.size, RES_SIZE)].filter(Boolean).join(' · '), 'air-resources-meta'));
    row.append(
      make('span', linked ? t('airResourcesBadgeProtected') : t('airResourcesBadgeHistory'),
        'air-resources-badge ' + (linked ? 'is-protected' : 'is-history')),
      copy,
    );
    const remove = button(t('delete'), () => removeSession(session), 'air-resources-danger');
    // 禁用的按钮连点击都收不到，所以「为什么不能删」只能挂在 title 上（旧页同此）。
    remove.disabled = linked;
    if (linked) remove.title = t('airResourcesLinked');
    remove.dataset.sessionId = String(session.id);
    row.append(remove);
    return row;
  }

  function paintSkills() {
    const list = el('air-resources-skills-list');
    if (!list) return;
    const count = el('air-resources-skills-count');
    // 抬头说的是「装了多少」，不是「筛出多少」：过滤是看清单的手段，不改变这一格的
    // 结论 —— 否则清空过滤框才能知道到底装了几个。
    if (count) count.textContent = t('airResourcesSkillsCount', { claude: counts.claude || 0, codex: counts.codex || 0 });
    const visible = visibleSkills();
    if (!visible.length) list.replaceChildren(make('p', t('airResourcesSkillsEmpty'), 'admin-empty'));
    else list.replaceChildren(...SKILL_LAYERS.map(layer => skillGroup(layer, visible)).filter(Boolean));
  }

  function skillGroup(layer, visible) {
    const members = visible.filter(skill => (SKILL_LAYERS.includes(skill.layer) ? skill.layer : 'user') === layer);
    if (!members.length) return null;
    const group = make('details', null, 'air-resources-group');
    group.dataset.layer = layer;
    // 有过滤词时全部摊开：命中藏在收起的组里等于没命中。
    group.open = !!String(filters.skills || '').trim() || openLayers[layer];
    const summary = make('summary', null, 'air-resources-group-head');
    summary.append(make('span', t(LAYER_KEYS[layer])), make('span', String(members.length), 'air-resources-group-count'),
      make('span', t(LAYER_KEYS[layer] + 'Hint'), 'air-resources-group-hint'));
    group.append(summary, ...members.map(skillRow));
    group.addEventListener('toggle', () => { if (!String(filters.skills || '').trim()) openLayers[layer] = group.open; });
    return group;
  }

  function paintSessions() {
    const list = el('air-resources-history-list');
    if (!list) return;
    const count = el('air-resources-history-count');
    if (count) {
      count.textContent = t('airResourcesHistorySummary', {
        n: totals.count || 0,
        size: FMT.formatBytes(totals.totalSize, RES_SIZE),
        protected: totals.protectedCount || 0,
      });
    }
    const visible = visibleSessions();
    if (!visible.length) list.replaceChildren(make('p', t('airResourcesHistoryEmpty'), 'admin-empty'));
    else list.replaceChildren(...visible.map(sessionRow));
  }

  function setStatus(text) {
    const status = el('air-resources-history-status');
    if (status) status.textContent = text;
  }

  function showLoading() {
    const placeholder = () => make('p', t('loading'), 'admin-empty');
    const skillsList = el('air-resources-skills-list');
    if (skillsList) skillsList.replaceChildren(placeholder());
    const historyList = el('air-resources-history-list');
    if (historyList) historyList.replaceChildren(placeholder());
  }

  async function load() {
    if (!context) return;
    showLoading();
    try {
      // 两块卡片一起拉：它们没有先后依赖，分两次 await 只会让第二块白等第一块的往返。
      const [skillsPayload, historyPayload] = await Promise.all([
        context.api('/api/agent-resources/skills'),
        context.api('/api/agent-resources/claude-sessions'),
      ]);
      skills = Array.isArray(skillsPayload && skillsPayload.skills) ? skillsPayload.skills : [];
      counts = (skillsPayload && skillsPayload.counts) || {};
      sessions = Array.isArray(historyPayload && historyPayload.sessions) ? historyPayload.sessions : [];
      totals = {
        count: historyPayload && historyPayload.count != null ? historyPayload.count : sessions.length,
        totalSize: (historyPayload && historyPayload.totalSize) || 0,
        protectedCount: (historyPayload && historyPayload.protectedCount) || 0,
      };
      paintSkills();
      paintSessions();
    } catch (error) {
      const message = t('airAdminLoadFailed', { message: error.message || String(error) });
      const failed = () => make('p', message, 'admin-empty error');
      const skillsList = el('air-resources-skills-list');
      if (skillsList) skillsList.replaceChildren(failed());
      const historyList = el('air-resources-history-list');
      if (historyList) historyList.replaceChildren(failed());
    }
  }

  async function removeSession(session) {
    // linked 的连问都不问，也就不可能发出请求 —— 这里再挡一道，是为了让「点了没反应」
    // 这条路在代码上也说不通，而不是只靠按钮 disabled 这个视觉属性。
    if (session.linked === true) return;
    const question = `${t('airResourcesDeleteTitle', { id: session.id })}\n\n${t('airResourcesDeleteBody')}`;
    if (!root.confirm(question)) return;
    try {
      // project 是 cwd 的 basename、id 是 .jsonl 的文件名，两段都是服务端给的字符串
      // （可能带空格、% 这类字符），各编各的 —— 任一段不编，一个斜杠就能把路径多切
      // 一段出来，打到别的会话上去。
      const result = await context.api(
        `/api/agent-resources/claude-sessions/${encodeURIComponent(session.project)}/${encodeURIComponent(session.id)}`,
        undefined, 'DELETE');
      await load();
      // 释放量用服务端回来的 freed，不用列表里那个 size：列表是删之前读的，
      // 而这句状态说的是「刚才那一下动了多少磁盘」。
      const message = t('airResourcesDeletedOne', { id: session.id, size: FMT.formatBytes(result && result.freed, RES_SIZE) });
      setStatus(message);
      context.notice(message);
    } catch (error) {
      setStatus(t('airResourcesFailed', { message: error.message || String(error) }));
    }
  }

  async function cleanOld() {
    const days = olderThanDays;
    const question = `${t('airResourcesCleanTitle', { days })}\n\n${t('airResourcesDeleteBody')}`;
    if (!root.confirm(question)) return;
    const trigger = el('air-resources-history-clean');
    if (trigger) trigger.disabled = true;
    try {
      const result = await context.api(`/api/agent-resources/claude-sessions?olderThanDays=${days}`, undefined, 'DELETE');
      await load();
      const message = t('airResourcesCleanDone', {
        n: (result && result.deleted) || 0,
        size: FMT.formatBytes(result && result.freed, RES_SIZE),
      });
      setStatus(message);
      context.notice(message);
    } catch (error) {
      setStatus(t('airResourcesFailed', { message: error.message || String(error) }));
    } finally {
      if (trigger) trigger.disabled = false;
    }
  }

  function skillsCard() {
    const card = make('section', null, 'admin-panel');
    const head = make('div', null, 'admin-panel-head');
    const heading = make('div');
    heading.append(make('span', 'SKILLS', 'eyebrow'), make('h3', t('airResourcesSkillsTitle')));
    const count = make('span', '', 'air-resources-count');
    count.id = 'air-resources-skills-count';
    head.append(heading, count);

    const filter = make('input', null, 'air-resources-filter');
    filter.id = 'air-resources-skills-filter';
    filter.type = 'search';
    filter.autocomplete = 'off';
    filter.spellcheck = false;
    filter.placeholder = t('airResourcesSkillsFilter');
    filter.value = filters.skills;
    filter.oninput = () => { filters.skills = filter.value; paintSkills(); };
    const toolbar = make('div', null, 'air-resources-toolbar');
    toolbar.append(filter);

    const list = make('div', null, 'air-resources-list');
    list.id = 'air-resources-skills-list';
    card.append(head, toolbar, list);
    return card;
  }

  function historyCard() {
    const card = make('section', null, 'admin-panel');
    const head = make('div', null, 'admin-panel-head');
    const heading = make('div');
    heading.append(make('span', 'HISTORY', 'eyebrow'), make('h3', t('airResourcesHistoryTitle')));
    const count = make('span', '', 'air-resources-count');
    count.id = 'air-resources-history-count';
    head.append(heading, count);

    const filter = make('input', null, 'air-resources-filter');
    filter.id = 'air-resources-history-filter';
    filter.type = 'search';
    filter.autocomplete = 'off';
    filter.spellcheck = false;
    filter.placeholder = t('airResourcesHistoryFilter');
    filter.value = filters.sessions;
    filter.oninput = () => { filters.sessions = filter.value; paintSessions(); };

    const age = make('select', null, 'air-resources-age');
    age.id = 'air-resources-history-age';
    for (const days of AGE_CHOICES) {
      const option = make('option', t('airResourcesOlderThanDays', { n: days }));
      // option 的 value 必须显式写成天数：不写的话它默认等于文案，而文案是跟着语言
      // 走的 —— 那样一来 selected 对不上、请求参数也会跟着界面语言变。
      option.value = String(days);
      age.append(option);
    }
    age.value = String(AGE_CHOICES.includes(olderThanDays) ? olderThanDays : 30);
    age.onchange = () => {
      olderThanDays = Number(age.value) || 30;
      // 换了档位就把上一次的「删了几条」收起来：那句话说的是旧档位的结果，
      // 留在新档位旁边就变成了一句会骗人的状态。
      setStatus(t('airResourcesProtectedHint'));
    };

    const clean = button(t('airResourcesCleanOld'), () => cleanOld(), 'air-resources-clean');
    clean.id = 'air-resources-history-clean';

    const toolbar = make('div', null, 'air-resources-toolbar');
    toolbar.append(filter, age, clean);

    const list = make('div', null, 'air-resources-list');
    list.id = 'air-resources-history-list';
    const status = make('div', t('airResourcesProtectedHint'), 'air-resources-status');
    status.id = 'air-resources-history-status';
    card.append(head, toolbar, list, status);
    return card;
  }

  function render(host, ctx) {
    context = ctx;
    const page = make('div', null, 'air-resources');
    page.append(skillsCard(), historyCard());
    host.replaceChildren(styleSheet(), page);
    // 上一次的删除结果不该跨进这一次打开：状态行回到它默认那句话（这里显式写一次，
    // 是因为 DOM 是新的，而模块上的状态不是）。
    setStatus(t('airResourcesProtectedHint'));
    return load();
  }

  root.MultiCCAirResources = Object.freeze({ render, refresh: () => load() });
})(typeof window !== 'undefined' ? window : null);
