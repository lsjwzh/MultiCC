'use strict';
const { getNative } = require('../../../src/native/runtime');

function lostMessageText(error) {
  return getNative().chatLostNotice(error);
}

function stuckDeliveryText({ reason = 'session_busy', reasons = [], waitedMs = 0 } = {}) {
  const list = reasons.length ? reasons.join('、') : reason;
  return getNative().chatQueuedNotice(reason === 'delivery_locked', `${list}`, Number(waitedMs || 0));
}

function heldBackgroundText({ waitedMs = 0 } = {}) {
  return getNative().chatHeldNotice(Number(waitedMs || 0));
}

function heldCapText({ minutes = 0 } = {}) {
  // A live value may return a different number on the second conversion.
  return getNative().chatHoldCapNotice(Number(minutes) >= 1 ? Math.round(Number(minutes)) : null);
}

function createSessionNotices({ appendChatMessage, chatBroadcast, now = Date.now, logger = console }) {
  function warn(event, fields) {
    try { logger?.warn?.(event, fields); } catch (_) {}
  }

  // A notice is a live broadcast on top of a durable append. Neither side may
  // reject through the caller: most call sites fire this without awaiting it
  // (a stuck-delivery notice sits inside a synchronous try/catch), so an
  // unhandled rejection here would take the whole server down.
  function broadcastNotice(sessionId, text) {
    try {
      chatBroadcast?.(sessionId, { type: 'system', subtype: 'notice', message: text });
    } catch (error) {
      warn('chat_notice_broadcast_failed', {
        sessionId,
        message: error && error.message ? error.message : String(error),
      });
    }
  }

  // Persist first: a live broadcast that no client happened to receive is the
  // same silence this exists to end, and the append is what a reload shows.
  // The returned promise always resolves (true = durable and broadcast;
  // false = the line did not land) so a fire-and-forget caller is safe.
  function say(sessionId, text) {
    if (!sessionId || typeof appendChatMessage !== 'function') return undefined;
    let saved;
    try {
      saved = appendChatMessage(sessionId, { role: 'system', content: text, ts: now() });
    } catch (error) {
      warn('chat_notice_persist_failed', {
        sessionId,
        message: error && error.message ? error.message : String(error),
      });
      return false;
    }
    if (saved && typeof saved.then === 'function') {
      return Promise.resolve(saved).then(ok => {
        if (!ok) return false;
        broadcastNotice(sessionId, text);
        return true;
      }, error => {
        warn('chat_notice_persist_failed', {
          sessionId,
          message: error && error.message ? error.message : String(error),
        });
        return false;
      });
    }
    if (!saved) return false;
    broadcastNotice(sessionId, text);
    return true;
  }
  return {
    notifyLostMessage({ sessionId, error }) { return say(sessionId, lostMessageText(error)); },
    notifyStuckDelivery({ sessionId, reason, reasons, waitedMs, heldForBackground = false }) {
      return say(sessionId, heldForBackground
        ? heldBackgroundText({ waitedMs })
        : stuckDeliveryText({ reason, reasons, waitedMs }));
    },
    notifyHoldCap({ sessionId, minutes }) { return say(sessionId, heldCapText({ minutes })); },
  };
}

module.exports = {
  createSessionNotices, lostMessageText, stuckDeliveryText, heldBackgroundText, heldCapText,
};
