'use strict';

function clean(value) {
  return value == null ? '' : String(value).trim();
}

// A Codex turn may stay on its native/static home only when no managed route
// was selected, or when the selected main provider is a confirmed direct
// ChatGPT OAuth provider and no subagent override needs the managed proxy.
// Missing provider metadata is deliberately treated as stale, not official.
function codexProxyConfigRequired(options = {}) {
  const subagentProviderId = clean(options.subagentProviderId);
  if (subagentProviderId) return true;
  const providerId = clean(options.providerId);
  if (!providerId || providerId === '_default_') return false;
  return options.officialOAuth !== true;
}

function assertCodexProxyConfigApplied({ required, applied } = {}) {
  if (required === true && applied !== true) {
    const error = new Error('Codex managed provider route could not be materialized');
    error.code = 'CODEX_PROXY_CONFIG_REQUIRED';
    throw error;
  }
  return applied === true;
}

module.exports = {
  assertCodexProxyConfigApplied,
  codexProxyConfigRequired,
};
