'use strict';

// One world for both sides of the docs / memory / memo / directory-events
// differential (docs/rust-migration/differential/docs-memory-routes.js).
//
// The Node side mounts the frozen retired handlers over it in-process; the
// Rust front door's Node child mounts the current host composition
// (src/routes/docs-memory-host.js) over a second copy with the same seed. Both
// processes see byte-identical media, so a difference can only come from the
// retired handlers versus the Rust kernel + host port split.
//
// Nothing here writes outside the data root it is handed.

const fs = require('fs');
const path = require('path');

const { atomicWriteJson, ensurePrivateDir } = require('../../src/runtime-security');

// The memory store the graph/tree walk, plus the file-editing corpus.
const MEMORY_FILES = {
  '_machine/global.md': '---\ntype: note\n---\n# Global\n\nmachine-wide [[shared]]\n',
  '_cli/claude/cli.md': '# CLI\n\nsee [[shared]]\n',
  'p-one/_shared/shared.md': '# Shared\n\nlinks [[global]] and [[missing-node]]\n',
  'p-one/tasks/t1/task.md': '# Task\n\n[[shared]]\n',
  'p-one/skills/s1/skill.md': '# Skill\n\n[[task]]\n',
  'p-one/sessions/sess-1/session.md': '# Session\n\n[[shared]]\n',
  'p-two/_shared/other.md': '# Other\n',
};

// Fixed ids and timestamps keep every read and HEAD case byte-for-byte; only
// the register/patch cases mint ids and timestamps of their own. `pinned` on a
// non-artifact row exercises the rank sort plus the load() permanent upgrade
// without pulling the artifact dependency walk into the comparison.
const DOCS_ENTRIES = [
  {
    id: 'doc_seed01', title: 'Shared notes', url: '/docs/shared', kind: 'page',
    note: 'hand-written page', source: 'agent', dir: '/work/app',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'doc_seed02', title: 'Pinned page', url: '/docs/pinned', kind: 'page',
    source: 'agent', pinned: true, createdAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'doc_seed04', title: 'Long note', url: '/docs/long', kind: 'page',
    note: 'x'.repeat(400), source: 'agent', createdAt: '2026-01-04T00:00:00.000Z',
  },
  {
    id: 'doc_seed05', title: 'Session page', url: '/docs/session', kind: 'page',
    source: 'agent', sessionId: 'task-abcdefabcdefabcdefabcdefabcdef12',
    createdAt: '2026-01-05T00:00:00.000Z',
  },
];

const EVENTS_SEED = [
  { ts: 1767225600000, type: 'note', sessionId: null, sessionLabel: null, detail: 'first' },
  { ts: 1767225601000, type: 'commit', sessionId: 'sess-1', sessionLabel: 'S', detail: null },
];

const SESSION_TASK = 'task-abcdefabcdefabcdefabcdefabcdef12';
const TASK_ID = 'tsk_abcdefabcdefabcdefabcdefabcdef12';

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The recent-event ring the native workspace socket owner would provide. */
function createEventRing() {
  const rings = new Map();
  return {
    has: dirId => rings.has(dirId),
    recent: dirId => (rings.get(dirId) || []).slice(-200),
    hydrate: (dirId, events) => {
      rings.set(dirId, Array.isArray(events) ? events.slice(-200) : []);
    },
    append: (dirId, event) => {
      const ring = rings.get(dirId) || [];
      ring.push(event);
      rings.set(dirId, ring.slice(-200));
    },
  };
}

