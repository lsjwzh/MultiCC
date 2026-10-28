'use strict';
// Existing account locks, platform network policy and injected SDK callbacks
// are host ports. Rust owns credential file reads, HTTP, parsing and fallback.
const { getNative } = require('../native/runtime');
const { policy } = require('../network/outbound');
async function query(input, { fetch } = {}) {
  const native = getNative('provider_credentials', 'rust');
  const plan = JSON.parse(await native.accountSubscriptionPlan(JSON.stringify(input)));
  if (plan.result) return plan.result;
  if (!fetch) {
    plan.proxyUrl = await policy.proxyForUrl(plan.url) || null;
    return JSON.parse(await native.queryAccountSubscription(JSON.stringify(plan)));
  }
  let status = 0, body = null;
  try {
    const response = await fetch(plan.url, { method: 'GET', headers: plan.headers, signal: AbortSignal.timeout(10000) });
    status = response.status;
    if (response.ok) body = await response.json();
  } catch (_) { status = 0; }
  return JSON.parse(native.accountSubscriptionResult(JSON.stringify({ plan, status, body, now: Date.now() })));
}
module.exports = { query };
