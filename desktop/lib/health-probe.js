'use strict';

// Readiness gate for the desktop shell. The window must not show the web UI
// (or a misleading "Connecting…" error) before the server reports /readyz 200
// — the same signal CI/process managers use (src/health.js: readyz flips to
// 200 only once serviceReady && !shuttingDown && commander migration settled).

const DEFAULT_READY_PATH = '/readyz';

function isReadyStatus(status) {
  return status === 200;
}

// A first boot after upgrading may convert the task database before serving
// (src/task-shell/migration-gate.js). Its stand-in answers 503 with
// phase:'data-migration' and progress; while that keeps moving the deadline is
// pushed out, up to this cap, so a slow machine is not killed mid-migration.
const MIGRATION_TIMEOUT_MS = 30 * 60_000;

async function readMigration(res) {
  try {
    if (!/json/.test(res.headers?.get?.('content-type') || '')) return null;
    const body = await res.json();
    return body && body.phase === 'data-migration' && body.migration ? body.migration : null;
  } catch (_) { return null; }
}

// Poll `${origin}${path}` every intervalMs until it answers 200 or timeoutMs
// elapses. Connection-refused / 503 answers during boot are expected and keep
// the poller running; only a timeout (or a failed data migration) rejects.
async function waitForReadiness({
  origin,
  path: readyPath = DEFAULT_READY_PATH,
  fetchImpl = fetch,
  intervalMs = 400,
  timeoutMs = 90_000,
  migrationTimeoutMs = MIGRATION_TIMEOUT_MS,
  onMigration,
  signal,
} = {}) {
  if (!origin) throw new TypeError('[desktop] waitForReadiness requires origin');
  const url = `${origin.replace(/\/$/, '')}${readyPath}`;
  const startedAt = Date.now();
  let deadline = startedAt + timeoutMs;
  let lastError = null;

  for (;;) {
    if (signal && signal.aborted) {
      const error = new Error('readiness probe aborted');
      error.code = 'READY_ABORTED';
      throw error;
    }
    if (Date.now() >= deadline) {
      const error = new Error(`server not ready within ${Math.round(timeoutMs / 1000)}s (${lastError || 'no response'})`);
      error.code = 'READY_TIMEOUT';
      throw error;
    }
    try {
      const res = await fetchImpl(url, { cache: 'no-store', signal });
      if (isReadyStatus(res.status)) {
        // Drain the body so the socket is reusable / cleanly closed.
        try { await res.arrayBuffer(); } catch (_) {}
        return { url, status: res.status };
      }
      lastError = `HTTP ${res.status}`;
      const migration = await readMigration(res);
      try { await res.arrayBuffer(); } catch (_) {}
      if (migration && migration.state === 'failed' && !(migration.error && migration.error.retrying)) {
        const error = new Error(`task data upgrade failed: ${(migration.error && migration.error.message) || 'unknown'}`);
        error.code = 'DATA_MIGRATION_FAILED';
        error.migration = migration;
        throw error;
      }
      if (migration) {
        lastError = `data migration ${migration.state === 'failed' ? 'waiting for disk space' : `${migration.percent}%`}`;
        deadline = Math.max(deadline, Math.min(Date.now() + timeoutMs, startedAt + migrationTimeoutMs));
        if (typeof onMigration === 'function') { try { onMigration(migration); } catch (_) {} }
      }
    } catch (cause) {
      if (cause && cause.code === 'DATA_MIGRATION_FAILED') throw cause;
      // ECONNREFUSED while the child boots — keep polling.
      lastError = cause && cause.code ? cause.code : (cause && cause.message) || 'fetch failed';
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

module.exports = { DEFAULT_READY_PATH, MIGRATION_TIMEOUT_MS, waitForReadiness, isReadyStatus };
