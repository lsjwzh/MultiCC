'use strict';

// Every Claude turn bound to a provider the host can serve locally must leave
// the machine through the local claude-proxy (cli-provider-router rewrites
// ANTHROPIC_BASE_URL to 127.0.0.1 and injects a virtual token), exactly like
// Codex's per-provider attempt homes. `applyClaudeProxyEnv` returns false when
// it declines to rewrite; that return value used to be ignored, so a session
// silently fell back to whatever ANTHROPIC_* the child env still carried and
// talked to the vendor endpoint directly — the provider URL and credential the
// host is supposed to own leaked straight out of the spawn. Resolve the
// requirement here and refuse to spawn instead.
//
// `required` is true for EVERY concrete providerId. There used to be one
// exemption — a non-built-in OAuth-passthrough entry with no base_url — on the
// grounds that "there is nothing local to forward to". That reasoning was about
// the *old* proxy: today the local hop serves both base-less shapes, so there IS
// somewhere local to forward to for every provider the store knows, and the
// exemption only bought a silent direct dial to Anthropic on whatever credential
// the child env happened to carry. core.applyClaudeProxyEnv materializes the
// route for either shape:
//   • no base URL and no credential → the official route (the proxy's official
//     branch replays the host login); forced unconditionally, like the built-in
//     official entry has always been, so an operator who turned the official path
//     off gets the proxy's refusal on the hop rather than a bypass around it;
//   • no base URL but its own token → the entry's implied upstream
//     (api.anthropic.com) with that same token, so an OAuth-passthrough provider
//     keeps working instead of being dialed directly.
// Sessions with no provider at all ('' / '_default_') keep their existing
// default-login path, and a stale binding that resolves to nothing fails closed.
//
// The resolved `summary` is still accepted — it documents the route at the call
// site — but no longer participates in the decision: a summary the caller got
// wrong must not be able to authorise a direct dial.

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function claudeProxyEnvRequired(options = {}) {
  const providerId = clean(options.providerId);
  if (!providerId || providerId === '_default_') return false;
  return true;
}

function assertClaudeProxyEnvApplied({ required, applied } = {}) {
  if (required === true && applied !== true) {
    const error = new Error('Claude managed provider route could not be materialized; refusing to spawn a direct connection to the provider endpoint');
    error.code = 'CLAUDE_PROXY_ENV_REQUIRED';
    throw error;
  }
  return applied === true;
}

module.exports = {
  claudeProxyEnvRequired,
  assertClaudeProxyEnvApplied,
};
