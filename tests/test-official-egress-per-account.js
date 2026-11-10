'use strict';

// The egress-IP allowlist of an official provider entry must be pinned to the
// entry being edited: the terminal alias keeps its own override record and each
// account entry gets its own. A vendor-wide shared record would silently force
// an unrestricted account through an allowlist it never configured (and refuse
// it when the host's egress IP changed) — the exact regression this file pins.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-official-egress-'));
const SAVED_ENV = { HOME: process.env.HOME, MULTICC_DATA_DIR: process.env.MULTICC_DATA_DIR };
process.env.HOME = path.join(root, 'home');
process.env.MULTICC_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });

// One managed Claude account so the per-account provider id survives
// normalize() instead of folding back onto the terminal alias.
const ACCOUNT_ID = 'aaaaaaaaaaaaaaaa';
const accountsDir = path.join(process.env.HOME, '.multicc', 'official-accounts', 'claude');
fs.mkdirSync(accountsDir, { recursive: true });
fs.writeFileSync(path.join(accountsDir, `${ACCOUNT_ID}.json`),
  JSON.stringify({ label: 'share', source: 'login', createdAt: 1 }));

const providers = require('../src/providers/core');
providers.enableUnifiedOfficialProviders();

const TERMINAL_ID = 'claude-official';
const ACCOUNT_PROVIDER_ID = `claude-official-${ACCOUNT_ID}`;
const storeFile = path.join(process.env.MULTICC_DATA_DIR, 'providers.json');
const storeRecords = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));

