'use strict';

// GET  /api/ark/quota        — fetch Volcano Ark (火山方舟) subscription quota by
//                                shelling out to the official `arkcli` CLI
//                                (`arkcli usage plan --format json`).
// POST /api/ark/quota/login  — spawn `arkcli auth login volc-sso` detached so the
//                                user's browser opens the Volc SSO flow; the CLI
//                                persists the credential for subsequent queries.
// POST /api/ark/quota/install — install arkcli globally via npm for the user.
//
// arkcli is NOT assumed to be present. We resolve it from $ARKCLI_BIN or PATH;
// if absent we return `needs_install` (rather than silently shelling out to
// `npx`, whose first-run download is slow and opaque) so the frontend can offer
// a one-click install.
//
// On logical failure arkcli exits non-zero and writes its JSON error object to
// stderr (success JSON goes to stdout), so we parse both streams and key off the
// `ok` field rather than the exit code. Failure modes surfaced to the frontend:
//   needs_install — arkcli binary not found (user can click to install via npm)
//   needs_auth    — CLI present but no Volc SSO credential (click to log in)
//   unavailable   — any other error / unexpected shape

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { renderQuotaBar } = require('../quota/quota-bar-view');

const TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 240000;
const ARKCLI_PACKAGE = '@volcengine/ark-cli';
const AUTH_RE = /not configured|auth login|volc-sso|\bsso\b|refresh_token|\.arkcli|logged_in|unauthoriz|credential/i;

let cachedBin = null;

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      // keep searching
    }
  }
  return null;
}

// Returns { cmd, prefix } or null. Only successful resolutions are cached so a
// binary installed after a `needs_install` is picked up on the next call.
function resolveArkcliBin() {
  if (cachedBin) return cachedBin;
  let found = null;
  if (process.env.ARKCLI_BIN) {
    found = { cmd: process.env.ARKCLI_BIN, prefix: [] };
  } else {
    const onPath = findOnPath('arkcli');
    if (onPath) found = { cmd: onPath, prefix: [] };
  }
  if (found) cachedBin = found;
  return found;
}

function runArkcli(args) {
  const bin = resolveArkcliBin();
  if (!bin) return Promise.resolve({ err: Object.assign(new Error('arkcli not found'), { code: 'ENOENT' }), stdout: '', stderr: '' });
  return new Promise((resolve) => {
    execFile(
      bin.cmd,
      [...bin.prefix, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

function installArkcli() {
  return new Promise((resolve) => {
    const npm = findOnPath('npm');
    if (!npm) {
      resolve({ ok: false, error: '未找到 npm，无法自动安装。请手动安装 Node.js 后重试，或自行安装 @volcengine/ark-cli。' });
      return;
    }
    execFile(
      npm,
      ['install', '-g', ARKCLI_PACKAGE],
      { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').trim().split('\n').slice(0, 3).join(' ');
          resolve({ ok: false, error: `npm install -g ${ARKCLI_PACKAGE} 失败：${detail || '未知错误'}` });
          return;
        }
        cachedBin = null; // re-resolve so the freshly installed binary is found
        resolve({ ok: true });
      },
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

// arkcli appends non-JSON chatter to the stream after its payload — e.g. the
// "arkcli X.Y available" upgrade notice on stderr — so JSON.parse(wholeStream)
// fails precisely on the error path, and a missing login was being misreported
// as a bare `unavailable` instead of the actionable `needs_auth`. Extract the
// first balanced {...} object instead (string-aware, so braces inside JSON
// strings don't end the scan early).
function parseArkcliJsonStream(stream) {
  const s = String(stream || '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchArkUsage(nowMs = Date.now()) {
  const { err, stdout, stderr } = await runArkcli(['usage', 'plan', '--format', 'json']);

  let parsed = null;
  for (const stream of [stdout, stderr]) {
    if (!stream.trim()) continue;
    const candidate = parseArkcliJsonStream(stream);
    if (candidate && typeof candidate === 'object') {
      parsed = candidate;
      break;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    if (err && err.code === 'ENOENT') {
      return { status: 'needs_install', error: 'arkcli not found on PATH' };
    }
    return { status: 'unavailable', error: (stderr || (err && err.message) || 'no output').slice(0, 300) };
  }

  if (parsed.ok === false) {
    const msg = (parsed.error && parsed.error.message) || 'unknown error';
    if (AUTH_RE.test(msg) || AUTH_RE.test(stderr)) {
      // Say what the user must do — a bare "unavailable" hides that this is
      // just a missing login, fixable with one command / the login button.
      return { status: 'needs_auth', error: `需要先运行 arkcli auth login 登录火山账号后再查询（${msg}）` };
    }
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
      const httpStatus = status === 'ok' ? 200
        : status === 'needs_auth' ? 401
        : status === 'needs_install' ? 404
        : 500;
      // The bar is rendered here, once, so the web and the app display the same
      // string. `baseUrl` is the one thing only the caller knows — which Ark
      // plan the session it is looking at actually routes through — so the
      // caller passes it in rather than re-picking the plan itself.
      const baseUrl = typeof req.query?.baseUrl === 'string' ? req.query.baseUrl : '';
      res.status(httpStatus).json({ ...result, bar: renderQuotaBar('ark', result, { baseUrl }) });
    } catch (_) {
      const result = { status: 'unavailable', error: 'ark quota fetch failed' };
      res.status(500).json({ ...result, bar: renderQuotaBar('ark', result) });
    }
  });

  app.post('/api/ark/quota/login', (req, res) => {
    const bin = resolveArkcliBin();
    if (!bin) {
      res.status(404).json({ status: 'needs_install', error: 'arkcli not found on PATH' });
      return;
    }
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

  app.post('/api/ark/quota/install', async (req, res) => {
    try {
      const result = await installArkcli();
      if (result.ok) {
        res.json({ status: 'ok' });
      } else {
        res.status(500).json({ status: 'error', error: result.error });
      }
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message || 'install failed' });
    }
  });
}

module.exports = { mountArkQuotaRoutes, fetchArkUsage, resolveArkcliBin, installArkcli, parseArkcliJsonStream };
