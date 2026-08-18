'use strict';

const crypto = require('crypto');
const { createStore } = require('../state-store');

// A short, human-referable display handle for an outward task. The user asked
// for a 4-position code where each position is one of 10 digits + 26 letters =
// 36 symbols, i.e. 36^4 ≈ 1.68M distinct codes.
//
// This is a DISPLAY handle, not an identity key: the full taskId remains the
// unique primary key everywhere in the runtime, and the code carries no
// security/authority meaning.
//
// Registry scheme (upgraded from pure deterministic derivation): a persisted
// taskId→code map guarantees a code is owned by exactly one taskId — visible
// collisions between different tasks are impossible, not just improbable.
//   - stable        → the same taskId always reads back its minted code
//   - reuse-on-same → Aux relation:"same" keeps the taskId, so the code stays
//   - renew-on-new  → Aux relation:"new" mints a new taskId, so a fresh code
//   - unique        → mint retries with a salted hash until the code is free
// Mint candidates are hash-derived: salt 0 reproduces the pre-registry
// deterministic code, so tasks created before the upgrade keep the code users
// already saw unless another task genuinely owns it. Codes are never reused
// once minted; the file grows ~30 bytes per task, negligible at fleet scale.
const CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_LEN = 4;
const CODE_PATTERN = /^[0-9A-Z]{4}$/;
// Hard stop for a pathologically full registry (36^4 ≈ 1.68M codes; reaching
// even thousands of attempts means something is badly wrong — fail loudly
// instead of looping).
const MAX_MINT_ATTEMPTS = 4096;

// Default mint candidate: top 32 bits of sha256(taskId[#salt]) base36-encoded
// to a fixed 4 chars. Salt 0 is byte-identical to the pre-registry derivation,
// which keeps codes stable across the upgrade. The modulo bias of 2^32 across
// 36^4 is < 0.06% — irrelevant for a display handle.
function defaultCandidate(taskId, salt) {
  const digest = crypto.createHash('sha256')
    .update(salt === 0 ? taskId : `${taskId}#${salt}`)
    .digest();
  let n = digest.readUInt32BE(0);
  let code = '';
  for (let i = 0; i < CODE_LEN; i += 1) {
    code = CODE_ALPHABET[n % 36] + code;
    n = Math.floor(n / 36);
  }
  return code;
}

// A registry owns the taskId→code mapping. Pass { file } to persist through
// state-store (atomic write + .bak recovery chain, fail-closed on corruption);
// omit it for an in-memory registry (tests and non-server callers).
// `candidate` is injectable so collision behaviour is deterministically
// testable without brute-forcing sha256 prefixes.
function createTaskShortCodeRegistry({ file = null, candidate = defaultCandidate } = {}) {
  const byTaskId = new Map();
  const byCode = new Map();
  const store = file
    ? createStore({ file, kind: 'task-short-codes', schemaVersion: 1, legacyIsArray: false })
    : null;

  if (store) {
    let loaded;
    try {
      loaded = store.loadOrRecover();
    } catch (e) {
      throw new Error(`[task-short-code] registry state unusable at ${file}: ${e.message}`);
    }
    if (loaded.present) {
      const entries = loaded.data && loaded.data.byTaskId;
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        throw new Error(`[task-short-code] registry payload in ${file} has no byTaskId object`);
      }
      for (const [taskId, code] of Object.entries(entries)) {
        // Skip malformed rows; on a duplicated code the first row wins and the
        // loser's taskId simply remints on next read (corruption only).
        if (!taskId || !CODE_PATTERN.test(code) || byCode.has(code)) continue;
        byTaskId.set(taskId, code);
        byCode.set(code, taskId);
      }
    }
  }

  function persist() {
    if (store) store.save({ byTaskId: Object.fromEntries(byTaskId) });
  }

  // Resolve the code for a taskId, minting (and persisting) on first sight.
  // Returns '' for a missing/blank taskId so an unresolved task (Aux hasn't
  // attributed it yet) shows no code.
  function codeFor(taskId) {
    const id = String(taskId == null ? '' : taskId).trim();
    if (!id) return '';
    const existing = byTaskId.get(id);
    if (existing) return existing;
    for (let salt = 0; salt < MAX_MINT_ATTEMPTS; salt += 1) {
      const code = candidate(id, salt);
      if (!CODE_PATTERN.test(code)) {
        throw new Error(`[task-short-code] candidate fn returned invalid code "${code}" (salt ${salt})`);
      }
      if (byCode.has(code)) continue;
      byTaskId.set(id, code);
      byCode.set(code, id);
      persist();
      return code;
    }
    throw new Error(`[task-short-code] exhausted ${MAX_MINT_ATTEMPTS} mint attempts (${byCode.size} codes registered)`);
  }

  return {
    codeFor,
    has: taskId => byTaskId.has(String(taskId == null ? '' : taskId).trim()),
    ownerOf: code => byCode.get(code) || null,
    size: () => byTaskId.size,
  };
}

// Process-wide registry. server.js bootstrap installs the persisted one via
// initTaskShortCodeRegistry({ file }); anything else (unit tests, one-off
// scripts) transparently gets an in-memory registry on first use, so callers
// never have to special-case initialization order.
let activeRegistry = null;

function initTaskShortCodeRegistry(opts) {
  activeRegistry = createTaskShortCodeRegistry(opts);
  return activeRegistry;
}

function registry() {
  if (!activeRegistry) activeRegistry = createTaskShortCodeRegistry();
  return activeRegistry;
}

// Derive the 4-char base36 code for a taskId (see codeFor).
function taskShortCode(taskId) {
  return registry().codeFor(taskId);
}

// Render `#CODE · text`. Returns text unchanged when there is no resolvable
// code, and just `#CODE` when there is a code but no text, so callers never
// have to special-case the empty states.
function labelWithCode(taskId, text) {
  const body = String(text == null ? '' : text).trim();
  const code = taskShortCode(taskId);
  if (!code) return body;
  if (!body) return `#${code}`;
  return `#${code} · ${body}`;
}

module.exports = {
  taskShortCode,
  labelWithCode,
  createTaskShortCodeRegistry,
  initTaskShortCodeRegistry,
  CODE_LEN,
  CODE_ALPHABET,
};
