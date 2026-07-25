'use strict';

// Event log + passive inter-agent notes store.
// Each directory has an append-only event log (events/<dirId>.jsonl) and a shared
// pool of notes. A note left for another agent is delivered passively — prepended
// to that agent's next chat turn.
//
// Extracted verbatim from server.js. Behaviour is preserved exactly; host
// collaboration is injected through deps:
//   · persistedSessions / directories are boot-loaded Maps and stay live by ref
//   · workspaceBroadcast fans an event out to the workspace Meta channel; it is
//     composed AFTER this store in server.js, so the store receives
//     getWorkspaceBroadcast() and resolves it per call (pre-broadcast appends
//     simply skip the fan-out, matching the old behaviour where module-level
//     appends ran before workspace clients could exist)
// The `notes` array is module-private mutable state — loadNotes() and
// purgeNotesForSession() reassign it wholesale — so it is NEVER exposed by
// reference; consumers go through loadNotes/saveNotes/getNotes/pendingNotesFor.

const fs = require('fs');
const path = require('path');

function createNotesStore(rawDeps) {
  const deps = rawDeps || {};
  const {
    eventsDir,
    notesFile,
    persistedSessions,
    directories,
    atomicWriteJson,
    ensurePrivateDir,
    getWorkspaceBroadcast,
  } = deps;

  if (!eventsDir || typeof eventsDir !== 'string') {
    throw new TypeError('[notes-store] eventsDir is required');
  }
  if (!notesFile || typeof notesFile !== 'string') {
    throw new TypeError('[notes-store] notesFile is required');
  }
  if (!persistedSessions || typeof persistedSessions.get !== 'function') {
    throw new TypeError('[notes-store] persistedSessions map is required');
  }
  if (!directories || typeof directories.get !== 'function') {
    throw new TypeError('[notes-store] directories map is required');
  }
  if (typeof atomicWriteJson !== 'function') {
    throw new TypeError('[notes-store] atomicWriteJson must be a function');
  }
  if (typeof ensurePrivateDir !== 'function') {
    throw new TypeError('[notes-store] ensurePrivateDir must be a function');
  }
  if (typeof getWorkspaceBroadcast !== 'function') {
    throw new TypeError('[notes-store] getWorkspaceBroadcast must be a function');
  }

  const EVENTS_DIR = eventsDir;
  try { ensurePrivateDir(EVENTS_DIR); } catch (_) {}
  const NOTES_FILE = notesFile;
  const eventRing = new Map();   // dirId → event[] (last 200, lazy-loaded)
  let notes = [];                // [{ id, dirId, fromSessionId, fromLabel, toSessionId, body, ts, delivered, deliveredAt }]

  function loadNotes() {
    try {
      if (fs.existsSync(NOTES_FILE)) notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    } catch (e) {
      console.error('[multicc] load notes.json failed:', e.message);
      notes = [];
    }
  }
  function saveNotes() {
    try { atomicWriteJson(NOTES_FILE, notes); }
    catch (e) { console.error('[multicc] save notes.json failed:', e.message); }
  }

  // Lazy-load a directory's recent events from disk into the ring buffer.
  function recentEvents(dirId) {
    if (eventRing.has(dirId)) return eventRing.get(dirId);
    const ring = [];
    try {
      const file = path.join(EVENTS_DIR, `${dirId}.jsonl`);
      if (fs.existsSync(file)) {
        for (const l of fs.readFileSync(file, 'utf8').trim().split('\n').slice(-200)) {
          try { ring.push(JSON.parse(l)); } catch (_) {}
        }
      }
    } catch (_) {}
    eventRing.set(dirId, ring);
    return ring;
  }

  // Append an event to a directory's log + ring buffer, and broadcast it live.
  function appendEvent(dirId, type, detail, sessionId) {
    if (!dirId) return;
    const session = sessionId ? persistedSessions.get(sessionId) : null;
    const evt = {
      ts: Date.now(), type,
      sessionId: sessionId || null,
      sessionLabel: session ? (session.label || session.id) : (sessionId || null),
      detail: detail || null,
    };
    const ring = recentEvents(dirId);
    ring.push(evt);
    if (ring.length > 200) ring.shift();
    try { fs.appendFileSync(path.join(EVENTS_DIR, `${dirId}.jsonl`), JSON.stringify(evt) + '\n', { mode: 0o600 }); }
    catch (_) {}
    const broadcast = getWorkspaceBroadcast();
    if (typeof broadcast === 'function') broadcast(dirId, { type: 'event', event: evt });
  }

  function pendingNotesFor(sessionId) {
    return notes.filter(n => n.toSessionId === sessionId && !n.delivered);
  }

  // Drop all notes referencing a session (called when it is deleted).
  function purgeNotesForSession(sessionId) {
    const before = notes.length;
    notes = notes.filter(n => n.toSessionId !== sessionId && n.fromSessionId !== sessionId);
    if (notes.length !== before) saveNotes();
  }

  function mountRoutes(app) {
    // Directory event log.
    app.get('/api/directories/:id/events', (req, res) => {
      const d = directories.get(req.params.id);
      if (!d) return res.status(404).json({ error: 'directory not found' });
      res.json({ events: recentEvents(d.id) });
    });
  }

  return {
    loadNotes,
    saveNotes,
    recentEvents,
    appendEvent,
    pendingNotesFor,
    purgeNotesForSession,
    getNotes: () => notes,
    mountRoutes,
  };
}

module.exports = { createNotesStore };
