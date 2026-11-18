//! The serving half of `src/routes/static-assets.js`, answered here instead of
//! by Node (rules: [`multicc_core::static_web`] and
//! [`multicc_core::static_assets_routes`]):
//!
//! ```text
//! GET       <any>            -> the versioned-HTML middleware (?v=<mtime>)
//! GET|HEAD  <any>            -> express.static(public/, { extensions: ['html'] })
//! ```
//!
//! Both layers are resolved once, in [`claim`], and the request is claimed only
//! when the resolution produces a response. That is `serve-static`'s
//! `fallthrough: true` contract: a 400/403/404 from `send` was a plain
//! `next()`, so the request has to keep travelling to Node exactly as it did
//! before — the routes registered after the retired mount are all `/api/*`
//! plus `POST /codex-proxy/*`, and `tests/test-static-doc-page.js` keeps
//! `public/` free of a directory that could shadow one.
//!
//! An `Upgrade` request is never claimed: Node's HTTP server emits `upgrade`
//! instead of `request`, so Express (and therefore the retired mount) never saw
//! one.
//!
//! The 500 from `send`'s `onStatError` is the one error the retired mount
//! forwarded as `next(err)`, and 412/416 reach the same handler after a file
//! matched; all three are rendered by [`super::download::error_after_send`],
//! which is `safeErrorHandler` on a response that already carries send's
//! headers. The differential
//! `docs/rust-migration/differential/static-web-root.js` checks every shape
//! byte for byte against the frozen Node module.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{HeaderMap, Method, Response, Uri};
use multicc_core::http_send::{self, Header, SendPlan};
use multicc_core::static_assets_routes::{
    self, download_headers, QueryView, VersionedPlan, TASK_ENTRY_FILE,
};
use multicc_core::static_web::{self, PathPlan};

use super::download;
use super::express::{self, RequestCtx};
use super::App;

