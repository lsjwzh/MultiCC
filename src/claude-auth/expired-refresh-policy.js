'use strict';

// Migration bridge only. Rust owns the expired-token retry and park decisions;
// JavaScript retains the CLI/Keychain calls and durable-state adapter.
const { getNative } = require('../native/runtime');

let warned = false;

function planClaudeExpiredRefresh(input, logger) {
  try {
    const addon = getNative('claude_refresh', 'rust');
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
        action: 'build the current Rust addon; retaining the existing refresh policy until it is available',
      });
    }
    // No Node copy of the new policy: an older installation keeps only its
    // existing bounded retry behaviour until its native addon is upgraded.
    return null;
  }
}

module.exports = { planClaudeExpiredRefresh };
