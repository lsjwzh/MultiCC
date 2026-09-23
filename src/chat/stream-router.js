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
  const backend = name => {
    const mode = modes.get(name);
    if (mode === 'sdk') return sdk;
    if (mode === 'app-server') return appServer;
    return legacy;
  };
  const api = {
    ensure(name, cfg) {
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
      const barrier = barriers.get(name);
      if (barrier) { await barrier; if (barriers.get(name) === barrier) barriers.delete(name); }
      used.set(name, Date.now());
      return backend(name).send(name, ...args);
    },
    close(name) {
      const selected = backend(name);
      used.delete(name);
      Promise.resolve(selected.close(name)).then(() => {
        if (backend(name) === selected && !selected.status(name)) modes.delete(name);
      }).catch(() => {});
    },
    async closeAndWait(name, opts) {
      await barriers.get(name);
      const result = await backend(name).closeAndWait(name, opts);
      barriers.delete(name); modes.delete(name); used.delete(name);
      return result;
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
        if (!status) { modes.delete(name); used.delete(name); continue; }
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
