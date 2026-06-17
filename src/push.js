// Notification delivery layer — Web Push (VAPID), Bark, and webhook channels,
// plus the subscription store and per-endpoint health tracking.
//
// VAPID key generation + webpush.setVapidDetails() stay in server.js (startup,
// needs the .env writer). web-push is a process singleton, so the instance this
// module sends through is already configured by the time any send runs.
//
// Landmine notes:
//  • `subscriptions` is a const Map, NEVER reassigned — loadSubscriptions()
//    clears and repopulates it so exported `push.subscriptions` stays live.
//  • Bark/Webhook URLs are hot-reloaded from the settings route; they live in
//    the mutable `cfg` singleton (read as `push.cfg.X`, never destructured).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const webpush = require('web-push');

const PUSH_SUBS_FILE = path.join(__dirname, '..', 'push_subscriptions.json');

// Hot-reloadable channel config (Bark / Webhook).
const cfg = {
  BARK_URL: process.env.BARK_URL || '',
  WEBHOOK_URL: process.env.WEBHOOK_URL || '',
};
function applyEnvUpdates(updates) {
  if (updates.BARK_URL !== undefined) cfg.BARK_URL = updates.BARK_URL;
  if (updates.WEBHOOK_URL !== undefined) cfg.WEBHOOK_URL = updates.WEBHOOK_URL;
}

// Subscription + health stores (all const; never reassigned).
const subscriptions = new Map(); // endpoint -> PushSubscription JSON
const healthStats = new Map();   // endpoint -> { successCount, failCount, ... }
const globalStats = { totalSent: 0, totalSuccess: 0, totalFail: 0, lastPushTime: 0, lastPushType: '', lastPushSessionId: '' };
const barkHealth = { lastSendTime: 0, lastSuccess: true, lastError: '' };
const webhookHealth = { lastSendTime: 0, lastSuccess: true, lastError: '' };

function getHealthEntry(endpoint) {
  if (!healthStats.has(endpoint)) {
    healthStats.set(endpoint, { successCount: 0, failCount: 0, lastSuccessTime: 0, lastFailTime: 0, lastFailReason: '', consecutiveFails: 0 });
  }
  return healthStats.get(endpoint);
}

function loadSubscriptions() {
  try {
    if (fs.existsSync(PUSH_SUBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'));
      subscriptions.clear();
      for (const s of data) subscriptions.set(s.endpoint, s);
      console.log(`[multicc/push] Loaded ${subscriptions.size} push subscription(s)`);
    }
  } catch (_) {}
}

function saveSubscriptions() {
  try {
    fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify([...subscriptions.values()], null, 2));
  } catch (e) {
    console.error('[multicc/push] Failed to save subscriptions:', e.message);
  }
}

// Send push notification to all subscribers (async, properly handles stale cleanup)
async function sendPushToAll(payload) {
  if (subscriptions.size === 0) return;
  const payloadStr = JSON.stringify(payload);
  const entries = [...subscriptions.entries()];
  const results = await Promise.allSettled(
    entries.map(([endpoint, sub]) =>
      webpush.sendNotification(sub, payloadStr).then(
        () => ({ endpoint, ok: true }),
        err => ({ endpoint, ok: false, statusCode: err.statusCode, message: err.message })
      )
    )
  );

  const stale = [];
  for (const r of results) {
    const v = r.status === 'fulfilled' ? r.value : { endpoint: '', ok: false, message: 'settled-rejected' };
    const h = getHealthEntry(v.endpoint);
    globalStats.totalSent++;
    if (v.ok) {
      h.successCount++;
      h.lastSuccessTime = Date.now();
      h.consecutiveFails = 0;
      globalStats.totalSuccess++;
    } else {
      h.failCount++;
      h.lastFailTime = Date.now();
      h.lastFailReason = v.message || `HTTP ${v.statusCode}`;
      h.consecutiveFails++;
      globalStats.totalFail++;
      if (v.statusCode === 404 || v.statusCode === 410) stale.push(v.endpoint);
      console.error(`[multicc/push] Send failed for ${v.endpoint.slice(0, 40)}... (${v.statusCode || v.message})`);
    }
  }

  if (stale.length > 0) {
    for (const ep of stale) {
      subscriptions.delete(ep);
      healthStats.delete(ep);
    }
    saveSubscriptions();
    console.log(`[multicc/push] Cleaned ${stale.length} expired subscription(s)`);
  }
}

// Bark push notification (iOS backup)
function sendBarkNotification(title, body, url) {
  if (!cfg.BARK_URL) return;
  const barkUrl = `${cfg.BARK_URL.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?url=${encodeURIComponent(url || '')}&group=multicc`;
  barkHealth.lastSendTime = Date.now();
  const mod = barkUrl.startsWith('https') ? https : http;
  mod.get(barkUrl, res => {
    barkHealth.lastSuccess = res.statusCode >= 200 && res.statusCode < 300;
    if (!barkHealth.lastSuccess) barkHealth.lastError = `HTTP ${res.statusCode}`;
    else barkHealth.lastError = '';
    res.resume();
  }).on('error', err => {
    barkHealth.lastSuccess = false;
    barkHealth.lastError = err.message;
    console.error('[multicc/push] Bark send failed:', err.message);
  });
}

// Generic webhook notification
function sendWebhookNotification(payload) {
  if (!cfg.WEBHOOK_URL) return;
  webhookHealth.lastSendTime = Date.now();
  const data = JSON.stringify(payload);
  const parsed = new URL(cfg.WEBHOOK_URL);
  const mod = parsed.protocol === 'https:' ? https : http;
  const req = mod.request(parsed, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    webhookHealth.lastSuccess = res.statusCode >= 200 && res.statusCode < 300;
    if (!webhookHealth.lastSuccess) webhookHealth.lastError = `HTTP ${res.statusCode}`;
    else webhookHealth.lastError = '';
    res.resume();
  });
  req.on('error', err => {
    webhookHealth.lastSuccess = false;
    webhookHealth.lastError = err.message;
    console.error('[multicc/push] Webhook send failed:', err.message);
  });
  req.end(data);
}

// Load persisted subscriptions on first require (was loadPushSubscriptions() at startup).
loadSubscriptions();

module.exports = {
  cfg,
  applyEnvUpdates,
  subscriptions,
  healthStats,
  globalStats,
  barkHealth,
  webhookHealth,
  getHealthEntry,
  loadSubscriptions,
  saveSubscriptions,
  sendPushToAll,
  sendBarkNotification,
  sendWebhookNotification,
};
