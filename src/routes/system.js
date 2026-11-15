'use strict';

// 系统路由的 Node 侧只剩发布资产一族（APK / iOS OTA），且其中只有 /multicc.apk
// 还挂在真实 app 上：其余三条与 ios-udid 的三条已随发布资产与聊天历史簇迁到
// Rust 前门（native/gateway/src/app/release_history_routes.rs），由
// src/routes/release-history-host.js 的捕获应用挂载。宿主修复面板
// （developer-tools / macos-privacy / ops-terminal）已随宿主与系统操作簇迁到
// Rust 前门，由 src/routes/host-ops-host.js 的捕获应用挂载。
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

// 三条已迁路由 + ios-udid 的三条，挂在宿主端口的捕获应用上。
// `deps.iosUdid` 可选注入（测试用）；生产留空即在这里构造唯一实例 —— UDID 的
// 一次性令牌表必须跨请求存活，所以整个进程只能构造一次。
function mountSystemHostRoutes(app, rawDeps) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express app.get and app.post are required');
  }
  const deps = assertSystemRouteDeps(rawDeps);
  app.get('/api/apk-info', createApkInfoHandler(deps));
  app.get('/api/ios-ota-info', createIosOtaInfoHandler(deps));
  // itms-services fetches the manifest without the login cookie (the shared
  // HTTP-entry exemption, multicc_core::http_entry::public_path); the asset URL
  // inside is rendered per request so the same IPA installs over loopback, LAN
  // or Tailscale Funnel HTTPS.
  app.get('/ios-ota/manifest.plist', deps.iosOta.manifestHandler);
  (deps.iosUdid || require('../ios-udid').createIosUdid()).mountHostRoutes(app);
}

// 唯一仍在真实 app 上的发布资产路由：有本地文件时它 `next()` 落到 express.static
// 的流式 sendFile（Range/ETag/Last-Modified），无法在前门拆分，所以留在 Node。
// Mounted before express.static: local files fall through to static serving;
// verified releases redirect, and every other state terminates explicitly.
function mountApkDownload(app, rawDeps) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('Express app.get is required');
  }
  const deps = assertSystemRouteDeps(rawDeps);
  app.get('/multicc.apk', deps.apkDistribution.downloadHandler);
}

module.exports = {
  createApkInfoHandler,
  createIosOtaInfoHandler,
  mountSystemHostRoutes,
  mountApkDownload,
};
