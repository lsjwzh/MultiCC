'use strict';

const { getUnlockPassword, getUnlockProbe, getPowerPreferences, readPowerSettings } = require('../host-power-services');
const { MAX_PASSWORD_LENGTH } = require('../macos-unlock-password');

const passwordService = deps => deps.unlockPassword || getUnlockPassword();
const preferencesService = deps => deps.powerPreferences || getPowerPreferences();
async function probeAuthorization(deps, allowUI = false) {
  try { return await (deps.unlockProbe || getUnlockProbe()).probe({ allowUI }); }
  catch { return { state: 'unavailable', detail: 'probe-failed' }; }
}

async function requireUnlockReady(deps, res) {
  if (!(await passwordService(deps).hasPassword())) {
    res.status(409).json({ code: 'unlock_setup_required', error: '请先在这台 Mac 的全局设置中保存登录密码，再开启此功能。' });
    return false;
  }
  const authorization = await probeAuthorization(deps);
  if (authorization.state !== 'authorized') {
    res.status(409).json({ code: 'unlock_authorization_required', authorization,
      error: '自动解锁尚未准备好，请在这台 Mac 的全局设置中点击「检查授权」。' });
    return false;
  }
  return true;
}

// Serialize coupled mutations: a concurrent password removal must not race
// with enabling lid mode, and two clients must not open two system prompts.
function mountPowerWriteRoutes(app, deps) {
  let pending = Promise.resolve();
  const serial = handler => (req, res, next) => {
    const result = pending.then(() => handler(req, res, next));
    pending = result.catch(() => {});
    return result;
  };
  app.post('/api/settings/power', serial(createPowerSettingsHandler(deps)));
  app.post('/api/settings/power/auto-unlock', serial(async (req, res, next) => {
    try {
      if (!deps.macosPower.isAvailable()) return res.status(400).json({ error: 'This setting is only available on macOS' });
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
      const lid = await deps.macosPower.getLidModeSettings();
      if (!enabled && lid.enabled) return res.status(409).json({ error: '关盖运行需要自动解锁。请先关闭「关盖运行」。' });
      if (enabled && !(await requireUnlockReady(deps, res))) return;
      if (!enabled && !(await (deps.unlockProbe || getUnlockProbe()).runtimeReady())) {
        return res.status(409).json({ error: 'MultiCC Agent 尚未更新或未启动，请在这台 Mac 上重启 MultiCC 后再试。' });
      }
      preferencesService(deps).write(enabled);
      return res.json({ ok: true, ...await readPowerSettings(deps, req) });
    } catch (error) { return next(error); }
  }));
  for (const [method, action] of [['post', 'set'], ['delete', 'clear']]) {
    app[method]('/api/settings/power/unlock-password', serial(async (req, res, next) => {
      try {
        if (!deps.isLocalRequest(req)) return res.status(403).json({ error: '请在这台 Mac 上打开全局设置，保存登录密码。' });
        const password = passwordService(deps);
        if (!password.isAvailable()) return res.status(400).json({ error: 'This setting is only available on macOS' });
        if (action === 'clear') {
          const lid = await deps.macosPower.getLidModeSettings();
          if (lid.enabled) return res.status(409).json({ error: '请先关闭「关盖运行」，再删除已保存的密码。' });
          preferencesService(deps).write(false);
          await password.clearPassword();
          return res.json({ ok: true, set: false });
        }
        const value = req.body?.password;
        if (typeof value !== 'string' || !value.length) return res.status(400).json({ error: 'password is required' });
        if (value.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ error: 'password is too long' });
        // Freeze legacy consent before adding a credential. Saving alone does
        // not switch on a feature the user has not finished configuring.
        const preferences = preferencesService(deps);
        preferences.write(preferences.read(await password.hasPassword()));
        await password.setPassword(value);
        return res.json({ ok: true, set: true, authorization: await probeAuthorization(deps, true) });
      } catch (error) { return next(error); }
    }));
  }
  app.post('/api/settings/power/unlock-password/authorize', serial(async (req, res, next) => {
    try {
      if (!deps.isLocalRequest(req)) return res.status(403).json({ error: '仅可在本机检查授权' });
      const authorization = await passwordService(deps).hasPassword()
        ? await probeAuthorization(deps, true) : { state: 'no-password' };
      return res.json({ ok: true, authorization });
    } catch (error) { return next(error); }
  }));
}

function createPowerSettingsHandler(deps) {
  return async (req, res, next) => {
    try {
      if (!deps.macosPower.isAvailable()) return res.status(400).json({ error: 'This setting is only available on macOS' });
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
      if (enabled && !(await requireUnlockReady(deps, res))) return;
      await deps.macosPower.setLidSleepPrevention(enabled);
      return res.json({ ok: true, ...await readPowerSettings(deps, req) });
    } catch (error) { return next(error); }
  };
}

module.exports = { createPowerSettingsHandler, mountPowerWriteRoutes };
