'use strict';

// The live chat-session table — the single owner is native/addon/src/session_records.rs
// (the same owner that holds the persisted session table). This is a Map-shaped
// facade, not a second table: every membership call forwards to Rust, which owns
// which ids exist and their order. The per-session `cs` objects stay live
// JavaScript references (the native owner holds opaque host references to them)
// so the streaming/CLI/timer owners keep object identity and property order.
//
// `instanceof Map` still holds: several hosts check for a Map explicitly.

const owners = new WeakMap();

function ownerOf(sessions) {
  const slot = owners.get(sessions);
  if (!slot || !slot.native) throw new TypeError('chat session owner is required');
  return slot.native;
}

/// The native owner behind a facade, or null for any other value.
function chatSessionsOwner(sessions) {
  const owner = owners.get(sessions);
  return owner ? owner.native : null;
}

function entriesOf(sessions) {
  return ownerOf(sessions).chatEntries();
}

class ChatSessionMap extends Map {
  // eslint-disable-next-line no-useless-constructor
  constructor(shared) {
    super();
    if (!shared || !shared.native) throw new TypeError('chat session owner is required');
    owners.set(this, { native: shared.native, forget: null });
  }

  get size() { return ownerOf(this).chatSize(); }
  get(key) { return ownerOf(this).chatGet(key); }
  set(key, value) {
    ownerOf(this).chatSet(key, value);
    return this;
  }

  has(key) { return ownerOf(this).chatHas(key); }
  // Turn-progress state (timeline, delivery probes) is keyed by session name
  // inside the Rust owner and has to leave with the session. See
  // `setForgetHook` and src/chat/turn-progress.js.
  delete(key) {
    const removed = ownerOf(this).chatDelete(key);
    if (removed) {
      const slot = owners.get(this);
      if (slot.forget) slot.forget(key);
    }
    return removed;
  }
  clear() {
    const keys = entriesOf(this).map(entry => entry[0]);
    ownerOf(this).chatClear();
    const slot = owners.get(this);
    if (slot.forget) for (const key of keys) slot.forget(key);
  }
  /// Hook invoked with the session name after it leaves the table (server wires
  /// it to the turn-progress owner). Without a hook, behaviour is unchanged.
  setForgetHook(fn) {
    owners.get(this).forget = typeof fn === 'function' ? fn : null;
    return this;
  }
  keys() { return entriesOf(this).map(entry => entry[0])[Symbol.iterator](); }
  values() { return entriesOf(this).map(entry => entry[1])[Symbol.iterator](); }
  entries() { return entriesOf(this)[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback, thisArg) {
    for (const [key, value] of entriesOf(this)) callback.call(thisArg, value, key, this);
  }
}

// `shared` is the process owner from `src/state/owner.js`. One owner per
// process: the live chat table has no Node-side storage of its own.
function createChatSessions(shared) {
  return new ChatSessionMap(shared);
}

module.exports = { ChatSessionMap, createChatSessions, chatSessionsOwner };
