'use strict';

const { getNative } = require('../native/binding');
const DEFAULT_MISS_TTL_MS = 30_000;

function createRolloutPathResolver(deps = {}) {
  const {
    fs,                 // node:fs (existsSync + readdirSync)
    path,               // node:path
    sessionsDirFor,     // (record) => string|null — where that session's rollouts live
    now = Date.now,
    missTtlMs = DEFAULT_MISS_TTL_MS,
  } = deps;

  if (!fs || typeof fs.existsSync !== 'function' || typeof fs.readdirSync !== 'function') {
    throw new TypeError('[rollout-path] fs with existsSync/readdirSync is required');
  }
  if (!path || typeof path.join !== 'function') {
    throw new TypeError('[rollout-path] path is required');
  }
  if (typeof sessionsDirFor !== 'function') {
    throw new TypeError('[rollout-path] sessionsDirFor is required');
  }

  return getNative().rolloutResolver({
    now, sessionsDirFor, cache: new Map(),
    entries: dir => fs.readdirSync(dir, { withFileTypes: true }),
    exists: name => fs.existsSync(name), join: (dir, entry) => path.join(dir, entry.name),
    key: (dir, record) => `${dir}::${record.cliSessionId}`, fresh: at => now() - at <= missTtlMs,
  });
}
module.exports = { createRolloutPathResolver, DEFAULT_MISS_TTL_MS };
