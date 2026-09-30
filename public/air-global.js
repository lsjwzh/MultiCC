'use strict';

// Native global settings. Password setup is shared by both macOS switches;
// only server-confirmed state is displayed, and credentials are kept on disable.
(function initAirGlobal(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  // render(host, context) 每进一次面板就重建 DOM，回调里要用的 context 只能存在模块上
  // （同 air-secrets.js）：它由 air.js 每次渲染递进来。
  let context = null;
  let setupFromShortcut = null;
  let styleNode = null;

  // 样式跟模块走：这页是后加的，不去动 air.css（那份是外壳和各面板共用的）。
  // 颜色只用 Air v2 的词表（--hairline / --muted / --faint / --shadow-1）。
  function injectStyle(host) {
    if (!styleNode) {
      styleNode = document.createElement('style');
      styleNode.textContent = `
        .air-global-hint { padding: 13px 15px; text-align: left; line-height: 1.6; }
        .air-global-card { display: grid; gap: 11px; }
        /* 风险告知是这一页唯一一段长正文，也是唯一必须被读完的一段：
           字号压到跟注释同级、行距放到 1.65，但颜色不能淡到看不见。 */
        .air-global-risk { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.65; white-space: pre-line; }
        .air-global-risk code { padding: 1px 4px; border: 1px solid var(--hairline); border-radius: 5px;
          background: #f7fafd; font-family: var(--mono, monospace); font-size: 10px; }
        .air-global-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .air-global-toggle { display: inline-flex; align-items: center; gap: 8px; color: #2f536f;
          font-size: 12px; font-weight: 650; cursor: pointer; }
        .air-global-toggle input { width: auto; margin: 0; }
        .air-global-toggle:has(input:disabled) { color: var(--faint); cursor: default; }
        .air-global-desc { margin: 0; color: var(--faint); font-size: 10.5px; line-height: 1.6; }
        .air-global-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .air-global-foot button { min-height: 32px; padding: 5px 11px; font-size: 11px; }
        .air-global-status { min-width: 0; color: var(--faint); font-size: 10.5px; overflow-wrap: anywhere; }
        .air-global-status.ok { color: #2f7d52; }
        .air-global-status.err { color: #b34b34; }
        /* 两条设置之间只隔一条细线：允许自动解锁是同一张卡里的第二件事，那张卡的抬头
           （MACOS）同时罩着两条，所以它不该再画一张自己的卡。 */
        .air-global-sep { padding-top: 4px; border-top: 1px solid var(--hairline); }
        .air-global-block { display: grid; gap: 7px; }
        #air-global-unlock-password { width: auto; min-width: 0; flex: 1 1 240px; }
        .air-global-permission-dialog { max-width: min(460px, calc(100vw - 28px)); border: 1px solid var(--hairline);
          border-radius: 14px; padding: 22px; color: #25445e; box-shadow: 0 16px 50px rgba(18,45,70,.22); }
        .air-global-permission-dialog::backdrop { background: rgba(14,32,48,.48); }
        .air-global-permission-dialog h3 { margin: 0 0 8px; }
        .air-global-permission-dialog p { line-height: 1.6; }
        .air-global-permission-dialog .air-global-foot { margin-top: 15px; }
      `;
    }
    host.append(styleNode); // replaceChildren 会把它一起清掉，每次重绘都挂回去
  }

  // 抬头那一行的右侧格子永远留着：两块卡各自的「实时状态」都写在这里（OAuth 写
  // 已开启/已关闭，关盖运行写平台标），值由 load 填。
  function card(eyebrow, titleText, noteText) {
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    title.append(make('span', eyebrow, 'eyebrow'), make('h3', titleText));
    const note = make('span', noteText == null ? '' : noteText, 'admin-panel-note');
    head.append(title, note);
    return { head, note };
  }

  // ── 电源：只有两条对外设置（关盖运行、允许自动解锁） ──────────────────────
  function powerCard() {
    const panel = make('section', null, 'admin-panel air-global-card');
    panel.id = 'air-global-power-card';
    // 先藏起来：非 macOS 上这张卡根本不该出现，而 available 只有服务端说得清。
    panel.hidden = true;
    const { head, note } = card('MACOS', t('airGlobalPowerTitle'), t('airGlobalPowerPlatform'));
    note.id = 'air-global-power-platform';

    const toggle = make('input');
    toggle.type = 'checkbox';
    toggle.id = 'air-global-power-toggle';
    toggle.disabled = true;
    toggle.onchange = () => { void togglePower(); };
    const label = make('label', null, 'air-global-toggle');
    label.append(toggle, make('span', t('airGlobalPowerToggle')));

    const refresh = make('button', t('airGlobalPowerRefresh'));
    refresh.type = 'button';
    refresh.id = 'air-global-power-refresh';
    refresh.onclick = () => { void loadPower(); };
    const status = make('span', '', 'air-global-status');
    status.id = 'air-global-power-status';
    const foot = make('div', null, 'air-global-foot');
    foot.append(refresh, status);
    const permissionButton = make('button', t('airGlobalPermissionsButton'));
    permissionButton.type = 'button';
    permissionButton.id = 'air-global-permissions-button';
    permissionButton.hidden = true;
    permissionButton.onclick = () => { void checkAgentPermissions(true); };
    const permissionDialog = make('dialog', null, 'air-global-permission-dialog');
    permissionDialog.id = 'air-global-permission-dialog';
    const permissionTitle = make('h3', t('airGlobalPermissionsTitle'));
    const permissionBody = make('p', '', 'air-global-permission-body');
    permissionBody.id = 'air-global-permission-body';
    const permissionActions = make('div', null, 'air-global-foot');
    const permissionOpen = make('button', t('airGlobalPermissionsOpen'));
    permissionOpen.type = 'button';
    permissionOpen.id = 'air-global-permission-open';
    permissionOpen.onclick = () => { void openAgentPermission(); };
    const permissionCheck = make('button', t('airGlobalPermissionsRecheck'));
    permissionCheck.type = 'button';
    permissionCheck.id = 'air-global-permission-check';
    permissionCheck.onclick = () => { void checkAgentPermissions(false); };
    const permissionClose = make('button', t('airGlobalPermissionsClose'));
    permissionClose.type = 'button';
    permissionClose.onclick = () => permissionDialog.close();
    permissionActions.append(permissionOpen, permissionCheck, permissionClose);
    permissionDialog.append(permissionTitle, permissionBody, permissionActions);

    // Password setup is shared by both switches; saved credentials survive disabling.
    const unlockToggle = make('input');
    unlockToggle.type = 'checkbox';
    unlockToggle.id = 'air-global-unlock-toggle';
    unlockToggle.disabled = true;
    unlockToggle.onchange = () => { void toggleUnlock(); };
    const unlockLabel = make('label', null, 'air-global-toggle');
    unlockLabel.append(unlockToggle, make('span', t('airGlobalUnlockToggle')));

    const unlockBlock = make('div', null, 'air-global-block');
    unlockBlock.id = 'air-global-unlock-block';
    unlockBlock.hidden = true;
    const pwInput = make('input');
    pwInput.type = 'password';
    pwInput.id = 'air-global-unlock-password';
    pwInput.placeholder = t('airGlobalUnlockPlaceholder');
    pwInput.autocomplete = 'off';
    pwInput.onkeydown = (event) => { if (event.key === 'Enter') void saveUnlockPassword(); };
    const saveBtn = make('button', t('airGlobalUnlockSave'));
    saveBtn.type = 'button';
    saveBtn.id = 'air-global-unlock-save';
    saveBtn.onclick = () => { void saveUnlockPassword(); };
    // 授权那一次没点上（人没看见框，或者点晚了）时的重试：条目已经在钥匙串里，所以
    // **不用重输密码** —— 再问一次就是把那个系统框再弹一次。
    const authorizeBtn = make('button', t('airGlobalUnlockAuthorize'));
    authorizeBtn.type = 'button';
    authorizeBtn.id = 'air-global-unlock-authorize';
    authorizeBtn.onclick = () => { void authorizeUnlockPassword(); };
    const unlockStatus = make('span', '', 'air-global-status');
    unlockStatus.id = 'air-global-unlock-status';
    const unlockRow = make('div', null, 'air-global-foot');
    const cancel = make('button', t('airGlobalUnlockCancel'));
    cancel.type = 'button';
    cancel.id = 'air-global-unlock-cancel';
    cancel.onclick = cancelPassword;
    unlockRow.append(pwInput, saveBtn, cancel);
    unlockBlock.append(unlockRow);
    authorizeBtn.hidden = true;
    const change = make('button', t('airGlobalUnlockChange'));
    change.type = 'button';
    change.id = 'air-global-unlock-change';
    change.onclick = () => requestPassword('change');
    const forget = make('button', t('airGlobalUnlockForget'));
    forget.type = 'button';
    forget.id = 'air-global-unlock-forget';
    forget.onclick = () => { void forgetPassword(); };
    const unlockFoot = make('div', null, 'air-global-foot');
    unlockFoot.append(unlockStatus, authorizeBtn, change, forget);

    panel.append(
      head,
      label,
      make('p', t('airGlobalPowerDesc'), 'air-global-desc'),
      foot,
      permissionButton,
      permissionDialog,
      make('div', null, 'air-global-sep'),
      unlockLabel,
      make('p', t('airGlobalUnlockDesc'), 'air-global-desc'),
      unlockBlock,
      unlockFoot,
    );
    return panel;
  }

  let powerState = null;
  let powerBusy = false;
  let pendingPowerAction = null;
  let nextPermission = null;
  let permissionLocal = false;

  async function openAgentPermission() {
    if (!nextPermission) return;
    const button = el('air-global-permission-open');
    button.disabled = true;
    try {
      await context.api('/api/system/agent-permissions/open', { permission: nextPermission }, 'POST');
      el('air-global-permission-body').textContent = t('airGlobalPermissionsGuide', {
        name: nextPermission === 'accessibility' ? t('airGlobalPermissionsAccessibility') : t('airGlobalPermissionsRecording'),
      });
    } catch (error) {
      el('air-global-permission-body').textContent = t('airGlobalPermissionsOpenFailed', { message: error.message });
    } finally { button.disabled = false; }
  }

  async function checkAgentPermissions(autoOpen) {
    const dialog = el('air-global-permission-dialog');
    if (!dialog) return;
    try {
      const data = await context.api('/api/system/agent-permissions');
      permissionLocal = data.local === true;
      if (!data.ok) {
        nextPermission = null;
        el('air-global-permission-body').textContent = t('airGlobalPermissionsAgentUnavailable');
      } else if (data.accessibility && data.screenRecording) {
        nextPermission = null;
        if (dialog.open) dialog.close();
        return;
      } else {
        nextPermission = !data.accessibility ? 'accessibility' : 'screenRecording';
        const name = nextPermission === 'accessibility'
          ? t('airGlobalPermissionsAccessibility') : t('airGlobalPermissionsRecording');
        el('air-global-permission-body').textContent = data.local
          ? t('airGlobalPermissionsMissing', { name }) : t('airGlobalPermissionsLocal', { name });
        if (autoOpen && data.local) await openAgentPermission();
      }
    } catch (error) {
      nextPermission = null;
      permissionLocal = false;
      el('air-global-permission-body').textContent = t('airGlobalPermissionsCheckFailed', { message: error.message });
    }
    el('air-global-permission-open').hidden = !nextPermission || !permissionLocal;
    if (!dialog.open) dialog.showModal();
  }

  function setPowerBusy(busy) {
    powerBusy = busy;
    for (const id of ['power-toggle', 'unlock-toggle', 'power-refresh', 'unlock-save', 'unlock-authorize', 'unlock-change', 'unlock-forget', 'unlock-cancel']) {
      const node = el('air-global-' + id);
      if (node) node.disabled = busy;
    }
    if (!busy && powerState) paintUnlock(powerState.unlockPassword);
  }

  function paintPower(data, broadcast = true) {
    powerState = data;
    if (broadcast) root.dispatchEvent(new CustomEvent("multicc-power-changed", { detail: data }));
    const panel = el('air-global-power-card');
    panel.hidden = data.available === false;
    const toggle = el('air-global-power-toggle');
    toggle.checked = !!data.enabled;
    toggle.disabled = powerBusy || !!data.error;
    const status = el('air-global-power-status');
    status.textContent = data.error ? t('airGlobalPowerReadFailed', { message: data.error }) : t(data.enabled ? 'airGlobalPowerOn' : 'airGlobalPowerOff');
    if (!data.error && !data.enabled && data.systemSleepDisabled) status.textContent = t('airGlobalPowerExternal');
    status.className = 'air-global-status' + (data.error ? ' err' : data.enabled ? ' ok' : '');
    el('air-global-permissions-button').hidden = !data.enabled;
    paintUnlock(data.unlockPassword);
  }

  async function loadPower() {
    if (powerBusy) return;
    try { paintPower(await context.api('/api/settings/power')); }
    catch (error) {
      const panel = el('air-global-power-card');
      panel.hidden = false;
      el('air-global-power-toggle').disabled = true;
      el('air-global-unlock-toggle').disabled = true;
      el('air-global-power-status').textContent = t('airGlobalPowerReadFailed', { message: error.message });
    }
  }

  const AUTHORIZATION_TEXT = {
    authorized: 'airGlobalUnlockAuthorized',
    'waiting-for-user': 'airGlobalUnlockWaitAuthorize',
    'no-password': 'airGlobalUnlockNotStored',
    unavailable: 'airGlobalUnlockProbeUnknown',
  };
  // Agent 自身坏了（没执行权限 / 没装 / 版本老）时，点多少次「检查授权」都不会好，
  // 指引必须换成「重启 MultiCC 会自动修」——否则用户会在这个按钮上一直打转。
  const RESTART_FIXES = {
    'agent-not-executable': 'airGlobalUnlockAgentBroken',
    'agent-not-installed': 'airGlobalUnlockAgentMissing',
    'agent-update-required': 'airGlobalUnlockAgentOutdated',
  };
  function paintAuthorization(authorization) {
    const state = authorization?.state || 'unavailable';
    const restartFixesIt = !!RESTART_FIXES[authorization?.detail];
    const status = el('air-global-unlock-status');
    status.textContent = t(RESTART_FIXES[authorization?.detail]
      || AUTHORIZATION_TEXT[state] || AUTHORIZATION_TEXT.unavailable);
    status.className = 'air-global-status' + (state === 'authorized' ? ' ok' : ' err');
    el('air-global-unlock-authorize').hidden = state === 'authorized' || restartFixesIt
      || powerState?.unlockPassword?.canEdit === false;
  }

  function paintUnlock(value) {
    const toggle = el('air-global-unlock-toggle');
    const required = !!powerState?.enabled;
    toggle.checked = !!value?.enabled;
    toggle.disabled = powerBusy || !value?.available || !!value.error || required;
    const status = el('air-global-unlock-status');
    if (!pendingPowerAction) {
      status.className = 'air-global-status' + (value?.error ? ' err' : value?.enabled ? ' ok' : '');
      status.textContent = t(value?.error ? 'airGlobalUnlockUnreadable' : required && !value?.set ? 'airGlobalUnlockNeedPassword' : required ? 'airGlobalUnlockIncluded' : value?.enabled ? 'airGlobalUnlockSaved' : 'airGlobalUnlockOff');
      el('air-global-unlock-block').hidden = true;
    }
    const local = value?.canEdit !== false;
    el('air-global-unlock-change').hidden = !local || (!value?.set && !required);
    el('air-global-unlock-forget').hidden = !local || !value?.set || required || !!value?.enabled;
  }

  function requestPassword(action) {
    if (powerState?.unlockPassword?.canEdit === false) {
      el('air-global-unlock-status').textContent = t('airGlobalUnlockLocal');
      return;
    }
    pendingPowerAction = action;
    el('air-global-unlock-block').hidden = false;
    el('air-global-unlock-authorize').hidden = !powerState?.unlockPassword?.set;
    el('air-global-unlock-status').textContent = t('airGlobalUnlockNeedPassword');
    el('air-global-unlock-password').focus();
  }

  function cancelPassword() {
    if (powerBusy) return;
    pendingPowerAction = null;
    el('air-global-unlock-password').value = '';
    el('air-global-unlock-authorize').hidden = true;
    paintPower(powerState);
  }

  async function applyPower(action, enabled) {
    if (powerBusy) return;
    if (enabled && !powerState?.unlockPassword?.set) {
      paintPower(powerState); // Neither switch is on until setup finishes.
      requestPassword(action);
      return;
    }
    setPowerBusy(true);
    el('air-global-power-status').textContent = t('airGlobalPowerWaiting');
    let failure = null;
    try {
      const path = action === 'lid' ? '/api/settings/power' : '/api/settings/power/auto-unlock';
      paintPower(await context.api(path, { enabled }));
      pendingPowerAction = null;
    } catch (error) {
      // A timeout may follow a successful change: re-read instead of guessing.
      try { paintPower(await context.api('/api/settings/power')); } catch (_) { /* keep last known state */ }
      failure = error;
      pendingPowerAction = enabled && error.code === 'unlock_authorization_required' ? action : null;
    } finally { setPowerBusy(false); }
    if (failure) {
      el('air-global-power-status').textContent = t('airGlobalPowerFailed', { message: failure.message });
      el('air-global-power-status').className = 'air-global-status err';
      el('air-global-unlock-authorize').hidden = !pendingPowerAction || powerState?.unlockPassword?.canEdit === false;
    } else if (action === 'lid' && enabled && powerState?.enabled) {
      await checkAgentPermissions(true);
    }
  }

  async function togglePower() {
    await applyPower('lid', el('air-global-power-toggle').checked);
  }
  async function toggleUnlock() {
    await applyPower('unlock', el('air-global-unlock-toggle').checked);
  }

  async function finishPasswordSetup(data) {
    if (data?.authorization?.state !== 'authorized') {
      paintAuthorization(data?.authorization);
      return;
    }
    const action = pendingPowerAction;
    pendingPowerAction = null;
    el('air-global-unlock-block').hidden = true;
    if (action && action !== 'change') await applyPower(action, true);
    else { await loadPower(); paintAuthorization(data.authorization); }
  }

  async function saveUnlockPassword() {
    if (powerBusy) return;
    const input = el('air-global-unlock-password');
    if (!input.value) { input.focus(); return; }
    const password = input.value;
    input.value = ''; // Never retain the password in the DOM after submitting.
    setPowerBusy(true);
    el('air-global-unlock-status').textContent = t('airGlobalPowerWaiting');
    let data;
    try {
      data = await context.api('/api/settings/power/unlock-password', { password }, 'POST');
      powerState.unlockPassword.set = !!data.set;
    } catch (error) {
      el('air-global-unlock-status').textContent = t('airGlobalUnlockFailed', { message: error.message });
      el('air-global-unlock-status').className = 'air-global-status err';
    } finally { setPowerBusy(false); }
    if (data) await finishPasswordSetup(data);
  }

  async function authorizeUnlockPassword() {
    if (powerBusy) return;
    setPowerBusy(true);
    let data;
    try { data = await context.api('/api/settings/power/unlock-password/authorize', {}); }
    catch (error) { el('air-global-unlock-status').textContent = t('airGlobalUnlockFailed', { message: error.message }); }
    finally { setPowerBusy(false); }
    if (data) await finishPasswordSetup(data);
  }

  async function forgetPassword() {
    if (powerBusy) return;
    setPowerBusy(true);
    let error;
    try { await context.api('/api/settings/power/unlock-password', undefined, 'DELETE'); }
    catch (failure) { error = failure; }
    finally { setPowerBusy(false); }
    await loadPower();
    if (error) el('air-global-unlock-status').textContent = t('airGlobalUnlockFailed', { message: error.message });
  }

  function load() {
    return loadPower();
  }

  function beginPowerSetup(action) {
    if (!action || !powerState) return;
    if (action === 'permissions') { void checkAgentPermissions(true); return; }
    if (!powerState.unlockPassword?.set) requestPassword(action);
    else {
      pendingPowerAction = action;
      paintAuthorization({ state: 'waiting-for-user' });
    }
  }

  function render(host, ctx) {
    context = ctx;
    pendingPowerAction = null;
    powerState = null;
    powerBusy = false;
    // 安装包（APK / iOS OTA）不在这页重复第二遍 —— 见文件头。这里只留一句指路。
    const install = make('section', null, 'admin-panel');
    install.append(make('p', t('airGlobalInstallHint'), 'admin-empty air-global-hint'));
    host.replaceChildren(install, powerCard());
    injectStyle(host);
    const action = setupFromShortcut;
    setupFromShortcut = null;
    return load().then(() => beginPowerSetup(action));
  }

  root.addEventListener('multicc-power-changed', event => {
    if (el('air-global-power-card') && !powerBusy && event.detail !== powerState) paintPower(event.detail, false);
  });

  root.MultiCCAirGlobal = Object.freeze({ render, refresh: () => load(), prepareSetup: action => {
    if (el('air-global-power-card')?.checkVisibility() && powerState) beginPowerSetup(action);
    else setupFromShortcut = action;
  } });
})(typeof window !== 'undefined' ? window : null);
