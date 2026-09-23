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
    // `/manage` is the stable bookmark for the Air control surface. The old
    // dashboard document is gone — every one of its tools is an Air native
    // panel now — so this route no longer has a legacy shell to fall back to;
    // anything it cannot name lands on the overview rather than a 404.
    // Both spellings share one handler so an old `/manage.html?view=provider`
    // bookmark keeps its view instead of being flattened onto the overview.
    app.get(['/manage', '/manage.html'], (req, res) => {
      const requested = typeof req.query.view === 'string' ? req.query.view
        : (req.query.focus === 'aux' ? 'aux' : 'overview');
      const aliases = { cron: 'schedules', tasks: 'overview', planner: 'overview' };
      const allowed = new Set([
        'overview', 'schedules', 'docs', 'memory', 'settings', 'voice', 'goal', 'aux',
        'provider', 'global', 'push', 'tunnel', 'bridges', 'resources', 'skillsync', 'storage',
      ]);
      const view = aliases[requested] || (allowed.has(requested) ? requested : 'overview');
      const params = new URLSearchParams({ view });
      if (typeof req.query.token === 'string' && req.query.token) params.set('token', req.query.token);
      if (typeof req.query.external === 'string' && req.query.external) params.set('external', req.query.external);
      for (const key of ['dir', 'task']) {
        if (typeof req.query[key] === 'string' && req.query[key]) params.set(key, req.query[key]);
      }
      return res.redirect(`/air?${params.toString()}`);
    });

    // The legacy task planner has been removed, including its embedded entry.
    app.get(['/air', '/air.html'], (req, res, next) => {
      if (req.query.view !== 'planner') return next();
      const params = new URLSearchParams({ view: 'overview' });
      for (const key of ['dir', 'task', 'token', 'external']) {
        if (typeof req.query[key] === 'string' && req.query[key]) params.set(key, req.query[key]);
      }
      return res.redirect(`/air?${params.toString()}`);
    });

    // Root → Air (unless ?id= is specified, which means a terminal session)
    app.get('/', (req, res, next) => {
      // `__aux__` is not a real session id — it is the old dashboard's shorthand
      // for "open the assistant panel", which is an Air mode now.
      if (req.query.id === '__aux__') return res.redirect('/air?view=aux');
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
