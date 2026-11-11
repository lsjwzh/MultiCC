'use strict';
// FROZEN COPY, DIFFERENTIAL ONLY — do not import from product code.
//
// Both files below were retired when /api/files and /api/upload moved to
// native/gateway/src/app/file_transfer.rs (docs/gateway.md §37):
//
//   * src/routes/file-transfer.js        (HEAD copy, verbatim)
//   * src/upload-middleware.js chat half (HEAD copy, verbatim; the voice
//     half still lives in product code and is not frozen here)
//
// This module exists only as the Node oracle of
// docs/rust-migration/differential/file-transfer.js and must never be
// required by a production path. The differential injects every dependency
// that touches process state: the filesystem deps for /api/files and an
// isolated tmpdir for persistChatUpload, so no real upload directory or
// service is touched.

// ── frozen copy of src/routes/file-transfer.js @ HEAD ──────────────────────

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

// ── frozen copy of src/upload-middleware.js @ HEAD ─────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

const MIB = 1024 * 1024;
const UPLOAD_LIMITS = Object.freeze({
  fileSize: 25 * MIB,
  files: 1,
  fields: 0,
  // Busboy emits partsLimit when the counter reaches the configured value;
  // use 2 so exactly one multipart part succeeds and a second is rejected.
  parts: 2,
  fieldNameSize: 64,
  headerPairs: 100,
  maxActive: 4,
  tempFiles: 200,
  tempBytes: 512 * MIB,
});

const CHAT_APPLICATION_TYPES = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

class UploadPolicyError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'UploadPolicyError';
    this.code = code;
    this.status = status;
  }
}

function normalizedMime(value) {
  return String(value || 'application/octet-stream').split(';')[0].trim().toLowerCase();
}

function chatMimeAllowed(value) {
  const mime = normalizedMime(value);
  return /^(?:image|text|audio|video)\//.test(mime) || CHAT_APPLICATION_TYPES.has(mime);
}

function voiceMimeAllowed(value) {
  const mime = normalizedMime(value);
  return mime.startsWith('audio/') || mime === 'video/webm' || mime === 'application/ogg';
}

function safeOriginalName(value) {
  const portable = String(value || 'upload.bin').replace(/\\/g, '/');
  const name = path.posix.basename(portable).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
  return name || 'upload.bin';
}

function createFileFilter(allowed) {
  return (req, file, callback) => {
    if (file.fieldname !== 'file') {
      return callback(new UploadPolicyError('unexpected upload field', 'UPLOAD_UNEXPECTED_FIELD', 400));
    }
    file.originalname = safeOriginalName(file.originalname);
    if (!allowed(file.mimetype)) {
      return callback(new UploadPolicyError('unsupported upload media type', 'UPLOAD_UNSUPPORTED_MEDIA_TYPE', 415));
    }
    callback(null, true);
  };
}

function mapUploadError(error) {
  if (error instanceof UploadPolicyError) {
    return { status: error.status, code: error.code, error: error.message };
  }
  const code = error && error.code;
  if (code === 'LIMIT_FILE_SIZE') {
    return { status: 413, code: 'UPLOAD_FILE_TOO_LARGE', error: 'upload exceeds 25 MiB limit' };
  }
  if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_PART_COUNT' || code === 'LIMIT_FIELD_COUNT') {
    return { status: 400, code: 'UPLOAD_TOO_MANY_PARTS', error: 'exactly one file and no fields are allowed' };
  }
  if (code === 'LIMIT_UNEXPECTED_FILE') {
    return { status: 400, code: 'UPLOAD_UNEXPECTED_FIELD', error: 'expected one file field named file' };
  }
  if (code === 'LIMIT_FIELD_KEY' || code === 'LIMIT_FIELD_VALUE') {
    return { status: 400, code: 'UPLOAD_FIELD_INVALID', error: 'multipart field exceeds limits' };
  }
  return { status: 500, code: 'UPLOAD_FAILED', error: 'upload failed' };
}

