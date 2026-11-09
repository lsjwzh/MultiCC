'use strict';

// The live directory registry — the single owner is native
// (native/addon/src/session_records.rs), colocated with the session-record
// table so a cascading delete is one native transaction. This is a Map-shaped
// facade, not a second table: membership, order and the directories.json writer
// all live in Rust. Directory records stay live JavaScript references (the
// owner holds opaque host references) so the existing field writers keep object
// identity and property order.
//
// `instanceof Map` still holds: several hosts accept either a Map or a plain
// object and check for one explicitly.

const { CorruptedStateError } = require('../state/store');

const owners = new WeakMap();

function sharedOf(map) {
  const slot = owners.get(map);
  if (!slot || !slot.native) throw new TypeError('directory table owner is required');
  return slot;
}

function nativeOf(map) {
  return sharedOf(map).native;
}

/// The native owner behind a facade, or null for any other value.
function directoryOwner(map) {
  const slot = owners.get(map);
  return (slot && slot.native) || null;
}

function entriesOf(map) {
  return nativeOf(map).directoryEntries();
}

class DirectoryMap extends Map {
  // eslint-disable-next-line no-useless-constructor
  constructor(shared) {
    super();
    owners.set(this, shared);
  }

  get size() { return nativeOf(this).directorySize(); }
  get(key) { return nativeOf(this).directoryGet(key); }
  set(key, value) {
    nativeOf(this).directorySet(key, value);
    return this;
  }

  has(key) { return nativeOf(this).directoryHas(key); }
  delete(key) { return nativeOf(this).directoryDelete(key); }
  clear() { nativeOf(this).directoryClear(); }
  keys() { return entriesOf(this).map(entry => entry[0])[Symbol.iterator](); }
  values() { return entriesOf(this).map(entry => entry[1])[Symbol.iterator](); }
  entries() { return entriesOf(this)[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback, thisArg) {
    for (const [key, value] of entriesOf(this)) callback.call(thisArg, value, key, this);
  }
}

function createDirectoryTable(shared) {
  if (!shared || !shared.native || typeof shared.native.directoryEntries !== 'function') {
    throw new TypeError('directory table requires the native state owner');
  }
  return new DirectoryMap(shared);
}

/// Rebuild the `CorruptedStateError` the StateStore threw. The native loader
/// reports which shape failed; the message text stays the same for callers that
/// log or match it.
function corruptedStateError(file, result) {
  if (result && result.errorKind === 'unreadable') {
    return new CorruptedStateError(`unreadable state file ${file}`, { file });
  }
  if (result && result.errorKind === 'envelope') {
    return new CorruptedStateError(`state envelope missing in ${file}`, { file });
  }
  return new CorruptedStateError(`corrupt JSON in ${file}`, {
    file,
    raw: (result && result.raw) || '',
  });
}

/// Boot load that installs the native table. Returns the recovery metadata the
/// bootstrap logs; throws `CorruptedStateError` exactly when the StateStore did.
function loadDirectories(shared, file) {
  if (!shared || !shared.native) throw new TypeError('state owner is required');
  const result = shared.native.loadDirectories();
  if (result.errorKind) throw corruptedStateError(file, result);
  return result;
}

module.exports = {
  DirectoryMap,
  createDirectoryTable,
  directoryOwner,
  corruptedStateError,
  loadDirectories,
};
