'use strict';

// Old Gemini records remain readable but can no longer launch the retired CLI.
// Never let the generic unknown-CLI fallback send that history to Claude.
const RETIRED_GEMINI = Object.freeze({
  name: 'gemini', cmd: '',
  buildInvocation() { throw new Error('Gemini CLI 已停用，请切换至 Antigravity（agy）；原会话历史不会自动迁移。'); },
  buildTerminalCmd() { return "printf '%s\\n' 'Gemini CLI retired; switch to Antigravity (agy).'"; },
  decodeEvent() { return []; },
});

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
      return String(cli || '').trim().toLowerCase() === 'gemini' ? RETIRED_GEMINI : (byName.get(cli) || fallback);
    },
  };
}

module.exports = { createCliProviderRegistry };
