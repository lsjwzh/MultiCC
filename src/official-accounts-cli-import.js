'use strict';

// The account store is the single source of truth for official providers. A
// login the CLI itself holds (Keychain "Claude Code-credentials", ~/.codex/
// auth.json) is NOT listed beside the store; it is copied INTO the store as an
// ordinary account, de-duplicated by account identity, and from then on routes,
// quota and auto steering only ever see store accounts.
//
// Identity never comes from ~/.claude.json: cc-switch rewrites that file, so its
// oauthAccount may describe a different login than the token. Claude identity is
// asked of the profile endpoint WITH the CLI token itself; Codex identity comes
// from the token's own id_token / account_id.
//
// The CLI's credential is only read, never refreshed — rotating it here would
// log the CLI out. Keeping it fresh is the CLI refreshers' job (claude-auth/
// oauth-refresh.js, codex/oauth-refresh.js run the CLI before expiry). A copy
// imported from the CLI shares the CLI's refresh token, so it must not rotate
// on its own either: it FOLLOWS the CLI — whenever the CLI holds a newer token
// for the same account, the copy is replaced. A healthy account the user signed
// in through multicc itself is never clobbered. "Imported" is judged by the
// refresh-token fingerprint the importer recorded (followsCli), not the source
// tag alone: once any login rewrites the token the account is independent.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { atomicWriteJson, secureFile } = require('./runtime-security');
const { refreshFingerprint, followsCliImport } = require('./official-accounts');

// Matches the CLI refreshers' cadence, so a refreshed CLI token reaches the
// copy long before the copy's own access token lapses (refresh runs 15 min early).
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;
const IMPORT_SOURCE = 'cli-import';

