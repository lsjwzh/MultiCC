'use strict';

// Billing dates are independent of usage-window resets and OAuth expiry.
// Extended billing-field parsing lives in Rust; this is only the JS boundary.
const { getNative } = require('../native/runtime');

function subscriptionFromBody(body, { source = 'account', observedAt = Date.now() } = {}) {
  return JSON.parse(getNative().parseAccountSubscription(JSON.stringify({ body, source, observedAt })));
}

function codexAuthSubscription(auth) {
  return require('../providers/native-credentials').credential({ operation: 'codexSubscription', auth });
}

module.exports = { subscriptionFromBody, codexAuthSubscription };
