'use strict';

// Air 任务面板 `/api/air` 簇的挂载点。
//
// 这 15 条公开路由已经由 Rust 前门接管（native/gateway/src/app/air_routes.rs，
// 规则在 native/core/src/air_routes.rs）：
//
//   GET    /api/air
//   POST   /api/air/worktrees/reclaim
//   GET    /api/air/resolve
//   POST   /api/air/tasks
//   GET    /api/air/tasks/:id
//   GET    /api/air/tasks/:id/open
//   POST   /api/air/tasks/:id/delivery/reconcile
//   POST   /api/air/tasks/:id/roles
//   GET    /api/air/pins              POST /api/air/pins        POST /api/air/pins/toggle
//   GET    /api/air/todos             POST /api/air/todos       POST /api/air/todos/toggle
//   POST   /api/air/todos/ignore
//
// 本文件只负责把宿主端口（POST /api/__host/air）和仍然属于 Node 的两条摘要路由
// （/api/air/sync、/api/air/page）挂上去，并像从前一样把 liveSync 交给
// registerSync。进程内的快照/运行时/落盘/广播都在 ./air-routes-host.js。
//
// 返回值保持原契约（liveSync 或 null）：server.js 不用它，但测试拿它做摘要断言。

const { createAirRuntime } = require('./air-routes-host');

function mountAirRoutes(app, deps) {
  const runtime = createAirRuntime(deps);
  runtime.mount(app);
  return runtime.liveSync;
}

module.exports = { mountAirRoutes };
