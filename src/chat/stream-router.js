'use strict';

// All session lifecycle callers use this facade, so resident children of every
// protocol participate in cancellation, hibernation, deletion, pruning and
// shutdown like CLI streams. Which backend owns a session is a property of the
// protocol that session speaks (`streamBackend`, set by the adapter), not of the
// CLI name, so a lane can move without any lifecycle caller learning about it.
function createStreamRouter(legacy, sdk, appServer) {
  const modes = new Map();
  const barriers = new Map();
  // When a turn was last admitted on each child. This is the only usage signal
  // every backend can supply without each of them growing its own clock; the
  // residency pool reads it back through residents().
  const used = new Map();
  const pending = new Map();
  const residency = require('./workspace-residency').createWorkspaceResidency({
    status: name => backend(name).status(name),
    closeAndWait: name => api.closeAndWait(name), pending: name => (pending.get(name) || 0)
      + Number(!!barriers.get(name)?.promise || !!barriers.get(name)?.selected.isClosing?.(name)),
  });
  const backend = name => {
    const mode = modes.get(name);
    if (mode === 'sdk') return sdk;
    if (mode === 'app-server') return appServer;
    return legacy;
  };
  // Retain the backend after a deadline expires, not a permanently rejected
  // promise. The backend retains the actual child and can join it again.
  function join(name, opts) {
    const entry = barriers.get(name);
    if (!entry) return Promise.resolve({ closed: true, hadProcess: false });
    if (entry.promise) return entry.promise;
    let stopped;
    try {
      stopped = entry.joinOnly && entry.selected.waitForClose
        ? entry.selected.waitForClose(name, opts) : entry.selected.closeAndWait(name, opts);
      // closeAndWait synchronously retires the session entry before waiting.
      // A later ensure may register a replacement under this name: retries
      // must only join the captured exit, never close that replacement.
      if (entry.selected.isClosing?.(name) || !entry.selected.status?.(name)) entry.joinOnly = true;
    }
    catch (error) { stopped = Promise.reject(error); }
    entry.promise = Promise.resolve(stopped).then(result => {
      if (result?.closed !== true) throw Object.assign(new Error('process exit unconfirmed'), { code: 'workspace_busy' });
      if (barriers.get(name) === entry) barriers.delete(name);
      if (entry.dispose && backend(name) === entry.selected && !entry.selected.status(name)) {
        modes.delete(name); used.delete(name); residency.forget(name);
      }
      return result;
    }).catch(error => { entry.promise = null; throw error; });
    entry.promise.catch(() => {});
    return entry.promise;
  }
  function closeBackend(name, selected, opts, dispose) {
    const previous = barriers.get(name);
    if (previous) {
      if (previous.selected === selected) { previous.dispose ||= dispose; return join(name, opts); }
      return join(name, opts).then(() => closeBackend(name, selected, opts, dispose));
    }
    barriers.set(name, { selected, dispose, promise: null });
    return join(name, opts);
  }
  const api = {
    ensure(name, cfg) {
      residency.track(name, cfg.cwd);
      const mode = cfg.streamBackend === 'app-server' || cfg.streamBackend === 'zcode-app-server' ? 'app-server'
        : cfg.sdkOptions ? 'sdk' : 'legacy';
      if (modes.has(name) && modes.get(name) !== mode) {
        if (barriers.has(name)) throw Object.assign(new Error('workspace_busy'), { code: 'workspace_busy' });
        closeBackend(name, backend(name), undefined, false).catch(() => {});
      }
      modes.set(name, mode);
      used.set(name, Date.now());
      return backend(name).ensure(name, cfg);
    },
    async send(name, ...args) {
      residency.assertSend(name);
      pending.set(name, (pending.get(name) || 0) + 1);
      try {
        if (barriers.has(name)) await join(name);
        residency.assertSend(name);
        used.set(name, Date.now());
        return await backend(name).send(name, ...args);
      } finally {
        const count = (pending.get(name) || 1) - 1;
        if (count) pending.set(name, count); else pending.delete(name);
      }
    },
    close(name) {
      return closeBackend(name, backend(name), undefined, true);
    },
    closeAndWait(name, opts) {
      return closeBackend(name, backend(name), opts, true);
    },
    parkWorkspace: (name, workspace) => residency.park(name, workspace),
    claimWorkspace: async (name, workspace, opts) => {
      await join(name);
      return residency.claim(name, workspace, opts);
    },
    // Every warm resident child this host currently holds — the pool's input.
    // Each entry is a child the backend still reports, so a name whose child was
    // reaped (or closed by a lifecycle caller) drops out here by itself instead
    // of being tracked, and the router forgets it. `busy`/`queued` are the
    // child's own claim on itself: an entry with either set is a claimed lease.
    residents() {
      const warm = [];
      for (const [name, mode] of [...modes]) {
        const status = backend(name)?.status?.(name);
        if (!status) { if (!barriers.has(name)) { modes.delete(name); used.delete(name); } continue; }
        if (!status.alive) continue;
        warm.push(Object.freeze({
          name, mode,
          busy: !!status.busy, queued: status.queued || 0,
          lastUsedAt: used.get(name) || 0,
        }));
      }
      return warm;
    },
  };
  for (const method of ['cancel', 'status', 'isAlive', 'recycle']) api[method] = (name, ...args) => backend(name)[method](name, ...args);
  api.inject = api.send;
  return api;
}

module.exports = { createStreamRouter };
