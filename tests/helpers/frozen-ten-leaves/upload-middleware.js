'use strict';

// Voice uploads only. Chat attachments (multipart parsing, limits, the temp-file
// quota and the on-disk write) live in the Rust front door (multicc-gateway);
// Node keeps this suite for the in-process ASR/voice routes, which still pass
// buffers straight to the voice host.

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
    voice: gate(createParser(multerImpl, { fileSize, allowed: voiceMimeAllowed })),
  });
}

module.exports = {
  UPLOAD_LIMITS,
  UploadPolicyError,
  createAdmissionGate,
  createUploadSuite,
  mapUploadError,
  sendUploadError,
  voiceMimeAllowed,
};
