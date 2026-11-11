'use strict';

// Frozen copy of the three diagnostics handlers that used to be `mountRoutes`
// in src/turn-ledger/runtime.js, kept verbatim (apart from the injected
// dependencies) so docs/rust-migration/differential/turn-ledger.js can compare
// the Rust front door against what Node used to answer.
//
// The retired runtime closed over `launches`, `ledger.snapshot` and the hook
// installer; here those arrive as arguments, which is exactly what the deleted
// code read.

const SID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function mountTurnLedgerRoutes(app, deps) {
  const { launches, snapshot, trustStatus, grantTrust } = deps;

  function launchFor(req, res) {
    const sid = req.params.id;
    const launch = SID_RE.test(sid) ? launches[sid] : null;
    if (!launch || launch.cli !== 'codex') {
      res.status(409).json({ error: 'not a launched codex terminal' });
      return null;
    }
    return launch;
  }

  app.get('/api/sessions/:id/turn-ledger', (req, res) => {
    const sid = req.params.id;
    res.json({ shadow: true, launch: launches[sid] || null, snapshot: snapshot(sid) });
  });
  app.get('/api/sessions/:id/turn-hooks/codex-trust', async (req, res) => {
    const launch = launchFor(req, res);
    if (!launch) return;
    try { res.json(await trustStatus(launch)); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/api/sessions/:id/turn-hooks/codex-trust', async (req, res) => {
    const launch = launchFor(req, res);
    if (!launch) return;
    try { res.json(await grantTrust(launch)); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
}

module.exports = { mountTurnLedgerRoutes };
