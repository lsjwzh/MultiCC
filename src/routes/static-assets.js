'use strict';

// Static asset serving: the `/` root redirect, the versioned-HTML middleware
// (cache-busting `?v=<mtime>` rewrite for embedded WebViews), and the
// express.static mount for public/ (with the .apk download headers).
//
// Extracted verbatim from server.js. Behaviour — including mount order — is
// preserved exactly: mountStaticAssets(app) must be called at the same point in
// the middleware chain where these handlers used to live (after the auth gate
// and artifacts mount, before the remaining API routes).

function createStaticAssetsRoutes(rawDeps) {
  const deps = rawDeps || {};
  const { express, fs, path, publicDir } = deps;

  if (!express || typeof express.static !== 'function') {
    throw new TypeError('[static-assets] express (with static) is required');
  }
  if (!fs || typeof fs.readFile !== 'function' || typeof fs.statSync !== 'function') {
    throw new TypeError('[static-assets] fs is required');
  }
  if (!path || typeof path.join !== 'function' || typeof path.resolve !== 'function') {
    throw new TypeError('[static-assets] path is required');
  }
  if (typeof publicDir !== 'string' || !publicDir) {
    throw new TypeError('[static-assets] publicDir is required');
  }

  const _publicDir = publicDir;

  // Cache-busting for embedded WebViews: rewrite local <script src="x.js"> /
  // <link href="x.css"> in served HTML to "x.js?v=<mtime>", and send the HTML
  // itself with no-store. Many embedded WebViews ignore Cache-Control on static
  // assets and keep a stale copy; they still re-fetch when the asset URL changes,
  // so appending the file's mtime as a query makes every frontend edit show up on
  // the next page load without users having to clear cache manually.
  //
  // Exported (as serveHtml) because every HTML route must go through it. The
  // share route serves this same document for a recipient, and a second writer
  // would silently lose the cache-busting that keeps their WebView current.
  function _serveVersionedHtml(absPath, res) {
    fs.readFile(absPath, 'utf8', (err, html) => {
      if (err) { res.status(500).end(); return; }
      const out = html.replace(
        /((?:src|href)\s*=\s*["'])(?!https?:)(?!\/\/)([^"'?#]+\.)(js|css)(["'])/gi,
        (m, pre, name, ext, q) => {
          try {
            const mt = Math.floor(fs.statSync(path.join(_publicDir, name + ext)).mtimeMs);
            return `${pre}${name}${ext}?v=${mt}${q}`;
          } catch (_) { return m; }
        });
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.type('text/html').send(out);
    });
  }

  function mountRoutes(app) {
    // The three bookmark redirects (`/manage`, `/dashboard`, and
    // `/air?view=planner`) and the `.apk`/`.ipa` guard are owned by the Rust
    // front door now (native/gateway/src/app/static_assets_routes.rs, rules in
    // native/core/src/static_assets_routes.rs). They are claimed after the auth
    // gate, so an unclaimed path reaches this module exactly like before.

    // `GET /` 的两种重定向（无参 → /air，`?id=__aux__` → /air?view=aux）已由 Rust
    // 前门独占（native/gateway/src/app/release_history_routes.rs）。带
    // `?id=`/`?newid=`/`?cwd=` 的根路径是终端会话 URL，前门不认领，落到下面的
    // versioned-HTML 中间件 —— 与原来 `next()` 的去向完全一致。

    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      let rel;
      try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch (_) { return next(); }
      // Session URLs are bookmarks to tasks, never a second conversation UI.
      // Air is the sole exception: its task workspace embeds the canonical
      // full chat renderer and only changes its layout/theme. This explicit
      // flag cannot turn an ordinary public chat bookmark back into a second
      // top-level conversation surface.
      const airChatRenderer = req.query.air === '1'
        && ['chat', 'chat.html'].includes(rel)
        && ['task', 'session'].some(key => typeof req.query[key] === 'string' && req.query[key].length > 0);
      // The standalone task shell document is gone: its `board=1` renderer was
      // never reachable from any link, and its remaining bookmarks are covered
      // by the same task-entry hop the chat bookmarks already use
      // (task-entry.html → /api/air/resolve → /air?task=…).
      if (['chat', 'chat.html', 'task-shell', 'task-shell.html'].includes(rel) && !airChatRenderer) {
        return _serveVersionedHtml(path.join(_publicDir, 'task-entry.html'), res);
      }
      const cands = !rel || rel === '/' ? ['index.html']
        : rel.endsWith('.html') ? [rel]
        : [rel + '.html'];
      for (const c of cands) {
        const fp = path.resolve(_publicDir, c);
        if ((fp === _publicDir || fp.startsWith(_publicDir + path.sep))
            && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          return _serveVersionedHtml(fp, res);
        }
      }
      next();
    });

    // The `.apk`/`.ipa` guard (only the canonical `/multicc.apk` and
    // `/multicc-ios.ipa` names are downloadable) moved to the Rust front door
    // with the redirects above; the download headers below still apply to the
    // two canonical files this static mount is allowed to serve.

    app.use(express.static(_publicDir, {
      extensions: ['html'],
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.apk')) {
          res.set('Content-Type', 'application/vnd.android.package-archive');
          res.set('Content-Disposition', 'attachment; filename="multicc.apk"');
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.set('Pragma', 'no-cache');
          res.set('Expires', '0');
        }
        if (filePath.endsWith('.ipa')) {
          res.set('Content-Type', 'application/octet-stream');
          res.set('Content-Disposition', 'attachment; filename="multicc-ios.ipa"');
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.set('Pragma', 'no-cache');
          res.set('Expires', '0');
        }
      },
    }));
  }

  return { mountRoutes, serveHtml: _serveVersionedHtml };
}

module.exports = { createStaticAssetsRoutes };
