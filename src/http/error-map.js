'use strict';

const {
  DOMAIN_KINDS,
  isDomainError,
  isInfrastructureError,
} = require('./domain-error');
const { HttpError, isHttpError } = require('./http-error');
const { safeCode, sanitizePublicText } = require('./public-safety');

const DOMAIN_ERROR_MAP = Object.freeze({
  [DOMAIN_KINDS.BAD_REQUEST]: Object.freeze({ status: 400, code: 'invalid_request', error: 'request_error' }),
  [DOMAIN_KINDS.NOT_FOUND]: Object.freeze({ status: 404, code: 'not_found', error: 'not_found' }),
  [DOMAIN_KINDS.CONFLICT]: Object.freeze({ status: 409, code: 'conflict', error: 'conflict' }),
  [DOMAIN_KINDS.RATE_LIMITED]: Object.freeze({ status: 429, code: 'rate_limited', error: 'rate_limited' }),
  [DOMAIN_KINDS.INTERNAL]: Object.freeze({ status: 500, code: 'internal_error', error: 'internal_error' }),
});

function internalError(cause, compatibility) {
  return new HttpError({
    status: 500,
    code: 'internal_error',
    message: 'internal_error',
    compatibility,
    cause,
  });
}

function mapError(error) {
  if (isHttpError(error)) return error;
  if (isInfrastructureError(error)) return internalError(error, error.compatibility);
  if (!isDomainError(error)) return internalError(error);

  const definition = DOMAIN_ERROR_MAP[error.kind];
  if (!definition || definition.status >= 500) {
    return internalError(error, error.compatibility);
  }
  return new HttpError({
    status: definition.status,
    code: safeCode(error.code, definition.code),
    message: sanitizePublicText(error.publicMessage, definition.error),
    compatibility: error.compatibility,
    cause: error,
  });
}

module.exports = { DOMAIN_ERROR_MAP, mapError };
