'use strict';

/* 官方账号（多账号登录）管理 —— Provider 配置页的独立区块。
 *
 * 每种 CLI 只有一个官方 Provider，账号在这里全局切换，新请求使用当前账号。
 *
 * Codex 账号登录走白名单 loginFlow 终端（CODEX_HOME 指向账号目录），添加后
 * 打开该终端页让用户完成浏览器授权；Claude 账号登录走 multicc 自己的 PKCE
 * 流程，添加后 window.open(oauthUrl) 并轮询 login-status 直到完成。
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
      const remaining = Math.max(0, Math.round((1 - w.utilization) * 100));
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
    const chips = a.loggedIn
      ? chip(tr('airOfficialAcctSignedIn'), '#58a6ff') + (a.email ? ' <span style="font-size:12px;color:var(--muted)">' + esc(a.email) + '</span>' : '')
      : chip(tr('airOfficialAcctSignedOut'), '#f85149') + ' <span style="font-size:11px;color:var(--faint)">' + esc(a.reason || '') + '</span>';
    const refresh = a.refresh && a.refresh.lastError
      ? ' <span style="font-size:11px;color:var(--danger)" title="' + esc(tr('airOfficialAcctRefreshTitle')) + '">' + esc(tr('airOfficialAcctRefreshError', { message: a.refresh.lastError })) + '</span>' : '';
    return accountRow('codex', a, chips + refresh);
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
    return accountRow('claude', a, chips);
  }

  function accountRow(vendor, a, chipsHtml) {
    const name = a.label || tr(vendor === 'codex' ? 'airOfficialAcctCodexAccount' : 'airOfficialAcctClaudeAccount', { id: a.id.slice(0, 6) });
    const provider = a.providerName
      ? '<span style="font-size:11px;color:var(--faint)">⇄ ' + esc(a.providerName) + '</span>' : '';
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<b style="font-size:13px">' + esc(name) + '</b>' + chipsHtml + provider + (a.active ? chip(tr('airOfficialAcctActive'), '#3fb950') : '')
      + '<span style="margin-left:auto;display:flex;gap:6px">'
      + (a.active ? '' : '<button class="btn btn-green" data-act="activate" data-vendor="' + vendor + '" data-id="' + a.id + '">' + esc(tr('airOfficialAcctActivate')) + '</button>')
      + (a.global ? '' : '<button class="btn" style="padding:2px 10px;font-size:11px" data-act="quota" data-vendor="' + vendor + '" data-id="' + a.id + '">' + esc(tr('airOfficialAcctRefreshQuota')) + '</button>')
      + '<button class="btn" style="padding:2px 10px;font-size:11px" data-act="relogin" data-vendor="' + vendor + '" data-id="' + a.id + '">' + esc(tr('airOfficialAcctRelogin')) + '</button>'
      + (a.global || a.active ? '' : '<button class="btn" style="padding:2px 10px;font-size:11px;color:var(--danger)" data-act="delete" data-vendor="' + vendor + '" data-id="' + a.id + '">' + esc(tr('airOfficialAcctDelete')) + '</button>')
      + '</span></div>'
      + (a.global ? '' : '<div style="font-size:12px">' + quotaHtml(vendor, a.id) + '</div>')
      + '</div>';
  }

  function vendorSection(vendor, title, hint, accounts, rowFn) {
    const rows = accounts.length
      ? accounts.map(rowFn).join('')
      : '<div style="font-size:12px;color:var(--faint)">' + esc(tr('airOfficialAcctEmpty')) + '</div>';
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
      state.loading = false;
      paint();
      // 自动为已登录账号拉一次余量；失败的行保留可点「刷新余量」重试。
      for (const a of state.codex) if (a.loggedIn) fetchQuota('codex', a.id);
      for (const a of state.claude) if (a.loggedIn) fetchQuota('claude', a.id);
      for (const a of state.claude) if ((a.login || {}).state === 'pending') watchClaudeLogin(a.id);
    } catch (err) {
      state.loading = false;
      const el = bodyEl();
      if (el) el.innerHTML = '<span style="color:var(--danger);font-size:13px">' + esc(tr('airOfficialAcctLoadFailed', { message: err.message })) + '</span>';
    }
  }

  function refreshProviders() { if (typeof loadProviders === 'function') loadProviders(); }

  // ── add / relogin / delete ─────────────────────────────────────────────────

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
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '<button class="btn" data-act="close" style="font-size:13px">' + esc(tr('airOfficialAcctCancel')) + '</button>'
      + '<button class="btn btn-green" data-act="ok" style="font-size:13px">' + esc(tr('airOfficialAcctCreateAndLogin')) + '</button>'
      + '</div>'
      + '<div data-k="status" class="status-text" style="margin-top:8px"></div></div>';
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector('[data-act="close"]').onclick = close;
    overlay.querySelector('[data-act="ok"]').onclick = () => onConfirm(overlay.querySelector('[data-k="label"]').value.trim(), overlay.querySelector('[data-k="status"]'), close);
  }

  async function addOfficialAccount(vendor) {
    labelOverlay(vendor, async (label, st, close) => {
      st.textContent = tr('airOfficialAcctCreating'); st.className = 'status-text';
      try {
        const data = await api().json('/api/' + vendor + '/accounts', { method: 'POST', json: { label } });
        close();
        if (vendor === 'codex') {
          if (data.loginSessionId) {
            toast(tr('airOfficialAcctCreatedOpeningTerminal'));
            window.open('index.html?id=' + encodeURIComponent(data.loginSessionId), '_blank');
          } else { toast(tr('airOfficialAcctTerminalOpenFailed', { message: data.error || '' }), true); }
        } else {
          toast(tr('airOfficialAcctCreatedFinishInBrowser'));
          if (data.oauthUrl) window.open(data.oauthUrl, '_blank');
          watchClaudeLogin(data.accountId);
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
      } else if (vendor === 'codex') {
        if (data.loginSessionId) window.open('index.html?id=' + encodeURIComponent(data.loginSessionId), '_blank');
        toast(data.loginSessionId ? tr('airOfficialAcctTerminalOpened') : tr('airOfficialAcctTerminalOpenFailed', { message: data.error || '' }), !data.loginSessionId);
      } else {
        if (data.oauthUrl) { window.open(data.oauthUrl, '_blank'); watchClaudeLogin(id); }
        toast(tr('airOfficialAcctFinishInBrowser'));
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

  // ── claude browser-login watch ─────────────────────────────────────────────

  function watchClaudeLogin(accountId) {
    if (!accountId || state.loginWatch[accountId]) return;
    const startedAt = Date.now();
    state.loginWatch[accountId] = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60 * 1000) { stopWatch(accountId); return; }
      try {
        const s = await api().json('/api/claude/accounts/' + encodeURIComponent(accountId) + '/login-status');
        if (s.state === 'pending') return;
        stopWatch(accountId);
        if (s.state === 'complete') {
          toast(s.email ? tr('airOfficialAcctClaudeLoginDoneEmail', { email: s.email }) : tr('airOfficialAcctClaudeLoginDone'));
        } else if (s.state === 'error') {
          toast(tr('airOfficialAcctClaudeLoginFailed', { message: s.error || '' }), true);
        }
        loadOfficialAccounts();
      } catch (_) { /* transient — keep polling until the timeout */ }
    }, 2000);
  }

  function stopWatch(accountId) {
    clearInterval(state.loginWatch[accountId]);
    delete state.loginWatch[accountId];
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
  });

  // Provider 视图每次被打开时刷新（账号可能刚在别处登录/删除过）。
  if (document.body) {
    new MutationObserver(() => {
      if (document.body.dataset.view === 'provider') loadOfficialAccounts();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    if (document.body.dataset.view === 'provider') loadOfficialAccounts();
  }

  window.MultiCCOfficialAccounts = { load: loadOfficialAccounts, renderCodexQuota, renderClaudeQuota };
})();
