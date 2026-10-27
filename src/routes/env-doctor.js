'use strict';

// Environment doctor routes (src/doctor/environment.js). Under /api/system/
// beside the repair terminal they feed, and behind the same global auth gate.
function mountEnvDoctorRoutes(app, { doctor }) {
  if (!doctor) throw new TypeError('environment doctor required');

  app.post('/api/system/env-doctor', (req, res) => {
    const body = req.body || {};
    const out = doctor.start({ error: body.error, path: body.path, fix: body.fix, recent: body.recent, lang: body.lang });
    if (!out.ok) return res.status(out.status || 400).json({ ok: false, code: out.code, error: out.error });
    return res.json(out);
  });

  app.get('/api/system/env-doctor/:runId', (req, res) => {
    const run = doctor.get(String(req.params.runId || ''));
    return run ? res.json({ ok: true, run }) : res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'diagnosis not found' });
  });

  app.post('/api/system/env-doctor/:runId/cancel', (req, res) => res.json({ ok: doctor.cancel(String(req.params.runId || '')) }));
}

module.exports = { mountEnvDoctorRoutes };
