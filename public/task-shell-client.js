(function (root) {
  'use strict';
  // Keep the selected control target and original request key immutable while
  // the network result is unknown. A reconnect cannot silently answer a newer
  // question or re-route the same message into a second branch.
  function createClient({ request, storage, key, randomId }) {
    let pending = null;
    try { pending = JSON.parse(storage.getItem(key) || 'null'); } catch (_) {}
    function save(value) {
      pending = value;
      if (value) storage.setItem(key, JSON.stringify(value)); else storage.removeItem(key);
    }
    async function deliver(shellId, value) {
      try {
        const result = await request(`/api/task-shells/${encodeURIComponent(shellId)}/messages`, value);
        save(null); return result;
      } catch (error) {
        if (error.notReserved === true) save(null);
        throw error;
      }
    }
    return {
      pending: () => pending,
      send(shellId, payload) {
        if (pending) return Promise.reject(new Error('pending_delivery'));
        const value = { ...payload, clientMsgId: randomId() };
        save(value); return deliver(shellId, value);
      },
      retry(shellId) {
        if (!pending) return Promise.reject(new Error('no_pending_delivery'));
        return deliver(shellId, pending);
      },
    };
  }
  const api = { createClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCTaskShellClient = api;
})(typeof window !== 'undefined' ? window : globalThis);
