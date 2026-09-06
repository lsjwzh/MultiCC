'use strict';

(function initWorkspaceSetup(global) {
  if (!global || !global.MultiCCApi) throw new Error('Workspace setup dependencies are unavailable');

  const api = global.MultiCCApi;
  let catalog = null;
  let catalogPromise = null;
  let selectedTemplateId = '';
  let suggestionTimer = null;
  let suggestions = [];
  let createdDirectory = null;
  let sampleFlow = false;
  let templatesReady = false;

  const copy = {
    zh: {
      preparing: '正在准备工作区…', creatingWorkspace: '正在验证路径并创建工作区…', creatingSample: '正在创建安全示例工作区…',
      creatingRole: '正在准备角色 {n}/{total}：{role}', ready: '工作区与团队已准备完成',
      retry: '重试团队创建', create: '创建工作区与团队', sampleCreate: '创建示例工作区与团队', sampleReady: '示例工作区已准备完成',
      partial: '工作区已创建，但有 {n} 个角色准备失败。可以重试，或稍后手动添加。',
      loadFailed: '团队模板加载失败，将只创建指挥官。', required: '请选择本地路径。',
      sampleFailed: '示例工作区创建失败：{error}', failed: '工作区创建失败：{error}',
    },
    en: {
      preparing: 'Preparing workspace…', creatingWorkspace: 'Validating the path and creating the workspace…', creatingSample: 'Creating the safe sample workspace…',
      creatingRole: 'Preparing role {n}/{total}: {role}', ready: 'Workspace and team are ready',
      retry: 'Retry team setup', create: 'Create workspace and team', sampleCreate: 'Create sample workspace and team', sampleReady: 'Sample workspace is ready',
      partial: 'The workspace was created, but {n} roles failed. Retry now or add them later.',
      loadFailed: 'Team templates failed to load. Only the Commander will be created.', required: 'Choose a local path.',
      sampleFailed: 'Could not create the sample workspace: {error}', failed: 'Could not create the workspace: {error}',
    },
  };

  function language() {
    try { return global.localStorage.getItem('multicc_lang') === 'en' ? 'en' : 'zh'; }
    catch (_) { return 'zh'; }
  }
  function tr(key, params) {
    let value = copy[language()][key] || key;
    for (const [name, replacement] of Object.entries(params || {})) value = value.replace(`{${name}}`, replacement);
    return value;
  }
  function localized(value) { return value && (value[language()] || value.zh || value.en) || ''; }
  function el(id) { return global.document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function setStatus(message, error = false) {
    const node = el('newdir-status');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('visible', !!message);
    node.classList.toggle('error', error);
  }
  function setBusy(busy) {
    for (const id of ['newdir-name', 'newdir-path', 'newdir-create', 'newdir-cancel']) {
      const node = el(id); if (node) node.disabled = busy || (sampleFlow && id !== 'newdir-cancel');
    }
    const submit = el('newdir-submit');
    if (submit) { submit.disabled = busy || !templatesReady; submit.textContent = busy ? tr('preparing') : (createdDirectory ? tr('retry') : tr(sampleFlow ? 'sampleCreate' : 'create')); }
    const grid = el('workspace-team-grid');
    if (grid) {
      grid.setAttribute('aria-busy', busy || !templatesReady ? 'true' : 'false');
      grid.querySelectorAll('input').forEach(input => { input.disabled = busy || !templatesReady; });
    }
  }

  async function teamCatalog() {
    if (catalog) return catalog;
    if (!catalogPromise) catalogPromise = api.json('/team-presets.json', { timeoutMs: 8000 })
      .then(data => { catalog = data; return data; })
      .finally(() => { catalogPromise = null; });
    return catalogPromise;
  }
  function selectedTemplate() {
    return (catalog && catalog.templates || []).find(item => item.id === selectedTemplateId)
      || { id: 'commander-only', roles: [] };
  }
  function renderTemplates() {
    const grid = el('workspace-team-grid');
    if (!grid || !catalog) return;
    grid.innerHTML = (catalog.templates || []).map(template => {
      const selected = template.id === selectedTemplateId;
      const roles = template.roles || [];
      const count = roles.length + 1;
      const recommended = language() === 'en' ? 'Recommended' : '推荐';
      const commander = language() === 'en' ? 'Commander' : '指挥官';
      const countLabel = language() === 'en' ? `${count} Agents` : `${count} 个 Agent`;
      const commanderSummary = language() === 'en' ? 'Receives goals, dispatches work, and verifies delivery' : '负责接收目标、拆分任务、派发和验收';
      return `<label class="workspace-team-card${selected ? ' selected' : ''}" data-team-template="${escapeHtml(template.id)}">
        <input type="radio" name="workspace-team" value="${escapeHtml(template.id)}"${selected ? ' checked' : ''}>
        <span class="workspace-team-title">${escapeHtml(localized(template.name))}${template.recommended ? `<span class="recommended">${recommended}</span>` : ''}<span class="workspace-team-count">${countLabel}</span></span>
        <span class="workspace-team-desc">${escapeHtml(localized(template.description))}</span>
        <span class="workspace-role-list"><span class="workspace-role-chip" title="${commanderSummary}">${commander}</span>${roles.map(role => `<span class="workspace-role-chip" title="${escapeHtml(localized(role.summary))}">${escapeHtml(localized(role.label))}</span>`).join('')}</span>
        ${selected ? `<span class="workspace-role-details"><span><b>${commander}</b>${commanderSummary}</span>${roles.map(role => `<span><b>${escapeHtml(localized(role.label))}</b>${escapeHtml(localized(role.summary))}</span>`).join('')}</span>` : ''}
        <span class="workspace-team-example">${escapeHtml(localized(template.example))}</span>
      </label>`;
    }).join('');
    grid.querySelectorAll('input[name="workspace-team"]').forEach(input => input.addEventListener('change', () => {
      selectedTemplateId = input.value;
      renderTemplates();
    }));
    if (el('newdir-submit')?.disabled) grid.querySelectorAll('input').forEach(input => { input.disabled = true; });
  }
  async function loadTemplates() {
    try {
      const data = await teamCatalog();
      selectedTemplateId = selectedTemplateId || data.defaultTemplateId || data.templates?.[0]?.id || 'commander-only';
      renderTemplates();
    } catch (_) {
      selectedTemplateId = 'commander-only';
      const grid = el('workspace-team-grid');
      if (grid) grid.innerHTML = `<div class="workspace-team-desc">${escapeHtml(tr('loadFailed'))}</div>`;
    }
    templatesReady = true;
    setBusy(false);
  }

  function resetDialog() {
    createdDirectory = null;
    sampleFlow = false;
    templatesReady = false;
    selectedTemplateId = '';
    suggestions = [];
    const name = el('newdir-name'); if (name) { name.value = ''; name.disabled = false; }
    const path = el('newdir-path'); if (path) { path.value = ''; path.disabled = false; }
    const create = el('newdir-create'); if (create) { create.checked = false; create.disabled = false; }
    const suggest = el('newdir-suggest'); if (suggest) { suggest.style.display = 'none'; suggest.innerHTML = ''; }
    el('newdir-modal')?.classList.remove('sample-flow');
    setStatus('');
    setBusy(false);
  }
  function openNewDirectoryModal() {
    resetDialog();
    const modal = el('newdir-modal'); if (!modal) return;
    modal.style.display = 'flex';
    loadTemplates();
    global.setTimeout(() => el('newdir-name')?.focus(), 50);
  }
  function closeNewDirectoryModal() { const modal = el('newdir-modal'); if (modal) modal.style.display = 'none'; }

  function onNewDirPathInput() {
    global.clearTimeout(suggestionTimer);
    suggestionTimer = global.setTimeout(fetchNewDirSuggestions, 180);
  }
  async function fetchNewDirSuggestions() {
    const box = el('newdir-suggest'); if (!box) return;
    try {
      const data = await api.json('/api/fs/list?path=' + encodeURIComponent(el('newdir-path')?.value || ''));
      renderNewDirSuggestions(data.entries || []);
    } catch (_) { box.style.display = 'none'; }
  }
  function renderNewDirSuggestions(entries) {
    const box = el('newdir-suggest'); if (!box) return;
    suggestions = entries;
    if (!entries.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = entries.map((entry, index) => `<button type="button" class="workspace-path-option" data-path-index="${index}">📁 ${escapeHtml(entry.name)}</button>`).join('');
    box.style.display = 'block';
    box.querySelectorAll('[data-path-index]').forEach(button => button.addEventListener('click', () => pickNewDirSuggestion(Number(button.dataset.pathIndex))));
  }
  function pickNewDirSuggestion(index) {
    const entry = suggestions[index]; if (!entry) return;
    const path = el('newdir-path'); path.value = entry.path + '/';
    const name = el('newdir-name'); if (!name.value.trim()) name.value = entry.name;
    path.focus(); fetchNewDirSuggestions();
  }

  async function provisionTeam(directory, template) {
    const roles = template.roles || [];
    const failures = [];
    for (let index = 0; index < roles.length; index++) {
      const role = roles[index];
      setStatus(tr('creatingRole', { n: index + 1, total: roles.length, role: localized(role.label) }));
      try {
        await api.json(`/api/directories/${encodeURIComponent(directory.id)}/role-workers/${encodeURIComponent(role.presetId)}`, {
          method: 'PUT', json: { label: localized(role.label) }, timeoutMs: 60000,
        });
      } catch (error) { failures.push({ role, error }); }
    }
    return failures;
  }
  async function finishSetup(directory, template) {
    const failures = await provisionTeam(directory, template);
    if (failures.length) {
      setStatus(tr('partial', { n: failures.length }), true);
      setBusy(false);
      return false;
    }
    setStatus(sampleFlow ? tr('sampleReady') : tr('ready'));
    if (typeof global.workspaceSetupDidCreate === 'function') await global.workspaceSetupDidCreate(directory);
    if (typeof global.showToast === 'function') global.showToast(sampleFlow ? tr('sampleReady') : tr('ready'));
    closeNewDirectoryModal();
    return true;
  }
  async function submitNewDirectory() {
    const dirPath = el('newdir-path')?.value.trim() || '';
    const typedName = el('newdir-name')?.value.trim() || '';
    const inferredName = dirPath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || '';
    const name = typedName || inferredName;
    if (!createdDirectory && !sampleFlow && (!name || !dirPath)) { setStatus(tr('required'), true); return; }
    setBusy(true);
    try {
      if (!createdDirectory) {
        setStatus(tr(sampleFlow ? 'creatingSample' : 'creatingWorkspace'));
        createdDirectory = sampleFlow
          ? await api.json('/api/onboarding/sample-workspace', { method: 'POST', timeoutMs: 60000 })
          : await api.json('/api/directories', {
            method: 'POST', json: { name, path: dirPath, create: !!el('newdir-create')?.checked }, timeoutMs: 60000,
          });
      }
      await finishSetup(createdDirectory, selectedTemplate());
    } catch (error) {
      setStatus(tr(sampleFlow ? 'sampleFailed' : 'failed', { error: api.errorText(error) }), true);
      setBusy(false);
    }
  }
  function createSampleWorkspace() {
    resetDialog();
    sampleFlow = true;
    const modal = el('newdir-modal'); if (modal) modal.style.display = 'flex';
    modal?.classList.add('sample-flow');
    const name = el('newdir-name'); if (name) name.value = language() === 'en' ? 'MultiCC starter sample' : 'MultiCC 入门示例';
    const path = el('newdir-path'); if (path) { path.value = language() === 'en' ? 'A safe location managed by MultiCC' : '由 MultiCC 管理的安全位置'; path.disabled = true; }
    setBusy(false);
    loadTemplates().then(() => global.setTimeout(() => el('workspace-team-grid')?.querySelector('input:checked')?.focus(), 50));
  }

  Object.assign(global, {
    openNewDirectoryModal, closeNewDirectoryModal, onNewDirPathInput,
    fetchNewDirSuggestions, renderNewDirSuggestions, pickNewDirSuggestion,
    submitNewDirectory, createSampleWorkspace,
  });
  global.MultiCCWorkspaceSetup = Object.freeze({ teamCatalog, selectedTemplate, provisionTeam });
})(window);
