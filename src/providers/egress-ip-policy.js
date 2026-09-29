'use strict';

// Fail-closed gate for the provider "egress IP allowlist" advanced option:
// a provider with a non-empty egressIpAllowlist may only be used while this
// machine's current public IP is exactly one of the listed addresses. Exact
// match only (no CIDR/range). Consumed by both the chat-turn admission gate
// (turn-engine.js) and the balance/quota poll paths (usage-limit-poller.js,
// routes/provider-balance.js) so a provider restricted this way is refused
// everywhere it would otherwise make an outbound call, not just on send.

const { getCachedEgressIp, ensureMonitorStarted } = require('./egress-ip');

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeAllowlist(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const ip = clean(raw);
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

function egressIpRestrictionActive(provider) {
  return normalizeAllowlist(provider && provider.egressIpAllowlist).length > 0;
}

// Never throws. { allowed, code, detail } — code/detail are set only when
// allowed is false.
function checkEgressIpAllowed(provider) {
  const allowlist = normalizeAllowlist(provider && provider.egressIpAllowlist);
  if (allowlist.length === 0) return { allowed: true, code: null, detail: '' };
  ensureMonitorStarted();
  const cached = getCachedEgressIp();
  if (!cached.ip) {
    return {
      allowed: false,
      code: 'egress_ip_unknown',
      detail: cached.error
        ? `出口 IP 探测失败（${cached.error}），暂不能使用该 Provider`
        : '出口 IP 尚未探测完成，暂不能使用该 Provider',
    };
  }
  if (!allowlist.includes(cached.ip)) {
    return {
      allowed: false,
      code: 'egress_ip_mismatch',
      detail: `当前出口 IP（${cached.ip}）不在该 Provider 允许的 IP 列表内，请修改 Provider 的出口 IP 配置，或切换 VPN 后重试`,
    };
  }
  return { allowed: true, code: null, detail: '' };
}

function assertEgressIpAllowed(provider) {
  const result = checkEgressIpAllowed(provider);
  if (!result.allowed) {
    const error = new Error(result.detail);
    error.code = result.code === 'egress_ip_unknown' ? 'EGRESS_IP_UNKNOWN' : 'EGRESS_IP_MISMATCH';
    throw error;
  }
  return true;
}

module.exports = {
  normalizeAllowlist,
  egressIpRestrictionActive,
  checkEgressIpAllowed,
  assertEgressIpAllowed,
};
