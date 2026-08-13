'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// The golden parity contract: the server renders a bar once (the words, colors,
// ordering and vendor rules all baked in, with only {cd:}/{ago:} time tokens
// left for the client), and BOTH clients must resolve those tokens to the same
// strings. This test is the node half; app/test/quota_bar_render_test.dart is
// the Flutter half. Both read the same fixture, so a resolver change that is not
// mirrored on the other end fails here AND there.
//
// The fixture is generated from the renderer + this resolver, so it also pins
// the renderer's output: if the renderer starts emitting different text/color
// for a given input, regenerating the fixture makes the diff an explicit review.
const { resolveQuotaBar } = require('../public/quota-bar-view');
const fixture = require('./fixtures/quota-bar-golden.json');

test('the golden fixture is non-empty and anchored to a fixed now', () => {
  assert.ok(Number.isFinite(fixture.now));
  assert.ok(fixture.cases.length >= 20, `expected broad coverage, got ${fixture.cases.length}`);
});

for (const c of fixture.cases) {
  test(`node resolver matches golden: ${c.name}`, () => {
    const view = resolveQuotaBar(c.bar, { state: c.state, now: fixture.now });
    assert.ok(view, 'a bar must resolve to a view, never null');
    assert.equal(view.text, c.expected.text, 'text');
    assert.equal(view.color, c.expected.colorHex, 'color');
    assert.equal(view.title, c.expected.title, 'title');
    assert.equal(view.action, c.expected.action ?? null, 'action');
  });
}

test('the resolver never leaves a {cd:} or {ago:} token in the output', () => {
  for (const c of fixture.cases) {
    const view = resolveQuotaBar(c.bar, { state: c.state, now: fixture.now });
    assert.doesNotMatch(view.text, /\{(cd|ago):/, `${c.name}: unresolved token in text`);
    assert.doesNotMatch(view.title, /\{(cd|ago):/, `${c.name}: unresolved token in title`);
  }
});
