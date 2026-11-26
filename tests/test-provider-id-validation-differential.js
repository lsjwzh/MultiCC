'use strict';

// Differential: the retired JavaScript rules for the ⑤ segment of
// `validProviderId` (protocol compatibility table, CLI→pool map,
// `providerSupportsCli`) versus the Rust kernel now behind
// `getNative().providerValidateId`, reached through the very function the eight
// production consumers call: `createProviderRoutes(...).validProviderId`.
//
// The oracle is `tests/helpers/legacy-provider-cli-rules.js`, frozen from
// `git show HEAD:src/providers/core.js` before the Node side was changed. Both
// sides run the same corpus of cli × id × store and must agree on:
//
//   1. the return value (deepStrictEqual and its JSON bytes),
//   2. the `normalizeOfficialProviderId` call sequence,
//   3. the `getProviderSummary` call sequence (arguments AND order).
//
// The two fake facts also count their calls, so "the answer matched" can never
// be satisfied by a side that skipped the lookup the other one made.
//
// Coverage is asserted per branch (①empty ②vendor-native ③opencode-native
// ④no-pool ⑤missing summary ⑥incompatible ⑦accepted) so an empty corpus or a
// dead side cannot make this file green for the wrong reason.
//
// The mutation block at the bottom breaks the oracle three ways and proves each
// break turns the comparison red. That is what makes a green run meaningful.
//
// Hermetic and deterministic: no network, no clock, no files (the defaults
// owner writes to a per-process temp dir through the shared fixture).

const assert = require('node:assert/strict');
const test = require('node:test');

const { createProviderRoutes } = require('../src/routes/providers');
const legacy = require('./helpers/legacy-provider-cli-rules');
const { fixtureDefaultsOwner } = require('./helpers/provider-defaults-owner');
const { nativeVendorOf } = require('../src/providers/native-vendor');
const { NATIVE_OPENCODE_ID, nativeOpenCodeId } = require('./helpers/frozen-native-opencode');

// ── corpus ──────────────────────────────────────────────────────────────────
const CLIS = [
  'claude', 'codex', 'claude-exp', 'codex-exp', 'opencode', 'zcode',
  'kimi', 'dsh', 'grok', 'workbuddy', 'qoder', 'gemini', 'agy', '', null, undefined, 123,
];

const IDS = [
  null, undefined, '', 'x', 'claude-native:x', 'codex-native:x',
  // vendor-native lanes come from VENDOR_NATIVE_CLIS (qoder/codebuddy/gemini/pi/
  // commandcode/dsh/grok); `claude-native:x` above is deliberately NOT one, so a
  // lane-shaped-but-unknown prefix stays on the store path.
  'qoder-native:qoder', 'qoder-native:x', 'qoder-native:', 'dsh-native:x',
  'gemini-native:gemini', 'agy-native:agy', 'grok-native:grok', 'codebuddy-native:c',
  'pi-native:p', 'commandcode-native:c',
  'opencode-native:ok-1', 'opencode-native:-bad', `opencode-native:${'x'.repeat(65)}`,
  'a-native:b', 0, 123, true, {},
  'official-alias', 'official-canonical',
  'anthropic-token', 'anthropic-no-token', 'openai-token', 'openai-no-token',
  'virtual-pool', 'dual-pool', 'missing-id',
];

