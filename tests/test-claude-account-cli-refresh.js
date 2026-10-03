'use strict';

// Simulation of per-account Claude refresh through the claude CLI.
//
// Two fakes stand in for the outside world, and both keep the one property the
// whole design hinges on:
//   - a token server whose refresh tokens are SINGLE-USE and rotating — a
//     spent token answers invalid_grant, exactly like the real endpoint, so a
//     double spend (two holders of one token family) shows up as a rejection;
//   - a `claude` executable, spawned for real, that keys its credential slot on
//     CLAUDE_CONFIG_DIR (<dir>/.credentials.json, the non-macOS layout) and only
//     refreshes on an authenticated turn inside its own 5 minute window.
// The macOS Keychain slot is checked separately against a recorded runner; the
// service-name contract itself was confirmed against the real CLI (claude
// 2.1.285: a seeded `Claude Code-credentials-<hash>` slot reads as logged in,
// an empty config dir as logged out).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createOfficialAccountStore } = require('../src/official-accounts');
const { createCliLoginImporter } = require('../src/official-accounts-cli-import');
const { createClaudeAccountCredentialService } = require('../src/claude-auth/account-credentials');
const { createClaudeAccountRefreshSupervisor, createCliCredentialSlot, keychainServiceFor } = require('../src/claude-auth/accounts-refresh');
const { TOKEN_URL } = require('../src/claude-auth/official-oauth');

const MIN = 60 * 1000;

