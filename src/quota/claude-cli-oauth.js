'use strict';

const { outboundFetch } = require('../network/outbound');

// The Claude Code CLI's own subscription, read straight from the credential
// store the CLI already maintains:
//
//   macOS   Keychain item "Claude Code-credentials"
//   others  ~/.claude/.credentials.json
//
// This is the cheapest possible source for the 5h / weekly windows — one HTTPS
// GET against the same control-plane endpoint the CLI's own `/usage` reads, no
// browser, no claude.ai cookie, no Cloudflare clearance, ~200ms. It is also the
// only source that keeps working when the user's claude.ai web session and the
// CLI are logged into different accounts: the CLI's token answers for the
// account the CLI actually spends.
//
// The store belongs to the CLI, so this module only ever READS it. In
// particular it never refreshes: a refresh rotates the refresh token, and half
// a rotation (we get a new one, the CLI never sees it, we crash before writing
// it back) would leave the user's CLI logged out. An access token that is
// expired or missing simply means "no answer from this source" and the caller
// falls through to the browser paths.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { fetchUsage } = require('../claude-auth/official-oauth');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
// A token that dies in the next minute is not worth a round trip — the endpoint
// would answer 401 and we would spend the fallback budget on a known-dead token.
const EXPIRY_SKEW_MS = 60 * 1000;

// The store is `{"claudeAiOauth":{accessToken,refreshToken,expiresAt,...}}` in
// every version seen so far, but older builds wrote the fields at the top level.
function parseCredentials(raw) {
  return require('../providers/native-credentials').credential({ operation: 'parseCli', raw: String(raw || '') });
}

// Injected reader + fetch keep this testable without a keychain or a network.
async function readCliCredentials(options = {}) {
  if (!options.readKeychain && !options.readFile) {
    return require('../providers/native-credentials').readCli({ platform: options.platform || process.platform,
      file: options.credentialsFile || CREDENTIALS_FILE, service: options.keychainService || KEYCHAIN_SERVICE });
  }
  const {
    platform = process.platform,
    readKeychain = async () => null,
    readFile = async (file) => fs.readFileSync(file, 'utf8'),
    credentialsFile = CREDENTIALS_FILE,
  } = options;

  if (platform === 'darwin') {
    const raw = await readKeychain();
    if (raw) {
      const parsed = parseCredentials(raw);
      if (parsed.ok) return { ...parsed, store: 'keychain' };
    }
  }
  try {
    const parsed = parseCredentials(await readFile(credentialsFile));
    if (parsed.ok) return { ...parsed, store: 'file' };
    return { ok: false, reason: parsed.reason, store: 'file' };
  } catch (_) {
    return { ok: false, reason: 'unreadable', store: platform === 'darwin' ? 'keychain' : 'file' };
  }
}

// Returns the raw usage body for the CLI's account, or null when this source
// cannot answer (no store, dead token, endpoint down). Null means "let the
// caller try the next source" — never an error the user has to see.
async function fetchCliUsage(options = {}) {
  const {
    fetchImpl = outboundFetch,
    now = () => Date.now(),
    readCredentials = readCliCredentials,
  } = options;

  let cred;
  try { cred = await readCredentials(); } catch (_) { return null; }
  if (!cred || !cred.ok || !cred.accessToken) return null;
  if (cred.expiresAt != null && cred.expiresAt <= now() + EXPIRY_SKEW_MS) return null;

  let usage;
  try { usage = await fetchUsage(fetchImpl, cred.accessToken); } catch (_) { return null; }
  if (!usage || typeof usage !== 'object') return null;
  return {
    usage,
    account: {
      id: 'cli',
      label: 'Claude Code CLI',
      email: '',
      subscriptionType: cred.subscriptionType || '',
      store: cred.store || '',
    },
  };
}

module.exports = {
  fetchCliUsage,
  readCliCredentials,
  parseCredentials,
  KEYCHAIN_SERVICE,
  CREDENTIALS_FILE,
  EXPIRY_SKEW_MS,
};
