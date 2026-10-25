'use strict';

// 迁移桥接：Rust 校验选择和生成状态，复用宿主已有的原子配置文件接口持久化。
// 不修改 process.env、不热切换正在挂载的代理，也不触发服务重启。
function mountCprBackendSettingsRoutes(app, options = {}) {
  const host = require('../host-env');
  const readEnvFile = options.readEnvFile || host.readEnvFile;
  const writeEnvFile = options.writeEnvFile || host.writeEnvFile;
  const nativeModule = options.getNative || (() => require('../native/runtime').getNative('cpr'));
  const currentBackend = options.runtime?.proxyBackend || 'rust';
  const env = options.env || process.env;

  function handler(save) {
    return (req, res) => {
      try {
        const native = nativeModule();
        if (typeof native?.cprBackendSettings !== 'function') {
          return res.status(503).json({ error: 'CPR 设置接口尚未就绪，请更新原生模块并手动重启服务' });
        }
        const result = JSON.parse(native.cprBackendSettings(JSON.stringify({
          action: save ? 'save' : 'read', currentBackend,
          configuredBackend: readEnvFile().MULTICC_CPR_BACKEND ?? env.MULTICC_CPR_BACKEND,
          requestedBackend: req.body?.backend,
          rustAvailable: native.cprProtocolVersion?.() === 1
            && ['cprRoute', 'cprPrepare', 'cprCreateExchange'].every(name => typeof native[name] === 'function'),
        })));
        const { updates, status, ...view } = result;
        if (status !== 200) return res.status(status).json(view);
        if (save) writeEnvFile(updates);
        return res.json({ ok: true, ...view });
      } catch (_) {
        return res.status(503).json({ error: '无法读取或保存 CPR 设置，请检查配置文件和原生模块后重试' });
      }
    };
  }
  app.get('/api/settings/cpr-backend', handler(false));
  app.post('/api/settings/cpr-backend', handler(true));
}

module.exports = { mountCprBackendSettingsRoutes };
