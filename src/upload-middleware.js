'use strict';

const { getNative } = require('./native/binding');

// Voice uploads only. Chat attachments (multipart parsing, limits, the temp-file
// quota and the on-disk write) live in the Rust front door (multicc-gateway);
// Node keeps this suite for the in-process ASR/voice routes, which still pass
// buffers straight to the voice host.

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

function voiceMimeAllowed(value) {
  return getNative().voiceUploadMime(String(value || 'application/octet-stream'));
}

function safeOriginalName(value) {
  return getNative().voiceUploadName(String(value || 'upload.bin'));
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
  return getNative().voiceUploadError(error && error.code);
}

function sendUploadError(res, error) {
  const mapped = mapUploadError(error);
  res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
}

function createAdmissionGate(maxActive) {
  const admit = getNative().voiceUploadGate(active => active >= maxActive);
  return function wrap(parser) {
    return (req, res, next) => {
      const release = admit();
      if (!release) {
        res.setHeader('Connection', 'close');
        return sendUploadError(res, new UploadPolicyError('too many concurrent uploads', 'UPLOAD_BUSY', 429));
      }
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
