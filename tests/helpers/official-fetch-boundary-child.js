'use strict';
// A fresh CommonJS cache per scenario; no supplier request or credentials.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const [mode, scenario] = process.argv.slice(2);
const outbound = require('../../src/network/outbound');
const policy = require('../../src/native/binding').proxyPolicy;
const close = outbound.close;
const relayPath = require.resolve('../../src/codex/official-relay');
const legacyPath = require.resolve('./legacy-official-fetch-entry');
const trace = [];
const fetchA = () => {};
const fetchB = () => {};
const factoryResult = Object.assign(() => {}, { close() {} });
const options = { fixture: true };
let selectedFetch = scenario === 'undefined' ? undefined : fetchA;
let throwOnRead = scenario === 'failed-load';
let selectedFactory = value => { assert.equal(value, options); trace.push('factory-A'); return { outboundFetch: factoryResult }; };
let selectedParser = value => { assert.equal(value, 'fixture'); trace.push('parser-A'); return { httpProxy: 'http-A', httpsProxy: 'https-A', socksProxy: 'must-be-omitted', exceptions: ['omit'] }; };
if (process.env.MULTICC_TEST_OFFICIAL_FETCH_EAGER_MUTANT === '1') {
  Object.defineProperty(outbound, 'official', { value: require(legacyPath), configurable: true });
}
Object.defineProperty(outbound, 'outboundFetch', { configurable: true, enumerable: true, get() {
  trace.push('fetch-read');
  if (throwOnRead) throw new Error('fixture dependency read failed');
  return selectedFetch;
} });
Object.defineProperty(outbound, 'createOutbound', { configurable: true, enumerable: true, get() {
  trace.push('factory-read'); return selectedFactory;
} });
Object.defineProperty(policy, 'parseMacSystemProxy', { configurable: true, enumerable: true, get() {
  trace.push('parser-read'); return selectedParser;
} });
const loadEntry = () => mode === 'legacy' ? require(legacyPath) : outbound.official;
const previousLoad = Module._load;
Module._load = function (request, parent, ...args) {
  if (parent?.filename === relayPath) {
    // The frozen old seam and its replacement both use the real relay body.
    if (request === '../network/official-fetch') return loadEntry();
    if (request === '../network/outbound' && mode === 'legacy') return { get official() { return loadEntry(); } };
  }
  return previousLoad.call(this, request, parent, ...args);
};
async function main() {
  let create = require(relayPath).createCodexOfficialRelayHandler;
  assert.deepEqual(trace, [], 'importing the relay must not initialize the official entry');
  assert.equal(Object.keys(outbound).includes('official'), false, 'unrelated SDK export enumeration must not expose the lazy seam');
  create({ getProvider: () => null, fetch: fetchB });
  assert.deepEqual(trace, [], 'an injected fetch must not read the default SDK entry');
  if (scenario === 'failed-load') {
    assert.throws(() => create({ getProvider: () => null }), /fixture dependency read failed/);
    assert.deepEqual(trace, ['factory-read', 'fetch-read']);
    throwOnRead = false;
  }
  if (scenario === 'undefined') {
    assert.throws(() => create({ getProvider: () => null }), /fetch required/);
    selectedFetch = fetchB;
    assert.throws(() => create({ getProvider: () => null }), /fetch required/, 'a captured undefined value must remain cached');
    assert.equal(loadEntry().officialFetch, undefined);
  } else {
    create({ getProvider: () => null });
    assert.equal(loadEntry().officialFetch, fetchA);
  }
  const first = loadEntry();
  const expected = scenario === 'failed-load'
    ? ['factory-read', 'fetch-read', 'factory-read', 'fetch-read', 'parser-read']
    : ['factory-read', 'fetch-read', 'parser-read'];
  assert.deepEqual(trace, expected, 'first use must capture the same exports in the same order');
  selectedFetch = fetchB;
  selectedFactory = () => { throw new Error('replacement factory must not be read'); };
  selectedParser = () => { throw new Error('replacement parser must not be read'); };
  assert.equal(loadEntry(), first);
  assert.equal(first.createOfficialFetch(options), factoryResult);
  assert.equal(first.createOfficialFetch(options).close, factoryResult.close);
  assert.deepEqual(first.parseMacProxy('fixture'), { httpProxy: 'http-A', httpsProxy: 'https-A' });
  delete require.cache[relayPath];
  create = require(relayPath).createCodexOfficialRelayHandler;
  if (scenario === 'undefined') assert.throws(() => create({ getProvider: () => null }), /fetch required/);
  else create({ getProvider: () => null });
  create({ getProvider: () => null, fetch: fetchB });
  assert.equal(loadEntry(), first, 'reloading the consumer must not reset the official entry');
  assert.deepEqual(trace, [...expected, 'factory-A', 'factory-A', 'parser-A']);
  process.stdout.write(JSON.stringify({ scenario, trace, singleton: true, injectedFetchLazy: true, consumerReloadStable: true, closeIdentity: true }) + '\n');
}
main().finally(() => { Module._load = previousLoad; return close(); }).catch(error => {
  process.stderr.write(error.stack + '\n'); process.exitCode = 1;
});
