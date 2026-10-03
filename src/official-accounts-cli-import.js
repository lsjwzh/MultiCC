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
// log the CLI out. An expired CLI token is simply not imported this round.
// Existing store accounts are only overwritten when they are unusable (signed
// out / expired), so a healthy store copy is never clobbered.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { atomicWriteJson, secureFile } = require('./runtime-security');

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
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

  async function importClaude() {
    let cli;
    try { cli = await readClaudeCli(); } catch (_) { return { status: 'unreadable' }; }
    if (!cli || !cli.ok || !cli.accessToken) return { status: 'no_login' };
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
      source: IMPORT_SOURCE,
      importedAt: new Date(now()).toISOString(),
    };
    const existing = accounts.listClaudeAccounts().find((a) => {
      const data = accounts.readClaudeCredential(a.id) || {};
      return profile.account_uuid ? sameText(data.account_uuid, profile.account_uuid) : sameText(data.email || a.email, profile.email);
    });
    if (existing) {
      if (existing.loggedIn && fresh(existing.expiresAt)) return { status: 'already', id: existing.id };
      accounts.writeClaudeCredential(existing.id, tokenData);
      return { status: 'updated', id: existing.id };
    }
    const created = accounts.createClaudeAccount({ label: '' });
    accounts.writeClaudeCredential(created.id, tokenData);
    return { status: 'imported', id: created.id };
  }

  function importCodex() {
    const cli = readCodexCliLogin(codexAuthFile);
    if (!cli) return { status: 'no_login' };
    if (!fresh(cli.expiresAt)) return { status: 'cli_expired' };
    const existing = accounts.listCodexAccounts().find(a => sameText(a.accountExternalId, cli.accountId)
      && (!cli.email || !a.email || sameText(a.email, cli.email)));
    const write = (id) => {
      const file = accounts.codexAuthFile(id);
      atomicWriteJson(file, cli.auth);
      secureFile(file);
    };
    if (existing) {
      if (accounts.readCodexCredential(existing.id, { now }).ok) return { status: 'already', id: existing.id };
      write(existing.id);
      return { status: 'updated', id: existing.id };
    }
    const created = accounts.createCodexAccount({ label: '' });
    write(created.id);
    return { status: 'imported', id: created.id };
  }

  async function importOnce() {
    const result = {};
    try { result.claude = await importClaude(); } catch (error) { result.claude = { status: 'error', error: error.message }; }
    try { result.codex = importCodex(); } catch (error) { result.codex = { status: 'error', error: error.message }; }
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

  // Before a store copy that came from the CLI rotates its refresh token (which
  // would log the CLI out), adopt the CLI's newer token if it holds one.
  async function refreshFromCli(vendor, id) {
    const r = await tick();
    return !!(r && r[vendor] && r[vendor].id === id && r[vendor].status === 'updated');
  }

  return Object.freeze({
    importOnce: tick,
    refreshFromCli,
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
