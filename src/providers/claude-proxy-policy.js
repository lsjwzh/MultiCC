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
// `required` is true when the host has somewhere local to forward to:
//   • a provider with a base_url — the normal case, and the reason this exists;
//   • the built-in official entry (`builtinOfficial`): a login-only provider
//     with no base_url that core.applyClaudeProxyEnv deliberately forces onto
//     the proxy (officialOAuth + its own officialProviderId) so the official
//     endpoint is reached through the local hop as well.
// A concrete providerId whose summary cannot be resolved fails closed — an
// unresolvable route is a bug, not a licence to talk to the vendor directly.
// This is the same stance resolveSpawnEnv already takes for zcode/kimi ("never
// turn a stale or OAuth-only managed binding into an implicit native request"),
// which for claude/codex currently degrades to `{env:{}}` — i.e. the native
// login. A broken claude binding must not become a silent Anthropic request on
// the operator's own account.
//
// Deliberately NOT required: a non-built-in OAuth-passthrough entry with no
// base_url. There is nothing for the proxy to forward to, so the CLI's own
// login reaches Anthropic with or without the rewrite, and requiring it would
// only reproduce the 2026-07-05 incident (such a session 502'd on every turn
// until the bypass was restored). Sessions with no provider at all
// ('' / '_default_') keep their existing default-login path.

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function claudeProxyEnvRequired(options = {}) {
  const providerId = clean(options.providerId);
  if (!providerId || providerId === '_default_') return false;
  const summary = options.summary;
  if (!summary) return true;
  if (summary.builtinOfficial === true) return true;
  return !!clean(summary.baseUrl);
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
