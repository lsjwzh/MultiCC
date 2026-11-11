'use strict';

// 宿主端口（host port）：文件浏览与聊天附件上传已经由 Rust 前门
// （multicc-gateway）独占，原 src/routes/file-transfer.js 的两条路由已删除：
//
//   GET  /api/files    目录列表
//   POST /api/upload   聊天附件上传（multipart 解析、限额、临时目录配额、落盘）
//
// 路由匹配、query 的 trim 语义（含 `req.query.x.trim is not a function` 这类
// 错误）、上传策略与错误响应都在 Rust。这里只剩 Rust 看不到的 Node 运行时事实：
// 进程内的会话表（sessions / persistedSessions），以及目录条目的 ICU
// localeCompare 排序 —— Rust 侧按字节序排会与旧前端看到的顺序漂移。
//
// 读侧只回原料：{ ok, dir, entries }，不再回最终响应；列举失败回
// { ok:false, message }，前门据此复刻旧的 400 { error: message }。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/file-transfer';

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('[file-transfer-host] dependencies are required');
  }
  if (!deps.fs || !deps.path || !deps.os) {
    throw new TypeError('[file-transfer-host] filesystem dependencies are required');
  }
  for (const name of ['getActiveSession', 'getPersistedSession']) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`[file-transfer-host] dependency missing: ${name}`);
    }
  }
  return deps;
}

function resolveDirectory(rawPath, sessionId, deps) {
  let dirPath = (rawPath || '').trim();
  const id = (sessionId || '').trim();

  if (!dirPath && id) {
    const active = deps.getActiveSession(id);
    const persisted = deps.getPersistedSession(id);
    dirPath = (active && active.cwd) || (persisted && persisted.cwd) || deps.os.homedir();
  } else if (!dirPath) {
    dirPath = deps.os.homedir();
  }

  if (dirPath === '~') dirPath = deps.os.homedir();
  else if (dirPath.startsWith('~/') || dirPath.startsWith('~\\')) {
    dirPath = deps.path.join(deps.os.homedir(), dirPath.slice(2));
  }
  return deps.path.resolve(dirPath);
}

function listDirectory(dirPath, deps) {
  const entries = deps.fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .map((entry) => {
      const fullPath = deps.path.join(dirPath, entry.name);
      const isDir = entry.isDirectory();
      let size = null;
      if (!isDir) {
        try { size = deps.fs.statSync(fullPath).size; } catch (_) { /* preserve unreadable entry */ }
      }
      return { name: entry.name, isDir, path: fullPath, size };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function createFileTransferHost(options) {
  const deps = assertDependencies(options);

  return async function handle(body) {
    if (!body || body.op !== 'files') return { ok: false };
    const dirPath = resolveDirectory(body.path, body.session, deps);
    try {
      return { ok: true, dir: dirPath, entries: listDirectory(dirPath, deps) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  };
}

function mountFileTransferHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[file-transfer-host] Express-compatible app is required');
  }
  const isLocal = typeof options.isLocal === 'function' ? options.isLocal : isLocalRequest;
  const handle = createFileTransferHost(options);
  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    Promise.resolve(handle(req.body)).then(
      answer => res.json(answer),
      error => res.status(500).json({ error: 'file transfer failed', detail: String(error && error.message || error) }),
    );
  });
}

module.exports = { mountFileTransferHostRoute, createFileTransferHost, HOST_PATH };
