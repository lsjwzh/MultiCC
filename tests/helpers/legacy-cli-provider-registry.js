'use strict';

function createCliProviderRegistry(adapters, fallbackName = 'claude') {
  const byName = new Map();
  for (const adapter of adapters) {
    if (!adapter || !adapter.name) continue;
    if (typeof adapter.buildInvocation !== 'function') {
      throw new Error(`CLI adapter ${adapter.name} is missing buildInvocation()`);
    }
    if (typeof adapter.decodeEvent !== 'function') {
      throw new Error(`CLI adapter ${adapter.name} is missing decodeEvent()`);
    }
    byName.set(adapter.name, adapter);
  }
  const fallback = byName.get(fallbackName);
  if (!fallback) throw new Error(`missing fallback CLI adapter: ${fallbackName}`);
  return {
    providers: Object.fromEntries(byName.entries()),
    get(cli) {
      return byName.get(cli) || fallback;
    },
  };
}

module.exports = { createCliProviderRegistry };
