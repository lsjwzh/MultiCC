'use strict';

// Air 原生「敏感信息」面板 —— 本地密钥保险箱的前端（原生 DOM，不再嵌旧 manage 页）。
// 后端契约见 src/secrets-vault.js：GET /api/secrets（只有元数据）、POST /api/secrets、
// DELETE /api/secrets/:name、GET /api/secrets/:name/value（只给「显示」那一下用）。
//
// 三条红线跟 manage 侧、App 侧一致：列表永远只拿元数据；值只在用户点「显示」时单条
// 读回，用 textContent 写进 DOM（不进 innerHTML、不进日志）；任何失败只把 error.message
// 交给 notice，不把请求体回显。
//
// 它是「子进程环境变量」这一份配置，不是某一组功能里的开关：条目按同名环境变量注入
// 子进程（ANTHROPIC_/CLAUDE_/OPENAI_/CODEX_/MULTICC_ 前缀除外），所以入口在设置中心第
// 一组和控制台工具格的第一格。
(function initAirSecrets(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

  // render(context) 每进一次面板就重建 DOM，拉到的数据留在模块上（同 air-admin.js 的
  // auxView）：回调里要用的 context 也只能存这里，它由 air.js 每次渲染递进来。
  let context = null;
  let entries = []; // 最近一次列表，只有元数据
  // 显示中的值只活在这一次「点开」里：重绘、刷新、换页一律先收起，值不该比它活得久。
  const revealed = new Map();

  function button(text, handler, className = '') {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  function field(labelText, control) {
    const label = make('label', null, 'air-aux-field');
    label.append(make('span', labelText), control);
    return label;
  }

  function metaLine(entry) {
    const parts = [];
    if (entry.description) parts.push(entry.description);
    if (entry.updatedAt) {
      const when = new Date(entry.updatedAt);
      if (!Number.isNaN(when.getTime())) parts.push(t('updatedAt', { time: when.toLocaleString(getLocale()) }));
    }
    return parts.join(' · ');
  }

  function row(entry) {
    const card = make('article', null, 'air-secret-card');
    const copy = make('div', null, 'air-secret-copy');
    const head = make('div', null, 'air-secret-head');
    head.append(make('code', entry.name, 'air-secret-name'));
    head.append(make('span', entry.source === 'agent' ? t('secretsSourceAgent') : t('secretsSourceUser'), 'air-secret-tag'));
    copy.append(head);
    const meta = metaLine(entry);
    if (meta) copy.append(make('small', meta));
    if (revealed.has(entry.name)) {
      // 值只在用户点开的那一下出现在这里；用 textContent，绝不当 HTML。
      copy.append(make('code', revealed.get(entry.name), 'air-secret-value'));
    }
    const actions = make('div', null, 'air-secret-actions');
    actions.append(button(revealed.has(entry.name) ? t('secretsHide') : t('secretsShow'), () => toggleReveal(entry)));
    actions.append(button(t('delete'), () => remove(entry), 'danger'));
    card.append(make('span', '🔑', 'air-secret-mark'), copy, actions);
    return card;
  }

  function paint() {
    const list = el('air-secret-list');
    if (!list) return;
    const count = el('air-secret-count');
    if (count) count.textContent = t('airAdminNItems', { n: entries.length });
    if (!entries.length) list.replaceChildren(make('p', t('secretsEmpty'), 'admin-empty'));
    else list.replaceChildren(...entries.map(row));
  }

  async function load() {
    const list = el('air-secret-list');
    if (list) list.replaceChildren(make('p', t('loading'), 'admin-empty'));
    try {
      entries = await context.api('/api/secrets');
      if (!Array.isArray(entries)) entries = [];
      revealed.clear();
      paint();
    } catch (error) {
      if (list) list.replaceChildren(make('p', t('airAdminLoadFailed', { message: error.message }), 'admin-empty error'));
    }
  }

  async function toggleReveal(entry) {
    if (revealed.has(entry.name)) { revealed.delete(entry.name); paint(); return; }
    try {
      const result = await context.api(`/api/secrets/${encodeURIComponent(entry.name)}/value`);
      revealed.set(entry.name, String((result && result.value) || ''));
      paint();
    } catch (error) { context.notice(error.message || String(error)); }
  }

  async function remove(entry) {
    const question = `${t('secretsDeleteTitle', { name: entry.name })}\n\n${t('secretsDeleteBody')}`;
    if (!root.confirm(question)) return;
    try {
      await context.api(`/api/secrets/${encodeURIComponent(entry.name)}`, undefined, 'DELETE');
      context.notice(t('secretsDeleted', { name: entry.name }));
      await load();
    } catch (error) { context.notice(error.message || String(error)); }
  }

  async function save() {
    const nameInput = el('air-secret-name');
    const valueInput = el('air-secret-value');
    const descInput = el('air-secret-desc');
    const status = el('air-secret-status');
    const submit = el('air-secret-save');
    const name = (nameInput?.value || '').trim();
    const value = valueInput?.value || '';
    // 校验文案跟服务端 NAME_RE 同一句，先在本地挡一道：值没必要为格式错误跑一趟网络。
    if (!NAME_RE.test(name)) { if (status) status.textContent = t('secretsNameInvalid'); return; }
    if (!value) { if (status) status.textContent = t('secretsValueRequired'); return; }
    if (submit) submit.disabled = true;
    if (status) status.textContent = t('airAdminSaving');
    try {
      await context.api('/api/secrets', {
        name,
        value,
        description: (descInput?.value || '').trim(),
        source: 'user',
      });
      // 保存成功立刻清空表单：明文值不在 DOM 里多待一秒。
      if (nameInput) nameInput.value = '';
      if (valueInput) valueInput.value = '';
      if (descInput) descInput.value = '';
      if (status) status.textContent = '';
      context.notice(t('secretsSaved', { name }));
      await load();
    } catch (error) {
      if (status) status.textContent = t('saveFailed', { error: error.message || String(error) });
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function render(host, ctx) {
    context = ctx;
    revealed.clear();
    const intro = make('section', null, 'admin-panel');
    const introHead = make('div', null, 'admin-panel-head');
    const introTitle = make('div');
    introTitle.append(make('span', 'SECRETS', 'eyebrow'), make('h3', t('secretsAddTitle')));
    introHead.append(introTitle, make('span', t('secretsVaultHint'), 'admin-panel-note'));

    const nameInput = make('input');
    nameInput.type = 'text';
    nameInput.id = 'air-secret-name';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.placeholder = 'OPENAI_API_KEY';
    const valueInput = make('input');
    valueInput.type = 'password'; // 明文值默认不回显：连肩窥都挡一层
    valueInput.id = 'air-secret-value';
    valueInput.autocomplete = 'new-password';
    valueInput.spellcheck = false;
    const descInput = make('input');
    descInput.type = 'text';
    descInput.id = 'air-secret-desc';
    descInput.autocomplete = 'off';
    // 值和描述两栏都不给 placeholder：标签就在上面一行，占位符再抄一遍只是噪音
    // （名字那栏留的是例子，说的是「填成什么样」，不是「这是什么」）。
    for (const input of [nameInput, valueInput, descInput]) {
      input.onkeydown = event => { if (event.key === 'Enter') save(); };
    }

    const status = make('span');
    status.id = 'air-secret-status';
    const submit = button(t('save'), () => save(), 'primary');
    submit.id = 'air-secret-save';
    const saveRow = make('div', null, 'air-aux-save');
    saveRow.append(submit, status);
    const form = make('div', null, 'air-aux-form');
    form.append(
      field(t('secretsFieldName'), nameInput),
      field(t('secretsFieldValue'), valueInput),
      field(t('secretsFieldDesc'), descInput),
      saveRow,
    );
    intro.append(introHead, form);

    const vault = make('section', null, 'admin-panel');
    const vaultHead = make('div', null, 'admin-panel-head');
    const vaultTitle = make('div');
    vaultTitle.append(make('span', 'VAULT', 'eyebrow'), make('h3', t('secretsVaultTitle')));
    const count = make('span', '', 'air-secret-count');
    count.id = 'air-secret-count';
    vaultHead.append(vaultTitle, count);
    const list = make('div', null, 'air-secret-list');
    list.id = 'air-secret-list';
    vault.append(vaultHead, list);

    host.replaceChildren(intro, vault);
    void load();
  }

  root.MultiCCAirSecrets = Object.freeze({ render, refresh: () => load() });
})(typeof window !== 'undefined' ? window : null);
