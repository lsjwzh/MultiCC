(function initManageBridges(global) {
  'use strict';

  /* ── WeChat Bridge (iLink) ── */
  let _wxEvtSource = null;
  let _wxRunning = false;
  let _wxLoginPollTimer = null;
  let _wxReconnectTimer = null;
  let _wxSseGeneration = 0;

  function wechatSetLoginUI(loggedIn) {
    const btnQR = document.getElementById('wx-btn-qr');
    const btnLogout = document.getElementById('wx-btn-logout');
    const qrImg = document.getElementById('wx-qr-img');
    const statusEl = document.getElementById('wx-login-status');
    if (loggedIn) {
      btnQR.style.display = 'none';
      btnLogout.style.display = '';
      qrImg.style.display = 'none';
      statusEl.textContent = '已登录微信';
      statusEl.style.color = '#3fb950';
    } else {
      btnQR.style.display = '';
      btnLogout.style.display = 'none';
      statusEl.textContent = '';
    }
  }

  function wechatSetRunning(running) {
    _wxRunning = running;
    const btnStart = document.getElementById('wx-btn-start');
    const btnStop = document.getElementById('wx-btn-stop');
    const badge = document.getElementById('wx-running-badge');
    btnStart.disabled = running;
    btnStop.disabled = !running;
    badge.style.display = running ? '' : 'none';
  }

  async function wechatGetQR() {
    const statusEl = document.getElementById('wx-login-status');
    statusEl.textContent = '获取二维码中...';
    statusEl.style.color = '#d29922';
    try {
      const res = await fetch('/api/wechat/qrcode' + tokenQS('?'));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const qrImg = document.getElementById('wx-qr-img');
      const img = data.image || '';
      if (img) {
        if (/^https?:\/\//i.test(img)) {
          renderQrUrlToImg(qrImg, img);
        } else if (img.startsWith('data:')) {
          qrImg.src = img;
        } else {
          qrImg.src = `data:image/png;base64,${img}`;
        }
        qrImg.onerror = () => {
          if (data.qrcode) {
            qrImg.onerror = null;
            renderQrUrlToImg(qrImg, wechatLoginUrl(data.qrcode));
          }
        };
        qrImg.style.display = 'block';
      } else if (data.qrcode) {
        renderQrUrlToImg(qrImg, wechatLoginUrl(data.qrcode));
        qrImg.style.display = 'block';
      }
      statusEl.textContent = '请用微信扫描二维码';
      if (_wxLoginPollTimer) clearInterval(_wxLoginPollTimer);
      _wxLoginPollTimer = setInterval(wechatPollLogin, 2000);
    } catch (e) {
      statusEl.textContent = `获取失败: ${e.message}`;
      statusEl.style.color = '#f85149';
    }
  }

  function wechatLoginUrl(qrcodeToken) {
    return `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=${encodeURIComponent(qrcodeToken)}&bot_type=3`;
  }

  function renderQrUrlToImg(imgEl, url) {
    if (typeof qrcode !== 'function') {
      imgEl.src = url;
      return;
    }
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const cellSize = 5;
    const margin = 8;
    const count = qr.getModuleCount();
    const size = count * cellSize + margin * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(margin + c * cellSize, margin + r * cellSize, cellSize, cellSize);
        }
      }
    }
    imgEl.src = canvas.toDataURL('image/png');
  }

  async function wechatPollLogin() {
    try {
      const res = await fetch('/api/wechat/login-status' + tokenQS('?'));
      const data = await res.json();
      if (data.status === 'confirmed') {
        if (_wxLoginPollTimer) { clearInterval(_wxLoginPollTimer); _wxLoginPollTimer = null; }
        wechatSetLoginUI(true);
        showToast('微信登录成功');
      } else if (data.status === 'expired' || data.status === 'error') {
        if (_wxLoginPollTimer) { clearInterval(_wxLoginPollTimer); _wxLoginPollTimer = null; }
        const statusEl = document.getElementById('wx-login-status');
        statusEl.textContent = data.error || '二维码已过期';
        statusEl.style.color = '#f85149';
        document.getElementById('wx-qr-img').style.display = 'none';
      }
    } catch (_) {}
  }

  async function wechatLogout() {
    try {
      await fetch('/api/wechat/logout' + tokenQS('?'), { method: 'POST' });
      wechatSetLoginUI(false);
      wechatSetRunning(false);
      wechatDisconnectSSE();
      showToast('已退出微信登录');
    } catch (e) {
      showToast(`退出失败: ${e.message}`, true);
    }
  }

  async function wechatStart() {
    const body = {
      outputIdle: Number(document.getElementById('wx-idle').value) || 5000,
    };
    try {
      const res = await fetch('/api/wechat/start' + tokenQS('?'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      wechatSetRunning(true);
      wechatConnectSSE();
      showToast('微信桥接已启动');
    } catch (e) {
      showToast(`启动失败: ${e.message}`, true);
    }
  }

  async function wechatStop() {
    try {
      await fetch('/api/wechat/stop' + tokenQS('?'), { method: 'POST' });
      wechatSetRunning(false);
      wechatDisconnectSSE();
      showToast('微信桥接已停止');
    } catch (e) {
      showToast(`停止失败: ${e.message}`, true);
    }
  }

  async function wechatSaveConfig() {
    const body = {
      outputIdle: Number(document.getElementById('wx-idle').value) || 5000,
    };
    try {
      const res = await fetch('/api/wechat/config' + tokenQS('?'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast('微信配置已保存');
    } catch (e) {
      showToast(`保存失败: ${e.message}`, true);
    }
  }

  function wechatConnectSSE() {
    wechatDisconnectSSE();
    const generation = _wxSseGeneration;
    const source = new EventSource('/api/wechat/events' + tokenQS('?'));
    _wxEvtSource = source;
    source.onmessage = (e) => {
      try { wechatAppendLog(JSON.parse(e.data)); } catch (_) {}
    };
    source.onerror = () => {
      if (generation !== _wxSseGeneration || source !== _wxEvtSource) return;
      source.close();
      _wxEvtSource = null;
      if (!_wxRunning) return;
      if (_wxReconnectTimer) clearTimeout(_wxReconnectTimer);
      _wxReconnectTimer = setTimeout(() => {
        _wxReconnectTimer = null;
        if (!_wxRunning || generation !== _wxSseGeneration) return;
        wechatConnectSSE();
      }, 3000);
    };
  }

  function wechatDisconnectSSE() {
    _wxSseGeneration += 1;
    if (_wxReconnectTimer) { clearTimeout(_wxReconnectTimer); _wxReconnectTimer = null; }
    if (_wxEvtSource) { _wxEvtSource.close(); _wxEvtSource = null; }
  }

  const _wxPrefixes = { in: '← WeChat', out: '→ Claude', system: 'SYS', error: 'ERR' };
  const _wxColors = { in: '#58a6ff', out: '#3fb950', system: '#d29922', error: '#f85149' };

  function appendBridgeLogRow(log, entry, prefix, color) {
    if (!log) return;
    const ph = log.querySelector('div[style*="text-align:center"]');
    if (ph) ph.remove();
    const div = document.createElement('div');
    div.style.cssText = `border-left:2px solid ${color};padding:2px 6px;line-height:1.4;word-break:break-word;`;
    const d = new Date(entry.ts);
    const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
    const timeEl = document.createElement('span');
    timeEl.style.cssText = 'color:#484f58;font-size:10px;margin-right:4px;';
    timeEl.textContent = time;
    const prefixEl = document.createElement('span');
    prefixEl.style.cssText = `color:${color};font-weight:600;`;
    prefixEl.textContent = prefix;
    div.appendChild(timeEl);
    div.appendChild(prefixEl);
    div.appendChild(document.createTextNode(' ' + String(entry.text || '')));
    log.appendChild(div);
    while (log.children.length > 100) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function wechatAppendLog(entry) {
    const color = _wxColors[entry.type] || '#484f58';
    appendBridgeLogRow(document.getElementById('wx-log'), entry, _wxPrefixes[entry.type] || entry.type, color);
  }

  /* ── Gateway session ── */
  function _wxSelectedCli() {
    const checked = document.querySelector('input[name="wx-gw-cli"]:checked');
    return checked ? checked.value : 'claude';
  }

  function wechatRenderGateway(gw) {
    const stateEl = document.getElementById('wx-gw-state');
    const createBtn = document.getElementById('wx-gw-create');
    const openBtn = document.getElementById('wx-gw-open');
    const resetBtn = document.getElementById('wx-gw-reset');
    const destroyBtn = document.getElementById('wx-gw-destroy');
    if (!stateEl) return;

    if (gw) {
      stateEl.textContent = `${gw.cli}`;
      stateEl.style.background = '#23863640';
      stateEl.style.color = '#3fb950';
      createBtn.style.display = 'none';
      openBtn.style.display = '';
      resetBtn.style.display = '';
      destroyBtn.style.display = '';
      // Sync radio with current cli
      const radio = document.querySelector(`input[name="wx-gw-cli"][value="${gw.cli}"]`);
      if (radio) radio.checked = true;
    } else {
      stateEl.textContent = '未创建';
      stateEl.style.background = '#21262d';
      stateEl.style.color = '#8b949e';
      createBtn.style.display = '';
      openBtn.style.display = 'none';
      resetBtn.style.display = 'none';
      destroyBtn.style.display = 'none';
    }
  }

  async function wechatGatewayRefresh() {
    try {
      const res = await fetch('/api/wechat/gateway' + tokenQS('?'));
      const gw = await res.json();
      wechatRenderGateway(gw);
      return gw;
    } catch (_) { return null; }
  }

  async function wechatGatewayCreate() {
    const cli = _wxSelectedCli();
    try {
      const res = await fetch('/api/wechat/gateway' + tokenQS('?'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      wechatRenderGateway(data);
      showToast(`Gateway 已创建 (${cli})`);
    } catch (e) { showToast(`创建失败: ${e.message}`, true); }
  }

  async function wechatGatewaySwitchCli() {
    const cli = _wxSelectedCli();
    try {
      const res = await fetch('/api/wechat/gateway' + tokenQS('?'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      wechatRenderGateway(data);
      showToast(`已切换到 ${cli}`);
    } catch (e) {
      showToast(`切换失败: ${e.message}`, true);
      wechatGatewayRefresh();  // revert radio
    }
  }

  function wechatGatewayOpen() {
    const url = '/chat?session=__gateway__' + tokenQS('&');
    window.open(url, '_blank');
  }

  async function wechatGatewayReset() {
    if (!(await showConfirm('清空 Gateway 对话历史？', { danger: true, okText: '清空' }))) return;
    try {
      const res = await fetch('/api/wechat/gateway/reset' + tokenQS('?'), { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      showToast('已清空对话历史');
    } catch (e) { showToast(`重置失败: ${e.message}`, true); }
  }

  async function wechatGatewayDestroy() {
    if (!(await showConfirm('销毁 Gateway 会话？历史会保留在 chat_history。', { danger: true, okText: '销毁' }))) return;
    try {
      const res = await fetch('/api/wechat/gateway' + tokenQS('?'), { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      wechatRenderGateway(null);
      showToast('Gateway 已销毁');
    } catch (e) { showToast(`销毁失败: ${e.message}`, true); }
  }

  async function wechatLoadConfig() {
    try {
      const res = await fetch('/api/wechat/config' + tokenQS('?'));
      const cfg = await res.json();
      document.getElementById('wx-idle').value = cfg.outputIdle || 5000;
      wechatSetLoginUI(!!cfg.loggedIn);
    } catch (_) {}
  }

  async function wechatCheckStatus() {
    try {
      const res = await fetch('/api/wechat/status' + tokenQS('?'));
      const data = await res.json();
      wechatSetLoginUI(data.loggedIn);
      wechatRenderGateway(data.gateway);
      if (data.running) {
        wechatSetRunning(true);
        wechatConnectSSE();
        try {
          const logRes = await fetch('/api/wechat/log' + tokenQS('?'));
          const entries = await logRes.json();
          for (const e of entries.slice(-50)) wechatAppendLog(e);
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Hook up radio change → switch cli (only when gateway already exists)
  document.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'wx-gw-cli') {
      const stateEl = document.getElementById('wx-gw-state');
      if (stateEl && stateEl.textContent !== '未创建') wechatGatewaySwitchCli();
    }
  });

  /* ───────────────────────── Feishu Bridge ───────────────────────── */
  let _fsEvtSource = null;
  let _fsRunning = false;
  let _fsReconnectTimer = null;
  let _fsSseGeneration = 0;

  function feishuSetConfigured(configured) {
    const el = document.getElementById('fs-cfg-state');
    if (!el) return;
    el.textContent = configured ? '已配置' : '未配置';
    el.style.background = configured ? '#23863640' : '#21262d';
    el.style.color = configured ? '#3fb950' : '#8b949e';
  }

  function feishuSetRunning(running) {
    _fsRunning = running;
    const btnStart = document.getElementById('fs-btn-start');
    const btnStop = document.getElementById('fs-btn-stop');
    const badge = document.getElementById('fs-running-badge');
    const wsBadge = document.getElementById('fs-ws-badge');
    if (btnStart) btnStart.disabled = running;
    if (btnStop) btnStop.disabled = !running;
    if (badge) badge.style.display = running ? '' : 'none';
    if (wsBadge) wsBadge.style.display = running ? '' : 'none';
  }

  async function feishuSaveConfig() {
    const body = {
      appId: document.getElementById('fs-appid').value.trim(),
      domain: document.getElementById('fs-domain').value,
    };
    const secret = document.getElementById('fs-appsecret').value;
    if (secret) body.appSecret = secret;       // empty = keep existing
    const statusEl = document.getElementById('fs-cfg-status');
    try {
      const res = await fetch('/api/feishu/config' + tokenQS('?'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      document.getElementById('fs-appsecret').value = '';
      if (statusEl) statusEl.textContent = '已保存';
      showToast('飞书凭证已保存');
      feishuLoadConfig();
    } catch (e) {
      if (statusEl) statusEl.textContent = `保存失败: ${e.message}`;
      showToast(`保存失败: ${e.message}`, true);
    }
  }

  async function feishuStart() {
    try {
      const res = await fetch('/api/feishu/start' + tokenQS('?'), { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      feishuSetRunning(true);
      feishuConnectSSE();
      showToast('飞书桥接已启动');
    } catch (e) {
      showToast(`启动失败: ${e.message}`, true);
    }
  }

  async function feishuStop() {
    try {
      await fetch('/api/feishu/stop' + tokenQS('?'), { method: 'POST' });
      feishuSetRunning(false);
      feishuDisconnectSSE();
      showToast('飞书桥接已停止');
    } catch (e) {
      showToast(`停止失败: ${e.message}`, true);
    }
  }

  function feishuConnectSSE() {
    feishuDisconnectSSE();
    const generation = _fsSseGeneration;
    const source = new EventSource('/api/feishu/events' + tokenQS('?'));
    _fsEvtSource = source;
    source.onmessage = (e) => { try { feishuAppendLog(JSON.parse(e.data)); } catch (_) {} };
    source.onerror = () => {
      if (generation !== _fsSseGeneration || source !== _fsEvtSource) return;
      source.close();
      _fsEvtSource = null;
      if (!_fsRunning) return;
      if (_fsReconnectTimer) clearTimeout(_fsReconnectTimer);
      _fsReconnectTimer = setTimeout(() => {
        _fsReconnectTimer = null;
        if (!_fsRunning || generation !== _fsSseGeneration) return;
        feishuConnectSSE();
      }, 3000);
    };
  }

  function feishuDisconnectSSE() {
    _fsSseGeneration += 1;
    if (_fsReconnectTimer) { clearTimeout(_fsReconnectTimer); _fsReconnectTimer = null; }
    if (_fsEvtSource) { _fsEvtSource.close(); _fsEvtSource = null; }
  }

  const _fsPrefixes = { in: '← 飞书', out: '→ Claude', system: 'SYS', error: 'ERR' };
  const _fsColors = { in: '#58a6ff', out: '#3fb950', system: '#d29922', error: '#f85149' };

  function feishuAppendLog(entry) {
    const color = _fsColors[entry.type] || '#484f58';
    appendBridgeLogRow(document.getElementById('fs-log'), entry, _fsPrefixes[entry.type] || entry.type, color);
  }

  /* ── Feishu Gateway session ── */
  function _fsSelectedCli() {
    const checked = document.querySelector('input[name="fs-gw-cli"]:checked');
    return checked ? checked.value : 'claude';
  }

  function feishuRenderGateway(gw) {
    const stateEl = document.getElementById('fs-gw-state');
    const createBtn = document.getElementById('fs-gw-create');
    const openBtn = document.getElementById('fs-gw-open');
    const resetBtn = document.getElementById('fs-gw-reset');
    const destroyBtn = document.getElementById('fs-gw-destroy');
    if (!stateEl) return;
    if (gw) {
      stateEl.textContent = `${gw.cli}`;
      stateEl.style.background = '#23863640';
      stateEl.style.color = '#3fb950';
      createBtn.style.display = 'none';
      openBtn.style.display = '';
      resetBtn.style.display = '';
      destroyBtn.style.display = '';
      const radio = document.querySelector(`input[name="fs-gw-cli"][value="${gw.cli}"]`);
      if (radio) radio.checked = true;
    } else {
      stateEl.textContent = '未创建';
      stateEl.style.background = '#21262d';
      stateEl.style.color = '#8b949e';
      createBtn.style.display = '';
      openBtn.style.display = 'none';
      resetBtn.style.display = 'none';
      destroyBtn.style.display = 'none';
    }
  }

  async function feishuGatewayRefresh() {
    try {
      const res = await fetch('/api/feishu/gateway' + tokenQS('?'));
      const gw = await res.json();
      feishuRenderGateway(gw);
      return gw;
    } catch (_) { return null; }
  }

  async function feishuGatewayCreate() {
    const cli = _fsSelectedCli();
    try {
      const res = await fetch('/api/feishu/gateway' + tokenQS('?'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      feishuRenderGateway(data);
      showToast(`飞书 Gateway 已创建 (${cli})`);
    } catch (e) { showToast(`创建失败: ${e.message}`, true); }
  }

  async function feishuGatewaySwitchCli() {
    const cli = _fsSelectedCli();
    try {
      const res = await fetch('/api/feishu/gateway' + tokenQS('?'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      feishuRenderGateway(data);
      showToast(`已切换到 ${cli}`);
    } catch (e) {
      showToast(`切换失败: ${e.message}`, true);
      feishuGatewayRefresh();
    }
  }

  function feishuGatewayOpen() {
    const url = '/chat?session=__feishu_gateway__' + tokenQS('&');
    window.open(url, '_blank');
  }

  async function feishuGatewayReset() {
    if (!(await showConfirm('清空飞书 Gateway 对话历史？', { danger: true, okText: '清空' }))) return;
    try {
      const res = await fetch('/api/feishu/gateway/reset' + tokenQS('?'), { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      showToast('已清空对话历史');
    } catch (e) { showToast(`重置失败: ${e.message}`, true); }
  }

  async function feishuGatewayDestroy() {
    if (!(await showConfirm('销毁飞书 Gateway 会话？历史会保留在 chat_history。', { danger: true, okText: '销毁' }))) return;
    try {
      const res = await fetch('/api/feishu/gateway' + tokenQS('?'), { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      feishuRenderGateway(null);
      showToast('飞书 Gateway 已销毁');
    } catch (e) { showToast(`销毁失败: ${e.message}`, true); }
  }

  async function feishuLoadConfig() {
    try {
      const res = await fetch('/api/feishu/config' + tokenQS('?'));
      const cfg = await res.json();
      if (document.getElementById('fs-appid')) document.getElementById('fs-appid').value = cfg.appId || '';
      if (document.getElementById('fs-domain')) document.getElementById('fs-domain').value = cfg.domain || 'feishu';
      feishuSetConfigured(!!cfg.configured);
    } catch (_) {}
  }

  async function feishuCheckStatus() {
    try {
      const res = await fetch('/api/feishu/status' + tokenQS('?'));
      const data = await res.json();
      feishuSetConfigured(!!data.configured);
      feishuRenderGateway(data.gateway);
      if (data.running) {
        feishuSetRunning(true);
        feishuConnectSSE();
        try {
          const logRes = await fetch('/api/feishu/log' + tokenQS('?'));
          const entries = await logRes.json();
          for (const e of entries.slice(-50)) feishuAppendLog(e);
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Hook up radio change → switch cli (only when feishu gateway already exists)
  document.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'fs-gw-cli') {
      const stateEl = document.getElementById('fs-gw-state');
      if (stateEl && stateEl.textContent !== '未创建') feishuGatewaySwitchCli();
    }
  });

  /* ── Generic token-based bridges: Telegram / Discord / Slack ──
     All three share Feishu's exact REST surface + gateway model; only the config
     fields differ. One data-driven controller drives all of them (id prefix per
     platform), instead of copy-pasting the Feishu functions three times. */
  const TOKEN_BRIDGES = {
    telegram: { api: '/api/telegram', idp: 'tg', name: 'Telegram', session: '__telegram_gateway__', fields: ['botToken'], logIn: '← Telegram' },
    discord:  { api: '/api/discord',  idp: 'dc', name: 'Discord',  session: '__discord_gateway__',  fields: ['botToken'], logIn: '← Discord' },
    slack:    { api: '/api/slack',    idp: 'sk', name: 'Slack',    session: '__slack_gateway__',    fields: ['botToken', 'appToken'], logIn: '← Slack' },
  };
  const _bridgeEvt = {};       // platform → EventSource
  const _bridgeRunning = {};   // platform → bool
  const _bridgeReconnectTimer = {}; // platform → owned reconnect timer
  const _bridgeSseGeneration = {};  // platform → monotonic connection generation
  function _bid(p, suffix) { return document.getElementById(TOKEN_BRIDGES[p].idp + '-' + suffix); }

  function bridgeSetConfigured(p, configured) {
    const el = _bid(p, 'cfg-state');
    if (!el) return;
    el.textContent = configured ? '已配置' : '未配置';
    el.style.background = configured ? '#23863640' : '';
    el.style.color = configured ? '#3fb950' : '';
  }
  function bridgeSetRunning(p, running) {
    _bridgeRunning[p] = running;
    const s = _bid(p, 'btn-start'), e = _bid(p, 'btn-stop'), b = _bid(p, 'running-badge'), w = _bid(p, 'ws-badge');
    if (s) s.disabled = running;
    if (e) e.disabled = !running;
    if (b) b.style.display = running ? '' : 'none';
    if (w) w.style.display = running ? '' : 'none';
  }
  async function bridgeSaveConfig(p) {
    const def = TOKEN_BRIDGES[p];
    const body = {};
    for (const f of def.fields) { const v = (_bid(p, f)?.value || '').trim(); if (v) body[f] = v; } // empty = keep existing
    const statusEl = _bid(p, 'cfg-status');
    try {
      const res = await fetch(def.api + '/config' + tokenQS('?'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const f of def.fields) { const el = _bid(p, f); if (el) el.value = ''; }
      if (statusEl) statusEl.textContent = '已保存';
      showToast(`${def.name} 凭证已保存`);
      bridgeLoadConfig(p);
    } catch (err) {
      if (statusEl) statusEl.textContent = `保存失败: ${err.message}`;
      showToast(`保存失败: ${err.message}`, true);
    }
  }
  async function bridgeStart(p) {
    const def = TOKEN_BRIDGES[p];
    try {
      const res = await fetch(def.api + '/start' + tokenQS('?'), { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      bridgeSetRunning(p, true);
      bridgeConnectSSE(p);
      showToast(`${def.name} 桥接已启动`);
    } catch (err) { showToast(`启动失败: ${err.message}`, true); }
  }
  async function bridgeStop(p) {
    const def = TOKEN_BRIDGES[p];
    try {
      await fetch(def.api + '/stop' + tokenQS('?'), { method: 'POST' });
      bridgeSetRunning(p, false);
      bridgeDisconnectSSE(p);
      showToast(`${def.name} 桥接已停止`);
    } catch (err) { showToast(`停止失败: ${err.message}`, true); }
  }
  function bridgeConnectSSE(p) {
    const def = TOKEN_BRIDGES[p];
    bridgeDisconnectSSE(p);
    const generation = _bridgeSseGeneration[p];
    const es = new EventSource(def.api + '/events' + tokenQS('?'));
    es.onmessage = (e) => { try { bridgeAppendLog(p, JSON.parse(e.data)); } catch (_) {} };
    es.onerror = () => {
      if (generation !== _bridgeSseGeneration[p] || es !== _bridgeEvt[p]) return;
      es.close();
      _bridgeEvt[p] = null;
      if (!_bridgeRunning[p]) return;
      if (_bridgeReconnectTimer[p]) clearTimeout(_bridgeReconnectTimer[p]);
      _bridgeReconnectTimer[p] = setTimeout(() => {
        _bridgeReconnectTimer[p] = null;
        if (!_bridgeRunning[p] || generation !== _bridgeSseGeneration[p]) return;
        bridgeConnectSSE(p);
      }, 3000);
    };
    _bridgeEvt[p] = es;
  }
  function bridgeDisconnectSSE(p) {
    _bridgeSseGeneration[p] = (_bridgeSseGeneration[p] || 0) + 1;
    if (_bridgeReconnectTimer[p]) {
      clearTimeout(_bridgeReconnectTimer[p]);
      _bridgeReconnectTimer[p] = null;
    }
    if (_bridgeEvt[p]) { _bridgeEvt[p].close(); _bridgeEvt[p] = null; }
  }

  const _bridgeLogColors = { in: '#58a6ff', out: '#3fb950', system: '#d29922', error: '#f85149' };
  function bridgeAppendLog(p, entry) {
    const def = TOKEN_BRIDGES[p];
    const prefixMap = { in: def.logIn, out: '→ Agent', system: 'SYS', error: 'ERR' };
    const color = _bridgeLogColors[entry.type] || '#8b949e';
    appendBridgeLogRow(_bid(p, 'log'), entry, prefixMap[entry.type] || entry.type, color);
  }
  function _bridgeSelectedCli(p) {
    const checked = document.querySelector(`input[name="${TOKEN_BRIDGES[p].idp}-gw-cli"]:checked`);
    return checked ? checked.value : 'claude';
  }
  function bridgeRenderGateway(p, gw) {
    const stateEl = _bid(p, 'gw-state'), createBtn = _bid(p, 'gw-create'), openBtn = _bid(p, 'gw-open'),
          resetBtn = _bid(p, 'gw-reset'), destroyBtn = _bid(p, 'gw-destroy');
    if (!stateEl) return;
    if (gw) {
      stateEl.textContent = gw.cli;
      stateEl.style.background = '#23863640'; stateEl.style.color = '#3fb950';
      createBtn.style.display = 'none'; openBtn.style.display = ''; resetBtn.style.display = ''; destroyBtn.style.display = '';
      const radio = document.querySelector(`input[name="${TOKEN_BRIDGES[p].idp}-gw-cli"][value="${gw.cli}"]`);
      if (radio) radio.checked = true;
    } else {
      stateEl.textContent = '未创建';
      stateEl.style.background = ''; stateEl.style.color = '';
      createBtn.style.display = ''; openBtn.style.display = 'none'; resetBtn.style.display = 'none'; destroyBtn.style.display = 'none';
    }
  }
  async function bridgeGatewayRefresh(p) {
    try { const res = await fetch(TOKEN_BRIDGES[p].api + '/gateway' + tokenQS('?')); const gw = await res.json(); bridgeRenderGateway(p, gw); return gw; }
    catch (_) { return null; }
  }
  async function bridgeGatewayCreate(p) {
    const def = TOKEN_BRIDGES[p], cli = _bridgeSelectedCli(p);
    try {
      const res = await fetch(def.api + '/gateway' + tokenQS('?'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cli }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      bridgeRenderGateway(p, data);
      showToast(`${def.name} Gateway 已创建 (${cli})`);
    } catch (err) { showToast(`创建失败: ${err.message}`, true); }
  }
  async function bridgeGatewaySwitchCli(p) {
    const def = TOKEN_BRIDGES[p], cli = _bridgeSelectedCli(p);
    try {
      const res = await fetch(def.api + '/gateway' + tokenQS('?'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cli }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      bridgeRenderGateway(p, data);
      showToast(`已切换到 ${cli}`);
    } catch (err) { showToast(`切换失败: ${err.message}`, true); bridgeGatewayRefresh(p); }
  }
  function bridgeGatewayOpen(p) {
    window.open('/chat?session=' + encodeURIComponent(TOKEN_BRIDGES[p].session) + tokenQS('&'), '_blank');
  }
  async function bridgeGatewayReset(p) {
    const def = TOKEN_BRIDGES[p];
    if (!(await showConfirm(`清空 ${def.name} Gateway 对话历史？`, { danger: true, okText: '清空' }))) return;
    try {
      const res = await fetch(def.api + '/gateway/reset' + tokenQS('?'), { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      showToast('已清空对话历史');
    } catch (err) { showToast(`重置失败: ${err.message}`, true); }
  }
  async function bridgeGatewayDestroy(p) {
    const def = TOKEN_BRIDGES[p];
    if (!(await showConfirm(`销毁 ${def.name} Gateway 会话？历史会保留在 chat_history。`, { danger: true, okText: '销毁' }))) return;
    try {
      const res = await fetch(def.api + '/gateway' + tokenQS('?'), { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      bridgeRenderGateway(p, null);
      showToast(`${def.name} Gateway 已销毁`);
    } catch (err) { showToast(`销毁失败: ${err.message}`, true); }
  }
  async function bridgeLoadConfig(p) {
    try { const res = await fetch(TOKEN_BRIDGES[p].api + '/config' + tokenQS('?')); const cfg = await res.json(); bridgeSetConfigured(p, !!cfg.configured); } catch (_) {}
  }
  async function bridgeCheckStatus(p) {
    const def = TOKEN_BRIDGES[p];
    try {
      const res = await fetch(def.api + '/status' + tokenQS('?'));
      const data = await res.json();
      bridgeSetConfigured(p, !!data.configured);
      bridgeRenderGateway(p, data.gateway);
      if (data.running) {
        bridgeSetRunning(p, true);
        bridgeConnectSSE(p);
        try { const logRes = await fetch(def.api + '/log' + tokenQS('?')); const entries = await logRes.json(); for (const e of entries.slice(-50)) bridgeAppendLog(p, e); } catch (_) {}
      }
    } catch (_) {}
  }
  // radio change → switch cli when that platform's gateway already exists
  document.addEventListener('change', (e) => {
    if (!e.target || !e.target.name) return;
    for (const p of Object.keys(TOKEN_BRIDGES)) {
      if (e.target.name === TOKEN_BRIDGES[p].idp + '-gw-cli') {
        const stateEl = _bid(p, 'gw-state');
        if (stateEl && stateEl.textContent !== '未创建') bridgeGatewaySwitchCli(p);
      }
    }
  });


  function initialize() {
    wechatLoadConfig();
    wechatCheckStatus();
    feishuLoadConfig();
    feishuCheckStatus();
    for (const platform of Object.keys(TOKEN_BRIDGES)) {
      bridgeLoadConfig(platform);
      bridgeCheckStatus(platform);
    }
  }

  function disconnect() {
    wechatDisconnectSSE();
    feishuDisconnectSSE();
    for (const platform of Object.keys(TOKEN_BRIDGES)) bridgeDisconnectSSE(platform);
  }

  Object.assign(global, {
    wechatGetQR,
    wechatLogout,
    wechatStart,
    wechatStop,
    wechatSaveConfig,
    wechatGatewayCreate,
    wechatGatewayOpen,
    wechatGatewayReset,
    wechatGatewayDestroy,
    feishuSaveConfig,
    feishuStart,
    feishuStop,
    feishuGatewayCreate,
    feishuGatewayOpen,
    feishuGatewayReset,
    feishuGatewayDestroy,
    bridgeSaveConfig,
    bridgeStart,
    bridgeStop,
    bridgeGatewayCreate,
    bridgeGatewayOpen,
    bridgeGatewayReset,
    bridgeGatewayDestroy,
  });
  global.MultiCCManageBridges = Object.freeze({ initialize, disconnect });
})(window);
