'use strict';

// Launch tickets for the global realtime voice gateway.
//
// A voice launch is the only thing a client may ask for. The client never names
// a directory, cwd, Commander, or prompt: it says either "global" (the Dashboard
// button) or "this chat" (the chat session's own phone button), and the Host
// resolves everything else from its own records. What the client receives back
// is an opaque id that means nothing outside this registry.
//
// The ticket is not a snapshot. `resolve` re-derives the routing target from
// live records on every prompt, so a deleted/retyped source session or Router is
// rejected on the next utterance. A ticket never falls back to some other target
// — a voice request must not land somewhere the user did not mean.

const crypto = require('crypto');
const { VOICE_ROUTER_ID, isVoiceRouterRecord } = require('./voice-router');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TICKETS = 64;
const GLOBAL_VOICE_ROUTER_ID = VOICE_ROUTER_ID;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createVoiceLaunchRegistry({
  records,
  directories,
  resolveCommander,
  now = () => Date.now(),
  randomId = () => crypto.randomBytes(24).toString('hex'),
  ttlMs = DEFAULT_TTL_MS,
  maxTickets = MAX_TICKETS,
} = {}) {
  if (!(records instanceof Map)) throw new TypeError('voice launch registry requires records Map');
  if (!(directories instanceof Map)) throw new TypeError('voice launch registry requires directories Map');
  if (typeof resolveCommander !== 'function') {
    throw new TypeError('voice launch registry requires resolveCommander');
  }

  const tickets = new Map();
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULT_TTL_MS;
  const capacity = Number.isInteger(maxTickets) && maxTickets > 0 ? maxTickets : MAX_TICKETS;

  function sweep() {
    const cutoff = now();
    for (const [id, ticket] of tickets) {
      if (ticket.expiresAt <= cutoff) tickets.delete(id);
    }
    // Oldest-first eviction keeps a runaway client from pinning the map; the
    // evicted ticket simply stops resolving, which fails closed.
    while (tickets.size > capacity) {
      const oldest = tickets.keys().next();
      if (oldest.done) break;
      tickets.delete(oldest.value);
    }
  }

  // A chat launch may only name a session the Host can still see, and only a
  // real conversation — never an aux/gateway internal or a bare terminal, which
  // has no chat transport for the voice turn to ride on.
  function chatContext(sourceSessionId) {
    const id = clean(sourceSessionId);
    if (!id) return { ok: false, code: 'voice_launch_source_required' };
    const record = records.get(id);
    if (!record) return { ok: false, code: 'voice_launch_source_not_found' };
    if (record.type === 'aux' || record.type === 'gateway') {
      return { ok: false, code: 'voice_launch_source_not_addressable' };
    }
    if (record.kind !== 'chat') return { ok: false, code: 'voice_launch_source_not_chat' };
    const directory = record.dirId ? directories.get(record.dirId) : null;
    if (!directory) return { ok: false, code: 'voice_launch_directory_not_found' };
    return {
      ok: true,
      context: {
        scope: 'chat',
        sourceSessionId: id,
        targetSessionId: id,
        directoryId: record.dirId,
        directoryLabel: directory.label || directory.name || '',
        cwd: directory.path || directory.cwd || '',
        commanderSessionId: null,
        display: record.label || id,
      },
    };
  }

  // A global launch lands on the voice router, which is the one session allowed
  // to decide which Fleet the work belongs to. Resolving it here — rather than
  // letting the client or the ACP agent pick — is what keeps an ambiguous
  // "deploy the thing" from being guessed onto an arbitrary Fleet.
  function globalContext() {
    const router = records.get(GLOBAL_VOICE_ROUTER_ID);
    if (!router) return { ok: false, code: 'voice_router_not_provisioned' };
    if (!isVoiceRouterRecord(router)) return { ok: false, code: 'voice_router_id_conflict' };
    return {
      ok: true,
      context: {
        scope: 'global',
        sourceSessionId: null,
        targetSessionId: GLOBAL_VOICE_ROUTER_ID,
        directoryId: router.dirId || null,
        directoryLabel: '',
        cwd: '',
        commanderSessionId: null,
        display: '全局语音',
      },
    };
  }

  function contextFor(scope, sourceSessionId) {
    const resolved = scope === 'chat' ? chatContext(sourceSessionId) : globalContext();
    if (!resolved.ok) return resolved;
    const context = resolved.context;
    // Retain fresh Commander information as compatibility/diagnostic metadata
    // for chat launches. It never selects the delivery target: chat scope stays
    // on its source session and global scope stays on the worker-only Router.
    if (context.directoryId) {
      const commander = resolveCommander(records, context.directoryId);
      context.commanderSessionId = commander.ok ? commander.sessionId : null;
      context.commanderCode = commander.ok ? null : commander.code;
    }
    return { ok: true, context };
  }

  function issue({ scope: rawScope, sourceSessionId } = {}) {
    sweep();
    const scope = clean(sourceSessionId) ? 'chat' : clean(rawScope) || 'global';
    if (scope !== 'chat' && scope !== 'global') {
      return { ok: false, code: 'voice_launch_scope_invalid' };
    }
    const resolved = contextFor(scope, sourceSessionId);
    if (!resolved.ok) return resolved;
    const id = clean(randomId());
    if (!id) return { ok: false, code: 'voice_launch_id_unavailable' };
    const expiresAt = now() + ttl;
    tickets.set(id, {
      id,
      scope,
      sourceSessionId: resolved.context.sourceSessionId,
      issuedAt: now(),
      expiresAt,
    });
    return {
      ok: true,
      launch: {
        id,
        scope,
        sourceSessionId: resolved.context.sourceSessionId,
        expiresAt: new Date(expiresAt).toISOString(),
        display: resolved.context.display,
      },
      context: resolved.context,
    };
  }

  // Called once per voice utterance. Re-validating here (instead of trusting the
  // ticket's issue-time snapshot) is what makes deletion/reclassification take
  // effect immediately and what makes a forged id inert.
  function resolve(launchId) {
    sweep();
    const id = clean(launchId);
    if (!id) return { ok: false, code: 'voice_launch_required' };
    const ticket = tickets.get(id);
    if (!ticket) return { ok: false, code: 'voice_launch_unknown' };
    if (ticket.expiresAt <= now()) {
      tickets.delete(id);
      return { ok: false, code: 'voice_launch_expired' };
    }
    const resolved = contextFor(ticket.scope, ticket.sourceSessionId);
    if (!resolved.ok) return resolved;
    // Sliding expiry: an in-use call stays alive, an abandoned tab does not.
    ticket.expiresAt = now() + ttl;
    return {
      ok: true,
      launchId: id,
      context: { ...resolved.context, launchId: id, expiresAt: new Date(ticket.expiresAt).toISOString() },
    };
  }

  function revoke(launchId) {
    const id = clean(launchId);
    if (!id) return { ok: false, code: 'voice_launch_required' };
    return { ok: tickets.delete(id) };
  }

  function revokeForSession(sessionId) {
    const id = clean(sessionId);
    if (!id) return 0;
    let removed = 0;
    for (const [ticketId, ticket] of tickets) {
      if (ticket.sourceSessionId === id) {
        tickets.delete(ticketId);
        removed += 1;
      }
    }
    return removed;
  }

  return Object.freeze({
    issue,
    resolve,
    revoke,
    revokeForSession,
    sweep,
    size: () => tickets.size,
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  GLOBAL_VOICE_ROUTER_ID,
  MAX_TICKETS,
  createVoiceLaunchRegistry,
};
