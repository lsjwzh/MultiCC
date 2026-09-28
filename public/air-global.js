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

  // ── OAuth 重放 ─────────────────────────────────────────────────────────
  function oauthCard() {
    const panel = make('section', null, 'admin-panel air-global-card');
    const { head, note } = card('PROXY', t('airGlobalOauthTitle'));
    note.id = 'air-global-oauth-state'; // 「已开启 / 已关闭」也要算状态，它得被单独取到

    const checkbox = make('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'air-global-oauth-enabled';
    checkbox.disabled = true; // 状态没回来之前不让点：这颗勾会真的改子进程怎么起
    checkbox.onchange = () => { void toggleOauth(); };
    const label = make('label', null, 'air-global-toggle');
    label.append(checkbox, make('span', t('airGlobalOauthToggle')));
    const row = make('div', null, 'air-global-row');
    row.append(label);

    const status = make('span', '', 'air-global-status');
    status.id = 'air-global-oauth-msg';

    panel.append(head, make('p', t('airGlobalOauthRisk'), 'air-global-risk'), row, status);
    return panel;
  }

  function paintOauth(enabled) {
    const checkbox = el('air-global-oauth-enabled');
    if (checkbox) { checkbox.checked = enabled; checkbox.disabled = false; }
    const state = el('air-global-oauth-state');
    if (state) state.textContent = t(enabled ? 'airGlobalOauthOn' : 'airGlobalOauthOff');
  }

  async function loadOauth() {
    const checkbox = el('air-global-oauth-enabled');
    const status = el('air-global-oauth-msg');
    try {
      const data = await context.api('/api/settings/official-oauth');
      paintOauth(!!(data && data.enabled));
      if (status) { status.textContent = ''; status.className = 'air-global-status'; }
    } catch (error) {
      // 读不到就把它按住并说明原因：一个不知道真假的勾比没有勾更坏。
      if (checkbox) { checkbox.disabled = true; checkbox.checked = false; }
      const state = el('air-global-oauth-state');
      if (state) state.textContent = '';
      if (status) {
        status.textContent = t('airGlobalOauthReadFailed', { message: error.message || String(error) });
        status.className = 'air-global-status err';
      }
    }
  }

  async function toggleOauth() {
    const checkbox = el('air-global-oauth-enabled');
    const status = el('air-global-oauth-msg');
    if (!checkbox) return;
    const previous = !checkbox.checked;
    // 开启是有风险的那一侧，必须先问一句。答「否」就到此为止：勾选退回原位，请求一个不发
    // —— 服务端没被问过，界面也不该替它先表态。
    if (checkbox.checked && !root.confirm(t('airGlobalOauthConfirm'))) {
      checkbox.checked = false;
      return;
    }
    const wanted = checkbox.checked;
    checkbox.disabled = true;
    if (status) { status.textContent = t('airGlobalOauthSaving'); status.className = 'air-global-status'; }
    try {
      const data = await context.api('/api/settings/official-oauth', { enabled: wanted });
      const settled = !!(data && data.enabled);
      paintOauth(settled);
      if (status) {
        status.textContent = t(settled ? 'airGlobalOauthOn' : 'airGlobalOauthOff') + t('airGlobalOauthSpawnNote');
        status.className = 'air-global-status ok';
      }
    } catch (error) {
      // 写失败就把勾退回原值：停在「用户点过」的那一态是在替服务端点头。
      checkbox.checked = previous;
      checkbox.disabled = false;
      if (status) {
        status.textContent = t('airGlobalOauthFailed', { message: error.message || String(error) });
        status.className = 'air-global-status err';
      }
    }
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

  function setPowerBusy(busy) {
    powerBusy = busy;
    for (const id of ['power-toggle', 'unlock-toggle', 'power-refresh', 'unlock-save', 'unlock-authorize', 'unlock-change', 'unlock-forget', 'unlock-cancel']) {
      const node = el('air-global-' + id);
      if (node) node.disabled = busy;
    }
    if (!busy && powerState) paintUnlock(powerState.unlockPassword);
  }

  function paintPower(data) {
    powerState = data;
    const panel = el('air-global-power-card');
    panel.hidden = data.available === false;
    const toggle = el('air-global-power-toggle');
    toggle.checked = !!data.enabled;
    toggle.disabled = powerBusy || !!data.error;
    const status = el('air-global-power-status');
    status.textContent = data.error ? t('airGlobalPowerReadFailed', { message: data.error }) : t(data.enabled ? 'airGlobalPowerOn' : 'airGlobalPowerOff');
    status.className = 'air-global-status' + (data.error ? ' err' : data.enabled ? ' ok' : '');
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
  function paintAuthorization(authorization) {
    const state = authorization?.state || 'unavailable';
    const status = el('air-global-unlock-status');
    status.textContent = t(AUTHORIZATION_TEXT[state] || AUTHORIZATION_TEXT.unavailable);
    status.className = 'air-global-status' + (state === 'authorized' ? ' ok' : ' err');
    el('air-global-unlock-authorize').hidden = state === 'authorized' || powerState?.unlockPassword?.canEdit === false;
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

  // 两块互相独立：一块读失败不该把另一块也变成一行错误，所以各自 catch、一起等。
  function load() {
    return Promise.all([loadOauth(), loadPower()]);
  }

  function render(host, ctx) {
    context = ctx;
    pendingPowerAction = null;
    powerState = null;
    powerBusy = false;
    // 安装包（APK / iOS OTA）不在这页重复第二遍 —— 见文件头。这里只留一句指路。
    const install = make('section', null, 'admin-panel');
    install.append(make('p', t('airGlobalInstallHint'), 'admin-empty air-global-hint'));
    host.replaceChildren(install, oauthCard(), powerCard());
    injectStyle(host);
    return load();
  }

  root.MultiCCAirGlobal = Object.freeze({ render, refresh: () => load() });
})(typeof window !== 'undefined' ? window : null);
