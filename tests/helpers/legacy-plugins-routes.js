'use strict';

// Frozen copy of the two plugin handlers that moved to the Rust front door:
// `POST /api/channels/recheck` and `GET /plugins/:id/*` (`servePluginFile`),
// taken verbatim from src/routes/plugins.js at commit 14d6f54a. It exists only
// as the differential oracle for `docs/rust-migration/differential/plugins.js`;
// production code must not require it. Update it only to mirror a documented
// change in Node, never to make the differential pass.
//
// The two Node-only facts the handlers consult are injected, so this file holds
// the retired rules and nothing else:
//   findManifest(id)            -> { dir, manifest } | null   (plugins.js readManifest over `roots`)
//   stillActive(sessionId, cat) -> boolean                    (src/plugins/channel-registry.js)
//   isLocalRequest(req)         -> boolean
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createLegacyPluginsRoutes(deps = {}) {
  if (typeof deps.findManifest !== 'function') throw new TypeError('legacy plugins: findManifest(id) is required');
  if (typeof deps.stillActive !== 'function') throw new TypeError('legacy plugins: stillActive(sessionId, category) is required');
  if (typeof deps.isLocalRequest !== 'function') throw new TypeError('legacy plugins: isLocalRequest(req) is required');
  const { findManifest, stillActive, isLocalRequest } = deps;

  function servePluginFile(req, res) {
    const id = req.params.id;
    const found = findManifest(id);
    if (!found) return res.status(404).json({ error: `插件 ${id} 不存在` });
    const relative = (req.params[0] || '').replace(/\\/g, '/');
    if (!relative || relative.includes('..') || relative.startsWith('/')) {
      return res.status(400).json({ error: '非法路径' });
    }
    const root = fs.realpathSync(found.dir);
    let absolute;
    try {
      absolute = fs.realpathSync(path.join(found.dir, relative));
    } catch (_) {
      return res.status(404).json({ error: '文件不存在' });
    }
    if (!absolute.startsWith(root + path.sep)) return res.status(400).json({ error: '非法路径' });
    // 只挂插件声明过 UI 的那棵子树（默认 ui/），插件目录里的源码、Cargo 产物不出网。
    const uiRoot = path.join(root, path.dirname(found.manifest.ui || 'ui/index.html'));
    if (!absolute.startsWith(uiRoot + path.sep)) return res.status(403).json({ error: '只有 UI 子树可访问' });
    let body;
    try {
      body = fs.readFileSync(absolute);
    } catch (_) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.set('Content-Type', MIME_TYPES[path.extname(absolute).toLowerCase()] || 'application/octet-stream');
    // WebView 常无视静态资源的 Cache-Control，跟主站一个策略：URL 不带指纹就禁缓存。
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(body);
  }

  return function mount(app) {
    // 插件发送前复核（方案 10.5 第 5 步）：这些任务的问题还在不在。只给本机的插件进程。
    app.post('/api/channels/recheck', (req, res) => {
      if (!isLocalRequest(req)) return res.status(403).json({ error: '只接受本机插件的复核请求' });
      const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 200) : [];
      res.set('Cache-Control', 'no-store');
      res.json({
        items: items.filter(item => item && typeof item === 'object').map(item => {
          const sessionId = typeof item.sessionId === 'string' ? item.sessionId.slice(0, 128) : '';
          const category = typeof item.category === 'string' ? item.category.slice(0, 32) : '';
          return { sessionId, category, active: stillActive(sessionId, category) };
        }),
      });
    });
    // 插件 UI 静态树（iframe 源）。挂在全局 auth gate 之后，与页面同等鉴权。
    app.get('/plugins/:id/*', servePluginFile);
  };
}

module.exports = { createLegacyPluginsRoutes };
