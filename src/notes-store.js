'use strict';

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
    getWorkspaceEvents,
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
  if (typeof getWorkspaceEvents !== 'function') {
    throw new TypeError('[notes-store] getWorkspaceEvents must be a function');
  }

  try { ensurePrivateDir(eventsDir); } catch (_) {}
  const eventFile = dirId => path.join(eventsDir, `${dirId}.jsonl`);
  return require('./native/binding').getNative().workspaceNotesOwner({
    load() {
      try { if (fs.existsSync(notesFile)) return JSON.parse(fs.readFileSync(notesFile, 'utf8')); }
      catch (e) { console.error('[multicc] load notes.json failed:', e.message); return []; }
    },
    save(notes) {
      try { atomicWriteJson(notesFile, notes); }
      catch (e) { console.error('[multicc] save notes.json failed:', e.message); }
    },
    filter: (notes, predicate) => notes.filter(predicate),
    events: () => getWorkspaceEvents(), session: id => persistedSessions.get(id),
    has: (owner, id) => owner.has(id), recent: (owner, id) => owner.recent(id),
    hydrate: (owner, id, ring) => owner.hydrate(id, ring),
    lines(id) {
      const file = eventFile(id);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
    },
    parse: line => JSON.parse(line), now: () => Date.now(),
    append: (id, event) => getWorkspaceEvents().append(id, event),
    persist: (id, event) => fs.appendFileSync(eventFile(id), JSON.stringify(event) + '\n', { mode: 0o600 }),
    broadcast: () => getWorkspaceBroadcast(),
  });
}
module.exports = { createNotesStore };
