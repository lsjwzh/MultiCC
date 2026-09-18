'use strict';

const { MODES, DEFAULT_MODE, normalizeAttributionMode } = require('../task-routing/attribution-mode');

// The automatic-attribution ladder is a host policy switch, not a per-call
// flag: one value decides what every conversation may do on its own. The value
// is persisted next to the other host settings (by host-write, which owns the
// .env file), so a restart can neither widen nor narrow it by accident, and an
// unknown value falls back to the safe tier instead of the most permissive one.
//
// This module deliberately holds the live value only. Writing .env is
// host-write's job: doing it here too would mean two writers, two rollback
// orders and two notions of "local" for one setting.
function createAttributionSettings({ initial = null } = {}) {
  let mode = normalizeAttributionMode(initial, DEFAULT_MODE);

  function getMode() { return mode; }

  // Pure value switch: validates, then swaps the live tier. Persistence and its
  // compensation live in the caller that owns the file.
  function setMode(value) {
    const requested = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!MODES.includes(requested)) {
      throw Object.assign(new Error(`mode must be one of ${MODES.join(', ')}`), { code: 'invalid_mode', status: 400 });
    }
    if (requested === mode) return { mode, changed: false };
    const previous = mode;
    mode = requested;
    return { mode, changed: true, previous };
  }

  // Only the read route lives here. The write is a host setting: it belongs to
  // src/routes/host-write.js, which owns the local-only check and the
  // persist→apply→rollback order, so there is exactly one such layer.
  function mount(app) {
    app.get('/api/settings/task-attribution', (_req, res) =>
      res.json({ mode: getMode(), modes: [...MODES], default: DEFAULT_MODE }));
  }

  return { getMode, setMode, mount };
}

function createAttributionSettingsFromEnv() {
  return createAttributionSettings({ initial: process.env.MULTICC_TASK_ATTRIBUTION_MODE });
}

module.exports = { createAttributionSettings, createAttributionSettingsFromEnv };
