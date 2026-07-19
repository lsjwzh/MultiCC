'use strict';

// <<dispatch>> marker parsing (pure, extracted verbatim from server.js).
// Recognizes the `<<dispatch target="...">...</dispatch>>` markers a gateway
// reply may carry, the confirm/cancel replies, and the placeholder target ids
// the model must never use as a real target. No host state -- deterministic.

const DISPATCH_RE = /<<dispatch\s+target=["'“”]?([^"'“”>\s]+)["'“”]?\s*>([\s\S]*?)<\/dispatch>>?/;
const DISPATCH_CONFIRM_RE = /^(确认|确定|yes|y|ok)$/i;
const DISPATCH_CANCEL_RE = /^(取消|算了|no|n)$/i;
const DISPATCH_RE_G = /<<dispatch\s+target=["'“”]?([^"'“”>\s]+)["'“”]?\s*>([\s\S]*?)<\/dispatch>>?/g;

// Pull a single dispatch marker out of gateway reply text.
// Returns { target, message, cleanText } (marker removed) or null.
function parseDispatchMarker(text) {
  if (!text) return null;
  const m = text.match(DISPATCH_RE);
  if (!m) return null;
  const target = (m[1] || '').trim();
  const message = (m[2] || '').trim();
  if (!target || !message) return null;
  const cleanText = text.replace(DISPATCH_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { target, message, cleanText };
}

function isDispatchPlaceholderTarget(targetId) {
  const raw = String(targetId || '').trim();
  if (!raw) return true;
  const normalized = raw
    .replace(/[“”"'`]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (/^(\.{2,}|…+)$/.test(normalized)) return true;
  if (/^<[^>]+>$/.test(normalized)) return true;
  return new Set([
    'sid', 'session_id', 'session id', 'sessionid',
    'target', 'target_id', 'target id',
    'worker session id', 'worker-session-id',
    '真实 session id', '真实sessionid',
    '目标会话id', '目标 session id',
  ]).has(normalized);
}

function parseAllDispatchMarkers(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(DISPATCH_RE_G)) {
    const target = (m[1] || '').trim();
    const message = (m[2] || '').trim();
    if (target && message) out.push({ target, message });
  }
  return out;
}

module.exports = {
  DISPATCH_RE,
  DISPATCH_RE_G,
  DISPATCH_CONFIRM_RE,
  DISPATCH_CANCEL_RE,
  parseDispatchMarker,
  isDispatchPlaceholderTarget,
  parseAllDispatchMarkers,
};
