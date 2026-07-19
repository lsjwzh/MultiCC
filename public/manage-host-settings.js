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
  function tnlFmtStatus(p, prov) {
    // p = runtime provider state; prov = config provider {enabled,url}
    if (!prov.enabled) return '未启用';
    if (!prov.url) return '未配置 URL';
    if (p.healthy === null || !p.lastCheckAt) return '等待首次探活…';
    const when = new Date(p.lastCheckAt).toLocaleTimeString();
    let s = p.healthy ? `正常 (HTTP ${p.lastHttpCode})` : `异常 (HTTP ${p.lastHttpCode}，连续失败 ${p.consecutiveFails})`;
    s += ` · ${when}`;
    if (p.restartTimes && p.restartTimes.length) s += ` · 近1h重启 ${p.restartTimes.length} 次`;
    if (p.lastAction) s += ` · ${p.lastAction}`;
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
      document.getElementById('tnl-ph-url').value = c.phddns.url || '';
      document.getElementById('tnl-ph-status').textContent = tnlFmtStatus(pr.phddns || {}, c.phddns);
      // tailscale
      document.getElementById('tnl-ts-enabled').checked = !!c.tailscale.enabled;
      document.getElementById('tnl-ts-url').value = c.tailscale.url || '';
      document.getElementById('tnl-ts-status').textContent = tnlFmtStatus(pr.tailscale || {}, c.tailscale);
      document.getElementById('tnl-ts-funnel').checked = !!c.tailscale.funnel;
      document.getElementById('tnl-ts-funnelport').value = c.tailscale.funnelPort || 3000;
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
        url: document.getElementById('tnl-ph-url').value.trim(),
      },
      tailscale: {
        enabled: document.getElementById('tnl-ts-enabled').checked,
        url: document.getElementById('tnl-ts-url').value.trim(),
        funnel: document.getElementById('tnl-ts-funnel').checked,
      },
    };
    const fp = parseInt(document.getElementById('tnl-ts-funnelport').value, 10);
    if (Number.isFinite(fp) && fp > 0) body.tailscale.funnelPort = fp;
    const iv = numOr('tnl-interval'); if (iv) body.intervalSec = iv;
    const ft = numOr('tnl-failthreshold'); if (ft) body.failThreshold = ft;
    const cd = numOr('tnl-cooldown'); if (cd !== undefined) body.restartCooldownSec = cd;
    const mr = numOr('tnl-maxrestarts'); if (mr) body.maxRestartsPerHour = mr;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/settings/tunnel', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (msg) { msg.textContent = '已保存'; msg.className = 'status-text ok'; }
      showToast('外网穿透设置已保存');
      loadTunnelSettings();
    } catch (e) {
      if (msg) { msg.textContent = '错误: ' + e.message; msg.className = 'status-text err'; }
    }
  }

  async function restartTunnel(provider) {
    const msgId = provider === 'phddns' ? 'tnl-ph-msg' : 'tnl-ts-msg';
    const msg = document.getElementById(msgId);
    if (msg) { msg.textContent = '正在重启…'; msg.className = 'status-text'; }
    try {
      const headers = {};
      if (_urlToken) headers['X-Access-Token'] = _urlToken;
      const res = await fetch('/api/tunnel/restart/' + provider, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
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

  /* ── APK info ── */
  async function loadApkInfo() {
    const btn = document.getElementById('apk-btn');
    if (!btn) return;
    try {
      const resp = await fetch('/api/apk-info' + tokenQS('?'));
      const info = await resp.json();
      if (info.exists) {
        const d = new Date(info.mtime);
        const time = `${d.getMonth()+1}-${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const sizeMB = (info.size / 1048576).toFixed(1);
        btn.textContent = `APK (${time})`;
        btn.title = `Download Android App — ${sizeMB}MB — Updated ${time}`;
      }
    } catch {}
  }


  function initialize() {
    loadPushDiagnostics();
    loadNotifySettings();
    loadTunnelSettings();
    loadApkInfo();
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
  });
  global.MultiCCManageHostSettings = Object.freeze({ initialize });
})(window);
