/* 新任务输入框上的「电脑」胶囊：配置了多电脑时才出现。它决定新任务创建在哪台
   电脑 —— 选中远程电脑后，创建链路的每个请求都走那台电脑的代理，目录列表也换成
   目标电脑自己的目录；创建成功后直接跳进那台电脑的控制台看这条新任务。 */
(function (root) {
  'use strict';
  let api = null, notice = () => {}, pill = null, pop = null, select = null;
  let localEntries = () => [], localDirectoryId = () => null, dialogOpen = () => false;
  let selfName = '', machines = [], selected = null;
  let directories = [], directoryId = null, dialogDirectoryId = null;
  const t = (key, params) => {
    const text = typeof root.t === 'function' ? root.t(key, params) : '';
    if (!text || text === key) return key;
    return params ? String(text).replace(/\{(\w+)\}/g, (match, name) => params[name] != null ? String(params[name]) : match) : text;
  };
  function render() {
    if (!pill) return;
    if (!machines.length) { selected = null; directories = []; directoryId = null; }
    pill.hidden = !machines.length;
    pill.textContent = t('airQuickMachine', { name: selected ? selected.name : t('airQuickMachineSelf') });
    pill.title = selected ? t('airQuickMachineRemoteTitle', { name: selected.name }) : t('airQuickMachineTitle');
    pill.setAttribute('aria-haspopup', 'menu');
  }
  async function refreshMachines() {
    try {
      const data = await api('/api/machines');
      selfName = data.self?.name || '';
      machines = data.machines || [];
    } catch (_) { machines = []; }
    if (selected && !machines.some(machine => machine.id === selected.id)) {
      selected = null; directories = []; directoryId = null;
    }
    render();
    return machines;
  }
  async function loadDirectories() {
    if (!selected) { directories = []; directoryId = null; return directories; }
    const cached = root.MultiCCAirMachines?.snapshot?.(selected.id);
    if (cached) directories = cached.directories || [];
    else {
      const snap = await api(`/api/machines/${encodeURIComponent(selected.id)}/proxy/api/air`);
      directories = snap.directories || [];
      root.MultiCCAirMachines?.remember?.(selected.id, directories);
    }
    if (!directories.some(entry => entry.id === directoryId)) directoryId = directories[0]?.id || null;
    return directories;
  }
  function entries() {
    return selected ? directories : localEntries();
  }
  function syncDialog() {
    if (!select) return null;
    const list = entries();
    select.replaceChildren(...list.map(entry => {
      const option = document.createElement('option');
      option.textContent = [entry.name, entry.path].filter(Boolean).join(' · ');
      option.value = entry.id;
      return option;
    }));
    const local = localEntries();
    const preferred = selected
      ? directoryId
      : (local.some(entry => entry.id === localDirectoryId()) ? localDirectoryId() : local[0]?.id || null);
    dialogDirectoryId = list.some(entry => entry.id === preferred) ? preferred : list[0]?.id || null;
    select.value = dialogDirectoryId || '';
    return dialogDirectoryId;
  }
  function targetDirectoryId() {
    if (selected) {
      const id = dialogOpen() ? dialogDirectoryId : directoryId;
      return directories.some(entry => entry.id === id) ? id : directories[0]?.id || null;
    }
    if (!dialogOpen()) return localDirectoryId();
    return localEntries().some(entry => entry.id === dialogDirectoryId) ? dialogDirectoryId : localDirectoryId();
  }
  function closePop() {
    if (!pop) return;
    pop.remove(); pop = null;
    document.removeEventListener('mousedown', onOutside, true);
    root.removeEventListener('resize', closePop);
  }
  function onOutside(event) {
    if (pop && !pop.contains(event.target) && event.target !== pill) closePop();
  }
  function openPop() {
    closePop();
    pop = document.createElement('div');
    pop.className = 'quick-machine-pop'; pop.setAttribute('role', 'menu');
    const entries = [{ machine: null, name: selfName ? `${t('airQuickMachineSelf')} · ${selfName}` : t('airQuickMachineSelf') },
      ...machines.map(machine => ({ machine, name: machine.name }))];
    for (const entry of entries) {
      const row = document.createElement('button');
      row.type = 'button'; row.setAttribute('role', 'menuitemradio');
      const current = (entry.machine?.id || null) === (selected?.id || null);
      row.setAttribute('aria-checked', String(current));
      const label = document.createElement('span'); label.textContent = entry.name;
      row.append(label);
      if (entry.machine) { const origin = document.createElement('small'); origin.textContent = entry.machine.origin; row.append(origin); }
      row.onclick = async () => {
        selected = entry.machine; closePop(); render();
        try { await loadDirectories(); }
        catch (error) { notice(error.message); }
        if (dialogOpen()) syncDialog();
        root.dispatchEvent(new CustomEvent('air:quick-machine-changed'));
      };
      pop.append(row);
    }
    document.body.append(pop);
    const rect = pill.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(rect.left, root.innerWidth - 280))}px`;
    pop.style.top = `${rect.bottom + 6}px`;
    document.addEventListener('mousedown', onOutside, true);
    root.addEventListener('resize', closePop);
  }
  root.MultiCCAirQuickMachine = {
    init(options) {
      api = options.api; notice = options.notice || notice; pill = options.pill || null;
      select = options.select || null;
      localEntries = options.localEntries || localEntries;
      localDirectoryId = options.localDirectoryId || localDirectoryId;
      dialogOpen = options.dialogOpen || dialogOpen;
      if (select) select.onchange = () => {
        dialogDirectoryId = select.value;
        if (selected) directoryId = select.value;
      };
      if (pill) pill.onclick = () => { void refreshMachines().then(openPop); };
      void refreshMachines();
    },
    selected: () => selected,
    directories: () => directories,
    directoryId: () => directoryId,
    setDirectoryId: id => { directoryId = id; },
    syncDialog,
    targetDirectoryId,
    resetDialog: () => { dialogDirectoryId = null; },
    request: (path, body, method) => selected
      ? api(`/api/machines/${encodeURIComponent(selected.id)}/proxy${path}`, body, method)
      : api(path, body, method),
    taskUrl: (dirId, taskId) => selected ? `/air?${new URLSearchParams({
      machine: selected.id, machineName: selected.name, machineOrigin: selected.origin,
      view: 'tasks', dir: dirId, task: taskId,
    })}` : null,
    refresh: refreshMachines,
  };
})(window);
