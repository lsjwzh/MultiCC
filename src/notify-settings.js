'use strict';

// Notification destination helpers shared by the host-read route family and
// the POST /api/settings/notify composition root (src/routes/host-write.js).
//
// Reads expose only the origin of a configured destination: paths and query
// strings can carry a device key or webhook token. The write side reuses the
// same masked form so an unchanged placeholder from the read API is a no-op
// instead of overwriting the real URL with bullets.

function summarizeSecretUrl(value) {
  const configured = typeof value === 'string' && value.length > 0;
  if (!configured) return { configured: false, origin: '', masked: '' };
  let origin = '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
  } catch (_) { /* opaque configured value */ }
  return {
    configured: true,
    origin,
    masked: origin ? `${origin}/••••` : '••••',
  };
}

function matchesCurrentNotifyPlaceholder(value, currentValue) {
  return typeof value === 'string'
    && !!currentValue
    && value === summarizeSecretUrl(currentValue).masked;
}

// Shared by the POST composition root: an unchanged read-side placeholder is
// a no-op, while an explicit empty string still clears the channel.
function resolveNotifySettingsUpdates(body = {}, current = {}) {
  const updates = {};
  for (const [bodyKey, configKey] of [['barkUrl', 'BARK_URL'], ['webhookUrl', 'WEBHOOK_URL']]) {
    if (!Object.prototype.hasOwnProperty.call(body, bodyKey)) continue;
    const value = body[bodyKey];
    if (typeof value !== 'string') continue;
    if (matchesCurrentNotifyPlaceholder(value, current[configKey])) continue;
    updates[configKey] = value;
  }
  return updates;
}

module.exports = { summarizeSecretUrl, matchesCurrentNotifyPlaceholder, resolveNotifySettingsUpdates };