// `getProviderSummary` answers from these rows. The three stores differ in what
// exists and in which pool an id lives, which is the whole point of the ⑤
// segment: a global-pool CLI must find a codex row, a single-pool CLI must not.
const STORES = [
  {
    name: 'mixed',
    rows: [
      { appType: 'claude', id: 'anthropic-token', apiFormat: 'anthropic', protocol: 'anthropic', baseUrl: 'https://a.example', hasToken: true },
      { appType: 'claude', id: 'anthropic-no-token', apiFormat: 'anthropic', protocol: 'anthropic', baseUrl: 'https://a.example', hasToken: false },
      { appType: 'codex', id: 'openai-token', apiFormat: 'openai_responses', protocol: 'openai_responses', baseUrl: 'https://c.example', hasToken: true },
      { appType: 'codex', id: 'openai-no-token', apiFormat: 'openai_responses', protocol: 'openai_responses', baseUrl: '', hasToken: false },
      { appType: 'claude', id: 'virtual-pool', apiFormat: 'anthropic', protocol: 'anthropic', virtual: true, baseUrl: '', hasToken: false },
      { appType: 'codex', id: 'dual-pool', apiFormat: 'openai_responses', protocol: 'openai_responses', baseUrl: 'https://d.example', hasToken: true },
      { appType: 'claude', id: 'official-canonical', apiFormat: 'anthropic', protocol: 'anthropic', baseUrl: '', hasToken: false },
    ],
  },
  {
    name: 'empty',
    rows: [],
  },
  {
    // Same id in both pools: the global lookup must pick one, the single-pool
    // lookup must pick its own, and a protocol mismatch must reject.
    name: 'conflicting',
    rows: [
      { appType: 'claude', id: 'dual-pool', apiFormat: 'anthropic', protocol: 'anthropic', baseUrl: 'https://claude.example', hasToken: true },
      { appType: 'codex', id: 'dual-pool', apiFormat: 'openai_responses', protocol: 'openai_responses', baseUrl: '', hasToken: false },
      { appType: 'claude', id: 'anthropic-token', apiFormat: 'openai_responses', protocol: 'openai_responses', baseUrl: 'https://mismatch.example', hasToken: true },
    ],
  },
];

// Official-id normalization: the alias folds onto the canonical id, everything
// else is the identity. `codex-exp`/`claude-exp` folding is the caller's job.
function normalizeOfficialProviderId(cli, id) {
  if (id === 'official-alias') return 'official-canonical';
  return id;
}

// Real `getProviderSummary(appType, id)` semantics: a global lookup
// (appType === undefined) walks both pools, a scoped one only its own.
function lookupSummary(store, appType, id) {
  const text = String(id);
  const match = store.rows.find(row => row.id === text
    && (appType === undefined || appType === null || row.appType === appType));
  if (!match) return null;
  return {
    id: match.id,
    appType: match.appType,
    apiFormat: match.apiFormat,
    protocol: match.protocol,
    virtual: !!match.virtual,
    baseUrl: match.baseUrl,
    hasToken: match.hasToken,
  };
}

function createFixture(store) {
  const calls = { normalize: [], summary: [] };
  // A sink swap lets the native path record into `calls` and the legacy oracle
  // record into its own hooks, so both sequences are the exact call order.
  let sink = calls;
  const providers = {
    normalizeOfficialProviderId(cli, id) {
      sink.normalize.push(['normalize', cli, id]);
      return normalizeOfficialProviderId(cli, id);
    },
    // These three are what the ⑤ rules used to ask the host for. Reaching them
    // from the native validator would mean the rules were not actually moved.
    appTypeForCli() { throw new Error('validProviderId asked the host for appTypeForCli'); },
    appTypesForCli() { throw new Error('validProviderId asked the host for appTypesForCli'); },
    providerSupportsCli() { throw new Error('validProviderId asked the host for providerSupportsCli'); },
  };
  const providerRouterRuntime = {
    getProviderSummary(appType, id) {
      sink.summary.push(['summary', appType, String(id)]);
      return lookupSummary(store, appType, id);
    },
  };
  const deps = createDeps(providers, providerRouterRuntime);
  const routes = createProviderRoutes(deps);
  // Route construction normalizes the two defaults owners through the same
  // fake; that is setup, not a case.
  calls.normalize.length = 0;
  calls.summary.length = 0;
  return {
    deps,
    validProviderId: (cli, id) => routes.validProviderId(cli, id),
    startNative() { sink = calls; calls.normalize.length = 0; calls.summary.length = 0; },
    startLegacy() { sink = { normalize: [], summary: [] }; calls.normalize.length = 0; calls.summary.length = 0; },
    calls,
  };
}

function createDeps(providers, providerRouterRuntime) {
  const noop = () => null;
  const deps = {
    providerDefaultsFile: '/virtual/provider-defaults.json',
    claudeCmd: '/opt/multicc/claude',
    providers,
    providerRouterRuntime,
    findProviderReferences: () => [],
    getAuxConfig: () => ({ protocol: 'anthropic', providerId: null }),
    getPort: () => 4321,
    persistedSessions: new Map(),
    providerRelayShares: {
      create: noop, list: () => [], getCredential: noop, revoke: noop, revokeProvider: noop,
    },
    logger: { error() {}, warn() {} },
    now: () => 1,
    isLocalRequest: () => true,
  };
  deps.providerDefaultsOwner = fixtureDefaultsOwner({
    fs: { readFileSync: () => '{}' },
    providerDefaultsFile: deps.providerDefaultsFile,
    atomicWriteJson() {},
  });
  return deps;
}

