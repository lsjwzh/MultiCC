'use strict';

// Migration bridge only. Rust owns the expired-token retry and park decisions;
// JavaScript retains the CLI/Keychain calls and durable-state adapter.
const { getNative } = require('../native/runtime');

let warned = false;

function planClaudeExpiredRefresh(input, logger) {
  try {
    const addon = getNative();
    if (typeof addon?.planClaudeExpiredRefresh !== 'function') throw new Error('policy_unavailable');
    const plan = JSON.parse(addon.planClaudeExpiredRefresh(JSON.stringify(input)));
    if (!plan || typeof plan.recoverParked !== 'boolean' || typeof plan.allowProbe !== 'boolean'
        || typeof plan.reservePostExpiry !== 'boolean' || !Number.isFinite(plan.budgetFloor)
        || plan.budgetFloor < 0) throw new Error('policy_invalid');
    return plan;
  } catch (_) {
    if (!warned) {
      warned = true;
      logger?.warn?.('claude_expired_refresh_policy_unavailable', {
        action: 'build the current Rust addon; Claude CLI probes stay disabled until it is available',
      });
    }
    // No Node copy of the policy. Callers read null as "no plan": parked
    // credentials stay parked and no authenticated probe is admitted.
    return null;
  }
}

module.exports = { planClaudeExpiredRefresh };
