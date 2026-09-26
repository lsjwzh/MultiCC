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
  // 数字格式的唯一来源（shared/format.js，先于本文件加载）。Node 侧的 DOM 沙箱里没
  // 有它，所以两种取法都留着：页面走全局，测试走 require。
  const FMT = root.MultiCCFormat
    || (typeof require === 'function' ? require('./shared/format.js') : null);

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

  // ── Update progress panel ──────────────────────────────────────────────
  // `./multicc update` prints a marker at every step boundary and the status
  // route returns them as `steps` (src/update-runner.js). The panel turns that
  // into a checklist, a bar and a ticking clock, so a slow step reads as "this
  // step is taking 40s", not as a frozen dialog.
  const UPDATE_STEP_IDS = ['deps', 'check', 'fetch', 'install', 'verify', 'restart', 'ready'];
  const STEP_LABEL_KEYS = {
    deps: 'airOpsStepDeps', check: 'airOpsStepCheck', fetch: 'airOpsStepFetch',
    install: 'airOpsStepInstall', verify: 'airOpsStepVerify', restart: 'airOpsStepRestart', ready: 'airOpsStepReady',
    // Standalone package (scripts/standalone-cli.js declares its own plan).
    download: 'airOpsStepDownload', checksum: 'airOpsStepChecksum', extract: 'airOpsStepExtract',
  };
  const STEP_ICONS = { done: '✓', running: '⟳', failed: '✗', skipped: '–', pending: '·' };

  // An elapsed span is one of the five questions shared/format.js owns, so this
  // is a delegate and nothing more: a second mm:ss spelling of "how long" is
  // exactly what tests/test-format-guard.js exists to catch, and it caught this
  // one. The name stays because the update panel reads better referring to
  // durationText() than to formatBytes-style plumbing.
  function durationText(ms) {
    return FMT.formatDuration(ms);
  }

  // Reconcile what the log says with what the client can see. The log cannot
  // record the restart while the server is down, nor mark a step failed (the
  // manager just exits), so both are inferred here.
  function effectiveSteps(state, { unreachable = false } = {}) {
    const reported = (state && state.steps) || [];
    const byId = new Map(reported.map(step => [step.id, step]));
    // The run's own plan when it reported one; the git manager's otherwise.
    const ids = reported.length ? reported.map(step => step.id) : UPDATE_STEP_IDS;
    const steps = ids.map(id => ({ id, state: 'pending', startedAt: null, endedAt: null, note: null, progress: null, ...(byId.get(id) || {}) }));
    if (unreachable) {
      const restart = steps.find(step => step.id === 'restart');
      if (restart.state === 'pending') restart.state = 'running';
    }
    const outcome = state && state.state;
    if (outcome === 'succeeded') {
      for (const step of steps) {
        if (step.state === 'running') step.state = 'done';
        else if (step.state === 'pending') step.state = 'skipped';
      }
    } else if (outcome === 'failed' || outcome === 'stale') {
      const current = steps.find(step => step.state === 'running')
        || steps.find(step => step.state === 'pending');
      if (current) current.state = 'failed';
    }
    return steps;
  }

  function createUpdateProgress() {
    const panel = document.createElement('div');
    panel.className = 'ops-progress';
    const summary = document.createElement('div');
    summary.className = 'ops-progress-summary';
    const bar = document.createElement('div');
    bar.className = 'ops-progress-bar';
    const fill = document.createElement('span');
    bar.append(fill);
    const list = document.createElement('ol');
    list.className = 'ops-steps';
    panel.append(summary, bar, list);

    let lastState = null;
    let lastUnreachable = false;
    let startedAtMs = Date.now();
    let timer = null;

    function paint() {
      const now = Date.now();
      const steps = effectiveSteps(lastState, { unreachable: lastUnreachable });
      const finished = steps.filter(step => step.state === 'done' || step.state === 'skipped').length;
      const current = steps.find(step => step.state === 'running');
      // A download reports its own percentage; any other running step counts half.
      const share = !current ? 0
        : (current.progress && current.progress.percent != null ? current.progress.percent / 100 : 0.5);
      const percent = Math.round(((finished + share) / steps.length) * 100);
      fill.style.width = `${percent}%`;
      panel.classList.toggle('is-failed', steps.some(step => step.state === 'failed'));
      summary.textContent = t('airOpsUpdateProgress', {
        done: finished, total: steps.length, time: durationText(now - startedAtMs),
      });
      list.replaceChildren(...steps.map(step => {
        const row = document.createElement('li');
        row.className = `ops-step is-${step.state}`;
        const icon = document.createElement('span');
        icon.className = 'ops-step-icon';
        icon.textContent = STEP_ICONS[step.state] || '·';
        const name = document.createElement('span');
        name.className = 'ops-step-name';
        name.textContent = STEP_LABEL_KEYS[step.id] ? t(STEP_LABEL_KEYS[step.id]) : step.id;
        const meta = document.createElement('span');
        meta.className = 'ops-step-meta';
        const began = Date.parse(step.startedAt || '');
        const ended = Date.parse(step.endedAt || '');
        if (step.state === 'skipped') meta.textContent = t('airOpsStepSkipped');
        else if (step.state === 'running') {
          meta.textContent = [step.progress && step.progress.text, Number.isFinite(began) ? durationText(now - began) : null]
            .filter(Boolean).join(' · ');
        }
        else if (step.state === 'done' && Number.isFinite(began) && Number.isFinite(ended)) meta.textContent = durationText(ended - began);
        row.append(icon, name, meta);
        return row;
      }));
    }

    return {
      node: panel,
      update(state, { unreachable = false } = {}) {
        if (state && !unreachable) {
          lastState = state;
          const began = Date.parse(state.startedAt || '');
          if (Number.isFinite(began)) startedAtMs = began;
        }
        lastUnreachable = unreachable;
        paint();
      },
      start() {
        if (timer) return;
        timer = setInterval(paint, 1000);
        paint();
      },
      stop() {
        if (timer) { clearInterval(timer); timer = null; }
        paint();
      },
    };
  }

  // One panel per polling run, re-attached when the update dialog is reopened.
  // The dialog is shared with the QR/APK panels: never take over an extra
  // slot that already holds someone else's content.
  let updateProgress = null;
  function attachProgress(dialog) {
    if (!updateProgress) updateProgress = createUpdateProgress();
    const host = el('ops-extra');
    const free = host && (!host.firstChild || host.firstChild === updateProgress.node);
    if (dialog && free && host.firstChild !== updateProgress.node) dialog.setExtra(updateProgress.node);
    updateProgress.start();
    return updateProgress;
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

  // Standalone (install.sh) runs have no step markers of their own, so the
  // client does not pretend to show a checklist for them — just the script's
  // raw output, verbatim, as it is written to the log. This is also what the
  // user asked for explicitly: "更新窗口只是实时显示脚本的进展就好了".
  function paintRawLog(dialog, state, { unreachable = false, note = '' } = {}) {
    if (!dialog) return;
    const lines = [note, state && state.tail].filter(Boolean).join('\n\n');
    dialog.setLog(lines);
  }

  // install.sh restarts the server at its own end, so the exit marker in the
  // log can be written by a process that is *about* to disappear — it proves
  // the script finished, not that the new server is answering yet. So success
  // for the standalone path is judged by /api/version-check, not by the log:
  // keep polling it — tolerating the errors a still-booting server returns —
  // until a response succeeds and reports exactly the version this run
  // installed. Ported from the user's explicit spec: "页面在前端不断请求
  // version接口...直到version成功，且返回目标版本号，才标记为升级成功".
  async function confirmTargetVersion(targetVersion, { dialog, deadline } = {}) {
    for (;;) {
      try {
        const result = await raw('/api/version-check');
        if (result.ok && result.data && (!targetVersion || result.data.current === targetVersion)) {
          return result.data;
        }
      } catch (_) {
        // Server still restarting; keep polling.
      }
      if (dialog) dialog.setBody(t('airOpsUpdateConfirmingBody'));
      if (Date.now() > deadline) return null;
      await sleep(POLL_MS);
    }
  }

  async function pollUntilDone({ force, kind = 'git', targetVersion = null }) {
    if (pollingUpdate) return;
    pollingUpdate = true;
    const startedAt = Date.now();
    let sawUnreachable = false;
    updateProgress = null;
    const standalone = kind === 'standalone';
    try {
      for (;;) {
        const state = await fetchUpdateStatus();
        const dialog = activeDialog && activeDialog.isOpen() ? activeDialog : null;
        const progress = standalone ? null : attachProgress(dialog);
        if (progress) progress.update(state.unreachable ? null : state, { unreachable: !!state.unreachable });
        if (standalone) paintRawLog(dialog, state.unreachable ? null : state, { unreachable: !!state.unreachable });

        if (state.unreachable) {
          sawUnreachable = true;
          setVersionHint(t('airOpsServerRestarting'), true);
          if (dialog) dialog.setBody(t('airOpsServerRestartingBody'));
        } else if (state.state === 'succeeded') {
          if (progress) progress.stop();
          if (!standalone) {
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
          }
          // install.sh: the exit marker only proves the script ran to
          // completion, not that the version it installed is the one now
          // answering requests — confirm that against /api/version-check
          // before declaring success.
          const resolvedTarget = targetVersion || state.targetVersion || null;
          setVersionHint(t('airOpsUpdateConfirming'), true);
          if (dialog) {
            dialog.setTitle(t('airOpsUpdateDoneTitle'));
            dialog.setBody(t('airOpsUpdateConfirmingBody'));
            dialog.setButtons([]);
          }
          const confirmed = await confirmTargetVersion(resolvedTarget, {
            dialog,
            deadline: Date.now() + MAX_WAIT_MS,
          });
          if (confirmed) {
            setVersionHint(t('airOpsUpdateDoneReloading'), true);
            location.reload();
            return;
          }
          setVersionHint(t('airOpsUpdateNoResponse'));
          if (dialog) {
            dialog.setTitle(t('airOpsUpdateLostTitle'));
            dialog.setBody(t('airOpsUpdateConfirmTimeout', { version: resolvedTarget || t('airOpsUnknown') }));
            dialog.setButtons([
              { label: t('airOpsReloadAnyway'), kind: 'primary', onClick: () => location.reload() },
              { label: t('airOpsClose'), onClick: () => dialog.close() },
            ], () => dialog.close());
          }
          return;
        } else if (state.state === 'failed' || state.state === 'stale') {
          const failed = state.state === 'failed';
          if (progress) progress.stop();
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
            if (!wasForced && failed && !standalone) {
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
          if (standalone) {
            setVersionHint((String(state.tail || '').trim().split('\n').pop() || t('airOpsUpdating')).slice(0, 40), true);
            if (dialog) dialog.setBody(sawUnreachable ? t('airOpsServerBackFinishing') : t('airOpsUpdatingBody'));
          } else {
            // The hint beside the version number: the download's own progress
            // when there is one, else the newest log line.
            const current = (state.steps || []).find(step => step.state === 'running' && step.progress);
            const lastLine = current
              ? `${t(STEP_LABEL_KEYS[current.id] || 'airOpsUpdating')} ${current.progress.percent != null ? `${current.progress.percent}%` : current.progress.text}`
              : (String(state.tail || '').trim().split('\n').pop() || t('airOpsUpdating'));
            setVersionHint(lastLine.slice(0, 40), true);
            if (dialog) {
              dialog.setBody(sawUnreachable ? t('airOpsServerBackFinishing') : t('airOpsUpdatingBody'));
              dialog.setLog(state.tail || '');
            }
          }
        } else if (dialog) {
          // 'idle' / 'scheduled': no log yet (the child writes its first line
          // after ~1s). Keep waiting; the timeout below is the backstop.
          dialog.setBody(t('airOpsStartingUpdate'));
        }

        if (Date.now() - startedAt > MAX_WAIT_MS) {
          if (progress) progress.stop();
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
      if (updateProgress) updateProgress.stop();
    }
  }

  let pollingUpdate = false;

  async function startUpdate(force, kind = 'git') {
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
      const runningStatus = (result.data && result.data.status) || {};
      await pollUntilDone({ force: !!runningStatus.force, kind, targetVersion: runningStatus.targetVersion || null });
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
    await pollUntilDone({ force: !!force, kind, targetVersion: (result.data && result.data.targetVersion) || null });
  }

  // kind comes from /api/update/status: 'standalone' downloads a new package
  // and has no git "force" mode, so the checkbox is left out.
  async function confirmThenUpdate(info, { kind = 'git' } = {}) {
    const standalone = kind === 'standalone';
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
      t(standalone ? 'airOpsUpdateIntroStandalone' : 'airOpsUpdateIntro'),
      t('airOpsUpdateSessionsNote'),
    ].join('\n'));

    const { label, input } = forceCheckbox();
    dialog.setExtra(standalone ? null : label);
    dialog.setLog('');
    dialog.setButtons([
      { label: t('airOpsCancel'), onClick: () => dialog.close() },
      {
        label: updateAvailable ? t('airOpsUpdateNow') : t('airOpsUpdateAnyway'),
        kind: 'primary',
        onClick: () => { const force = !standalone && input.checked; dialog.close(); startUpdate(force, kind); },
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
        dialog.setExtra(null);
        dialog.setLog(running.tail || '');
        dialog.setButtons([{ label: t('airOpsRunInBackground'), onClick: () => dialog.close() }], () => dialog.close());
        // Not awaited: the poll can run for many minutes, and holding the
        // guard that long would leave the version row unclickable — exactly
        // when the user who backgrounded the dialog wants it back.
        pollUntilDone({ force: !!running.force, kind: running.kind, targetVersion: running.targetVersion || null });
        if (running.kind !== 'standalone') attachProgress(dialog).update(running);
        return;
      }
      const info = await checkVersion();
      if (!info) {
        status(t('airOpsCheckFailedRetry'), 'err');
        return;
      }
      await confirmThenUpdate(info, { kind: running && running.kind });
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
  // 字节数走全站唯一那份（public/shared/format.js）：单位、进位、小数位都由它定。
  // 这里只保留本页的取舍 —— 0 字节的产物是「没发布」而不是「0 B」，KB 取整（跟管理台
  // 那格报同一个文件同一个数），以及未知用 '—'。
  const PKG_SIZE = Object.freeze({
    placeholder: '—', zeroIsMissing: true, unitDecimals: { KB: 0 },
  });

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
          `${FMT.formatBytes(apk.size, PKG_SIZE)} · ${fmtMtime(apk.mtime)}`,
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
          `${FMT.formatBytes(ios.size, PKG_SIZE)} · ${fmtMtime(ios.mtime)}`,
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
