'use strict';

// Readiness gate for the desktop shell. The window must not show the web UI
// (or a misleading "Connecting…" error) before the server reports /readyz 200
// — the same signal CI/process managers use (src/health.js: readyz flips to
// 200 only once serviceReady && !shuttingDown && commander migration settled).

const DEFAULT_READY_PATH = '/readyz';

function isReadyStatus(status) {
  return status === 200;
}

// Poll `${origin}${path}` every intervalMs until it answers 200 or timeoutMs
// elapses. Connection-refused / 503 answers during boot are expected and keep
// the poller running; only a timeout rejects.
async function waitForReadiness({
  origin,
  path: readyPath = DEFAULT_READY_PATH,
  fetchImpl = fetch,
  intervalMs = 400,
  timeoutMs = 90_000,
  signal,
} = {}) {
  if (!origin) throw new TypeError('[desktop] waitForReadiness requires origin');
  const url = `${origin.replace(/\/$/, '')}${readyPath}`;
  const deadline = Date.now() + timeoutMs;
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
      try { await res.arrayBuffer(); } catch (_) {}
    } catch (cause) {
      // ECONNREFUSED while the child boots — keep polling.
      lastError = cause && cause.code ? cause.code : (cause && cause.message) || 'fetch failed';
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

module.exports = { DEFAULT_READY_PATH, waitForReadiness, isReadyStatus };