test.after(() => {
  process.env.HOME = SAVED_ENV.HOME;
  if (SAVED_ENV.MULTICC_DATA_DIR === undefined) delete process.env.MULTICC_DATA_DIR;
  else process.env.MULTICC_DATA_DIR = SAVED_ENV.MULTICC_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

test('editing an account entry writes its own override record, never the terminal one', () => {
  providers.updateProvider('claude', ACCOUNT_PROVIDER_ID, { egressIpAllowlist: ['1.2.3.4'] });

  const account = providers.getProvider('claude', ACCOUNT_PROVIDER_ID);
  assert.deepEqual(account.egressIpAllowlist, ['1.2.3.4'], 'the edited entry carries the allowlist');
  assert.equal(providers.getProvider('claude', TERMINAL_ID).egressIpAllowlist, undefined,
    'the terminal alias stays unrestricted');

  const record = storeRecords().find(p => p.id === ACCOUNT_PROVIDER_ID);
  assert.ok(record, 'a per-account override record lands in the store');
  assert.deepEqual(record.egressIpAllowlist, ['1.2.3.4']);
  assert.equal(storeRecords().filter(p => p.id === TERMINAL_ID).length, 0,
    'no vendor-wide record is created behind the user\'s back');
});

test('editing the terminal alias does not leak its allowlist onto account entries', () => {
  providers.updateProvider('claude', TERMINAL_ID, { egressIpAllowlist: ['5.6.7.8'] });

  assert.deepEqual(providers.getProvider('claude', TERMINAL_ID).egressIpAllowlist, ['5.6.7.8']);
  assert.deepEqual(providers.getProvider('claude', ACCOUNT_PROVIDER_ID).egressIpAllowlist, ['1.2.3.4'],
    'the account entry keeps exactly what it configured');
});

test('clearing an account entry removes only its own override record', () => {
  providers.updateProvider('claude', ACCOUNT_PROVIDER_ID, { egressIpAllowlist: [] });

  assert.equal(providers.getProvider('claude', ACCOUNT_PROVIDER_ID).egressIpAllowlist, undefined);
  assert.equal(storeRecords().find(p => p.id === ACCOUNT_PROVIDER_ID), undefined,
    'the pure stub is dropped once empty');
  assert.deepEqual(providers.getProvider('claude', TERMINAL_ID).egressIpAllowlist, ['5.6.7.8'],
    'the terminal allowlist survives untouched');
});

test('allowlist override records never surface as duplicate providers', () => {
  providers.updateProvider('claude', ACCOUNT_PROVIDER_ID, { egressIpAllowlist: ['1.2.3.4'] });
  // The account itself is not logged in, so its synthetic row is not listed —
  // but its override record must not leak in as a provider of its own either.
  const ids = providers.listProviders('claude').map(p => p.id);
  assert.equal(ids.filter(id => id === TERMINAL_ID).length, 1);
  assert.equal(ids.indexOf(ACCOUNT_PROVIDER_ID), -1);
});

// ── 专用出口（每个账号一条 VPN 出口）────────────────────────────────────────
//
// The binding rides on the same per-entry override record as the allowlist, and
// it is what the proxy's resolveUpstreamAgent hook reads off the route's provider
// (src/claude-auth/egress-agent.js). Both must stay scoped to the edited entry: a
// shared record would silently move every account onto one exit IP.

const BINDING = { pluginId: 'chrome-proxy-launcher', profileId: 'us-home' };

test('a dedicated egress binding stays on its own entry and reaches the hop untouched', () => {
  providers.updateProvider('claude', ACCOUNT_PROVIDER_ID, { egressBinding: BINDING });

  assert.deepEqual(providers.getProvider('claude', ACCOUNT_PROVIDER_ID).egressBinding, BINDING);
  assert.equal(providers.getProvider('claude', TERMINAL_ID).egressBinding, undefined,
    'the terminal alias is not moved onto this account\'s exit');
  const record = storeRecords().find(p => p.id === ACCOUNT_PROVIDER_ID);
  assert.deepEqual(record.egressBinding, BINDING);

  // The hop's view carries the binding but stays base-less: the route keeps the
  // proxy's official branch (account credential, 401 recovery), and only the
  // dial goes out through the egress.
  const view = providers.routingProviderView('claude', ACCOUNT_PROVIDER_ID);
  assert.deepEqual(view.egressBinding, BINDING);
  assert.equal(view.settingsConfig.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(providers.routingProviderView('claude', TERMINAL_ID).egressBinding, undefined);
});

test('binding-only patches never clear the allowlist, and clearing the binding spares the rest', () => {
  providers.updateProvider('claude', ACCOUNT_PROVIDER_ID, { egressIpAllowlist: ['9.9.9.9'] });
  // A PATCH that only carries the binding (no egressIpAllowlist key) must leave
  // the allowlist alone.
  providers.updateProvider('claude', ACCOUNT_PROVIDER_ID, { egressBinding: BINDING });
  assert.deepEqual(providers.getProvider('claude', ACCOUNT_PROVIDER_ID).egressIpAllowlist, ['9.9.9.9']);

  providers.updateProvider('claude', ACCOUNT_PROVIDER_ID, { egressBinding: null });
  const account = providers.getProvider('claude', ACCOUNT_PROVIDER_ID);
  assert.equal(account.egressBinding, undefined);
  assert.deepEqual(account.egressIpAllowlist, ['9.9.9.9'], 'the allowlist override survives');
  assert.ok(storeRecords().find(p => p.id === ACCOUNT_PROVIDER_ID),
    'the record stays because it still carries the allowlist');
});

test('a dedicated egress cannot be bound to a non-official line', () => {
  providers.createProvider({
    appType: 'claude', name: 'Local relay', baseUrl: 'https://relay.test',
    authToken: 'sk-test', apiFormat: 'anthropic',
  });
  const local = providers.listProviders('claude').find(p => p.name === 'Local relay');
  assert.throws(() => providers.updateProvider('claude', local.id, { egressBinding: BINDING }),
    /官方账号/);
  assert.throws(() => providers.createProvider({
    appType: 'claude', name: 'Another relay', baseUrl: 'https://relay.test',
    authToken: 'sk-test', egressBinding: BINDING,
  }), /官方账号/);
});

test('deleting the account drops its override record along with it', () => {
  assert.equal(providers.deleteProvider('claude', ACCOUNT_PROVIDER_ID), true);
  assert.equal(storeRecords().find(p => p.id === ACCOUNT_PROVIDER_ID), undefined,
    'no orphaned restriction record outlives the account');
  assert.deepEqual(providers.getProvider('claude', TERMINAL_ID).egressIpAllowlist, ['5.6.7.8']);
});

// 登录换码发生在新账号还没登录的时候：此刻 provider 行是 needsLogin 的合成行，
// 绑定必须已经能从这里读出来，否则换码就拿不到出口、只能走本机网络。
test('an account that has not signed in yet still exposes the egress picked at creation', () => {
  const PENDING = 'bbbbbbbbbbbbbbbb';
  fs.writeFileSync(path.join(accountsDir, `${PENDING}.json`), JSON.stringify({ label: 'pending', createdAt: 2 }));
  const providerId = `claude-official-${PENDING}`;
  providers.updateProvider('claude', providerId, { egressBinding: BINDING });
  const row = providers.getProvider('claude', providerId);
  assert.ok(row, 'the pending account has a provider view');
  assert.equal(row.needsLogin, true);
  assert.deepEqual(row.egressBinding, BINDING);
});
