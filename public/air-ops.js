'use strict';

/**
 * The Air sidebar's bottom region: everything the old manage sidebar pinned
 * under its nav list, rebuilt for this shell.
 *
 * Ported from public/manage.html's `.nav-bottom` + manage-update.js +
 * manage-host-settings.js, which the Air console otherwise never loaded — so
 * the version row, the one-click update, the service restart and the QR/APK
 * entry points were simply absent here. The payloads are the same routes the
 * manage page drives; only the presentation is Air's.
 *
 * Self-initialising rather than driven from air.js (which is an IIFE and
 * exposes no context to modules): it needs no page data, only the DOM it owns.
 */
(function initAirOps(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);

  const POLL_MS = 2500;
  const MAX_WAIT_MS = 20 * 60 * 1000;

  // ── Requests ───────────────────────────────────────────────────────────
  // auth-client.js already wraps window.fetch, so same-origin calls carry the
  // access token without this module reading it.
  async function raw(path, body, method) {
    const options = { headers: { 'Content-Type': 'application/json' }, cache: 'no-store' };
    if (body !== undefined) {
      options.method = method || 'POST';
      options.body = JSON.stringify(body);
    } else if (method) {
      options.method = method;
    }
    const response = await fetch(path, options);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }
    return { ok: response.ok, status: response.status, data: payload };
  }

  async function get(path) {
    const result = await raw(path);
    if (!result.ok) {
      const message = (result.data && (result.data.error || result.data.message)) || `HTTP ${result.status}`;
      throw new Error(message);
    }
    return result.data;
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // ── Sidebar status line ────────────────────────────────────────────────
  let _statusTimer = null;
  function status(text = '', tone = '') {
    const line = el('air-ops-status');
    if (!line) return;
    clearTimeout(_statusTimer);
    line.textContent = text;
    line.className = `ops-status ${tone}`;
    if (text) _statusTimer = setTimeout(() => { line.textContent = ''; line.className = 'ops-status'; }, 8000);
  }

  // ── Ops dialog ─────────────────────────────────────────────────────────
  // One shared dialog for the update flow, the QR code and the APK panel, in
  // the shape the other Air dialogs use (see air.html's #service-dialog).
  function dialogApi() {
    const dialog = el('ops-dialog');
    let onEscape = null;
    const keyHandler = event => {
      if (event.key === 'Escape' && onEscape) { event.preventDefault(); onEscape(); }
    };
    const api = {
      setTitle(text) { el('ops-title').textContent = text; },
      setBody(text) {
        const body = el('ops-body');
        body.textContent = text || '';
        body.hidden = !text;
      },
      setExtra(node) {
        const host = el('ops-extra');
        host.replaceChildren(...(node ? [node] : []));
        host.hidden = !node;
      },
      setLog(text) {
        const log = el('ops-log');
        log.textContent = text || '';
        log.hidden = !text;
        log.scrollTop = log.scrollHeight;
      },
      setButtons(specs, escapeAction) {
        const row = el('ops-actions');
        row.replaceChildren(...specs.map(spec => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = spec.label;
          if (spec.kind) button.className = spec.kind;
          button.onclick = spec.onClick;
          return button;
        }));
        onEscape = escapeAction || null;
      },
      open() {
        document.removeEventListener('keydown', keyHandler, true);
        document.addEventListener('keydown', keyHandler, true);
        const closeButton = el('ops-close');
        if (closeButton) closeButton.onclick = () => api.close();
        if (!dialog.open) dialog.showModal();
      },
      close() {
        document.removeEventListener('keydown', keyHandler, true);
        onEscape = null;
        activeDialog = null;
        if (dialog.open) dialog.close();
      },
      isOpen() { return dialog.open; },
    };
    return api;
  }

  let activeDialog = null;
  function openDialog() {
    if (activeDialog && activeDialog.isOpen()) return activeDialog;
    activeDialog = dialogApi();
    activeDialog.open();
    return activeDialog;
  }

  // ── Version row ────────────────────────────────────────────────────────
  // Mirrors manage.js checkVersion(): the row is the status read-out, and the
  // click on it is the update entry point.
  function paintVersion(info) {
    const current = el('air-ver-current');
    const hint = el('air-ver-hint');
    const badge = el('air-ver-badge');
    const icon = el('air-ver-icon');
    if (!current) return;

    if (!info) {
      icon.textContent = '⏳';
      hint.textContent = '检查失败';
      badge.hidden = true;
      return;
    }
    current.textContent = `v${info.current || '—'}`;
    if (info.updateAvailable) {
      icon.textContent = '🆕';
      hint.textContent = '有新版';
      badge.textContent = `v${info.latestVersion || ''}`;
      badge.hidden = false;
    } else {
      icon.textContent = '📦';
      hint.textContent = info.apiError ? '已是最新（离线）' : '已是最新';
      badge.hidden = true;
    }
  }

  async function checkVersion() {
    const hint = el('air-ver-hint');
    if (hint) hint.textContent = '检查中…';
    try {
      const info = await get('/api/version-check');
      paintVersion(info);
      return info;
    } catch (_) {
      paintVersion(null);
      return null;
    }
  }

  // ── Update flow ────────────────────────────────────────────────────────
  function forceCheckbox() {
    const label = document.createElement('label');
    label.className = 'ops-force';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = '强制更新：工作区有改动或历史分叉时也更新。本地改动会先备份到 git stash（不会自动恢复），代码将重置到远端最新。';
    label.append(input, text);
    return { label, input };
  }

  // A network failure here is expected — the update restarts the server
  // underneath us — so it is a distinct state, never reported as a failure.
  async function fetchUpdateStatus() {
    try {
      const result = await raw('/api/update/status');
      if (!result.ok || !result.data) return { unreachable: true };
      return result.data;
    } catch (_) {
      return { unreachable: true };
    }
  }

  async function serverIsBack() {
    try {
      return (await raw('/api/server-info')).ok;
    } catch (_) {
      return false;
    }
  }

  async function pollUntilDone({ force }) {
    if (pollingUpdate) return;
    pollingUpdate = true;
    const startedAt = Date.now();
    let sawUnreachable = false;
    try {
      for (;;) {
        const state = await fetchUpdateStatus();
        const dialog = activeDialog && activeDialog.isOpen() ? activeDialog : null;
        if (state.unreachable) {
          sawUnreachable = true;
          setVersionHint('服务重启中…', true);
          if (dialog) dialog.setBody('服务正在重启，连接已暂时断开。这一步通常需要几秒钟。');
        } else if (state.state === 'succeeded') {
          setVersionHint('更新完成，正在重载…', true);
          if (dialog) {
            dialog.setTitle('更新完成');
            dialog.setBody('更新已完成，服务已重启。正在重新加载页面…');
            dialog.setLog(state.tail || '');
            dialog.setButtons([]);
          }
          // Reaching this branch already proves the new server answers (the
          // manager writes its exit marker only after wait_for_ready); the
          // extra probe covers a proxy still holding the old connection.
          for (let i = 0; i < 20 && !(await serverIsBack()); i += 1) await sleep(500);
          location.reload();
          return;
        } else if (state.state === 'failed' || state.state === 'stale') {
          const failed = state.state === 'failed';
          setVersionHint(failed ? '更新失败' : '更新无响应');
          if (dialog) {
            dialog.setTitle(failed ? '更新失败' : '更新失去响应');
            dialog.setBody(failed
              ? `更新未完成（退出码 ${state.exitCode}）。服务没有被更新，下面是完整输出：`
              : '更新进程超过 15 分钟没有任何输出，可能已被系统结束。下面是它最后的输出：');
            dialog.setLog(state.tail || '(无输出)');
            const buttons = [];
            // The run's own record of whether it was forced beats this
            // closure's copy: the dialog may be re-attached from another tab.
            const wasForced = state.force != null ? !!state.force : !!force;
            if (!wasForced && failed) {
              buttons.push({
                label: '强制更新重试',
                kind: 'danger',
                onClick: () => { dialog.close(); startUpdate(true); },
              });
            }
            buttons.push({ label: '关闭', onClick: () => dialog.close() });
            dialog.setButtons(buttons, () => dialog.close());
          }
          return;
        } else if (state.state === 'running') {
          const lastLine = String(state.tail || '').trim().split('\n').pop() || '正在更新…';
          setVersionHint(lastLine.slice(0, 40), true);
          if (dialog) {
            dialog.setBody(sawUnreachable ? '服务已回来，正在收尾…' : '正在更新，请勿关闭本机。完成后服务会自动重启。');
            dialog.setLog(state.tail || '');
          }
        } else if (dialog) {
          // 'idle' / 'scheduled': no log yet (the child writes its first line
          // after ~1s). Keep waiting; the timeout below is the backstop.
          dialog.setBody('正在启动更新…');
        }

        if (Date.now() - startedAt > MAX_WAIT_MS) {
          setVersionHint('更新超时');
          if (dialog) {
            dialog.setTitle('更新超时');
            dialog.setBody('等待超过 20 分钟仍未结束。请到服务器上查看 logs/update.log。');
            dialog.setButtons([{ label: '关闭', onClick: () => dialog.close() }], () => dialog.close());
          }
          return;
        }
        await sleep(POLL_MS);
      }
    } finally {
      pollingUpdate = false;
    }
  }

  let pollingUpdate = false;

  async function startUpdate(force) {
    const dialog = openDialog();
    dialog.setTitle('正在更新');
    dialog.setBody('正在启动更新…');
    dialog.setExtra(null);
    dialog.setLog('');
    dialog.setButtons([{ label: '后台运行', onClick: () => dialog.close() }], () => dialog.close());

    let result;
    try {
      result = await raw('/api/update', { force: !!force });
    } catch (error) {
      dialog.setTitle('无法启动更新');
      dialog.setBody(`请求失败：${error.message}`);
      dialog.setButtons([{ label: '关闭', onClick: () => dialog.close() }], () => dialog.close());
      return;
    }

    if (result.status === 409) {
      // Someone (or a previous tab) already started one — attach to it rather
      // than reporting an error the user can do nothing about.
      dialog.setBody('已有一个更新正在进行，正在接管其进度…');
      await pollUntilDone({ force: !!(result.data && result.data.status && result.data.status.force) });
      return;
    }
    if (!result.ok) {
      const data = result.data || {};
      dialog.setTitle('无法启动更新');
      dialog.setBody((data.error || `HTTP ${result.status}`) + (data.code ? `\n(${data.code})` : ''));
      dialog.setButtons([{ label: '关闭', onClick: () => dialog.close() }], () => dialog.close());
      return;
    }

    if (result.data && result.data.activeStreaming > 0) {
      status(`⚠️ 有 ${result.data.activeStreaming} 个会话正在输出，更新后的重启会中断它们（在途内容已保存）`, 'warn');
    }
    setVersionHint('正在更新…', true);
    await pollUntilDone({ force: !!force });
  }

  async function confirmThenUpdate(info) {
    const dialog = openDialog();
    const updateAvailable = !!(info && info.updateAvailable);
    const currentText = `v${(info && info.current) || '—'}`;
    const latestText = info && info.latest ? info.latest : null;

    dialog.setTitle(updateAvailable ? '发现新版本' : '更新 MultiCC');
    dialog.setBody([
      `当前版本：${currentText}（通道：${(info && info.channel) || 'dev'}）`,
      updateAvailable
        ? `最新版本：${latestText}`
        : (info && info.apiError ? '最新版本：无法连接检查服务（离线）' : `最新版本：${latestText || '未知'} — 当前已是最新`),
      '',
      '更新会拉取最新代码、必要时重装依赖，并在完成后自动重启服务。',
      '重启会短暂断开所有会话；正在输出的会话会被中断，其在途内容会先保存。',
    ].join('\n'));

    const { label, input } = forceCheckbox();
    dialog.setExtra(label);
    dialog.setLog('');
    dialog.setButtons([
      { label: '取消', onClick: () => dialog.close() },
      {
        label: updateAvailable ? '立即更新' : '仍要更新',
        kind: 'primary',
        onClick: () => { const force = input.checked; dialog.close(); startUpdate(force); },
      },
    ], () => dialog.close());
  }

  let updateFlowOpen = false;
  async function openUpdateFlow() {
    if (updateFlowOpen) return;
    updateFlowOpen = true;
    try {
      // An update already in flight (possibly started in another tab, or
      // before a reload) takes precedence over anything this click would do.
      const running = await fetchUpdateStatus();
      if (running && running.running) {
        const dialog = openDialog();
        dialog.setTitle('正在更新');
        dialog.setBody('已有一个更新正在进行，正在接管其进度…');
        dialog.setLog(running.tail || '');
        dialog.setButtons([{ label: '后台运行', onClick: () => dialog.close() }], () => dialog.close());
        // Not awaited: the poll can run for many minutes, and holding the
        // guard that long would leave the version row unclickable — exactly
        // when the user who backgrounded the dialog wants it back.
        pollUntilDone({ force: !!running.force });
        return;
      }
      const info = await checkVersion();
      if (!info) {
        status('检查更新失败，请稍后再试', 'err');
        return;
      }
      await confirmThenUpdate(info);
    } finally {
      updateFlowOpen = false;
    }
  }

  function setVersionHint(text, busy = false) {
    const hint = el('air-ver-hint');
    if (!hint) return;
    hint.textContent = text;
    hint.classList.toggle('busy', busy);
  }

  // ── Service uptime ─────────────────────────────────────────────────────
  // {uptimeMs, at} — the server's uptime and the local instant we learned it.
  // Everything on screen derives from this pair rather than the server's wall
  // clock, so a host whose clock is off cannot render a future start time.
  let bootReading = null;

  const pad = value => String(value).padStart(2, '0');
  function fmtClock(date) {
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

  function paintBootTime() {
    const time = el('air-boot-time');
    const uptime = el('air-boot-uptime');
    if (!time || !bootReading) return;
    const uptimeMs = bootReading.uptimeMs + (Date.now() - bootReading.at);
    const started = new Date(Date.now() - uptimeMs);
    time.textContent = fmtClock(started);
    time.title = started.toLocaleString();
    if (uptime) uptime.textContent = `已运行 ${fmtUptime(uptimeMs)}`;
  }

  async function loadBootTime() {
    if (!el('air-boot-time')) return;
    try {
      const info = await get('/api/server-info');
      if (!Number.isFinite(info && info.uptimeMs)) return; // leave the placeholder
      bootReading = { uptimeMs: info.uptimeMs, at: Date.now() };
      paintBootTime();
    } catch (_) {
      // An unreachable server has bigger tells than a dash in the sidebar.
    }
  }

  // ── APK / iOS OTA ──────────────────────────────────────────────────────
  function fmtSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fmtMtime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function downloadRow(title, detail, href) {
    const row = document.createElement('div');
    row.className = 'ops-download';
    const copy = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const note = document.createElement('small');
    note.textContent = detail;
    copy.append(heading, note);
    const link = document.createElement('a');
    link.href = href;
    link.textContent = '下载';
    link.className = 'primary';
    row.append(copy, link);
    return row;
  }

  async function openApkPanel() {
    const dialog = openDialog();
    dialog.setTitle('安装包');
    dialog.setBody('正在读取…');
    dialog.setExtra(null);
    dialog.setLog('');
    dialog.setButtons([{ label: '关闭', onClick: () => dialog.close() }], () => dialog.close());

    const extra = document.createElement('div');
    extra.className = 'ops-downloads';
    let any = false;
    try {
      const apk = await get('/api/apk-info');
      if (apk && apk.exists) {
        any = true;
        extra.append(downloadRow(
          `Android APK · ${apk.versionName || '—'}${apk.versionCode == null ? '' : `+${apk.versionCode}`}`,
          `${fmtSize(apk.size)} · ${fmtMtime(apk.mtime)}`,
          apk.downloadUrl || '/multicc.apk',
        ));
      }
    } catch (_) { /* fall through to the iOS row / empty state */ }
    try {
      const ios = await get('/api/ios-ota-info');
      if (ios && ios.exists) {
        any = true;
        extra.append(downloadRow(
          `iOS 安装包 · ${ios.versionName || '—'}${ios.versionCode ? `+${ios.versionCode}` : ''}`,
          `${fmtSize(ios.size)} · ${fmtMtime(ios.mtime)}`,
          ios.installPage || '/ios-ota',
        ));
      }
    } catch (_) { /* not published on this host */ }

    if (!any) {
      dialog.setBody('这台主机还没有可用的安装包。运行发布脚本后回到这里即可下载。');
      return;
    }
    dialog.setBody('直接下载安装包，或打开 iOS 的免重启安装页。');
    dialog.setExtra(extra);
  }

  // ── QR ─────────────────────────────────────────────────────────────────
  async function showQr() {
    const dialog = openDialog();
    dialog.setTitle('扫码打开 MultiCC Air');
    dialog.setLog('');
    dialog.setButtons([{ label: '关闭', onClick: () => dialog.close() }], () => dialog.close());

    let url;
    try {
      const info = await get('/api/server-info');
      url = `${info.url}/air`;
    } catch (_) {
      url = `${location.origin}/air`;
    }

    const extra = document.createElement('div');
    extra.className = 'ops-qr';
    const canvas = document.createElement('canvas');
    const caption = document.createElement('small');
    caption.textContent = url;
    extra.append(canvas, caption);
    dialog.setExtra(extra);

    // qrcode-generator (public/qrcode.min.js), same calls as manage.js showQR.
    if (typeof root.qrcode === 'function') {
      const qr = root.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const cellSize = 6;
      const margin = 8;
      const count = qr.getModuleCount();
      const size = count * cellSize + margin * 2;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Black on white on purpose: a QR in the shell's palette is on-brand and
      // unscannable, and this code only has to survive a phone camera.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      for (let row = 0; row < count; row += 1) {
        for (let column = 0; column < count; column += 1) {
          if (qr.isDark(row, column)) {
            ctx.fillRect(margin + column * cellSize, margin + row * cellSize, cellSize, cellSize);
          }
        }
      }
      dialog.setBody('用手机相机扫码，在同一网络下打开这台主机的 Air 控制台。');
    } else {
      dialog.setBody(`二维码组件未加载。手动访问：${url}`);
    }
  }

  // ── Push ───────────────────────────────────────────────────────────────
  // The subscription logic is public/pwa.js (loaded by air.html), including
  // its own #push-toggle lookup. Only the label is re-owned here: pwa.js falls
  // back to English when no translator is present, and Air ships no i18n
  // dictionary.
  function paintPush(subscribed, permission) {
    const button = el('push-toggle');
    if (!button) return;
    const denied = permission === 'denied';
    button.textContent = subscribed ? '推送已开' : '推送通知';
    button.classList.toggle('on', subscribed);
    button.disabled = denied;
    button.title = denied
      ? '浏览器已拒绝通知权限，请在站点设置里重新允许'
      : (subscribed ? '已开启浏览器推送；点击关闭' : '开启浏览器推送通知');
  }

  function bindPush() {
    root.addEventListener('multicc-push-state', event => {
      const detail = event.detail || {};
      paintPush(!!detail.subscribed, detail.permission);
    });
    const button = el('push-toggle');
    if (button) {
      button.onclick = async () => {
        if (typeof root.togglePush !== 'function') {
          status('推送模块未加载', 'err');
          return;
        }
        status('正在处理推送订阅…');
        try {
          await root.togglePush();
          status('');
        } catch (error) {
          status(`推送订阅失败：${error.message}`, 'err');
        }
      };
    }
    if (typeof root.getPushInfo === 'function') {
      try {
        const info = root.getPushInfo();
        paintPush(!!info.subscribed, info.permission);
      } catch (_) { /* pwa.js not ready yet; the event will paint it */ }
    }
  }

  // ── Restart ────────────────────────────────────────────────────────────
  async function restartService() {
    const agreed = window.confirm(
      '确定要重启 multicc 服务吗？\n这会短暂断开所有会话，随后自动重连（在途消息会先保存）。',
    );
    if (!agreed) return;
    try {
      const result = await raw('/api/restart', {});
      const data = result.data || {};
      if (!result.ok) {
        status(`重启失败：${data.error || `HTTP ${result.status}`}`, 'err');
        return;
      }
      status(data.activeStreaming > 0
        ? `⚠️ 有 ${data.activeStreaming} 个会话正在输出，将先尝试保存其在途内容，再重启`
        : '重启请求已发送，服务即将重启…', 'warn');
    } catch (error) {
      status(`重启请求失败：${error.message}`, 'err');
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  function initialize() {
    const versionRow = el('air-ver-row');
    if (!versionRow) return; // not on the Air shell

    versionRow.onclick = () => { void openUpdateFlow(); };
    versionRow.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openUpdateFlow(); }
    };

    el('air-apk-btn').onclick = () => { void openApkPanel(); };
    el('air-qr-btn').onclick = () => { void showQr(); };
    el('air-restart-btn').onclick = () => { void restartService(); };

    bindPush();
    void loadBootTime();
    void checkVersion();

    // Repaint from the cached reading — the start instant does not change while
    // the process lives, so this costs no requests.
    setInterval(paintBootTime, 60000);
    // A restart is the one thing that does change it, and the user triggers it
    // by hand. Re-reading whenever the tab comes back catches that without
    // polling a value that is constant the rest of the time.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void loadBootTime();
    });

    // The version row is the only place that can notice a new release, so it
    // checks once shortly after load and then hourly, skipping hidden tabs.
    setTimeout(() => { if (!document.hidden) void checkVersion(); }, 3000);
    setInterval(() => { if (!document.hidden) void checkVersion(); }, 60 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})(typeof window !== 'undefined' ? window : null);
