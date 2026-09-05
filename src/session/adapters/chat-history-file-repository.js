'use strict';

const fs = require('fs');
const path = require('path');
const { createPaths } = require('../../paths');
const { atomicWriteText, ensurePrivateDir } = require('../../runtime-security');

// Transcripts are stored as JSONL — one message per line — so that the common
// mutation can be an append instead of a rewrite.
//
// The port hands this adapter the whole message array on every persist, and
// serializing all of it was the single most expensive thing the server did: a
// multi-MB stringify plus a multi-MB atomic write for each appended message, and
// the streaming interim save repeats that for every session for the length of
// every turn. Nothing about the port has to change to fix it — the adapter can
// see for itself that a write only extends or replaces the tail of what it last
// wrote, because chat-history-service now shares message objects between
// successive writes instead of deep-cloning them. A reference-identity scan of
// the two arrays is a few microseconds and proves exactly which prefix is
// already on disk; the rest is appended, and any doubt falls back to the full
// atomic rewrite this file has always done.
//
// Legacy `[...]` array files are still read (they predate JSONL), and the first
// full rewrite of a session converts it — there is no migration step.

function safeSessionName(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_') || '_default';
}

function corrupt(message) {
  const error = new TypeError(`[session] ${message}`);
  error.code = 'CHAT_HISTORY_CORRUPT';
  return error;
}

function serializeLine(message) {
  return `${JSON.stringify(message)}\n`;
}

