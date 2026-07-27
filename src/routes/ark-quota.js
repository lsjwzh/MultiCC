'use strict';

// GET  /api/ark/quota       — fetch Volcano Ark (火山方舟) subscription quota by
//                               shelling out to the official `arkcli` CLI
//                               (`arkcli usage plan --format json`).
// POST /api/ark/quota/login — spawn `arkcli auth login volc-sso` detached so the
//                               user's browser opens the Volc SSO flow; the CLI
//                               persists the credential for subsequent queries.
//
// On logical failure arkcli exits non-zero and writes its JSON error object to
// stderr (success JSON goes to stdout), so we parse both streams and key off the
// `ok` field rather than the exit code. Failure modes surfaced to the frontend:
//   needs_auth   — CLI present but no Volc SSO credential (user must click login)
//   cli_missing  — arkcli binary not found on PATH (and npx fallback unavailable)
//   unavailable  — any other error / unexpected shape

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const TIMEOUT_MS = 45000;
const AUTH_RE = /not configured|auth login|volc-sso|\bsso\b|refresh_token|\.arkcli|logged_in|unauthoriz|credential/i;

let cachedBin = null;

function resolveArkcliBin() {
  if (cachedBin) return cachedBin;
  if (process.env.ARKCLI_BIN) {
    cachedBin = { cmd: process.env.ARKCLI_BIN, prefix: [] };
    return cachedBin;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'arkcli');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedBin = { cmd: candidate, prefix: [] };
      return cachedBin;
    } catch (_) {
      // keep searching
    }
  }
  cachedBin = { cmd: 'npx', prefix: ['--yes', '@volcengine/ark-cli'] };
  return cachedBin;
}

function runArkcli(args) {
  const bin = resolveArkcliBin();
  return new Promise((resolve) => {
    execFile(
      bin.cmd,
      [...bin.prefix, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizePeriod(p) {
  if (!p || typeof p !== 'object') return null;
  let resetAt = null;
  if (typeof p.reset_at === 'string') {
    const ms = Date.parse(p.reset_at);
    resetAt = Number.isFinite(ms) ? ms : null;
  } else {
    resetAt = finite(p.reset_at);
  }
  return {
    label: String(p.label || ''),
    used: finite(p.used),
    total: finite(p.total),
    percent: finite(p.percent),
    resetAt,
  };
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    product: String(item.product || ''),
    edition: String(item.edition || ''),
    tier: item.tier ? String(item.tier) : null,
    seatId: item.seat_id ? String(item.seat_id) : null,
    subscribed: item.subscribed === true,
    error: item.error ? String(item.error) : null,
    periods: Array.isArray(item.periods) ? item.periods.map(normalizePeriod).filter(Boolean) : [],
  };
}

async function fetchArkUsage(nowMs = Date.now()) {
  const { err, stdout, stderr } = await runArkcli(['usage', 'plan', '--format', 'json']);

  let parsed = null;
  for (const stream of [stdout, stderr]) {
    if (!stream.trim()) continue;
    try {
      const candidate = JSON.parse(stream);
      if (candidate && typeof candidate === 'object') {
        parsed = candidate;
        break;
      }
    } catch (_) {
      // try next stream
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    if (err && err.code === 'ENOENT') {
      return { status: 'cli_missing', error: 'arkcli not found (install @volcengine/ark-cli)' };
    }
    return { status: 'unavailable', error: (stderr || (err && err.message) || 'no output').slice(0, 300) };
  }

  if (parsed.ok === false) {
    const msg = (parsed.error && parsed.error.message) || 'unknown error';
    if (AUTH_RE.test(msg) || AUTH_RE.test(stderr)) return { status: 'needs_auth', error: msg };
    return { status: 'unavailable', error: msg };
  }

  if (!Array.isArray(parsed.items)) return { status: 'unavailable', error: 'items missing' };

  return {
    status: 'ok',
    fetchedAt: nowMs,
    viewer: parsed.viewer && typeof parsed.viewer === 'object' ? parsed.viewer : null,
    items: parsed.items.map(normalizeItem).filter(Boolean),
  };
}

function mountArkQuotaRoutes(app) {
  if (!app || typeof app.get !== 'function') return;

  app.get('/api/ark/quota', async (req, res) => {
    try {
      const result = await fetchArkUsage();
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200 : status === 'needs_auth' ? 401 : 500;
      res.status(httpStatus).json(result);
    } catch (_) {
      res.status(500).json({ status: 'unavailable', error: 'ark quota fetch failed' });
    }
  });

  app.post('/api/ark/quota/login', (req, res) => {
    const bin = resolveArkcliBin();
    try {
      const child = spawn(bin.cmd, [...bin.prefix, 'auth', 'login', 'volc-sso'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
      res.json({ status: 'started', pid: child.pid || null });
    } catch (err) {
      res.status(500).json({ status: 'unavailable', error: err.message || 'spawn failed' });
    }
  });
}

module.exports = { mountArkQuotaRoutes, fetchArkUsage, resolveArkcliBin };
