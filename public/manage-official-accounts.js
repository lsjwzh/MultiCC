'use strict';

/* 官方账号（多账号登录）管理 —— Provider 配置页的独立区块。
 *
 * 每种 CLI 只有一个官方 Provider，账号在这里全局切换，新请求使用当前账号。
 *
 * 两种账号登录走同一套 multicc 自己的 PKCE 流程（Claude 见
 * src/claude-auth/official-oauth.js，Codex 见 src/codex-auth/official-oauth.js）：
 * 添加后不自动打开授权页，而是弹出登录面板（照 Magpie 的做法）：给出完整授权
 * 链接供复制到任意浏览器，再粘贴浏览器最终停留的回调地址，轮询 login-status
 * 直到完成。只有「本机 CLI 登录账号」那一行仍走 loginFlow 终端。
 *
 * 依赖 manage.html 已加载的全局：window.MultiCCApi（api-client.js）、
 * window.QuotaBarView（quota-bar-view.js）、escapeHtml / showToast /
 * loadProviders（manage.js，点击时才解析，因此脚本顺序无要求）。 */

(function () {
  const api = () => window.MultiCCApi;
  // 旧页删掉之后这个模块只剩 Air 在用（air-provider-advanced.js 画骨架、显式调 load()），
  // 所以它自己写进 DOM 的那些文案也归 i18n 管了 —— 全部走 t()，key 以 airOfficialAcct 开头。
  const tr = (key, params) => (typeof window.t === 'function' ? window.t(key, params) : key);
  // 五个字符的转义（& < > " '），和 shared/dom-helpers.js 的 escapeHtml 同一份语义。
  // 旧实现里 typeof 守卫的 else 分支直接把原文吐回去 —— 账号 id/邮箱一旦落在属性位置上
  // 就是一个注入点，宁可在这里自己转一遍。
  const esc = (v) => (typeof escapeHtml === 'function'
    ? escapeHtml(String(v == null ? '' : v))
    : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (msg, isError) => { if (typeof showToast === 'function') showToast(msg, isError); };

  const state = {
    codex: [],
    claude: [],
    loading: false,
    quota: {}, // `${vendor}:${id}` → {status:'loading'} | {status:'ok'|'err', html}
    loginWatch: {}, // claude accountId → poll timer
    signin: null, // the open Claude sign-in panel {accountId, url, overlay, onStatus}
    cli: {}, // vendor → 本机 CLI 登录状态 {loggedIn, email, inStore}
  };

  function bodyEl() { return document.getElementById('official-accounts-body'); }
  function statusEl() { return document.getElementById('official-accounts-status'); }

  function setStatus(msg, isError) {
    const el = statusEl();
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status-text' + (isError ? ' err' : '');
  }

  // ── quota rendering ────────────────────────────────────────────────────────

  function quotaKey(vendor, id) { return vendor + ':' + id; }

  function quotaHtml(vendor, id) {
    const q = state.quota[quotaKey(vendor, id)];
    if (!q) return '<span style="color:var(--faint)">' + esc(tr('airOfficialAcctQuotaIdle')) + '</span>';
    if (q.status === 'loading') return '<span style="color:var(--faint)">' + esc(tr('airOfficialAcctQuotaLoading')) + '</span>';
    if (q.status === 'err') return '<span style="color:var(--danger)">' + esc(tr('airOfficialAcctQuotaError', { message: q.error })) + '</span>';
    return q.html;
  }

  function renderCodexQuota(data) {
    const bar = window.QuotaBarView && data.bar ? window.QuotaBarView.resolveQuotaBar(data.bar) : null;
    if (bar && bar.text) {
      const extra = [];
      if (data.planType) extra.push(esc(tr('airOfficialAcctPlan', { plan: data.planType })));
      if (data.credits && data.credits.hasCredits) extra.push(esc(tr('airOfficialAcctCredits', { balance: data.credits.balance })));
      return '<span style="color:' + esc(bar.color) + '" title="' + esc(bar.title || '') + '">' + esc(bar.text) + '</span>'
        + (extra.length ? ' <span style="color:var(--faint);font-size:11px">' + extra.join(' · ') + '</span>' : '');
    }
    return '<span style="color:var(--faint)">' + esc(tr('airOfficialAcctQuotaUnavailable')) + '</span>';
  }

  function renderClaudeQuota(data) {
    const usage = data.usage || {};
    const segs = [];
    const windowLabel = { five_hour: tr('airOfficialAcctWindow5h'), seven_day: tr('airOfficialAcctWindowWeek'), seven_day_sonnet: tr('airOfficialAcctWindowWeekSonnet') };
    for (const key of Object.keys(windowLabel)) {
      const w = usage[key];
      if (!w || typeof w.utilization !== 'number') continue;
      // utilization is a 0..100 percent (see routes/claude-usage-quota.js SCALE).
      const remaining = Math.max(0, Math.round(100 - w.utilization));
      const color = remaining <= 5 ? '#f85149' : remaining <= 20 ? '#d29922' : '#58a6ff';
      let resets = '';
      if (w.resets_at) {
        const at = Date.parse(w.resets_at);
        if (Number.isFinite(at) && window.QuotaBarView) {
          resets = ' ' + window.QuotaBarView.humanizeCountdown(Math.max(0, at - Date.now()));
        }
      }
      segs.push('<span style="color:' + color + '">' + esc(tr('airOfficialAcctWindowLeft', { window: windowLabel[key], percent: remaining })) + esc(resets) + '</span>');
    }
    if (!segs.length) return '<span style="color:var(--faint)">' + esc(tr('airOfficialAcctQuotaUnavailable')) + '</span>';
    return segs.join('<span style="color:var(--faint)"> · </span>');
  }

  async function fetchQuota(vendor, id) {
    state.quota[quotaKey(vendor, id)] = { status: 'loading' };
    paint();
    try {
      const data = await api().json(vendor === 'codex'
        ? '/api/codex/quota?account=' + encodeURIComponent(id)
        : '/api/claude/accounts/' + encodeURIComponent(id) + '/quota');
      if (data.status !== 'ok') {
        state.quota[quotaKey(vendor, id)] = { status: 'err', error: data.error || data.status || tr('airOfficialAcctQuotaFailed') };
      } else {
        state.quota[quotaKey(vendor, id)] = {
          status: 'ok',
          html: vendor === 'codex' ? renderCodexQuota(data) : renderClaudeQuota(data),
        };
      }
    } catch (err) {
      state.quota[quotaKey(vendor, id)] = { status: 'err', error: err.message || tr('airOfficialAcctQuotaFailed') };
    }
    paint();
  }

  // ── list rendering ─────────────────────────────────────────────────────────

  function chip(text, color) {
    return '<span style="font-size:11px;padding:1px 8px;border-radius:20px;border:1px solid ' + color + ';color:' + color + '">' + esc(text) + '</span>';
  }

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
  }

  function codexRow(a) {
    if (a.global) return accountRow('codex', a, chip(tr('airOfficialAcctUseLocalCodex'), '#58a6ff'));
    const login = a.login || { state: 'idle' };
    let chips;
    if (login.state === 'pending') {
      chips = chip(tr('airOfficialAcctAwaitingBrowser'), '#d29922');
    } else if (login.state === 'error') {
      chips = chip(tr('airOfficialAcctLoginFailed'), '#f85149') + ' <span style="font-size:11px;color:var(--danger)">' + esc(login.error || '') + '</span>';
    } else if (a.loggedIn) {
      chips = chip(tr('airOfficialAcctSignedIn'), '#58a6ff') + (a.email ? ' <span style="font-size:12px;color:var(--muted)">' + esc(a.email) + '</span>' : '');
    } else {
      chips = chip(tr('airOfficialAcctSignedOut'), '#f85149') + ' <span style="font-size:11px;color:var(--faint)">' + esc(a.reason || '') + '</span>';
    }
    const refresh = a.refresh && a.refresh.lastError
      ? ' <span style="font-size:11px;color:var(--danger)" title="' + esc(tr('airOfficialAcctRefreshTitle')) + '">' + esc(tr('airOfficialAcctRefreshError', { message: a.refresh.lastError })) + '</span>' : '';
    return accountRow('codex', a, chips + refresh, login.state === 'pending' ? loginResumeBlock('codex', a) : '');
  }

  function claudeRow(a) {
    if (a.global) return accountRow('claude', a, chip(tr('airOfficialAcctUseLocalClaude'), '#58a6ff'));
    let chips;
    const login = a.login || { state: 'idle' };
    if (login.state === 'pending') {
      chips = chip(tr('airOfficialAcctAwaitingBrowser'), '#d29922');
    } else if (login.state === 'error') {
      chips = chip(tr('airOfficialAcctLoginFailed'), '#f85149') + ' <span style="font-size:11px;color:var(--danger)">' + esc(login.error || '') + '</span>';
    } else if (a.loggedIn) {
      chips = chip(tr('airOfficialAcctSignedIn'), '#58a6ff') + (a.email ? ' <span style="font-size:12px;color:var(--muted)">' + esc(a.email) + '</span>' : '');
    } else {
      chips = chip(tr('airOfficialAcctSignedOut'), '#f85149');
    }
    const cred = a.credential || {};
    if (cred.lastError) chips += ' <span style="font-size:11px;color:var(--danger)" title="' + esc(tr('airOfficialAcctRefreshTitle')) + '">' + esc(tr('airOfficialAcctRefreshError', { message: cred.lastError })) + '</span>';
    else if (cred.lastRefreshAt) chips += ' <span style="font-size:11px;color:var(--faint)">' + esc(tr('airOfficialAcctLastRefresh', { at: fmtTime(cred.lastRefreshAt) })) + '</span>';
    return accountRow('claude', a, chips, login.state === 'pending' ? loginResumeBlock('claude', a) : '');
  }

  // A pending login keeps its link on the server; this reopens the panel for it
  // (both vendors now share the browser + paste flow).
  function loginResumeBlock(vendor, a) {
    return '<div style="border-top:1px dashed var(--border);padding-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<span style="flex:1;min-width:200px;font-size:11px;line-height:1.6;color:var(--faint)">' + esc(tr('airOfficialAcctSigninRowHint')) + '</span>'
      + '<button class="btn btn-green" style="padding:4px 10px;font-size:12px" data-act="open-signin" data-vendor="' + vendor + '" data-id="' + esc(a.id) + '">' + esc(tr('airOfficialAcctSigninResume')) + '</button>'
      + '</div>';
  }

  function accountRow(vendor, a, chipsHtml, extraHtml) {
    const name = a.label || tr(vendor === 'codex' ? 'airOfficialAcctCodexAccount' : 'airOfficialAcctClaudeAccount', { id: a.id.slice(0, 6) });
    const provider = a.providerName
      ? '<span style="font-size:11px;color:var(--faint)">⇄ ' + esc(a.providerName) + '</span>' : '';
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<b style="font-size:13px">' + esc(name) + '</b>' + chipsHtml
      + (a.cliCopy ? ' <span title="' + esc(tr('airOfficialAcctCliCopyTitle')) + '">' + chip(tr('airOfficialAcctCliCopy'), '#d29922') + '</span>' : '') + provider + (a.active ? chip(tr('airOfficialAcctActive'), '#3fb950') : '')
      + '<span style="margin-left:auto;display:flex;gap:6px">'
      + (a.active ? '' : '<button class="btn btn-green" data-act="activate" data-vendor="' + vendor + '" data-id="' + a.id + '">' + esc(tr('airOfficialAcctActivate')) + '</button>')
      + (a.global ? '' : '<button class="btn" style="padding:2px 10px;font-size:11px" data-act="quota" data-vendor="' + vendor + '" data-id="' + a.id + '">' + esc(tr('airOfficialAcctRefreshQuota')) + '</button>')
      + '<button class="btn" style="padding:2px 10px;font-size:11px" data-act="relogin" data-vendor="' + vendor + '" data-id="' + a.id + '"' + (a.cliCopy ? ' title="' + esc(tr('airOfficialAcctCliCopyTitle')) + '"' : '') + '>' + esc(tr('airOfficialAcctRelogin')) + '</button>'
      + (a.global ? '' : '<button class="btn" style="padding:2px 10px;font-size:11px;color:var(--danger)" data-act="delete" data-vendor="' + vendor + '" data-id="' + a.id + '">' + esc(tr('airOfficialAcctDelete')) + '</button>')
      + '</span></div>'
      + (a.global ? '' : '<div style="font-size:12px">' + quotaHtml(vendor, a.id) + '</div>')
      + '<div data-subscription-vendor="' + vendor + '" data-subscription-account="' + esc(a.id) + '"></div>'
      + (extraHtml || '')
      + '</div>';
  }

  // 本机 CLI 已登录、但账号库里没有这个账号：提醒在这里再登录一次（不拷贝 CLI 的登录）。
  function cliLoginHint(vendor) {
    const cli = state.cli[vendor];
    if (!cli || !cli.loggedIn || cli.inStore) return '';
    return '<div style="font-size:12px;color:#d29922;border:1px dashed #d2992266;border-radius:8px;padding:8px 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<span style="flex:1;min-width:200px;line-height:1.6">' + esc(tr(vendor === 'codex' ? 'airOfficialAcctCliLoginHintCodex' : 'airOfficialAcctCliLoginHintClaude', { email: cli.email || '' })) + '</span>'
      + '<button class="btn btn-green" style="padding:2px 10px;font-size:11px" data-act="add" data-vendor="' + vendor + '">' + esc(tr('airOfficialAcctCliLoginHintAction')) + '</button></div>';
  }

  function vendorSection(vendor, title, hint, accounts, rowFn) {
    const rows = cliLoginHint(vendor) + (accounts.length
      ? accounts.map(rowFn).join('')
      : '<div style="font-size:12px;color:var(--faint)">' + esc(tr('airOfficialAcctEmpty')) + '</div>');
    return '<div style="display:flex;flex-direction:column;gap:8px">'
      + '<div style="font-size:12px;color:var(--muted);font-weight:600">' + title
      + ' <span style="font-weight:400;color:var(--faint)">' + hint + '</span></div>'
      + rows + '</div>';
  }

  function paint() {
    const el = bodyEl();
    if (!el) return;
    if (state.loading) { el.innerHTML = '<span style="color:var(--faint);font-size:13px">' + esc(tr('airOfficialAcctLoading')) + '</span>'; return; }
    el.innerHTML = vendorSection('codex', tr('airOfficialAcctCodexSection'), tr('airOfficialAcctCodexSectionHint'), state.codex, codexRow)
      + '<div style="border-top:1px solid var(--border);margin:10px 0"></div>'
      + vendorSection('claude', tr('airOfficialAcctClaudeSection'), tr('airOfficialAcctClaudeSectionHint'), state.claude, claudeRow);
    el.querySelectorAll('[data-subscription-vendor]').forEach(host => {
      const vendor = host.dataset.subscriptionVendor;
      const accountId = host.dataset.subscriptionAccount;
      const account = state[vendor].find(a => a.id === accountId);
      window.MultiCCProviderSubscription?.mount(host, { vendor, accountId,
        subscription: account?.subscription, api: path => api().json(path) });
    });
  }

  async function loadOfficialAccounts() {
    if (!bodyEl()) return;
    state.loading = true;
    paint();
    try {
      const [codex, claude] = await Promise.all([
        api().json('/api/codex/accounts'),
        api().json('/api/claude/accounts'),
      ]);
      state.codex = Array.isArray(codex.accounts) ? codex.accounts : [];
      state.claude = Array.isArray(claude.accounts) ? claude.accounts : [];
      state.cli = { codex: codex.cliLogin || null, claude: claude.cliLogin || null };
      state.loading = false;
      paint();
      // 自动为已登录账号拉一次余量；失败的行保留可点「刷新余量」重试。
      for (const a of state.codex) if (a.loggedIn) fetchQuota('codex', a.id);
      for (const a of state.claude) if (a.loggedIn) fetchQuota('claude', a.id);
      for (const vendor of ['codex', 'claude']) {
        for (const a of state[vendor]) if ((a.login || {}).state === 'pending') watchLogin(vendor, a.id);
      }
    } catch (err) {
      state.loading = false;
      const el = bodyEl();
      if (el) el.innerHTML = '<span style="color:var(--danger);font-size:13px">' + esc(tr('airOfficialAcctLoadFailed', { message: err.message })) + '</span>';
    }
  }

  function refreshProviders() {
    if (typeof loadProviders === 'function') loadProviders();
    else window.MultiCCAirProvider?.refresh();
  }

  // ── add / relogin / delete ─────────────────────────────────────────────────

  const EGRESS_PLUGIN_ID = 'chrome-proxy-launcher';

  // 出口要在生成登录链接之前选好：账号是在这一步“注册”的，换码请求也在这台
  // 机器上发出，登录后才补绑定就晚了。插件里的身份清单是活的，打开面板时读
  // 一次；从插件页切回来再读一次，刚建的身份立刻可选。
  function loadEgressOptions(state, preselect) {
    const { select, hint, open } = state;
    select.innerHTML = '<option value="">' + esc(tr('airProviderEgressBindingOff')) + '</option>';
    select.disabled = true;
    hint.style.display = '';
    hint.textContent = tr('airProviderEgressBindingLoading');
    open.style.display = 'none';
    const guide = (message) => {
      if (!state.alive) return;
      hint.textContent = message;
      hint.style.display = '';
      open.style.display = '';
    };
    (async () => {
      let entry = null;
      try {
        const payload = await api().json('/api/plugins');
        entry = ((payload && payload.plugins) || []).find(item => item && item.id === EGRESS_PLUGIN_ID) || null;
      } catch (err) {
        guide(tr('airProviderEgressBindingLoadFailed', { message: err.message }));
        return;
      }
      if (!state.alive) return;
      if (!entry) return guide(tr('airProviderEgressBindingNoPlugin'));
      if (!entry.engine || !entry.engine.available) return guide((entry.engine && entry.engine.reason) || tr('airProviderEgressBindingNoPlugin'));
      let profiles = [];
      try {
        const listed = await api().json(`/api/plugins/${EGRESS_PLUGIN_ID}/run`, { method: 'POST', json: { command: 'list', input: {} } });
        profiles = Array.isArray(listed && listed.profiles) ? listed.profiles : [];
      } catch (err) {
        guide(tr('airProviderEgressBindingLoadFailed', { message: err.message }));
        return;
      }
      if (!state.alive) return;
      const usable = profiles.filter(profile => profile && typeof profile.id === 'string' && profile.id);
      select.innerHTML = '<option value="">' + esc(tr('airProviderEgressBindingOff')) + '</option>'
        + usable.map(profile => '<option value="' + esc(profile.id) + '">'
          + esc(`${profile.name || profile.id}${profile.egressText ? ` · ${profile.egressText}` : ''}`)
          + '</option>').join('');
      // 新账号默认落在第一个身份上：漏选就等于用本机网络登录，正是要避免的污染风险。
      select.value = usable.some(profile => profile.id === preselect) ? preselect : (usable[0] ? usable[0].id : '');
      select.disabled = !usable.length;
      if (usable.length) {
        hint.style.display = 'none';
        hint.textContent = '';
      } else {
        guide(tr('airProviderEgressBindingNoProfiles'));
      }
    })();
  }

  function labelOverlay(vendor, onConfirm) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const isCodex = vendor === 'codex';
    overlay.innerHTML = '<div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:440px;max-width:92vw;">'
      + '<div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">' + esc(tr(isCodex ? 'airOfficialAcctAddCodexTitle' : 'airOfficialAcctAddClaudeTitle')) + '</div>'
      + '<div style="font-size:12px;color:var(--faint);margin-bottom:10px;line-height:1.6">'
      + (isCodex
        ? esc(tr('airOfficialAcctAddCodexBody'))
        : esc(tr('airOfficialAcctAddClaudeBody')))
      + '</div>'
      + '<input data-k="label" type="text" placeholder="' + esc(tr('airOfficialAcctLabelPlaceholder')) + '" maxlength="64" style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 10px;outline:none">'
      + '<div style="margin-top:10px">'
      + '<div style="font-size:11px;color:var(--faint);margin-bottom:6px">' + esc(tr('airProviderEgressSelectLabel')) + '</div>'
      + '<select data-k="egress" style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:7px 10px;outline:none"></select>'
      + '<div style="font-size:11px;color:var(--faint);margin-top:6px;line-height:1.6">' + esc(tr('airProviderEgressSelectBody')) + '</div>'
      + '<div data-k="egress-hint" style="font-size:11px;line-height:1.6;color:#d29922;margin-top:6px"></div>'
      + '<button class="btn" data-act="open-plugin" style="font-size:12px;margin-top:6px;display:none">' + esc(tr('airProviderEgressOpenPlugin')) + '</button>'
      + '</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '<button class="btn" data-act="close" style="font-size:13px">' + esc(tr('airOfficialAcctCancel')) + '</button>'
      + '<button class="btn btn-green" data-act="ok" style="font-size:13px">' + esc(tr('airOfficialAcctCreateAndLogin')) + '</button>'
      + '</div>'
      + '<div data-k="status" class="status-text" style="margin-top:8px"></div></div>';
    document.body.appendChild(overlay);
    const egressState = {
      overlay,
      select: overlay.querySelector('[data-k="egress"]'),
      hint: overlay.querySelector('[data-k="egress-hint"]'),
      open: overlay.querySelector('[data-act="open-plugin"]'),
      alive: true,
    };
    const reloadEgress = () => loadEgressOptions(egressState, egressState.select.value);
    const close = () => {
      egressState.alive = false;
      window.removeEventListener('focus', reloadEgress);
      overlay.remove();
    };
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector('[data-act="close"]').onclick = close;
    egressState.open.onclick = () => { window.open('/air?view=plugins', '_blank', 'noopener'); };
    window.addEventListener('focus', reloadEgress);
    loadEgressOptions(egressState, '');
    overlay.querySelector('[data-act="ok"]').onclick = () => onConfirm(
      overlay.querySelector('[data-k="label"]').value.trim(),
      egressState.select.value,
      overlay.querySelector('[data-k="status"]'),
      close,
    );
  }

  async function addOfficialAccount(vendor) {
    labelOverlay(vendor, async (label, profileId, st, close) => {
      st.textContent = tr('airOfficialAcctCreating'); st.className = 'status-text';
      try {
        const egressBinding = profileId ? { pluginId: EGRESS_PLUGIN_ID, profileId } : null;
        const data = await api().json('/api/' + vendor + '/accounts', { method: 'POST', json: { label, egressBinding } });
        close();
        if (data.oauthUrl) {
          openSignin(vendor, data.accountId, data.oauthUrl, label);
          watchLogin(vendor, data.accountId);
        } else {
          toast(tr('airOfficialAcctLoginUnavailable', { message: data.loginError || data.error || '' }), true);
        }
        loadOfficialAccounts();
        refreshProviders();
      } catch (err) {
        st.textContent = tr('airOfficialAcctFailed', { message: err.message }); st.className = 'status-text err';
      }
    });
  }

  async function relogin(vendor, id) {
    setStatus(tr('airOfficialAcctReopeningLogin'));
    try {
      const data = await api().json(id === 'global' ? '/api/' + vendor + '/oauth/login' : '/api/' + vendor + '/accounts/' + encodeURIComponent(id) + '/relogin', { method: 'POST', json: {} });
      if (id === 'global') {
        if (data.sessionId) window.open('index.html?id=' + encodeURIComponent(data.sessionId), '_blank');
        toast(tr('airOfficialAcctTerminalOpened'));
      } else if (data.oauthUrl) {
        openSignin(vendor, id, data.oauthUrl);
        watchLogin(vendor, id);
      } else {
        setStatus(tr('airOfficialAcctLoginUnavailable', { message: data.error || '' }), true);
      }
      setStatus('');
      loadOfficialAccounts();
    } catch (err) { setStatus(tr('airOfficialAcctReloginFailed', { message: err.message }), true); }
  }

  async function activate(vendor, id) {
    setStatus(tr('airOfficialAcctSwitching'));
    try {
      await api().json('/api/' + vendor + '/accounts/' + encodeURIComponent(id) + '/activate', { method: 'POST', json: {} });
      setStatus(tr('airOfficialAcctSwitched'));
      await loadOfficialAccounts();
      refreshProviders();
    } catch (err) { setStatus(tr('airOfficialAcctSwitchFailed', { message: err.message }), true); }
  }

  async function removeAccount(vendor, id) {
    if (!window.confirm(tr('airOfficialAcctDeleteConfirm'))) return;
    setStatus(tr('airOfficialAcctDeleting'));
    try {
      await api().json('/api/' + vendor + '/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
      delete state.quota[quotaKey(vendor, id)];
      toast(tr('airOfficialAcctDeleted'));
      setStatus('');
      loadOfficialAccounts();
      refreshProviders();
    } catch (err) { setStatus(tr('airOfficialAcctDeleteFailed', { message: err.message }), true); }
  }

  // ── browser-login watch (both vendors) ─────────────────────────────────────

  function watchLogin(vendor, accountId) {
    const key = vendor + ':' + accountId;
    if (!accountId || state.loginWatch[key]) return;
    const startedAt = Date.now();
    state.loginWatch[key] = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60 * 1000) { stopWatch(key); return; }
      try {
        const s = await api().json('/api/' + vendor + '/accounts/' + encodeURIComponent(accountId) + '/login-status');
        if (s.state === 'pending') return;
        stopWatch(key);
        const panel = state.signin && state.signin.vendor === vendor && state.signin.accountId === accountId ? state.signin : null;
        if (panel) panel.onStatus(s);
        else if (s.state === 'complete') {
          toast(s.email ? tr(SIGNIN_TEXT[vendor].doneEmail, { email: s.email }) : tr(SIGNIN_TEXT[vendor].done));
        } else if (s.state === 'error') {
          toast(tr(SIGNIN_TEXT[vendor].failed, { message: s.error || '' }), true);
        }
        loadOfficialAccounts();
        refreshProviders();
      } catch (_) { /* transient — keep polling until the timeout */ }
    }, 2000);
    state.loginWatch[key].unref?.();
  }

  // ── sign-in panel (both vendors) ──────────────────────────────────────────
  // Magpie's sign-in sheet: nothing opens by itself. The whole link is shown to
  // copy into whichever browser or profile holds the account; that browser ends
  // on its own localhost (unreachable when MultiCC runs on a server), so its
  // address is pasted back here and the server finishes the PKCE exchange.
  // Codex uses the same sheet — its account login is multicc's own PKCE flow
  // too (src/codex-auth/official-oauth.js), so only the copy and the endpoint
  // vendor differ.

  const SIGNIN_TEXT = {
    claude: {
      title: 'airOfficialAcctSigninTitle', step1: 'airOfficialAcctSigninStep1', step2: 'airOfficialAcctSigninStep2',
      done: 'airOfficialAcctClaudeLoginDone', doneEmail: 'airOfficialAcctClaudeLoginDoneEmail', failed: 'airOfficialAcctClaudeLoginFailed',
    },
    codex: {
      title: 'airOfficialAcctCodexSigninTitle', step1: 'airOfficialAcctCodexSigninStep1', step2: 'airOfficialAcctCodexSigninStep2',
      done: 'airOfficialAcctCodexLoginDone', doneEmail: 'airOfficialAcctCodexLoginDoneEmail', failed: 'airOfficialAcctCodexLoginFailed',
    },
  };

  function openSignin(vendor, accountId, oauthUrl, label) {
    closeSignin();
    if (!accountId) return;
    const text = SIGNIN_TEXT[vendor] || SIGNIN_TEXT.claude;
    const account = (state[vendor] || []).find(a => a.id === accountId);
    const name = label || (account && account.label)
      || tr(vendor === 'codex' ? 'airOfficialAcctCodexAccount' : 'airOfficialAcctClaudeAccount', { id: accountId.slice(0, 6) });
    const btn = 'font-size:12px;padding:4px 10px;white-space:nowrap';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = '<div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:540px;max-width:94vw;max-height:90vh;overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:10px">'
      + '<div style="font-size:14px;color:#c9d1d9;font-weight:600">' + esc(tr(text.title, { name })) + '</div>'
      + '<div data-k="phase" style="font-size:12px;color:#d29922"></div>'
      + '<div style="font-size:12px;color:var(--faint);line-height:1.6">' + esc(tr(text.step1)) + '</div>'
      + '<div style="display:flex;gap:6px;align-items:center;min-width:0">'
      + '<code data-k="url" style="flex:1;min-width:0;white-space:nowrap;overflow-x:auto;user-select:all;-webkit-user-select:all;font-size:12px;padding:6px 8px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9"></code>'
      + '<button class="btn" data-k="copy" style="' + btn + '">' + esc(tr('airOfficialAcctSigninCopy')) + '</button>'
      + '<button class="btn" data-k="open" style="' + btn + '">' + esc(tr('airOfficialAcctSigninOpen')) + '</button>'
      + '</div>'
      + '<div style="font-size:12px;color:var(--faint);line-height:1.6">' + esc(tr(text.step2)) + '</div>'
      + '<form data-k="form" style="display:flex;gap:6px;flex-wrap:wrap;margin:0">'
      + '<input data-k="callback" type="text" autocomplete="off" spellcheck="false" aria-label="' + esc(tr('airOfficialAcctSigninCallbackLabel')) + '" placeholder="' + esc(tr('airOfficialAcctPastePlaceholder')) + '" style="flex:1;min-width:220px;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:7px 10px;outline:none">'
      + '<button type="submit" class="btn btn-green" data-k="submit" style="' + btn + '" disabled>' + esc(tr('airOfficialAcctPasteAction')) + '</button>'
      + '</form>'
      + '<div data-k="error" style="font-size:12px;color:var(--danger);line-height:1.6;word-break:break-word"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      + '<button class="btn" data-k="retry" style="' + btn + ';display:none">' + esc(tr('airOfficialAcctSigninRetry')) + '</button>'
      + '<button class="btn" data-k="close" style="' + btn + '">' + esc(tr('airOfficialAcctSigninLater')) + '</button>'
      + '</div></div>';
    document.body.appendChild(overlay);
    const q = k => overlay.querySelector('[data-k="' + k + '"]');
    const input = q('callback'), submit = q('submit'), phase = q('phase'), error = q('error'), retry = q('retry');
    const panel = { vendor, accountId, url: oauthUrl || '', submitting: false, finished: false, overlay };
    state.signin = panel;
    const same = () => state.signin === panel;
    const syncSubmit = () => { submit.disabled = panel.submitting || panel.finished || input.disabled || !input.value.trim(); };
    const reset = (url) => {
      panel.url = url || '';
      q('url').textContent = panel.url;
      phase.textContent = tr('airOfficialAcctSigninWaiting');
      error.textContent = '';
      retry.style.display = panel.url ? 'none' : '';
      input.disabled = !panel.url;
      syncSubmit();
    };

    panel.onStatus = (s) => {
      if (!same()) return;
      panel.submitting = false;
      if (s.state === 'complete') {
        panel.finished = true;
        input.disabled = true;
        error.textContent = '';
        phase.textContent = s.email ? tr(text.doneEmail, { email: s.email }) : tr(text.done);
        phase.style.color = '#3fb950';
        q('close').textContent = tr('airOfficialAcctSigninClose');
        setTimeout(() => { if (same()) closeSignin(); }, 1500);
      } else if (s.state === 'error') {
        input.disabled = true;
        phase.textContent = '';
        error.textContent = tr(text.failed, { message: s.error || '' });
        retry.style.display = '';
      }
      syncSubmit();
      loadOfficialAccounts();
      refreshProviders();
    };

    q('copy').onclick = () => {
      const done = () => toast(tr('airOfficialAcctSigninCopied'));
      const fallback = () => {
        // Plain-HTTP pages have no async clipboard: select the link instead.
        const range = document.createRange && document.createRange();
        if (range) { range.selectNodeContents(q('url')); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        if (ok) done(); else toast(tr('airOfficialAcctSigninCopyFailed'), true);
      };
      if (navigator.clipboard && window.isSecureContext !== false) navigator.clipboard.writeText(panel.url).then(done, fallback);
      else fallback();
    };
    q('open').onclick = () => { if (panel.url) window.open(panel.url, '_blank', 'noopener'); };
    input.oninput = syncSubmit;
    q('form').onsubmit = async (e) => {
      e.preventDefault();
      const raw = input.value.trim();
      if (panel.submitting || panel.finished || !raw) return;
      panel.submitting = true;
      input.disabled = true;
      error.textContent = '';
      phase.textContent = tr('airOfficialAcctSigninSubmitting');
      syncSubmit();
      try {
        const res = await api().json('/api/' + vendor + '/accounts/' + encodeURIComponent(accountId) + '/login-callback', { method: 'POST', json: { callback: raw } });
        if (!same()) return;
        if (res && res.state === 'complete') { panel.onStatus({ state: 'complete' }); return; }
        phase.textContent = tr('airOfficialAcctPasteAccepted');
        watchLogin(vendor, accountId);
      } catch (err) {
        if (!same()) return;
        panel.submitting = false;
        input.disabled = false;
        phase.textContent = tr('airOfficialAcctSigninWaiting');
        error.textContent = (err && err.message) || tr('airOfficialAcctPasteFailed');
        syncSubmit();
      }
    };
    retry.onclick = async () => {
      retry.disabled = true;
      try {
        const data = await api().json('/api/' + vendor + '/accounts/' + encodeURIComponent(accountId) + '/relogin', { method: 'POST', json: {} });
        if (!same()) return;
        if (!data.oauthUrl) throw new Error(data.error || 'login unavailable');
        input.value = '';
        reset(data.oauthUrl);
        watchLogin(vendor, accountId);
      } catch (err) {
        if (same()) error.textContent = tr('airOfficialAcctReloginFailed', { message: err.message });
      } finally { retry.disabled = false; }
    };
    q('close').onclick = closeSignin;

    reset(panel.url);
    watchLogin(vendor, accountId);
    if (input.focus) input.focus();
  }

  function closeSignin() {
    const panel = state.signin;
    if (!panel) return;
    state.signin = null;
    panel.overlay.remove();
  }

  // The pending login's link lives on the server; reopen the sheet for it.
  function resumeSignin(vendor, accountId) {
    const account = (state[vendor] || []).find(a => a.id === accountId);
    const url = account && account.login && account.login.oauthUrl;
    if (url) openSignin(vendor, accountId, url);
    else relogin(vendor, accountId);
  }

  function stopWatch(key) {
    clearInterval(state.loginWatch[key]);
    delete state.loginWatch[key];
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('#official-accounts-card [data-act]') : null;
    if (!btn) return;
    const vendor = btn.dataset.vendor;
    if (btn.dataset.act === 'add') addOfficialAccount(vendor);
    else if (btn.dataset.act === 'quota') fetchQuota(vendor, btn.dataset.id);
    else if (btn.dataset.act === 'relogin') relogin(vendor, btn.dataset.id);
    else if (btn.dataset.act === 'activate') activate(vendor, btn.dataset.id);
    else if (btn.dataset.act === 'delete') removeAccount(vendor, btn.dataset.id);
    else if (btn.dataset.act === 'open-signin') resumeSignin(vendor, btn.dataset.id);
  });

  // Provider 视图每次被打开时刷新（账号可能刚在别处登录/删除过）。
  if (document.body) {
    new MutationObserver(() => {
      if (document.body.dataset.view === 'provider') loadOfficialAccounts();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    if (document.body.dataset.view === 'provider') loadOfficialAccounts();
  }

  window.MultiCCOfficialAccounts = {
    load: loadOfficialAccounts,
    add: addOfficialAccount,
    relogin,
    renderCodexQuota,
    renderClaudeQuota,
  };
})();