// Parse either format. Returns null for `appendable` when the on-disk shape is
// not one this adapter may extend in place.
function parseTranscript(text) {
  const body = text.replace(/^﻿/, '');
  const start = body.search(/\S/);
  // An empty or whitespace-only file is not a valid transcript; the previous
  // implementation surfaced that as a JSON.parse failure and callers rely on it.
  if (start < 0) throw corrupt('chat history file is empty');

  if (body[start] === '[') {
    const value = JSON.parse(body);
    if (!Array.isArray(value)) throw corrupt('chat history file must contain an array');
    return { messages: value, legacy: true };
  }

  const complete = body.endsWith('\n');
  const lines = body.split('\n');
  if (complete) lines.pop();

  const messages = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    // Appends are not atomic, so a crash can leave a partial final line. That is
    // the only damage an interrupted append can do, and it costs the same
    // message the previous rename-based write would have lost. Any other parse
    // failure — or a file that yields nothing at all — is real corruption and
    // must surface, because hasPersistedDelivery() is the outbox's proof that a
    // delivery reached disk.
    const torn = !complete && index === lines.length - 1 && messages.length > 0;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch (error) {
      if (torn) break;
      throw corrupt(`chat history line ${index + 1} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (torn) break;
      throw corrupt(`chat history line ${index + 1} is not a message object`);
    }
    messages.push(parsed);
  }
  return { messages, legacy: false };
}

function createChatHistoryFileRepository({
  dataDir,
  fsImpl = fs,
  writeText = atomicWriteText,
  // Kill switch: setting MULTICC_HISTORY_APPEND=0 restores full-rewrite-only
  // behaviour. Both modes read and write the same JSONL files, so it can be
  // flipped either way without touching stored data.
  appendEnabled = process.env.MULTICC_HISTORY_APPEND !== '0',
} = {}) {
  const root = createPaths({ dataDir }).chatHistoryDir;

  // Only what this adapter itself last wrote, per file: the array (for the
  // reference scan), each line's end offset (to truncate at a line boundary),
  // and the byte size it produced (to detect any writer but us).
  const written = new Map();

  const canAppend = appendEnabled
    && typeof fsImpl.openSync === 'function'
    && typeof fsImpl.writeSync === 'function'
    && typeof fsImpl.closeSync === 'function'
    && typeof fsImpl.statSync === 'function'
    && typeof fsImpl.truncateSync === 'function';

  function fileFor(sessionId) {
    return path.join(root, `${safeSessionName(sessionId)}.json`);
  }

  function visibilityFileFor(sessionId) {
    return path.join(root, '.views', `${safeSessionName(sessionId)}.json`);
  }

  function readVisibility(sessionId) {
    let state;
    try { state = JSON.parse(fsImpl.readFileSync(visibilityFileFor(sessionId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (state?.version !== 1 || !Array.isArray(state.hiddenIds)
        || state.hiddenIds.some(id => typeof id !== 'string')) {
      throw corrupt('invalid chat visibility state');
    }
    return state;
  }

  function writeVisibility(sessionId, state) {
    const dir = path.dirname(visibilityFileFor(sessionId));
    if (fsImpl === fs) ensurePrivateDir(dir);
    else fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeText(visibilityFileFor(sessionId), JSON.stringify(state));
  }

  function readStrict(sessionId) {
    return parseTranscript(fsImpl.readFileSync(fileFor(sessionId), 'utf8')).messages;
  }

  function read(sessionId) {
    try {
      return readStrict(sessionId);
    } catch (_) {
      return [];
    }
  }

  function ensureRoot() {
    if (fsImpl === fs) ensurePrivateDir(root);
    else fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  // How many leading messages are already on disk, proven by identity rather
  // than by comparing contents: the service never mutates a message once it is
  // in the transcript, so a shared reference means identical stored bytes.
  function sharedPrefix(previous, next) {
    const limit = Math.min(previous.length, next.length);
    let index = 0;
    while (index < limit && previous[index] === next[index]) index += 1;
    return index;
  }

  function appendAt(file, offset, text) {
    // Truncating to a recorded line boundary is what lets an interim save
    // replace the trailing message instead of rewriting the transcript.
    if (offset != null) fsImpl.truncateSync(file, offset);
    const fd = fsImpl.openSync(file, 'a', 0o600);
    try {
      fsImpl.writeSync(fd, text);
      // Match the durability of the atomic rewrite this replaces. Some
      // filesystems reject fsync; a failure there must not fail the write.
      if (typeof fsImpl.fsyncSync === 'function') {
        try { fsImpl.fsyncSync(fd); } catch (_) {}
      }
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  function recordWritten(file, messages, lineEnds) {
    written.set(file, {
      messages: messages.slice(),
      lineEnds,
      size: lineEnds.length ? lineEnds[lineEnds.length - 1] : 0,
    });
  }

  function fullRewrite(file, messages) {
    const lineEnds = [];
    let text = '';
    let offset = 0;
    for (const message of messages) {
      const line = serializeLine(message);
      text += line;
      offset += Buffer.byteLength(line, 'utf8');
      lineEnds.push(offset);
    }
    ensureRoot();
    writeText(file, text);
    recordWritten(file, messages, lineEnds);
  }

  // Extend the tracked state in place, but only when the file on disk is still
  // byte-for-byte the one we recorded. A size mismatch means something else
  // wrote it (another process, a manual edit, a restore) and our offsets are
  // meaningless, so the full rewrite takes over.
  function incrementalWrite(file, messages) {
    const state = written.get(file);
    if (!state) return false;
    let actualSize;
    try { actualSize = fsImpl.statSync(file).size; } catch (_) { return false; }
    if (actualSize !== state.size) return false;

    const keep = sharedPrefix(state.messages, messages);
    // Nothing shared means this is a wholesale replacement (a cleared history, a
    // front trim past every retained message); rewriting is both simpler and no
    // more expensive than the append would be.
    if (keep === 0 && messages.length) return false;
    // A shrink with no new tail is a removal, not an append.
    if (keep === messages.length && keep < state.messages.length) return false;

    const truncateTo = keep === state.messages.length ? null : (keep ? state.lineEnds[keep - 1] : 0);
    const lineEnds = state.lineEnds.slice(0, keep);
    let offset = keep ? state.lineEnds[keep - 1] : 0;
    let text = '';
    for (let index = keep; index < messages.length; index += 1) {
      const line = serializeLine(messages[index]);
      text += line;
      offset += Buffer.byteLength(line, 'utf8');
      lineEnds.push(offset);
    }
    if (!text && truncateTo == null) {
      // Already exactly on disk.
      recordWritten(file, messages, lineEnds);
      return true;
    }
    appendAt(file, truncateTo, text);
    recordWritten(file, messages, lineEnds);
    return true;
  }

  function write(sessionId, messages) {
    if (!Array.isArray(messages)) throw new TypeError('[session] chat history write requires an array');
    const file = fileFor(sessionId);
    try {
      if (canAppend && incrementalWrite(file, messages)) return;
      fullRewrite(file, messages);
    } catch (error) {
      // Never let a failed write leave offsets that a later append would trust.
      written.delete(file);
      throw error;
    }
  }

  function deleteSession(sessionId) {
    const file = fileFor(sessionId);
    written.delete(file);
    try {
      fsImpl.unlinkSync(file);
      try { fsImpl.unlinkSync(visibilityFileFor(sessionId)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  function renameSession(fromSessionId, toSessionId) {
    const source = fileFor(fromSessionId);
    const target = fileFor(toSessionId);
    if (!fsImpl.existsSync(source) || fsImpl.existsSync(target)) return false;
    ensureRoot();
    written.delete(source);
    written.delete(target);
    const visibility = readVisibility(fromSessionId);
    if (visibility) writeVisibility(toSessionId, visibility);
    fsImpl.renameSync(source, target);
    if (visibility) fsImpl.unlinkSync(visibilityFileFor(fromSessionId));
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(target, 0o600);
    return true;
  }

  function hasPersistedDelivery(sessionId, deliveryId) {
    if (!deliveryId) return false;
    let messages;
    try {
      messages = readStrict(sessionId);
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
    return messages.some(message => message && (
      message.deliveryId === deliveryId || message.clientMsgId === deliveryId
    ));
  }

  function listSessionIds() {
    let names;
    try { names = fsImpl.readdirSync(root); }
    catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter(name => typeof name === 'string' && name.endsWith('.json'))
      .map(name => name.slice(0, -5))
      .sort();
  }

  return Object.freeze({
    deleteSession,
    fileFor,
    hasPersistedDelivery,
    listSessionIds,
    read,
    readStrict,
    readVisibility,
    renameSession,
    root,
    write,
    writeVisibility,
    visibilityFileFor,
  });
}

module.exports = { createChatHistoryFileRepository, safeSessionName };
