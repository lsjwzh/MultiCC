'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Durable task-shell routing state. Chat history and the task board
// keep their existing ownership. Sync transactions cover decisions before any
// asynchronous workspace creation or delivery can yield.
function createTaskShellStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const Database = require('better-sqlite3');
  const db = new Database(file, { timeout: 5000 });
  try {
    const version = db.pragma('user_version', { simple: true });
    if (version > 1) throw new Error('unsupported task-shell schema');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec('CREATE TABLE IF NOT EXISTS shell_records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind, id)); PRAGMA user_version = 1;');
    if (file !== ':memory:') for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(file + suffix, 0o600); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  } catch (error) { db.close(); throw error; }
  const select = db.prepare('SELECT body FROM shell_records WHERE kind = ? AND id = ?');
  const all = db.prepare('SELECT body FROM shell_records WHERE kind = ? ORDER BY rowid');
  const put = db.prepare('INSERT INTO shell_records(kind, id, body) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body');
  const remove = db.prepare('DELETE FROM shell_records WHERE kind = ? AND id = ?');
  const get = (kind, id) => { const row = select.get(kind, id); return row ? JSON.parse(row.body) : null; };
  return {
    get,
    list: kind => all.all(kind).map(row => JSON.parse(row.body)),
    set(kind, id, value) {
      const body = JSON.stringify(value);
      if (kind === 'snapshot') {
        const previous = select.get(kind, id);
        if (previous && previous.body !== body) throw new Error('immutable snapshot conflict');
      }
      put.run(kind, id, body);
      return value;
    },
    remove: (kind, id) => remove.run(kind, id),
    transaction: callback => db.transaction(callback).immediate(),
    close: () => { if (db.open) db.close(); },
  };
}

module.exports = { createTaskShellStore };
