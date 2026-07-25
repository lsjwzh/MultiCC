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
    // Root → manage page (unless ?id= is specified, which means a terminal session)
    app.get('/', (req, res, next) => {
      if (req.query.id === '__aux__') {
        const params = new URLSearchParams();
        params.set('focus', 'aux');
        res.redirect(`/manage.html?${params.toString()}`);
        return;
      }
      if (req.query.id || req.query.newid || req.query.cwd) return next(); // terminal session
      res.redirect('/manage');
    });

    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      let rel;
      try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch (_) { return next(); }
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
      },
    }));
  }

  return { mountRoutes };
}

module.exports = { createStaticAssetsRoutes };
