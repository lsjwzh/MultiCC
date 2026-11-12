'use strict';

// 系统路由的 Node 侧只剩发布资产一族（APK / iOS OTA）与四组宿主修复面板。
// 这三条已经迁进 Rust 前门（native/gateway/src/app/system.rs，规则在
// multicc_core::system_info，逐字节对比在
// docs/rust-migration/differential/system-scan.js）：
//
//   GET /api/server-info             网卡排序、DTO 组装 → Rust；进程事实经
//                                    src/routes/system-host.js 宿主端口
//   GET /api/version-check           GitHub 发现、tag 选择、DTO → Rust；
//                                    git ls-remote 回退经宿主端口（repo-actor
//                                    独占 git 环境）
//   GET /api/debug/codex-proxy-trace limit 语义 → Rust；环形缓冲留在 Node
//
// 退役前的实现冻结在 tests/helpers/legacy-system-scan-routes.js，供差分使用。

const { createDeveloperToolsRoutes } = require('./developer-tools');
const { createMacosPrivacyRoutes } = require('./macos-privacy');
const { createOpsTerminalRoutes } = require('./ops-terminal');

function createApkInfoHandler(deps) {
  return async function apkInfoHandler(req, res, next) {
    try {
      res.json(await deps.apkDistribution.info());
    } catch (error) {
      next(error);
    }
  };
}

function createIosOtaInfoHandler(deps) {
  return function iosOtaInfoHandler(req, res, next) {
    try {
      res.json(deps.iosOta.info());
    } catch (error) {
      next(error);
    }
  };
}

function assertSystemRouteDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('system route dependencies are required');
  if (!deps.apkDistribution
      || typeof deps.apkDistribution.info !== 'function'
      || typeof deps.apkDistribution.downloadHandler !== 'function') {
    throw new TypeError('system route APK distribution runtime is required');
  }
  if (!deps.iosOta
      || typeof deps.iosOta.info !== 'function'
      || typeof deps.iosOta.manifestHandler !== 'function') {
    throw new TypeError('system route iOS OTA runtime is required');
  }
  return deps;
}

function mountSystemRoutes(app, rawDeps) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express app.get and app.post are required');
  }
  const deps = assertSystemRouteDeps(rawDeps);
  app.get('/api/apk-info', createApkInfoHandler(deps));
  // Mounted before express.static: local files fall through to static serving;
  // verified releases redirect, and every other state terminates explicitly.
  app.get('/multicc.apk', deps.apkDistribution.downloadHandler);
  app.get('/api/ios-ota-info', createIosOtaInfoHandler(deps));
  // itms-services fetches the manifest without the login cookie (bypassed in
  // src/routes/auth.js); the asset URL inside is rendered per request so the
  // same IPA installs over loopback, LAN or Tailscale Funnel HTTPS.
  app.get('/ios-ota/manifest.plist', deps.iosOta.manifestHandler);
  require('../ios-udid').createIosUdid().mountRoutes(app);
  // Host toolchain repair. Mounted here rather than from server.js because it
  // needs no host state — only the platform and xcode-select — and server.js
  // sits against its source-line budget.
  createDeveloperToolsRoutes().mountRoutes(app);
  createMacosPrivacyRoutes().mountRoutes(app);
  // Ops terminal: shell-level environment repair (git install / commit
  // identity) for hosts that cannot create their first directory. Same mount
  // rationale as developer-tools above — no host state, and server.js sits
  // against its source-line budget.
  createOpsTerminalRoutes().mountRoutes(app);
}

module.exports = {
  createApkInfoHandler,
  createIosOtaInfoHandler,
  mountSystemRoutes,
};
