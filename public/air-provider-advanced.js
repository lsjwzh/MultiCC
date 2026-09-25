'use strict';

// Air 原生「Provider · 高级」区块 —— 旧 manage 页 Provider 视图里、Air 线路卡覆盖不到的
// 那四块：官方账号多账号切换、借道分享/导入、ZCode 原生连接、Kimi Code 原生连接。
// 这块以前是 air-provider.js 里一个惰性 iframe（/manage.html?view=provider&embed=air）；
// 旧页删掉之后它们必须自己站住，否则这四件事在界面上就没有入口了。
//
// 三块复用、一块重写：
//   ① 官方账号 —— manage-official-accounts.js 原样复用。它全程按 id 取元素
//      （official-accounts-body / official-accounts-status）、按
//      `#official-accounts-card [data-act]` 做事件委托，所以下面那套骨架的 id 和
//      data-act/data-vendor 必须和 public/manage.html 里逐字一致；改一个字，那块就静默
//      变哑（查询拿到 null，`if (!el) return` 直接返回）。它自己还挂了一个盯
//      body[data-view] 的 MutationObserver —— Air 的 body 上没有这个属性，所以永远不触发，
//      刷新由本模块显式调 MultiCCOfficialAccounts.load()。
//   ② 借道 —— manage-provider-relay.js 原样复用（importRelayProvider / manageRelayShares /
//      shareRelayProvider 三个全局函数）。它的弹层是自带深色内联样式的独立浮层，
//      挂在 document.body 上，不吃 Air 的皮肤，只用到 .btn / .status-text 两个类名。
//   ③ ZCode / Kimi 原生连接 —— 逻辑原本写在 manage.js（2536-2729 行）里，随旧页一起删，
//      所以这里按同样的接口重写一遍，文案全部走 t()。
//
// ── 旧模块要的全局在这里补齐 ────────────────────────────────────────────────────
// 两个复用模块直接引用 manage.js 的裸全局（providerApi / escapeHtml / showToast /
// loadProviders / providerCatalog / _providerData）。Air 不加载 manage.js，缺一个就是点下去
// 抛 ReferenceError。都用 typeof 守卫补，不覆盖已存在的实现（同 air-bridges.js 的做法）。
(function initAirProviderAdvanced(root) {
  if (!root || !root.document) return;
  const document = root.document;

  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  // 五个字符与 shared/dom-helpers.js 的 escapeHtml 同一份语义。本模块自带一份：它既当
  // 本模块的转义，也是在页面没加载 dom-helpers.js 时补 window.escapeHtml 的兜底实现。
  const esc = value => String(value == null ? '' : value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

  let context = null;

  // 补全局要等到渲染时：api-client.js（window.MultiCCApi）在 air.html 里排在本脚本之后，
  // 加载期就读它只会把 providerApi 钉成 undefined，之后每次点击都是 TypeError。
  function ensureGlobals() {
    if (typeof root.escapeHtml !== 'function') root.escapeHtml = esc;
    if (typeof root.showToast !== 'function') {
      root.showToast = message => { if (context) context.notice(String(message == null ? '' : message)); };
    }
    // 旧页的 loadProviders 重画整张 Provider 列表；Air 这边对应的是线路面板自己的刷新
    // （官方账号切换后卡片上的「当前使用」要跟着变，所以这一步不能省）。
    if (typeof root.loadProviders !== 'function') {
      root.loadProviders = () => { void root.MultiCCAirProvider?.refresh(); };
    }
    if (!root.providerApi) root.providerApi = root.MultiCCApi;
    if (!root.providerCatalog) root.providerCatalog = root.MultiCCProviderCatalog;
  }

  const api = () => root.MultiCCApi;
  const errText = error => (root.MultiCCApi?.errorText ? root.MultiCCApi.errorText(error) : (error?.message || String(error)));
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, handler, className = 'btn') => {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  };

  let styleNode = null;
  function injectStyle() {
    if (styleNode && styleNode.isConnected) return;
    styleNode = make('style');
    // 两个复用模块（和它们挂在 body 上的弹层）只认 manage 页的 .btn / .btn-green /
    // .status-text 和 --border / --muted / --faint / --danger / --warn 这几个变量。
    // 弹层不在面板里，所以这几条只能是全局规则 —— air.css 自己没有 .btn，不会打架。
    styleNode.textContent = `
      :root { --border: #d8e5f2; --muted: #4e6379; --danger: #d0453b; --warn: #b47512; }
      .btn { padding: 4px 12px; border: 1px solid #cfe0f1; border-radius: 8px; background: #fff; color: #2f4459; font-size: 12px; cursor: pointer; }
      .btn:hover { border-color: #9cc4e8; }
      .btn:disabled { opacity: .55; cursor: default; }
      .btn-green { border-color: #2071bf; background: #2071bf; color: #fff; }
      .status-text { color: var(--faint); font-size: 11px; }
      .status-text.ok { color: #2f7d4f; }
      .status-text.err { color: var(--danger); }
      .air-prov-adv-body { display: flex; flex-direction: column; gap: 10px; }
      .air-prov-adv-body p { margin: 0; color: var(--faint); font-size: 11px; line-height: 1.6; }
      .air-prov-adv-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .air-prov-adv-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .air-prov-adv-row label { color: var(--muted); font-size: 11px; min-width: 96px; }
      .air-prov-adv-row input, .air-prov-adv-row select { flex: 1; min-width: 200px; padding: 6px 9px; border: 1px solid #cfe0f1; border-radius: 8px; font-size: 12px; }
      .air-prov-adv-form { display: none; flex-direction: column; gap: 6px; padding: 6px 0; }
      .air-prov-adv-status { font-size: 12px; color: var(--muted); word-break: break-word; }
      #official-accounts-body { display: flex; flex-direction: column; gap: 8px; }
    `;
    document.head.append(styleNode);
  }

  function card(titleText, bodyNode, footNode, id) {
    const panel = make('section', null, 'admin-panel');
    if (id) panel.id = id;
    const head = make('div', null, 'admin-panel-head');
    head.append(make('h3', titleText));
    panel.append(head, bodyNode);
    if (footNode) panel.append(footNode);
    return panel;
  }

  // ── 官方账号（复用 manage-official-accounts.js 的骨架）────────────────────────
  function officialCard() {
    const body = make('div', null, 'air-prov-adv-body');
    body.id = 'official-accounts-body';
    body.append(make('p', t('airProviderAdvOfficialDesc')), make('span', t('airProviderAdvLoading'), 'status-text'));
    const foot = make('div', null, 'air-prov-adv-foot');
    for (const [vendor, label] of [['codex', t('airProviderAdvAddCodex')], ['claude', t('airProviderAdvAddClaude')]]) {
      // 这两个按钮不自己接 onclick：manage-official-accounts.js 在 document 上做委托，
      // 只认 data-act="add" + data-vendor，接了反而会点一次跑两遍。
      const control = make('button', label, 'btn btn-green');
      control.type = 'button';
      control.dataset.act = 'add';
      control.dataset.vendor = vendor;
      foot.append(control);
    }
    const officialStatus = make('span', '', 'status-text');
    officialStatus.id = 'official-accounts-status';
    foot.append(officialStatus);
    return card(t('airProviderAdvOfficialTitle'), body, foot, 'official-accounts-card');
  }

  // ── 借道分享 / 导入（复用 manage-provider-relay.js 的三个全局）────────────────
  function relayCard() {
    const body = make('div', null, 'air-prov-adv-body');
    body.append(make('p', t('airProviderAdvRelayDesc')));
    const foot = make('div', null, 'air-prov-adv-foot');
    const importButton = button(t('airProviderAdvRelayImport'), () => root.importRelayProvider?.());
    importButton.title = t('airProviderAdvRelayImportHint');
    foot.append(importButton, button(t('airProviderAdvRelayRecords'), () => root.manageRelayShares?.()));
    return card(t('airProviderAdvRelayTitle'), body, foot);
  }

  // ── ZCode 原生连接 ───────────────────────────────────────────────────────────
  function zcodeCard() {
    const body = make('div', null, 'air-prov-adv-body');
    body.append(make('p', t('airProviderAdvZcodeDesc')));
    const status = make('div', t('airProviderAdvChecking'), 'air-prov-adv-status');
    status.id = 'air-prov-zcode-status';
    const actions = make('div', null, 'air-prov-adv-foot');
    actions.id = 'air-prov-zcode-actions';
    actions.hidden = true;
    const login = button(t('airProviderAdvZcodeLogin'), loginZcode, 'btn btn-green');
    login.id = 'air-prov-zcode-login';
    const sync = button(t('airProviderAdvZcodeSync'), syncZcodeAuth);
    sync.id = 'air-prov-zcode-sync';
    actions.append(login, sync, button(t('airProviderAdvZcodeManualToggle'), () => toggleForm('air-prov-zcode-form')));
    const form = make('div', null, 'air-prov-adv-form');
    form.id = 'air-prov-zcode-form';
    const providerRow = make('div', null, 'air-prov-adv-row');
    providerRow.append(make('label', t('airProviderAdvProviderLabel')));
    const select = make('select');
    select.id = 'air-prov-zcode-provider';
    for (const [value, label] of [['zai', 'Z.ai (api.z.ai)'], ['bigmodel', 'BigModel (open.bigmodel.cn)']]) {
      const option = make('option', label); option.value = value; select.append(option);
    }
    providerRow.append(select);
    const keyRow = make('div', null, 'air-prov-adv-row');
    keyRow.append(make('label', t('airProviderAdvApiKey')));
    const key = make('input'); key.type = 'password'; key.id = 'air-prov-zcode-key'; key.placeholder = t('airProviderAdvApiKeyPlaceholder');
    keyRow.append(key);
    const save = make('div', null, 'air-prov-adv-foot');
    const zcodeFormStatus = make('span', '', 'status-text');
    zcodeFormStatus.id = 'air-prov-zcode-form-status';
    save.append(button(t('airProviderAdvSave'), saveZcodeManualKey, 'btn btn-green'), zcodeFormStatus);
    form.append(providerRow, keyRow, save);
    body.append(status, actions, form, make('p', t('airProviderAdvZcodeNote')));
    return card(t('airProviderAdvZcodeTitle'), body);
  }

  async function loadZcodeAuth() {
    const status = el('air-prov-zcode-status');
    const actions = el('air-prov-zcode-actions');
    if (!status || !actions) return;
    try {
      const data = await api().json('/api/zcode/auth');
      if (data.configured) {
        const name = data.provider === 'zai' ? 'Z.ai' : (data.provider === 'bigmodel' ? 'BigModel' : (data.provider || t('airProviderAdvCustomProvider')));
        status.innerHTML = `<span class="status-text ok">${esc(t('airProviderAdvConfigured'))}</span> — ${esc(t('airProviderAdvZcodeConfigured', { provider: name, model: data.model || '' }))}`;
        const sync = el('air-prov-zcode-sync');
        if (sync) sync.textContent = t('airProviderAdvZcodeResync');
      } else if (data.source === 'desktop_available' && data.desktopProviders?.length) {
        const first = data.desktopProviders[0];
        status.innerHTML = `<span class="status-text" style="color:var(--warn)">${esc(t('airProviderAdvNotConfigured'))}</span> — ${esc(t('airProviderAdvZcodeDesktopHint', { provider: first.id === 'zai' ? 'Z.ai' : 'BigModel' }))}`;
      } else {
        status.innerHTML = `<span class="status-text err">${esc(t('airProviderAdvNotConfigured'))}</span> — ${esc(t('airProviderAdvZcodeMissing'))}`;
      }
      actions.hidden = false;
      const login = el('air-prov-zcode-login');
      if (login) login.hidden = !data.loginAvailable;
    } catch (error) {
      status.textContent = t('airProviderAdvLoadFailed', { message: errText(error) });
    }
  }

  async function syncZcodeAuth() {
    try {
      const data = await api().json('/api/zcode/auth/sync', { method: 'POST' });
      context?.notice(data.ok
        ? t('airProviderAdvZcodeSynced', { provider: data.provider === 'zai' ? 'Z.ai' : 'BigModel' })
        : t('airProviderAdvSyncFailed', { message: data.message || t('airProviderAdvNoDesktopKey') }));
    } catch (error) {
      context?.notice(t('airProviderAdvSyncFailed', { message: errText(error) }));
    }
    void loadZcodeAuth();
  }

  async function loginZcode() {
    const control = el('air-prov-zcode-login');
    if (control) { control.disabled = true; control.textContent = t('airProviderAdvLoggingIn'); }
    try {
      const data = await api().json('/api/zcode/auth/login', { method: 'POST' });
      if (data.ok) context?.notice(t('airProviderAdvZcodeLoginOk'));
      else if (data.code === 'login_timeout') context?.notice(t('airProviderAdvLoginTimeout'));
      else context?.notice(t('airProviderAdvLoginFailed', { message: data.message || data.error || '' }));
    } catch (error) {
      context?.notice(t('airProviderAdvLoginFailed', { message: errText(error) }));
    } finally {
      if (control) { control.disabled = false; control.textContent = t('airProviderAdvZcodeLogin'); }
      void loadZcodeAuth();
    }
  }

  async function saveZcodeManualKey() {
    const status = el('air-prov-zcode-form-status');
    const providerId = el('air-prov-zcode-provider')?.value;
    const apiKey = el('air-prov-zcode-key')?.value?.trim();
    if (!providerId || !apiKey) { setFormStatus(status, t('airProviderAdvFillProviderKey'), true); return; }
    try {
      const data = await api().json('/api/zcode/auth', { method: 'PUT', json: { providerId, apiKey } });
      if (!data.ok) { setFormStatus(status, t('airProviderAdvSaveFailed', { message: data.error || data.message || '' }), true); return; }
      context?.notice(t('airProviderAdvZcodeKeySaved'));
      el('air-prov-zcode-key').value = '';
      el('air-prov-zcode-form').style.display = 'none';
      setFormStatus(status, '');
      void loadZcodeAuth();
    } catch (error) {
      setFormStatus(status, t('airProviderAdvSaveFailed', { message: errText(error) }), true);
    }
  }

  // ── Kimi Code 原生连接 ───────────────────────────────────────────────────────
  function kimiCard() {
    const body = make('div', null, 'air-prov-adv-body');
    body.append(make('p', t('airProviderAdvKimiDesc')));
    const status = make('div', t('airProviderAdvChecking'), 'air-prov-adv-status');
    status.id = 'air-prov-kimi-status';
    const actions = make('div', null, 'air-prov-adv-foot');
    actions.id = 'air-prov-kimi-actions';
    actions.hidden = true;
    const login = button(t('airProviderAdvKimiLogin'), loginKimi, 'btn btn-green');
    login.id = 'air-prov-kimi-login';
    actions.append(login, button(t('airProviderAdvKimiManualToggle'), () => toggleForm('air-prov-kimi-form')));
    const form = make('div', null, 'air-prov-adv-form');
    form.id = 'air-prov-kimi-form';
    const keyRow = make('div', null, 'air-prov-adv-row');
    keyRow.append(make('label', t('airProviderAdvApiKey')));
    const key = make('input'); key.type = 'password'; key.id = 'air-prov-kimi-key'; key.placeholder = t('airProviderAdvKimiApiKeyPlaceholder');
    keyRow.append(key);
    const baseRow = make('div', null, 'air-prov-adv-row');
    baseRow.append(make('label', t('airProviderAdvKimiBaseUrl')));
    const base = make('input'); base.type = 'text'; base.id = 'air-prov-kimi-baseurl'; base.placeholder = t('airProviderAdvKimiBaseUrlPlaceholder');
    baseRow.append(base);
    const save = make('div', null, 'air-prov-adv-foot');
    const kimiFormStatus = make('span', '', 'status-text');
    kimiFormStatus.id = 'air-prov-kimi-form-status';
    save.append(button(t('airProviderAdvSave'), saveKimiManualKey, 'btn btn-green'), kimiFormStatus);
    form.append(keyRow, baseRow, save);
    body.append(status, actions, form, make('p', t('airProviderAdvKimiNote')));
    return card(t('airProviderAdvKimiTitle'), body);
  }

  async function loadKimiAuth() {
    const status = el('air-prov-kimi-status');
    const actions = el('air-prov-kimi-actions');
    if (!status || !actions) return;
    try {
      const data = await api().json('/api/kimi/auth');
      if (data.configured) {
        const source = data.source === 'env_key' ? t('airProviderAdvKimiSourceEnv') : t('airProviderAdvKimiSourceFile');
        status.innerHTML = `<span class="status-text ok">${esc(t('airProviderAdvConfigured'))}</span> — ${esc(t('airProviderAdvKimiConfigured', { source }))}`;
      } else {
        status.innerHTML = `<span class="status-text err">${esc(t('airProviderAdvNotConfigured'))}</span> — ${esc(t('airProviderAdvKimiMissing'))}`;
      }
      actions.hidden = false;
      const login = el('air-prov-kimi-login');
      if (login) login.hidden = !data.loginAvailable;
    } catch (error) {
      status.textContent = t('airProviderAdvLoadFailed', { message: errText(error) });
    }
  }

  async function loginKimi() {
    const control = el('air-prov-kimi-login');
    if (control) { control.disabled = true; control.textContent = t('airProviderAdvLoggingIn'); }
    try {
      const data = await api().json('/api/kimi/auth/login', { method: 'POST' });
      if (data.ok) context?.notice(t('airProviderAdvKimiLoginOk'));
      else if (data.code === 'login_timeout') context?.notice(t('airProviderAdvLoginTimeout'));
      else context?.notice(t('airProviderAdvLoginFailed', { message: data.message || data.error || '' }));
    } catch (error) {
      context?.notice(t('airProviderAdvLoginFailed', { message: errText(error) }));
    } finally {
      if (control) { control.disabled = false; control.textContent = t('airProviderAdvKimiLogin'); }
      void loadKimiAuth();
    }
  }

  async function saveKimiManualKey() {
    const status = el('air-prov-kimi-form-status');
    const apiKey = el('air-prov-kimi-key')?.value?.trim();
    const baseURL = el('air-prov-kimi-baseurl')?.value?.trim() || undefined;
    if (!apiKey) { setFormStatus(status, t('airProviderAdvFillKey'), true); return; }
    try {
      const data = await api().json('/api/kimi/auth', { method: 'PUT', json: { apiKey, baseURL } });
      if (!data.ok) { setFormStatus(status, t('airProviderAdvSaveFailed', { message: data.error || data.message || '' }), true); return; }
      context?.notice(t('airProviderAdvKimiKeySaved'));
      el('air-prov-kimi-key').value = '';
      el('air-prov-kimi-baseurl').value = '';
      el('air-prov-kimi-form').style.display = 'none';
      setFormStatus(status, '');
      void loadKimiAuth();
    } catch (error) {
      setFormStatus(status, t('airProviderAdvSaveFailed', { message: errText(error) }), true);
    }
  }

  function setFormStatus(node, message, isError) {
    if (!node) return;
    node.textContent = message || '';
    node.className = 'status-text' + (isError ? ' err' : '');
  }

  function toggleForm(id) {
    const form = el(id);
    if (form) form.style.display = form.style.display === 'flex' ? 'none' : 'flex';
  }

  // host 是 air-provider.js 里那个 <section id="air-provider-advanced">：这一格每次展开
  // 都重画，因为官方账号 / 原生连接的状态可能在别处（终端登录、另一台设备）变过。
  function render(host, nextContext) {
    if (!host) return;
    context = nextContext || context;
    ensureGlobals();
    injectStyle();
    host.replaceChildren(officialCard(), relayCard(), zcodeCard(), kimiCard());
    void refresh();
  }

  function refresh() {
    root.MultiCCOfficialAccounts?.load();
    void loadZcodeAuth();
    void loadKimiAuth();
  }

  // prepare 单独露出来：线路卡上的「借道分享」不经过这一格，但那个弹层同样吃
  // escapeHtml / providerApi 这几个裸全局，没补就是点一下抛 ReferenceError。
  function prepare(nextContext) { context = nextContext || context; ensureGlobals(); }

  root.MultiCCAirProviderAdvanced = Object.freeze({ render, refresh, prepare });
})(typeof window !== 'undefined' ? window : null);
