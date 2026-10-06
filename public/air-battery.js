'use strict';

/**
 * Sidebar-bottom battery readout of the machine running MultiCC.
 *
 * The number comes from `GET /api/host/battery` (server-side `pmset`), so a phone
 * or a remote browser sees the host laptop's charge, not its own. Hosts without a
 * battery answer `available:false` and the row stays hidden.
 *
 * Self-initialising like air-ops.js: no page context from air.js is needed.
 */
(function initAirBattery(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const POLL_MS = 60 * 1000;
  const LOW_PERCENT = 20;

  // One state -> one icon, so tests and the stylesheet agree on what "low" means.
  function describe(battery) {
    if (!battery || battery.available !== true || !Number.isFinite(battery.percent)) return null;
    const percent = Math.round(battery.percent);
    const charging = battery.charging === true;
    const low = !charging && percent <= LOW_PERCENT;
    return { percent, charging, low, icon: charging ? '⚡' : low ? '🪫' : '🔋' };
  }

  function paint(battery) {
    const row = document.getElementById('air-battery');
    if (!row) return;
    const view = describe(battery);
    row.hidden = !view;
    if (!view) return;
    const icon = document.getElementById('air-battery-icon');
    const text = document.getElementById('air-battery-text');
    if (icon) icon.textContent = view.icon;
    if (text) text.textContent = `${view.percent}%`;
    row.classList.toggle('low', view.low);
    row.classList.toggle('charging', view.charging);
    row.title = `${view.percent}%`;
  }

  async function refresh() {
    try {
      const response = await root.fetch('/api/host/battery');
      paint(response.ok ? await response.json() : null);
    } catch (_) { /* A failed poll keeps the last reading; the next tick retries. */ }
  }

  root.MultiCCAirBattery = { describe, paint, refresh };
  void refresh();
  root.setInterval(refresh, POLL_MS);
})(typeof window !== 'undefined' ? window : globalThis);