// Which branch of the ⑤ pipeline a case lands in, computed from the frozen
// oracle's own primitives so the classification cannot drift from it.
function classify(store, cli, id) {
  const current = normalizeOfficialProviderId(cli, id);
  if (current == null || current === '') return 'empty';
  if (nativeVendorOf(current) !== null) return 'vendor-native';
  const openCodeNative = nativeOpenCodeId(current);
  if (openCodeNative !== null) return 'opencode-native';
  const appTypes = legacy.appTypesForCli(cli);
  if (!appTypes.length) return 'no-pool';
  const pool = appTypes.length > 1 ? undefined : legacy.appTypeForCli(cli);
  const summary = lookupSummary(store, pool, current);
  if (!summary) return 'missing-summary';
  return legacy.providerSupportsCli(summary, cli) ? 'accepted' : 'incompatible';
}

function label(cli, id) {
  const cliText = cli === undefined ? '<undefined>' : JSON.stringify(cli);
  let idText;
  try { idText = typeof id === 'string' ? JSON.stringify(id) : String(id); }
  catch (_) { idText = '<id>'; }
  return `${cliText} / ${idText}`;
}

test('native validProviderId matches the frozen JS rules on every corpus case', async (t) => {
  const stats = {
    requests: 0, byteIdentical: 0, rejected: 0, accepted: 0,
    sideEffects: 0, legacySideEffects: 0,
    branches: Object.create(null),
    perStore: Object.create(null),
  };
  const missing = { 'empty': [], 'vendor-native': [], 'opencode-native': [], 'no-pool': [],
    'missing-summary': [], 'incompatible': [], 'accepted': [] };

  for (const store of STORES) {
    const fixture = createFixture(store);
    const storeStats = { requests: 0, identical: 0, rejected: 0, accepted: 0 };
    for (const cli of CLIS) {
      for (const id of IDS) {
        stats.requests++;
        storeStats.requests++;
        const name = label(cli, id);

        fixture.startNative();
        const actual = fixture.validProviderId(cli, id);
        const nativeCalls = { normalize: fixture.calls.normalize.slice(), summary: fixture.calls.summary.slice() };

        fixture.startLegacy();
        const legacyHooks = { normalize: [], summary: [] };
        const expected = legacy.legacyValidProviderId(fixture.deps, cli, id, legacyHooks);

        assert.deepEqual(actual, expected, `value ${store.name} ${name}`);
        assert.equal(JSON.stringify(actual), JSON.stringify(expected), `bytes ${store.name} ${name}`);
        assert.deepEqual(nativeCalls, legacyHooks, `side-effect sequence ${store.name} ${name}`);

        stats.byteIdentical++;
        storeStats.identical++;
        stats.sideEffects += nativeCalls.normalize.length + nativeCalls.summary.length;
        stats.legacySideEffects += legacyHooks.normalize.length + legacyHooks.summary.length;
        if (expected.ok) { stats.accepted++; storeStats.accepted++; } else { stats.rejected++; storeStats.rejected++; }

        const branch = classify(store, cli, id);
        stats.branches[branch] = (stats.branches[branch] || 0) + 1;
        missing[branch].push(`${store.name} ${name}`);
      }
    }
    stats.perStore[store.name] = storeStats;
  }

  // ── coverage: an empty differential must not be green ────────────────────
  const minimums = {
    'empty': 144, 'vendor-native': 432, 'opencode-native': 144, 'no-pool': 357,
    'missing-summary': 390, 'incompatible': 23, 'accepted': 46,
  };
  for (const [branch, minimum] of Object.entries(minimums)) {
    assert.ok((stats.branches[branch] || 0) >= minimum,
      `branch ${branch} only hit ${stats.branches[branch] || 0} times (need ${minimum}); examples of what is missing: ${JSON.stringify(missing[branch].slice(0, 5))}`);
  }

  assert.equal(stats.byteIdentical, stats.requests);
  assert.equal(stats.sideEffects, stats.legacySideEffects);
  assert.ok(stats.requests > 1500, `corpus too small: ${stats.requests}`);
  assert.ok(stats.rejected > 0 && stats.accepted > 0);

  t.diagnostic(`requests=${stats.requests} byteIdentical=${stats.byteIdentical} `
    + `sideEffects=${stats.sideEffects} (legacy ${stats.legacySideEffects}) `
    + `rejected=${stats.rejected} accepted=${stats.accepted} `
    + `branches=${JSON.stringify(stats.branches)} perStore=${JSON.stringify(stats.perStore)}`);
});

