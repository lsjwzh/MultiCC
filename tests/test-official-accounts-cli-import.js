'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialAccountStore } = require('../src/official-accounts');
const { createCliLoginImporter } = require('../src/official-accounts-cli-import');
const { createClaudeAccountCredentialService } = require('../src/claude-auth/account-credentials');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 3600 * 1000;
const jwt = payload => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-import-'));
  const accounts = createOfficialAccountStore({ root: path.join(dir, 'store') });
  const codexAuthFile = path.join(dir, 'codex-home', 'auth.json');
  fs.mkdirSync(path.dirname(codexAuthFile), { recursive: true });
  const state = {
    claude: { ok: true, accessToken: 'cli-at', refreshToken: 'cli-rt', expiresAt: NOW + HOUR },
    profile: { email: 'me@example.com', account_uuid: 'uuid-1', organization_uuid: 'org', organization_name: 'Org' },
    profileCalls: [],
  };
  const writeCodex = (auth) => fs.writeFileSync(codexAuthFile, JSON.stringify(auth));
  const importer = createCliLoginImporter({
    accounts, codexAuthFile, now: () => NOW,
    readClaudeCli: async () => state.claude,
    fetchProfile: async (_f, token) => { state.profileCalls.push(token); return state.profile; },
  });
  return { dir, accounts, importer, state, writeCodex, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const codexAuth = (email, accountId = 'acct-1', exp = NOW / 1000 + 3600) => ({
  auth_mode: 'chatgpt', OPENAI_API_KEY: null,
  tokens: { id_token: jwt({ email }), access_token: jwt({ exp }), refresh_token: 'rt', account_id: accountId },
});

test('the CLI login is imported into the store as an ordinary account, once', async () => {
  const t = setup();
  try {
    t.writeCodex(codexAuth('me@example.com'));
    const first = await t.importer.importOnce();
    assert.equal(first.claude.status, 'imported');
    assert.equal(first.codex.status, 'imported');
    const [claude] = t.accounts.listClaudeAccounts();
    assert.equal(claude.loggedIn, true);
    assert.equal(claude.email, 'me@example.com', 'identity comes from the profile endpoint asked with the CLI token');
    assert.deepEqual(t.state.profileCalls, ['cli-at']);
    assert.equal(t.accounts.readClaudeCredential(claude.id).source, 'cli-import');
    const [codex] = t.accounts.listCodexAccounts();
    assert.equal(codex.email, 'me@example.com');
    assert.equal(t.accounts.readCodexCredential(codex.id, { now: () => NOW }).ok, true);

    const second = await t.importer.importOnce();
    assert.equal(second.claude.status, 'already');
    assert.equal(second.codex.status, 'already');
    assert.equal(t.accounts.listClaudeAccounts().length, 1, 'deduplicated by account identity');
    assert.equal(t.accounts.listCodexAccounts().length, 1);
  } finally { t.done(); }
});

test('a different CLI account becomes a second store account; a signed-out store copy is revived', async () => {
  const t = setup();
  try {
    t.writeCodex(codexAuth('me@example.com'));
    await t.importer.importOnce();
    t.state.profile = { ...t.state.profile, email: 'other@example.com', account_uuid: 'uuid-2' };
    t.writeCodex(codexAuth('other@example.com', 'acct-2'));
    const r = await t.importer.importOnce();
    assert.equal(r.claude.status, 'imported');
    assert.equal(r.codex.status, 'imported');
    assert.equal(t.accounts.listClaudeAccounts().length, 2);
    assert.equal(t.accounts.listCodexAccounts().length, 2);

    const target = t.accounts.listClaudeAccounts().find(a => a.email === 'other@example.com');
    t.accounts.writeClaudeCredential(target.id, { access_token: '', expired: '' });
    t.state.claude = { ...t.state.claude, accessToken: 'cli-at-2' };
    const revived = await t.importer.importOnce();
    assert.deepEqual(revived.claude, { status: 'updated', id: target.id });
    assert.equal(t.accounts.readClaudeCredential(target.id).access_token, 'cli-at-2');
  } finally { t.done(); }
});

test('no official CLI login, an API-key auth.json or an expired CLI token imports nothing', async () => {
  const t = setup();
  try {
    t.state.claude = { ok: false, reason: 'unreadable' };
    t.writeCodex({ auth_mode: 'apikey', OPENAI_API_KEY: 'k', tokens: null });
    let r = await t.importer.importOnce();
    assert.equal(r.claude.status, 'no_login');
    assert.equal(r.codex.status, 'no_login');
    t.state.claude = { ok: true, accessToken: 'old', refreshToken: 'rt', expiresAt: NOW - 1 };
    t.writeCodex(codexAuth('me@example.com', 'acct-1', NOW / 1000 - 10));
    r = await t.importer.importOnce();
    assert.equal(r.claude.status, 'cli_expired');
    assert.equal(r.codex.status, 'cli_expired');
    assert.deepEqual(t.state.profileCalls, [], 'an expired CLI token is never used');
    assert.equal(t.accounts.listClaudeAccounts().length + t.accounts.listCodexAccounts().length, 0);
  } finally { t.done(); }
});

test('an expired imported copy re-syncs from the CLI instead of rotating the shared refresh token', async () => {
  const t = setup();
  try {
    await t.importer.importOnce();
    const [account] = t.accounts.listClaudeAccounts();
    t.accounts.writeClaudeCredential(account.id, { expired: new Date(NOW - HOUR).toISOString() });
    t.state.claude = { ...t.state.claude, accessToken: 'cli-at-fresh', expiresAt: NOW + 2 * HOUR };
    let refreshed = false;
    const credentials = createClaudeAccountCredentialService({
      accounts: t.accounts, now: () => NOW, refreshFromCli: t.importer.refreshFromCli,
      fetch: async () => { refreshed = true; throw new Error('must not refresh'); },
    });
    assert.deepEqual(await credentials.readAccountToken(account.id), { token: 'cli-at-fresh' });
    assert.equal(refreshed, false);
  } finally { t.done(); }
});
