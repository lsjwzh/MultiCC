'use strict';

// The `mcrelay1.` share code is the single wire format between a lending
// instance (POST relay-share, re-copy of a recorded share) and an importing
// instance (re-copy of the original import info). Keeping the encoder in one
// place stops the three paths from drifting; the decoder lives in
// public/manage-provider-relay.js (parseRelayShareCode).

const CODE_PREFIX = 'mcrelay1.';

// Public model metadata only: the importer must start on a model the source
// actually serves (Codex Official has no model in config.toml).
function relayModelsOf(summary) {
  const source = summary || {};
  return [...new Set([
    source.model,
    ...(Array.isArray(source.modelOptions) ? source.modelOptions : []),
  ].map(value => String(value || '').trim())
    .filter(value => value && value.length <= 256))].slice(0, 100);
}

function encodeRelayShareCode({ name, appType, baseUrl, models, relayShareId, authToken }) {
  const list = Array.isArray(models) ? models : [];
  return CODE_PREFIX + Buffer.from(JSON.stringify({
    v: 2,
    kind: 'multicc-relay',
    name,
    appType,
    baseUrl,
    ...(list[0] ? { model: list[0], models: list } : {}),
    relayShareId,
    authToken,
  }), 'utf8').toString('base64url');
}

module.exports = { CODE_PREFIX, encodeRelayShareCode, relayModelsOf };
