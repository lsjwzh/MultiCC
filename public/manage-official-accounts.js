'use strict';

/* 官方账号（多账号登录）管理 —— Provider 配置页的独立区块。
 *
 * 每个官方账号 = 一条带 settingsConfig.officialAccount.id 标记的 provider 记录
 * + 一份 multicc 持有的独立凭证（~/.multicc/official-accounts/…），CLI 子进程
 * 永远不接触 OAuth 凭证，请求时由 cpr 代理按标记现场注入（见
 * src/routes/codex-accounts.js 与 src/routes/claude-accounts.js）。
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
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v));
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
    if (!q) return '<span style="color:var(--faint)">余量未查询</span>';
    if (q.status === 'loading') return '<span style="color:var(--faint)">余量查询中…</span>';
    if (q.status === 'err') return '<span style="color:var(--danger)">余量：' + esc(q.error) + '</span>';
    return q.html;
  }

  function renderCodexQuota(data) {
    const bar = window.QuotaBarView && data.bar ? window.QuotaBarView.resolveQuotaBar(data.bar) : null;
    if (bar && bar.text) {
      const extra = [];
      if (data.planType) extra.push('套餐 ' + esc(data.planType));
      if (data.credits && data.credits.hasCredits) extra.push('credits $' + esc(data.credits.balance));
      return '<span style="color:' + esc(bar.color) + '" title="' + esc(bar.title || '') + '">' + esc(bar.text) + '</span>'
        + (extra.length ? ' <span style="color:var(--faint);font-size:11px">' + extra.join(' · ') + '</span>' : '');
    }
    return '<span style="color:var(--faint)">余量不可用</span>';
  }

  function renderClaudeQuota(data) {
    const usage = data.usage || {};
    const segs = [];
    const windowLabel = { five_hour: '5h', seven_day: '周', seven_day_sonnet: '周·Sonnet' };
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
      segs.push('<span style="color:' + color + '">' + windowLabel[key] + ' 剩 ' + remaining + '%' + esc(resets) + '</span>');
    }
    if (!segs.length) return '<span style="color:var(--faint)">余量不可用</span>';
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
        state.quota[quotaKey(vendor, id)] = { status: 'err', error: data.error || data.status || '查询失败' };
      } else {
        state.quota[quotaKey(vendor, id)] = {
          status: 'ok',
          html: vendor === 'codex' ? renderCodexQuota(data) : renderClaudeQuota(data),
        };
      }
    } catch (err) {
      state.quota[quotaKey(vendor, id)] = { status: 'err', error: err.message || '查询失败' };
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
    const chips = a.loggedIn
      ? chip('已登录', '#58a6ff') + (a.email ? ' <span style="font-size:12px;color:var(--muted)">' + esc(a.email) + '</span>' : '')
      : chip('未登录', '#f85149') + ' <span style="font-size:11px;color:var(--faint)">' + esc(a.reason || '') + '</span>';
    const refresh = a.refresh && a.refresh.lastError
      ? ' <span style="font-size:11px;color:var(--danger)" title="凭证刷新">刷新异常：' + esc(a.refresh.lastError) + '</span>' : '';
    return accountRow('codex', a, chips + refresh);
  }

  function claudeRow(a) {
    let chips;
    const login = a.login || { state: 'idle' };
    if (login.state === 'pending') {
      chips = chip('等待浏览器授权…', '#d29922');
    } else if (login.state === 'error') {
      chips = chip('登录失败', '#f85149') + ' <span style="font-size:11px;color:var(--danger)">' + esc(login.error || '') + '</span>';
    } else if (a.loggedIn) {
      chips = chip('已登录', '#58a6ff') + (a.email ? ' <span style="font-size:12px;color:var(--muted)">' + esc(a.email) + '</span>' : '');
    } else {
      chips = chip('未登录', '#f85149');
    }
    const cred = a.credential || {};
    if (cred.lastError) chips += ' <span style="font-size:11px;color:var(--danger)" title="凭证刷新">刷新异常：' + esc(cred.lastError) + '</span>';
    else if (cred.lastRefreshAt) chips += ' <span style="font-size:11px;color:var(--faint)">上次刷新 ' + esc(fmtTime(cred.lastRefreshAt)) + '</span>';
    return accountRow('claude', a, chips);
  }

  function accountRow(vendor, a, chipsHtml) {
    const name = a.label || (vendor === 'codex' ? 'Codex 账号' : 'Claude 账号') + ' ' + a.id.slice(0, 6);
    const provider = a.providerName
      ? '<span style="font-size:11px;color:var(--faint)">⇄ ' + esc(a.providerName) + '</span>' : '';
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<b style="font-size:13px">' + esc(name) + '</b>' + chipsHtml + provider
      + '<span style="margin-left:auto;display:flex;gap:6px">'
      + '<button class="btn" style="padding:2px 10px;font-size:11px" data-act="quota" data-vendor="' + vendor + '" data-id="' + a.id + '">刷新余量</button>'
      + '<button class="btn" style="padding:2px 10px;font-size:11px" data-act="relogin" data-vendor="' + vendor + '" data-id="' + a.id + '">重新登录</button>'
      + '<button class="btn" style="padding:2px 10px;font-size:11px;color:var(--danger)" data-act="delete" data-vendor="' + vendor + '" data-id="' + a.id + '">删除</button>'
      + '</span></div>'
      + '<div style="font-size:12px">' + quotaHtml(vendor, a.id) + '</div>'
      + '</div>';
  }

  function vendorSection(vendor, title, hint, accounts, rowFn) {
    const rows = accounts.length
      ? accounts.map(rowFn).join('')
      : '<div style="font-size:12px;color:var(--faint)">暂无账号，点下方按钮添加。</div>';
    return '<div style="display:flex;flex-direction:column;gap:8px">'
      + '<div style="font-size:12px;color:var(--muted);font-weight:600">' + title
      + ' <span style="font-weight:400;color:var(--faint)">' + hint + '</span></div>'
      + rows + '</div>';
  }

  function paint() {
    const el = bodyEl();
    if (!el) return;
    if (state.loading) { el.innerHTML = '<span style="color:var(--faint);font-size:13px">加载中…</span>'; return; }
    el.innerHTML = vendorSection('codex', 'Codex 官方账号', '（ChatGPT 订阅，登录走独立终端，凭证由代理按账号注入）', state.codex, codexRow)
      + '<div style="border-top:1px solid var(--border);margin:10px 0"></div>'
      + vendorSection('claude', 'Claude 官方账号', '（Claude 订阅，登录走浏览器 OAuth，token 到期自动刷新）', state.claude, claudeRow);
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
      if (el) el.innerHTML = '<span style="color:var(--danger);font-size:13px">加载失败：' + esc(err.message) + '</span>';
    }
  }

  function refreshProviders() { if (typeof loadProviders === 'function') loadProviders(); }

  // ── add / relogin / delete ─────────────────────────────────────────────────

  function labelOverlay(vendor, onConfirm) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const isCodex = vendor === 'codex';
    overlay.innerHTML = '<div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:440px;max-width:92vw;">'
      + '<div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">添加 ' + (isCodex ? 'Codex' : 'Claude') + ' 官方账号</div>'
      + '<div style="font-size:12px;color:var(--faint);margin-bottom:10px;line-height:1.6">'
      + (isCodex
        ? '会创建一条带账号标记的 provider 并打开一个登录终端（独立 CODEX_HOME），在终端里完成浏览器授权即可；不影响共享的 ~/.codex 登录。'
        : '会创建一条带账号标记的 provider 并打开 Claude 授权页，授权后自动回到本页完成登录；token 到期由 multicc 自动刷新。')
      + '</div>'
      + '<input data-k="label" type="text" placeholder="备注（可选），如：工作号" maxlength="64" style="width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 10px;outline:none">'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '<button class="btn" data-act="close" style="font-size:13px">取消</button>'
      + '<button class="btn btn-green" data-act="ok" style="font-size:13px">创建并登录</button>'
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
      st.textContent = '创建中…'; st.className = 'status-text';
      try {
        const data = await api().json('/api/' + vendor + '/accounts', { method: 'POST', json: { label } });
        close();
        if (vendor === 'codex') {
          if (data.loginSessionId) {
            toast('已创建，正在打开登录终端…');
            window.open('chat.html?session=' + encodeURIComponent(data.loginSessionId), '_blank');
          } else { toast('账号已创建，但登录终端打开失败：' + (data.error || ''), true); }
        } else {
          toast('已创建，请在打开的授权页完成登录');
          if (data.oauthUrl) window.open(data.oauthUrl, '_blank');
          watchClaudeLogin(data.accountId);
        }
        loadOfficialAccounts();
        refreshProviders();
      } catch (err) {
        st.textContent = 'Failed: ' + err.message; st.className = 'status-text err';
      }
    });
  }

  async function relogin(vendor, id) {
    setStatus('正在重新打开登录…');
    try {
      const data = await api().json('/api/' + vendor + '/accounts/' + encodeURIComponent(id) + '/relogin', { method: 'POST', json: {} });
      if (vendor === 'codex') {
        if (data.loginSessionId) window.open('chat.html?session=' + encodeURIComponent(data.loginSessionId), '_blank');
        toast(data.loginSessionId ? '登录终端已打开' : ('登录终端打开失败：' + (data.error || '')), !data.loginSessionId);
      } else {
        if (data.oauthUrl) { window.open(data.oauthUrl, '_blank'); watchClaudeLogin(id); }
        toast('请在打开的授权页完成登录');
      }
      setStatus('');
      loadOfficialAccounts();
    } catch (err) { setStatus('重新登录失败：' + err.message, true); }
  }

  async function removeAccount(vendor, id) {
    if (!window.confirm('删除该官方账号？其凭证文件与绑定的 provider 记录会一并移除。')) return;
    setStatus('删除中…');
    try {
      await api().json('/api/' + vendor + '/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
      delete state.quota[quotaKey(vendor, id)];
      toast('已删除');
      setStatus('');
      loadOfficialAccounts();
      refreshProviders();
    } catch (err) { setStatus('删除失败：' + err.message, true); }
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
          toast('Claude 账号登录完成' + (s.email ? '：' + s.email : ''));
        } else if (s.state === 'error') {
          toast('Claude 账号登录失败：' + (s.error || ''), true);
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