// ── mutation verification ───────────────────────────────────────────────────
// The three breaks below are injected on the oracle side of the comparison
// (the native code is untouched). Each one must produce a difference, which is
// the only evidence that the green run above is actually comparing something.
// `oracleFlow` is the frozen 5-segment pipeline with explicit injection points,
// kept in this file so a break is a mock, never a source edit.
const MUTATIONS = {
  // ① a CREDENTIAL_GATED CLI is let through without baseUrl+token (the protocol
  //    table and the virtual rule stay intact, so only the token gate breaks).
  gatedWithoutToken: {
    supports: (summary, cli) => {
      const text = String(cli);
      if (summary.virtual || !legacy.CREDENTIAL_GATED_CLIS.has(text)) {
        return legacy.providerSupportsCli(summary, cli);
      }
      const format = legacy.normalizeApiFormat(summary.apiFormat || summary.protocol, summary.appType);
      return legacy.compatibleClisForFormat(format).includes(text);
    },
  },
  // ② `opencode-native:` ids are accepted on any lane, not just opencode.
  opencodeNativeAnyLane: { opencodeLane: () => true },
  // ③ the store summary is consulted even when the pool rule already rejected.
  summaryOnEarlyBranches: { summaryOnEarlyBranches: true },
};

function oracleFlow(deps, cli, id, hooks, overrides = {}) {
  const appType = legacy.appTypeForCli(cli);
  if (typeof deps.providers.normalizeOfficialProviderId === 'function') {
    const normalizedCli = cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli;
    hooks.normalize.push(['normalize', normalizedCli, id]);
    id = deps.providers.normalizeOfficialProviderId(normalizedCli, id);
  }
  if (id == null || id === '') return { ok: true, value: null };
  const nativeVendor = nativeVendorOf(id);
  if (nativeVendor !== null) {
    return cli === nativeVendor.cli ? { ok: true, value: String(id) } : { ok: false };
  }
  const openCodeNative = nativeOpenCodeId(id);
  if (openCodeNative !== null) {
    const laneOk = overrides.opencodeLane ? overrides.opencodeLane(cli) : cli === 'opencode';
    return laneOk && NATIVE_OPENCODE_ID.test(openCodeNative)
      ? { ok: true, value: String(id) } : { ok: false };
  }
  const appTypes = legacy.appTypesForCli(cli);
  if (!appTypes.length) {
    if (overrides.summaryOnEarlyBranches) {
      hooks.summary.push(['summary', undefined, String(id)]);
      deps.providerRouterRuntime.getProviderSummary(undefined, String(id));
    }
    return { ok: false };
  }
  const pool = appTypes.length > 1 ? undefined : appType;
  hooks.summary.push(['summary', pool, String(id)]);
  const summary = deps.providerRouterRuntime.getProviderSummary(pool, String(id));
  const compatible = overrides.supports
    ? (summary && overrides.supports(summary, cli))
    : (summary && legacy.providerSupportsCli(summary, cli));
  if (!compatible) return { ok: false };
  return { ok: true, value: String(id) };
}

function runMutation(overrides) {
  let differences = 0;
  for (const store of STORES) {
    const fixture = createFixture(store);
    for (const cli of CLIS) {
      for (const id of IDS) {
        fixture.startNative();
        const actual = fixture.validProviderId(cli, id);
        const nativeCalls = { normalize: fixture.calls.normalize.slice(), summary: fixture.calls.summary.slice() };
        fixture.startLegacy();
        const hooks = { normalize: [], summary: [] };
        const expected = oracleFlow(fixture.deps, cli, id, hooks, overrides);
        // A break counts when either axis diverges: the answer or the calls.
        if (JSON.stringify(actual) !== JSON.stringify(expected)
            || JSON.stringify(nativeCalls) !== JSON.stringify(hooks)) {
          differences++;
        }
      }
    }
  }
  return differences;
}

test('each injected rule break turns the differential red', (t) => {
  for (const [mutation, overrides] of Object.entries(MUTATIONS)) {
    const differences = runMutation(overrides);
    assert.ok(differences > 0, `mutation ${mutation} was not caught`);
    t.diagnostic(`mutation ${mutation}: ${differences} differences`);
  }
});

