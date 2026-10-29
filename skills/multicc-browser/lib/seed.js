'use strict';

// A new dedicated Chrome starts with the user's login from the main Chrome
// unless the user explicitly asked for a blank one (`start NAME --create
// --blank`).
//
// The login travels as cookies read from the *running* main Chrome over the
// gateway (Storage.getCookies) and written into the new browser
// (Storage.setCookies). Copying the profile's files instead needs the main
// Chrome fully quit — a Cookies database copied while Chrome writes it comes
// out logged-out with no error — and asking the user to quit their browser to
// start a second one is the wrong trade. Cookies never touch disk on the way;
// the new Chrome stores them encrypted like any other.
//
// What does not travel: localStorage/IndexedDB tokens and Google's own session
// (Google invalidates copied sessions server-side). Verify the login on the
// page; it is a head start, not a guarantee.

const fs = require('fs');
const path = require('path');

const P = require('./paths');
const G = require('./gateway');
const M = require('./main-chrome');
const { CDP } = require('./cdp');

const SEED_NOTE =
  'Cookies imported from the everyday Chrome by `mbrowser start --create`. They are this user\'s live ' +
  'logins; never publish this directory.\n';
const CHUNK = 200;

async function exportMainCookies({ log = () => {} } = {}) {
  await M.ensureMain({ log });
  // Anonymous lane: it ends with this one connection.
  const url = await G.mainEndpoint({});
  const client = await CDP.connect(url, { label: 'seed', displayUrl: G.redact(url) });
  try {
    const result = await client.send('Storage.getCookies', {}, undefined, { timeout: G.APPROVAL_TIMEOUT_MS });
    return result.cookies || [];
  } finally {
    client.close();
  }
}

// Storage.getCookies hands back Network.Cookie; Storage.setCookies takes
// Network.CookieParam. Same fields minus the read-only ones, and a session
// cookie must not be given an expiry.
function toCookieParam(cookie) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (!cookie.session && Number(cookie.expires) > 0) out.expires = Number(cookie.expires);
  for (const key of ['sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey']) {
    if (cookie[key] !== undefined && cookie[key] !== null) out[key] = cookie[key];
  }
  return out;
}

// Runs inside the daemon against its own browser connection. A chunk the
// browser rejects is retried cookie by cookie so one odd cookie cannot cost
// the whole login.
async function importCookies(send, cookies) {
  const params = (cookies || []).filter(c => c && c.name !== undefined && c.domain).map(toCookieParam);
  let imported = 0;
  let failed = 0;
  for (let index = 0; index < params.length; index += CHUNK) {
    const chunk = params.slice(index, index + CHUNK);
    try {
      await send('Storage.setCookies', { cookies: chunk });
      imported += chunk.length;
    } catch (_) {
      for (const cookie of chunk) {
        try {
          await send('Storage.setCookies', { cookies: [cookie] });
          imported += 1;
        } catch (__) {
          failed += 1;
        }
      }
    }
  }
  return { imported, failed, total: params.length };
}

function markSeeded(userDataDir) {
  try { fs.writeFileSync(path.join(userDataDir, P.SEEDED_MARKER), SEED_NOTE, { mode: 0o600 }); } catch (_) { /* informational */ }
}

module.exports = { exportMainCookies, toCookieParam, importCookies, markSeeded, CHUNK };
