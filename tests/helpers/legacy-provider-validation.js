'use strict';

// Frozen from src/routes/providers.js before moving native-line rules to Rust.
const { nativeVendorOf } = require('../../src/providers/native-vendor');
const { NATIVE_OPENCODE_ID, nativeOpenCodeId } = require('../../src/providers/native-opencode');

function validProviderId(deps, cli, id) {
  const appType = deps.providers.appTypeForCli(cli);
  if (typeof deps.providers.normalizeOfficialProviderId === 'function') {
    id = deps.providers.normalizeOfficialProviderId(cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli, id);
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
  const appTypes = typeof deps.providers.appTypesForCli === 'function'
    ? deps.providers.appTypesForCli(cli) : (appType ? [appType] : []);
  if (!appTypes.length) return { ok: false };
  const summary = deps.providerRouterRuntime.getProviderSummary(appTypes.length > 1 ? undefined : appType, String(id));
  if (!summary || !deps.providers.providerSupportsCli(summary, cli)) return { ok: false };
  return { ok: true, value: String(id) };
}

module.exports = { validProviderId };