function jwtPayload(token) {
  try {
    const value = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

const sameText = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function defaultCodexAuthFile(env = process.env) {
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

// {auth, accountId, email, expiresAt} for a ChatGPT login, null otherwise (an
// API-key auth.json — e.g. cc-switch pointing codex at a third party — is not an
// official login and is never imported).
function readCodexCliLogin(file) {
  let auth;
  try { auth = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  const tokens = auth && typeof auth.tokens === 'object' && auth.tokens ? auth.tokens : null;
  if (!tokens || (auth.auth_mode && auth.auth_mode !== 'chatgpt')) return null;
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id.trim() : '';
  if (!accessToken || !accountId) return null;
  const email = jwtPayload(tokens.id_token || accessToken).email;
  const exp = Number(jwtPayload(accessToken).exp);
  return { auth, accountId, email: typeof email === 'string' ? email : '', expiresAt: Number.isFinite(exp) ? exp * 1000 : null };
}

function createCliLoginImporter({
  accounts,
  fetchImpl = globalThis.fetch,
  readClaudeCli = () => require('./quota/claude-cli-oauth').readCliCredentials(),
  fetchProfile = require('./claude-auth/official-oauth').fetchProfile,
  codexAuthFile = defaultCodexAuthFile(),
  logger = { info() {}, warn() {} },
  now = Date.now,
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (!accounts) throw new TypeError('[official-accounts-cli-import] accounts store is required');
  let timer = null;
  let running = null;

  const fresh = expiresAt => expiresAt == null || expiresAt > now() + EXPIRY_SKEW_MS;

  const lastCli = {};
  // vendor → store account id the CLI login last resolved to.
  const lastMatch = {};

  // Copies imported before fingerprints existed: pin the token they hold now,
  // so a later independent login (which rewrites it) reads as independent.
  function backfillFingerprints() {
    for (const a of accounts.listClaudeAccounts()) {
      const data = accounts.readClaudeCredential(a.id) || {};
      if (data.source === IMPORT_SOURCE && data.importedRefreshHash == null && data.refresh_token) {
        accounts.writeClaudeCredential(a.id, { importedRefreshHash: refreshFingerprint(data.refresh_token) });
      }
    }
    for (const a of accounts.listCodexAccounts()) {
      if (a.source !== IMPORT_SOURCE) continue;
      const meta = accounts.readCodexMeta(a.id);
      if (meta.importedRefreshHash == null && readCodexTokens(a.id).refresh_token) {
        accounts.writeCodexMeta(a.id, { importedRefreshHash: refreshFingerprint(readCodexTokens(a.id).refresh_token) });
      }
    }
  }

  async function importClaude() {
    let cli;
    try { cli = await readClaudeCli(); } catch (_) { cli = null; }
    lastCli.claude = cli && cli.ok ? cli : null;
    if (!cli) return { status: 'unreadable' };
    if (!cli.ok || !cli.accessToken) return { status: 'no_login' };
    const stored = accounts.listClaudeAccounts().map(a => ({ a, data: accounts.readClaudeCredential(a.id) || {} }));
    // Unchanged CLI token: nothing to do, and no profile round trip.
    const same = stored.find(s => s.data.access_token === cli.accessToken);
    if (same) return { status: 'already', id: same.a.id };
    if (!fresh(cli.expiresAt)) return { status: 'cli_expired' };
    let profile;
    try { profile = await fetchProfile(fetchImpl, cli.accessToken); } catch (error) {
      return { status: 'profile_failed', error: error.message };
    }
    if (!profile || (!profile.account_uuid && !profile.email)) return { status: 'profile_failed' };
    const tokenData = {
      access_token: cli.accessToken,
      refresh_token: cli.refreshToken || '',
      expired: cli.expiresAt != null ? new Date(cli.expiresAt).toISOString() : '',
      email: profile.email || '',
      account_uuid: profile.account_uuid || '',
      organization_uuid: profile.organization_uuid || '',
      organization_name: profile.organization_name || '',
      ...(cli.scopes ? { scopes: cli.scopes } : {}),
      ...(cli.subscriptionType ? { subscription_type: cli.subscriptionType } : {}),
      source: IMPORT_SOURCE,
      importedRefreshHash: refreshFingerprint(cli.refreshToken),
      importedAt: new Date(now()).toISOString(),
    };
    const match = stored.find(({ a, data }) => (profile.account_uuid
      ? sameText(data.account_uuid, profile.account_uuid) : sameText(data.email || a.email, profile.email)));
    if (match) {
      const { a } = match;
      const usable = a.loggedIn && fresh(a.expiresAt);
      const newer = cli.expiresAt == null || a.expiresAt == null || cli.expiresAt > a.expiresAt;
      if (usable && !(a.followsCli && newer)) return { status: 'already', id: a.id };
      accounts.writeClaudeCredential(a.id, tokenData);
      return { status: 'updated', id: a.id };
    }
    const created = accounts.createClaudeAccount({ label: '' });
    accounts.writeClaudeCredential(created.id, tokenData);
    return { status: 'imported', id: created.id };
  }

  function readCodexTokens(id) {
    try { return JSON.parse(fs.readFileSync(accounts.codexAuthFile(id), 'utf8')).tokens || {}; } catch (_) { return {}; }
  }

  function importCodex() {
    const cli = readCodexCliLogin(codexAuthFile);
    lastCli.codex = cli;
    if (!cli) return { status: 'no_login' };
    const list = accounts.listCodexAccounts();
    const same = list.find(a => readCodexTokens(a.id).access_token === cli.auth.tokens.access_token);
    if (same) return { status: 'already', id: same.id };
    if (!fresh(cli.expiresAt)) return { status: 'cli_expired' };
    const existing = list.find(a => sameText(a.accountExternalId, cli.accountId)
      && (!cli.email || !a.email || sameText(a.email, cli.email)));
    const write = (id) => {
      const file = accounts.codexAuthFile(id);
      atomicWriteJson(file, cli.auth);
      secureFile(file);
      accounts.writeCodexMeta(id, {
        source: IMPORT_SOURCE,
        importedAt: new Date(now()).toISOString(),
        importedRefreshHash: refreshFingerprint(cli.auth.tokens.refresh_token),
      });
    };
    if (existing) {
      const usable = accounts.readCodexCredential(existing.id, { now }).ok;
      const newer = cli.expiresAt == null || existing.expiresAt == null || cli.expiresAt > existing.expiresAt;
      if (usable && !(existing.followsCli && newer)) return { status: 'already', id: existing.id };
      write(existing.id);
      return { status: 'updated', id: existing.id };
    }
    const created = accounts.createCodexAccount({ label: '' });
    write(created.id);
    return { status: 'imported', id: created.id };
  }

  // Does this store copy still share the CLI's token family? Then rotating it
  // would consume the CLI's refresh token (or have it consumed under us). True
  // while the refresh tokens are literally equal, or while an imported copy and
  // the CLI are the same account (the CLI rotates; the copy follows).
  function sharesCliLogin(vendor, id) {
    // Codex is a cheap file read, so it is always current (the supervisor may
    // ask before the first import tick); Claude uses the last Keychain read.
    const cli = vendor === 'codex' ? readCodexCliLogin(codexAuthFile) : lastCli.claude;
    if (!cli) return false;
    if (vendor === 'claude') {
      const data = accounts.readClaudeCredential(id) || {};
      if (cli.refreshToken && data.refresh_token === cli.refreshToken) return true;
      return followsCliImport(data.source, data.importedRefreshHash, data.refresh_token) && lastMatch.claude === id;
    }
    const tokens = readCodexTokens(id);
    if (cli.auth.tokens.refresh_token && tokens.refresh_token === cli.auth.tokens.refresh_token) return true;
    const account = accounts.listCodexAccounts().find(a => a.id === id);
    return !!account && account.followsCli && sameText(tokens.account_id, cli.accountId);
  }

  async function importOnce() {
    const result = {};
    try { backfillFingerprints(); } catch (_) { /* best effort; followsCliImport covers a missing hash */ }
    try { result.claude = await importClaude(); } catch (error) { result.claude = { status: 'error', error: error.message }; }
    try { result.codex = importCodex(); } catch (error) { result.codex = { status: 'error', error: error.message }; }
    for (const vendor of ['claude', 'codex']) if (result[vendor].id) lastMatch[vendor] = result[vendor].id;
    for (const [vendor, r] of Object.entries(result)) {
      if (r.status === 'imported' || r.status === 'updated') logger.info('official_account_cli_import', { vendor, status: r.status, accountId: r.id });
      else if (r.status === 'error') logger.warn('official_account_cli_import_failed', { vendor, error: r.error });
    }
    return result;
  }

  function tick() {
    if (running) return running;
    running = importOnce().catch(() => ({})).finally(() => { running = null; });
    return running;
  }

  // Called before a store copy that came from the CLI would rotate its token:
  // re-sync first. {synced} — the copy now holds the CLI's newer token;
  // {shared} — the copy still shares the CLI's token family and must wait for
  // the CLI refresher instead of rotating.
  async function refreshFromCli(vendor, id) {
    const r = (await tick()) || {};
    const own = r[vendor] || {};
    return { synced: own.id === id && own.status === 'updated', shared: sharesCliLogin(vendor, id) };
  }

  return Object.freeze({
    importOnce: tick,
    refreshFromCli,
    sharesCliLogin,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
      setTimeout(tick, 5_000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  });
}

module.exports = { createCliLoginImporter, readCodexCliLogin, defaultCodexAuthFile, IMPORT_SOURCE };
