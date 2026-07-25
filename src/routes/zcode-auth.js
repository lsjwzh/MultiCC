'use strict';

// ZCode native-auth management routes. Public DTOs intentionally exclude
// credentials, local paths, raw child output, and OAuth URLs.

function assertApp(app) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('[zcode-auth] Express-compatible app is required');
  }
  return app;
}

function boundedText(value, max) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  return text.slice(0, max);
}

function authStatusDto(status) {
  const value = status && typeof status === 'object' ? status : {};
  return {
    configured: value.configured === true,
    provider: boundedText(value.provider, 160) || null,
    hasKey: value.hasKey === true,
    source: ['none', 'cli_config', 'desktop_available'].includes(value.source)
      ? value.source
      : 'none',
    kind: ['anthropic', 'openai-compatible', 'openai'].includes(value.kind)
      ? value.kind
      : null,
    model: boundedText(value.model, 240) || null,
  };
}

function mountZcodeAuthRoutes(app, deps = {}) {
  assertApp(app);
  const zcodeAuth = deps.zcodeAuth || require('../cli-adapters/zcode-auth');

  // GET /api/zcode/auth -- get current auth status
  app.get('/api/zcode/auth', (req, res) => {
    try {
      const status = zcodeAuth.getZcodeAuthStatus();
      const desktopKeys = zcodeAuth.detectDesktopApiKeys();
      const desktopProviders = Object.keys(desktopKeys).map(id => ({
        id,
        hasKey: true,
      }));
      res.json({
        ...authStatusDto(status),
        loginAvailable: zcodeAuth.isZcodeLoginAvailable(),
        desktopProviders,
      });
    } catch (_) {
      res.status(500).json({ error: 'zcode auth status failed' });
    }
  });

  // POST /api/zcode/auth/sync -- L1: sync desktop API key to CLI config
  app.post('/api/zcode/auth/sync', (req, res) => {
    try {
      const result = zcodeAuth.syncDesktopKeyToCli();
      if (result.synced) {
        res.json({ ok: true, ...result });
      } else {
        res.status(400).json({
          ok: false,
          code: result.reason || 'sync_failed',
          message: '未在 ZCode 桌面端配置中检测到 API Key。请先在桌面端设置 API Key，或手动填写。',
        });
      }
    } catch (_) {
      res.status(500).json({ error: 'zcode auth sync failed' });
    }
  });

  // PUT /api/zcode/auth -- L2: manually set API key
  app.put('/api/zcode/auth', (req, res) => {
    try {
      const providerId = (req.body.providerId || '').trim();
      const apiKey = (req.body.apiKey || '').trim();
      const baseURL = (req.body.baseURL || '').trim() || undefined;
      if (!providerId || !apiKey) {
        return res.status(400).json({ error: 'providerId and apiKey are required' });
      }
      const result = zcodeAuth.setZcodeApiKey(providerId, apiKey, { baseURL });
      res.json({ ok: true, ...result });
    } catch (_) {
      res.status(400).json({ error: 'invalid ZCode API key configuration' });
    }
  });

  // POST /api/zcode/auth/login -- L3: spawn 'zcode login' for OAuth
  app.post('/api/zcode/auth/login', (req, res) => {
    try {
      if (!zcodeAuth.isZcodeLoginAvailable()) {
        return res.status(400).json({
          ok: false,
          code: 'engine_not_found',
          message: 'ZCode 引擎未安装。请先安装 ZCode 桌面版。',
        });
      }
      const child = zcodeAuth.spawnZcodeLogin();
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { child.kill('SIGTERM'); } catch (_) {}
          res.json({
            ok: true,
            code: 'login_timeout',
            message: '登录已启动但超时未完成。如果浏览器已打开，请在浏览器中完成授权。',
          });
        }
      }, 300000); // 5 min timeout

      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        if (code === 0) {
          // Login succeeded -- verify the key was written
          const status = zcodeAuth.getZcodeAuthStatus();
          res.json({
            ok: true,
            code: 'login_success',
            ...authStatusDto(status),
          });
        } else {
          res.json({
            ok: false,
            code: 'login_failed',
            exitCode: Number.isInteger(code) ? code : null,
            message: 'ZCode 登录失败。',
          });
        }
      });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        res.status(500).json({
          ok: false,
          code: 'spawn_error',
          message: '无法启动 ZCode 官方登录流程。',
        });
      });
    } catch (_) {
      res.status(500).json({ error: 'zcode login failed' });
    }
  });

  // GET /api/zcode/auth/check -- L4: pre-check for session creation/turn admission
  app.get('/api/zcode/auth/check', (req, res) => {
    try {
      const result = zcodeAuth.ensureZcodeAuth();
      if (result && result.ok) {
        res.json({
          ok: true,
          provider: boundedText(result.provider, 160) || null,
          source: ['cli_config', 'multicc_provider'].includes(result.source)
            ? result.source
            : 'cli_config',
        });
      } else {
        res.json({
          ok: false,
          code: 'configuration_required',
          message: 'ZCode 原生连接尚未配置。请选择 MultiCC Provider，或配置 Z.ai Coding Plan / API Key。',
        });
      }
    } catch (_) {
      res.status(500).json({ ok: false, code: 'check_failed', message: 'ZCode 配置检查失败' });
    }
  });
}

module.exports = { mountZcodeAuthRoutes };
