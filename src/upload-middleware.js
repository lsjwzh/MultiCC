'use strict';

const { createUploadSuite, createAdmissionGate, UploadPolicyError, UPLOAD_LIMITS, getNative } = require('./native/binding');
function voiceMimeAllowed(value) { return getNative().voiceUploadMime(String(value || 'application/octet-stream')); }
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

module.exports = {
  UPLOAD_LIMITS,
  UploadPolicyError,
  createAdmissionGate,
  createUploadSuite,
  mapUploadError,
  sendUploadError,
  voiceMimeAllowed,
};
