'use strict';

// Resolve a codex session's rollout *.jsonl — the file whose mtime feeds the
// process probe's "still appending events" signal.
//
// Finding it means walking a sessions tree that only ever grows, and the probe
// asks for it on every liveness poll for every codex session. Doing that walk
// each time was synchronous FS work on the event loop, repeated to rediscover a
// path that never moves once the file exists. The answer is a pure function of
// (sessions dir, cliSessionId), so it is memoized: a resolved path costs one
// existsSync to revalidate, and a miss is re-walked only after a short pause so
// a session whose rollout has not been created yet still picks it up shortly,
// without turning every poll into a full scan.

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

  // `${sessionsDir}::${cliSessionId}` -> { path: string|null, at: number }
  const cache = new Map();

  function scan(dir, cliSessionId) {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && e.name.includes(cliSessionId) && e.name.endsWith('.jsonl')) return p;
      }
    }
    return null;
  }

  // Best-effort: any failure resolves to null, so a broken lookup can only cost
  // the probe one signal, never throw into the liveness endpoint.
  function resolve(record) {
    try {
      if (!record || record.cli !== 'codex' || !record.cliSessionId) return null;
      const dir = sessionsDirFor(record);
      if (!dir) return null;
      const key = `${dir}::${record.cliSessionId}`;
      const cached = cache.get(key);
      if (cached) {
        if (cached.path) {
          if (fs.existsSync(cached.path)) return cached.path;
        } else if ((now() - cached.at) <= missTtlMs) {
          return null;
        }
        cache.delete(key);
      }
      const found = fs.existsSync(dir) ? scan(dir, record.cliSessionId) : null;
      cache.set(key, { path: found, at: now() });
      return found;
    } catch (_) {
      return null;
    }
  }

  function forget(record) {
    if (!record || !record.cliSessionId) return;
    let dir = null;
    try { dir = sessionsDirFor(record); } catch (_) { dir = null; }
    if (dir) cache.delete(`${dir}::${record.cliSessionId}`);
  }

  return { resolve, forget };
}

module.exports = { createRolloutPathResolver, DEFAULT_MISS_TTL_MS };
