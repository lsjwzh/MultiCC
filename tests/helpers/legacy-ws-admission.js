'use strict';
// Frozen transcription of the WebSocket connection admission gate, captured
// 2026-11-20 as the differential oracle for multicc_core::ws_admission.
//
// Source: src/ws/connection-router.js, the ordered block between the close
// listener and the per-path dispatch (lines 144-219 of the checkout this was
// frozen from). Transcribed statement for statement, including the order in
// which metrics, logs and socket annotations happen relative to the close that
// ends the connection -- the close log line reads `ws._correlationId`, so an
// annotation written before a refusal is observable.
//
//   if (getShuttingDown()) { ws.close(1012, 'server shutting down'); return; }
//   if (!isRequestPeerAllowed(req)) { metric; ws.close(4003, '...'); return; }
//   if (!nativeSocket) installNativeQueue(ws, wsHost, connId, wsPorts, map);
//   let sharePerm = null;
//   if (path === '/ws/chat' && share param) {
//     const access = share.access(param, { cookies });
//     if (access && access.sessionId === session param) sharePerm = access.access;
//     if (!sharePerm) { ws.close(4003, 'Forbidden'); return; }
//   }
//   if (!sharePerm) {  // one-use ticket is consumed only on this branch
//     const ticket = has('ticket') && consumeWsTicket(get('ticket'), path);
//     const legacyCookie = accessToken && allowLegacyWsCookie
//       && cookies.multicc_auth && verifyCookie(cookies.multicc_auth);
//     const legacyToken = accessToken && allowLegacyWsToken
//       && verifyAccessToken(get('token'));
//     if (ticket?.machineGrantId) {
//       if (!machines?.active(id)) { ws.close(4003, '...'); return; }
//       ws._machineGrantId = ticket.machineGrantId;
//     }
//     if (ticket) ws._correlationId = ticket.correlationId || ticket.requestId;
//     if (ticket && fleet scope mismatch) { metric; ws.close(4003, 'Forbidden'); return; }
//     if (legacyCookie || legacyToken) { metric; logger.warn('legacy_ws_auth', ...); }
//     if (!local && (!accessToken || (!ticket && !legacyCookie && !legacyToken))) {
//       metric; ws.close(4003, 'Forbidden'); return;
//     }
//   }
//   if (addressedSessionId && isInternalExecutionSlot(record)) {
//     sendWs(ws, { type: 'error', error: 'Session does not exist.', ... });
//     ws.close(); return;
//   }
//   if (path === '/ws/chat') { ws._sharePerm = sharePerm; return handleChatWs(...); }
//
// `addressedSessionId` is the `session` query parameter on /ws/chat, the `id`
// parameter on the session paths and null on the sessionless paths; it is
// computed before this block and is a fact here.

const PEER_REJECTED = 'multicc_ws_public_peer_rejected_total';
const FLEET_DENIED = 'multicc_ws_fleet_scope_denied_total';
const LEGACY_AUTH = 'multicc_ws_legacy_auth_total';
const AUTH_DENIED = 'multicc_ws_auth_denied_total';

// `share.access` is consulted before the one-use ticket, so the share outcome
// decides whether the ticket is consumed at all. Both entry points below read
// this one function; the kernel mirrors that with `needs_ticket`.
function sharePermission(f) {
  if (!(f.path === '/ws/chat' && f.shareParam)) return { branch: false, permission: null };
  const access = f.shareAccess;
  let permission = null;
  if (access && access.sessionId === f.sessionParam) permission = access.access;
  return { branch: true, permission: permission || null };
}

// True when the admission reaches the auth phase, which is the only caller of
// the one-use ticket. A refused share never consumes one.
function consumesTicket(f) {
  if (f.shuttingDown || !f.peerAllowed) return false;
  const share = sharePermission(f);
  if (share.branch && !share.permission) return false;
  return !share.permission;
}

function plan(f) {
  const steps = [];
  if (f.shuttingDown) {
    steps.push({ op: 'close', code: 1012, reason: 'server shutting down' });
    return steps;
  }
  if (!f.peerAllowed) {
    steps.push({ op: 'metric', name: PEER_REJECTED });
    steps.push({ op: 'close', code: 4003, reason: 'Direct public access disabled' });
    return steps;
  }
  // The two workspace hosts bring their own send queue; patching `ws.send`
  // for them as well would install a second one. Position matters: the queue
  // goes on after the two early refusals and before any credential work.
  if (!f.nativeSocket) steps.push({ op: 'installSendQueue' });
  const share = sharePermission(f);
  const sharePerm = share.permission;
  if (share.branch && !sharePerm) {
    steps.push({ op: 'close', code: 4003, reason: 'Forbidden' });
    return steps;
  }
  if (!sharePerm) {
    // `has('ticket') && consume(...)`: no parameter yields false, a failed
    // consume yields null. Both are falsy, so the two are indistinguishable
    // from here on.
    const ticket = f.hasTicketParam ? (f.ticket || null) : null;
    const legacyCookie = !!(f.accessToken && f.allowLegacyWsCookie
      && f.authCookie && f.cookieValid);
    const legacyToken = !!(f.accessToken && f.allowLegacyWsToken && f.tokenValid);
    if (ticket && ticket.machineGrantId) {
      if (!(f.machinesPresent && f.machineActive)) {
        steps.push({ op: 'close', code: 4003, reason: '电脑授权已撤销' });
        return steps;
      }
      steps.push({ op: 'machineGrant', value: ticket.machineGrantId });
    }
    if (ticket) {
      steps.push({ op: 'correlationId', value: ticket.correlationId || ticket.requestId || null });
    }
    if (ticket && ((ticket.fleetSessionId && ticket.fleetSessionId !== f.addressedSessionId)
        || (ticket.fleetDirectoryId && ticket.fleetDirectoryId !== f.addressedDirectoryId))) {
      steps.push({ op: 'metric', name: FLEET_DENIED });
      steps.push({ op: 'close', code: 4003, reason: 'Forbidden' });
      return steps;
    }
    if (legacyCookie || legacyToken) {
      steps.push({ op: 'metric', name: LEGACY_AUTH });
      steps.push({
        op: 'legacyWarning',
        path: f.path,
        mode: legacyToken ? 'query' : 'cookie',
        ip: f.ip === undefined ? null : f.ip,
      });
    }
    if (!f.local && (!f.accessToken || (!ticket && !legacyCookie && !legacyToken))) {
      steps.push({ op: 'metric', name: AUTH_DENIED });
      steps.push({ op: 'close', code: 4003, reason: 'Forbidden' });
      return steps;
    }
  }
  if (f.addressedSessionId && f.sessionInternalSlot) {
    steps.push({ op: 'sessionMissing' });
    // `ws.close()` with no arguments: an empty close frame, not 1000 with a
    // reason.
    steps.push({ op: 'close', code: null, reason: null });
    return steps;
  }
  // The chat dispatch assigns `ws._sharePerm = sharePerm` for every admitted
  // chat client, null included.
  if (f.path === '/ws/chat') steps.push({ op: 'sharePermission', value: sharePerm });
  steps.push({ op: 'accept' });
  return steps;
}

module.exports = {
  PEER_REJECTED, FLEET_DENIED, LEGACY_AUTH, AUTH_DENIED,
  sharePermission, consumesTicket, plan,
};
