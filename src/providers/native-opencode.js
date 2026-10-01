'use strict';

// OpenCode's own providers — the Zen gateway (id `opencode`), the Go plan
// (`opencodego`) and anything added with `opencode auth login` — are not MultiCC
// providers: the CLI reads them from its own config and credentials, so a pool
// names one as `opencode-native:<id>` and every layer treats it as a
// provider-less opencode session pinned to a `<id>/<model>` wire id. The helpers
// are pure and never touch the live model list, so a stored pool survives a cold
// boot and validates before OpenCode has ever been asked for its models.

const NATIVE_OPENCODE_PREFIX = 'opencode-native:';
// The OpenCode provider id namespace: lowercase-ish, no path separators.
const NATIVE_OPENCODE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const NATIVE_OPENCODE_NAMES = { opencode: 'OpenCode Zen', opencodego: 'OpenCode Go' };

// The id behind a `opencode-native:<id>` value, or null for anything else. A
// null answer is not "invalid": it means the value is an ordinary provider id.
function nativeOpenCodeId(value) {
  const text = String(value == null ? '' : value);
  return text.startsWith(NATIVE_OPENCODE_PREFIX)
    ? text.slice(NATIVE_OPENCODE_PREFIX.length) : null;
}

function nativeOpenCodeName(id) {
  return NATIVE_OPENCODE_NAMES[id] || `OpenCode · ${id}`;
}

// A stand-in catalog entry for one native id, so the Auto Provider runtime sees
// the shape it sees for a managed route. It is protocol-agnostic (protocolOf
// reads null, so it is excluded from the per-lane protocol-mix check) and reads
// as 'user-managed' (nothing marks it official). `modelOptions` are the
// `<id>/<model>` wire ids the opencode model cache knows; an empty list leaves
// the line on OpenCode's own default.
function syntheticNativeOpenCodeProvider(id, modelOptions = []) {
  const options = [...new Set((Array.isArray(modelOptions) ? modelOptions : [])
    .map(model => String(model == null ? '' : model).trim()).filter(Boolean))];
  return Object.freeze({
    id: NATIVE_OPENCODE_PREFIX + id,
    name: nativeOpenCodeName(id),
    nativeOpenCode: true,
    nativeProvider: id,
    model: options[0] || null,
    modelOptions: Object.freeze(options),
  });
}

module.exports = {
  NATIVE_OPENCODE_ID,
  NATIVE_OPENCODE_PREFIX,
  nativeOpenCodeId,
  nativeOpenCodeName,
  syntheticNativeOpenCodeProvider,
};
