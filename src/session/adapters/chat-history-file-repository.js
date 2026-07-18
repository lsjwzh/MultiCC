'use strict';

const fs = require('fs');
const path = require('path');
const { createPaths } = require('../../paths');
const { atomicWriteJson, ensurePrivateDir } = require('../../runtime-security');

function safeSessionName(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_') || '_default';
}

function createChatHistoryFileRepository({ dataDir, fsImpl = fs, writeJson = atomicWriteJson } = {}) {
  const root = createPaths({ dataDir }).chatHistoryDir;

  function fileFor(sessionId) {
    return path.join(root, `${safeSessionName(sessionId)}.json`);
  }

  function readStrict(sessionId) {
    const value = JSON.parse(fsImpl.readFileSync(fileFor(sessionId), 'utf8'));
    if (!Array.isArray(value)) {
      const error = new TypeError('[session] chat history file must contain an array');
      error.code = 'CHAT_HISTORY_CORRUPT';
      throw error;
    }
    return value;
  }

  function read(sessionId) {
    try {
      return readStrict(sessionId);
    } catch (_) {
      return [];
    }
  }

  function write(sessionId, messages) {
    if (!Array.isArray(messages)) throw new TypeError('[session] chat history write requires an array');
    if (fsImpl === fs && writeJson === atomicWriteJson) {
      ensurePrivateDir(root);
      writeJson(fileFor(sessionId), messages);
      return;
    }
    fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
    writeJson(fileFor(sessionId), messages);
  }

  function deleteSession(sessionId) {
    try {
      fsImpl.unlinkSync(fileFor(sessionId));
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
    if (fsImpl === fs) ensurePrivateDir(root);
    else fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
    fsImpl.renameSync(source, target);
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
    renameSession,
    root,
    write,
  });
}

module.exports = { createChatHistoryFileRepository, safeSessionName };
