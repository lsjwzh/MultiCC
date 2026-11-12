'use strict';

// Live host ports only. The gateway owns relay route matching and model DTOs;
// the existing Rust HTTP entry owner retains admission and scoped grant state.
const { isLocalRequest } = require('../request-locality');
const HOST_PATH = '/api/__host/provider-relay';

function mountProviderRelayHostRoute(app, { authRuntime, modelCatalogRuntime, isLocal = isLocalRequest }) {
  app.post(HOST_PATH, async (req, res) => {
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = req.body || {};
    try {
      if (body.op === 'admission') {
        const wire = body.request || {};
        const originalUrl = typeof wire.originalUrl === 'string' ? wire.originalUrl : '';
        const queryAt = originalUrl.indexOf('?');
        const queryParser = app.get('query parser fn');
        const socket = { remoteAddress: wire.peer };
        const request = {
          method: wire.method,
          path: wire.path,
          url: originalUrl,
          originalUrl,
          headers: wire.headers || {},
          query: queryAt >= 0 && typeof queryParser === 'function'
            ? queryParser(originalUrl.slice(queryAt + 1)) : {},
          socket,
          connection: socket,
          ip: wire.peer,
          secure: false,
          id: wire.id,
          correlationId: wire.correlationId,
        };
        return res.json(await authRuntime.admitGatewayRequest(request));
      }
      if (body.op === 'catalogFacts') {
        return res.json(await modelCatalogRuntime.sourceCatalogFacts(body.appType, body.id));
      }
      return res.status(400).json({ error: 'unknown host operation' });
    } catch (_) {
      return res.status(500).json({ error: 'host operation failed' });
    }
  });
}

module.exports = { HOST_PATH, mountProviderRelayHostRoute };
