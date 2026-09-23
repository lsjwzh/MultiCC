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
        /* 免密助手是同一张卡里的附属选项，不是第二件事：靠一条细线和缩进把它
           归到关盖开关下面，而不是再画一张卡。 */
        .air-global-helper { display: grid; gap: 7px; padding-top: 10px; border-top: 1px solid var(--hairline); }
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

  // ── 关盖运行（仅 macOS） ───────────────────────────────────────────────
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

    // 免密助手这一行只在服务端说「这台机器适用」时才出现（loadHelper 里解禁），
    // 所以先整块藏起来：一个按了必然报错的按钮比没有这个按钮更糟。
    const helperRow = make('div', null, 'air-global-helper');
    helperRow.id = 'air-global-helper-row';
    helperRow.hidden = true;
    const helperBtn = make('button', t('airGlobalHelperInstall'));
    helperBtn.type = 'button';
    helperBtn.id = 'air-global-helper-btn';
    helperBtn.onclick = () => { void toggleHelper(); };
    const helperStatus = make('span', '', 'air-global-status');
    helperStatus.id = 'air-global-helper-status';
    const helperFoot = make('div', null, 'air-global-foot');
    helperFoot.append(helperBtn, helperStatus);
    helperRow.append(helperFoot, make('p', t('airGlobalHelperDesc'), 'air-global-desc'));

    panel.append(head, label, make('p', t('airGlobalPowerDesc'), 'air-global-desc'), foot, helperRow);
    return panel;
  }

  // 装不装都不影响关盖运行能不能用，所以这块读失败时只写一行状态，绝不把整张卡收掉
  // ——那会让人以为关盖开关本身出了问题。
  // keepStatus：刚说完一句话（取消了、失败了）之后的那次复查要带上它 —— 复查是为了
  // 把按钮态校准到服务端说的那个，不是为了把那句话抹掉换成一行干巴巴的「已安装」。
  async function loadHelper(keepStatus = false) {
    const row = el('air-global-helper-row');
    const button = el('air-global-helper-btn');
    const status = el('air-global-helper-status');
    if (!row || !button || !status) return;
    const say = (text, className) => {
      if (keepStatus) return;
      status.textContent = text;
      status.className = className;
    };
    try {
      const data = await context.api('/api/system/privileged-helper');
      if (!data || data.applicable === false) { row.hidden = true; return; }
      row.hidden = false;
      button.dataset.installed = data.installed ? '1' : '';
      button.textContent = t(data.installed ? 'airGlobalHelperRemove' : 'airGlobalHelperInstall');
      say(data.installed ? t('airGlobalHelperInstalled', { user: data.user }) : t('airGlobalHelperMissing'),
        `air-global-status${data.installed ? ' ok' : ''}`);
    } catch (error) {
      // 读不到状态时那句话必须盖掉：此刻屏幕上的「已取消/已移除」谁也担保不了了。
      row.hidden = false;
      status.textContent = t('airGlobalHelperReadFailed', { message: error.message || String(error) });
      status.className = 'air-global-status err';
    }
  }

  async function toggleHelper() {
    const button = el('air-global-helper-btn');
    const status = el('air-global-helper-status');
    if (!button || !status) return;
    const removing = Boolean(button.dataset.installed);
    // 同关盖开关：这一步会弹系统授权框，先按住按钮并说明在等什么。
    button.disabled = true;
    status.textContent = t('airGlobalHelperWaiting');
    status.className = 'air-global-status';
    let keepStatus = false;
    try {
      await context.api(
        `/api/system/privileged-helper/${removing ? 'uninstall' : 'install'}`, undefined, 'POST');
      status.textContent = t(removing ? 'airGlobalHelperRemoved' : 'airGlobalHelperDone');
      status.className = 'air-global-status ok';
    } catch (error) {
      // 取消密码框是用户的选择，不是故障。它走的也是这条 catch —— 外壳的 request()
      // 把 ok:false 一律当失败抛出，但会把整个回包挂到 error 上，所以这里认 status
      // 而不是认「抛没抛」：照原样把服务端那句话写出来，不染红。
      const canceled = error && error.status === 'canceled';
      status.textContent = canceled
        ? (error.error || error.message)
        : t('airGlobalHelperFailed', { message: error.message || String(error) });
      status.className = `air-global-status${canceled ? '' : ' err'}`;
      // 两种情况这句话都得留着：它是这一次点击唯一的结果，不该被复查换成「已安装」。
      keepStatus = true;
    } finally {
      button.disabled = false;
      // 装没装成以服务端的复查为准（sudo 会静默忽略权限不对的 drop-in），
      // 所以最后总要再问一次，而不是照按钮本地的想法改文案。
      await loadHelper(keepStatus);
    }
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
      // 先把关盖状态画好再问助手：助手读失败不该拖着开关一起显示不出来。
      void loadHelper();
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
