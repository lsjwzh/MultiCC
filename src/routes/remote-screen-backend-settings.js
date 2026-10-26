'use strict';

// 「🖥 屏幕」后端选择：rust（独立进程 multicc-remote，默认）或 node（迁移前的回退实现）。
// 语义与 CPR 后端开关一致：Rust 校验选择并生成状态，Node 只负责收集宿主事实和落盘。
// 不修改 process.env、不热切换当前进程已加载的实现、也不触发重启 —— 保存后必须手动重启。
const fs = require('node:fs');

function mountRemoteScreenBackendSettingsRoutes(app, options = {}) {
  const host = require('../host-env');
  const readEnvFile = options.readEnvFile || host.readEnvFile;
  const writeEnvFile = options.writeEnvFile || host.writeEnvFile;
  // 测试注入；生产每次请求解析同一个原生模块（重建后无需重启）。
  const getNative = options.getNative || (() => require('../native/runtime').getNative('remote_screen'));
  const env = options.env || process.env;

  // 只解析二进制路径，绝不启动远控进程。
  function rustAvailable() {
    if (typeof options.rustAvailable === 'function') return options.rustAvailable() === true;
    try {
      const binary = require('../remote-screen-rust')._remoteBinary();
      return !!binary && fs.existsSync(binary);
    } catch (_) { return false; }
  }
  // Node 回退版的 P2P 依赖 werift；装不上就没有完整回退能力。
  function nodeAvailable() {
    if (typeof options.nodeAvailable === 'function') return options.nodeAvailable() === true;
    try { require.resolve('werift'); return true; } catch (_) { return false; }
  }
  // 实际生效的后端（启动时由选择层决定），不是配置文件里的目标值。
  function currentBackend() {
    if (options.currentBackend != null) return options.currentBackend;
    try { return require('../remote-screen').backend || 'rust'; } catch (_) { return 'rust'; }
  }

  function handler(save) {
    return (req, res) => {
      try {
        const native = getNative();
        if (typeof native?.remoteScreenBackendSettings !== 'function') {
          return res.status(503).json({ error: '远程屏幕设置接口尚未就绪，请更新原生模块并手动重启服务' });
        }
        const result = JSON.parse(native.remoteScreenBackendSettings(JSON.stringify({
          action: save ? 'save' : 'read', currentBackend: currentBackend(),
          configuredBackend: readEnvFile().MULTICC_REMOTE_SCREEN_BACKEND ?? env.MULTICC_REMOTE_SCREEN_BACKEND,
          requestedBackend: req.body?.backend,
          rustAvailable: rustAvailable(), nodeAvailable: nodeAvailable(),
        })));
        const { updates, status, ...view } = result;
        if (status !== 200) return res.status(status).json(view);
        if (save) writeEnvFile(updates);
        return res.json({ ok: true, ...view });
      } catch (_) {
        return res.status(503).json({ error: '无法读取或保存远程屏幕设置，请检查配置文件和原生模块后重试' });
      }
    };
  }
  app.get('/api/settings/remote-screen-backend', handler(false));
  app.post('/api/settings/remote-screen-backend', handler(true));
}

module.exports = { mountRemoteScreenBackendSettingsRoutes };
