'use strict';
// StateStore — durable JSON persistence for multicc's small critical state.
//
// Concerns this module owns and the rest of the codebase must stop reinventing:
//
//   1. Atomic write.   Write to a sibling temp file (same dir, same fs), fsync
//                      the file, rename over the target, then fsync the parent
//                      directory. That last step is the one everyone forgets:
//                      without it, on power-loss the rename can be lost even
//                      though the temp file's contents are durable.
//
//   2. Schema version. Every file carries a { schemaVersion, kind, data }
//                      envelope so a future migration can tell "empty" from
//                      "old". Legacy bare-array files are auto-wrapped on load
//                      (kind is filled in at write time).
//
//   3. Rolling backups. Before each successful write, the previous target is
//                      rotated through .bak1 → .bak2 → … .bakN. If a corrupt
//                      write ever lands, the last known-good is on disk one
//                      rotation away.
//
//   4. Fail-closed on load. A parse error or checksum-shaped corruption throws
//                      a `CorruptedStateError`. Callers MUST decide explicitly
//                      whether to recover from .bakN — the default behaviour
//                      before this module was "log and start from empty", which
//                      silently discards the user's session/directory graph
//                      the next time savePersistedSessions() ran.
//
// Everything else in the codebase (server.js writeFileSync calls, ad hoc temp
// files) is out of scope for this migration; this module is what those calls
// migrate onto over time. First step: sessions.json + directories.json.

const fs = require('fs');
const path = require('path');

const SCHEMA_KEY = '__multiccSchema';
const DEFAULT_ROTATE = 3;
let failureReporter = () => {};

class CorruptedStateError extends Error {
  constructor(msg, meta) {
    super(msg);
    this.name = 'CorruptedStateError';
    Object.assign(this, meta || {});
  }
}

function envelope({ kind, schemaVersion, data }) {
  // On disk we always write an object envelope. The `data` field is the actual
  // payload the caller cares about. Kept flat so a manual `jq .data` still
  // works without diving into a nested wrapper.
  return { [SCHEMA_KEY]: { kind, version: schemaVersion, writtenAt: null }, data };
}

// fsync a file descriptor if it's still open; ignore ENOTSUP (some in-memory
// filesystems in CI don't implement fsync — no-op is fine).
function tryFsync(fd) {
  try { fs.fsyncSync(fd); }
  catch (e) { if (e && e.code !== 'ENOTSUP' && e.code !== 'EINVAL') throw e; }
}

