'use strict';

// Kimi Code native-auth management routes (device-code login + status).
// Public DTOs intentionally exclude credentials, local paths, raw child
// output, and the OAuth verification URL (the managed browser opens it
// directly; it is never echoed to clients).

const LOGIN_WAIT_MS = 5 * 60 * 1000;
const URL_CAPTURE_MS = 30 * 1000;

function assertApp(app) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.put !== 'function') {
    throw new TypeError('[kimi-auth] Express-compatible app is required');
  }
  return app;
}

function authStatusDto(status) {
  const value = status && typeof status === 'object' ? status : {};
  return {
    configured: value.configured === true,
    hasKey: value.hasKey === true,
    source: ['none', 'env_key', 'credentials'].includes(value.source)
      ? value.source
      : 'none',
  };
}

function mountKimiAuthRoutes(app, deps = {}) {
  assertApp(app);
  const kimiAuth = deps.kimiAuth || require('../cli-adapters/kimi-auth');
  const getBrowser = deps.getBrowser
    || (() => require('../quota-managed-browser').getManagedQuotaBrowser());
  const loginWaitMs = Number.isFinite(deps.loginWaitMs) ? deps.loginWaitMs : LOGIN_WAIT_MS;
  const urlCaptureMs = Number.isFinite(deps.urlCaptureMs) ? deps.urlCaptureMs : URL_CAPTURE_MS;

  // GET /api/kimi/auth — current native auth status
  app.get('/api/kimi/auth', (req, res) => {
    try {
      res.json({
        ok: true,
        ...authStatusDto(kimiAuth.getKimiAuthStatus()),
        loginAvailable: kimiAuth.isKimiLoginAvailable(),
      });
    } catch (_) {
      res.status(500).json({ error: 'kimi auth status failed' });
    }
  });

  // GET /api/kimi/auth/check — pre-check for session creation / turn admission
  app.get('/api/kimi/auth/check', (req, res) => {
    try {
      const result = kimiAuth.ensureKimiAuth(null);
      if (result && result.ok) {
        res.json({ ok: true, source: result.source });
      } else {
        res.json({
          ok: false,
          code: 'configuration_required',
          message: result && result.message,
          loginAvailable: !!(result && result.loginAvailable),
        });
      }
    } catch (_) {
      res.status(500).json({ ok: false, code: 'check_failed', message: 'Kimi 配置检查失败' });
    }
  });

  // PUT /api/kimi/auth — L2: manually set API key (provider-less native auth).
  app.put('/api/kimi/auth', (req, res) => {
    try {
      const apiKey = (req.body.apiKey || '').trim();
      const baseURL = (req.body.baseURL || '').trim() || undefined;
      if (!apiKey) {
        return res.status(400).json({ error: 'apiKey is required' });
      }
      const result = kimiAuth.setKimiApiKey(apiKey, { baseURL });
      res.json({ ok: true, ...result });
    } catch (_) {
      res.status(400).json({ error: 'Kimi API Key 配置失败' });
    }
  });

  // POST /api/kimi/auth/login — spawn `kimi login` (device-code flow).
  // When the CLI emits the verification URL we open it in the managed VISIBLE
  // browser (shared quota profile keeps the vendor login alive); a user who is
  // already logged in on the web only needs to confirm. The route resolves when
  // the CLI exits (0 = token stored) or after loginWaitMs.
  app.post('/api/kimi/auth/login', (req, res) => {
    try {
      if (!kimiAuth.isKimiLoginAvailable()) {
        return res.status(400).json({
          ok: false,
          code: 'cli_not_found',
          message: '未找到 kimi CLI。请先安装：npm install -g @moonshot-ai/kimi-code',
        });
      }
      let child;
      try {
        child = kimiAuth.spawnKimiLogin();
      } catch (_) {
        return res.status(500).json({ ok: false, code: 'spawn_error', message: '无法启动 kimi login' });
      }
      let resolved = false;
      let urlOpened = false;
      let stderrTail = '';

      const finish = (payload, status = 200) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        res.status(status).json(payload);
      };

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (_) {}
        finish({
          ok: true,
          code: 'login_timeout',
          browserOpened: urlOpened,
          message: '登录已启动但超时未完成。如果浏览器窗口已打开，请在其中完成授权后重试。',
        });
      }, loginWaitMs);
      if (timer.unref) timer.unref();

      // Capture the verification URL from stderr, then hand it to the managed
      // visible browser once. Raw output is bounded and never returned.
      const urlTimer = setTimeout(() => {
        if (child.stderr && typeof child.stderr.pause === 'function') {
          try { child.stderr.pause(); } catch (_) {}
        }
      }, urlCaptureMs);
      if (urlTimer.unref) urlTimer.unref();

      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + String(chunk)).slice(-8192);
          const url = kimiAuth.parseKimiLoginVerificationUrl(stderrTail);
          if (!url || urlOpened || resolved) return;
          urlOpened = true;
          Promise.resolve()
            .then(() => getBrowser().openVisibleLogin(url))
            .catch(() => { urlOpened = false; /* best effort; CLI also tries openUrl */ });
        });
      }

      child.on('close', (code) => {
        if (code === 0) {
          finish({
            ok: true,
            code: 'login_success',
            browserOpened: urlOpened,
            ...authStatusDto(kimiAuth.getKimiAuthStatus()),
          });
        } else {
          finish({
            ok: false,
            code: 'login_failed',
            exitCode: Number.isInteger(code) ? code : null,
            message: 'Kimi 登录失败，请重试或在浏览器中手动完成授权。',
          });
        }
      });
      child.on('error', () => {
        finish({ ok: false, code: 'spawn_error', message: '无法启动 kimi login 流程' }, 500);
      });
    } catch (_) {
      res.status(500).json({ error: 'kimi login failed' });
    }
  });
}

module.exports = { mountKimiAuthRoutes };
