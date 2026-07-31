'use strict';

const path = require('path');
const { createErrorDto, requestContext, withApiMeta } = require('../api-contract');
const { createVoiceGatewayService, GATEWAY_PROVIDER } = require('../voice-gateway');

function resultStatus(code) {
  if (code === 'directory_not_found' || code === 'voice_gateway_not_found') return 404;
  if (code === 'directory_required'
      || code === 'commander_binding_is_host_owned'
      || code === 'voice_gateway_provider_invalid'
      || code === 'voice_gateway_enabled_invalid'
      || code === 'voice_gateway_auto_install_invalid') return 400;
  return 409;
}

function publicBaseUrl(value) {
  try {
    const url = new URL(String(value || 'http://127.0.0.1:3000'));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    url.username = '';
    url.password = '';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return 'http://127.0.0.1:3000';
  }
}

function createVoiceGatewayRoutes({
  records,
  directories,
  sessionPersistence,
  acpAgentPath = path.join(__dirname, '..', 'voice', 'multicc-acp-agent.mjs'),
  nodePath = process.execPath,
  getBaseUrl = () => 'http://127.0.0.1:3000',
  runtime = null,
} = {}) {
  if (!sessionPersistence || typeof sessionPersistence.mutate !== 'function') {
    throw new TypeError('voice gateway routes require sessionPersistence.mutate');
  }
  const service = createVoiceGatewayService({
    records,
    directories,
    mutate: (source, operation) => sessionPersistence.mutate(source, operation),
  });

  function withLaunch(gateway) {
    return {
      ...gateway,
      acp: {
        protocol: 'acp-v1-stdio',
        command: nodePath,
        args: [acpAgentPath, '--directory-id', gateway.directoryId],
        env: {
          MULTICC_BASE_URL: publicBaseUrl(getBaseUrl()),
        },
        note: 'Qwen generic ACP 的第三层会话工具会被忽略；任务只由 MultiCC Commander 路由。',
      },
    };
  }

  function sendFailure(req, res, result, versioned = false) {
    const payload = {
      ok: false,
      error: result.code,
      ...(result.gatewayIds ? { gatewayIds: result.gatewayIds } : {}),
    };
    return res.status(resultStatus(result.code)).json(versioned
      ? createErrorDto({ message: result.code, code: result.code, ...requestContext(req, res) })
      : payload);
  }

  function sendSuccess(req, res, payload, versioned = false) {
    return res.json(versioned ? withApiMeta(payload, requestContext(req, res)) : payload);
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function'
        || typeof app.put !== 'function' || typeof app.delete !== 'function') {
      throw new TypeError('voice gateway routes require an Express-compatible app');
    }

    function list(req, res, versioned = false) {
      res.set?.('Cache-Control', 'no-store');
      const gateways = service.list();
      return sendSuccess(req, res, {
        ok: true,
        gateways: versioned ? gateways : gateways.map(withLaunch),
      }, versioned);
    }

    function get(req, res, versioned = false) {
      const result = service.inspect(req.params.id);
      if (!result.ok) return sendFailure(req, res, result, versioned);
      res.set?.('Cache-Control', 'no-store');
      return sendSuccess(req, res, {
        ok: true,
        gateway: versioned ? result.gateway : withLaunch(result.gateway),
      }, versioned);
    }

    function put(req, res, next, versioned = false) {
      try {
        const body = req.body || {};
        if (body.autoInstall !== undefined && typeof body.autoInstall !== 'boolean') {
          return sendFailure(req, res, { code: 'voice_gateway_auto_install_invalid' }, versioned);
        }
        const result = service.ensure(req.params.id, {
          enabled: body.enabled,
          provider: body.provider,
          commanderSessionId: body.commanderSessionId,
        });
        if (!result.ok) return sendFailure(req, res, result, versioned);
        runtime?.reconcile?.(req.params.id, { installIfNeeded: body.autoInstall === true });
        res.set?.('Cache-Control', 'no-store');
        res.status(result.created ? 201 : 200);
        return sendSuccess(req, res, {
          ok: true,
          created: result.created,
          gateway: versioned ? result.gateway : withLaunch(result.gateway),
        }, versioned);
      } catch (error) {
        if (error?.code === 'voice_gateway_id_conflict') {
          return sendFailure(req, res, { code: error.code }, versioned);
        }
        return typeof next === 'function' ? next(error) : res.status(500).json({ error: 'internal_error' });
      }
    }

    function remove(req, res, next, versioned = false) {
      try {
        const result = service.remove(req.params.id);
        if (!result.ok) return sendFailure(req, res, result, versioned);
        Promise.resolve(runtime?.stop?.(req.params.id)).catch(() => {});
        return sendSuccess(req, res, result, versioned);
      } catch (error) {
        return typeof next === 'function' ? next(error) : res.status(500).json({ error: 'internal_error' });
      }
    }

    app.get('/api/voice-gateways', (req, res) => list(req, res));
    app.get('/api/v1/voice-gateways', (req, res) => list(req, res, true));
    app.get('/api/directories/:id/voice-gateway', (req, res) => get(req, res));
    app.get('/api/v1/directories/:id/voice-gateway', (req, res) => get(req, res, true));
    app.put('/api/directories/:id/voice-gateway', (req, res, next) => put(req, res, next));
    app.put('/api/v1/directories/:id/voice-gateway', (req, res, next) => put(req, res, next, true));
    app.delete('/api/directories/:id/voice-gateway', (req, res, next) => remove(req, res, next));
    app.delete('/api/v1/directories/:id/voice-gateway', (req, res, next) => remove(req, res, next, true));
  }

  return Object.freeze({ mountRoutes, service, provider: GATEWAY_PROVIDER });
}

module.exports = {
  createVoiceGatewayRoutes,
  publicBaseUrl,
  resultStatus,
};
