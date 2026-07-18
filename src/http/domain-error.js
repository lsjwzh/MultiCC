'use strict';

const DOMAIN_ERROR = Symbol('MultiCC.DomainError');
const INFRASTRUCTURE_ERROR = Symbol('MultiCC.InfrastructureError');

const DOMAIN_KINDS = Object.freeze({
  BAD_REQUEST: 'bad_request',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  INTERNAL: 'internal',
});

class DomainError extends Error {
  constructor(kind, message, { code, publicMessage, compatibility, cause } = {}) {
    super(typeof message === 'string' ? message : 'domain operation failed');
    this.name = 'DomainError';
    this.kind = String(kind || 'unknown');
    this.code = code;
    this.publicMessage = publicMessage === undefined ? this.message : publicMessage;
    this.compatibility = compatibility;
    if (cause !== undefined) this.cause = cause;
    Object.defineProperty(this, DOMAIN_ERROR, { value: true });
  }
}

class InfrastructureError extends Error {
  constructor(message, { code, compatibility, cause } = {}) {
    super(typeof message === 'string' ? message : 'infrastructure operation failed');
    this.name = 'InfrastructureError';
    this.code = code;
    this.compatibility = compatibility;
    if (cause !== undefined) this.cause = cause;
    Object.defineProperty(this, INFRASTRUCTURE_ERROR, { value: true });
  }
}

function isDomainError(value) {
  return !!(value && value[DOMAIN_ERROR] === true);
}

function isInfrastructureError(value) {
  return !!(value && value[INFRASTRUCTURE_ERROR] === true);
}

module.exports = {
  DOMAIN_KINDS,
  DomainError,
  InfrastructureError,
  isDomainError,
  isInfrastructureError,
};
