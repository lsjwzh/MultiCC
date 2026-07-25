'use strict';

// Per-session metadata routes: the inter-agent notes inbox/outbox (POST and
// GET /api/sessions/:id/notes) and the liveness probe (GET .../liveness).
//
// Extracted verbatim from server.js. Behaviour is preserved exactly; mutable
// host state is reached through functions only — `notes` is a `let` array that
// loadNotes/purgeNotesForSession wholesale reassign, so the module receives
// getNotes()/saveNotes()/pendingNotesFor() and never the array itself, and
// livenessRuntime (composed from src/liveness/runtime further up the host) is
// resolved per request through a getter.

const crypto = require('crypto');

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[session-meta] ${name} must be a function`);
  }
}

function createSessionMetaRuntime(rawDeps) {
  const deps = rawDeps || {};
  const {
    persistedSessions,
    asyncHandler,
    appendEvent,
    workspaceBroadcast,
    saveNotes,
    pendingNotesFor,
    getNotes,
    getLivenessRuntime,
  } = deps;

  if (!persistedSessions || typeof persistedSessions.get !== 'function') {
    throw new TypeError('[session-meta] persistedSessions map is required');
  }
  for (const [fn, name] of [
    [asyncHandler, 'asyncHandler'], [appendEvent, 'appendEvent'],
    [workspaceBroadcast, 'workspaceBroadcast'], [saveNotes, 'saveNotes'],
    [pendingNotesFor, 'pendingNotesFor'], [getNotes, 'getNotes'],
    [getLivenessRuntime, 'getLivenessRuntime'],
  ]) assertFunction(fn, name);

  function mountRoutes(app) {
    // ── Inter-agent notes ──
    app.post('/api/sessions/:id/notes', (req, res) => {
      const from = persistedSessions.get(req.params.id);
      if (!from) return res.status(404).json({ error: 'session not found' });
      const toId = (req.body.toSessionId || '').trim();
      const body = (req.body.body || '').trim();
      if (!toId || !body) return res.status(400).json({ error: 'toSessionId 和 body 必填' });
      const to = persistedSessions.get(toId);
      if (!to) return res.status(404).json({ error: 'target session not found' });
      if (to.dirId !== from.dirId) return res.status(400).json({ error: '只能给同一目录下的会话留言' });

      const note = {
        id: crypto.randomUUID(), dirId: from.dirId,
        fromSessionId: from.id, fromLabel: from.label || from.id,
        toSessionId: to.id, body: body.slice(0, 4000),
        ts: Date.now(), delivered: false, deliveredAt: null,
      };
      getNotes().push(note);
      saveNotes();
      appendEvent(from.dirId, 'note', `→ ${to.label || to.id}`, from.id);
      workspaceBroadcast(from.dirId, { type: 'note_pending', sessionId: to.id, count: pendingNotesFor(to.id).length });
      res.json(note);
    });

    // Session liveness: working (producing / awaiting model) vs idle vs stalled.
    // ?probe=0 skips the process-level lsof/rollout check for a cheap event-only read.
    app.get('/api/sessions/:id/liveness', asyncHandler(async (req, res) => {
      const s = persistedSessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'session not found' });
      const wantProbe = req.query.probe !== '0';
      const v = await getLivenessRuntime().assess(req.params.id, { probe: wantProbe });
      res.json(v);
    }));

    // Inbox + outbox for a session.
    app.get('/api/sessions/:id/notes', (req, res) => {
      const s = persistedSessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'session not found' });
      res.json(getNotes().filter(n => n.toSessionId === s.id || n.fromSessionId === s.id));
    });
  }

  return { mountRoutes };
}

module.exports = { createSessionMetaRuntime };
