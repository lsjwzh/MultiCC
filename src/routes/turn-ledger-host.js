'use strict';

// Host port (host port): the three terminal turn-ledger diagnostics routes now
// belong to the Rust front door (multicc-gateway), and the Node handlers that
// used to be `mountRoutes` in src/turn-ledger/runtime.js are gone:
//
//   GET  /api/sessions/:id/turn-ledger
//   GET  /api/sessions/:id/turn-hooks/codex-trust
//   POST /api/sessions/:id/turn-hooks/codex-trust
//
// Path matching, the decoded `:id`, the `Allow` lists, the 409 for a session
// that is not a launched Codex terminal, the snapshot DTO (field order, the
// `liveness` projection, `reason`, `lastEventAt || null`) and the 502 mapping
// live in native/gateway/src/app/turn_ledger.rs. What stays here is exactly the
// state Rust cannot see: the in-process `launches` table, the TurnLedger's
// per-session record, and the `codex app-server` JSON-RPC calls the trust pair
// makes through the installer.
//
// Ops (all answered as raw material, never as a final response):
//   { op: 'ledger', sessionId }              -> { ok, launch, record }
//   { op: 'launch', sessionId }              -> { ok, launch }
//   { op: 'trust', write, codexHome, cwd }   -> { ok, value } | { ok: false, message }
//
// This is not a public API: the front door calls it on the internal port with a
// loopback PROXY line, and `isLocalRequest` refuses anything forwarded from a
// real remote client (docs/gateway.md, internal port model).

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/turn-ledger';

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('[turn-ledger-host] dependencies are required');
  }
  for (const name of ['launch', 'record', 'trust']) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`[turn-ledger-host] dependency missing: ${name}`);
    }
  }
  return deps;
}

function text(value) {
  return typeof value === 'string' ? value : null;
}

function createTurnLedgerHost(options) {
  const deps = assertDependencies(options);

  return async function handle(input) {
    const body = input && typeof input === 'object' ? input : {};
    const sessionId = text(body.sessionId) || '';
    if (body.op === 'ledger') {
      return { ok: true, launch: deps.launch(sessionId) || null, record: deps.record(sessionId) || null };
    }
    if (body.op === 'launch') {
      return { ok: true, launch: deps.launch(sessionId) || null };
    }
    if (body.op === 'trust') {
      // The front door already checked that the launch is a Codex terminal and
      // hands its `codexHome`/`cwd` back, so this call never re-reads the table.
      try {
        const value = await deps.trust({
          write: body.write === true,
          codexHome: text(body.codexHome),
          cwd: text(body.cwd),
        });
        return { ok: true, value };
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) };
      }
    }
    return { ok: false };
  };
}

function mountTurnLedgerHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[turn-ledger-host] Express-compatible app is required');
  }
  const isLocal = typeof options.isLocal === 'function' ? options.isLocal : isLocalRequest;
  const handle = createTurnLedgerHost(options);
  app.post(HOST_PATH, (req, res) => {
    // Loopback only: a request forwarded from a real remote client carries that
    // address in its PROXY line and is refused here.
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    Promise.resolve(handle(req.body)).then(
      answer => res.json(answer),
      error => res.status(500).json({ error: 'turn ledger failed', detail: String((error && error.message) || error) }),
    );
  });
}

module.exports = { mountTurnLedgerHostRoute, createTurnLedgerHost, HOST_PATH };
