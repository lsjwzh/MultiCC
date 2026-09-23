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
    closeAndWait: name => api.closeAndWait(name), pending: name => (pending.get(name) || 0) + Number(barriers.has(name)),
  });
  const backend = name => {
    const mode = modes.get(name);
    if (mode === 'sdk') return sdk;
    if (mode === 'app-server') return appServer;
    return legacy;
  };
  const api = {
    ensure(name, cfg) {
      residency.track(name, cfg.cwd);
      const mode = cfg.streamBackend === 'app-server' ? 'app-server'
        : cfg.sdkOptions ? 'sdk' : 'legacy';
      if (modes.has(name) && modes.get(name) !== mode) {
        const barrier = backend(name).closeAndWait(name);
        barrier.catch(() => {});
        barriers.set(name, barrier);
      }
      modes.set(name, mode);
      used.set(name, Date.now());
      return backend(name).ensure(name, cfg);
    },
    async send(name, ...args) {
      residency.assertSend(name);
      pending.set(name, (pending.get(name) || 0) + 1);
      try {
        const barrier = barriers.get(name);
        if (barrier) { await barrier; if (barriers.get(name) === barrier) barriers.delete(name); }
        residency.assertSend(name);
        used.set(name, Date.now());
        return await backend(name).send(name, ...args);
      } finally {
        const count = (pending.get(name) || 1) - 1;
        if (count) pending.set(name, count); else pending.delete(name);
      }
    },
    close(name) {
      const selected = backend(name);
      used.delete(name);
      const barrier = Promise.resolve(selected.closeAndWait(name));
      barriers.set(name, barrier);
      barrier.then(() => {
        if (barriers.get(name) === barrier) barriers.delete(name);
        if (backend(name) === selected && !selected.status(name)) { modes.delete(name); residency.forget(name); }
      }).catch(() => {});
      return barrier;
    },
    async closeAndWait(name, opts) {
      await barriers.get(name);
      const result = await backend(name).closeAndWait(name, opts);
      barriers.delete(name); modes.delete(name); used.delete(name);
      residency.forget(name);
      return result;
    },
    parkWorkspace: (name, workspace) => residency.park(name, workspace),
    claimWorkspace: (name, workspace, opts) => residency.claim(name, workspace, opts),
    // Every warm resident child this host currently holds — the pool's input.
    // Each entry is a child the backend still reports, so a name whose child was
    // reaped (or closed by a lifecycle caller) drops out here by itself instead
    // of being tracked, and the router forgets it. `busy`/`queued` are the
    // child's own claim on itself: an entry with either set is a claimed lease.
    residents() {
      const warm = [];
      for (const [name, mode] of [...modes]) {
        const status = backend(name)?.status?.(name);
        if (!status) { modes.delete(name); used.delete(name); continue; }
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