// ── fake token server: single-use rotating refresh tokens ────────────────────
function startTokenServer() {
  const families = new Map(); // family -> {gen, refresh}
  const events = [];          // {family, ok}
  const issue = (family) => {
    const f = families.get(family) || { gen: -1 };
    f.gen += 1;
    f.refresh = `rt-${family}-${f.gen}`;
    families.set(family, f);
    return { access_token: `at-${family}-${f.gen}`, refresh_token: f.refresh, expires_in: 3600 };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let rt = '';
      try { rt = JSON.parse(body).refresh_token || ''; } catch (_) { rt = new URLSearchParams(body).get('refresh_token') || ''; }
      const family = (/^rt-(.+)-\d+$/.exec(rt) || [])[1];
      const f = family && families.get(family);
      if (!f || f.refresh !== rt) {
        events.push({ family: family || '?', ok: false });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      events.push({ family, ok: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(issue(family)));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/v1/oauth/token`;
    resolve({
      url,
      issue,
      events,
      rotations: family => events.filter(e => e.family === family && e.ok).length,
      rejections: () => events.filter(e => !e.ok).length,
      // In-process fetch for multicc's own (inline) refresh path.
      fetch: (target, init) => (String(target) === TOKEN_URL
        ? globalThis.fetch(url, init)
        : Promise.resolve(new Response('{}', { status: 503 }))),
      close: () => new Promise(r => server.close(r)),
    });
  }));
}

// ── fake claude CLI ──────────────────────────────────────────────────────────
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = process.env.CLAUDE_CONFIG_DIR || '';
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  args: process.argv.slice(2), configDir: dir,
  anthropicKey: !!process.env.ANTHROPIC_API_KEY,
  secureStorageDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || null,
}) + '\\n');
if (process.env.FAKE_CLAUDE_MODE === 'fail') process.exit(1);
const file = path.join(dir, '.credentials.json');
let store; try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { process.exit(1); }
const o = store.claudeAiOauth;
const turn = process.argv.includes('-p');
if (!turn || o.expiresAt - Date.now() > 5 * 60 * 1000) process.exit(0); // nothing due
setTimeout(async () => {
  const res = await fetch(process.env.FAKE_OAUTH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken }) });
  if (!res.ok) process.exit(1);
  const j = await res.json();
  store.claudeAiOauth = { ...o, accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 };
  fs.writeFileSync(file, JSON.stringify(store));
}, Number(process.env.FAKE_CLAUDE_DELAY_MS || 0));
`;

async function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-refresh-'));
  const server = await startTokenServer();
  const accounts = createOfficialAccountStore({ root: path.join(dir, 'store') });
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
  const log = path.join(dir, 'claude.log');
  fs.writeFileSync(log, '');
  const env = { FAKE_OAUTH_URL: server.url, FAKE_CLAUDE_LOG: log, ...(opts.env || {}) };
  const supervisor = createClaudeAccountRefreshSupervisor({
    accounts, platform: 'linux', claudeBin: bin, extraEnv: env, user: 'tester',
    isEnabled: () => true, sharesCliLogin: opts.sharesCliLogin,
  });
  // An own-token account, as multicc's PKCE login leaves it.
  const addAccount = (family, expiresInMs) => {
    const { id } = accounts.createClaudeAccount({ label: family });
    const t = server.issue(family);
    accounts.writeClaudeCredential(id, {
      access_token: t.access_token, refresh_token: t.refresh_token,
      expired: new Date(Date.now() + expiresInMs).toISOString(), email: `${family}@example.com`,
    });
    return id;
  };
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return {
    dir, server, accounts, supervisor, addAccount, calls, bin, env,
    done: async () => { supervisor.stop(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('two own-token accounts are each refreshed by the CLI under their own CLAUDE_CONFIG_DIR', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-leak-check';
  const t = await setup({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/elsewhere' } });
  try {
    const a = t.addAccount('alice', 3 * MIN);
    const b = t.addAccount('bob', 3 * MIN);
    const results = await t.supervisor.checkAll('test');
    assert.deepEqual(results.map(r => r.outcome), ['refreshed', 'refreshed']);

    assert.equal(t.accounts.readClaudeCredential(a).access_token, 'at-alice-1');
    assert.equal(t.accounts.readClaudeCredential(b).access_token, 'at-bob-1');
    assert.ok(Date.parse(t.accounts.readClaudeCredential(a).expired) > Date.now() + 50 * MIN);
    assert.equal(t.accounts.readClaudeCredential(a).email, 'alice@example.com', 'identity fields survive the adopt');
    assert.equal(t.server.rotations('alice'), 1);
    assert.equal(t.server.rotations('bob'), 1);
    assert.equal(t.server.rejections(), 0, 'no refresh token was spent twice');

    const turns = t.calls().filter(c => c.args.includes('-p'));
    assert.deepEqual(turns.map(c => c.configDir).sort(), [t.accounts.claudeHomeDir(a), t.accounts.claudeHomeDir(b)].sort());
    for (const c of t.calls()) {
      assert.equal(c.anthropicKey, false, 'inherited ANTHROPIC_* routing is stripped');
      assert.equal(c.secureStorageDir, null, 'an inherited secure-storage override cannot redirect the slot');
    }
    for (const id of [a, b]) {
      assert.equal(fs.existsSync(path.join(t.accounts.claudeHomeDir(id), '.credentials.json')), false, 'slot cleared after adopt');
    }
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    await t.done();
  }
});

test('a fresh account spawns nothing and writes no slot', async () => {
  const t = await setup();
  try {
    const id = t.addAccount('carol', 50 * MIN);
    const [r] = await t.supervisor.checkAll('test');
    assert.equal(r.outcome, 'fresh');
    assert.equal(t.calls().length, 0);
    assert.equal(fs.existsSync(t.accounts.claudeHomeDir(id)), false);
  } finally { await t.done(); }
});

// The CLI's own login, imported into the store, shares its token family.
async function importCliLogin(t, family = 'cli', expiresInMs = 3 * MIN) {
  const tok = t.server.issue(family);
  const cli = { ok: true, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + expiresInMs };
  const importer = createCliLoginImporter({
    accounts: t.accounts,
    codexAuthFile: path.join(t.dir, 'no-codex', 'auth.json'),
    readClaudeCli: async () => cli,
    fetchProfile: async () => ({ email: 'me@example.com', account_uuid: 'uuid-me' }),
  });
  const r = await importer.importOnce();
  return { importer, cli, id: r.claude.id };
}

test('a copy that shares the CLI token family is never rotated by its own CLI run', async () => {
  const t0 = await setup();
  const imported = await importCliLogin(t0);
  const t = { ...t0, supervisor: createClaudeAccountRefreshSupervisor({
    accounts: t0.accounts, platform: 'linux', claudeBin: t0.bin, extraEnv: t0.env, isEnabled: () => true,
    sharesCliLogin: imported.importer.sharesCliLogin,
  }) };
  try {
    assert.equal(t.accounts.listClaudeAccounts()[0].followsCli, true);
    const [r] = await t.supervisor.checkAll('test');
    assert.equal(r.outcome, 'follows_cli');
    assert.equal(t.calls().length, 0);
    assert.equal(t.server.rotations('cli'), 0, 'the CLI keeps the only live copy of its refresh token');

    // Why it matters: a second holder rotating the same family logs the first out.
    const stolen = await (await t.server.fetch(TOKEN_URL, { method: 'POST', body: JSON.stringify({ refresh_token: imported.cli.refreshToken }) })).json();
    assert.ok(stolen.access_token);
    const cliOwn = await t.server.fetch(TOKEN_URL, { method: 'POST', body: JSON.stringify({ refresh_token: imported.cli.refreshToken }) });
    assert.equal(cliOwn.status, 400, 'the CLI\'s next refresh fails: invalid_grant');
  } finally { await t0.done(); }
});

test('signing an imported account in separately makes it independent: not clobbered, refreshed by its own CLI run', async () => {
  const t0 = await setup();
  const imported = await importCliLogin(t0, 'cli', 50 * MIN);
  const supervisor = createClaudeAccountRefreshSupervisor({
    accounts: t0.accounts, platform: 'linux', claudeBin: t0.bin, extraEnv: t0.env, isEnabled: () => true,
    sharesCliLogin: imported.importer.sharesCliLogin,
  });
  try {
    // What the relogin route's PKCE completion writes: a NEW token family.
    const own = t0.server.issue('mine');
    t0.accounts.writeClaudeCredential(imported.id, {
      access_token: own.access_token, refresh_token: own.refresh_token, expired: new Date(Date.now() + 3 * MIN).toISOString(),
    });
    const [acct] = t0.accounts.listClaudeAccounts();
    assert.equal(acct.source, 'cli-import', 'the tag is left as it was');
    assert.equal(acct.followsCli, false, 'but the fingerprint no longer matches, so it is independent');
    assert.equal(imported.importer.sharesCliLogin('claude', imported.id), false);

    // The CLI later holds a newer token for the same account: the independent login stays.
    const cliNext = t0.server.issue('cli');
    imported.cli.accessToken = cliNext.access_token;
    imported.cli.refreshToken = cliNext.refresh_token;
    imported.cli.expiresAt = Date.now() + 55 * MIN;
    assert.equal((await imported.importer.importOnce()).claude.status, 'already');
    assert.equal(t0.accounts.readClaudeCredential(imported.id).access_token, own.access_token);

    const [r] = await supervisor.checkAll('test');
    assert.equal(r.outcome, 'refreshed');
    assert.equal(t0.server.rotations('mine'), 1);
    assert.equal(t0.server.rotations('cli'), 0, 'the CLI login is untouched');
    assert.equal(t0.server.rejections(), 0);
  } finally { supervisor.stop(); await t0.done(); }
});

test('a slot left holding a newer token (rotated, never read back) is adopted, not overwritten', async () => {
  const t = await setup();
  try {
    const id = t.addAccount('dave', 3 * MIN);
    // Simulate a crash right after the CLI rotated: the slot has gen 1, the account gen 0.
    const rotated = t.server.issue('dave');
    await createCliCredentialSlot({ configDir: t.accounts.claudeHomeDir(id), platform: 'linux' }).write({
      claudeAiOauth: { accessToken: rotated.access_token, refreshToken: rotated.refresh_token, expiresAt: Date.now() + 60 * MIN },
    });
    const [r] = await t.supervisor.checkAll('test');
    assert.equal(r.outcome, 'recovered');
    assert.equal(t.calls().length, 0, 'no CLI run: re-seeding the spent token would have lost the account');
    assert.equal(t.accounts.readClaudeCredential(id).refresh_token, rotated.refresh_token);
    assert.equal(fs.existsSync(path.join(t.accounts.claudeHomeDir(id), '.credentials.json')), false);
  } finally { await t.done(); }
});

test('when the CLI cannot refresh, the slot is cleared and the inline refresh still rescues the request', async () => {
  const t = await setup({ env: { FAKE_CLAUDE_MODE: 'fail' } });
  try {
    const id = t.addAccount('erin', 30 * 1000);
    const [r] = await t.supervisor.checkAll('test');
    assert.notEqual(r.outcome, 'refreshed');
    assert.equal(t.accounts.readClaudeCredential(id).access_token, 'at-erin-0', 'account untouched');
    assert.equal(fs.existsSync(path.join(t.accounts.claudeHomeDir(id), '.credentials.json')), false);

    const credentials = createClaudeAccountCredentialService({ accounts: t.accounts, fetch: t.server.fetch, exclusive: t.supervisor.exclusive });
    const got = await credentials.readAccountToken(id);
    assert.equal(got.token, 'at-erin-1');
    assert.equal(t.server.rotations('erin'), 1);
  } finally { await t.done(); }
});

test('a request arriving mid CLI refresh waits for it instead of spending the same token', async () => {
  const t = await setup({ env: { FAKE_CLAUDE_DELAY_MS: '400' } });
  try {
    const id = t.addAccount('frank', 30 * 1000);
    const credentials = createClaudeAccountCredentialService({ accounts: t.accounts, fetch: t.server.fetch, exclusive: t.supervisor.exclusive });
    const sweep = t.supervisor.checkAll('test');
    await new Promise(r => setTimeout(r, 100)); // the CLI is now mid-refresh
    const got = await credentials.readAccountToken(id);
    const [r] = await sweep;
    assert.equal(r.outcome, 'refreshed');
    assert.equal(got.token, 'at-frank-1', 'the request got the CLI\'s token');
    assert.equal(t.server.rotations('frank'), 1);
    assert.equal(t.server.rejections(), 0);
  } finally { await t.done(); }
});

test('control: without the shared lock the same race double-spends (the simulation can see it)', async () => {
  const t = await setup({ env: { FAKE_CLAUDE_DELAY_MS: '400' } });
  try {
    const id = t.addAccount('gina', 30 * 1000);
    const credentials = createClaudeAccountCredentialService({ accounts: t.accounts, fetch: t.server.fetch });
    const sweep = t.supervisor.checkAll('test');
    await new Promise(r => setTimeout(r, 100));
    await credentials.readAccountToken(id);
    await sweep;
    assert.equal(t.server.rejections(), 1, 'one of the two holders hit invalid_grant');
  } finally { await t.done(); }
});

test('a config dir whose account is gone is swept with its slot', async () => {
  const t = await setup();
  try {
    const orphan = path.join(t.accounts.root, 'claude', 'abcdefabcdefabcd.home');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, '.credentials.json'), '{}');
    await t.supervisor.checkAll('test');
    assert.equal(fs.existsSync(orphan), false);
  } finally { await t.done(); }
});

test('macOS slot: the CLI\'s service name, $USER account, token via stdin hex only', async () => {
  const calls = [];
  const items = new Map();
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input || null });
    if (args[0] === '-i') {
      const m = /-s "([^"]+)" -X "([0-9a-f]+)"/.exec(opts.input);
      items.set(m[1], Buffer.from(m[2], 'hex').toString('utf8'));
      return { code: 0, stdout: '' };
    }
    const svc = args[args.indexOf('-s') + 1];
    if (args[0] === 'find-generic-password') return items.has(svc) ? { code: 0, stdout: items.get(svc) } : { code: 44, stdout: '' };
    if (args[0] === 'delete-generic-password') { items.delete(svc); return { code: 0, stdout: '' }; }
    return { code: 1, stdout: '' };
  };
  const dir = '/Users/someone/.multicc/official-accounts/claude/0123456789abcdef.home';
  const slot = createCliCredentialSlot({ configDir: dir, platform: 'darwin', run, user: 'someone' });
  const expected = `Claude Code-credentials-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
  assert.equal(slot.service, expected);
  assert.equal(keychainServiceFor(dir), expected);
  assert.notEqual(slot.service, 'Claude Code-credentials', 'never the default login');

  assert.equal(await slot.write({ claudeAiOauth: { accessToken: 'at-secret', refreshToken: 'rt-secret', expiresAt: 1 } }), true);
  const write = calls.at(-1);
  assert.deepEqual(write.args, ['-i']);
  assert.match(write.input, /^add-generic-password -U -a "someone" -s "Claude Code-credentials-[0-9a-f]{8}" -X "[0-9a-f]+"\n$/);
  for (const c of calls) assert.ok(!c.args.join(' ').includes('secret'), 'the token never reaches argv');

  const back = await slot.read();
  assert.equal(back.ok, true);
  assert.equal(back.refreshToken, 'rt-secret');
  assert.deepEqual(calls.at(-1).args, ['find-generic-password', '-a', 'someone', '-s', expected, '-w']);
  await slot.remove();
  assert.equal((await slot.read()).ok, false);
});

test('codex: an imported copy re-logged in with CODEX_HOME stops following the CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-independent-'));
  try {
    const accounts = createOfficialAccountStore({ root: path.join(dir, 'store') });
    const codexAuthFile = path.join(dir, 'codex-home', 'auth.json');
    fs.mkdirSync(path.dirname(codexAuthFile), { recursive: true });
    const jwt = p => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`;
    const auth = (rt, exp) => ({ auth_mode: 'chatgpt', tokens: { id_token: jwt({ email: 'me@example.com' }), access_token: jwt({ exp, n: rt }), refresh_token: rt, account_id: 'acct-1' } });
    const soon = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(codexAuthFile, JSON.stringify(auth('rt-cli-0', soon)));
    const importer = createCliLoginImporter({ accounts, codexAuthFile, readClaudeCli: async () => null });
    const id = (await importer.importOnce()).codex.id;
    assert.equal(accounts.listCodexAccounts()[0].followsCli, true);
    assert.equal(importer.sharesCliLogin('codex', id), true);

    // `codex login` with CODEX_HOME=<account dir> rewrites auth.json with its own family.
    fs.writeFileSync(accounts.codexAuthFile(id), JSON.stringify(auth('rt-own-0', soon)));
    assert.equal(accounts.listCodexAccounts()[0].followsCli, false);
    assert.equal(importer.sharesCliLogin('codex', id), false, 'its own CODEX_HOME refresher may now rotate it');

    fs.writeFileSync(codexAuthFile, JSON.stringify(auth('rt-cli-1', soon + 600)));
    assert.equal((await importer.importOnce()).codex.status, 'already');
    assert.equal(JSON.parse(fs.readFileSync(accounts.codexAuthFile(id), 'utf8')).tokens.refresh_token, 'rt-own-0', 'not clobbered by the CLI copy');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a copy imported before fingerprints existed keeps following the CLI, and an independent login still frees it', async () => {
  const t0 = await setup();
  const imported = await importCliLogin(t0, 'cli', 50 * MIN);
  try {
    // Downgrade to the pre-fingerprint shape: source tag only.
    const file = t0.accounts.claudeFile(imported.id);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete legacy.importedRefreshHash;
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(t0.accounts.listClaudeAccounts()[0].followsCli, true, 'no hash: old meaning, still follows');

    // The CLI rotates its family; the copy now holds a spent token and must be replaced, not left behind.
    const next = t0.server.issue('cli');
    Object.assign(imported.cli, { accessToken: next.access_token, refreshToken: next.refresh_token, expiresAt: Date.now() + 55 * MIN });
    assert.equal((await imported.importer.importOnce()).claude.status, 'updated');
    assert.equal(t0.accounts.readClaudeCredential(imported.id).refresh_token, next.refresh_token);

    // Downgrade again, then let a tick with an unchanged CLI token backfill the hash.
    const again = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete again.importedRefreshHash;
    fs.writeFileSync(file, JSON.stringify(again));
    await imported.importer.importOnce();
    assert.ok(t0.accounts.readClaudeCredential(imported.id).importedRefreshHash, 'fingerprint backfilled');

    const own = t0.server.issue('mine');
    t0.accounts.writeClaudeCredential(imported.id, { access_token: own.access_token, refresh_token: own.refresh_token });
    assert.equal(t0.accounts.listClaudeAccounts()[0].followsCli, false, 'independent once re-logged in');
  } finally { await t0.done(); }
});
