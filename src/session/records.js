'use strict';

// The live session-record table — the single owner is
// native/addon/src/session_records.rs. This is a Map-shaped facade, not a
// second table: every membership call forwards to Rust, which owns ids, their
// order and the durable writer. Record objects stay live JavaScript references
// (the native owner holds opaque host references to them) so the existing field
// writers keep object identity and property order.
//
// `instanceof Map` still holds: several hosts accept either a Map or a plain
// object and check for one explicitly.

const { getNative } = require('../native/runtime');

const owners = new WeakMap();

function ownerOf(records) {
  const slot = owners.get(records);
  return slot && slot.native;
}

/// The native owner behind a facade, or null for any other value.
function sessionRecordsOwner(records) {
  return ownerOf(records) || null;
}

function entriesOf(records) {
  return ownerOf(records).entriesSnapshot();
}

class SessionRecordMap extends Map {
  // eslint-disable-next-line no-useless-constructor
  constructor(owner) {
    super();
    owners.set(this, { native: owner, anchor: null });
  }

  get size() { return ownerOf(this).size(); }
  get(key) { return ownerOf(this).get(key); }
  // `[...records.values()].filter(r => r.dirId === dirId)` without materializing
  // the whole table: the owner filters ordered live records natively.
  listByDir(dirId) { return ownerOf(this).listByDir(dirId); }
  set(key, value) {
    ownerOf(this).set(key, value);
    return this;
  }

  has(key) { return ownerOf(this).has(key); }
  delete(key) { return ownerOf(this).delete(key); }
  clear() { ownerOf(this).clear(); }
  keys() { return entriesOf(this).map(entry => entry[0])[Symbol.iterator](); }
  values() { return entriesOf(this).map(entry => entry[1])[Symbol.iterator](); }
  entries() { return entriesOf(this)[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback, thisArg) {
    for (const [key, value] of entriesOf(this)) callback.call(thisArg, value, key, this);
  }
}

// One native owner per table. `source` is the boot Map the Node loader already
// parsed/migrated (or an array of [id, record] pairs); it is read once and not
// retained.
function createSessionRecords(source) {
  const native = getNative();
  if (typeof native.RustSessionRecords !== 'function') {
    throw new Error('rust_session_records_unavailable');
  }
  const anchor = Object.create(null);
  const owner = new native.RustSessionRecords(anchor);
  const records = new SessionRecordMap(owner);
  owners.set(records, { native: owner, anchor });
  if (source) owner.init(source instanceof Map ? source.entries() : source);
  return records;
}

// `TASK_STATE_DEFAULTS` comes from the same core rule the owner merges with, so
// the exported constant and the live merge cannot drift.
function sessionRecordDefaults() {
  const native = getNative();
  if (typeof native.sessionRecordsTaskStateDefaults !== 'function') {
    throw new Error('rust_session_records_unavailable');
  }
  return native.sessionRecordsTaskStateDefaults();
}

// Record-write helpers for hosts that receive the table but not the task-state
// store. Both require the native owner: there is no direct-write path.
function appendClassifyHistory(records, id, entry, cutoff) {
  const owner = ownerOf(records);
  if (!owner) throw new TypeError('session record owner is required');
  return owner.appendClassifyHistory(id, entry, cutoff);
}
function resetTaskState(records, id) {
  const owner = ownerOf(records);
  if (!owner) throw new TypeError('session record owner is required');
  return owner.resetTaskState(id);
}

module.exports = {
  SessionRecordMap,
  createSessionRecords,
  sessionRecordsOwner,
  sessionRecordDefaults,
  appendClassifyHistory,
  resetTaskState,
};
