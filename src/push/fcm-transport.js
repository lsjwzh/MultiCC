'use strict';

const fs = require('node:fs');
const { createSign } = require('node:crypto');

// Credentials stay on the server. Missing/invalid credentials disable only FCM.
// Deliberately fixed Google endpoints: a credential file cannot redirect secrets.
function createFcmTransport({ credentialsFile = process.env.MULTICC_FCM_CREDENTIALS,
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  let credentials;
  try {
    const c = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    if (c.type === 'service_account' && /^[a-z][a-z0-9-]{4,62}$/.test(c.project_id)
      && typeof c.client_email === 'string' && typeof c.private_key === 'string') credentials = c;
  } catch (_) {}
  let cached;
  let pending;
  async function request(url, options) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return { response, body };
  }
  async function accessToken() {
    if (cached && cached.expires > now() + 60000) return cached.token;
    if (pending) return pending;
    pending = (async () => {
      const iat = Math.floor(now() / 1000);
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
        iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
      })}`;
      const signature = createSign('RSA-SHA256').update(input).sign(credentials.private_key, 'base64url');
      const { response, body } = await request('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${signature}` }).toString(),
      });
      if (!response.ok || typeof body.access_token !== 'string') throw new Error('FCM_AUTH_FAILED');
      cached = { token: body.access_token, expires: now() + Math.min(Number(body.expires_in) || 3600, 3600) * 1000 };
      return cached.token;
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
        body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '3600s' } } }),
      });
      if (response.ok && typeof body.name === 'string') return { ok: true, code: 'accepted' };
      if (response.status === 401) cached = null;
      const stale = body.error?.details?.some(d => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && d.errorCode === 'UNREGISTERED');
      return { ok: false, code: stale ? 'unregistered' : 'rejected' };
    } catch (_) { return { ok: false, code: 'unavailable' }; }
  }
  return { projectId: credentials?.project_id || '', send };
}
module.exports = { createFcmTransport };
