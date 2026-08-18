'use strict';

const crypto = require('crypto');

// A short, human-referable display handle for an outward task. The user asked
// for a 4-position code where each position is one of 10 digits + 26 letters =
// 36 symbols, i.e. 36^4 ≈ 1.68M distinct codes.
//
// This is a DISPLAY handle, not an identity key: the full taskId remains the
// unique primary key everywhere in the runtime. The code is derived
// deterministically from the taskId, which buys three properties for free with
// zero persistence:
//   - stable      → the same task always renders the same code
//   - reuse-on-same → Aux relation:"same" keeps the taskId, so the code stays
//   - renew-on-new  → Aux relation:"new" mints a new taskId, so the code renews
// Two different taskIds can in principle collide onto the same code, but the
// collision is cosmetic only — the taskId still disambiguates internally, and
// at fleet scale (dozens of live tasks) a visible collision is astronomically
// rare. The code therefore carries no security/authority meaning.
const CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_LEN = 4;

// Derive the 4-char base36 code for a taskId. Returns '' for a missing/blank
// taskId so an unresolved task (Aux hasn't attributed it yet) shows no code.
function taskShortCode(taskId) {
  const id = String(taskId == null ? '' : taskId).trim();
  if (!id) return '';
  // Take the top 32 bits of sha256(taskId) and base36-encode a fixed 4 chars.
  // The modulo bias of 2^32 across 36^4 is < 0.06% — irrelevant for a display
  // handle and it keeps the mapping trivially reproducible on any surface.
  const digest = crypto.createHash('sha256').update(id).digest();
  let n = digest.readUInt32BE(0);
  let code = '';
  for (let i = 0; i < CODE_LEN; i += 1) {
    code = CODE_ALPHABET[n % 36] + code;
    n = Math.floor(n / 36);
  }
  return code;
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

module.exports = { taskShortCode, labelWithCode, CODE_LEN, CODE_ALPHABET };
