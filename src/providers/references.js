'use strict';

// Which sessions, defaults and Aux config still point at a provider — the facts
// a delete has to break or refuse. Every membership rule now lives in Rust
// (`multicc_core::provider_registry::reference_*`, walked by
// `native/addon/src/provider_registry.rs`'s `provider_find_references`): the
// pool each `cli` draws from, the two CLIs that span both pools, what makes a
// target poolable at all, and the Aux queue's protocol-derived pool.
//
// This file is the transport only. The live session table, the Rust-backed
// defaults view and the Aux config stay in the Node process, so the addon reads
// them here instead of the front door holding a second copy.
//
// Behaviour is pinned against the frozen pre-migration implementation in
// tests/helpers/legacy-provider-references.js by tests/test-provider-references.js.
const { getNative } = require('../native/runtime');

function findProviderReferences(input = {}) {
  return getNative().providerFindReferences(input);
}

module.exports = { findProviderReferences };