test('OpenCode catalog matches the frozen provider, coercion order and mutability', () => {
  const actual = require('../src/native/binding').getNativeOpenCodeCatalog();
  const frozenFile = require.resolve('./helpers/frozen-native-opencode.js');
  const frozen = require(frozenFile);
  const source = require('node:fs').readFileSync(frozenFile);
  const hash = require('node:crypto').createHash('sha1').update('blob ' + source.length + '\0').update(source);
  assert.equal(hash.digest('hex'), 'cd60a9160fcee6544911a20db766edfa0dd8d109');
  assert.equal(actual.NATIVE_OPENCODE_PREFIX, frozen.NATIVE_OPENCODE_PREFIX);
  assert.equal(actual.NATIVE_OPENCODE_ID.source, frozen.NATIVE_OPENCODE_ID.source);
  assert.equal(actual.NATIVE_OPENCODE_ID.flags, frozen.NATIVE_OPENCODE_ID.flags);
  const ids = [null, undefined, '', 'opencode', 'opencodego', 'opencode-go', 'third-party', 10, true,
    'constructor', 'toString', '__proto__', 'a'.repeat(64), 'a'.repeat(65), 'opencode-native:', 'opencode-native:\ud800', Symbol('s')];
  const opts = [undefined, null, 'bad', {}, [], [' o/m ', 'o/m', null, false, 0, '', Symbol('opt')], Array(3), ['\ufeff', '\udfff']];
  const trace = (api, rawId, models, wrapped) => {
    const calls = [], sentinel = {};
    const id = wrapped ? {
      [Symbol.toPrimitive](hint) {
        calls.push(hint);
        if (typeof rawId === 'symbol') throw sentinel;
        return rawId;
      },
    } : rawId;
    function capture(f) {
      try { return { result: f() }; }
      catch (e) { return { thrown: e === sentinel ? 'sentinel' : [e.name, e.message] }; }
    }
    const nativeId = capture(() => api.nativeOpenCodeId(id));
    const name = capture(() => api.nativeOpenCodeName(id));
    const entry = capture(() => {
      const data = api.syntheticNativeOpenCodeProvider(id, models);
      if (api === actual) assert.equal(data.appType, 'opencode');
      return { sameNativeId: Object.is(data.nativeProvider, id), fields: Object.keys(data).filter(key => key !== 'appType'), id: data.id, name: data.name, model: data.model,
        options: data.modelOptions, frozen: Object.isFrozen(data), optionsFrozen: Object.isFrozen(data.modelOptions), native: data.nativeOpenCode };
    });
    return { nativeId, name, entry, calls };
  };
  for (const id of ids) for (const models of opts) for (const wrapped of [false, true]) {
    assert.deepEqual(trace(actual, id, models, wrapped), trace(frozen, id, models, wrapped));
  }
});

test('OpenCode catalog preserves custom model arrays, exceptions and the iteration order', () => {
  const actual = require('../src/native/binding').getNativeOpenCodeCatalog();
  const old = require('./helpers/frozen-native-opencode');
  function trace(api, fail) {
    const events = [];
    const sentinel = {};
    const opaque = {};
    const models = [];
    models.map = function (convert) {
      assert.equal(this, models);
      events.push(['map', convert(null), convert(false), convert(' x '), convert(Symbol('m'))]);
      return { filter(predicate) {
        events.push(['filter', predicate === Boolean, predicate(''), predicate(1)]);
        if (fail) throw sentinel;
        return (function* () { events.push('iterate'); yield opaque; yield opaque; yield 'y'; })();
      } };
    };
    const id = { [Symbol.toPrimitive](hint) { events.push(hint); return 'vendor'; } };
    try {
      const entry = api.syntheticNativeOpenCodeProvider(id, models);
      assert.equal(entry.modelOptions[0], opaque);
      assert.equal(entry.model, opaque);
      assert.equal(entry.nativeProvider, id);
      events.push(entry.id, entry.modelOptions.length, entry.modelOptions[1], entry.name);
    } catch (e) {
      if (e !== sentinel) throw e;
      events.push('same thrown object');
    }
    return events;
  }
  for (const fail of [false, true]) assert.deepEqual(trace(actual, fail), trace(old, fail));
});
