'use strict';

const { getNative } = require('../native/binding');

const fs = require('node:fs');
const { createSign } = require('node:crypto');

// Credentials stay on the server. Missing/invalid credentials disable only FCM.
// Deliberately fixed Google endpoints: a credential file cannot redirect secrets.
function createFcmTransport({ credentialsFile = process.env.MULTICC_FCM_CREDENTIALS,
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  let credentials;
  try {
    const c = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    if (getNative().fcmCredentials(c)) credentials = c;
  } catch (_) {}
  const cache = credentials && getNative().fcmTokenCache({
    now: () => now(), fresh: expires => expires > now() + 60000, add: (a, b) => a + b,
  });
  let pending;
  async function request(url, options) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return { response, body };
  }
  async function accessToken() {
    const cached = cache.lookup();
    if (cached !== undefined) return cached;
    if (pending) return pending;
    pending = (async () => {
      const iat = Math.floor(now() / 1000);
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(getNative().fcmTokenClaims(credentials.client_email, iat))}`;
      const signature = createSign('RSA-SHA256').update(input).sign(credentials.private_key, 'base64url');
      const { response, body } = await request('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${signature}` }).toString(),
      });
      return cache.remember(response, body);
    })();
    try { return await pending; } finally { pending = null; }
  }
  async function send(token, data) {
    if (!credentials) return { ok: false, code: 'not_configured' };
    try {
      const bearer = await accessToken();
      const { response, body } = await request(`https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        // Native service renders immediately, even without a Flutter engine.
        // Data-only permits local opt-out/binding checks before any display.
        body: JSON.stringify(getNative().fcmMessage(token, data)),
      });
      return getNative().fcmDelivery(response, body, cache.clear);
    } catch (_) { return { ok: false, code: 'unavailable' }; }
  }
  return { projectId: credentials?.project_id || '', send };
}
module.exports = { createFcmTransport };
