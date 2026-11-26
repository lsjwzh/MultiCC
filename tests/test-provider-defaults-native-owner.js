'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getNative } = require('../src/native/binding');

test('native defaults owner preserves snapshots, disk bytes and write-failure ordering', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-defaults-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'defaults.json');
  fs.writeFileSync(file, JSON.stringify({ claude: 'old', codex: '', ignored: 1 }));
  const owner = new (getNative().RustProviderDefaultsStore)(file);
  let requests = 0;
  let sideEffects = 0;
  const snapshot = () => { requests++; return owner.snapshot(); };
  const persist = () => { requests++; owner.persist(); sideEffects++; };
  const replace = value => { requests++; owner.replace(value); };
  const commit = value => { requests++; owner.commit(value); sideEffects++; };
  assert.deepEqual(snapshot(), { claude: 'old', codex: null });
  const first = { claude: null, codex: 'new' };
  replace(first);
  persist();
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(first, null, 2));
  const second = { ...first, subagent: { claude: null, codex: null }, extra: '\ud800' };
  commit(second);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(second, null, 2));
  assert.deepEqual(snapshot(), second);
  assert.deepEqual({ requests, sideEffects }, { requests: 5, sideEffects: 2 });

  const invalidParent = path.join(dir, 'not-a-directory');
  fs.writeFileSync(invalidParent, 'fixture');
  const failing = new (getNative().RustProviderDefaultsStore)(path.join(invalidParent, 'defaults.json'));
  assert.throws(() => failing.commit(first), /PROVIDER_DEFAULTS_WRITE_FAILED/);
  assert.deepEqual(failing.snapshot(), { claude: null, codex: null });
  failing.replace(first);
  assert.throws(() => failing.persist(), /PROVIDER_DEFAULTS_WRITE_FAILED/);
  assert.deepEqual(failing.snapshot(), first);
});

test('isolated legacy defaults replay: 15 operations, identical snapshots and 6 writes per side', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-defaults-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = getNative();
  let operations = 0;
  let legacyWrites = 0;
  let nativeWrites = 0;
  for (const [index, initial] of [
    undefined,
    '{broken',
    JSON.stringify({ claude: 'legacy', codex: '', subagent: { claude: { providerId: ' p ', model: ' m ' } } }),
  ].entries()) {
    const left = path.join(root, `legacy-${index}.json`);
    const right = path.join(root, `native-${index}.json`);
    if (initial !== undefined) { fs.writeFileSync(left, initial); fs.writeFileSync(right, initial); }
    const legacy = { claude: null, codex: null };
    try {
      const stored = JSON.parse(fs.readFileSync(left, 'utf8'));
      legacy.claude = stored.claude || null;
      legacy.codex = stored.codex || null;
      if (Object.prototype.hasOwnProperty.call(stored, 'subagent')) {
        const normalized = JSON.parse(native.normalizeSubagentDefaults(JSON.stringify({ stored: stored.subagent })));
        legacy.subagent = { claude: normalized.claude ?? null, codex: normalized.codex ?? null };
      }
    } catch (_) { /* legacy boot tolerates missing and malformed files */ }
    const owner = new native.RustProviderDefaultsStore(right);
    const compare = () => {
      operations++;
      assert.equal(JSON.stringify(owner.snapshot()), JSON.stringify(legacy));
    };
    compare();
    const next = { ...legacy, claude: 'next' };
    operations++;
    Object.assign(legacy, next);
    owner.replace(next);
    operations++;
    fs.writeFileSync(left, JSON.stringify(legacy, null, 2)); legacyWrites++;
    owner.persist(); nativeWrites++;
    assert.equal(fs.readFileSync(right, 'utf8'), fs.readFileSync(left, 'utf8'));
    const subagent = { ...legacy, subagent: { claude: null, codex: null } };
    operations++;
    fs.writeFileSync(left, JSON.stringify(subagent, null, 2)); legacyWrites++;
    Object.assign(legacy, subagent);
    owner.commit(subagent); nativeWrites++;
    assert.equal(fs.readFileSync(right, 'utf8'), fs.readFileSync(left, 'utf8'));
    compare();
  }
  assert.deepEqual({ operations, legacyWrites, nativeWrites }, { operations: 15, legacyWrites: 6, nativeWrites: 6 });
});

test('real host HTTP calls share and persist the native defaults owner', async t => {
  const express = require('express');
  const { mountProvidersHostRoute } = require('../src/routes/providers-host');
  const { getProviderDefaultsOwner, providerDefaultsView } = require('../src/providers/defaults-port');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-defaults-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'defaults.json');
  fs.writeFileSync(file, '{"claude":"old","codex":null}');
  const owner = getProviderDefaultsOwner(file);
  assert.equal(getProviderDefaultsOwner(file), owner);
  const defaults = providerDefaultsView(owner);
  let writes = 0;
  const noop = () => null;
  const providers = Object.fromEntries(['getCcSwitchStatus', 'listProviders', 'getProviderUsageStats',
    'importFromCcSwitch', 'createProvider', 'updateProvider', 'deleteProvider', 'getProvider',
    'probeRelayModels', 'claudeProbeRouteEnv'].map(key => [key, noop]));
  const shares = Object.fromEntries(['create', 'list', 'getCredential', 'revoke', 'revokeProvider'].map(key => [key, noop]));
  const app = express();
  app.use(express.json());
  mountProvidersHostRoute(app, {
    providers, providerRouterRuntime: { getProviderSummary: noop }, providerDefaults: defaults, defaultsOwner: owner,
    providerRelayShares: shares, claudeCmd: 'fixture', findProviderReferences: noop, getAuxConfig: noop, getPort: noop,
    validProviderId: (_cli, id) => ({ ok: true, value: id }),
    saveProviderDefaults: () => { owner.persist(); writes++; return true; }, isLocal: () => true,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/__host/providers`;
  const post = async body => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.text();
  };
  assert.equal(await post({ op: 'defaultsGet' }), '{"ok":true,"defaults":{"claude":"old","codex":null}}');
  assert.equal(await post({ op: 'normalizeId', cli: 'claude', id: 'new' }), '{"ok":true,"id":"new"}');
  assert.equal(await post({ op: 'providerSummary', appType: 'claude', id: 'new' }), '{"ok":true,"summary":null}');
  assert.equal(await post({ op: 'defaultsPersist', next: { claude: 'new' } }), '{"ok":true,"defaults":{"claude":"new","codex":null}}');
  assert.equal(defaults.claude, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ claude: 'new', codex: null }, null, 2));
  assert.equal(writes, 1);
});
