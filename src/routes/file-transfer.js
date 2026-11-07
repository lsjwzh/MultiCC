'use strict';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`file-transfer routes require ${name}`);
  return value;
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('file-transfer route dependencies are required');
  if (!deps.fs || !deps.path || !deps.os) throw new TypeError('file-transfer filesystem dependencies are required');
  if (!deps.upload || typeof deps.upload.chat !== 'function') {
    throw new TypeError('file-transfer routes require chat upload middleware');
  }
  requireFunction(deps.persistChatUpload, 'persistChatUpload');
  requireFunction(deps.sendUploadError, 'sendUploadError');
  requireFunction(deps.getActiveSession, 'getActiveSession');
  requireFunction(deps.getPersistedSession, 'getPersistedSession');
  return deps;
}

function resolveDirectory(rawPath, sessionId, deps) {
  let dirPath = (rawPath || '').trim();
  const id = (sessionId || '').trim();

  if (!dirPath && id) {
    const active = deps.getActiveSession(id);
    const persisted = deps.getPersistedSession(id);
    dirPath = (active && active.cwd) || (persisted && persisted.cwd) || deps.os.homedir();
  } else if (!dirPath) {
    dirPath = deps.os.homedir();
  }

  if (dirPath === '~') dirPath = deps.os.homedir();
  else if (dirPath.startsWith('~/') || dirPath.startsWith('~\\')) {
    dirPath = deps.path.join(deps.os.homedir(), dirPath.slice(2));
  }
  return deps.path.resolve(dirPath);
}

function createFilesHandler(deps) {
  return function filesHandler(req, res) {
    const dirPath = resolveDirectory(req.query && req.query.path, req.query && req.query.session, deps);
    try {
      const entries = deps.fs.readdirSync(dirPath, { withFileTypes: true });
      const files = entries
        .map((entry) => {
          const fullPath = deps.path.join(dirPath, entry.name);
          const isDir = entry.isDirectory();
          let size = null;
          if (!isDir) {
            try { size = deps.fs.statSync(fullPath).size; } catch (_) { /* preserve unreadable entry */ }
          }
          return { name: entry.name, isDir, path: fullPath, size };
        })
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const parent = dirPath !== deps.path.parse(dirPath).root ? deps.path.dirname(dirPath) : null;
      return res.json({ path: dirPath, parent, files });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  };
}

function createUploadHandler(deps) {
  return function uploadHandler(req, res) {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    try {
      const saved = deps.persistChatUpload(req.file);
      req.file.buffer = null;
      deps.log(`[multicc] Uploaded: ${saved.path} (${saved.name})`);
      return res.json({ path: saved.path, name: saved.name });
    } catch (error) {
      return deps.sendUploadError(res, error);
    }
  };
}

function mountFileTransferRoutes(app, rawDeps) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('file-transfer routes require an Express-compatible app');
  }
  const deps = assertDependencies({ log: console.log, ...rawDeps });
  requireFunction(deps.log, 'log');
  app.get('/api/files', createFilesHandler(deps));
  // GET /api/download and the upload temp-file stats/cleanup are answered by
  // the Rust front door (docs/gateway.md §9).
  app.post('/api/upload', deps.upload.chat, createUploadHandler(deps));
}

module.exports = {
  resolveDirectory,
  createFilesHandler,
  createUploadHandler,
  mountFileTransferRoutes,
};
