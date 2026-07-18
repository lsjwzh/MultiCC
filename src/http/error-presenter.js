'use strict';

const { createErrorDto, safeId } = require('../api-contract');
const { mapError } = require('./error-map');

function presentationContext(context = {}) {
  const requestId = safeId(context.requestId);
  const correlationId = safeId(context.correlationId, requestId);
  return { requestId, correlationId };
}

function presentError(error, context = {}, { compatibility = false } = {}) {
  const mapped = mapError(error);
  const ids = presentationContext(context);
  const body = createErrorDto({
    message: mapped.message,
    code: mapped.code,
    requestId: ids.requestId,
    correlationId: ids.correlationId,
  });
  if (compatibility) Object.assign(body, mapped.compatibility);
  return Object.freeze({ status: mapped.status, body: Object.freeze(body) });
}

module.exports = { presentError, presentationContext };
