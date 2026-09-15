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
    // `/manage` is now the stable bookmark for the Air control surface. Keep
    // `/manage.html` as the explicit compatibility document while its deeper
    // tools are migrated one by one; this prevents old links from dropping the
    // user back onto the retired dashboard shell.
    app.get('/manage', (req, res) => {
      if (req.query.focus === 'aux') {
        const legacy = new URLSearchParams({ focus: 'aux' });
        if (typeof req.query.token === 'string' && req.query.token) legacy.set('token', req.query.token);
        return res.redirect(`/manage.html?${legacy.toString()}`);
      }
      const requested = typeof req.query.view === 'string' ? req.query.view : 'overview';
      const aliases = { cron: 'schedules', overview: 'overview', tasks: 'planner' };
      const allowed = new Set([
        'overview', 'tasks', 'planner', 'schedules', 'docs', 'memory', 'settings', 'voice', 'goal',
        'provider', 'global', 'push', 'tunnel', 'bridges', 'resources', 'skillsync', 'storage',
      ]);
      const view = aliases[requested] || (allowed.has(requested) ? requested : 'overview');
      const params = new URLSearchParams({ view });
      if (typeof req.query.token === 'string' && req.query.token) params.set('token', req.query.token);
      if (typeof req.query.external === 'string' && req.query.external) params.set('external', req.query.external);
      return res.redirect(`/air?${params.toString()}`);
    });

    // Root → manage page (unless ?id= is specified, which means a terminal session)
    app.get('/', (req, res, next) => {
      if (req.query.id === '__aux__') {
        const params = new URLSearchParams();
        params.set('focus', 'aux');
        res.redirect(`/manage.html?${params.toString()}`);
        return;
      }
      if (req.query.id || req.query.newid || req.query.cwd) return next(); // terminal session
      res.redirect('/air');
    });

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
      const taskRenderer = req.query.air === '1' && req.query.board === '1'
        && typeof req.query.task === 'string' && req.query.task.length > 0;
      if ((['chat', 'chat.html'].includes(rel) && !airChatRenderer)
          || (['task-shell', 'task-shell.html'].includes(rel) && !taskRenderer)) {
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

    // App binary distribution has exactly one public name per platform. The
    // canonical routes are mounted before this module and either fall through
    // for a verified local file or terminate explicitly. Never let an
    // accidental binary such as public/webcc.apk become downloadable just
    // because it was left in the public directory.
    app.use((req, res, next) => {
      let requestedPath = req.path;
      try { requestedPath = decodeURIComponent(requestedPath); } catch (_) {}
      if ((req.method === 'GET' || req.method === 'HEAD')
          && requestedPath !== '/multicc.apk'
          && requestedPath !== '/multicc-ios.ipa'
          && /\.(apk|ipa)$/i.test(requestedPath)) {
        res.set('Cache-Control', 'no-store');
        return res.status(404).end();
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
