(function () {
  'use strict';

  // Ops terminal: a repair shell for hosts that cannot create their first
  // directory — no git on a bare VPS, no commit identity on a fresh service
  // account. Such a host has no session terminal yet, so the add-directory
  // dialog opens this panel (FIX_ACTIONS in air-task-settings.js) and hands it
  // a retry callback. Commands run as background jobs on the host
  // (src/routes/ops-terminal.js) that this panel polls: an install can take
  // minutes, and a panel closed mid-run re-attaches to the job when reopened.

  const POLL_MS = 600;
  const MAX_POLL_FAILURES = 5;
  const ERROR_KEYS = { OPS_BUSY: 'airOpsTerminalBusy', INVALID_COMMAND: 'airOpsTerminalInvalid' };

  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function request(url, body, method = 'POST') {
    const options = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const raw = await response.text();
    let result = {};
    try { result = raw ? JSON.parse(raw) : {}; }
    catch (_) { throw new Error(t('airOpsTerminalBadResponse', { status: response.status })); }
    if (!response.ok || result.ok === false) {
      const error = new Error(ERROR_KEYS[result.code] ? t(ERROR_KEYS[result.code])
        : result.message || result.error || result.code || t('airOpsTerminalBadResponse', { status: response.status }));
      error.code = result.code;
      error.job = result.job || null;
      throw error;
    }
    return result;
  }

  // Survives closing the panel: a repair is usually 2–3 commands and the user
  // should not have to retype them after peeking at the directory dialog.
  const history = [];

  function open(options = {}) {
    const retry = typeof options.retry === 'function' ? options.retry : null;
    const d = node('dialog', null, 'air-ops-dialog');
    const form = node('form');
    form.append(node('h2', t('airOpsTerminalTitle')), node('p', t('airOpsTerminalHint')));

    const envBox = node('div', '', 'air-ops-env');
    const advice = node('div', '', 'air-ops-advice');
    const cmdline = node('div', null, 'air-ops-cmdline');
    const input = node('input', null, 'air-ops-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.placeholder = t('airOpsTerminalCommandPlaceholder');
    const runButton = node('button', t('airOpsTerminalRun'), 'primary');
    runButton.type = 'submit';
    const stopButton = node('button', t('airOpsTerminalStop'), 'danger');
    stopButton.type = 'button';
    stopButton.hidden = true;
    cmdline.append(input, runButton, stopButton);

    const output = node('pre', '', 'air-ops-output');
    output.setAttribute('aria-live', 'polite');
    const historyRow = node('div', '', 'air-ops-history');
    const footer = node('div', null, 'air-ops-footer');
    const ready = node('span', '', 'air-ops-ready');
    const retryButton = node('button', t('airOpsTerminalRetry'), 'primary');
    retryButton.type = 'button';
    retryButton.hidden = true;
    const close = node('button', t('airOpsTerminalClose'));
    close.type = 'button';
    footer.append(ready, retryButton, close);

    form.append(envBox, advice, cmdline, output, historyRow, footer);
    d.append(form);
    document.body.append(d);
    d.showModal();

    let env = null;
    let closed = false;
    let view = null; // the job this panel is showing: { id, command, from, out, meta }
    let lastRun = null;

    close.onclick = () => d.close();
    d.onclose = () => { closed = true; d.remove(); };
    retryButton.onclick = () => { d.close(); retry(); };
    form.onsubmit = event => { event.preventDefault(); void runCommand(); };
    stopButton.onclick = () => {
      stopButton.disabled = true;
      request('/api/system/ops-run/stop', {}).catch(() => { stopButton.disabled = false; });
    };

    const envReady = () => !!(env && env.git && env.git.available && env.identity && env.identity.valid);

    // The next repair the user can actually run from here, in dependency order:
    // identity cannot be set before git exists.
    function nextSuggestion() {
      const suggestions = (env && env.suggestions) || {};
      if (!(env && env.git && env.git.available)) return suggestions.gitInstallRunnable ? suggestions.gitInstall : null;
      return env.identity && env.identity.valid ? null : suggestions.identity || null;
    }

    function chip(command, parent) {
      const button = node('button', command, 'air-ops-chip');
      button.type = 'button';
      button.title = command;
      button.onclick = () => { input.value = command; input.focus(); };
      parent.append(button);
    }

    function row(label, value, className) {
      const line = node('p');
      line.append(node('span', label, 'air-ops-k'), node('span', value, className || ''));
      envBox.append(line);
    }

    function paintEnv() {
      envBox.replaceChildren();
      advice.replaceChildren();
      if (!env) return;
      const git = env.git || {};
      const identity = env.identity || {};
      const account = env.account;
      row(t('airOpsTerminalGitLabel'), git.available ? `✓ ${git.version || ''}` : t('airOpsTerminalGitMissing'),
        git.available ? 'air-ops-status-ok' : 'air-ops-status-bad');
      if (!git.available) row(t('airOpsTerminalIdentityLabel'), t('airOpsTerminalIdentityNeedsGit'), 'air-ops-muted');
      else if (identity.valid) row(t('airOpsTerminalIdentityLabel'), `✓ ${identity.name} <${identity.email}>`, 'air-ops-status-ok');
      else if (identity.name || identity.email) row(t('airOpsTerminalIdentityLabel'), t('airOpsTerminalIdentityInvalid'), 'air-ops-status-bad');
      else row(t('airOpsTerminalIdentityLabel'), t('airOpsTerminalIdentityMissing'), 'air-ops-status-bad');
      if (account && account.user) {
        const key = account.uid === 0 ? 'airOpsTerminalAccountRoot'
          : account.sudo ? 'airOpsTerminalAccountSudo' : 'airOpsTerminalAccountPlain';
        row(t('airOpsTerminalAccountLabel'), t(key, { user: account.user }));
      }
      row(t('airOpsTerminalPackageLabel'), env.packageManager || t('airOpsTerminalPackageNone'));

      const suggestions = env.suggestions || {};
      if (!git.available && suggestions.gitInstall && !suggestions.gitInstallRunnable) {
        // Offering a one-click run here could only end in "must be root".
        const note = node('p', t('airOpsTerminalNeedsRoot', { user: (account && account.user) || '' }), 'air-ops-needs-root');
        advice.append(note, node('code', suggestions.gitInstall, 'air-ops-copy'));
      }
      const next = nextSuggestion();
      if (next) {
        const chips = node('div', null, 'air-ops-chips');
        chips.append(node('span', t('airOpsTerminalSuggestions'), 'air-ops-chips-label'));
        chip(next, chips);
        advice.append(chips);
      }
      ready.textContent = envReady() ? (retry ? t('airOpsTerminalEnvReadyRetry') : t('airOpsTerminalEnvReady')) : '';
      retryButton.hidden = !(envReady() && retry);
    }

    function prefill() {
      // Never clobber something the user typed; only an empty box or the
      // command that just succeeded is replaced by the next repair.
      if (input.value.trim() && input.value.trim() !== lastRun) return;
      input.value = nextSuggestion() || '';
    }

    async function probe() {
      try {
        env = await request('/api/system/ops-env', undefined, 'GET');
      } catch (error) {
        env = null;
        paintEnv();
        envBox.append(node('p', t('airOpsTerminalProbeFailed', { message: error.message }), 'air-ops-status-bad'));
        return;
      }
      if (!closed) paintEnv();
    }

    function remember(command) {
      const seen = history.indexOf(command);
      if (seen >= 0) history.splice(seen, 1);
      history.unshift(command);
      if (history.length > 8) history.pop();
      paintHistory();
    }

    function paintHistory() {
      historyRow.replaceChildren();
      if (!history.length) return;
      historyRow.append(node('span', t('airOpsTerminalHistoryLabel'), 'air-ops-chips-label'));
      for (const command of history) chip(command, historyRow);
    }

    function setRunning(running) {
      runButton.hidden = running;
      stopButton.hidden = !running;
      stopButton.disabled = false;
    }

    function append(text) {
      if (!text || !view) return;
      // Follow the tail only when the user has not scrolled up to read.
      const stick = output.scrollTop + output.clientHeight >= output.scrollHeight - 8;
      view.out.append(document.createTextNode(text));
      if (stick) output.scrollTop = output.scrollHeight;
    }

    function apply(job) {
      if (job.skipped) append(t('airOpsTerminalOutputSkipped', { count: job.skipped }) + '\n');
      append(job.chunk);
      view.from = job.total;
      const seconds = Math.floor(job.durationMs / 1000);
      if (job.running) view.meta.textContent = seconds ? t('airOpsTerminalRunningFor', { seconds }) : t('airOpsTerminalRunning');
    }

    function attach(job) {
      const entry = node('div', null, 'air-ops-entry');
      const out = node('span', '', 'air-ops-out');
      const meta = node('span', t('airOpsTerminalRunning'), 'air-ops-out-meta');
      entry.append(node('div', `$ ${job.command}`, 'air-ops-cmd-head'), out, meta);
      output.append(entry);
      view = { id: job.id, command: job.command, from: 0, out, meta, entry };
      setRunning(true);
      apply(job);
      output.scrollTop = output.scrollHeight;
      if (job.running) void follow(view);
      else void settle(view, job);
    }

    async function follow(mine) {
      let failures = 0;
      while (!closed && view === mine) {
        await sleep(POLL_MS);
        if (closed || view !== mine) return;
        let job;
        try {
          job = (await request(`/api/system/ops-run?from=${mine.from}`, undefined, 'GET')).job;
          failures = 0;
        } catch (error) {
          if (++failures < MAX_POLL_FAILURES) continue;
          mine.meta.textContent = t('airOpsTerminalPollFailed', { message: error.message });
          mine.entry.classList.add('air-ops-entry-bad');
          setRunning(false);
          view = null;
          return;
        }
        if (!job || job.id !== mine.id) { await settle(mine, null); return; }
        apply(job);
        if (!job.running) { await settle(mine, job); return; }
      }
    }

    async function settle(mine, job) {
      if (view === mine) view = null;
      setRunning(false);
      const parts = [];
      if (job && job.stopped) parts.push(t('airOpsTerminalStopped'));
      else if (job && job.timedOut) parts.push(t('airOpsTerminalTimedOut'));
      if (job) {
        parts.push(t('airOpsTerminalExitCode', { code: job.exitCode == null ? '—' : String(job.exitCode) }));
        parts.push(`${(job.durationMs / 1000).toFixed(1)}s`);
      }
      mine.meta.textContent = parts.join(' · ');
      const failed = !job || job.exitCode !== 0 || job.timedOut || job.stopped;
      if (failed) mine.entry.classList.add('air-ops-entry-bad');
      remember(mine.command);
      if (closed) return;
      await probe();
      // A failed command stays in the box to be edited; a successful one
      // makes way for the next repair.
      if (!failed) { lastRun = mine.command; prefill(); }
      input.focus();
    }

    async function runCommand() {
      const command = input.value.trim();
      if (!command || view) return;
      runButton.disabled = true;
      try {
        const result = await request('/api/system/ops-run', { command });
        if (!closed) attach(result.job);
      } catch (error) {
        // Another tab (or this panel before it was closed) is mid-run: show
        // that job instead of an error, since it is what the host is doing.
        if (error.code === 'OPS_BUSY' && error.job && !closed) attach(error.job);
        else if (!closed) {
          const entry = node('div', null, 'air-ops-entry air-ops-entry-bad');
          entry.append(node('div', `$ ${command}`, 'air-ops-cmd-head'), node('span', error.message, 'air-ops-out-meta'));
          output.append(entry);
          output.scrollTop = output.scrollHeight;
        }
      } finally {
        runButton.disabled = false;
      }
    }

    paintHistory();
    input.focus();
    void (async () => {
      const [, running] = await Promise.all([
        probe(),
        request('/api/system/ops-run', undefined, 'GET').then(r => r.job).catch(() => null),
      ]);
      if (closed) return;
      if (running && running.running && !view) attach(running);
      else prefill();
    })();
  }

  window.MultiCCAirOps = { open };
})();
