'use strict';

(function initWorkspaceSetup(global) {
  if (!global || !global.MultiCCApi) throw new Error('Workspace setup dependencies are unavailable');

  const api = global.MultiCCApi;
  let suggestionTimer = null;
  let suggestions = [];
  let createdDirectory = null;
  let sampleFlow = false;

  const copy = {
    zh: {
      preparing: '正在准备工作区…', creatingWorkspace: '正在验证路径并创建工作区…', creatingSample: '正在创建安全示例工作区…',
      ready: '工作目录已准备完成',
      retry: '继续', create: '创建工作目录', sampleCreate: '创建示例工作目录', sampleReady: '示例工作区已准备完成',
      required: '请选择本地路径。',
      sampleFailed: '示例工作区创建失败：{error}', failed: '工作区创建失败：{error}',
    },
    en: {
      preparing: 'Preparing workspace…', creatingWorkspace: 'Validating the path and creating the workspace…', creatingSample: 'Creating the safe sample workspace…',
      ready: 'Workspace is ready',
      retry: 'Continue', create: 'Create workspace', sampleCreate: 'Create sample workspace', sampleReady: 'Sample workspace is ready',
      required: 'Choose a local path.',
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
    if (submit) { submit.disabled = busy; submit.textContent = busy ? tr('preparing') : (createdDirectory ? tr('retry') : tr(sampleFlow ? 'sampleCreate' : 'create')); }
  }

  function resetDialog() {
    createdDirectory = null;
    sampleFlow = false;
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

  async function finishSetup(directory) {
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
      await finishSetup(createdDirectory);
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
    global.setTimeout(() => el('newdir-submit')?.focus(), 50);
  }

  Object.assign(global, {
    openNewDirectoryModal, closeNewDirectoryModal, onNewDirPathInput,
    fetchNewDirSuggestions, renderNewDirSuggestions, pickNewDirSuggestion,
    submitNewDirectory, createSampleWorkspace,
  });
})(window);
