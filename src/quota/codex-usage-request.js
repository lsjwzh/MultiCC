'use strict';

const os = require('node:os');
const path = require('node:path');
const { outboundFetch } = require('../network/outbound');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

// Both the chat quota route and background/provider polling use this request.
// Response mapping and timeout budgets belong to the callers; endpoint, auth
// headers and proxy transport must not diverge between those entry points.
function requestCodexUsage(auth, { fetch = outboundFetch, signal } = {}) {
  return fetch(USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'ChatGPT-Account-Id': auth.accountId || '',
      originator: 'codex_cli_rs',
      Accept: 'application/json',
    },
    signal,
  });
}

// Official codex OAuth credential lives on disk in ~/.codex/auth.json (shared
// login) or in an official-account's own auth.json (target.authFile, for
// providers marked settingsConfig.officialAccount). It is rotated by the codex
// CLI itself; we read it fresh each poll (never cache the token) so a refresh
// is picked up automatically. Returns null on any problem → the poll shows
// nothing rather than fabricating.
function readCodexAuth(authFile = path.join(os.homedir(), '.codex', 'auth.json')) {
  return require('../providers/native-credentials').credential({ operation: 'codexAuth',
    file: authFile || path.join(os.homedir(), '.codex', 'auth.json') });
}

module.exports = { requestCodexUsage, readCodexAuth };
