(function () {
  'use strict';

  // Ops terminal: a repair shell for hosts that cannot create their first
  // directory — no git on a bare VPS, no commit identity on a fresh service
  // account. Such a host has no session terminal yet, so the directory dialog
  // opens this panel with the repair pre-filled (FIX_ACTIONS in
  // air-task-settings.js maps the server's fix code to a preset here).
  // Commands run through POST /api/system/ops-run with the authority of the
  // MultiCC process itself; privileged repairs still need the service account
  // to have those rights.

  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

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
      throw new Error(result.message || result.error || result.code
        || t('airOpsTerminalBadResponse', { status: response.status }));
    }
    return result;
  }

  // Survives closing the panel: a repair is usually 2–3 commands and the user
  // should not have to retype them after peeking at the directory dialog.
  const history = [];

  function open(preset) {
    const d = node('dialog');
    const form = node('form');
    form.append(node('h2', t('airOpsTerminalTitle')));
    form.append(node('p', t('airOpsTerminalHint')));

    const envBox = node('div', '', 'air-ops-env');
    const chips = node('div', null, 'air-ops-chips');
    const cmdline = node('div', null, 'air-ops-cmdline');
    const input = node('input', null, 'air-ops-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = t('airOpsTerminalCommandPlaceholder');
    const runButton = node('button', t('airOpsTerminalRun'), 'primary');
    runButton.type = 'button';
    cmdline.append(input, runButton);

    const output = node('pre', '', 'air-ops-output');
    output.setAttribute('aria-live', 'polite');
    const historyRow = node('div', '', 'air-ops-history');
    const ready = node('p', '', 'air-ops-ready');
    const close = node('button', t('airOpsTerminalClose'));
    close.type = 'button';
    close.onclick = () => d.close();

    form.append(envBox, chips, cmdline, output, historyRow, ready, close);
    form.onsubmit = event => { event.preventDefault(); void runCommand(); };
    d.onclose = () => d.remove();
    d.append(form);
    document.body.append(d);
    d.showModal();

    let env = null;
    let running = false;

    function suggestionChips() {
      const suggestions = (env && env.suggestions) || {};
      const wantInstall = !(env && env.git && env.git.available);
      const wantName = !(env && env.identity && env.identity.name);
      const wantEmail = !(env && env.identity && env.identity.email);
      return [
        wantInstall ? suggestions.gitInstall : null,
        wantName ? suggestions.identityName : null,
        wantEmail ? suggestions.identityEmail : null,
      ].filter(Boolean);
    }

    function paintEnv() {
      if (!env) return;
      envBox.replaceChildren();
      const gitOk = !!(env.git && env.git.available);
      const gitLine = node('p');
      gitLine.append(
        node('span', t('airOpsTerminalGitLabel'), 'air-ops-k'),
        gitOk
          ? node('span', `✓ ${env.git.version || ''}`, 'air-ops-status-ok')
          : node('span', t('airOpsTerminalGitMissing'), 'air-ops-status-bad'),
      );
      const idOk = !!(env.identity && env.identity.name && env.identity.email);
      const idLine = node('p');
      idLine.append(
        node('span', t('airOpsTerminalIdentityLabel'), 'air-ops-k'),
        idOk
          ? node('span', `✓ ${env.identity.name} <${env.identity.email}>`, 'air-ops-status-ok')
          : node('span', t('airOpsTerminalIdentityMissing'), 'air-ops-status-bad'),
      );
      const pmLine = node('p');
      pmLine.append(
        node('span', t('airOpsTerminalPackageLabel'), 'air-ops-k'),
        node('span', env.packageManager || t('airOpsTerminalPackageNone')),
      );
      envBox.append(gitLine, idLine, pmLine);

      chips.replaceChildren();
      const list = suggestionChips();
      if (list.length) chips.append(node('span', t('airOpsTerminalSuggestions'), 'air-ops-chips-label'));
      for (const command of list) {
        const chip = node('button', command, 'air-ops-chip');
        chip.type = 'button';
        chip.title = command;
        chip.onclick = () => { input.value = command; input.focus(); };
        chips.append(chip);
      }

      ready.textContent = gitOk && idOk ? t('airOpsTerminalEnvReady') : '';
    }

    async function probe() {
      try {
        env = await request('/api/system/ops-env', undefined, 'GET');
      } catch (error) {
        env = null;
        envBox.replaceChildren(node('p', t('airOpsTerminalProbeFailed', { message: error.message }), 'air-ops-status-bad'));
        return;
      }
      paintEnv();
      // One-shot pre-fill from the failure that opened the panel: the dialog
      // already named the problem, so the first command should be its remedy.
      if (preset && !input.value) {
        const suggestions = env.suggestions || {};
        if (preset === 'git-missing' && suggestions.gitInstall) input.value = suggestions.gitInstall;
        if (preset === 'git-identity' && suggestions.identityName) input.value = suggestions.identityName;
        preset = null;
      }
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
      for (const command of history) {
        const chip = node('button', command, 'air-ops-chip');
        chip.type = 'button';
        chip.title = command;
        chip.onclick = () => { input.value = command; input.focus(); };
        historyRow.append(chip);
      }
    }

    async function runCommand() {
      const command = input.value.trim();
      if (!command || running) return;
      running = true;
      runButton.disabled = true;
      const head = node('div', `$ ${command}`, 'air-ops-cmd-head');
      const body = node('div', t('airOpsTerminalRunning'), 'air-ops-cmd-body');
      output.append(head, body);
      output.scrollTop = output.scrollHeight;
      try {
        const result = await request('/api/system/ops-run', { command });
        body.replaceChildren();
        if (result.stdout) body.append(node('span', result.stdout, 'air-ops-out-out'));
        if (result.stderr) body.append(node('span', result.stderr, 'air-ops-out-err'));
        const meta = [];
        if (result.timedOut) meta.push(t('airOpsTerminalTimedOut'));
        meta.push(t('airOpsTerminalExitCode', { code: result.exitCode == null ? '—' : String(result.exitCode) }));
        meta.push(`${result.durationMs}ms`);
        body.append(node('span', meta.join(' · '), 'air-ops-out-meta'));
        if (result.timedOut || result.exitCode !== 0) body.classList.add('air-ops-cmd-bad');
        remember(command);
        await probe();
      } catch (error) {
        body.replaceChildren(node('span', error.message, 'air-ops-out-err'));
        body.classList.add('air-ops-cmd-bad');
      } finally {
        running = false;
        runButton.disabled = false;
      }
      output.scrollTop = output.scrollHeight;
    }

    runButton.onclick = () => { void runCommand(); };
    paintHistory();
    void probe();
    input.focus();
  }

  window.MultiCCAirOps = { open };
})();
