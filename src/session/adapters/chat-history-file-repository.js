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

  function read(sessionId) {
    try {
      const value = JSON.parse(fsImpl.readFileSync(fileFor(sessionId), 'utf8'));
      return Array.isArray(value) ? value : [];
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

  return Object.freeze({ fileFor, read, root, write });
}

module.exports = { createChatHistoryFileRepository, safeSessionName };
