'use strict';

// All session lifecycle callers use this facade, so SDK children participate
// in cancellation, hibernation, deletion, pruning and shutdown like CLI streams.
function createStreamRouter(legacy, sdk) {
  const modes = new Map();
  const barriers = new Map();
  const backend = name => modes.get(name) === 'sdk' ? sdk : legacy;
  const api = {
    ensure(name, cfg) {
      const mode = cfg.sdkOptions ? 'sdk' : 'legacy';
      if (modes.has(name) && modes.get(name) !== mode) {
        const barrier = backend(name).closeAndWait(name);
        barrier.catch(() => {});
        barriers.set(name, barrier);
      }
      modes.set(name, mode);
      return backend(name).ensure(name, cfg);
    },
    async send(name, ...args) {
      const barrier = barriers.get(name);
      if (barrier) { await barrier; if (barriers.get(name) === barrier) barriers.delete(name); }
      return backend(name).send(name, ...args);
    },
    close(name) {
      const selected = backend(name);
      Promise.resolve(selected.close(name)).then(() => {
        if (backend(name) === selected && !selected.status(name)) modes.delete(name);
      }).catch(() => {});
    },
    async closeAndWait(name, opts) {
      await barriers.get(name);
      const result = await backend(name).closeAndWait(name, opts);
      barriers.delete(name); modes.delete(name);
      return result;
    },
  };
  for (const method of ['cancel', 'status', 'isAlive', 'recycle']) api[method] = (name, ...args) => backend(name)[method](name, ...args);
  api.inject = api.send;
  return api;
}

module.exports = { createStreamRouter };