function sendUploadError(res, error) {
  const mapped = mapUploadError(error);
  res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
}

function createAdmissionGate(maxActive) {
  let active = 0;
  return function wrap(parser) {
    return (req, res, next) => {
      if (active >= maxActive) {
        res.setHeader('Connection', 'close');
        return sendUploadError(res, new UploadPolicyError('too many concurrent uploads', 'UPLOAD_BUSY', 429));
      }
      active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active -= 1;
      };
      res.once('finish', release);
      res.once('close', release);
      parser(req, res, error => {
        if (error) {
          release();
          return sendUploadError(res, error);
        }
        next();
      });
    };
  };
}

function createParser(multerImpl, { fileSize, allowed }) {
  return multerImpl({
    storage: multerImpl.memoryStorage(),
    limits: {
      fileSize,
      files: UPLOAD_LIMITS.files,
      fields: UPLOAD_LIMITS.fields,
      parts: UPLOAD_LIMITS.parts,
      fieldNameSize: UPLOAD_LIMITS.fieldNameSize,
      headerPairs: UPLOAD_LIMITS.headerPairs,
    },
    fileFilter: createFileFilter(allowed),
  }).single('file');
}

function createUploadSuite({
  multerImpl = multer,
  fileSize = UPLOAD_LIMITS.fileSize,
  maxActive = UPLOAD_LIMITS.maxActive,
} = {}) {
  const gate = createAdmissionGate(maxActive);
  return Object.freeze({
    chat: gate(createParser(multerImpl, { fileSize, allowed: chatMimeAllowed })),
    voice: gate(createParser(multerImpl, { fileSize, allowed: voiceMimeAllowed })),
  });
}

function tempUploadStats({ tmpDir = os.tmpdir(), fsImpl = fs } = {}) {
  let count = 0;
  let bytes = 0;
  for (const name of fsImpl.readdirSync(tmpDir)) {
    if (!name.startsWith('multicc_')) continue;
    try {
      const stat = fsImpl.statSync(path.join(tmpDir, name));
      if (!stat.isFile()) continue;
      count += 1;
      bytes += stat.size;
    } catch (_) {}
  }
  return { count, bytes };
}

function persistChatUpload(file, {
  tmpDir = os.tmpdir(),
  fsImpl = fs,
  maxFiles = UPLOAD_LIMITS.tempFiles,
  maxBytes = UPLOAD_LIMITS.tempBytes,
} = {}) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new UploadPolicyError('No file', 'UPLOAD_FILE_REQUIRED', 400);
  }
  const stats = tempUploadStats({ tmpDir, fsImpl });
  if (stats.count >= maxFiles || stats.bytes + file.buffer.length > maxBytes) {
    throw new UploadPolicyError('temporary upload quota exceeded', 'UPLOAD_STORAGE_QUOTA_EXCEEDED', 507);
  }
  const originalName = safeOriginalName(file.originalname);
  const ext = path.extname(originalName).replace(/[^a-z0-9.]/gi, '').slice(0, 12) || '.bin';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const name = `multicc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext.startsWith('.') ? ext : `.${ext}`}`;
    const target = path.join(tmpDir, name);
    try {
      fsImpl.writeFileSync(target, file.buffer, { mode: 0o600, flag: 'wx' });
      return Object.freeze({ path: target, name: originalName, size: file.buffer.length });
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt === 2) throw error;
    }
  }
  throw new UploadPolicyError('could not allocate upload path', 'UPLOAD_STORAGE_FAILED', 500);
}

module.exports = {
  // /api/files
  resolveDirectory,
  createFilesHandler,
  mountFileTransferRoutes,
  mount: mountFileTransferRoutes,
  // /api/upload
  createUploadHandler,
  createUploadSuite,
  persistChatUpload,
  sendUploadError,
  mapUploadError,
  tempUploadStats,
  UPLOAD_LIMITS,
};
