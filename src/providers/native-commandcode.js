'use strict';

// Command Code owns its vendor catalog and account: the CLI reads models from
// `command-code --list-models` and the user's own login / ~/.commandcode
// providers.json, so it is a provider-less lane in MultiCC's provider store.
// An Auto Provider pool can still use it by naming its one native line,
// `commandcode-native:commandcode`, with the vendor's model id as the wire
// model. Every layer then treats it like a provider-less commandcode session;
// the id is validated structurally, so a stored pool survives a cold boot.

const NATIVE_COMMANDCODE_PREFIX = 'commandcode-native:';
const NATIVE_COMMANDCODE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const NATIVE_COMMANDCODE_LINE_ID = 'commandcode';
const NATIVE_COMMANDCODE_NAME = 'Command Code';
// The vendor catalog's id shape (src/routes/commandcode-models.js MODEL_ID_RE).
const NATIVE_COMMANDCODE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,118}[A-Za-z0-9._/-]$/;

// The id behind a `commandcode-native:<id>` value, or null for anything else.
function nativeCommandCodeId(value) {
  const text = String(value == null ? '' : value);
  return text.startsWith(NATIVE_COMMANDCODE_PREFIX)
    ? text.slice(NATIVE_COMMANDCODE_PREFIX.length) : null;
}

function nativeCommandCodeName() {
  return NATIVE_COMMANDCODE_NAME;
}

// A stand-in catalog entry for the vendor line, so the Auto Provider runtime
// sees the shape it sees for a managed route. It is protocol-agnostic: the
// vendor catalog mixes Anthropic- and OpenAI-shaped models behind one CLI.
function syntheticNativeCommandCodeProvider(id = NATIVE_COMMANDCODE_LINE_ID, modelOptions = []) {
  const options = [...new Set((Array.isArray(modelOptions) ? modelOptions : [])
    .map(model => String(model == null ? '' : model).trim()).filter(Boolean))];
  return Object.freeze({
    id: NATIVE_COMMANDCODE_PREFIX + id,
    name: nativeCommandCodeName(),
    nativeCommandCode: true,
    nativeProvider: id,
    appType: 'commandcode',
    model: options[0] || null,
    modelOptions: Object.freeze(options),
  });
}

module.exports = {
  NATIVE_COMMANDCODE_ID,
  NATIVE_COMMANDCODE_LINE_ID,
  NATIVE_COMMANDCODE_MODEL,
  NATIVE_COMMANDCODE_NAME,
  NATIVE_COMMANDCODE_PREFIX,
  nativeCommandCodeId,
  nativeCommandCodeName,
  syntheticNativeCommandCodeProvider,
};
