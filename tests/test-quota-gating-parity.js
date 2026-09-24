'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// The gating parity contract — the node half.
//
// Deciding WHICH bar may be on screen is a pure function of (window kind, cli,
// baseUrl), and that decision exists in three places: the server renderer's
// inputs, the web module (public/chat-rate-limit.js — the authority) and the
// app's Dart mirror (app/lib/models/vendor_quota.dart). The web and Dart copies
// once disagreed on the 借道 (borrowed provider) branch, and the only symptom
// was a bar that showed up on the phone and not in the browser, so the copies
// now answer to one table: tests/helpers/quota-gating-cases.js →
// tests/fixtures/quota-gating-golden.json.
//
// This test re-runs that table against the LIVE web module. It fails when the
// web predicates move without the fixture being regenerated — and the fixture
// is what app/test/quota_gating_parity_test.dart holds Dart to, so the failure
// is the moment to decide, in one place, which end is wrong.

const api = require('../public/chat-rate-limit');
const fixture = require('./fixtures/quota-gating-golden.json');
const { CLIS, WINDOW_KINDS, BASE_URLS } = require('./helpers/quota-gating-cases');

function labels() { return BASE_URLS.map((c) => c.label); }

test('the fixture covers the whole table (no case has quietly gone missing)', () => {
  assert.deepEqual(fixture.clis, [...CLIS]);
  assert.deepEqual(fixture.windowKinds, [...WINDOW_KINDS]);
  assert.deepEqual(fixture.baseUrls.map((c) => c.label), labels());
  assert.ok(fixture.baseUrls.every((c) => typeof c.why === 'string' && c.why.length > 4), 'every baseUrl keeps its rationale');
  assert.equal(Object.keys(fixture.providerMatchesCliIn).length, WINDOW_KINDS.length * BASE_URLS.length);
  assert.equal(Object.keys(fixture.balanceBarVisibleFor).length, BASE_URLS.length);
  assert.equal(Object.keys(fixture.baseUrlTraits).length, BASE_URLS.length);
});

test('the fixture is non-vacuous (the gates really do split the inputs)', () => {
  const all = CLIS.join(',');
  const rows = Object.values(fixture.providerMatchesCliIn).map((r) => r.join(','));
  assert.ok(new Set(rows).size >= 3, 'the kind×baseUrl grid must produce more than one answer');
  const balanceRows = Object.values(fixture.balanceBarVisibleFor);
  assert.ok(balanceRows.some((r) => r.length > 0) && balanceRows.some((r) => r.length < CLIS.length), 'the balance gate must both pass and reject');
  // The two axes must actually move the answer: a baseUrl change flips a kind,
  // and a kind change flips an answer at the same baseUrl.
  assert.notDeepEqual(fixture.providerMatchesCliIn['claude@official-login'], fixture.providerMatchesCliIn['claude@relay-codex-lan']);
  assert.notDeepEqual(fixture.providerMatchesCliIn['glm@zhipu-intl'], fixture.providerMatchesCliIn['codex@custom-host']);
});

test('the deliberate "visible under every CLI" cells are exactly the ones intended', () => {
  // A provider-bound window belongs to whichever CLI is bound to that provider
  // (every CLI can be pointed at any provider per session), so these cells pass
  // for every cli — including an unknown one. That is a decision, not drift: if
  // the set grows or shrinks, the reviewer has to say why.
  const all = CLIS.join(',');
  const full = Object.entries(fixture.providerMatchesCliIn).filter(([, r]) => r.join(',') === all).map(([k]) => k);
  assert.deepEqual(full, ['glm@zhipu-cn', 'glm@zhipu-intl', 'glm@zhipu-upper'], 'only a Zhipu-pointed glm window is CLI-agnostic');
  const balanceFull = Object.entries(fixture.balanceBarVisibleFor).filter(([, r]) => r.join(',') === all).map(([k]) => k);
  assert.deepEqual(balanceFull, ['deepseek', 'relay-claude', 'relay-claude-trailing', 'relay-codex-lan', 'relay-codex-tailscale'], 'only a provider the cli is actually bound to may show its own balance');
});

test('web providerMatchesCliIn matches every cell of the fixture', () => {
  const drift = [];
  for (const kind of WINDOW_KINDS) {
    for (const { label, url } of BASE_URLS) {
      const expected = fixture.providerMatchesCliIn[`${kind}@${label}`];
      const actual = CLIS.filter((cli) => api.providerMatchesCliIn(kind, cli, url));
      if (expected.join(',') !== actual.join(',')) {
        drift.push(`${kind}@${label}: fixture [${expected}] vs web [${actual}]`);
      }
    }
  }
  assert.deepEqual(drift, [], `public/chat-rate-limit.js moved; review then run scripts/generate-quota-gating-fixture.js --write\n${drift.join('\n')}`);
});

test('web balanceBarVisibleFor matches every cell of the fixture', () => {
  const drift = [];
  for (const { label, url } of BASE_URLS) {
    const expected = fixture.balanceBarVisibleFor[label];
    const actual = CLIS.filter((cli) => api.balanceBarVisibleFor(cli, url));
    if (expected.join(',') !== actual.join(',')) drift.push(`${label}: fixture [${expected}] vs web [${actual}]`);
  }
  assert.deepEqual(drift, [], `public/chat-rate-limit.js moved; review then run scripts/generate-quota-gating-fixture.js --write\n${drift.join('\n')}`);
});

test('web baseUrl traits match every cell of the fixture', () => {
  const drift = [];
  for (const { label, url } of BASE_URLS) {
    const actual = {
      host: api.hostFromBaseUrl(url),
      ark: api.isArkBaseUrl(url),
      zhipu: api.isZhipuBaseUrl(url),
      kimi: api.isKimiBaseUrl(url),
      deepseek: api.isDeepseekBaseUrl(url),
      claudeProvider: api.isClaudeProvider(url),
      relayProtocol: api.relayProtocolFromBaseUrl(url),
      arkPlan: api.arkPlanFromBaseUrl(url),
    };
    const expected = fixture.baseUrlTraits[label];
    for (const key of Object.keys(expected)) {
      if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
        drift.push(`${label}.${key}: fixture ${JSON.stringify(expected[key])} vs web ${JSON.stringify(actual[key])}`);
      }
    }
  }
  assert.deepEqual(drift, [], `public/chat-rate-limit.js moved; review then run scripts/generate-quota-gating-fixture.js --write\n${drift.join('\n')}`);
});

test('the exported one-arg wrappers read the live provider baseUrl', () => {
  // providerMatchesCli/balanceMatchesCli are the shapes the browser calls; a
  // refactor that decouples them from setProviderBaseUrl would keep the pure
  // functions green while the page shows the wrong bar, so the wiring itself is
  // asserted here. The first call of each setter is the page's identity report,
  // which kicks off the page-load refreshes — stubbed so no test hits the network.
  const realFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ status: 'ok', bars: {} }) });
  try {
    api.setCli('claude');
    api.setProviderBaseUrl('https://relay.example/claude-proxy/abc/remote');
    assert.equal(api.providerMatchesCli('claude', 'claude-exp'), true, 'borrowed claude window under claude-exp');
    assert.equal(api.providerMatchesCli('claude', 'codex'), false, 'borrowed claude window must not show under codex');
    api.setProviderBaseUrl('');
    assert.equal(api.providerMatchesCli('claude', 'codex'), false, 'official claude window under codex');
    assert.equal(api.balanceMatchesCli('codex'), true, 'the balance chip follows the cli too');
  } finally {
    global.fetch = realFetch;
  }
});
