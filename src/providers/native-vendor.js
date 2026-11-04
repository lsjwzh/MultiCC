'use strict';

// Vendor-native lanes: a CLI that owns its account AND its model catalog cannot
// be reached through the MultiCC provider store at all. The Auto Provider pool
// still needs a line to point at, so these lanes get one synthetic line per
// lane — `<cli>-native:<cli>` — whose models come from that vendor's own
// catalog. Spawning maps the id back to a provider-less lane; validation is
// structural so a stored pool survives a cold boot and the vendor CLI never has
// to be online to save one.
//
// OpenCode keeps its own module (native-opencode.js): one lane may hold several
// native providers, and its wire model carries the `<provider>/<model>` prefix.
// The vendors here have a single catalog and a bare model id.

const { displayNameOf } = require('../cli/cli-capability');
const { peekCommandcodeModels } = require('../routes/commandcode-models');
const { peekQoderModels } = require('../routes/qoder-models');
const { peekCodebuddyModels } = require('../routes/codebuddy-models');
const { peekGrokModels } = require('../routes/grok-models');

// Lanes that own a vendor catalog. dsh/grok are additionally managed-capable
// (they can run MultiCC provider lines); their native line is still a valid
// candidate, exactly like OpenCode's managed + native mix.
const VENDOR_NATIVE_CLIS = Object.freeze([
  'qoder', 'codebuddy', 'gemini', 'pi', 'commandcode', 'dsh', 'grok',
]);
const VENDOR_NATIVE_SET = new Set(VENDOR_NATIVE_CLIS);
const NATIVE_VENDOR_SUFFIX = '-native:';
const NATIVE_VENDOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,118}[A-Za-z0-9._/-]$/;

// Mirrors DSH_MODELS (src/cli-adapters/dsh.js) and GEMINI_MODEL_OPTIONS
// (public/chat-ai-config.js). Pi has no catalog; its line runs the CLI default
// or a user-typed model id.
const DSH_MODELS = Object.freeze(['deepseek-v4-flash', 'deepseek-v4-pro']);
const GEMINI_MODELS = Object.freeze(['gemini-2.5-pro', 'gemini-2.5-flash']);

function nativeVendorLineId(cli) {
  return `${cli}-native:${cli}`;
}

// The lane behind a `<cli>-native:<id>` value, or null for anything else
// (including OpenCode's own `opencode-native:` namespace).
function nativeVendorOf(value) {
  const text = String(value == null ? '' : value);
  const at = text.indexOf(NATIVE_VENDOR_SUFFIX);
  if (at <= 0) return null;
  const cli = text.slice(0, at);
  if (!VENDOR_NATIVE_SET.has(cli)) return null;
  return Object.freeze({ cli, id: text.slice(at + NATIVE_VENDOR_SUFFIX.length) });
}

function isVendorNative(value) {
  return nativeVendorOf(value) !== null;
}

function nativeVendorName(cli) {
  return displayNameOf(cli);
}

function modelIds(entries) {
  return [...new Set((Array.isArray(entries) ? entries : [])
    .map(entry => (entry && typeof entry === 'object' ? entry.model : entry))
    .map(model => String(model == null ? '' : model).trim())
    .filter(Boolean))];
}

// Synchronous vendor catalog for a lane. Routes answer with their warm cache or
// bundled snapshot; dsh/gemini are static; pi has none.
function nativeVendorModels(cli) {
  try {
    if (cli === 'commandcode') return modelIds(peekCommandcodeModels());
    if (cli === 'qoder') return modelIds(peekQoderModels());
    if (cli === 'codebuddy') return modelIds(peekCodebuddyModels());
    if (cli === 'grok') return modelIds(peekGrokModels());
  } catch (_) { /* a cold route must not break a turn */ }
  if (cli === 'dsh') return [...DSH_MODELS];
  if (cli === 'gemini') return [...GEMINI_MODELS];
  return [];
}

// A stand-in catalog entry shaped like a managed route, so the Auto Provider
// runtime, editor and run-config all see the same fields.
function syntheticVendorProvider(cli, modelOptions = nativeVendorModels(cli)) {
  const options = modelIds(modelOptions);
  return Object.freeze({
    id: nativeVendorLineId(cli),
    name: nativeVendorName(cli),
    nativeVendor: true,
    nativeCommandCode: cli === 'commandcode',
    nativeProvider: cli,
    appType: cli,
    model: options[0] || null,
    modelOptions: Object.freeze(options),
  });
}

module.exports = {
  DSH_MODELS,
  GEMINI_MODELS,
  MODEL_ID,
  NATIVE_VENDOR_ID,
  NATIVE_VENDOR_SUFFIX,
  VENDOR_NATIVE_CLIS,
  VENDOR_NATIVE_SET,
  isVendorNative,
  nativeVendorLineId,
  nativeVendorModels,
  nativeVendorName,
  nativeVendorOf,
  syntheticVendorProvider,
};
