'use strict';

// Per-session sub-task routing (Claude `CLAUDE_CODE_SUBAGENT_MODEL`, Codex agent
// layers). One validator for every write path — the session-profile PATCH and
// session creation — because an Air task now pins its route at creation time
// instead of only being editable afterwards, and two validators would drift.
//
// Shape: `{ providerId, model }`. Clearing is `null` / `''` / `{}`. A concrete
// override always names BOTH ends: the provider is what the local protocol proxy
// routes on (`ccfw:<providerId>:<model>`), so "a model with no line" is not
// something the wire format can carry — it is always sent as "no override".
//
// Pure on purpose (this module lives under src/session, whose files may only
// require node: builtins and local siblings): the caller passes in the provider
// lookups it already has.
function normalizeSubagentInput({ cli, provider = null, subagent = null, validProviderId, providers } = {}) {
  const clearing = subagent === null || subagent === ''
    || (typeof subagent === 'object' && Object.keys(subagent).length === 0);
  if (clearing) return { ok: true, value: null, cleared: true };
  const appType = cli || 'claude';
  if (appType !== 'claude' && appType !== 'codex') {
    return { ok: false, error: 'subagent routing is only supported by Claude and Codex' };
  }
  if (typeof subagent !== 'object') return { ok: false, error: 'invalid subagent' };
  const v = validProviderId(appType, (subagent.providerId || '').toString().trim());
  if (!v.ok) return { ok: false, error: 'invalid subagent provider' };
  const model = (subagent.model || '').toString().trim();
  if (!model) return { ok: false, error: 'subagent model required' };
  if (appType === 'codex') {
    // Codex materializes a second model_provider from the sub-task route, so it
    // needs a main provider to fall back to and an endpoint it can actually call.
    if (!provider) return { ok: false, error: 'Codex subagent routing requires a selected main provider' };
    if (!providers.codexProviderProxyable(v.value)) {
      return { ok: false, error: 'Codex subagent provider has no callable HTTP endpoint' };
    }
  }
  return { ok: true, value: { providerId: v.value, model }, cleared: false };
}

module.exports = { normalizeSubagentInput };
