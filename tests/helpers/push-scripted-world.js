'use strict';

// Scripted world for the push cluster (18 public routes now answered by
// native/gateway/src/app/push_routes.rs). One bag of Node facts feeds both
// sides of the migration differential:
//
//   mountLegacy(app, bag)      the frozen HEAD handlers
//                              (tests/helpers/legacy-push-routes/index.js)
//   currentHostOptions(bag)    the live host port composition
//                              (src/routes/push-host.js)
//
// so the comparison covers the split itself: the Rust side decides paths,
// parameter decoding, the request-body gates, the FCM id/token shapes, the
// Bark action vocabulary and every response envelope, and only asks Node for
// the runtime facts through `/api/__host/push`.
//
// Nothing here can reach a real endpoint: the FCM transport, the Bark
// deliverer and the plugin-channel deliverer are scripted functions that
// record their calls instead of opening sockets, the webhook sender only
// records, and the business push receipts live in the case's temp directory.
//
// Every stateful call both sides make is appended to `effects.calls`, which
// the differential compares per case: a route that answers the same bytes but
// asks Node for the wrong thing (or twice) fails.
//
// Each bag gets its own temp directory, so the device/channel/receipt files
// never share a path with another case or with the checkout.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFcmDevices } = require('../../src/push/fcm-devices');
const { createBarkDevices } = require('../../src/push/bark-devices');
const { createChannelSubscriptions } = require('../../src/push/channel-subscriptions');
const { createBusinessPushService, browserPayloadOf } = require('../../src/push/business');

