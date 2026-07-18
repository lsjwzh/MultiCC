'use strict';

const { mapError } = require('./error-map');

// Express 4 rejection adapter. It deliberately does not send a response: the
// existing terminal safeErrorHandler remains the single HTTP response owner.
function asyncRoute(handler, { errorMapper = mapError } = {}) {
  if (typeof handler !== 'function') throw new TypeError('asyncRoute requires a handler function');
  if (typeof errorMapper !== 'function') throw new TypeError('asyncRoute errorMapper must be a function');
  return function mappedAsyncRoute(req, res, next) {
    return Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(error => next(errorMapper(error)));
  };
}

module.exports = { asyncRoute };
