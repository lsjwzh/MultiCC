'use strict';

// Global realtime-voice control plane.
//
// There is exactly one realtime voice gateway per machine. Every entry point —
// the Dashboard button, the Web Chat phone button, the Flutter Chat phone
// button — hits `POST /voice-gateway/launch` and gets back an opaque, expiring
// launch id. The client never names a directory, cwd, Commander or prompt; the
// Host resolves all of that from its own records when the launch is redeemed.
//
// The legacy `/directories/:id/voice-gateway*` routes stay mounted for one
// compatibility window (see routes/voice-gateway.js). They keep editing the old
// per-Fleet records, but the *runtime* they project is this single global child.

const { createErrorDto, requestContext, withApiMeta } = require('../api-contract');
const { publicBaseUrl } = require('./voice-gateway');

const NOT_FOUND = new Set(['voice_gateway_not_found', 'voice_launch_source_not_found', 'voice_launch_unknown']);
// voice_router_not_provisioned / voice_router_id_conflict fall through to 409.
const BAD_REQUEST = new Set([
  'commander_binding_is_host_owned',
  'voice_gateway_provider_invalid',
  'voice_gateway_enabled_invalid',
  'voice_gateway_auto_install_invalid',
  'voice_launch_required',
  'voice_launch_scope_invalid',
  'voice_launch_source_required',
  'voice_launch_source_not_addressable',
  'voice_launch_source_not_chat',
]);
const GONE = new Set(['voice_launch_expired']);

function statusForCode(code) {
  if (NOT_FOUND.has(code)) return 404;
  if (BAD_REQUEST.has(code)) return 400;
  if (GONE.has(code)) return 410;
  return 409;
}

