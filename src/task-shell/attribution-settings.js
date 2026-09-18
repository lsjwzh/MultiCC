'use strict';

const { MODES, DEFAULT_MODE, normalizeAttributionMode } = require('../task-routing/attribution-mode');

// The automatic-attribution ladder is a host policy switch, not a per-call
// flag: one value decides what every conversation may do on its own, so it is
// persisted next to the other host settings. A restart can then neither widen
// nor narrow it by accident, and an unknown value falls back to the safe tier
// instead of the most permissive one.
function createAttributionSettings({ initial = null, persist = null, reportFailure = null, isLocalRequest = null } = {}) {
  let mode = normalizeAttributionMode(initial, DEFAULT_MODE);

  function getMode() { return mode; }

  function setMode(value) {
    const requested = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!MODES.includes(requested)) {
      throw Object.assign(new Error(`mode must be one of ${MODES.join(', ')}`), { code: 'invalid_mode', status: 400 });
    }
    if (requested === mode) return { mode, changed: false };
    const previous = mode;
    if (persist) {
      try { persist({ MULTICC_TASK_ATTRIBUTION_MODE: requested }); }
      catch (error) {
        reportFailure?.(error);
        throw Object.assign(new Error('This setting could not be saved'), { code: 'persist_failed', status: 500 });
      }
    }
    mode = requested;
    return { mode, changed: true, previous };
  }

  function mount(app) {
    app.get('/api/settings/task-attribution', (_req, res) =>
      res.json({ mode: getMode(), modes: [...MODES], default: DEFAULT_MODE }));
    app.post('/api/settings/task-attribution', (req, res, next) => {
      if (isLocalRequest && !isLocalRequest(req)) return res.status(403).json({ error: '仅可在本机修改' });
      try {
        return res.json({ ok: true, ...setMode(req.body?.mode) });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
        return next(error);
      }
    });
  }

  return { getMode, setMode, mount };
}

// Composition helper: the host only supplies the ports it already owns (the
// .env writer, its control-failure reporter and the locality check), so the
// switch never grows a second writer or a second notion of "local".
function createAttributionSettingsFromEnv({ writeEnv = null, reportFailure = null, isLocalRequest = null } = {}) {
  return createAttributionSettings({
    initial: process.env.MULTICC_TASK_ATTRIBUTION_MODE,
    persist: writeEnv || null,
    reportFailure: reportFailure ? error => reportFailure('attribution_settings', 'persist', error?.message || 'failed') : null,
    isLocalRequest,
  });
}

module.exports = { createAttributionSettings, createAttributionSettingsFromEnv };
