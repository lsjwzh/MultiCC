'use strict';

// Frozen oracle for the ⑤ segment of `validProviderId` — the protocol
// compatibility table (`compatibleClisForFormat` / `CREDENTIAL_GATED_CLIS` /
// `providerSupportsCli`) and the CLI→pool map (`appTypeForCli` /
// `appTypesForCli`) that `src/providers/core.js` used to own in JavaScript.
//
// Frozen verbatim from `git show HEAD:src/providers/core.js` on 2026-11-16,
// *before* the Node side was changed to delegate to Rust. Do not "fix" these
// bodies: their only job is to answer as the retired implementation did, so a
// differential can prove the native rules answer the same.
//
// One documented deviation: the retired `normalizeApiFormat` carried its own
// JS spelling table. The working tree had already moved it to
// `getNative().providerNormalizeApiFormat` (same answer, decided in Rust), so
// the oracle calls the same native export instead of re-freezing the table.
// `normalizeApiFormat` never forks on the third `cfg` argument the retired
// signature accepted; callers still pass it and it is ignored, as in the tree.
//
// `providerSupportsCli`'s retired body summarizes a provider ROW (one with a
// `settingsConfig`) via `summarize()`. The validator never passes a row — it
// passes the flattened `getProviderSummary` answer — so the row branch is out
// of this oracle's corpus and throws loudly instead of silently drifting.

const { getNative } = require('../../src/native/runtime');
const { nativeVendorOf } = require('../../src/providers/native-vendor');
const { NATIVE_OPENCODE_ID, nativeOpenCodeId } = require('../../src/providers/native-opencode');

const API_FORMATS = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI_RESPONSES: 'openai_responses',
});

// Frozen from the retired `parseConfig`.
function parseConfig(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return {}; }
}

// Frozen from the retired `normalizeApiFormat`; the spelling table now lives in
// `multicc_core::provider_settings_config` (see the header note).
function normalizeApiFormat(value, appType) {
  return getNative().providerNormalizeApiFormat({ apiFormat: value, appType });
}

function compatibleClisForFormat(apiFormat) {
  // DSH joins the Anthropic pool: its only LLM client speaks Anthropic Messages
  // (default endpoint https://api.deepseek.com/anthropic, DEEPSEEK_BASE_URL
  // replaces the whole base — verified in dsh-llm-deepseek). Grok joins both
  // pools: its config.toml [model.*] api_backend accepts "messages" and
  // "responses" (docs/user-guide/11-custom-models.md). WorkBuddy/Qoder CN were
  // probe-tested 2026-10-15 and ignore endpoint overrides entirely — they stay
  // providerless by vendor design, not by our choice.
  if (apiFormat === API_FORMATS.ANTHROPIC) return ['claude', 'claude-exp', 'opencode', 'zcode', 'dsh', 'grok'];
  // Kimi Code joins the OpenAI-family pool (moonshot's own API is
  // OpenAI-compatible).
  return ['codex', 'codex-exp', 'opencode', 'zcode', 'kimi', 'grok'];
}

// These CLIs replay a provider over plain HTTP: an OAuth-subscription entry
// (Claude/Codex official) has no credential they can use, so they only appear
// on providers with a real baseUrl+token. Their official logins stay on the
// provider-less native route.
const CREDENTIAL_GATED_CLIS = new Set(['zcode', 'kimi', 'dsh', 'grok']);

// The retired `providerSupportsCli` summarized a provider ROW. The validator
// only ever hands it a flattened summary, which this oracle asserts.
function summarizeRowOutOfOracle() {
  throw new Error('legacy-provider-cli-rules: provider rows with settingsConfig are outside this oracle');
}

function providerSupportsCli(provider, cli) {
  if (!provider || !cli) return false;
  if (provider.virtual) return [provider.appType, `${provider.appType}-exp`].includes(String(cli));
  const format = normalizeApiFormat(provider.apiFormat || provider.protocol, provider.appType, parseConfig(provider.settingsConfig));
  if (!compatibleClisForFormat(format).includes(String(cli))) return false;
  if (!CREDENTIAL_GATED_CLIS.has(String(cli))) return true;
  const summary = provider.settingsConfig ? summarizeRowOutOfOracle() : provider;
  return !!(summary && summary.baseUrl && summary.hasToken);
}

// Map a session's cli to its MultiCC-managed provider pool (appType).
// Qoder CN owns authentication/provider configuration in its vendor client, so
// it deliberately returns null. OpenCode and ZCode can consume both provider
// pools and therefore resolve globally by provider id; appTypeForCli remains a
// legacy single-pool default only.
function appTypeForCli(cli) {
  if (cli === 'codex' || cli === 'codex-exp') return 'codex';
  if (cli === 'claude' || cli === 'claude-exp' || cli === 'opencode') return 'claude';
  // DSH speaks only Anthropic Messages — its pool is the claude-side one.
  if (cli === 'dsh') return 'claude';
  return null;
}

function appTypesForCli(cli) {
  // Grok's per-model api_backend accepts both "messages" and "responses", so it
  // resolves providers globally by id like OpenCode/ZCode/Kimi.
  if (cli === 'opencode' || cli === 'zcode' || cli === 'kimi' || cli === 'grok') return ['claude', 'codex'];
  const type = appTypeForCli(cli);
  return type ? [type] : [];
}

// Frozen from `tests/helpers/legacy-provider-validation.js`'s `validProviderId`,
// with every rule query replaced by this file's frozen functions and every fact
// lookup routed through a counting hook on the caller's fakes.
//
// `hooks` (both optional arrays): `hooks.normalize` and `hooks.summary` receive
// the exact call sequence the retired code produced — `['normalize', cli, id]`
// for `normalizeOfficialProviderId` and `['summary', pool, String(id)]` for
// `getProviderSummary`. The differential compares those arrays against the ones
// its fakes record for the native path, so both sides must write the same shape.
// The deps object exposes `providers` and `providerRouterRuntime`, exactly like
// the retired route module's deps.
function legacyValidProviderId(deps, cli, id, hooks = {}) {
  const appType = appTypeForCli(cli);
  if (typeof deps.providers.normalizeOfficialProviderId === 'function') {
    const normalizedCli = cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli;
    if (hooks.normalize) hooks.normalize.push(['normalize', normalizedCli, id]);
    id = deps.providers.normalizeOfficialProviderId(normalizedCli, id);
  }
  if (id == null || id === '') return { ok: true, value: null };
  const nativeVendor = nativeVendorOf(id);
  if (nativeVendor !== null) {
    return cli === nativeVendor.cli ? { ok: true, value: String(id) } : { ok: false };
  }
  const openCodeNative = nativeOpenCodeId(id);
  if (openCodeNative !== null) {
    return cli === 'opencode' && NATIVE_OPENCODE_ID.test(openCodeNative)
      ? { ok: true, value: String(id) } : { ok: false };
  }
  const appTypes = appTypesForCli(cli);
  if (!appTypes.length) return { ok: false };
  const pool = appTypes.length > 1 ? undefined : appType;
  if (hooks.summary) hooks.summary.push(['summary', pool, String(id)]);
  const summary = deps.providerRouterRuntime.getProviderSummary(pool, String(id));
  if (!summary || !providerSupportsCli(summary, cli)) return { ok: false };
  return { ok: true, value: String(id) };
}

module.exports = {
  API_FORMATS,
  CREDENTIAL_GATED_CLIS,
  appTypeForCli,
  appTypesForCli,
  compatibleClisForFormat,
  legacyValidProviderId,
  normalizeApiFormat,
  providerSupportsCli,
};
