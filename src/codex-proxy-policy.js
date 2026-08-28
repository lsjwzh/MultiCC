'use strict';

function clean(value) {
  return value == null ? '' : String(value).trim();
}

// A Codex turn may stay on its native/static home only when no managed route
// was selected. Every concrete provider — including ChatGPT OAuth Official —
// must be materialized as an attempt-scoped local proxy route. This keeps the
// upstream credential host-side and gives guard/admission/activity/usage one
// invariant route shape for every managed attempt.
function codexProxyConfigRequired(options = {}) {
  const subagentProviderId = clean(options.subagentProviderId);
  if (subagentProviderId) return true;
  const providerId = clean(options.providerId);
  if (!providerId || providerId === '_default_') return false;
  return true;
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
