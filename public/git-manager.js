/* Git history browser shared by the Air directory card. Repository text is
 * always inserted with textContent; file patches are fetched only on demand. */
(() => {
  'use strict';

  function element(tag, text, className) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text != null) result.textContent = text;
    return result;
  }

  function open({ dirId, api, t }) {
    if (!dirId || document.querySelector('.git-manager')) return;
    const dialog = element('dialog', null, 'git-manager');
    dialog.setAttribute('aria-label', t('gitLogTitle'));
    dialog.dataset.step = 'commits';
    const shell = element('div', null, 'git-manager-shell');
    const header = element('header', null, 'git-manager-header');
    const back = element('button', '‹', 'git-manager-back');
    back.type = 'button';
    back.setAttribute('aria-label', t('gitManagerBack'));
    const title = element('strong', t('gitLogTitle'));
    const refresh = element('button', '↻', 'git-manager-refresh');
    refresh.type = 'button';
    refresh.setAttribute('aria-label', t('retry'));
    const close = element('button', '×', 'git-manager-close');
    close.type = 'button';
    close.setAttribute('aria-label', t('close'));
    header.append(back, title, refresh, close);
    const toolbar = element('div', null, 'git-manager-toolbar');
    const search = element('input', null, 'git-manager-search');
    search.type = 'search';
    search.placeholder = t('gitManagerSearch');
    search.setAttribute('aria-label', t('gitManagerSearch'));
    const allLabel = element('label', null, 'git-manager-all');
    const all = element('input');
    all.type = 'checkbox';
    allLabel.append(all, element('span', t('gitLogAllBranches')));
    toolbar.append(search, allLabel);
    const columns = element('div', null, 'git-manager-columns');
    const commitsPane = element('section', null, 'git-manager-pane git-manager-commits');
    const filesPane = element('section', null, 'git-manager-pane git-manager-files');
    const diffPane = element('section', null, 'git-manager-pane git-manager-diff');
    columns.append(commitsPane, filesPane, diffPane);
    shell.append(header, toolbar, columns);
    dialog.append(shell);
    document.body.append(dialog);

    const state = { commits: [], commit: null, files: [], file: null,
      fileCache: new Map(), diffCache: new Map(), serial: 0 };
    const url = (route, extra = '') => `/api/git/${route}?dirId=${encodeURIComponent(dirId)}${extra}`;
    const message = (pane, label, error = false) => pane.replaceChildren(element('p', label,
      `git-manager-message${error ? ' error' : ''}`));
    const setStep = step => { dialog.dataset.step = step; };

    function paintCommits() {
      const query = search.value.trim().toLocaleLowerCase();
      const commits = state.commits.filter(item =>
        `${item.short} ${item.subject} ${item.author} ${item.refs}`.toLocaleLowerCase().includes(query));
      if (!commits.length) { message(commitsPane, t('gitLogEmpty')); return; }
      commitsPane.replaceChildren(...commits.map(commit => {
        const row = element('button', null, 'git-manager-row');
        row.type = 'button';
        row.classList.toggle('selected', commit.hash === state.commit?.hash);
        row.append(element('code', commit.short || commit.hash.slice(0, 7)),
          element('strong', commit.subject || t('airGitNoSubject')),
          element('small', `${commit.author || '—'} · ${(commit.date || '').replace('T', ' ').slice(0, 16)}`));
        if (commit.refs) row.append(element('span', commit.refs, 'git-manager-refs'));
        row.onclick = () => void selectCommit(commit);
        return row;
      }));
    }

    function paintFiles() {
      if (!state.commit) { message(filesPane, t('gitManagerSelectCommit')); return; }
      if (!state.files.length) { message(filesPane, t('gitManagerNoFiles')); return; }
      filesPane.replaceChildren(element('h3', `${state.commit.short} · ${state.files.length} ${t('gitManagerFiles')}`),
        ...state.files.map(file => {
          const row = element('button', null, 'git-manager-row git-manager-file');
          row.type = 'button';
          row.classList.toggle('selected', file.path === state.file?.path);
          row.append(element('span', file.status, 'git-manager-file-status'), element('span', file.path));
          if (file.oldPath) row.append(element('small', `← ${file.oldPath}`));
          row.onclick = () => void selectFile(file);
          return row;
        }));
    }

    async function loadLog() {
      const serial = ++state.serial;
      state.commit = null; state.file = null; state.files = [];
      state.fileCache.clear(); state.diffCache.clear();
      setStep('commits');
      message(commitsPane, t('airGitReadingLog'));
      message(filesPane, t('gitManagerSelectCommit'));
      message(diffPane, t('gitManagerSelectFile'));
      try {
        const result = await api(url('log', `&limit=100${all.checked ? '&all=1' : ''}`));
        if (serial !== state.serial || !dialog.isConnected) return;
        state.commits = result.commits || [];
        paintCommits();
      } catch (error) {
        if (serial === state.serial && dialog.isConnected) message(commitsPane,
          t('airGitLogFailed', { msg: error.message }), true);
      }
    }

    async function selectCommit(commit) {
      const serial = ++state.serial;
      state.commit = commit; state.file = null;
      state.files = state.fileCache.get(commit.hash) || [];
      paintCommits();
      setStep('files');
      message(diffPane, t('gitManagerSelectFile'));
      if (state.fileCache.has(commit.hash)) { paintFiles(); return; }
      message(filesPane, t('gitManagerLoadingFiles'));
      try {
        const result = await api(url('commit-files', `&hash=${encodeURIComponent(commit.hash)}`));
        if (serial !== state.serial || !dialog.isConnected) return;
        state.files = result.files || [];
        state.fileCache.set(commit.hash, state.files);
        paintFiles();
      } catch (error) {
        if (serial === state.serial && dialog.isConnected) message(filesPane,
          t('gitManagerFilesFailed', { msg: error.message }), true);
      }
    }

    async function selectFile(file) {
      const commit = state.commit;
      const serial = ++state.serial;
      state.file = file;
      paintFiles();
      setStep('diff');
      const key = `${commit.hash}\0${file.path}`;
      let result = state.diffCache.get(key);
      if (!result) {
        message(diffPane, t('airGitDiffReading'));
        try {
          result = await api(url('commit-diff',
            `&hash=${encodeURIComponent(commit.hash)}&file=${encodeURIComponent(file.path)}`));
          state.diffCache.set(key, result);
        } catch (error) {
          if (serial === state.serial && dialog.isConnected) message(diffPane,
            t('airGitDiffFailed', { msg: error.message }), true);
          return;
        }
      }
      if (serial !== state.serial || !dialog.isConnected) return;
      const patch = element('pre', result.error
        ? t('airGitDiffFailed', { msg: result.error })
        : (result.diff || t('airGitNoDiff')), 'git-manager-patch');
      diffPane.replaceChildren(element('h3', file.path),
        ...(result.truncated ? [element('p', t('airGitDiffTruncated'), 'git-manager-warning')] : []), patch);
    }

    back.onclick = () => setStep(dialog.dataset.step === 'diff' ? 'files' : 'commits');
    close.onclick = () => dialog.close();
    refresh.onclick = () => void loadLog();
    all.onchange = () => void loadLog();
    search.oninput = paintCommits;
    dialog.onclose = () => { state.serial++; dialog.remove(); };
    dialog.showModal();
    void loadLog();
  }

  window.MultiCCGitManager = Object.freeze({ open });
})();