/// What [`claim`] resolved the request to, carried to [`handle`] as a request
/// extension so the filesystem is read exactly once per request.
#[derive(Debug, Clone)]
pub enum Resolved {
    /// The versioned-HTML middleware renders this absolute document.
    Versioned { file: PathBuf },
    /// `express.static` serves this absolute file.
    File { file: PathBuf },
    /// `serve-static`'s directory listener: 301 to the path with a slash.
    Directory { location: String },
    /// `send`'s `onStatError` produced a 500, which `fallthrough` forwards to
    /// `safeErrorHandler` as `next(err)`.
    Failed { code: &'static str, detail: String },
}

/// `index: ['index.html']`, the `send` default `serve-static` keeps.
const INDEX: &str = "index.html";
/// `extensions: ['html']`, the only option the retired mount overrode.
const EXTENSION: &str = "html";

/// `fs.statSync` as the two retired layers read it.
pub(super) enum Entry {
    File,
    Directory,
    /// The error's `err.code` and the status `send`'s `onStatError` gives it.
    Error(&'static str, u16),
}

pub(super) fn probe(path: &Path) -> Entry {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Entry::Directory,
        Ok(_) => Entry::File,
        Err(error) => {
            let (status, code) = download::fs_error(&error);
            Entry::Error(code, status)
        }
    }
}

/// `send`'s `sendIndex`: one index entry, a directory result skipped, and an
/// exhausted list answering 404 (a plain `next()` under `fallthrough`).
fn resolve_index(root: &Path, directory: &str) -> Option<Resolved> {
    let candidate = root.join(directory).join(INDEX);
    match probe(&candidate) {
        Entry::File => Some(Resolved::File { file: candidate }),
        // `next()` with no error, then the exhausted list: `error(404)`.
        Entry::Directory => None,
        Entry::Error(_, 404) => None,
        Entry::Error(code, _) => Some(Resolved::Failed {
            code,
            detail: format!("{} {}", code, candidate.display()),
        }),
    }
}

/// `send`'s `sendFile` plus the single `extensions` retry.
fn resolve_file(root: &Path, relative: &str, original_url: &str) -> Option<Resolved> {
    let target = root.join(relative);
    match probe(&target) {
        Entry::File => return Some(Resolved::File { file: target }),
        Entry::Directory => {
            // serve-static's `createRedirectDirectoryListener`. The trailing
            // slash case never reaches here: it took `sendIndex` instead.
            return Some(Resolved::Directory {
                location: static_web::directory_location(original_url),
            });
        }
        // Only ENOENT on an extension-less path retries; every other 404-class
        // error is `onStatError` and a plain `next()`.
        Entry::Error("ENOENT", _) if !static_web::has_extension(relative) => {}
        Entry::Error(_, 404) => return None,
        Entry::Error(code, _) => {
            return Some(Resolved::Failed {
                code,
                detail: format!("{} {}", code, target.display()),
            })
        }
    }
    let retried = root.join(format!("{relative}.{EXTENSION}"));
    match probe(&retried) {
        Entry::File => Some(Resolved::File { file: retried }),
        // A directory candidate calls `next()` with no error, so the exhausted
        // list answers 404 instead of the carried ENOENT.
        Entry::Directory => None,
        Entry::Error(_, 404) => None,
        Entry::Error(code, _) => Some(Resolved::Failed {
            code,
            detail: format!("{} {}", code, retried.display()),
        }),
    }
}

/// The retired chain's two layers, resolved in their mount order. `None` is the
/// `next()` that has to reach Node.
pub fn claim(app: &App, method: &Method, uri: &Uri, headers: &HeaderMap) -> Option<Resolved> {
    if !(method == Method::GET || method == Method::HEAD) {
        return None;
    }
    // Node's HTTP server hands an upgrade to the `upgrade` listener, so the
    // retired Express chain never received one.
    if headers.contains_key("upgrade") {
        return None;
    }
    let root = app.public_dir.as_path();
    let path = uri.path();
    let original_url = uri.path_and_query().map(|value| value.as_str())?;
    // The versioned-HTML middleware ran for GET only.
    if method == Method::GET {
        match static_assets_routes::versioned_plan(path, &QueryView::new(original_url)) {
            VersionedPlan::TaskEntry => {
                return Some(Resolved::Versioned {
                    file: root.join(TASK_ENTRY_FILE),
                })
            }
            VersionedPlan::Candidate { relative } => {
                let candidate = root.join(&relative);
                if matches!(probe(&candidate), Entry::File) {
                    return Some(Resolved::Versioned { file: candidate });
                }
            }
            VersionedPlan::Skip => {}
        }
    }
    match static_web::path_plan(path) {
        PathPlan::Fallthrough { .. } => None,
        PathPlan::Index { directory } => resolve_index(root, &directory),
        PathPlan::File { relative } => resolve_file(root, &relative, original_url),
    }
}

/// `res.status(500).end()` — an empty body, no Content-Type and no ETag. Node
/// stamps `Content-Length: 0` for an ended GET response but not for HEAD.
fn ended(ctx: &RequestCtx, status: u16) -> Response<Body> {
    let mut builder = express::with_base_headers(Response::builder().status(status), ctx);
    let body = if express::is_head(ctx) {
        express::no_content_body()
    } else {
        builder = builder.header("Content-Length", "0");
        Body::empty()
    };
    express::log_request(ctx, status);
    builder.body(body).expect("static response parts")
}

/// `_serveVersionedHtml(absPath, res)`: the `?v=<mtime>` rewrite, `no-store`,
/// then `res.type('text/html').send(out)`.
fn versioned(app: &App, ctx: &RequestCtx, file: &Path) -> Response<Body> {
    let Ok(bytes) = std::fs::read(file) else {
        // `fs.readFile` err -> `res.status(500).end()`.
        return ended(ctx, 500);
    };
    let html = String::from_utf8_lossy(&bytes);
    let root = app.public_dir.as_path();
    let mtime = |asset: &str| {
        std::fs::metadata(root.join(asset))
            .ok()
            .map(|meta| download::file_stat(&meta).mtime_ms)
    };
    let out = static_assets_routes::version_html(&html, &mtime);
    express::send(
        ctx,
        200,
        "text/html; charset=utf-8",
        out.into_bytes(),
        &[
            ("Cache-Control", "no-store, no-cache, must-revalidate"),
            ("Pragma", "no-cache"),
        ],
    )
}

/// The 301 `serve-static` writes for a directory without a trailing slash: a
/// raw-`http` response, not `res.redirect`.
fn directory(ctx: &RequestCtx, location: &str) -> Response<Body> {
    let body = static_web::directory_document(location);
    let builder = express::with_base_headers(Response::builder().status(301), ctx);
    let builder = express::header(builder, "Content-Type", "text/html; charset=UTF-8");
    let builder = express::header(builder, "Content-Length", &body.len().to_string());
    let builder = express::header(builder, "Content-Security-Policy", "default-src 'none'");
    let builder = express::header(builder, "X-Content-Type-Options", "nosniff");
    let builder = express::header(builder, "Location", location);
    express::log_request(ctx, 301);
    let body = if express::is_head(ctx) {
        Body::empty()
    } else {
        Body::from(body)
    };
    builder.body(body).expect("static response parts")
}

/// `express.static(public/, { extensions, setHeaders })` for a resolved file.
pub(super) async fn serve_file(ctx: &RequestCtx, file: &Path) -> Response<Body> {
    let text = file.to_string_lossy().into_owned();
    // send stats the file itself, after the route's own stat.
    let meta = match tokio::fs::metadata(file).await {
        Ok(meta) => meta,
        Err(error) => {
            let (status, code) = download::fs_error(&error);
            if status == 404 {
                // The file vanished between the two stats: a plain `next()`,
                // which with nothing left to match is finalhandler's 404.
                return express::not_found(ctx);
            }
            return download::error_after_send(ctx, status, Some(code), &[], &error.to_string());
        }
    };
    if meta.is_dir() {
        return express::not_found(ctx);
    }
    let stat = download::file_stat(&meta);
    let header = |name: &str| ctx.headers.get(name).map(str::to_string);
    let preset: Vec<Header> = download_headers(&text);
    match http_send::plan_with_preset(&text, &stat, ctx.method.as_str(), &header, &preset) {
        SendPlan::Error { status, headers } => {
            // 404 before any header is the legacy dotfile branch, which
            // `fallthrough` turned into a plain `next()`.
            if status == 404 {
                return express::not_found(ctx);
            }
            let detail = match status {
                412 => "Precondition Failed",
                416 => "Range Not Satisfiable",
                _ => "send error",
            };
            download::error_after_send(ctx, status, None, &headers, detail)
        }
        plan => download::write_plan(ctx, &text, plan).await,
    }
}

pub async fn handle(app: &App, ctx: &RequestCtx, resolved: Option<&Resolved>) -> Response<Body> {
    match resolved {
        Some(Resolved::Versioned { file }) => versioned(app, ctx, file),
        Some(Resolved::File { file }) => serve_file(ctx, file).await,
        Some(Resolved::Directory { location }) => directory(ctx, location),
        Some(Resolved::Failed { code, detail }) => {
            download::error_after_send(ctx, 500, Some(code), &[], detail)
        }
        // `claim` is the only producer and it never claims without one.
        None => express::error(ctx, 500, "static web root claimed without a resolution"),
    }
}
