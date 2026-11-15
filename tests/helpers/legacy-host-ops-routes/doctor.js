'use strict';

function mountDoctorRoutes(app, { doctor }) {
  if (!doctor) throw new TypeError('doctor service required');

  app.post('/api/sessions/:id/doctor', (req, res) => {
    const body = req.body || {};
    const out = doctor.start({ sessionId: String(req.params.id || ''), autofix: body.autofix === true, note: body.note });
    if (!out.ok) return res.status(out.status || 400).json({ ok: false, error: out.error });
    return res.json(out);
  });

  app.get('/api/sessions/:id/doctor', (req, res) => res.json({ runs: doctor.list(String(req.params.id || '')) }));

  app.get('/api/doctor/runs/:runId', (req, res) => {
    const run = doctor.get(String(req.params.runId || ''));
    return run ? res.json({ run }) : res.status(404).json({ error: 'doctor run not found' });
  });

  app.post('/api/doctor/runs/:runId/cancel', (req, res) => res.json({ ok: doctor.cancel(String(req.params.runId || '')) }));
}

module.exports = { mountDoctorRoutes };
