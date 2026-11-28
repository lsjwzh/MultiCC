'use strict';

(function (root) {
  const document = root.document;
  const el = id => document.getElementById(id);
  const endpoint = '/api/system/agent-permissions';
  const settingsButton = el('air-remote-control-settings');
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  let api;

  function createDialog() {
    const permissionDialog = make('dialog', null, 'air-global-permission-dialog');
    permissionDialog.id = 'air-global-permission-dialog';
    const permissionTitle = make('h3', t('airGlobalPermissionsTitle'));
    const permissionBody = make('p', '', 'air-global-permission-body');
    permissionBody.id = 'air-global-permission-body';
    const permissionRecovery = make('p', t('airGlobalPermissionsRecovery'));
    permissionRecovery.id = 'air-global-permission-recovery';
    const permissionResult = make('p');
    permissionResult.id = 'air-global-permission-result';
    permissionResult.setAttribute('role', 'status');
    const permissionStatus = make('div', null, 'air-global-permission-status');
    permissionStatus.id = 'air-global-permission-status';
    const permissionTarget = make('p');
    permissionTarget.id = 'air-global-permission-target';
    const permissionActions = make('div', null, 'air-global-foot');
    const permissionOpen = make('button', t('airGlobalPermissionsOpen'));
    permissionOpen.type = 'button';
    permissionOpen.id = 'air-global-permission-open';
    permissionOpen.onclick = () => { void openAgentPermission(); };
    const permissionCheck = make('button', t('airGlobalPermissionsRecheck'));
    permissionCheck.type = 'button';
    permissionCheck.id = 'air-global-permission-check';
    permissionCheck.onclick = () => { void checkAgentPermissions(false); };
    const permissionRestart = make('button', t('airGlobalPermissionsRestart'));
    permissionRestart.type = 'button';
    permissionRestart.id = 'air-global-permission-restart';
    permissionRestart.hidden = true;
    permissionRestart.onclick = () => { void restartAgentPermissions(); };
    const permissionClose = make('button', t('airGlobalPermissionsClose'));
    permissionClose.type = 'button';
    permissionClose.onclick = () => permissionDialog.close();
    permissionActions.append(permissionOpen, permissionCheck, permissionRestart, permissionClose);
    permissionDialog.append(permissionTitle, permissionResult, permissionStatus, permissionBody,
      permissionTarget, permissionRecovery, permissionActions);

    permissionTitle.id = 'air-global-permission-title';
    permissionDialog.setAttribute('aria-labelledby', permissionTitle.id);
    document.body.append(permissionDialog);
  }

  let nextPermission = null;
  let permissionLocal = false;
  let permissionRestarting = false;
  let permissionReadEpoch = 0;
  const permissionNames = {
    accessibility: 'airGlobalPermissionsAccessibility',
    screenRecording: 'airGlobalPermissionsRecording',
  };

  function publish(data) {
    settingsButton.hidden = data.applicable !== true;
    root.dispatchEvent(new CustomEvent('multicc-agent-permissions', { detail: data }));
    return data;
  }

  async function readPermissions(request) {
    try {
      return await request(endpoint);
    } catch (error) {
      // Air's request helper throws on ok:false, including a Mac whose Agent is still starting.
      if (error.applicable === true && error.error === 'agent-unavailable') return error;
      throw error;
    }
  }

  function attach(request) {
    settingsButton.onclick = () => show(request);
    void readPermissions(request).then(publish).catch(() => {});
  }

  function show(request, autoOpen = false) {
    api = request;
    if (!el('air-global-permission-dialog')) createDialog();
    return checkAgentPermissions(autoOpen);
  }

  async function restartFromCard(request, button) {
    if (button.disabled || permissionRestarting) return;
    button.disabled = true;
    try {
      const data = await show(request);
      if (data?.local === true) await restartAgentPermissions();
      else if (data?.local === false) {
        el('air-global-permission-result').textContent = t('airGlobalPermissionsRestartLocal');
      }
    } finally { button.disabled = false; }
  }

  async function restartAgentPermissions() {
    if (!permissionLocal || permissionRestarting) return;
    permissionRestarting = true;
    permissionReadEpoch++;
    const dialog = el('air-global-permission-dialog');
    const buttons = ['restart', 'restart-direct', 'check', 'open']
      .map(name => el('air-global-permission-' + name)).filter(Boolean);
    buttons.forEach(button => { button.disabled = true; });
    el('air-global-permission-result').textContent = t('airGlobalPermissionsRestarting');
    try {
      const data = await api(endpoint + '/restart', {}, 'POST');
      if (dialog !== el('air-global-permission-dialog')) return;
      if (!data.ok) throw new Error(data.error || t('airGlobalPermissionsAgentUnavailable'));
      await checkAgentPermissions(false, data);
      el('air-global-permission-result').textContent = t('airGlobalPermissionsRestarted');
    } catch (error) {
      if (dialog !== el('air-global-permission-dialog')) return;
      el('air-global-permission-result').textContent = t('airGlobalPermissionsRestartFailed', { message: error.message });
    } finally {
      permissionRestarting = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  async function openAgentPermission() {
    if (!nextPermission || !permissionLocal) return;
    const permission = nextPermission;
    const epoch = permissionReadEpoch;
    const button = el('air-global-permission-open');
    button.disabled = true;
    try {
      await api(endpoint + '/open', { permission }, 'POST');
      if (epoch !== permissionReadEpoch) return;
      el('air-global-permission-body').textContent = t('airGlobalPermissionsGuide', {
        name: t(permissionNames[permission]),
      });
    } catch (error) {
      if (epoch === permissionReadEpoch) {
        el('air-global-permission-body').textContent = t('airGlobalPermissionsOpenFailed', { message: error.message });
      }
    } finally { button.disabled = false; }
  }

  async function checkAgentPermissions(autoOpen, snapshot) {
    const dialog = el('air-global-permission-dialog');
    if (!dialog) return;
    const epoch = ++permissionReadEpoch;
    el('air-global-permission-result').textContent = '';
    el('air-global-permission-status').replaceChildren();
    el('air-global-permission-target').textContent = '';
    el('air-global-permission-recovery').hidden = false;
    let checked = null;
    try {
      const data = snapshot || await readPermissions(api);
      if (epoch !== permissionReadEpoch || dialog !== el('air-global-permission-dialog')) return;
      checked = publish(data);
      permissionLocal = data.local === true;
      el('air-global-permission-restart').hidden = !permissionLocal || data.applicable === false;
      el('air-global-permission-target').textContent = data.agentApp
        ? t('airGlobalPermissionsTarget', { path: data.agentApp }) : '';
      if (!data.ok) {
        nextPermission = null;
        el('air-global-permission-body').textContent = t('airGlobalPermissionsAgentUnavailable');
      } else if (data.applicable === false) {
        nextPermission = null;
        if (dialog.open) dialog.close();
        return;
      } else {
        for (const [key, label] of Object.entries(permissionNames)) {
          const row = make('span', `${t(label)}：${t(data[key] === true ? 'airGlobalPermissionsGranted'
            : data[key] === false ? 'airGlobalPermissionsNotDetected' : 'airGlobalPermissionsUnknown')}`);
          row.dataset.permission = key;
          el('air-global-permission-status').append(row);
        }
        nextPermission = !data.accessibility ? 'accessibility' : !data.screenRecording
          ? 'screenRecording' : null;
        const ready = !nextPermission;
        el('air-global-permission-recovery').hidden = ready;
        el('air-global-permission-body').textContent = nextPermission
          ? t(data.local ? 'airGlobalPermissionsMissing' : 'airGlobalPermissionsLocal', { name: t(permissionNames[nextPermission]) })
          : t('airGlobalPermissionsDesktopReady');
        if (autoOpen && ready) { if (dialog.open) dialog.close(); return; }
        if (autoOpen && data.local && nextPermission) await openAgentPermission();
      }
    } catch (error) {
      if (epoch !== permissionReadEpoch || dialog !== el('air-global-permission-dialog')) return;
      nextPermission = null;
      permissionLocal = false;
      el('air-global-permission-restart').hidden = true;
      el('air-global-permission-body').textContent = t('airGlobalPermissionsCheckFailed', { message: error.message });
    }
    el('air-global-permission-open').hidden = !nextPermission || !permissionLocal;
    if (!dialog.open) dialog.showModal();
    return checked;
  }

  root.MultiCCAirAgentPermissions = { attach, show, restartFromCard };
})(window);
