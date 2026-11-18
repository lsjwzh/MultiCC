'use strict';

// 本模块曾经注册三样东西：`GET /` 的重定向、版本化 HTML 中间件（给内嵌 WebView
// 的 `?v=<mtime>` 缓存击穿）和 public/ 的 `express.static` 挂载（含 .apk/.ipa 下载
// 头）。三样都已由 Rust 前门独占：
//
//   GET|HEAD  /manage /dashboard /air?view=planner  native/.../static_assets_routes.rs
//   GET|HEAD  *.{apk,ipa} 守卫                       同上
//   GET|HEAD  /                                      native/.../release_history_routes.rs
//   GET       <任意>  版本化 HTML 中间件              native/.../static_web_root.rs
//   GET|HEAD  <任意>  express.static(public/)         同上
//
// 所以这里没有 `mountRoutes` 了，Node 侧也没有第二份静态实现可以静默兜底。
// 留下的只有 `serveHtml`：`/share/:token` 页面仍由宿主端口上的 Express 渲染
// （src/routes/share.js 的 `serveSharePage`），它需要同一套响应形状。重写规则本身
// 只有一份，在 `multicc_core::static_assets_routes::version_html`，这里经原生模块
// 调用它 —— 不留两份正则和两份 mtime 查表。

function createStaticAssetsRoutes(rawDeps) {
  const deps = rawDeps || {};
  const { publicDir } = deps;

  if (typeof publicDir !== 'string' || !publicDir) {
    throw new TypeError('[static-assets] publicDir is required');
  }

  const _publicDir = publicDir;
  // 可注入只为测试；生产恒走原生模块（没有 Node 版重写规则）。
  const native = deps.native || require('../native/runtime');

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
    const out = native.staticVersionedHtml(absPath, _publicDir);
    // `fs.readFile` 失败（含不可读文件）时原生侧回 null，等于退休实现的
    // `res.status(500).end()`。
    if (out === null || out === undefined) { res.status(500).end(); return; }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.type('text/html').send(out);
  }

  return { serveHtml: _serveVersionedHtml };
}

module.exports = { createStaticAssetsRoutes };
