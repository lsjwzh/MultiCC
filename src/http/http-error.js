'use strict';

const {
  safeCode,
  sanitizeCompatibility,
  sanitizePublicText,
} = require('./public-safety');

const HTTP_ERROR = Symbol('MultiCC.HttpError');

function trustedStatus(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

class HttpError extends Error {
  constructor({ status, code, message, compatibility, cause } = {}) {
    const normalizedStatus = trustedStatus(status);
    const internal = normalizedStatus >= 500;
    const fallback = internal ? 'internal_error' : 'request_error';
    const publicMessage = internal ? fallback : sanitizePublicText(message, fallback);
    super(publicMessage);
    this.name = 'HttpError';
    this.status = normalizedStatus;
    this.code = internal ? 'internal_error' : safeCode(code, fallback);
    this.safe = !internal;
    this.compatibility = sanitizeCompatibility(compatibility);
    if (cause !== undefined) this.cause = cause;
    Object.defineProperty(this, HTTP_ERROR, { value: true });
    Object.freeze(this);
  }
}

function isHttpError(value) {
  return !!(value && value[HTTP_ERROR] === true);
}

module.exports = { HttpError, isHttpError, trustedStatus };
