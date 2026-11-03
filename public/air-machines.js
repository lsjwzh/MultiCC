(function (root) {
  'use strict';
  let selected = 'self';
  const cache = new WeakMap();
  // Directory snapshot per computer. A tab click renders the last known
  // directories immediately and refreshes behind them, so switching computers
  // no longer waits for remote round trips before showing anything.
  const snapshots = new Map();
  const warming = new Set();
  const FRESH_MS = 60000;
  const tr = (key, params) => root.t(key, params);
  function node(tag, text, cls) { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; }
  function button(text, click) { const b = node('button', text); b.type = 'button'; b.onclick = click; return b; }
  function mount(host, context) {
    if (root.MultiCCMachineScope) return;
    if (cache.has(host)) return;
    cache.set(host, true);
    const panel = node('section', null, 'machine-panel'); host.append(panel);
    let machine, generation = 0, view = 'directories', machines = [], self, gridHost = null;
    const api = context.api;
    const status = node('div', tr('airMachinesLoading'), 'machine-note');
    const tabs = node('div', null, 'machine-tabs'); tabs.setAttribute('role', 'tablist');
    const body = node('div');
    const toolbar = node('div', null, 'machine-toolbar');
    toolbar.append(button(tr('airMachinesAdd'), () => connect()), button(tr('refresh'), () => load(true)), button(tr('airMachinesGrants'), grants));
    panel.append(toolbar, tabs, status, body);
    function path(suffix) { return machine.local ? suffix : `/api/machines/${machine.id}/proxy${suffix}`; }
    function frame(mode, dir) {
      if (machine.local) { if (dir) context.navigate(dir); else context.setMode('settings'); return; }
      body.replaceChildren();
      const back = button(tr('airMachinesBackDirectories'), () => { view = 'directories'; show(); });
      const target = node('strong', `${tr('airMachinesTargetPrefix')}${machine.name}`);
      const hint = node('p', `${tr('airMachinesSavedPrefix')}${machine.name}`, 'machine-note');
      const iframe = node('iframe', null, 'machine-frame');
      iframe.title = `${machine.name} · ${mode === 'settings' ? tr('airMachinesSettings') : tr('airMachinesDirectory')}`;
      const query = new URLSearchParams({ machine: machine.id, machineName: machine.name, machineOrigin: machine.origin, view: mode }); if (dir) query.set('dir', dir);
      iframe.src = `/air?${query}`;
      body.append(back, target, hint, iframe);
    }
    function renderGrid(directories) {
      if (!gridHost) return;
      gridHost.replaceChildren();
      // 卡片与「按目录」首页同一种（article.directory-card 包 button），网格直接吃
      // console-directory-grid 那套稿件样式（air-navigation.css），不在这里另起一份，
      // 否则卡片宽度随内容长短漂移（之前就是裸 .directory-grid 没有网格样式）。
      const grid = node('div', null, 'directory-grid console-directory-grid');
      for (const directory of directories) {
        const btn = button('', () => frame('tasks', directory.id)); btn.className = 'machine-directory';
        btn.append(node('strong', directory.name), node('small', directory.path, 'machine-note'));
        const card = node('article', null, 'directory-card'); card.append(btn); grid.append(card);
      }
      if (!grid.children.length) grid.append(node('p', tr('airMachinesNoDirectories')));
      gridHost.append(grid, button(tr('airMachinesManageDirectories'), () => frame('directories')));
    }
    async function show() {
      const current = ++generation;
      body.replaceChildren(); status.textContent = `${machine.name} · ${tr('airMachinesConnecting')}`;
      const heading = node('div', null, 'machine-heading');
      heading.append(node('strong', machine.name));
      const actions = node('div', null, 'machine-actions');
      actions.append(button(tr('airMachinesDirectories'), () => { view = 'directories'; show(); }), button(tr('airMachinesSettings'), () => { view = 'settings'; show(); }));
      if (!machine.local) actions.append(button(tr('airMachinesReconnect'), () => connect(machine)), button(tr('airMachinesRemove'), async () => {
        if (!root.confirm(`${tr('airMachinesRemoveConfirm')} ${machine.name}`)) return;
        try { const result = await api(`/api/machines/${machine.id}`, undefined, 'DELETE'); selected = 'self'; await load(); if (!result.remoteRevoked) context.notice(tr('airMachinesRemoveOffline')); } catch (e) { status.textContent = e.message; }
      }));
      heading.append(actions);
      gridHost = node('div');
      body.append(heading, gridHost);
      const cached = view === 'directories' ? snapshots.get(machine.id) : null;
      if (cached) {
        status.textContent = `${machine.name} · ${tr('airMachinesConnected')}`;
        renderGrid(cached.directories);
        void refresh(current);
        return;
      }
      await refresh(current);
    }
    async function refresh(current) {
      try {
        if (view === 'settings') {
          await api(path('/api/machines/self'));
          if (current !== generation || !host.isConnected) return;
          status.textContent = `${machine.name} · ${tr('airMachinesConnected')}`;
          frame('settings');
          return;
        }
        // Probe and snapshot in parallel: the probe used to gate the snapshot
        // fetch, so nothing appeared until both round trips finished in series.
        const [probe, snap] = await Promise.allSettled([api(path('/api/machines/self')), api(path('/api/air'))]);
        if (current !== generation || !host.isConnected) return;
        if (snap.status === 'fulfilled') {
          const directories = snap.value.directories || [];
          snapshots.set(machine.id, { directories, at: Date.now() });
          status.textContent = `${machine.name} · ${tr('airMachinesConnected')}`;
          renderGrid(directories);
          return;
        }
        throw probe.status === 'rejected' ? probe.reason : snap.reason;
      } catch (e) {
        if (current !== generation) return;
        status.textContent = `${machine.name} · ${tr('airMachinesUnavailable')}`;
        // A stale grid stays useful while the computer is unreachable: the
        // warning rides below it instead of replacing the directories.
        if (!gridHost.children.length) {
          const error = node('div', e.message, 'machine-warning');
          error.append(button(tr('retry'), show)); gridHost.append(error);
          return;
        }
        gridHost.append(node('div', e.message, 'machine-warning'));
      }
    }
    async function load(force) {
      try {
        const data = await api('/api/machines'); self = data.self; machines = [self, ...data.machines];
        if (force) snapshots.clear();
        if (!machines.some(m => m.id === selected)) selected = self.id;
        tabs.replaceChildren();
        for (const item of machines) {
          const b = button(`${item.name}${item.local ? tr('airMachinesEntrySuffix') : ''}`, () => { selected = item.id; machine = item; view = 'directories'; for (const n of tabs.children) n.setAttribute('aria-selected', String(n === b)); show(); });
          b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(selected === item.id)); tabs.append(b);
        }
        machine = machines.find(m => m.id === selected); await show();
        warm();
      } catch (e) { status.textContent = e.message; }
    }
    // Fill snapshots (and, through the Rust proxy, its pooled TLS connections)
    // for every remote computer in the background, so the first click on a tab
    // renders from cache instead of paying the round trips cold.
    function warm() {
      void (async () => {
        for (const item of machines) {
          if (item.local || warming.has(item.id)) continue;
          const cached = snapshots.get(item.id);
          if (cached && Date.now() - cached.at < FRESH_MS) continue;
          warming.add(item.id);
          try {
            const snap = await api(`/api/machines/${item.id}/proxy/api/air`);
            snapshots.set(item.id, { directories: snap.directories || [], at: Date.now() });
          } catch (_) { /* the click path reports the real error */ }
          finally { warming.delete(item.id); }
        }
      })();
    }
    function connect(existing) {
      ++generation; body.replaceChildren();
      const form = node('form', null, 'machine-form');
      form.append(node('h3', tr(existing ? 'airMachinesReconnectTitle' : 'airMachinesAdd')));
      const inputs = {};
      for (const [key, label, type, value] of [['name', tr('airMachinesName'), 'text', existing?.name || ''], ['origin', tr('airMachinesOrigin'), 'url', existing?.origin || ''], ['password', tr('airMachinesPassword'), 'password', '']]) {
        const row = node('label', label), input = node('input'); input.type = type; input.required = true; input.value = value; input.autocomplete = key === 'password' ? 'off' : 'on'; inputs[key] = input; row.append(input); form.append(row);
      }
      form.append(node('p', tr('airMachinesPairHint'), 'machine-note'), node('p', tr('airMachinesInsecureHint'), 'machine-note'));
      const error = node('p', '', 'machine-warning'); error.hidden = true;
      const save = node('button', tr('airMachinesVerify')); save.type = 'submit';
      form.append(error, save, button(tr('cancel'), show)); body.append(form);
      form.onsubmit = async event => {
        event.preventDefault(); save.disabled = true;
        const payload = { ...Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, n.value])), ...(existing ? { expectedId: existing.id } : {}) }; inputs.password.value = '';
        try { const result = await api('/api/machines', payload, 'POST'); selected = result.id; snapshots.delete(result.id); await load(); }
        catch (e) { error.hidden = false; error.textContent = e.message; }
        finally { payload.password = ''; save.disabled = false; }
      };
    }
    async function grants() {
      const current = ++generation;
      body.replaceChildren(node('h3', tr('airMachinesEntryGrants')));
      try {
        const data = await api('/api/machines/grants');
        if (current !== generation) return;
        for (const grant of data.grants) {
          const row = node('div'); row.append(node('span', grant.name), button(tr('airMachinesRevoke'), async () => {
            if (!root.confirm(`${tr('airMachinesRevokeConfirm')} ${grant.name}`)) return;
            try { await api(`/api/machines/grants/${grant.id}`, undefined, 'DELETE'); grants(); } catch (e) { status.textContent = e.message; }
          })); body.append(row);
        }
        if (!data.grants.length) body.append(node('p', tr('airMachinesNoGrants')));
        body.append(button(tr('airMachinesBack'), show));
      } catch (e) { status.textContent = e.message; }
    }
    load();
  }
  root.MultiCCAirMachines = {
    mount,
    snapshot: id => snapshots.get(id) || null,
    remember: (id, directories) => { snapshots.set(id, { directories, at: Date.now() }); },
  };
})(window);
