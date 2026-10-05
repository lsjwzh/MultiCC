'use strict';

const { getPowerPreferences } = require('./host-power-services');
const { createPowerd } = require('./powerd');

async function readConsent(status) {
  return status.unlockPassword === true
    && (getPowerPreferences().read(true) || createPowerd().readIntent() === 'on');
}

const messages = {
  'auto-unlock-disabled': '请先在全局设置中开启“允许自动解锁”。',
  'permissions-required': '请先在这台 Mac 上为 MultiCC Agent 开启辅助功能和屏幕录制权限。',
  'user-stopped': '本机已按 Esc 急停，请先确认并解除急停。',
  'no-password': '尚未保存登录密码，请在这台 Mac 的全局设置中完成自动解锁配置。',
  'password-needs-authorization': '请先在这台 Mac 的全局设置中完成钥匙串授权。',
  'password-unreadable': '无法读取已保存的登录密码，请在本机检查自动解锁配置。',
  'no-password-field': '暂未找到锁屏密码框，请稍后手动重试。',
  'desktop-busy': '另一个会话正在操作电脑，请稍后再试。',
  busy: '正在唤起屏幕，请等待当前操作结束。',
};

function mountWakeRoutes(app, { call, wakeDisplay, invalidate, consent = readConsent }) {
  let waking = false;
  async function state() {
    const status = await call({ op: 'status', session: 'remote-screen' }, 3000);
    if (status?.ok !== true || typeof status.screenLocked !== 'boolean') throw new Error('状态不可用');
    const enabled = await consent(status);
    const busy = status.control?.leaseHolder && status.control.leaseHolder !== 'remote-screen';
    const permissions = status.accessibility === true && status.screenRecording === true;
    return { ok: true, screenLocked: status.screenLocked, autoUnlockEnabled: enabled,
      canWake: enabled && permissions && !busy && status.control?.halted !== true,
      reason: !enabled ? 'auto-unlock-disabled' : !permissions ? 'permissions-required'
        : status.control?.halted === true ? 'user-stopped' : busy ? 'desktop-busy' : null };
  }
  const fail = (res, code, status = 409) => res.status(status).json({ ok: false, error: code,
    message: messages[code] || '未能确认屏幕已解锁，请检查本机状态后手动重试。' });
  app.get('/api/remote-screen/wake', async (_req, res) => {
    res.set({ 'Cache-Control': 'no-store' });
    try { const value = await state(); res.json({ ...value, message: messages[value.reason] || '' }); }
    catch { fail(res, 'agent-unavailable', 503); }
  });
  app.post('/api/remote-screen/wake', async (_req, res) => {
    if (waking) return fail(res, 'busy');
    waking = true;
    try {
      const before = await state();
      if (!before.canWake) return fail(res, before.reason);
      await wakeDisplay();
      if (before.screenLocked) {
        const result = await call({ op: 'unlock', session: 'remote-screen' }, 20000);
        if (result?.ok !== true) return fail(res, result?.reason || result?.error || 'unlock-failed');
      }
      const after = await state();
      if (after.screenLocked) return fail(res, 'still-locked');
      invalidate();
      return res.json({ ...after, message: '屏幕已唤起，正在恢复画面。' });
    } catch { return fail(res, 'agent-unavailable', 503); }
    finally { waking = false; }
  });
}
module.exports = { mountWakeRoutes };
