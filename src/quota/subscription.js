'use strict';

// Billing dates are independent of usage-window resets and OAuth expiry.
// Only explicitly named subscription fields may enter this public projection.
function dateMs(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value));
  const n = numeric ? Number(value) : Date.parse(value);
  const ms = numeric && n < 1e12 ? n * 1000 : n;
  return Number.isFinite(ms) && ms >= 946684800000 && ms < 4102444800000 ? ms : null;
}

function subscriptionFromBody(body, { source = 'account', observedAt = Date.now() } = {}) {
  // Migration bridge: extended billing-field parsing lives in Rust. Older
  // binaries retain the existing parser until their next native rebuild.
  const native = require('../native/runtime').getNative('subscription');
  if (typeof native?.parseAccountSubscription === 'function') {
    return JSON.parse(native.parseAccountSubscription(JSON.stringify({ body, source, observedAt })));
  }
  if (!body || typeof body !== 'object') return null;
  const rows = [body.subscription, body.billing, body.organization?.subscription, body.organization, body];
  const pickDate = keys => {
    for (const row of rows) for (const key of keys) {
      const value = dateMs(row?.[key]);
      if (value != null) return value;
    }
    return null;
  };
  const cancelled = rows.some(row => row?.cancel_at_period_end === true || row?.auto_renew === false || row?.will_renew === false);
  const renews = rows.some(row => row?.auto_renew === true || row?.will_renew === true);
  const currentPeriodEnd = pickDate(['current_period_end', 'subscription_end', 'subscription_expires_at', 'chatgpt_subscription_active_until']);
  const nextBillingAt = cancelled ? null : pickDate(['next_billing_at', 'next_billing_date', 'next_renewal_at', 'renews_at', 'renewal_date'])
    ?? (renews ? currentPeriodEnd : null);
  if (!nextBillingAt && !currentPeriodEnd && !cancelled) return null;
  return { nextBillingAt, currentPeriodEnd, autoRenew: cancelled ? false : renews ? true : null,
    source, observedAt: dateMs(observedAt) };
}

function codexAuthSubscription(auth) {
  const tokens = auth?.tokens || {};
  for (const token of [tokens.id_token, tokens.access_token]) {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
      const claims = payload['https://api.openai.com/auth'];
      if (!claims || (tokens.account_id && claims.chatgpt_account_id && tokens.account_id !== claims.chatgpt_account_id)) continue;
      const subscription = subscriptionFromBody(claims, { source: 'login', observedAt: dateMs(payload.iat) });
      if (subscription) return subscription;
    } catch (_) { /* Opaque or malformed credentials expose no billing date. */ }
  }
  return null;
}

module.exports = { dateMs, subscriptionFromBody, codexAuthSubscription };
