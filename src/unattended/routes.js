'use strict';

// HTTP surface of unattended mode (contract: docs/unattended-mode.md).
//
//   GET  /api/sessions/:id/unattended → { ok, unattended, limits }
//   POST /api/sessions/:id/unattended → { ok, unattended, limits }
//
// The supervisor host is late-bound (`deps.getUnattended`): it is composed after
// this module is required, like the other runtime hosts.

const { LIMITS } = require('./kernel');

function mountUnattendedRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('[unattended-routes] Express app is required');
  }
  const records = deps.records;
  if (!records || typeof records.get !== 'function') {
    throw new TypeError('[unattended-routes] records map is required');
  }
  const getHost = () => (typeof deps.getUnattended === 'function' ? deps.getUnattended() : null);

  function respond(res, result) {
    if (result.ok) {
      return res.json({ ok: true, unattended: result.unattended || null, limits: LIMITS });
    }
    const status = Number(result.status) || 409;
    return res.status(status).json({
      ok: false,
      error: result.code || 'unattended_failed',
      unattended: null,
      limits: LIMITS,
    });
  }

  app.get('/api/sessions/:id/unattended', (req, res) => {
    const host = getHost();
    if (!host) return res.status(501).json({ ok: false, error: 'unattended_unavailable' });
    const id = req.params.id;
    if (!records.get(id)) return res.status(404).json({ ok: false, error: 'session_not_found' });
    return res.json({ ok: true, unattended: host.get(id) || null, limits: LIMITS });
  });

  app.post('/api/sessions/:id/unattended', async (req, res) => {
    const host = getHost();
    if (!host) return res.status(501).json({ ok: false, error: 'unattended_unavailable' });
    const id = req.params.id;
    const record = records.get(id);
    if (!record) return res.status(404).json({ ok: false, error: 'session_not_found' });
    if (record.type === 'aux' || record.type === 'gateway') {
      return res.status(400).json({ ok: false, error: 'not_a_chat_session' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    switch (body.action) {
      case 'start': return respond(res, await host.start(id, body));
      case 'update': return respond(res, host.update(id, body));
      case 'stop': return respond(res, host.stop(id));
      case 'resume': return respond(res, await host.resume(id));
      default:
        return res.status(400).json({ ok: false, error: 'bad_action', unattended: host.get(id) || null });
    }
  });
}

module.exports = { mountUnattendedRoutes };
