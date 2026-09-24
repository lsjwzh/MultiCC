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
      hint.textContent = t('airOpsCheckFailed');
      badge.hidden = true;
      return;
    }
    current.textContent = `v${info.current || '—'}`;
    if (info.updateAvailable) {
      icon.textContent = '🆕';
      hint.textContent = t('airOpsNewVersion');
      badge.textContent = `v${info.latestVersion || ''}`;
      badge.hidden = false;
    } else {
      icon.textContent = '📦';
      hint.textContent = info.apiError ? t('airOpsUpToDateOffline') : t('airOpsUpToDate');
      badge.hidden = true;
    }
  }

  async function checkVersion() {
    const hint = el('air-ver-hint');
    if (hint) hint.textContent = t('airOpsChecking');
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
    text.textContent = t('airOpsForceLabel');
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
          setVersionHint(t('airOpsServerRestarting'), true);
          if (dialog) dialog.setBody(t('airOpsServerRestartingBody'));
        } else if (state.state === 'succeeded') {
          setVersionHint(t('airOpsUpdateDoneReloading'), true);
          if (dialog) {
            dialog.setTitle(t('airOpsUpdateDoneTitle'));
            dialog.setBody(t('airOpsUpdateDoneBody'));
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
          setVersionHint(failed ? t('airOpsUpdateFailed') : t('airOpsUpdateNoResponse'));
          if (dialog) {
            dialog.setTitle(failed ? t('airOpsUpdateFailed') : t('airOpsUpdateLostTitle'));
            dialog.setBody(failed
              ? t('airOpsUpdateIncomplete', { code: state.exitCode })
              : t('airOpsUpdateStale'));
            dialog.setLog(state.tail || t('airOpsNoOutput'));
            const buttons = [];
            // The run's own record of whether it was forced beats this
            // closure's copy: the dialog may be re-attached from another tab.
            const wasForced = state.force != null ? !!state.force : !!force;
            if (!wasForced && failed) {
              buttons.push({
                label: t('airOpsForceRetry'),
                kind: 'danger',
                onClick: () => { dialog.close(); startUpdate(true); },
              });
            }
            buttons.push({ label: t('airOpsClose'), onClick: () => dialog.close() });
            dialog.setButtons(buttons, () => dialog.close());
          }
          return;
        } else if (state.state === 'running') {
          const lastLine = String(state.tail || '').trim().split('\n').pop() || t('airOpsUpdating');
          setVersionHint(lastLine.slice(0, 40), true);
          if (dialog) {
            dialog.setBody(sawUnreachable ? t('airOpsServerBackFinishing') : t('airOpsUpdatingBody'));
            dialog.setLog(state.tail || '');
          }
        } else if (dialog) {
          // 'idle' / 'scheduled': no log yet (the child writes its first line
          // after ~1s). Keep waiting; the timeout below is the backstop.
          dialog.setBody(t('airOpsStartingUpdate'));
        }

        if (Date.now() - startedAt > MAX_WAIT_MS) {
          setVersionHint(t('airOpsUpdateTimeout'));
          if (dialog) {
            dialog.setTitle(t('airOpsUpdateTimeout'));
            dialog.setBody(t('airOpsUpdateTimeoutBody'));
            dialog.setButtons([{ label: t('airOpsClose'), onClick: () => dialog.close() }], () => dialog.close());
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
    dialog.setTitle(t('airOpsUpdatingTitle'));
    dialog.setBody(t('airOpsStartingUpdate'));
    dialog.setExtra(null);
    dialog.setLog('');
    dialog.setButtons([{ label: t('airOpsRunInBackground'), onClick: () => dialog.close() }], () => dialog.close());

    let result;
    try {
      result = await raw('/api/update', { force: !!force });
    } catch (error) {
      dialog.setTitle(t('airOpsCannotStart'));
      dialog.setBody(t('airOpsRequestFailed', { message: error.message }));
      dialog.setButtons([{ label: t('airOpsClose'), onClick: () => dialog.close() }], () => dialog.close());
      return;
    }

    if (result.status === 409) {
      // Someone (or a previous tab) already started one — attach to it rather
      // than reporting an error the user can do nothing about.
      dialog.setBody(t('airOpsUpdateTakeover'));
      await pollUntilDone({ force: !!(result.data && result.data.status && result.data.status.force) });
      return;
    }
    if (!result.ok) {
      const data = result.data || {};
      dialog.setTitle(t('airOpsCannotStart'));
      dialog.setBody((data.error || `HTTP ${result.status}`) + (data.code ? `\n(${data.code})` : ''));
      dialog.setButtons([{ label: t('airOpsClose'), onClick: () => dialog.close() }], () => dialog.close());
      return;
    }

    if (result.data && result.data.activeStreaming > 0) {
      status(`⚠️ ${t('airOpsStreamingBusyUpdate', { count: result.data.activeStreaming })}`, 'warn');
    }
    setVersionHint(t('airOpsUpdating'), true);
    await pollUntilDone({ force: !!force });
  }

  async function confirmThenUpdate(info) {
    const dialog = openDialog();
    const updateAvailable = !!(info && info.updateAvailable);
    const currentText = `v${(info && info.current) || '—'}`;
    const latestText = info && info.latest ? info.latest : null;

    dialog.setTitle(updateAvailable ? t('airOpsNewVersionFound') : t('airOpsUpdateMultiCC'));
    dialog.setBody([
      t('airOpsCurrentVersion', { current: currentText, channel: (info && info.channel) || 'dev' }),
      updateAvailable
        ? t('airOpsLatestVersion', { latest: latestText })
        : (info && info.apiError ? t('airOpsLatestOffline') : t('airOpsLatestIsCurrent', { latest: latestText || t('airOpsUnknown') })),
      '',
      t('airOpsUpdateIntro'),
      t('airOpsUpdateSessionsNote'),
    ].join('\n'));

    const { label, input } = forceCheckbox();
    dialog.setExtra(label);
    dialog.setLog('');
    dialog.setButtons([
      { label: t('airOpsCancel'), onClick: () => dialog.close() },
      {
        label: updateAvailable ? t('airOpsUpdateNow') : t('airOpsUpdateAnyway'),
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
        dialog.setTitle(t('airOpsUpdatingTitle'));
        dialog.setBody(t('airOpsUpdateTakeover'));
        dialog.setLog(running.tail || '');
        dialog.setButtons([{ label: t('airOpsRunInBackground'), onClick: () => dialog.close() }], () => dialog.close());
        // Not awaited: the poll can run for many minutes, and holding the
        // guard that long would leave the version row unclickable — exactly
        // when the user who backgrounded the dialog wants it back.
        pollUntilDone({ force: !!running.force });
        return;
      }
      const info = await checkVersion();
      if (!info) {
        status(t('airOpsCheckFailedRetry'), 'err');
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
    time.title = started.toLocaleString(getLocale());
    if (uptime) uptime.textContent = t('airOpsUptime', { uptime: fmtUptime(uptimeMs) });
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
    link.textContent = t('airOpsDownload');
    link.className = 'primary';
    row.append(copy, link);
    return row;
  }

  async function openApkPanel() {
    const dialog = openDialog();
    dialog.setTitle(t('airOpsInstallPackages'));
    dialog.setBody(t('airOpsLoading'));
    dialog.setExtra(null);
    dialog.setLog('');
    dialog.setButtons([{ label: t('airOpsClose'), onClick: () => dialog.close() }], () => dialog.close());

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
          `${t('airOpsIosPackage')} · ${ios.versionName || '—'}${ios.versionCode ? `+${ios.versionCode}` : ''}`,
          `${fmtSize(ios.size)} · ${fmtMtime(ios.mtime)}`,
          ios.installPage || '/ios-ota',
        ));
      }
    } catch (_) { /* not published on this host */ }

    if (!any) {
      dialog.setBody(t('airOpsNoPackages'));
      return;
    }
    dialog.setBody(t('airOpsPackagesBody'));
    dialog.setExtra(extra);
  }

  // ── QR ─────────────────────────────────────────────────────────────────
  async function showQr() {
    const dialog = openDialog();
    dialog.setTitle(t('airOpsQrTitle'));
    dialog.setLog('');
    dialog.setButtons([{ label: t('airOpsClose'), onClick: () => dialog.close() }], () => dialog.close());

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
      dialog.setBody(t('airOpsQrBody'));
    } else {
      dialog.setBody(t('airOpsQrModuleMissing', { url }));
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
    button.textContent = subscribed ? t('airOpsPushOn') : t('airOpsPushNotify');
    button.classList.toggle('on', subscribed);
    button.disabled = denied;
    button.title = denied
      ? t('airOpsPushDenied')
      : (subscribed ? t('airOpsPushUnsubscribe') : t('airOpsPushSubscribe'));
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
          status(t('airOpsPushModuleMissing'), 'err');
          return;
        }
        status(t('airOpsPushWorking'));
        try {
          await root.togglePush();
          status('');
        } catch (error) {
          status(t('airOpsPushFailed', { message: error.message }), 'err');
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
    const agreed = window.confirm(t('airOpsRestartConfirm'));
    if (!agreed) return;
    try {
      const result = await raw('/api/restart', {});
      const data = result.data || {};
      if (!result.ok) {
        status(t('airOpsRestartFailed', { error: data.error || `HTTP ${result.status}` }), 'err');
        return;
      }
      status(data.activeStreaming > 0
        ? `⚠️ ${t('airOpsRestartStreaming', { count: data.activeStreaming })}`
        : t('airOpsRestartSent'), 'warn');
    } catch (error) {
      status(t('airOpsRestartRequestFailed', { message: error.message }), 'err');
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
    // 「更多与系统」展开后底栏比一屏还高（100% 缩放的笔记本上很常见），主机操作
    // 那一栏会落到视口外。侧栏自己会滚（air.css），这里把最后一行带进视野，
    // 不让用户以为重启按钮不存在。
    const sideMore = el('side-more');
    if (sideMore) sideMore.addEventListener('toggle', () => {
      if (sideMore.open) requestAnimationFrame(() => el('air-restart-btn')?.scrollIntoView({ block: 'nearest' }));
    });

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
