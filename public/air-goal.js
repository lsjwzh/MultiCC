'use strict';

// Air 原生「Goal 预检」面板 —— 从旧 manage 页的 Goal 预检那一格搬过来（原生 DOM，
// 不再嵌旧 manage 页）。后端契约见 src/routes/aux-goal.js：
//   GET  /api/settings/goal → { dimensions: { objective, criteria, scope, executable }, minScore }
//   POST /api/settings/goal   body { dimensions, minScore }
// 这份配置管的是「以 Goal 模式发任务前，辅助 AI 按哪几个维度检查目标是否合格」；
// 聊天的 🎯 弹窗能在单条消息上临时覆盖它，所以这里改的是缺省值，不是唯一入口。
//
// 两条口径跟旧页（manage.js 的 loadGoalSettings / saveGoalSettings）严格一致，
// 别按直觉「修正」：
//   ① 维度取回时是 `dims[k] !== false` 才算勾上 —— 缺省（字段缺失、老配置文件、
//      服务端换了默认）算启用，只有显式 false 才是关。写成 `=== true` 会让所有
//      没显式写过这份配置的用户四个维度一起静默失效。
//   ② 阈值 parseInt 不出有限数就按 60 提交。空输入框是「没动过」，不是 0 —— 而
//      0 的含义是「不强制」，把空值当 0 等于把预检悄悄关掉。
//
// 保存成功后必须重新 load() 一次：服务端会 clamp 范围、补默认值，回显才是唯一真相，
// 本地那份「我刚提交了什么」不作数（旧页也是这么做的）。
(function initAirGoal(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  // 顺序就是旧页从上到下的顺序，也是服务端 GOAL_DIMENSIONS 的键序。
  const DIM_KEYS = ['objective', 'criteria', 'scope', 'executable'];
  const DIM_TEXT = {
    objective: ['airGoalObjective', 'airGoalObjectiveHint'],
    criteria: ['airGoalCriteria', 'airGoalCriteriaHint'],
    scope: ['airGoalScope', 'airGoalScopeHint'],
    executable: ['airGoalExecutable', 'airGoalExecutableHint'],
  };
  // 跟服务端 GOAL_CONFIG_DEFAULT.minScore 同一个数：读不到时显示它，解析失败时提交它。
  const DEFAULT_MIN_SCORE = 60;

  // render/refresh 每进一次面板都会重画，回调里要用的 context 只能存这儿 ——
  // 它由 air.js / air-admin.js 每次渲染递进来（同 air-secrets.js 的规矩）。
  let context = null;

  // 样式跟着面板走：air.css 不认识 air-goal-* 这些类，而这一格只有这个文件是主人。
  // 节点只建一次并缓存 —— 重画时是把它移过去，不是再插一份到文档里。
  let styleNode = null;
  function style() {
    if (styleNode) return styleNode;
    styleNode = document.createElement('style');
    styleNode.textContent = `
      .air-goal-intro { margin: 0 0 14px; max-width: 720px; color: var(--muted); font-size: 11.5px; line-height: 1.65; }
      .air-goal-dims { display: grid; gap: 7px; margin-bottom: 16px; }
      .air-goal-dims > h4 { margin: 0 0 2px; color: var(--faint); font-size: 10px; font-weight: 650; letter-spacing: 1.2px; }
      .air-goal-dim { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; border: 1px solid var(--hairline); border-radius: 12px; background: #fff; cursor: pointer; }
      .air-goal-dim:hover { border-color: var(--accent); }
      /* air.css 顶上那条 input, select, textarea { width: 100% } 是给文本框写的，
         勾选框必须自己把宽度收回来（同一文件里 .air-tunnel-switches / .schedule-enabled
         也是这么干的）：不收就会撑满整行，把右边的文案挤到卡片外面去。 */
      .air-goal-dim > input { flex: 0 0 auto; width: 15px; height: 15px; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; accent-color: var(--accent); }
      .air-goal-dim-copy { display: grid; gap: 2px; min-width: 0; }
      .air-goal-dim-copy > b { color: var(--text); font-size: 12px; font-weight: 600; }
      .air-goal-dim-copy > small { color: var(--faint); font-size: 11px; line-height: 1.5; }
      .air-goal-score { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 16px; }
      .air-goal-score-field { display: flex; align-items: baseline; gap: 8px; color: var(--text); font-size: 11.5px; }
      .air-goal-score-field > input { width: 84px; }
      .air-goal-hint { color: var(--faint); font-size: 11px; line-height: 1.5; }
      .air-goal-status { color: var(--faint); font-size: 11px; }
      .air-goal-status.ok { color: var(--accent); }
      .air-goal-status.error { color: var(--danger); }
    `;
    return styleNode;
  }

  function button(text, handler, className = '') {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  // 读一次服务端状态写进已有控件（不重建 DOM：状态行/勾选框的引用在 save 里还要用）。
  async function load() {
    const banner = el('air-goal-load-error');
    if (banner) { banner.hidden = true; banner.textContent = ''; }
    try {
      const data = await context.api('/api/settings/goal');
      const dims = (data && data.dimensions) || {};
      for (const key of DIM_KEYS) {
        const box = el('air-goal-dim-' + key);
        if (box) box.checked = dims[key] !== false; // 口径①：只有显式 false 才算关
      }
      const score = el('air-goal-min-score');
      if (score) score.value = String(data && data.minScore != null ? data.minScore : DEFAULT_MIN_SCORE);
    } catch (error) {
      // 读不到就把话说清楚，还要挡住「对着一份空表单点保存」——那会把默认值写回去，
      // 等于用一次读取失败把用户的配置重置了。
      if (banner) {
        banner.textContent = t('airAdminLoadFailed', { message: error.message || String(error) });
        banner.hidden = false;
      }
    }
  }

  async function save() {
    const status = el('air-goal-status');
    const submit = el('air-goal-save');
    const dimensions = {};
    for (const key of DIM_KEYS) {
      const box = el('air-goal-dim-' + key);
      dimensions[key] = box ? box.checked : true; // 勾选框不在（面板已卸载）时按启用兜底
    }
    const score = el('air-goal-min-score');
    let minScore = parseInt(score ? score.value : '', 10);
    if (!Number.isFinite(minScore)) minScore = DEFAULT_MIN_SCORE; // 口径②：解析不出按 60
    if (submit) submit.disabled = true;
    if (status) { status.textContent = t('airAdminSaving'); status.className = 'air-goal-status'; }
    try {
      await context.api('/api/settings/goal', { dimensions, minScore });
      context.notice(t('airGoalSaved'));
      await load(); // 服务端 clamp / 补默认，回显才是唯一真相
      if (status) { status.textContent = t('airGoalStatusSaved'); status.className = 'air-goal-status ok'; }
    } catch (error) {
      const message = error.message || String(error);
      // 失败时两处都要说：面板内的状态行（人就站在这儿）和右下角提示（挡住上一个
      // 成功的回执继续挂着，让人以为这次也成了）。
      if (status) { status.textContent = t('saveFailed', { error: message }); status.className = 'air-goal-status error'; }
      context.notice(t('saveFailed', { error: message }));
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function build() {
    const panel = make('section', null, 'admin-panel air-goal');
    panel.append(style());
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    title.append(make('span', 'GOAL', 'eyebrow'), make('h3', t('airGoalTitle')));
    head.append(title);
    panel.append(head, make('p', t('airGoalIntro'), 'air-goal-intro'));

    // 读取失败的横幅：平时 hidden，只占一行位置（admin-empty 的写法跟其他面板一致）。
    const banner = make('p', '', 'admin-empty error');
    banner.id = 'air-goal-load-error';
    banner.hidden = true;
    panel.append(banner);

    const dims = make('div', null, 'air-goal-dims');
    dims.append(make('h4', t('airGoalDimsTitle')));
    for (const key of DIM_KEYS) {
      const [labelKey, hintKey] = DIM_TEXT[key];
      const box = make('input');
      box.type = 'checkbox';
      box.id = 'air-goal-dim-' + key;
      const copy = make('span', null, 'air-goal-dim-copy');
      copy.append(make('b', t(labelKey)), make('small', t(hintKey)));
      // label 包着勾选框：整行都能点，不用去戳那个 15px 的方框。
      const row = make('label', null, 'air-goal-dim');
      row.append(box, copy);
      dims.append(row);
    }
    panel.append(dims);

    const scoreField = make('label', null, 'air-goal-score-field');
    const scoreInput = make('input');
    scoreInput.type = 'number';
    scoreInput.id = 'air-goal-min-score';
    scoreInput.min = '0';
    scoreInput.max = '100';
    scoreField.append(make('span', t('airGoalMinScore')), scoreInput);
    const scoreRow = make('div', null, 'air-goal-score');
    scoreRow.append(scoreField, make('span', t('airGoalMinScoreHint'), 'air-goal-hint'));
    panel.append(scoreRow);

    const status = make('span', '', 'air-goal-status');
    status.id = 'air-goal-status';
    const submit = button(t('save'), () => save(), 'primary');
    submit.id = 'air-goal-save';
    const saveRow = make('div', null, 'air-aux-save');
    saveRow.append(submit, status);
    // 阈值框里敲回车就保存：这一格只有它一个输入框，鼠标去够按钮是白跑一趟。
    scoreInput.onkeydown = event => { if (event.key === 'Enter') save(); };
    panel.append(saveRow);

    return panel;
  }

  function render(host, ctx) {
    context = ctx;
    host.replaceChildren(build());
    return load();
  }

  root.MultiCCAirGoal = Object.freeze({ render, refresh: () => load() });
})(typeof window !== 'undefined' ? window : null);