// The Qwen web client reads `?session=` (max 200 chars) from its page URL and
// carries it through to every ACP prompt as `voice_session_id`. That is the only
// channel we need: the launch id *is* the Qwen voice session id.
function launchUrl(runtimeUrl, launchId) {
  const base = String(runtimeUrl || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/?session=${encodeURIComponent(launchId)}`;
}

function createGlobalVoiceGatewayRoutes({
  service,
  launchRegistry,
  voiceRouter = null,
  runtime = null,
  getBaseUrl = () => 'http://127.0.0.1:3000',
  log = console,
} = {}) {
  if (!service || typeof service.inspectGlobal !== 'function') {
    throw new TypeError('global voice gateway routes require the voice gateway service');
  }
  if (!launchRegistry || typeof launchRegistry.issue !== 'function') {
    throw new TypeError('global voice gateway routes require a launch registry');
  }

  function fail(req, res, code, versioned, extra = {}) {
    const status = statusForCode(code);
    if (versioned) {
      return res.status(status).json(createErrorDto({
        message: code,
        code,
        ...requestContext(req, res),
      }));
    }
    return res.status(status).json({ ok: false, error: code, ...extra });
  }

  function ok(req, res, payload, versioned) {
    return res.json(versioned ? withApiMeta(payload, requestContext(req, res)) : payload);
  }

  function get(req, res, versioned) {
    const result = service.inspectGlobal();
    res.set?.('Cache-Control', 'no-store');
    return ok(req, res, {
      ok: true,
      gateway: result.gateway,
      legacy: result.legacy,
      baseUrl: publicBaseUrl(getBaseUrl()),
    }, versioned);
  }

  function put(req, res, next, versioned) {
    try {
      const body = req.body || {};
      if (body.autoInstall !== undefined && typeof body.autoInstall !== 'boolean') {
        return fail(req, res, 'voice_gateway_auto_install_invalid', versioned);
      }
      const result = service.ensureGlobal({
        enabled: body.enabled,
        provider: body.provider,
        commanderSessionId: body.commanderSessionId,
      });
      if (!result.ok) return fail(req, res, result.code, versioned);
      // A global launch has nowhere to land without the router session, so
      // provision it with the gateway rather than at first use.
      if (result.gateway.enabled === true) {
        const provisioned = voiceRouter?.ensure?.();
        if (provisioned && provisioned.ok === false) {
          log.warn?.('[multicc/voice] router provisioning failed', { code: provisioned.code });
        }
      }
      // reconcileAll is the single place that decides how many children run, so
      // enabling the global gateway also stops any leftover per-Fleet child.
      runtime?.reconcileAll?.({ installIfNeeded: body.autoInstall === true });
      res.set?.('Cache-Control', 'no-store');
      res.status(result.created ? 201 : 200);
      return ok(req, res, { ok: true, created: result.created, gateway: result.gateway }, versioned);
    } catch (error) {
      return typeof next === 'function' ? next(error) : res.status(500).json({ error: 'internal_error' });
    }
  }

  function remove(req, res, next, versioned) {
    try {
      const result = service.removeGlobal();
      if (!result.ok) return fail(req, res, result.code, versioned);
      Promise.resolve(runtime?.stopGlobal?.()).catch(() => {});
      return ok(req, res, { ok: true, removed: true }, versioned);
    } catch (error) {
      return typeof next === 'function' ? next(error) : res.status(500).json({ error: 'internal_error' });
    }
  }

  function runtimeStatus(req, res, versioned) {
    res.set?.('Cache-Control', 'no-store');
    const status = runtime?.statusGlobal?.() || { scope: 'global', state: 'stopped', desired: false, url: null };
    // The child listens on loopback only. Never hand its raw URL to a caller
    // that is not on this machine, and never claim remote reachability we do
    // not actually have.
    return ok(req, res, { ok: true, runtime: { ...status, url: undefined } }, versioned);
  }

  async function restart(req, res, next, versioned) {
    try {
      const status = await runtime?.restartGlobal?.();
      res.set?.('Cache-Control', 'no-store');
      return ok(req, res, { ok: true, runtime: { ...(status || {}), url: undefined } }, versioned);
    } catch (error) {
      return typeof next === 'function' ? next(error) : res.status(500).json({ error: 'internal_error' });
    }
  }

  // The only client-facing entry point. `{}` means "global"; `{sourceSessionId}`
  // means "this chat". Anything else the client sends is ignored on purpose.
  async function launch(req, res, next, versioned) {
    try {
      const body = req.body || {};
      const inspected = service.inspectGlobal();
      if (!inspected.gateway.configured || inspected.gateway.enabled !== true) {
        return fail(req, res, 'voice_gateway_not_found', versioned);
      }
      // Backfill for a gateway configured before the router existed.
      if (!body.sourceSessionId) voiceRouter?.ensure?.();
      const issued = launchRegistry.issue({ sourceSessionId: body.sourceSessionId });
      if (!issued.ok) return fail(req, res, issued.code, versioned);

      // Start on demand so the first launch of the day does not require the user
      // to have pressed a separate "start" button.
      let status = runtime?.statusGlobal?.() || null;
      if (status && status.state !== 'running') {
        try { status = await runtime?.startGlobal?.(); } catch (_) { /* reported via state below */ }
      }
      const url = launchUrl(status?.url, issued.launch.id);
      if (!url) {
        launchRegistry.revoke(issued.launch.id);
        return fail(req, res, status?.lastError?.code || 'voice_gateway_not_running', versioned);
      }
      res.set?.('Cache-Control', 'no-store');
      try {
        log.info?.('[multicc/voice] launch issued', {
          scope: issued.launch.scope,
          source: issued.launch.sourceSessionId || null,
          target: issued.context.targetSessionId,
        });
      } catch (_) {}
      return ok(req, res, {
        ok: true,
        launch: {
          url,
          scope: issued.launch.scope,
          expiresAt: issued.launch.expiresAt,
          display: issued.launch.display,
          // Honest about the current transport: the Qwen child binds to
          // 127.0.0.1, so this URL only opens from this machine.
          transport: { loopbackOnly: true },
        },
      }, versioned);
    } catch (error) {
      return typeof next === 'function' ? next(error) : res.status(500).json({ error: 'internal_error' });
    }
  }

  // Redeemed once per voice utterance by the ACP agent, never by a browser.
  // Re-resolving here is what makes a Commander swap take effect without a
  // restart and a forged or expired id inert.
  function resolveLaunch(req, res, versioned) {
    const result = launchRegistry.resolve(req.params.launchId);
    if (!result.ok) return fail(req, res, result.code, versioned);
    res.set?.('Cache-Control', 'no-store');
    return ok(req, res, { ok: true, context: result.context }, versioned);
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
        || typeof app.put !== 'function' || typeof app.delete !== 'function') {
      throw new TypeError('global voice gateway routes require an Express-compatible app');
    }
    app.get('/api/voice-gateway', (req, res) => get(req, res, false));
    app.get('/api/v1/voice-gateway', (req, res) => get(req, res, true));
    app.put('/api/voice-gateway', (req, res, next) => put(req, res, next, false));
    app.put('/api/v1/voice-gateway', (req, res, next) => put(req, res, next, true));
    app.delete('/api/voice-gateway', (req, res, next) => remove(req, res, next, false));
    app.delete('/api/v1/voice-gateway', (req, res, next) => remove(req, res, next, true));
    app.get('/api/voice-gateway/runtime', (req, res) => runtimeStatus(req, res, false));
    app.get('/api/v1/voice-gateway/runtime', (req, res) => runtimeStatus(req, res, true));
    app.post('/api/voice-gateway/restart', (req, res, next) => restart(req, res, next, false));
    app.post('/api/v1/voice-gateway/restart', (req, res, next) => restart(req, res, next, true));
    app.post('/api/voice-gateway/launch', (req, res, next) => launch(req, res, next, false));
    app.post('/api/v1/voice-gateway/launch', (req, res, next) => launch(req, res, next, true));
    app.get('/api/voice-gateway/launch/:launchId', (req, res) => resolveLaunch(req, res, false));
    app.get('/api/v1/voice-gateway/launch/:launchId', (req, res) => resolveLaunch(req, res, true));
  }

  return Object.freeze({ mountRoutes });
}

module.exports = {
  createGlobalVoiceGatewayRoutes,
  launchUrl,
  statusForCode,
};
