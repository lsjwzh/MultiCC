'use strict';

const { DomainError, DOMAIN_KINDS } = require('./domain-error');
const { presentError } = require('./error-presenter');

// Some diagnostic endpoints historically return HTTP 200 with { ok:false } to
// mean "the dependency is unhealthy" rather than "the request failed". This
// helper preserves that wire behavior while applying the same error whitelist.
function presentDiagnosticResult(result, context = {}, {
  kind = DOMAIN_KINDS.BAD_REQUEST,
  compatibility = true,
} = {}) {
  if (!result || typeof result !== 'object' || result.ok !== false) {
    throw new TypeError('presentDiagnosticResult requires a legacy { ok:false } result');
  }
  const compatibilitySource = {
    ...result,
    ...(result.compatibility && typeof result.compatibility === 'object'
      ? result.compatibility
      : {}),
  };
  const error = new DomainError(kind, result.message || result.error || 'request_error', {
    code: result.code,
    publicMessage: result.error || result.message,
    compatibility: compatibilitySource,
  });
  const presented = presentError(error, context, { compatibility });
  return Object.freeze({ status: 200, body: presented.body });
}

module.exports = { presentDiagnosticResult };
