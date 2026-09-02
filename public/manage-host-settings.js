(function initManageHostSettings(global) {
  'use strict';

  /* ── Push Notification Diagnostics ── */

  function formatTimestamp(ts) {
    if (!ts) return '—';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  async function loadPushDiagnostics() {
    // Client-side info
    if (typeof getPushInfo === 'function') {
      const info = getPushInfo();
      const permEl = document.getElementById('push-d-permission');
      const subEl = document.getElementById('push-d-sub-status');
      const epEl = document.getElementById('push-d-endpoint');
      const platEl = document.getElementById('push-d-platform');
      const toggleEl = document.getElementById('push-d-toggle');

      if (permEl) {
        permEl.textContent = info.permission;
        permEl.style.color = info.permission === 'granted' ? '#3fb950' : info.permission === 'denied' ? '#f85149' : '#d29922';
      }
      if (subEl) {
        if (info.subscribed) {
          subEl.textContent = 'Active';
          subEl.style.color = '#3fb950';
        } else {
          subEl.textContent = 'None';
          subEl.style.color = '#8b949e';
        }
      }
      if (epEl) {
        if (info.endpoint) {
          const ep = info.endpoint;
          epEl.textContent = ep.length > 60 ? ep.slice(0, 40) + '...' + ep.slice(-15) : ep;
        } else {
          epEl.textContent = '—';
        }
      }
      if (platEl) platEl.textContent = info.platform;
      if (toggleEl) {
        toggleEl.textContent = info.subscribed ? 'Push ON' : 'Push';
        toggleEl.className = info.subscribed ? 'btn btn-green' : 'btn';
      }
    }

    // Server-side health
    try {
      const res = await fetch('/api/push/health' + tokenQS('?'));
      if (!res.ok) return;
      const data = await res.json();

      const g = data.global;
      document.getElementById('push-d-last-push').textContent = g.lastPushTime
        ? `${formatTimestamp(g.lastPushTime)} (${g.lastPushType})`
        : 'Never';

      const total = g.totalSuccess + g.totalFail;
      const rateEl = document.getElementById('push-d-rate');
      if (total > 0) {
        const pct = Math.round(g.totalSuccess / total * 100);
        rateEl.textContent = `${pct}% (${g.totalSuccess}/${total})`;
        rateEl.style.color = pct >= 90 ? '#3fb950' : pct >= 70 ? '#d29922' : '#f85149';
      } else {
        rateEl.textContent = 'No data';
        rateEl.style.color = '#8b949e';
      }

      document.getElementById('push-d-total').textContent = g.totalSent || '0';
      document.getElementById('push-d-sub-count').textContent = data.subscriptionCount || '0';

      // Last error from any subscription
      let lastErr = null;
      for (const s of data.subscriptions || []) {
        if (s.lastFailTime && (!lastErr || s.lastFailTime > lastErr.time)) {
          lastErr = { time: s.lastFailTime, reason: s.lastFailReason };
        }
      }
      const errEl = document.getElementById('push-d-last-error');
      if (lastErr) {
        errEl.textContent = `${lastErr.reason} (${formatTimestamp(lastErr.time)})`;
        errEl.style.color = '#f85149';
      } else {
        errEl.textContent = 'None';
        errEl.style.color = '#3fb950';
      }
    } catch (e) {
      console.error('[manage] Failed to load push health:', e);
    }
  }

  async function sendTestPush() {
    const statusEl = document.getElementById('push-d-test-status');
    statusEl.textContent = 'Sending...';
    statusEl.className = 'status-text';
    try {
      const res = await fetch('/api/push/test' + tokenQS('?'), { method: 'POST' });
      const data = await res.json();
      statusEl.textContent = `Sent to ${data.subscribers} subscriber(s)`;
      statusEl.className = 'status-text ok';
      setTimeout(() => loadPushDiagnostics(), 2000);
    } catch (e) {
      statusEl.textContent = 'Failed: ' + e.message;
      statusEl.className = 'status-text err';
    }
  }

  async function loadNotifySettings() {
    try {
      const res = await fetch('/api/settings/notify' + tokenQS('?'));
      const cfg = await res.json();
      const barkInput = document.getElementById('push-d-bark');
      const webhookInput = document.getElementById('push-d-webhook');
      // Show full URL only if user has set one (server masks it for GET)
      if (barkInput && cfg.hasBark) barkInput.placeholder = cfg.barkUrl || 'Configured';
      if (webhookInput && cfg.webhookUrl) webhookInput.value = cfg.webhookUrl;
    } catch (_) {}
  }

  async function saveNotifySettings() {
    const statusEl = document.getElementById('push-d-backup-status');
    const barkVal = document.getElementById('push-d-bark').value.trim();
    const webhookVal = document.getElementById('push-d-webhook').value.trim();
    const body = {};
    if (barkVal) body.barkUrl = barkVal;
    if (webhookVal !== undefined) body.webhookUrl = webhookVal;

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/settings/notify', { method: 'POST', headers, body: JSON.stringify(body) });
      if (res.ok) {
        statusEl.textContent = 'Saved';
        statusEl.className = 'status-text ok';
        showToast('Notification settings saved');
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.className = 'status-text err';
    }
  }

  async function testBark() {
    const statusEl = document.getElementById('push-d-backup-status');
    statusEl.textContent = 'Testing Bark...';
    statusEl.className = 'status-text';
    try {
      const res = await fetch('/api/push/test-bark' + tokenQS('?'), { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      statusEl.textContent = 'Bark test sent';
      statusEl.className = 'status-text ok';
    } catch (e) {
      statusEl.textContent = 'Bark: ' + e.message;
      statusEl.className = 'status-text err';
    }
  }

  async function testWebhook() {
    const statusEl = document.getElementById('push-d-backup-status');
    statusEl.textContent = 'Testing Webhook...';
    statusEl.className = 'status-text';
    try {
      const res = await fetch('/api/push/test-webhook' + tokenQS('?'), { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      statusEl.textContent = 'Webhook test sent';
      statusEl.className = 'status-text ok';
    } catch (e) {
      statusEl.textContent = 'Webhook: ' + e.message;
      statusEl.className = 'status-text err';
    }
  }

  /* ── 外网穿透监控 Tunnel ── */
  function tnlFmtStatus(p, prov, avail) {
    // p = runtime provider state; prov = config provider {enabled,url}
    const observeOnly = !prov.enabled && !!prov.funnel;
    if (!prov.enabled && !prov.funnel) return '未启用';
    const funnelProbe = !!prov.funnel && p.probeMode === 'tailscale_funnel_public';
    if (!prov.url && !prov.funnel) return '未配置 URL';
    if (!p.lastCheckAt) return '等待首次探活…';
    const when = new Date(p.lastCheckAt).toLocaleTimeString();
    if (p.probeVerdict === 'degraded') {
      let s = `公网 Funnel 部分可用 · 边缘 ${p.edgeSuccessCount || 0}/${p.resolvedAddressCount || 0} · ${when}`;
      s += ' · 已告警，不自动修复';
      return s;
    }
    if (p.probeVerdict === 'indeterminate') {
      let s = `公网探针不确定 (${p.probeError || 'unknown'}) · ${when}`;
      if (prov.monitorOnly) {
        s += funnelProbe ? ' · 仅监控（不自动修复 Funnel）' : ' · 仅监控（不自动重启）';
        return s;
      }
      if (p.lastAction) s += ` · ${p.lastAction}`;
      return s;
    }
    // URL 探活 与 客户端进程 是两个维度：URL 活着不代表本机的 frpc/natapp
    // 在跑（这个 URL 可能根本是别家隧道的），措辞上必须分开。
    const label = funnelProbe ? '公网 Funnel' : 'URL 探活';
    let s = label + ' ' + (p.healthy ? `正常 (HTTP ${p.lastHttpCode})` : `异常 (HTTP ${p.lastHttpCode}，连续 ${p.consecutiveFails} 次)`);
    if (funnelProbe && p.resolvedAddressCount) s += ` · 边缘 ${p.edgeSuccessCount || 0}/${p.resolvedAddressCount}`;
    s += ` · ${when}`;
    if (observeOnly) {
      s += ' · 仅观察（自动修复未启用）';
      return s;
    }
    if (prov.monitorOnly) {
      s += funnelProbe ? ' · 仅监控（不自动修复 Funnel）' : ' · 仅监控（不自动重启）';
      return s;
    }
    // 客户端二进制不存在时 multicc 根本无法托管/重启它（URL 往往是外部隧道
    // 提供的）——显示中性事实，而不是任何历史重启文案。
    if (avail === false) {
      s += ' · 客户端: 未安装（非 multicc 托管）';
      return s;
    }
    if (p.restartTimes && p.restartTimes.length) {
      s += funnelProbe ? ` · 近1h修复/重连 ${p.restartTimes.length} 次` : ` · 近1h重启 ${p.restartTimes.length} 次`;
    }
    if (p.lastAction) s += funnelProbe ? ` · 最近动作: ${p.lastAction}` : ` · 客户端: ${p.lastAction}`;
    return s;
  }

  // ── Access token (external-access login password) ──
  async function loadAccessToken() {
    const input = document.getElementById('tnl-token');
    const hint = document.getElementById('tnl-token-hint');
    const btn = document.getElementById('tnl-token-save');
    if (!input) return;
    try {
      const res = await fetch('/api/settings/access-token' + tokenQS('?'));
      const d = await res.json();
      if (d.canEdit) {
        // localhost: editable. Show placeholder reflecting current state.
        input.disabled = false;
        input.readOnly = false;
        input.value = '';
        input.placeholder = d.hasToken ? '已设置（留空保存=清除；输入新值=修改）' : '未设置';
        if (hint) { hint.textContent = '· 本机可修改'; hint.style.color = 'var(--faint)'; }
        if (btn) btn.disabled = false;
      } else {
        // remote: read-only masked.
        input.disabled = true;
        input.readOnly = true;
        input.value = d.masked || '';
        input.placeholder = d.hasToken ? '' : '未设置';
        if (hint) { hint.textContent = '· 仅本机可修改'; hint.style.color = 'var(--faint)'; }
        if (btn) btn.disabled = true;
      }
    } catch (_) {}
  }

  async function saveAccessToken() {
    const input = document.getElementById('tnl-token');
    const msg = document.getElementById('tnl-token-msg');
    if (!input || input.disabled) return;
    const token = input.value;
    if (token.includes('****')) { if (msg) { msg.textContent = '未修改'; msg.className = 'status-text'; } return; }
    if (token.trim() && !confirm('保存后，外网/局域网访问都需要用此密码登录，旧的登录会话会失效。确定？')) return;
    if (!token.trim() && !confirm('留空保存将清除访问密码，任何人凭 URL 即可访问。确定？')) return;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/settings/access-token', { method: 'POST', headers, body: JSON.stringify({ token }) });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || ('HTTP ' + res.status));
      if (msg) { msg.textContent = d.hasToken ? '已保存' : '已清除'; msg.className = 'status-text ok'; }
      showToast('访问密码已更新');
      loadAccessToken();
    } catch (e) {
      if (msg) { msg.textContent = '错误: ' + e.message; msg.className = 'status-text err'; }
    }
  }

  // ── Claude Code proxy global toggle ──
  async function loadProxySetting() {
    const cb = document.getElementById('cc-proxy-enabled');
    const hint = document.getElementById('cc-proxy-hint');
    if (!cb) return;
    try {
      const res = await fetch('/api/settings/proxy' + tokenQS('?'));
      const d = await res.json();
      cb.checked = !!d.enabled;
      cb.disabled = false;
      if (hint) hint.textContent = '· ' + (d.enabled ? '已开启' : '已关闭');
    } catch (_) {}
  }

  async function saveProxySetting() {
    const cb = document.getElementById('cc-proxy-enabled');
    const msg = document.getElementById('cc-proxy-msg');
    if (!cb) return;
    const enabled = cb.checked;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/settings/proxy', { method: 'POST', headers, body: JSON.stringify({ enabled }) });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || ('HTTP ' + res.status));
      cb.checked = !!d.enabled;
      const hint = document.getElementById('cc-proxy-hint');
      if (hint) hint.textContent = '· ' + (d.enabled ? '已开启' : '已关闭');
      if (msg) { msg.textContent = (d.enabled ? '已开启' : '已关闭') + '（下一轮 spawn 生效）'; msg.className = 'status-text ok'; }
    } catch (e) {
      if (msg) { msg.textContent = '错误: ' + e.message; msg.className = 'status-text err'; }
    }
  }

  // ── Route claude-official (OAuth) through the proxy — default OFF ──
  async function loadOfficialOAuthSetting() {
    const cb = document.getElementById('cc-oauth-enabled');
    const hint = document.getElementById('cc-oauth-hint');
    if (!cb) return;
    try {
      const res = await fetch('/api/settings/official-oauth' + tokenQS('?'));
      const d = await res.json();
      cb.checked = !!d.enabled;
      cb.disabled = false;
      if (hint) hint.textContent = '· ' + (d.enabled ? '已开启 ⚠️' : '已关闭');
    } catch (_) {}
  }

  async function saveOfficialOAuthSetting() {
    const cb = document.getElementById('cc-oauth-enabled');
    const msg = document.getElementById('cc-oauth-msg');
    if (!cb) return;
    if (cb.checked && !confirm('开启后会在官方客户端之外重放你的订阅 OAuth token，可能违反 Anthropic 服务条款并有账号风险。确定开启？')) {
      cb.checked = false; return;
    }
    const enabled = cb.checked;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/settings/official-oauth', { method: 'POST', headers, body: JSON.stringify({ enabled }) });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || ('HTTP ' + res.status));
      cb.checked = !!d.enabled;
      const hint = document.getElementById('cc-oauth-hint');
      if (hint) hint.textContent = '· ' + (d.enabled ? '已开启 ⚠️' : '已关闭');
      if (msg) { msg.textContent = (d.enabled ? '已开启' : '已关闭') + '（下一轮 spawn 生效）'; msg.className = 'status-text ok'; }
    } catch (e) {
      if (msg) { msg.textContent = '错误: ' + e.message; msg.className = 'status-text err'; }
    }
  }

  // Degrade「立即重启」instead of letting it fail opaquely: no client binary
  // means there is nothing we can launch, and monitor-only mode deliberately
  // never touches the client process.
  function tnlGateRestart(btnId, available, monitorOnly, tailscaleMode = false) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (monitorOnly) {
      btn.disabled = true;
      btn.title = tailscaleMode ? '仅监控模式下不修复 Funnel 或重连控制面' : '仅监控模式下不重启客户端';
      return;
    }
    if (available === false) { btn.disabled = true; btn.title = '未检测到客户端，请先安装'; return; }
    btn.disabled = false;
    btn.title = '';
  }

  async function loadTunnelSettings() {
    loadAccessToken();
    loadProxySetting();
    loadOfficialOAuthSetting();
    try {
      const res = await fetch('/api/settings/tunnel' + tokenQS('?'));
      const st = await res.json();
      const c = st.config, av = st.availability || {}, pr = st.providers || {};
      // availability hints
      const phAvail = document.getElementById('tnl-ph-avail');
      if (phAvail) phAvail.textContent = av.phddns ? '· 已安装' : '· 未检测到 PhDDNS.app';
      const tsAvail = document.getElementById('tnl-ts-avail');
      if (tsAvail) tsAvail.textContent = av.tailscale ? '· CLI 可用' : '· 未检测到 tailscale CLI';
      // phddns
      document.getElementById('tnl-ph-enabled').checked = !!c.phddns.enabled;
      document.getElementById('tnl-ph-monitoronly').checked = !!c.phddns.monitorOnly;
      document.getElementById('tnl-ph-url').value = c.phddns.url || '';
      document.getElementById('tnl-ph-status').textContent = tnlFmtStatus(pr.phddns || {}, c.phddns, av.phddns);
      tnlGateRestart('tnl-ph-restart', av.phddns, !!c.phddns.monitorOnly);
      // tailscale
      document.getElementById('tnl-ts-enabled').checked = !!c.tailscale.enabled;
      document.getElementById('tnl-ts-monitoronly').checked = !!c.tailscale.monitorOnly;
      document.getElementById('tnl-ts-url').value = c.tailscale.url || '';
      document.getElementById('tnl-ts-status').textContent = tnlFmtStatus(pr.tailscale || {}, c.tailscale, av.tailscale);
      const tsPublicUrl = document.getElementById('tnl-ts-publicurl');
      if (tsPublicUrl) tsPublicUrl.textContent = pr.tailscale?.publicUrl || '等待公网探测…';
      tnlGateRestart('tnl-ts-restart', av.tailscale, !!c.tailscale.monitorOnly, true);
      document.getElementById('tnl-ts-funnel').checked = !!c.tailscale.funnel;
      document.getElementById('tnl-ts-funnelport').value = c.tailscale.funnelPort || 3000;
      // natapp (硬编码隧道)
      const na = c.natapp || {};
      document.getElementById('tnl-na-enabled').checked = !!na.enabled;
      document.getElementById('tnl-na-monitoronly').checked = !!na.monitorOnly;
      document.getElementById('tnl-na-url').value = na.url || '';
      document.getElementById('tnl-na-authtoken').value = na.authtoken || '';
      document.getElementById('tnl-na-port').value = na.port || 3000;
      document.getElementById('tnl-na-startcmd').value = na.startCmd || '';
      document.getElementById('tnl-na-status').textContent = tnlFmtStatus(pr.natapp || {}, na, av.natapp);
      tnlGateRestart('tnl-na-restart', av.natapp, !!na.monitorOnly);
      const naAvail = document.getElementById('tnl-na-avail');
      if (naAvail) naAvail.textContent = av.natapp ? '· 已安装' : '· 未检测到 natapp';
      // cpolar (硬编码隧道)
      const cp = c.cpolar || {};
      document.getElementById('tnl-cp-enabled').checked = !!cp.enabled;
      document.getElementById('tnl-cp-monitoronly').checked = !!cp.monitorOnly;
      document.getElementById('tnl-cp-url').value = cp.url || '';
      document.getElementById('tnl-cp-authtoken').value = cp.authtoken || '';
      document.getElementById('tnl-cp-port').value = cp.port || 3000;
      document.getElementById('tnl-cp-startcmd').value = cp.startCmd || '';
      document.getElementById('tnl-cp-status').textContent = tnlFmtStatus(pr.cpolar || {}, cp, av.cpolar);
      tnlGateRestart('tnl-cp-restart', av.cpolar, !!cp.monitorOnly);
      const cpAvail = document.getElementById('tnl-cp-avail');
      if (cpAvail) cpAvail.textContent = av.cpolar ? '· 已安装' : '· 未检测到 cpolar';
      // sakurafrp (硬编码隧道)
      const sf = c.sakurafrp || {};
      document.getElementById('tnl-sf-enabled').checked = !!sf.enabled;
      document.getElementById('tnl-sf-monitoronly').checked = !!sf.monitorOnly;
      document.getElementById('tnl-sf-url').value = sf.url || '';
      document.getElementById('tnl-sf-authtoken').value = sf.authtoken || '';
      document.getElementById('tnl-sf-port').value = sf.port || 3000;
      document.getElementById('tnl-sf-startcmd').value = sf.startCmd || '';
      document.getElementById('tnl-sf-status').textContent = tnlFmtStatus(pr.sakurafrp || {}, sf, av.sakurafrp);
      tnlGateRestart('tnl-sf-restart', av.sakurafrp, !!sf.monitorOnly);
      const sfAvail = document.getElementById('tnl-sf-avail');
      if (sfAvail) sfAvail.textContent = av.sakurafrp ? '· 已安装' : '· 未检测到 sakurafrp';
      loadFunnelStatus();
      loadIpv6Status();
      // advanced
      document.getElementById('tnl-interval').value = c.intervalSec;
      document.getElementById('tnl-failthreshold').value = c.failThreshold;
      document.getElementById('tnl-cooldown').value = c.restartCooldownSec;
      document.getElementById('tnl-maxrestarts').value = c.maxRestartsPerHour;
    } catch (_) {}
  }

  async function saveTunnelSettings() {
    const msg = document.getElementById('tnl-adv-msg');
    const numOr = (id) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : undefined; };
    const body = {
      phddns: {
        enabled: document.getElementById('tnl-ph-enabled').checked,
        monitorOnly: document.getElementById('tnl-ph-monitoronly').checked,
        url: document.getElementById('tnl-ph-url').value.trim(),
      },
      tailscale: {
        enabled: document.getElementById('tnl-ts-enabled').checked,
        monitorOnly: document.getElementById('tnl-ts-monitoronly').checked,
        url: document.getElementById('tnl-ts-url').value.trim(),
        funnel: document.getElementById('tnl-ts-funnel').checked,
      },
    };
    const fp = parseInt(document.getElementById('tnl-ts-funnelport').value, 10);
    if (Number.isFinite(fp) && fp > 0) body.tailscale.funnelPort = fp;
    // natapp / cpolar / sakurafrp - 硬编码隧道，支持自定义启动命令。
    // startCmd 留空时不放入 body，以免空串覆盖服务端默认模板（applyConfig 是浅 merge）。
    body.natapp = {
      enabled: document.getElementById('tnl-na-enabled').checked,
      monitorOnly: document.getElementById('tnl-na-monitoronly').checked,
      url: document.getElementById('tnl-na-url').value.trim(),
      authtoken: document.getElementById('tnl-na-authtoken').value,
    };
    {
      const p = parseInt(document.getElementById('tnl-na-port').value, 10);
      if (Number.isFinite(p) && p > 0) body.natapp.port = p;
      const sc = document.getElementById('tnl-na-startcmd').value.trim();
      if (sc) body.natapp.startCmd = sc;
    }
    body.cpolar = {
      enabled: document.getElementById('tnl-cp-enabled').checked,
      monitorOnly: document.getElementById('tnl-cp-monitoronly').checked,
      url: document.getElementById('tnl-cp-url').value.trim(),
      authtoken: document.getElementById('tnl-cp-authtoken').value,
    };
    {
      const p = parseInt(document.getElementById('tnl-cp-port').value, 10);
      if (Number.isFinite(p) && p > 0) body.cpolar.port = p;
      const sc = document.getElementById('tnl-cp-startcmd').value.trim();
      if (sc) body.cpolar.startCmd = sc;
    }
    body.sakurafrp = {
      enabled: document.getElementById('tnl-sf-enabled').checked,
      monitorOnly: document.getElementById('tnl-sf-monitoronly').checked,
      url: document.getElementById('tnl-sf-url').value.trim(),
      authtoken: document.getElementById('tnl-sf-authtoken').value,
    };
    {
      const p = parseInt(document.getElementById('tnl-sf-port').value, 10);
      if (Number.isFinite(p) && p > 0) body.sakurafrp.port = p;
      const sc = document.getElementById('tnl-sf-startcmd').value.trim();
      if (sc) body.sakurafrp.startCmd = sc;
    }
    const iv = numOr('tnl-interval'); if (iv) body.intervalSec = iv;
    const ft = numOr('tnl-failthreshold'); if (ft) body.failThreshold = ft;
    const cd = numOr('tnl-cooldown'); if (cd !== undefined) body.restartCooldownSec = cd;
    const mr = numOr('tnl-maxrestarts'); if (mr) body.maxRestartsPerHour = mr;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/settings/tunnel', { method: 'POST', headers, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.ok) throw new Error(d?.error || ('HTTP ' + res.status));
      if (msg) { msg.textContent = '已保存'; msg.className = 'status-text ok'; }
      showToast('外网穿透设置已保存');
      loadTunnelSettings();
    } catch (e) {
      if (msg) { msg.textContent = '错误: ' + e.message; msg.className = 'status-text err'; }
    }
  }

  async function restartTunnel(provider) {
    const msgId = { phddns: 'tnl-ph-msg', tailscale: 'tnl-ts-msg', natapp: 'tnl-na-msg', cpolar: 'tnl-cp-msg', sakurafrp: 'tnl-sf-msg' }[provider];
    const msg = document.getElementById(msgId);
    if (msg) { msg.textContent = '正在重启…'; msg.className = 'status-text'; }
    try {
      const headers = {};
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/tunnel/restart/' + provider, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || ('HTTP ' + res.status));
      if (msg) { msg.textContent = data.message || '已触发重启'; msg.className = 'status-text ok'; }
      setTimeout(loadTunnelSettings, 1500);
    } catch (e) {
      if (msg) { msg.textContent = '失败: ' + e.message; msg.className = 'status-text err'; }
    }
  }

  // ── Restart the whole multicc service (moved here from the chat page header) ──
  // POSTs /api/restart; the server schedules a detached graceful `./multicc restart`
  // (drains in-flight messages, then relaunches). All sessions briefly disconnect
  // and auto-reconnect once the fresh instance is up.
  async function restartMulticcService() {
    if (!(await showConfirm('确定要重启 multicc 服务吗？\n这会短暂断开所有会话，随后自动重连（在途消息会先保存）。', { danger: true, okText: '重启' }))) return;
    const headers = { 'Content-Type': 'application/json' };
    if (_urlToken) headers['X-Access-Token'] = _urlToken;
    try {
      const res = await fetch('/api/restart', { method: 'POST', headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast('重启失败：' + (data.error || 'HTTP ' + res.status), true); return; }
      if (data.activeStreaming > 0) {
        showToast('⚠️ 有 ' + data.activeStreaming + ' 个会话正在输出，其在途内容已保存、将被中断', true);
      } else {
        showToast('重启请求已发送，服务即将重启…');
      }
    } catch (e) {
      showToast('重启请求失败：' + e.message, true);
    }
  }

  // Read-only Funnel status text (tailscale funnel status output).
  async function loadFunnelStatus() {
    const el = document.getElementById('tnl-ts-funnelstatus');
    if (!el) return;
    try {
      const res = await fetch('/api/tunnel/funnel' + tokenQS('?'));
      const data = await res.json();
      el.textContent = (data.status && data.status.trim()) || '未开启 (No serve config)';
    } catch (_) { el.textContent = '—'; }
  }

  // Detect whether remote clients can reach this host via direct IPv6 (vs DERP relay).
  // `manual` = triggered by the 检测 button → show a transient "检测中…" hint.
  async function loadIpv6Status(manual) {
    const sEl = document.getElementById('tnl-ipv6-status');
    const aEl = document.getElementById('tnl-ipv6-addr');
    if (!sEl) return;
    if (manual) sEl.textContent = '检测中…';
    try {
      const res = await fetch('/api/tunnel/ipv6' + tokenQS('?'));
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || ('HTTP ' + res.status));
      const ts = d.tailscale || {};
      if (d.directReady) {
        sEl.textContent = '✅ 就绪 — 远程可走 IPv6 直连';
        sEl.style.color = 'var(--green, #16a34a)';
      } else if (!d.host || !d.host.hasGlobalV6) {
        sEl.textContent = '❌ 本机无全局 IPv6（路由器/ISP 未下发）';
        sEl.style.color = 'var(--err, #dc2626)';
      } else if (ts.available && ts.ipv6 === false) {
        sEl.textContent = '⚠️ 有本机地址但 Tailscale 测不通 IPv6（可能被运营商拦入站）';
        sEl.style.color = 'var(--warn, #d97706)';
      } else {
        sEl.textContent = '✅ 本机有全局 IPv6' + (ts.available ? '' : '（无 tailscale CLI，未二次验证）');
        sEl.style.color = 'var(--green, #16a34a)';
      }
      const addrs = (d.host && d.host.addresses || []).map(x => `${x.address} (${x.iface})`);
      let line = addrs.length ? addrs.join('\n') : '无';
      if (ts.detail) line += `\nTailscale netcheck → IPv6: ${ts.detail}`;
      if (ts.nearestDerp) line += `\n最近 DERP 中继: ${ts.nearestDerp}`;
      if (aEl) aEl.textContent = line;
    } catch (e) {
      sEl.textContent = '检测失败: ' + e.message;
      sEl.style.color = 'var(--err, #dc2626)';
    }
  }

  // Apply the Funnel checkbox: open/close public-internet exposure on the port.
  async function applyFunnel() {
    const msg = document.getElementById('tnl-ts-msg');
    const on = document.getElementById('tnl-ts-funnel').checked;
    const port = parseInt(document.getElementById('tnl-ts-funnelport').value, 10) || 3000;
    if (on && !confirm(`确定开启 Funnel 公网访问？\n这会把端口 ${port} 暴露到整个互联网（任何人凭 URL 可访问）。\n请确认已设置足够强的 ACCESS_TOKEN。`)) return;
    if (msg) { msg.textContent = on ? '正在开启 Funnel…' : '正在关闭 Funnel…'; msg.className = 'status-text'; }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/tunnel/funnel', { method: 'POST', headers, body: JSON.stringify({ on, port }) });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || data.message || ('HTTP ' + res.status));
      if (msg) { msg.textContent = data.message || '完成'; msg.className = 'status-text ok'; }
      // Persist the funnel flag/port into config too, then refresh status.
      saveTunnelSettings();
      setTimeout(loadFunnelStatus, 1200);
    } catch (e) {
      if (msg) { msg.textContent = '失败: ' + e.message; msg.className = 'status-text err'; }
    }
  }

  /* ── APK distribution ── */
  let _apkLoadPromise = null;
  let _apkInfo = { exists: false, localExists: false, source: null };
  let _apkLoadError = '';

  function apkText(key, params) {
    return typeof global.t === 'function' ? global.t(key, params) : key;
  }

  function formatApkVersion(name, code) {
    if (!name) return '—';
    return code == null ? String(name) : `${name}+${code}`;
  }

  function formatApkTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    const pad = part => String(part).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatApkSize(value) {
    const bytes = Number(value);
    return Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1048576).toFixed(1)} MB` : '—';
  }

  function safeApkDownloadUrl(value) {
    const url = String(value || '');
    if (url === '/multicc.apk') return url;
    return /^https:\/\/github\.com\/lsjwzh\/MultiCC\/releases\/download\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\/multicc\.apk$/.test(url)
      ? url : '';
  }

  function renderApkInfo() {
    const quick = document.getElementById('apk-btn');
    const summary = document.getElementById('apk-artifact-summary');
    const hint = document.getElementById('apk-card-hint');
    const status = document.getElementById('apk-source-status');
    const download = document.getElementById('apk-download-btn');
    if (!quick && !summary && !status && !download) return;

    const info = _apkInfo || { exists: false, localExists: false, source: null };
    const target = formatApkVersion(info.targetVersionName, info.targetVersionCode);
    const published = formatApkVersion(info.versionName, info.versionCode);
    const size = formatApkSize(info.size);
    const time = formatApkTime(info.mtime);
    const releaseTag = info.releaseTag || '—';

    let artifactText;
    if (info.source === 'local') {
      artifactText = info.localCurrent === false || info.current === false
        ? apkText('apkArtifactLocalStale', { published, target, size, time })
        : apkText('apkArtifactLocal', { published, size, time });
    } else if (info.source === 'release') {
      artifactText = apkText('apkArtifactRelease', { published, releaseTag, size, time });
    } else {
      artifactText = apkText('apkArtifactMissing', { releaseTag, target });
    }
    if (summary) summary.textContent = artifactText;

    if (download) {
      download.textContent = apkText('apkDownload');
      const safeUrl = info.exists ? safeApkDownloadUrl(info.downloadUrl) : '';
      if (safeUrl) {
        download.href = safeUrl;
        download.removeAttribute('aria-disabled');
        download.removeAttribute('tabindex');
        download.title = artifactText;
      } else {
        download.removeAttribute('href');
        download.setAttribute('aria-disabled', 'true');
        download.setAttribute('tabindex', '-1');
        download.title = apkText('apkDownloadUnavailable');
      }
    }

    let stateText;
    let stateTone;
    if (_apkLoadError) {
      stateText = apkText('apkLookupFailed', { error: _apkLoadError });
      stateTone = 'err';
    } else if (info.source === 'local') {
      stateText = info.localCurrent === false || info.current === false
        ? apkText('apkSourceLocalStale', { target }) : apkText('apkSourceLocal');
      stateTone = 'ok';
    } else if (info.source === 'release') {
      stateText = apkText('apkSourceRelease', { releaseTag });
      stateTone = 'ok';
    } else {
      stateText = apkText('apkReleaseMissing', { releaseTag });
      stateTone = 'err';
    }

    if (status) {
      status.textContent = stateText;
      status.className = `apk-status${stateTone ? ` ${stateTone}` : ''}`;
    }
    if (hint) {
      hint.textContent = info.source === 'local' ? apkText('apkSourceLocalShort')
        : info.source === 'release' ? apkText('apkSourceReleaseShort') : apkText('apkSourceUnavailable');
      hint.className = `status-text${info.exists ? ' ok' : ' err'}`;
    }

    if (quick) {
      quick.textContent = info.exists ? 'APK ✓' : 'APK !';
      quick.title = stateText || apkText('apkOpenPanel');
    }
  }

  async function refreshApkInfo() {
    try {
      const infoResp = await fetch('/api/apk-info' + tokenQS('?'));
      if (!infoResp.ok) throw new Error(`HTTP ${infoResp.status}`);
      const info = await infoResp.json();
      _apkInfo = info && typeof info === 'object'
        ? info : { exists: false, localExists: false, source: null };
      _apkLoadError = '';
    } catch (error) {
      _apkLoadError = error && error.message || 'network';
      renderApkInfo();
      return false;
    }
    renderApkInfo();
    return true;
  }

  function loadApkInfo() {
    if (_apkLoadPromise) return _apkLoadPromise;
    _apkLoadPromise = refreshApkInfo().finally(() => { _apkLoadPromise = null; });
    return _apkLoadPromise;
  }

  function openApkPanel() {
    if (typeof global.setView === 'function') global.setView('global');
    if (document.body && document.body.classList) document.body.classList.remove('nav-open');
    const card = document.getElementById('apk-card');
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    loadApkInfo();
  }

  // Kept as a compatibility alias for cached manage.html documents from the
  // immediately preceding build, where the sidebar called this name.
  function handleApkButton() { openApkPanel(); }


  /* ── Service uptime read-out (sidebar, under the version) ── */
  //
  // Lives beside restartMulticcService() on purpose: the button that ends a
  // run and the line that says when the current run began are the same fact
  // seen from two sides.

  // Padded, unlike loadApkInfo's variant: this one sits in a monospace column
  // under the version, where a 1-digit month would break the alignment.
  function fmtBootClock(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // Coarse by design — two units at most. Nobody reads "2h 15m 6s" off a
  // sidebar, and a seconds field would demand a 1s repaint to stay honest.
  function fmtUptime(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return '<1m';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  }

  // {uptimeMs, at} — the server's uptime and the local instant we learned it.
  // Everything on screen is derived from this pair rather than from the
  // server's wall clock, so a host whose clock is off does not render a start
  // time in the future.
  let _bootReading = null;

  function paintBootTime() {
    const timeEl = document.getElementById('boot-time');
    const upEl = document.getElementById('boot-uptime');
    if (!timeEl || !_bootReading) return;
    const uptimeMs = _bootReading.uptimeMs + (Date.now() - _bootReading.at);
    const started = new Date(Date.now() - uptimeMs);
    timeEl.textContent = fmtBootClock(started);
    // The short clock drops the year; the tooltip carries the full instant.
    timeEl.title = started.toLocaleString();
    if (upEl) {
      upEl.textContent = typeof global.t === 'function'
        ? global.t('uptimeDuration', { duration: fmtUptime(uptimeMs) })
        : fmtUptime(uptimeMs);
    }
  }

  async function loadBootTime() {
    if (!document.getElementById('boot-time')) return;
    try {
      const res = await fetch('/api/server-info' + tokenQS('?'));
      const data = await res.json();
      if (!res.ok || !Number.isFinite(data.uptimeMs)) return;   // leave the placeholder
      _bootReading = { uptimeMs: data.uptimeMs, at: Date.now() };
      paintBootTime();
    } catch (_) {
      // An unreachable server has bigger tells than a dash in the sidebar.
    }
  }

  function initialize() {
    loadPushDiagnostics();
    loadNotifySettings();
    loadTunnelSettings();
    loadApkInfo();
    loadBootTime();
    // Repaint from the cached reading — the start instant does not change
    // while the process lives, so this costs no requests.
    setInterval(paintBootTime, 60000);
    // A restart is the one thing that does change it, and the user triggers it
    // by hand. Re-reading whenever the tab comes back is enough to catch that
    // without polling a value that is constant the rest of the time.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        loadBootTime();
        loadApkInfo();
      }
    });
  }

  Object.assign(global, {
    loadPushDiagnostics,
    sendTestPush,
    saveNotifySettings,
    testBark,
    testWebhook,
    saveAccessToken,
    saveProxySetting,
    saveOfficialOAuthSetting,
    loadTunnelSettings,
    saveTunnelSettings,
    restartTunnel,
    restartMulticcService,
    loadIpv6Status,
    applyFunnel,
    loadApkInfo,
    openApkPanel,
    handleApkButton,
    loadBootTime,
  });
  global.MultiCCManageHostSettings = Object.freeze({ initialize });
})(window);
