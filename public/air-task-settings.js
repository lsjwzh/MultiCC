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
  };

  function renderFix(container, fix) {
    const action = FIX_ACTIONS[fix];
    if (!action) return;
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
      catch (e) { error.textContent = e.message; if (e.fix) renderFix(fixBox, e.fix); }
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
      throw failure;
    }
    return result;
  }
  window.MultiCCAirSettings = {
    directory(onSaved) {
      dialog(t('airTaskSettingsAddDirectory'), form => {
        const name = field(form, t('airTaskSettingsName')), path = field(form, t('airTaskSettingsAbsolutePath')); name.required = path.required = true;
        name.maxLength = 100; path.placeholder = '/Users/you/projects/example';
        const create = node('input'); create.type = 'checkbox'; create.checked = true;
        const createLabel = node('label', t('airTaskSettingsCreateIfMissing')); createLabel.prepend(create);
        form.append(createLabel);
        form.append(node('p', t('airTaskSettingsAddDirectoryNote')));
        return async () => { const result = await request('/api/directories', { name: name.value, path: path.value, create: create.checked }); await onSaved(result); };
      });
    },
  };
})();
