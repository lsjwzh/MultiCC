'use strict';

// 宿主端口（host port）：`/api/server-info`、`/api/version-check`、
// `/api/debug/codex-proxy-trace` 已经由 Rust 前门（multicc-gateway，
// native/gateway/src/app/system.rs）独占；网卡排序、semver、tag 选择、DTO
// 形状都在 multicc_core::system_info。这里只剩 Node 进程自己才知道的事实
// 与 git 执行：
//
//   server-info  网卡表、绑定地址、端口、鉴权开关、进程 uptime/启动时刻，
//                以及挂载时缓存的安装版本（与退役的 createServerInfoHandler 一致：
//                版本在挂载时读一次，读取失败则整次省略 version 键）
//   ls-remote    版本检查的 git 回退。repo-actor 独占 git 执行环境（运行时
//                补丁过的 PATH、非交互 env、按仓库串行队列），所以这一步留在
//                Node；失败静默（与退役代码的 catch 一致），由 Rust 侧收尾
//   trace        codex 代理前缀追踪环形缓冲（src/codex/proxy-trace.js 留在
//                Node）；limit 的 Number 语义与 200 封顶已由 Rust 算好，这里
//                只做防御性再封顶后取快照
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/system';
// 与退役的 system.js 一致：GitHub 发现失败后的 git 回退与 15s 超时。
const LS_REMOTE_ARGS = ['ls-remote', '--tags', 'https://github.com/lsjwzh/MultiCC.git', 'refs/tags/v*'];
const LS_REMOTE_TIMEOUT_MS = 15000;

function mountSystemHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[system-host] Express-compatible app is required');
  }
  const { fs, path, rootDir, networkInterfaces, getPort, getBindHost, authRequired, gitRun } = options;
  if (!fs || !path || !rootDir) {
    throw new TypeError('[system-host] fs, path and rootDir are required');
  }
  for (const [name, value] of Object.entries({ networkInterfaces, getPort, authRequired, gitRun })) {
    if (typeof value !== 'function') throw new TypeError(`[system-host] ${name} must be a function`);
  }
  // 测试注入；生产解析与其余路由同一个实现，每次请求现取。
  const isLocal = options.isLocal || isLocalRequest;
  const uptimeSeconds = typeof options.uptimeSeconds === 'function' ? options.uptimeSeconds : () => process.uptime();
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // 与退役的 createServerInfoHandler 一致：版本在处理器创建时读一次，
  // 读取失败不是健康依赖——省略 version 键，其余字段照常。
  let serverVersion = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    serverVersion = pkg.version || '0.0.0';
  } catch (_) {
    serverVersion = null;
  }

  function serverInfoFacts() {
    // 与退役处理器同一条公式：负 uptime 不可能出现，钳位比报出一个未来的
    // startedAt 更便宜。startedAt 是可读事实；uptimeMs 供时钟不准的客户端使用。
    const uptimeMs = Math.max(0, Math.round(uptimeSeconds() * 1000));
    return {
      interfaces: networkInterfaces(),
      bindHost: typeof getBindHost === 'function' ? getBindHost() : '0.0.0.0',
      port: getPort(),
      authRequired: Boolean(authRequired()),
      version: serverVersion,
      startedAt: new Date(now() - uptimeMs).toISOString(),
      uptimeMs,
    };
  }

  app.post(HOST_PATH, async (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    if (body.op === 'server-info') {
      return res.json(serverInfoFacts());
    }
    if (body.op === 'ls-remote') {
      try {
        const output = await gitRun(rootDir, LS_REMOTE_ARGS, { timeout: LS_REMOTE_TIMEOUT_MS, kind: 'version-check' });
        return res.json({ ok: true, output: String(output || '') });
      } catch (_) {
        return res.json({ ok: false });
      }
    }
    if (body.op === 'trace') {
      // Rust 已按 Number/isInteger/>0 语义把 limit 归一到 1..=200；这里的
      // 再封顶只是防御，正常流量上恒等。
      const limit = Number.isSafeInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 200) : 100;
      // 与退役路由一致：proxy-trace 保持惰性加载。
      return res.json({ entries: require('../codex/proxy-trace').codexProxyTrace().snapshot(limit) });
    }
    return res.status(400).json({ error: 'unknown host operation' });
  });
}

module.exports = { mountSystemHostRoute, HOST_PATH };
