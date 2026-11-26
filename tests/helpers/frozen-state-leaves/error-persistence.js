'use strict';

// ── Persisted chat errors ────────────────────────────────────────────────────
//
// A turn's failure (provider 4xx/5xx, a Codex stream error, a lost message…) is
// broadcast as `{ type: 'error' }` and drawn as a live system line, but nothing
// wrote it to the transcript — so after a reload or a reopened session there was
// no trace of what had gone wrong. This writes the same line into chat history
// as a system message, keyed by a clientMsgId that the live broadcast carries as
// `errorClientMsgId`, so the page that watched it live and a page that replays
// history agree on one line instead of drawing it twice.

const crypto = require('node:crypto');

const DEDUPE_WINDOW_MS = 10_000;
const MAX_TEXT = 4000;

// Same predicate as public/chat-event-controller.js: a transient Codex reconnect
// is not shown live, so it must not appear in history either.
function isRecoverableReconnect(text) {
  const value = String(text || '').trim();
  const prefix = /^(?:Codex|Codex Exp|Codex Exec) 出错：Reconnecting\.\.\.\s*\d+\/\d+/i;
  if (!prefix.test(value)) return false;
  if (/^(?:Codex|Codex Exp|Codex Exec) 出错：Reconnecting\.\.\.\s*\d+\/\d+\s*$/i.test(value)) return true;
  return /\(.*(?:stream disconnected before completion|response\.completed).*\)\s*$/i.test(value);
}

function createErrorPersister({ appendChatMessage, now = Date.now, windowMs = DEDUPE_WINDOW_MS, logger = console }) {
  const recent = new Map(); // `${sessionId}\n${text}` → { at, clientMsgId }

  function warn(event, fields) {
    try { logger?.warn?.(event, fields); } catch (_) {}
  }

  // Returns the payload to broadcast: the original one, or a copy that carries
  // `errorClientMsgId` so the live line and a history replay reconcile onto one
  // record instead of drawing it twice. The write is asynchronous and the
  // broadcast must not wait for its fsync, so the id is advertised up front;
  // a failed write only means the line will not survive a reload.
  function annotate(sessionId, payload) {
    if (!sessionId || payload?.type !== 'error' || typeof appendChatMessage !== 'function') return payload;
    const text = String(payload.error ?? '').trim().slice(0, MAX_TEXT);
    if (!text || isRecoverableReconnect(text)) return payload;
    let claimedKey = null;
    let claimedEntry = null;
    try {
      const at = now();
      for (const [key, entry] of recent) if (at - entry.at > windowMs) recent.delete(key);
      const key = `${sessionId}\n${text}`;
      const seen = recent.get(key);
      if (seen) return { ...payload, errorClientMsgId: seen.clientMsgId };
      const clientMsgId = `err-${crypto.createHash('sha1').update(`${key}\n${at}`).digest('hex').slice(0, 16)}`;
      // Register the entry before starting the write so two identical broadcasts
      // cannot enqueue the same line twice while the first is in flight. It is
      // only a *pending* claim: if the write fails, roll it back so the error
      // can be retried instead of staying permanently absent from history while
      // the broadcast already advertised its clientMsgId.
      const entry = { at, clientMsgId };
      recent.set(key, entry);
      claimedKey = key;
      claimedEntry = entry;
      const onFailure = (error) => {
        if (recent.get(key) === entry) recent.delete(key);
        warn('chat_error_persist_failed', {
          sessionId,
          message: error && error.message ? error.message : String(error),
        });
      };
      const record = appendChatMessage(sessionId, {
        role: 'system',
        content: `Error: ${text}`,
        ts: at,
        clientMsgId,
        errorEvent: true,
        errorCode: typeof payload.code === 'string' ? payload.code : undefined,
      });
      if (record && typeof record.then === 'function') {
        record.then(saved => { if (saved === false) onFailure(new Error('append rejected')); }, onFailure);
      } else if (record === false) {
        onFailure(new Error('append rejected'));
      }
      return { ...payload, errorClientMsgId: clientMsgId };
    } catch (error) {
      // A synchronous throw means nothing was enqueued: release the claim too,
      // or a later identical error would advertise an id with no row behind it.
      if (claimedEntry && recent.get(claimedKey) === claimedEntry) recent.delete(claimedKey);
      warn('chat_error_persist_failed', {
        sessionId,
        message: error && error.message ? error.message : String(error),
      });
      return payload; // persistence must never break the live broadcast
    }
  }

  return { annotate };
}

module.exports = { createErrorPersister, isRecoverableReconnect };
