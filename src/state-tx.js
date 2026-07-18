'use strict';
// state-tx — small journal + apply helpers for state mutations that must land
// atomically across MORE THAN ONE state file (right now that's just directory
// deletion, which changes both directories.json and sessions.json).
//
// Design summary
// --------------
// The workflow the caller drives is:
//
//   1. mutate the in-memory Maps (delete dir + owned sessions),
//   2. call `commitCrossFileWrite(tx)` with both file paths + payloads,
//   3. that call writes a small journal entry, then writes each file
//      atomically (state-store.writeJsonAtomic), then deletes the journal.
//   4. On boot, `replayJournals()` looks for leftover entries. If found, they
//      contain the intended snapshots of both files — we finish the writes and
//      only then delete the journal. That way a crash between step 3.1 and 3.2
//      doesn't leave the user with a stale sessions.json still pointing at a
//      directory that already left directories.json (or vice versa).
//
// The journal file itself is written atomically via state-store, so an aborted
// journal write is safe — we simply won't replay a partial one.
//
// Why not a full-blown WAL? multicc's on-disk state is small (dozens of KB) and
// we only need durability across two files at a time. A dedicated transaction
// per delete keeps the code narrow. If the state file grows or more cross-file
// invariants appear, this becomes the pinch point for extension.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic, readJson } = require('./state-store');

// Payload shape stored in the journal. The `files` array captures the FINAL
// state we intend both files to reach; on replay we blindly write them, because
// the in-memory mutation that produced them is by definition consistent (we
// snapshotted after all the deletes ran).
//
//   { id, kind: 'delete-directory', ts, files: [{ path, payload, kind, schemaVersion }] }

function newTxId() { return crypto.randomBytes(8).toString('hex'); }

// Write a journal entry describing the intended state of every file involved.
// Returns the absolute path of the journal file (so the caller can pass it to
// clearJournal() after the writes succeed).
function writeJournal(journalDir, entry) {
  fs.mkdirSync(journalDir, { recursive: true });
  const file = path.join(journalDir, `tx-${entry.id}.json`);
  // Rotation on a per-tx journal is meaningless (each file is single-use); pass
  // rotate:0 so we don't leave behind .bak files that would be replayed twice.
  writeJsonAtomic(file, entry, { rotate: 0, kind: 'state-tx-journal', schemaVersion: 1 });
  return file;
}

function clearJournal(file) {
  try { fs.unlinkSync(file); } catch (_) { /* already gone → also fine */ }
}

// Apply one journal entry: write each file to its intended payload atomically.
// Only-once semantics: as long as each individual writeJsonAtomic is atomic,
// re-running this for the same journal produces the same result — safe to
// retry on the next boot if this call itself dies partway.
function applyJournalEntry(entry) {
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`[state-tx] malformed journal entry: ${JSON.stringify(entry).slice(0, 200)}`);
  }
  for (const f of entry.files) {
    if (!f.path) throw new Error('[state-tx] journal file entry missing path');
    writeJsonAtomic(f.path, f.payload, {
      rotate: f.rotate ?? 3,
      kind: f.kind || 'unknown',
      schemaVersion: f.schemaVersion ?? 1,
    });
  }
}

// The main entry point callers use. Writes journal → writes each file → clears
// journal. Throws if ANY write fails, so the HTTP layer can 500 rather than
// return success with a torn state on disk.
function commitCrossFileWrite({ journalDir, kind, files }) {
  if (!journalDir) throw new TypeError('[state-tx] journalDir required');
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError('[state-tx] at least one file required');
  }
  const entry = { id: newTxId(), kind, ts: Date.now(), files };
  const jf = writeJournal(journalDir, entry);
  try {
    applyJournalEntry(entry);
  } catch (e) {
    // Leave the journal on disk — the next boot will retry and finish the
    // writes. Rethrow so the caller (and its HTTP client) sees the failure.
    throw new Error(`[state-tx] apply failed for tx ${entry.id}: ${e.message}`);
  }
  clearJournal(jf);
  return { txId: entry.id };
}

// Boot-time replay. Scans the journal dir for tx-*.json entries; for each one
// that parses cleanly, apply it and then delete the journal file. Malformed
// journals are moved aside to `<dir>/broken/` so a human can look at them
// rather than having them silently disappear.
function replayJournals(journalDir, { log = () => {} } = {}) {
  let entries;
  try { entries = fs.readdirSync(journalDir); } catch (_) { return { replayed: 0, skipped: 0 }; }
  let replayed = 0, skipped = 0;
  for (const name of entries) {
    if (!/^tx-.+\.json$/.test(name)) continue;
    const full = path.join(journalDir, name);
    let r;
    try { r = readJson(full); } catch (e) {
      skipped++;
      log(`[state-tx] skipping unreadable journal ${name}: ${e.message}`);
      moveAside(full);
      continue;
    }
    if (!r.present) continue;
    try {
      applyJournalEntry(r.data);
      clearJournal(full);
      replayed++;
      log(`[state-tx] replayed journal ${name}`);
    } catch (e) {
      skipped++;
      log(`[state-tx] apply failed for ${name}: ${e.message}`);
      moveAside(full);
    }
  }
  return { replayed, skipped };
}

function moveAside(file) {
  try {
    const broken = path.join(path.dirname(file), 'broken');
    fs.mkdirSync(broken, { recursive: true });
    const dst = path.join(broken, path.basename(file) + '.' + Date.now());
    fs.renameSync(file, dst);
  } catch (_) { /* best-effort */ }
}

module.exports = {
  commitCrossFileWrite,
  replayJournals,
  // Exported for tests only:
  _writeJournal: writeJournal,
  _applyJournalEntry: applyJournalEntry,
};
