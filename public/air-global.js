'use strict';

// Air 原生「全局配置」面板 —— 主机的两条全局开关（原生 DOM，不再嵌旧 manage 页）。
// 后端契约见 src/routes/host-read.js / host-write.js：
//   GET/POST /api/settings/official-oauth → { enabled }
//   GET/POST /api/settings/power          → { available, enabled, error? }
//
// 旧 manage 的 global 那一格还有第三张卡（Android APK / iOS OTA 下载）。那张**不搬**：
// 侧栏「更多与系统 › 主机操作」里的「安装包」按钮（air-ops.js 的 openApkPanel）早就读
// 同一对接口列下载行了，同一件事两个入口正是这次迁移要消掉的，所以这页只在顶上留一句
// 指路（见 airGlobalInstallHint），不再画第二张下载卡。
//
// 两条开关都不是普通的偏好，各自的「说错话」代价不一样，所以规矩分开写：
//   · OAuth 重放：开启是**有风险**的动作（在官方客户端之外重放订阅 token），所以开启
//     前必须先问一句；答「否」时勾选要回滚且一个请求都不许发 —— 勾上就等于替用户答应
//     了一件他没答应的事。
//   · 关盖运行：切换要在 Mac 上弹系统授权框、可能要等很久，而且服务端才是「到底生效
//     没有」的唯一裁判。所以过程里先按住开关并说明在等授权，结果一律以服务端回的
//     enabled 为准；失败必须把勾选退回去，不能留下一个服务端并不认账的勾。
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
  // 两条都遵守同一条规矩：开的时候要一次密码，之后不再出。关盖运行那一次是管理员
  // 授权（顺手装上 powerd，之后连重启都不用再问）；允许自动解锁那一次是把登录密码
  // 存进本机钥匙串，写入时预授权 Agent（-T），所以 Agent 之后读它不会弹框。
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

    // 第二条：允许自动解锁。开关本身就是「存不存密码」这一件事 —— 打开才露出输入框，
    // 关掉就是删掉钥匙串里那条目。
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
    unlockRow.append(pwInput, saveBtn, authorizeBtn);
    unlockBlock.append(unlockRow, unlockStatus);

    panel.append(
      head,
      label,
      make('p', t('airGlobalPowerDesc'), 'air-global-desc'),
      foot,
      make('div', null, 'air-global-sep'),
      unlockLabel,
      make('p', t('airGlobalUnlockDesc'), 'air-global-desc'),
      unlockBlock,
    );
    return panel;
  }

  async function loadPower() {
    const panel = el('air-global-power-card');
    const toggle = el('air-global-power-toggle');
    const status = el('air-global-power-status');
    if (!panel || !toggle) return;
    try {
      const data = await context.api('/api/settings/power');
      // 不支持的平台直接整卡消失，不是灰掉：这张卡在非 macOS 上没有任何意义。
      if (!data || data.available === false) {
        panel.hidden = true;
        if (status) status.textContent = '';
        return;
      }
      panel.hidden = false;
      toggle.disabled = false;
      toggle.checked = !!data.enabled;
      paintUnlock(data.unlockPassword);
      if (status) {
        if (data.error) {
          // 读到了「这个平台支持，但状态读不出来」：卡留着，把原因写在状态行上。
          status.textContent = t('airGlobalPowerReadFailed', { message: data.error });
          status.className = 'air-global-status err';
        } else {
          status.textContent = t(data.enabled ? 'airGlobalPowerOn' : 'airGlobalPowerOff');
          status.className = `air-global-status${data.enabled ? ' ok' : ''}`;
        }
      }
    } catch (error) {
      // 连可用性都问不出来时也把卡收起来（同旧页）：留在屏幕上的是一个读不到真状态的开关。
      panel.hidden = true;
      if (status) status.textContent = '';
    }
  }

  // 保存之后服务端会当场问一次 Agent「你到底能不能读钥匙串里这条目」，回执有四种。
  // 四句话分开写，是因为「用户下一步该做什么」完全不同：授权过了什么都不用做；没授权
  // 则必须让他在**此刻**（屏幕解锁、人就在跟前）点掉那个系统框——这一步漏了，锁屏时
  // 框会弹在点不到的地方，Agent 卡在读密码那步。
  const AUTHORIZATION_TEXT = {
    authorized: 'airGlobalUnlockAuthorized',
    'waiting-for-user': 'airGlobalUnlockWaitAuthorize',
    'no-password': 'airGlobalUnlockNotStored',
    unavailable: 'airGlobalUnlockProbeUnknown',
  };

  function paintAuthorization(authorization) {
    const status = el('air-global-unlock-status');
    if (!status || !authorization) return;
    const key = AUTHORIZATION_TEXT[authorization.state];
    if (!key) return;
    status.textContent = t(key);
    const tone = authorization.state === 'authorized' ? ' ok' : (authorization.state === 'no-password' ? ' err' : '');
    status.className = `air-global-status${tone}`;
  }

  // 开关态一律以服务端说的为准（钥匙串里到底有没有那条目）。输入框只在「刚打开、还没
  // 存成」的那一刻露出来，所以每次按服务端回包重画时都收回去。
  function paintUnlock(unlockPassword) {
    const toggle = el('air-global-unlock-toggle');
    const block = el('air-global-unlock-block');
    const status = el('air-global-unlock-status');
    const authorize = el('air-global-unlock-authorize');
    if (!toggle) return;
    const available = Boolean(unlockPassword && unlockPassword.available);
    toggle.disabled = !available;
    if (!available) {
      // 这台机器根本没有这条设置：开关按住、框收起来，状态行也不许留着上一台机器的旧话。
      if (block) block.hidden = true;
      if (status) { status.textContent = ''; status.className = 'air-global-status'; }
      return;
    }
    if (unlockPassword.error) {
      // 读不到「钥匙串里到底有没有那条目」时不许画勾：一个不知道真假的勾比没有勾更坏
      // （显示成「关」会让人以为什么都没开，而它可能正开着）。
      toggle.disabled = true;
      toggle.checked = false;
      if (block) block.hidden = true;
      if (status) {
        status.textContent = t('airGlobalUnlockUnreadable');
        status.className = 'air-global-status err';
      }
      return;
    }
    const set = Boolean(unlockPassword.set);
    toggle.checked = set;
    if (block) block.hidden = true;
    // 没有条目时「确认授权」无从谈起：它只会回一句 no-password。
    if (authorize) authorize.hidden = !set;
    if (status && !status.textContent) {
      status.textContent = set ? t('airGlobalUnlockSaved') : '';
      status.className = `air-global-status${set ? ' ok' : ''}`;
    }
  }

  // 打开：已经存过就没什么可做的（服务端说 set，开关本来就是亮的）；没存过就把输入框
  // 露出来让人输一次。关掉：删掉钥匙串里那条目 —— 开关本身就是这件事，不需要第二个按钮。
  async function toggleUnlock() {
    const toggle = el('air-global-unlock-toggle');
    const block = el('air-global-unlock-block');
    const status = el('air-global-unlock-status');
    const input = el('air-global-unlock-password');
    if (!toggle) return;
    if (toggle.checked) {
      if (block) block.hidden = false;
      if (status) { status.textContent = t('airGlobalUnlockNeedPassword'); status.className = 'air-global-status'; }
      if (input) input.focus();
      return;
    }
    if (block) block.hidden = true;
    toggle.disabled = true;
    if (status) { status.textContent = t('airGlobalPowerWaiting'); status.className = 'air-global-status'; }
    try {
      await context.api('/api/settings/power/unlock-password', undefined, 'DELETE');
      if (input) input.value = '';
      // 条目没了，「确认授权」就无从谈起（它只会回一句 no-password）—— 跟着一起收起来。
      const authorize = el('air-global-unlock-authorize');
      if (authorize) authorize.hidden = true;
      if (status) { status.textContent = t('airGlobalUnlockCleared'); status.className = 'air-global-status ok'; }
    } catch (error) {
      // 删不掉就把开关弹回去：屏幕上的勾必须等于钥匙串里真有那条目。
      toggle.checked = true;
      if (status) {
        status.textContent = t('airGlobalUnlockFailed', { message: error.message || String(error) });
        status.className = 'air-global-status err';
      }
    } finally {
      toggle.disabled = false;
    }
  }

  async function saveUnlockPassword() {
    const input = el('air-global-unlock-password');
    const status = el('air-global-unlock-status');
    const save = el('air-global-unlock-save');
    const toggle = el('air-global-unlock-toggle');
    const block = el('air-global-unlock-block');
    if (!input || !save) return;
    const password = input.value;
    if (!password) { input.focus(); return; }
    // 这次请求里可能弹系统授权框，最坏要等十几秒（Agent 侧 8 秒 + 通信余量）。
    save.disabled = true;
    if (status) { status.textContent = t('airGlobalPowerWaiting'); status.className = 'air-global-status'; }
    try {
      const data = await context.api('/api/settings/power/unlock-password', { password }, 'POST');
      input.value = '';
      if (block) block.hidden = true;
      if (toggle) toggle.checked = true;
      // 条目这下才真的在钥匙串里，「确认授权」从这一刻起才有意义（首次保存时它还是藏着的）。
      const authorize = el('air-global-unlock-authorize');
      if (authorize) authorize.hidden = false;
      // 服务端回的是「Agent 到底读不读得到」的判定，界面照它说话。没有这个字段时
      // （老服务端）退回原来那句。
      if (data && data.authorization) paintAuthorization(data.authorization);
      else if (status) {
        status.textContent = t(data && data.set ? 'airGlobalUnlockSaved' : 'airGlobalUnlockCleared');
        status.className = 'air-global-status ok';
      }
    } catch (error) {
      if (status) {
        status.textContent = t('airGlobalUnlockFailed', { message: error.message || String(error) });
        status.className = 'air-global-status err';
      }
    } finally {
      save.disabled = false;
    }
  }

  // 授权那一次没点上（人没看见框，或者点晚了）时的重试：条目已经在钥匙串里，所以**不用
  // 重输密码**（保存框早就清空了，叫用户重输一次才是真的劝退）。再问一次就是把那个系统
  // 框再弹一次。
  async function authorizeUnlockPassword() {
    const status = el('air-global-unlock-status');
    const button = el('air-global-unlock-authorize');
    if (!button) return;
    button.disabled = true;
    if (status) { status.textContent = t('airGlobalPowerWaiting'); status.className = 'air-global-status'; }
    try {
      const data = await context.api('/api/settings/power/unlock-password/authorize', {});
      paintAuthorization(data && data.authorization);
    } catch (error) {
      if (status) {
        status.textContent = t('airGlobalUnlockFailed', { message: error.message || String(error) });
        status.className = 'air-global-status err';
      }
    } finally {
      button.disabled = false;
    }
  }

  async function togglePower() {
    const toggle = el('air-global-power-toggle');
    const status = el('air-global-power-status');
    if (!toggle) return;
    const previous = !toggle.checked;
    // 这一步会在 Mac 上弹系统授权框、可能等上几十秒：先按住开关，别让人以为没反应再点一次。
    toggle.disabled = true;
    if (status) { status.textContent = t('airGlobalPowerWaiting'); status.className = 'air-global-status'; }
    try {
      const data = await context.api('/api/settings/power', { enabled: toggle.checked });
      // 勾选态以服务端回的为准：授权被取消、pmset 没生效时它会说 no。
      toggle.checked = !!(data && data.enabled);
      if (status) {
        status.textContent = t(toggle.checked ? 'airGlobalPowerOn' : 'airGlobalPowerOff');
        status.className = `air-global-status${toggle.checked ? ' ok' : ''}`;
      }
    } catch (error) {
      toggle.checked = previous;
      if (status) {
        status.textContent = t('airGlobalPowerFailed', { message: error.message || String(error) });
        status.className = 'air-global-status err';
      }
    } finally {
      toggle.disabled = false;
    }
  }

  // 两块互相独立：一块读失败不该把另一块也变成一行错误，所以各自 catch、一起等。
  function load() {
    return Promise.all([loadOauth(), loadPower()]);
  }

  function render(host, ctx) {
    context = ctx;
    // 安装包（APK / iOS OTA）不在这页重复第二遍 —— 见文件头。这里只留一句指路。
    const install = make('section', null, 'admin-panel');
    install.append(make('p', t('airGlobalInstallHint'), 'admin-empty air-global-hint'));
    host.replaceChildren(install, oauthCard(), powerCard());
    injectStyle(host);
    return load();
  }

  root.MultiCCAirGlobal = Object.freeze({ render, refresh: () => load() });
})(typeof window !== 'undefined' ? window : null);
