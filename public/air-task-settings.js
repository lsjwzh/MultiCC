(function () {
  'use strict';

  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  // Some failures have exactly one command that repairs them. Rather than
  // printing it and hoping the user opens a terminal, render the button that
  // runs it — on macOS `xcode-select --install` only raises the system's own
  // "Install" dialog, so the click the user makes is still the deciding one.
  const FIX_ACTIONS = {
    'install-developer-tools': {
      label: () => t('airTaskSettingsInstallDevTools'),
      url: '/api/system/developer-tools/install',
      message: result => (result.status === 'already-installed'
        ? t('airTaskSettingsInstallDevToolsInstalled')
        : result.status === 'already-requested'
          ? t('airTaskSettingsInstallDevToolsPending')
          : t('airTaskSettingsInstallDevToolsRequested')),
      failure: () => t('airTaskSettingsInstallDevToolsFailed'),
    },
    // macOS privacy cannot be granted programmatically — only the user, in
    // System Settings, can do it. The button opens the right pane and then
    // names the exact program to add, which is the part people get wrong.
    'open-disk-access': {
      label: () => t('airTaskSettingsOpenDiskAccess'),
      url: '/api/system/disk-access/open',
      working: () => t('airTaskSettingsOpenDiskAccessWorking'),
      message: () => t('airTaskSettingsOpenDiskAccessOpened'),
      failure: () => t('airTaskSettingsOpenDiskAccessFailed'),
      detail: async () => {
        const info = await request('/api/system/disk-access', undefined, 'GET');
        return info && info.target ? t('airTaskSettingsOpenDiskAccessTarget') + info.target : null;
      },
    },
    // None has a one-shot endpoint: installing git depends on the host's
    // package manager and on privileges the service may lack, and an unknown
    // git failure needs a look first. The button opens the ops terminal panel
    // (air-ops-terminal.js), which probes the host, pre-fills the next repair
    // and offers to retry this dialog once the environment is ready.
    'fix-git-missing': { label: () => t('airTaskSettingsFixGitMissing'), opensTerminal: true },
    'fix-git-identity': { label: () => t('airTaskSettingsFixGitIdentity'), opensTerminal: true },
    'open-ops-terminal': { label: () => t('airTaskSettingsOpenOpsTerminal'), opensTerminal: true },
  };

  function renderFix(container, fix, retry, context) {
    const action = FIX_ACTIONS[fix];
    if (!action) return;
    if (action.opensTerminal) {
      const wrap = node('p', null, 'air-fix-action');
      const button = node('button', action.label());
      button.type = 'button';
      button.onclick = () => window.MultiCCAirOps?.open({ retry, context });
      wrap.append(button);
      container.append(wrap);
      return;
    }
    const wrap = node('p', null, 'air-fix-action');
    const button = node('button', action.label());
    button.type = 'button';
    const status = node('span', '', 'air-fix-status');
    const detail = node('code', '', 'air-fix-detail');
    button.onclick = async () => {
      button.disabled = true;
      status.textContent = (action.working || (() => t('airTaskSettingsInstallDevToolsWorking')))();
      try {
        const result = await request(action.url, {});
        status.textContent = action.message(result);
        // Best-effort: the action already succeeded, so a detail lookup that
        // fails must not turn it into a reported failure.
        if (action.detail) {
          try { detail.textContent = (await action.detail()) || ''; } catch { detail.textContent = ''; }
        }
      } catch (cause) {
        // Keep the button live: a headless launchd host cannot draw the system
        // dialog, and the user may want to retry after starting MultiCC from a
        // logged-in session.
        button.disabled = false;
        status.textContent = cause.message || action.failure();
      }
    };
    wrap.append(button, status, detail);
    container.append(wrap);
  }

  // Any refusal the server explains can go to the AI Assistant's model, which
  // reads the host the way someone on SSH would and answers with commands for
  // the repair terminal (src/doctor/environment.js) — the fixed buttons above
  // only cover the failures that have one known remedy.
  function renderDiagnose(container, context, retry) {
    if (!window.MultiCCAirOps) return;
    const button = node('button', t('airTaskSettingsAiDiagnose'));
    button.type = 'button';
    button.title = t('airOpsDoctorPrivacy');
    button.onclick = () => window.MultiCCAirOps.open({ retry, context, diagnose: true });
    const row = container.querySelector('.air-fix-action');
    if (row) { row.firstElementChild.after(button); return; }
    const wrap = node('p', null, 'air-fix-action');
    wrap.append(button);
    container.append(wrap);
  }

  function dialog(title, build) {
    const d = node('dialog'), form = node('form'), error = node('p'), fixBox = node('div');
    error.setAttribute('role', 'alert');
    const cancel = node('button', t('airTaskSettingsCancel')), submit = node('button', t('airTaskSettingsSave'));
    cancel.type = 'button'; submit.className = 'primary';
    cancel.onclick = () => d.close(); form.append(node('h2', title));
    const save = build(form); form.append(error, fixBox, cancel, submit);
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; error.textContent = ''; fixBox.replaceChildren();
      try { await save(); d.close(); }
      catch (e) {
        error.textContent = e.message;
        const retry = () => form.requestSubmit();
        if (e.fix) renderFix(fixBox, e.fix, retry, e.diagnose);
        if (e.diagnose) renderDiagnose(fixBox, e.diagnose, retry);
      }
      finally { submit.disabled = false; }
    };
    d.onclose = () => d.remove(); d.append(form); document.body.append(d); d.showModal();
  }

  function field(form, title, tag = 'input') {
    const label = node('label', title), input = node(tag);
    label.append(input); form.append(label); return input;
  }

  async function request(url, body, method = 'POST') {
    const options = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const raw = await response.text();
    let result = {};
    try { result = raw ? JSON.parse(raw) : {}; }
    catch (_) { throw new Error(t('airTaskSettingsBadResponse', { status: response.status })); }
    if (!response.ok || result.ok === false) {
      const failure = new Error(result.message || result.error || result.code || t('airTaskSettingsRequestFailed', { status: response.status }));
      // Server-named remedy (see src/directory/service.js). Carried on the Error
      // so the dialog can offer a button instead of prose the user must retype.
      if (result.fix) failure.fix = result.fix;
      failure.status = response.status;
      throw failure;
    }
    return result;
  }

  // Browses directories on the machine running MultiCC. A browser-native
  // directory picker would browse the phone/laptop viewing this page instead,
  // which is the wrong filesystem whenever Air is opened remotely.
  function attachFolderPicker(pathInput, nameInput) {
    const label = pathInput.closest('label');
    const row = node('div', null, 'air-path-row');
    const choose = node('button', t('airTaskSettingsBrowseFolders'));
    choose.type = 'button'; choose.setAttribute('aria-expanded', 'false');
    pathInput.replaceWith(row); row.append(pathInput, choose);

    const panel = node('div', null, 'air-folder-picker');
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', t('airTaskSettingsBrowseFolders'));
    const location = node('code', '', 'air-folder-location');
    const up = node('button', t('airTaskSettingsFolderUp'));
    const use = node('button', t('airTaskSettingsUseFolder'), 'primary');
    up.type = use.type = 'button';
    const actions = node('div', null, 'air-folder-actions');
    actions.append(up, use);
    const bar = node('div', null, 'air-folder-bar');
    bar.append(location, actions);
    const list = node('div', null, 'air-folder-list');
    panel.append(bar, list);
    label.after(panel);

    let generation = 0;
    let currentBase = '';
    let currentParent = null;
    const close = () => {
      panel.hidden = true;
      choose.setAttribute('aria-expanded', 'false');
    };
    const browse = async (target, syncInput) => {
      const mine = ++generation;
      list.replaceChildren(node('p', t('airTaskSettingsFoldersLoading'), 'air-folder-empty'));
      try {
        const result = await request(`/api/fs/list?path=${encodeURIComponent(target || '')}`, undefined, 'GET');
        if (mine !== generation) return;
        currentBase = result.base || '';
        currentParent = result.parent || null;
        location.textContent = currentBase;
        location.title = currentBase;
        up.disabled = !currentParent;
        use.disabled = !currentBase || result.selectable === false;
        if (syncInput && currentBase) pathInput.value = currentBase;
        list.replaceChildren();
        for (const entry of result.entries || []) {
          const button = node('button');
          button.type = 'button'; button.className = 'air-folder-entry';
          button.title = entry.path;
          button.append(node('span', '📁', 'air-folder-icon'), node('span', entry.name));
          button.onclick = () => browse(entry.path, true);
          list.append(button);
        }
        if (!list.children.length) {
          list.append(node('p', t('airTaskSettingsNoSubfolders'), 'air-folder-empty'));
        }
      } catch (error) {
        if (mine !== generation) return;
        currentBase = ''; currentParent = null;
        location.textContent = '';
        up.disabled = use.disabled = true;
        list.replaceChildren(node('p', t('airTaskSettingsFolderLoadFailed', { message: error.message }), 'air-folder-error'));
      }
    };

    choose.onclick = () => {
      if (!panel.hidden) { close(); return; }
      panel.hidden = false;
      choose.setAttribute('aria-expanded', 'true');
      browse(pathInput.value.trim(), false);
    };
    up.onclick = () => { if (currentParent) browse(currentParent, true); };
    use.onclick = () => {
      if (!currentBase) return;
      pathInput.value = currentBase;
      if (!nameInput.value.trim()) {
        const leaf = currentBase.split(/[\\/]/).filter(Boolean).pop();
        if (leaf) nameInput.value = leaf;
      }
      close();
      pathInput.focus();
    };
  }

  window.MultiCCAirSettings = {
    directory(onSaved, { example = false } = {}) {
      dialog(t('airTaskSettingsAddDirectory'), form => {
        const name = field(form, t('airTaskSettingsName')), path = field(form, t('airTaskSettingsAbsolutePath')); name.required = path.required = true;
        name.maxLength = 100; path.placeholder = '/Users/you/projects/example';
        attachFolderPicker(path, name);
        if (example) {
          name.value = t('airExampleProject');
          void request('/api/fs/list', undefined, 'GET').then(result => {
            if (result.base && !path.value) path.value = result.base.replace(/\/$/, '') + '/MultiCC-Example';
          }).catch(() => { path.placeholder = t('airTaskSettingsAbsolutePath'); });
        }
        const create = node('input'); create.type = 'checkbox'; create.checked = true;
        const createLabel = node('label', t('airTaskSettingsCreateIfMissing')); createLabel.prepend(create);
        form.append(createLabel);
        form.append(node('p', t('airTaskSettingsAddDirectoryNote')));
        return async () => {
          let result;
          try { result = await request('/api/directories', { name: name.value, path: path.value, create: create.checked }); }
          catch (e) {
            // Only a refusal the server explained is worth diagnosing; a lost
            // connection has no failure text to reason about.
            if (e.status) e.diagnose = { error: e.message, path: path.value.trim(), fix: e.fix || '' };
            throw e;
          }
          await onSaved(result);
        };
      });
    },
  };
})();
