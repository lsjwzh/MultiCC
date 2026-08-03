'use strict';

// ── One-click update from the sidebar version bar ──
//
// Clicking the version row checks for a new version and, if the user confirms,
// runs `./multicc update` on the host. That command restarts the server as its
// last step, so this flow is written around one fact: the connection will drop
// mid-operation, and a failed poll during that window means "restarting", not
// "failed". The server's own state lives in logs/update.log, so polling resumes
// against the new process and still learns how the run ended.
//
// Lives outside manage.js on purpose: that file is at the source line budget.

(function () {
  const POLL_MS = 1500;
  // npm install on a cold cache plus a restart; past this the run is not coming
  // back and the user should be told so rather than watch a spinner forever.
  const MAX_WAIT_MS = 20 * 60 * 1000;

  let _flowOpen = false;
  // Exactly one poll loop may run at a time, but the dialog it renders into can
  // be replaced: the user may close the dialog ("后台运行") and re-open it by
  // clicking the version row again, and the same run must keep reporting.
  let _polling = false;
  let _activeDialog = null;

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    // Same convention as the rest of manage/*: cookie auth normally, explicit
    // header when the page was opened with ?token=.
    try { if (typeof _urlToken !== 'undefined' && _urlToken) h['X-Access-Token'] = _urlToken; } catch (_) {}
    return h;
  }

  function el(tag, css, text) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text != null) node.textContent = text;
    return node;
  }

  function setHint(text, accent) {
    const hint = document.getElementById('ver-hint');
    if (!hint) return;
    hint.textContent = text;
    hint.style.color = accent ? 'var(--accent)' : '';
  }

  function toast(msg, isError) {
    if (typeof showToast === 'function') showToast(msg, !!isError);
  }

  // ── Dialog ─────────────────────────────────────────────────────────────
  // One overlay for the whole flow (confirm → progress → outcome): the log the
  // user is reading must not be thrown away and re-created when the phase
  // changes, or the pane would flicker and lose its scroll position.
  function createDialog() {
    const overlay = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;');
    const box = el('div', 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:520px;max-width:94vw;max-height:88vh;display:flex;flex-direction:column;');
    const title = el('div', 'font-size:15px;font-weight:600;color:#c9d1d9;margin-bottom:10px;', '更新 MultiCC');
    const body = el('div', 'font-size:13px;color:#c9d1d9;line-height:1.7;white-space:pre-wrap;');
    const extra = el('div', 'margin-top:10px;');
    const logPane = el('pre', 'display:none;margin:12px 0 0;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:8px;font-size:11px;line-height:1.5;color:#8b949e;white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:38vh;flex:1 1 auto;');
    const row = el('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex:0 0 auto;');
    box.appendChild(title); box.appendChild(body); box.appendChild(extra); box.appendChild(logPane); box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let onEscape = null;
    function keyHandler(e) { if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); } }
    document.addEventListener('keydown', keyHandler, true);

    return {
      overlay,
      setTitle(text) { title.textContent = text; },
      setBody(text) { body.textContent = text; },
      setExtra(node) { extra.textContent = ''; if (node) extra.appendChild(node); },
      setLog(text) {
        if (!text) { logPane.style.display = 'none'; return; }
        const atBottom = logPane.scrollHeight - logPane.scrollTop - logPane.clientHeight < 24;
        logPane.style.display = 'block';
        logPane.textContent = text;
        if (atBottom) logPane.scrollTop = logPane.scrollHeight;
      },
      setButtons(buttons, escapeAction) {
        row.textContent = '';
        for (const spec of buttons) {
          const button = el('button', null, spec.label);
          button.className = 'btn' + (spec.kind ? ' btn-' + spec.kind : '');
          button.onclick = spec.onClick;
          row.appendChild(button);
        }
        onEscape = escapeAction || null;
      },
      close() {
        document.removeEventListener('keydown', keyHandler, true);
        overlay.remove();
        if (_activeDialog === this) _activeDialog = null;
      },
    };
  }

  function forceCheckbox() {
    const label = el('label', 'display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#8b949e;cursor:pointer;');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'update-force';
    input.style.cssText = 'margin-top:3px;flex:0 0 auto;';
    const text = el('span', null, '强制更新：工作区有改动或历史分叉时也更新。本地改动会先备份到 git stash（不会自动恢复），代码将重置到远端最新。');
    label.appendChild(input); label.appendChild(text);
    return { label, input };
  }

  // ── Status polling ─────────────────────────────────────────────────────
  async function fetchStatus() {
    // A network failure here is expected — the update restarts the server
    // underneath us — so it is reported as a distinct state, never as a failure.
    try {
      const res = await fetch('/api/update/status', { headers: headers(), cache: 'no-store' });
      if (!res.ok) return { unreachable: true };
      return await res.json();
    } catch (_) {
      return { unreachable: true };
    }
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function serverIsBack() {
    try {
      const res = await fetch('/api/server-info', { headers: headers(), cache: 'no-store' });
      return res.ok;
    } catch (_) { return false; }
  }

  // Renders into whichever dialog is currently attached, re-read every tick so
  // closing and re-opening the dialog never orphans the run.
  async function pollUntilDone({ force }) {
    if (_polling) return;
    _polling = true;
    const startedAt = Date.now();
    let sawUnreachable = false;
    try {
      for (;;) {
        const status = await fetchStatus();
        const dialog = _activeDialog;
        if (status.unreachable) {
          sawUnreachable = true;
          setHint('服务重启中…', true);
          if (dialog) dialog.setBody('服务正在重启，连接已暂时断开。这一步通常需要几秒钟。');
        } else if (status.state === 'succeeded') {
          setHint('更新完成，正在重载…', true);
          if (dialog) {
            dialog.setTitle('更新完成');
            dialog.setBody('更新已完成，服务已重启。正在重新加载页面…');
            dialog.setLog(status.tail || '');
            dialog.setButtons([]);
          }
          toast('更新完成，正在重载页面…');
          // The manager only writes its exit marker after wait_for_ready, so
          // reaching this branch already proves the new server answers. The
          // extra probe covers the odd case of a proxy still holding the old
          // connection open.
          for (let i = 0; i < 20 && !(await serverIsBack()); i += 1) await sleep(500);
          location.reload();
          return;
        } else if (status.state === 'failed' || status.state === 'stale') {
          const failed = status.state === 'failed';
          setHint(failed ? '更新失败' : '更新无响应');
          if (dialog) {
            dialog.setTitle(failed ? '更新失败' : '更新失去响应');
            dialog.setBody(failed
              ? `更新未完成（退出码 ${status.exitCode}）。服务没有被更新，下面是完整输出：`
              : '更新进程超过 15 分钟没有任何输出，可能已被系统结束。下面是它最后的输出：');
            dialog.setLog(status.tail || '(无输出)');
            const buttons = [];
            // The run's own record of whether it was forced beats this closure's
            // copy: the dialog may have been re-attached from another tab.
            const wasForced = status.force != null ? !!status.force : !!force;
            if (!wasForced && failed) {
              buttons.push({
                label: '强制更新重试',
                kind: 'danger',
                onClick: () => { dialog.close(); startUpdate(true); },
              });
            }
            buttons.push({ label: '关闭', onClick: () => dialog.close() });
            dialog.setButtons(buttons, () => dialog.close());
          } else {
            toast(failed ? '更新失败，点击版本号查看输出' : '更新失去响应', true);
          }
          return;
        } else if (status.state === 'running') {
          const lastLine = String(status.tail || '').trim().split('\n').pop() || '正在更新…';
          setHint(lastLine.slice(0, 40), true);
          if (dialog) {
            dialog.setBody(sawUnreachable ? '服务已回来，正在收尾…' : '正在更新，请勿关闭本机。完成后服务会自动重启。');
            dialog.setLog(status.tail || '');
          }
        } else if (status.state === 'idle') {
          // The log has not appeared yet (the child writes its first line after
          // ~1s), or someone removed it. Keep waiting; the timeout below is the
          // backstop.
          if (dialog) dialog.setBody('正在启动更新…');
        }

        if (Date.now() - startedAt > MAX_WAIT_MS) {
          setHint('更新超时');
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
      _polling = false;
    }
  }

  async function startUpdate(force) {
    const dialog = createDialog();
    _activeDialog = dialog;
    dialog.setTitle('正在更新');
    dialog.setBody('正在启动更新…');
    dialog.setExtra(null);
    dialog.setButtons([{ label: '后台运行', onClick: () => dialog.close() }], () => dialog.close());

    let res;
    try {
      res = await fetch('/api/update', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ force: !!force }),
      });
    } catch (error) {
      dialog.setTitle('无法启动更新');
      dialog.setBody('请求失败：' + error.message);
      dialog.setButtons([{ label: '关闭', onClick: () => dialog.close() }], () => dialog.close());
      return;
    }
    const data = await res.json().catch(() => ({}));

    if (res.status === 409) {
      // Someone (or a previous tab) already started one — attach to it rather
      // than reporting an error the user can do nothing about.
      dialog.setBody('已有一个更新正在进行，正在接管其进度…');
      await pollUntilDone({ force: !!(data.status && data.status.force) });
      return;
    }
    if (!res.ok) {
      dialog.setTitle('无法启动更新');
      dialog.setBody((data.error || 'HTTP ' + res.status) + (data.code ? `\n(${data.code})` : ''));
      dialog.setButtons([{ label: '关闭', onClick: () => dialog.close() }], () => dialog.close());
      return;
    }

    if (data.activeStreaming > 0) {
      toast(`⚠️ 有 ${data.activeStreaming} 个会话正在输出，更新后的重启会中断它们（在途内容已保存）`, true);
    }
    setHint('正在更新…', true);
    await pollUntilDone({ force: !!force });
  }

  async function confirmThenUpdate(info) {
    const dialog = createDialog();
    const updateAvailable = !!(info && info.updateAvailable);
    const currentText = 'v' + ((info && info.current) || '—');
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

    dialog.setButtons([
      { label: '取消', onClick: () => dialog.close() },
      {
        label: updateAvailable ? '立即更新' : '仍要更新',
        kind: updateAvailable ? 'green' : null,
        onClick: () => { const force = input.checked; dialog.close(); startUpdate(force); },
      },
    ], () => dialog.close());
  }

  // ── Entry point: the sidebar version row ───────────────────────────────
  window.onVersionBarClick = async function onVersionBarClick() {
    if (_flowOpen) return;
    _flowOpen = true;
    try {
      // An update already in flight (possibly started in another tab, or before
      // a reload) takes precedence over anything this click would otherwise do.
      const running = await fetchStatus();
      if (running && running.running) {
        const dialog = createDialog();
        _activeDialog = dialog;
        dialog.setTitle('正在更新');
        dialog.setBody('已有一个更新正在进行，正在接管其进度…');
        dialog.setButtons([{ label: '后台运行', onClick: () => dialog.close() }], () => dialog.close());
        // Not awaited: the poll can run for many minutes, and holding _flowOpen
        // that long would make the version row unclickable — exactly when the
        // user who backgrounded the dialog wants it back.
        pollUntilDone({ force: !!running.force });
        return;
      }

      setHint('检查中…');
      let info = null;
      try {
        const res = await fetch('/api/version-check', { headers: headers(), cache: 'no-store' });
        info = await res.json();
      } catch (_) {
        info = null;
      }
      // Keep the sidebar's own rendering authoritative — checkVersion() owns
      // those elements, so re-run it rather than duplicating its logic here.
      if (typeof window.checkVersion === 'function') window.checkVersion();
      if (!info) {
        toast('检查更新失败，请稍后再试', true);
        return;
      }
      await confirmThenUpdate(info);
    } finally {
      _flowOpen = false;
    }
  };
})();
