'use strict';

// The WebSocket envelope has two implementations: the production JavaScript in
// the native API contract, which every live frame goes through, and
// multicc_core::api_contract::ws_envelope, which the Rust front door uses.
// `docs/rust-migration/differential/ws-envelope-golden.json` is what keeps
// them equal — the Rust kernel's own test compares itself against that file.
//
// Nothing, until this test, compared the FILE against the live JavaScript. A
// golden that goes stale while `createWsEnvelope` changes leaves the Rust test
// passing against bytes the Node side no longer produces, and the chat replay
// buffer — whose frames are `JSON.stringify(createWsEnvelope(event))` — would
// start disagreeing with the front door one frame at a time.
//
// So this pins the golden to the live implementation, closing the loop:
//   live JS  ==(this test)==  golden  ==(Rust kernel test)==  Rust
//
// Why the JavaScript is still the runtime implementation here: encoding
// through a JSON bridge was measured at 18x the cost on a small streamed event
// (149ns -> 2716ns) and 6.7x on a tool-heavy one (12.3us -> 82.9us). Every
// provider event on a streaming turn pays it twice (buffer + broadcast), and
// main-thread stalls on exactly this path have been a production problem, so
// the bridge is not worth the bytes it would not change. The front door will
// call the Rust kernel natively, with no bridge, when it owns the write side.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWsEnvelope } = require('../src/native/runtime').getApiContract();
const golden = require('../docs/rust-migration/differential/ws-envelope-golden.json');

test('the frozen envelope golden still matches the live JavaScript', () => {
  const entries = Object.entries(golden);
  assert.ok(entries.length >= 26, `the golden lost cases: ${entries.length}`);
  let refusals = 0;
  for (const [index, entry] of entries) {
    const payload = JSON.parse(entry.payload);
    const context = JSON.parse(entry.context);
    // `response: null` is the host throwing for an invalid payload or a null
    // context — a refusal is part of the contract, not an absent case.
    let actual = null;
    try {
      actual = JSON.stringify(createWsEnvelope(payload, context));
    } catch (_) {
      actual = null;
    }
    const expected = entry.response === null
      ? null
      : Buffer.from(entry.response, 'base64').toString('utf8');
    if (expected === null) refusals += 1;
    assert.equal(actual, expected,
      `case ${index}: payload=${entry.payload} context=${entry.context}`);
  }
  // The refusal cases are what prove the throw is pinned too, not only the
  // happy path; a golden of 26 accepted frames would hide a kernel that never
  // refuses anything.
  assert.ok(refusals >= 3, `the golden must keep its refusals: ${refusals}`);
  console.log(`ws envelope pin: ${entries.length} frozen cases, ${refusals} refusals`);
});
