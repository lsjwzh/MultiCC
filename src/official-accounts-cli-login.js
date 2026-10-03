'use strict';

// Notices the login the CLI itself holds (Keychain "Claude Code-credentials",
// ~/.codex/auth.json) so the accounts panel can say "your CLI is signed in as X
// — sign in here too". It never copies that login into the account store: a
// copy would share the CLI's single-use refresh token, and whichever side
// refreshed first would log the other out. Store accounts always get their own
// login (multicc PKCE / `codex login` with CODEX_HOME).
//
// Identity never comes from ~/.claude.json (cc-switch rewrites it): Claude asks
// the profile endpoint with the CLI token — a read, which rotates nothing —
// and Codex reads the token's own id_token / account_id.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

function jwtPayload(token) {
  try {
    const value = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

const sameText = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const tokenKey = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

function defaultCodexAuthFile(env = process.env) {
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

// {accountId, email} for a ChatGPT login, null otherwise (an API-key auth.json —
// e.g. cc-switch pointing codex at a third party — is not an official login).
function readCodexCliLogin(file) {
  let auth;
  try { auth = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  const tokens = auth && typeof auth.tokens === 'object' && auth.tokens ? auth.tokens : null;
  if (!tokens || (auth.auth_mode && auth.auth_mode !== 'chatgpt')) return null;
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id.trim() : '';
  if (!accessToken || !accountId) return null;
  const email = jwtPayload(tokens.id_token || accessToken).email;
  return { accountId, email: typeof email === 'string' ? email : '' };
}

function createCliLoginDetector({
  accounts,
  fetchImpl = globalThis.fetch,
  readClaudeCli = () => require('./quota/claude-cli-oauth').readCliCredentials(),
  fetchProfile = require('./claude-auth/official-oauth').fetchProfile,
  codexAuthFile = defaultCodexAuthFile(),
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (!accounts) throw new TypeError('[official-accounts-cli-login] accounts store is required');
  let timer = null;
  let running = null;
  let claudeCli = null;      // {email, accountUuid} | null
  const profiles = new Map(); // access-token key -> profile (one lookup per CLI token)

  async function detectClaude() {
    let cli;
    try { cli = await readClaudeCli(); } catch (_) { cli = null; }
    if (!cli || !cli.ok || !cli.accessToken) { claudeCli = null; return; }
    const key = tokenKey(cli.accessToken);
    let profile = profiles.get(key);
    if (!profile) {
      try { profile = (await fetchProfile(fetchImpl, cli.accessToken)) || {}; } catch (_) { profile = {}; }
      if (profile.email || profile.account_uuid) { profiles.clear(); profiles.set(key, profile); }
    }
    claudeCli = { email: profile.email || '', accountUuid: profile.account_uuid || '' };
  }

  // {loggedIn, email, inStore}: inStore is true when a store account is that
  // same login (then there is nothing to remind about).
  function status(vendor) {
    if (vendor === 'codex') {
      const cli = readCodexCliLogin(codexAuthFile);
      if (!cli) return { loggedIn: false };
      const inStore = accounts.listCodexAccounts().some(a => a.loggedIn && !a.cliCopy
        // A workspace account_id can be shared by teammates: the email must agree too.
        && sameText(a.accountExternalId, cli.accountId) && (!cli.email || !a.email || sameText(a.email, cli.email)));
      return { loggedIn: true, email: cli.email, inStore };
    }
    if (!claudeCli) return { loggedIn: false };
    const own = accounts.listClaudeAccounts().filter(a => a.loggedIn && !a.cliCopy);
    const inStore = own.some((a) => {
      const data = accounts.readClaudeCredential(a.id) || {};
      return sameText(data.account_uuid, claudeCli.accountUuid) || sameText(data.email || a.email, claudeCli.email);
    // Unknown identity (profile lookup failed): only remind when nothing is signed in.
    }) || (!claudeCli.email && !claudeCli.accountUuid && own.length > 0);
    return { loggedIn: true, email: claudeCli.email, inStore };
  }

  function tick() {
    if (running) return running;
    running = detectClaude().catch(() => {}).finally(() => { running = null; });
    return running;
  }

  return Object.freeze({
    detect: tick,
    status,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
      setTimeout(tick, 5_000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  });
}

module.exports = { createCliLoginDetector, readCodexCliLogin, defaultCodexAuthFile };
