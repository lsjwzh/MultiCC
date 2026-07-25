'use strict';

// ZCode auth management routes.
// Provides L1-L4 endpoints for managing ZCode API key configuration.

function assertApp(app) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('[zcode-auth] Express-compatible app is required');
  }
  return app;
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
        baseURL: desktopKeys[id].baseURL,
        hasKey: true,
      }));
      res.json({
        ...status,
        loginAvailable: zcodeAuth.isZcodeLoginAvailable(),
        desktopProviders,
        cliConfigPath: zcodeAuth.CLI_CONFIG_PATH,
        desktopConfigPath: zcodeAuth.DESKTOP_CONFIG_PATH,
      });
    } catch (error) {
      res.status(500).json({ error: 'zcode auth status failed', detail: error.message });
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
    } catch (error) {
      res.status(500).json({ error: 'zcode auth sync failed', detail: error.message });
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
    } catch (error) {
      res.status(400).json({ error: error.message });
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
      let stdout = '';
      let stderr = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { child.kill('SIGTERM'); } catch (_) {}
          res.json({
            ok: true,
            code: 'login_timeout',
            message: '登录已启动但超时未完成。如果浏览器已打开，请在浏览器中完成授权。',
            stdout: stdout.slice(-500),
            stderr: stderr.slice(-500),
          });
        }
      }, 300000); // 5 min timeout

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

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
            ...status,
          });
        } else {
          res.json({
            ok: false,
            code: 'login_failed',
            exitCode: code,
            message: 'ZCode 登录失败。',
            stdout: stdout.slice(-500),
            stderr: stderr.slice(-500),
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
          message: err.message,
        });
      });
    } catch (error) {
      res.status(500).json({ error: 'zcode login failed', detail: error.message });
    }
  });

  // GET /api/zcode/auth/check -- L4: pre-check for session creation/turn admission
  app.get('/api/zcode/auth/check', (req, res) => {
    try {
      const result = zcodeAuth.ensureZcodeAuth();
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, code: 'check_failed', message: error.message });
    }
  });
}

module.exports = { mountZcodeAuthRoutes };