const NOW = 1794687600000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function clone(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function answerOf(answers, key) {
  const entry = answers[key];
  if (entry === undefined) return undefined;
  if (entry.throw) {
    throw Object.assign(new Error(entry.throw.message), entry.throw);
  }
  return clone(entry.value === undefined ? null : entry.value);
}

function buildDeps(rawScenario) {
  const scenario = rawScenario || {};
  const answers = scenario.answers || {};
  const calls = [];
  const record = (entry) => {
    // Bark adds devices with a random uuid; both sides generate their own, so
    // the comparison treats it as one value (the same rewrite the differential
    // applies to response bodies).
    calls.push(JSON.parse(JSON.stringify(entry === undefined ? null : entry).replace(UUID_RE, '<uuid>')));
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-world-'));
  const now = () => NOW;
  // The logger is deliberately silent: the legacy guard logs
  // `[multicc/push] request failed: …` where the host port logs
  // `[push-host] <op> failed: …`. Both are the same failure, so log lines are
  // not part of the compared side-effect sequence (the status/body are).
  const logger = { log() {}, info() {}, warn() {}, error() {} };

  // ── push subscriptions (the same Map both sides read) ────────────────────
  const subscriptions = new Map(Object.entries(scenario.subscriptions || {}));
  const cfg = {
    BARK_URL: scenario.barkUrl || '',
    WEBHOOK_URL: scenario.webhookUrl || '',
  };

  async function saveSubscriptions() {
    record({ call: 'saveSubscriptions', size: subscriptions.size, endpoints: [...subscriptions.keys()].sort() });
    answerOf(answers, 'saveSubscriptions');
    fs.writeFileSync(path.join(dir, 'subscriptions.json'), JSON.stringify([...subscriptions.values()]));
  }

  async function sendPushToAll(payload) {
    record({
      call: 'sendPushToAll',
      subscribers: subscriptions.size,
      payload: typeof payload === 'function' ? '<fn>' : clone(payload),
    });
    const answer = answerOf(answers, 'sendPushToAll');
    if (answer !== undefined) return answer;
    const count = subscriptions.size;
    return {
      subscriberCount: count, deliveryCount: count, failureCount: 0,
      staleCount: 0, remainingSubscriberCount: 0,
    };
  }

  // ── FCM: scripted transport, real device store ───────────────────────────
  const fcmFile = path.join(dir, 'fcm-devices.json');
  if (scenario.fcmSeedInvalid) fs.writeFileSync(fcmFile, 'not json');
  else if (scenario.fcmSeed) fs.writeFileSync(fcmFile, JSON.stringify({ version: 1, devices: scenario.fcmSeed }));
  const transport = {
    projectId: scenario.fcmProjectId === undefined ? 'proj-diff' : scenario.fcmProjectId,
    async send(token, data) {
      record({ call: 'fcmSend', token, data });
      const answer = answerOf(answers, `fcmSend:${token}`);
      return answer === undefined ? { ok: true } : answer;
    },
  };
  const fcmDevices = createFcmDevices({ file: fcmFile, transport, now });

  // ── Bark: scripted deliverer, real device store and health map ───────────
  const barkFile = path.join(dir, 'bark-devices.json');
  if (scenario.barkSeedInvalid) fs.writeFileSync(barkFile, 'not json');
  else if (scenario.barkSeed || scenario.barkLegacy) {
    fs.writeFileSync(barkFile, JSON.stringify({
      version: 1, devices: scenario.barkSeed || [], legacy: scenario.barkLegacy || {},
    }));
  }
  async function deliverBark(url, title, body, link) {
    record({ call: 'deliverBark', url, title, body, link: link || '' });
    if (scenario.barkDeliverThrows) throw new Error(scenario.barkDeliverThrows);
    const answer = answerOf(answers, 'deliverBark');
    return answer === undefined ? { ok: true } : answer;
  }
  const barkDevices = createBarkDevices({ file: barkFile, getLegacyUrl: () => cfg.BARK_URL, deliver: deliverBark });

  // service.js' hasBarkDevices / sendBarkNotification / sendWebhookNotification,
  // with the transport scripted.
  function hasBarkDevices() {
    try { return barkDevices.hasEnabled(); } catch (_) { return false; }
  }
  async function sendBarkNotification(title, body, url) {
    record({ call: 'sendBarkNotification', title, body, link: url || '' });
    try {
      if (!barkDevices.hasEnabled()) return { ok: true, accepted: 0, results: [] };
      return await barkDevices.send(title, body, url);
    } catch (_) {
      return { ok: false, accepted: 0, results: [] };
    }
  }
  async function sendWebhookNotification(payload) {
    record({ call: 'sendWebhookNotification', payload: clone(payload) });
    if (!cfg.WEBHOOK_URL) return;
    const answer = answerOf(answers, 'sendWebhookNotification');
    if (answer !== undefined) throw Object.assign(new Error('webhook failed'), answer);
  }

  // ── plugin channel subscriptions: scripted target check and delivery ─────
  const channelFile = path.join(dir, 'channel-subscriptions.json');
  if (scenario.channelSeedInvalid) fs.writeFileSync(channelFile, 'not json');
  else if (scenario.channelSeed) {
    fs.writeFileSync(channelFile, JSON.stringify({ version: 1, subscriptions: scenario.channelSeed }));
  }
  let channelSeq = 0;
  const channelSubscriptions = createChannelSubscriptions({
    file: channelFile,
    now,
    idFactory: () => `chs_${scenario.case || 'case'}_${++channelSeq}`,
    logger,
    checkTarget: (plugin, target) => {
      record({ call: 'checkTarget', plugin, target });
      const answer = answerOf(answers, `checkTarget:${plugin}:${target}`);
      return answer === undefined ? null : answer;
    },
    deliver: async (plugin, payload) => {
      record({ call: 'deliver', plugin, payload });
      const answer = answerOf(answers, `deliver:${plugin}`);
      return answer === undefined ? { ok: true, receipt: { id: 'rcpt-1' } } : answer;
    },
  });

  // ── business push: the real receipt/dedupe service over a temp store ─────
  const receiptsFile = path.join(dir, 'notification-receipts.json');
  if (scenario.seedReceipt) {
    const request = scenario.seedReceipt.request;
    const payloadHash = scenario.seedReceipt.reuse
      ? 'f'.repeat(64)
      : sha256(JSON.stringify(browserPayloadOf(request)));
    fs.writeFileSync(receiptsFile, JSON.stringify({
      version: 1,
      receipts: {
        [sha256(request.dedupeKey)]: {
          payloadHash,
          deliveredAt: NOW,
          stats: {
            subscriberCount: 1, deliveryCount: 1, failureCount: 0,
            staleCount: 0, remainingSubscriberCount: 0,
          },
        },
      },
    }));
  }
  const businessPush = createBusinessPushService({ sendPushToAll, receiptsFile, now, logger });

  const push = {
    subscriptions, cfg, businessPush,
    saveSubscriptions, sendPushToAll, sendBarkNotification, sendWebhookNotification,
    hasBarkDevices, fcmDevices, barkDevices, channelSubscriptions,
  };

  const bag = {
    scenario, answers, effects: { calls }, push, businessPush, logger, now, dir,
    fcmDevices, barkDevices, channelSubscriptions, subscriptions,
  };
  return bag;
}

/** The stub child swaps bags per host-port call without remounting the app. */
function bindDeps(getBag) {
  const current = () => {
    const value = getBag();
    return value && value.push ? value : value;
  };
  return new Proxy({}, {
    get: (_target, key) => current()[key],
    has: (_target, key) => key in current(),
  });
}

/** Frozen HEAD handlers over one bag. */
function mountLegacy(app, bag) {
  const legacy = require('./legacy-push-routes');
  return legacy.mountRoutes(app, {
    push: bag.push, businessPush: bag.businessPush, logger: bag.logger, now: bag.now,
  });
}

/** The live host-port composition over one bag. */
function currentHostOptions(bag) {
  return {
    push: bag.push,
    businessPush: bag.businessPush,
    isLocal: () => true,
    logger: bag.logger,
    now: bag.now,
  };
}

module.exports = {
  NOW,
  buildDeps,
  bindDeps,
  mountLegacy,
  currentHostOptions,
  answerOf,
};