// fsync a directory. Same tolerance as tryFsync().
function fsyncDir(dirPath) {
  let fd = null;
  try {
    fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
    tryFsync(fd);
  } catch (e) {
    // Windows can't open a dir for fsync; skip silently — multicc is unix-only
    // anyway (node-pty spawn-helper, tmux) so this is defensive rather than hot.
    if (e.code !== 'EISDIR' && e.code !== 'EBADF' && e.code !== 'EPERM') {
      throw e;
    }
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
}

// Rotate target → target.bak1 → target.bak2 → … .bakN. Missing rungs are fine;
// we shift only what exists. Called just before a rename, so at any moment the
// on-disk state is one of: (old target + rotated bakN), or (new target +
// rotated bakN) — never both empty.
function rotateBackups(target, keep) {
  for (let i = keep; i >= 1; i--) {
    const src = i === 1 ? target : `${target}.bak${i - 1}`;
    const dst = `${target}.bak${i}`;
    try {
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    } catch (e) {
      // Best-effort rotation. If a bak file can't be moved we still want the
      // primary write to proceed; the new bak1 will fill in on the next write.
      // eslint-disable-next-line no-console
      console.warn(`[multicc/state-store] backup rotate ${src} → ${dst} failed: ${e.message}`);
    }
  }
}

// Write payload durably: tmp file → fsync → rename → parent fsync.
// Throws on any hard failure; caller decides what to do (usually: propagate to
// the HTTP layer so the client doesn't get a false success).
function writeTextAtomic(target, text, { mode = 0o600, dirMode = 0o700, beforeRename } = {}) {
  const dir = path.dirname(target);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: dirMode });
    fs.chmodSync(dir, dirMode);
  }
  catch (e) {
    if (e.code !== 'EEXIST') {
      try { failureReporter(e, { operation: 'mkdir', target }); } catch (_) {}
      throw new Error(`[state-store] mkdir ${dir}: ${e.message}`);
    }
  }
  const tmp = `${target}.tmp.${process.pid}.${counter++}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeSync(fd, text);
    tryFsync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (typeof beforeRename === 'function') beforeRename();
    fs.renameSync(tmp, target);
    fs.chmodSync(target, mode);
    fsyncDir(dir);
  } catch (e) {
    try { failureReporter(e, { operation: 'atomic_write', target }); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function writeJsonAtomic(target, payload, { rotate = DEFAULT_ROTATE, kind = 'unknown', schemaVersion = 1 } = {}) {
  const env = envelope({ kind, schemaVersion, data: payload });
  env[SCHEMA_KEY].writtenAt = new Date().toISOString();
  const text = JSON.stringify(env, null, 2);

  writeTextAtomic(target, text, {
    mode: 0o600,
    dirMode: 0o700,
    beforeRename: () => rotateBackups(target, rotate),
  });
}
let counter = 0;

function setFailureReporter(reporter) {
  failureReporter = typeof reporter === 'function' ? reporter : () => {};
}

// Load a state file. Returns:
//   { present: false }                        → target doesn't exist at all
//   { present: true, data, envelope }         → clean read
// Throws CorruptedStateError on parse failure. The caller can catch it and
// attempt recovery via `recoverFromBackup()` — never fall through to "empty",
// which silently drops user data on the next save().
function readJson(target, { legacyIsArray = false } = {}) {
  if (!fs.existsSync(target)) return { present: false };
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); }
  catch (e) { throw new CorruptedStateError(`unreadable state file ${target}: ${e.message}`, { file: target }); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    throw new CorruptedStateError(`corrupt JSON in ${target}: ${e.message}`, { file: target, raw: raw.slice(0, 200) });
  }
  // Legacy bare-array file (pre-schema) — unwrap and mark as legacy.
  if (Array.isArray(parsed)) {
    if (!legacyIsArray) {
      // Explicitly not accepting bare arrays — surface as corruption so the
      // caller decides whether to migrate.
      throw new CorruptedStateError(`unexpected bare-array shape in ${target}`, { file: target });
    }
    return { present: true, data: parsed, envelope: { kind: 'legacy-array', version: 0 } };
  }
  if (parsed && typeof parsed === 'object' && parsed[SCHEMA_KEY] && 'data' in parsed) {
    return { present: true, data: parsed.data, envelope: parsed[SCHEMA_KEY] };
  }
  // Object but not our envelope — treat as corruption. This covers e.g. a
  // half-written file that JSON.parse happened to accept.
  throw new CorruptedStateError(`state envelope missing in ${target}`, { file: target });
}

// Walk .bak1..bakN looking for the most recent successful write. Returns the
// same shape as readJson() (present:false if nothing usable survives).
function recoverFromBackup(target, opts = {}, keep = DEFAULT_ROTATE) {
  for (let i = 1; i <= keep; i++) {
    const bak = `${target}.bak${i}`;
    if (!fs.existsSync(bak)) continue;
    try {
      const r = readJson(bak, opts);
      if (r.present) return { ...r, recoveredFrom: bak };
    } catch (_) { /* try next rung */ }
  }
  return { present: false };
}

// Convenience: one-call factory that binds a file to a kind and gives back a
// {load, save, saveMany} triple. Not required — server.js's persistence
// callsites can also call readJson/writeJsonAtomic directly — but useful for
// domain modules (directory repo, session repo) that want a small handle.
function createStore({ file, kind, schemaVersion = 1, legacyIsArray = true, rotate = DEFAULT_ROTATE } = {}) {
  if (!file) throw new TypeError('[state-store] createStore requires { file }');
  return {
    file,
    load: () => readJson(file, { legacyIsArray }),
    loadOrRecover: () => {
      try { return readJson(file, { legacyIsArray }); }
      catch (e) {
        if (!(e instanceof CorruptedStateError)) throw e;
        const rec = recoverFromBackup(file, { legacyIsArray }, rotate);
        if (rec.present) return { ...rec, recovered: true };
        throw e;   // fail-closed: no usable state on any rung
      }
    },
    save: (data) => writeJsonAtomic(file, data, { rotate, kind, schemaVersion }),
    _writeAtomic: (payload, opts) => writeJsonAtomic(file, payload, { rotate, kind, schemaVersion, ...opts }),
  };
}

module.exports = {
  CorruptedStateError,
  writeTextAtomic,
  writeJsonAtomic,
  readJson,
  recoverFromBackup,
  createStore,
  SCHEMA_KEY,
  setFailureReporter,
};