/** Seed `dataRoot` (idempotent) and compose the dependency bags. */
function buildState(dataRoot) {
  const memoryRoot = path.join(dataRoot, 'memory-store');
  const memoRoot = path.join(dataRoot, 'memo-store');
  const eventsDir = path.join(dataRoot, 'events');
  const projectPath = path.join(dataRoot, 'project');
  const notesFile = path.join(dataRoot, 'notes.json');

  fs.mkdirSync(projectPath, { recursive: true });
  ensurePrivateDir(eventsDir);
  ensurePrivateDir(memoRoot);
  fs.mkdirSync(memoryRoot, { recursive: true });
  for (const [rel, text] of Object.entries(MEMORY_FILES)) {
    writeText(path.join(memoryRoot, ...rel.split('/')), text);
  }
  writeText(path.join(eventsDir, 'dir-1.jsonl'),
    EVENTS_SEED.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeText(path.join(memoRoot, 'dir-1', 'memo.md'), '# Memo\n\nhello from the seeded world\n');
  const store = path.join(dataRoot, 'docs_registry.json');
  if (!fs.existsSync(store)) atomicWriteJson(store, DOCS_ENTRIES);

  const directories = new Map([
    ['dir-1', { id: 'dir-1', name: 'Project One', path: projectPath }],
    ['dir-2', { id: 'dir-2', name: 'Project Two', path: projectPath }],
    ['p-one', { id: 'p-one', name: 'Project One', path: projectPath }],
  ]);
  const persistedSessions = new Map();
  const ring = createEventRing();

  return {
    dataRoot,
    memoryRoot,
    memoRoot,
    eventsDir,
    notesFile,
    projectPath,
    directories,
    persistedSessions,
    ring,
    effects: path.join(dataRoot, 'effects.log'),
  };
}

// artifact <-> task lookups; the production values come from the task shell
// host, which has no bearing on the retired handlers' assembly.
const artifactTaskId = id =>
  (new RegExp(`^task-([a-f0-9]{32})$`).test(String(id || '')) ? `tsk_${String(id).slice(5)}` : null);
const artifactTaskTitle = taskId => (taskId === TASK_ID ? 'Session task' : null);
const resolveDir = id => (id === SESSION_TASK ? '/work/app' : null);

/** The three `docs-registry` mount options (frozen oracle and host port alike). */
function docsDeps() {
  return {
    artifactExists: () => false,
    resolveTaskId: artifactTaskId,
    resolveTaskTitle: artifactTaskTitle,
    resolveDir,
  };
}

function memoryDeps(state) {
  return {
    fs,
    path,
    memoryStoreRoot: state.memoryRoot,
    directories: state.directories,
    persistedSessions: state.persistedSessions,
    workspaceBroadcast: () => {},
    atomicWriteText: (file, text) => writeText(file, text),
    now: Date.now,
  };
}

function notesDeps(state) {
  return {
    eventsDir: state.eventsDir,
    notesFile: state.notesFile,
    persistedSessions: state.persistedSessions,
    directories: state.directories,
    atomicWriteJson,
    ensurePrivateDir,
    getWorkspaceBroadcast: () => null,
    getWorkspaceEvents: () => state.ring,
  };
}

// The session records and the turn admission a memo send reaches. `runTurn`
// records the delivered turn in the side's effect log, so the differential
// compares the side effect as well as the answer.
function memoDeps(state) {
  return {
    directories: {
      get: id => state.directories.get(id),
      list: () => [...state.directories.values()],
    },
    sessions: {
      get: id => ({
        'sess-1': { id: 'sess-1', dirId: 'dir-1', kind: 'chat' },
        'sess-x': { id: 'sess-x', dirId: 'dir-2', kind: 'chat' },
        'sess-t': { id: 'sess-t', dirId: 'dir-1', kind: 'terminal' },
      })[id] || null,
    },
    runtime: {
      getChatSession: () => ({}),
      runTurn: async (id, text) => {
        fs.appendFileSync(state.effects, `turn:${id}:${text}\n`);
        return true;
      },
    },
    memoRoot: state.memoRoot,
    log: () => {},
  };
}

module.exports = {
  DOCS_ENTRIES,
  EVENTS_SEED,
  MEMORY_FILES,
  SESSION_TASK,
  TASK_ID,
  artifactTaskId,
  artifactTaskTitle,
  buildState,
  createEventRing,
  docsDeps,
  memoDeps,
  memoryDeps,
  notesDeps,
  resolveDir,
  writeText,
};
