'use strict';

// Locate the Codex CLI session id for a freshly-launched process by scanning
// its rollout `*.jsonl` files. Codex writes a `session_meta` record as the first
// line of each session file; we pick the most-recently-modified file whose
// recorded cwd matches the launch cwd (resolving symlinks so macOS's /private
// prefix doesn't cause a false miss).
//
// Extracted verbatim from server.js. Pure filesystem read — no host state — so
// the finder takes its fs/path and default sessions dir as injected deps and is
// exercised directly against a temp directory in tests.

function createCodexSessionFinder({ fs, path, defaultSessionsDir } = {}) {
  if (!fs || typeof fs.existsSync !== 'function') {
    throw new TypeError('[codex-session-file] fs is required');
  }
  if (!path || typeof path.join !== 'function') {
    throw new TypeError('[codex-session-file] path is required');
  }

  function findCodexSessionId(cwd, sinceMs, sessionsDir) {
    try {
      const rootDir = sessionsDir || defaultSessionsDir;
      if (!rootDir || !fs.existsSync(rootDir)) return null;
      const candidates = [];
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile() && e.name.endsWith('.jsonl')) {
            try {
              const stat = fs.statSync(p);
              if (stat.mtimeMs >= sinceMs) candidates.push({ path: p, mtimeMs: stat.mtimeMs });
            } catch (_) {}
          }
        }
      };
      walk(rootDir);
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const c of candidates) {
        try {
          // Read first line only (session_meta is the first record)
          const fd = fs.openSync(c.path, 'r');
          const buf = Buffer.alloc(8192);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          const firstLine = buf.slice(0, n).toString().split('\n')[0];
          if (!firstLine) continue;
          const meta = JSON.parse(firstLine);
          if (meta.type !== 'session_meta') continue;
          const metaCwd = meta.payload?.cwd;
          const metaId = meta.payload?.id;
          // cwd may differ on macOS due to /private prefix; compare resolved real paths
          if (!metaId) continue;
          const norm = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
          if (norm(metaCwd) === norm(cwd)) return metaId;
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  return { findCodexSessionId };
}

module.exports = { createCodexSessionFinder };
