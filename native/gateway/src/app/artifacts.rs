//! The serving half of `src/artifacts.js`, answered here instead of by Node
//! (rules: [`multicc_core::static_web`], the same send engine the public/
//! static root uses):
//!
//! ```text
//! GET|HEAD  /artifacts/<id>[/<file>]  -> express.static over two roots:
//!                                        <data root>/artifacts, then the
//!                                        legacy ~/.multicc/artifacts
//! ```
//!
//! The retired mount (`app.use('/artifacts', headers, ...roots.map(static))`)
//! prepended a headers middleware that turns `?download=1` / `?dl=1` into a
//! `Content-Disposition: attachment`, then ran one `serve-static` per root
//! with `{ index: 'index.html', dotfiles: 'ignore' }` and a `setHeaders` of
//! `Cache-Control: no-store, must-revalidate` + `X-Content-Type-Options:
//! nosniff`. Unlike the public/ root there is no `extensions` retry: a file
//! miss falls through to the next root, and a miss in every root is a plain
//! `next()` that has to keep travelling to Node (where the public/ static
//! layer, and then the default 404, waited) — so [`claim`] resolves the
//! filesystem once and only claims when a response exists.
//!
//! The mount point matched case-insensitively (`/ARTIFACTS/...` was served
//! too) while the auth capability regex stayed case-sensitive; [`handle`]
//! therefore decides the gate from the shared `http_entry::public_path` rule
//! instead of from how this router matched. The headers middleware ran on
//! every match — including requests that later fell through — so the
//! attachment disposition also rides the 301 and 500 this router answers.
//! The one shape it cannot ride is the forwarded fallthrough itself; the
//! differential `docs/rust-migration/differential/artifacts-root.js`
//! documents that single byte difference.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{HeaderMap, Method, Response, Uri};
use multicc_core::auth_runtime::Snapshot;
use multicc_core::http_gate::{self, is_private_network_address};
use multicc_core::http_send::{self, Header, SendPlan};
use multicc_core::static_web::{self, PathPlan};

use super::download;
use super::express::{self, RequestCtx};
use super::static_web_root::{probe, Entry};
use super::App;

/// What [`claim`] resolved the request to, carried to [`handle`] as a request
/// extension so the filesystem is read exactly once per request.
#[derive(Debug, Clone)]
pub enum Resolved {
    /// One of the two roots serves this absolute file.
    File { file: PathBuf },
    /// `serve-static`'s directory listener: 301 to the path with a slash.
    Directory { location: String },
    /// `send`'s `onStatError` produced a 500, which `fallthrough` forwards to
    /// `safeErrorHandler` as `next(err)` — and skips the second root, exactly
    /// like Express's error-first `next`.
    Failed { code: &'static str, detail: String },
}

/// `index: 'index.html'`, the only index the retired mount registered.
const INDEX: &str = "index.html";

/// Express mounted the router at `/artifacts` case-insensitively; the matched
/// prefix is stripped before `serve-static` sees the path, and a bare
/// `/artifacts` left `req.url` as `/`.
fn strip_prefix(path: &str) -> Option<&str> {
    const PREFIX: &str = "/artifacts";
    if path.len() < PREFIX.len() {
        return None;
    }
    let (head, rest) = path.split_at(PREFIX.len());
    if !head.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    if rest.is_empty() {
        return Some("/");
    }
    rest.starts_with('/').then_some(rest)
}

/// The two roots in mount order, deduplicated like `servedRoots()`'s `Set`.
pub(super) fn served_roots(app: &App) -> Vec<PathBuf> {
    let primary = app.data_root.join("artifacts");
    let legacy = app.home_dir.join(".multicc").join("artifacts");
    if primary == legacy {
        vec![primary]
    } else {
        vec![primary, legacy]
    }
}

/// `qs`'s lenient percent decoding for a query key or value: `+` is a space,
/// valid `%xx` sequences decode, malformed ones stay literal.
fn query_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'+' {
            out.push(b' ');
            index += 1;
        } else if byte == b'%' && index + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            match (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                (Some(high), Some(low)) => {
                    out.push((high * 16 + low) as u8);
                    index += 3;
                }
                _ => {
                    out.push(byte);
                    index += 1;
                }
            }
        } else {
            out.push(byte);
            index += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Express's `req.query` for the two keys the headers middleware read: the
/// attachment only happens when the parsed value is exactly the string `1`,
/// so a repeated key — an array to `qs`, never `=== '1'` — does not count,
/// and neither does a bracketed key (`download[]=1` parses to an array too).
fn download_requested(query: &str) -> bool {
    let values = |wanted: &str| -> Vec<String> {
        let mut found = Vec::new();
        for pair in query.split('&') {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            if query_decode(key) == wanted {
                found.push(query_decode(value));
            }
        }
        found
    };
    values("download") == ["1"] || values("dl") == ["1"]
}

/// `path.basename(req.path)` inside the retired mount: the request path minus
/// the prefix, still percent-encoded, with trailing slashes ignored and an
/// empty result mapped to `download`. The middleware then removed the
/// header-hostile characters (`"`, CR, LF).
fn download_basename(stripped: &str) -> String {
    let trimmed = stripped.trim_end_matches('/');
    let base = trimmed.rsplit('/').next().unwrap_or("");
    let base = if base.is_empty() { "download" } else { base };
    base.chars()
        .filter(|c| !matches!(c, '"' | '\r' | '\n'))
        .collect()
}

/// The `attachment; filename="..."` value the headers middleware would have
/// stamped on this request, or `None` when neither query flag is `1`.
fn download_disposition(ctx: &RequestCtx) -> Option<String> {
    let query = ctx
        .original_url
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or("");
    if !download_requested(query) {
        return None;
    }
    let stripped = strip_prefix(&ctx.path).unwrap_or("/");
    Some(format!(
        "attachment; filename=\"{}\"",
        download_basename(stripped)
    ))
}

/// `send`'s `sendIndex`: one `index.html` probe, a directory or a 404-class
/// error meaning this root falls through to the next.
fn resolve_index(root: &Path, directory: &str) -> Option<Resolved> {
    let candidate = root.join(directory).join(INDEX);
    match probe(&candidate) {
        Entry::File => Some(Resolved::File { file: candidate }),
        Entry::Directory => None,
        Entry::Error(_, 404) => None,
        Entry::Error(code, _) => Some(Resolved::Failed {
            code,
            detail: format!("{} {}", code, candidate.display()),
        }),
    }
}

/// `send`'s `sendFile` with no `extensions` retry: a miss here is the next
/// root's turn, not a `.html` probe.
fn resolve_file(root: &Path, relative: &str, original_url: &str) -> Option<Resolved> {
    let target = root.join(relative);
    match probe(&target) {
        Entry::File => Some(Resolved::File { file: target }),
        // serve-static's `createRedirectDirectoryListener`. The trailing slash
        // case never reaches here: it took `sendIndex` instead.
        Entry::Directory => Some(Resolved::Directory {
            location: static_web::directory_location(original_url),
        }),
        Entry::Error(_, 404) => None,
        Entry::Error(code, _) => Some(Resolved::Failed {
            code,
            detail: format!("{} {}", code, target.display()),
        }),
    }
}

/// `send`'s dotfile rule for an explicit `dotfiles: 'ignore'`: unlike the
/// legacy rule `path_plan` implements for the public root (only the *last*
/// segment decides), *any* normalized segment longer than one character that
/// starts with `.` is a 404, which `fallthrough` turned into a plain `next()`.
/// The check reads only the decoded path, so one test in front of both roots
/// is exactly the two per-layer tests the retired mount ran.
fn dotfile_fallthrough(plan: &PathPlan) -> bool {
    let relative = match plan {
        PathPlan::File { relative } => relative.as_str(),
        PathPlan::Index { directory } => directory.as_str(),
        PathPlan::Fallthrough { .. } => return false,
    };
    relative
        .split('/')
        .any(|part| part.len() > 1 && part.starts_with('.'))
}

/// The retired mount's layers in order: root one, then the legacy root, then
/// the `next()` that has to reach Node. `None` is that `next()`.
pub fn claim(app: &App, method: &Method, uri: &Uri, headers: &HeaderMap) -> Option<Resolved> {
    if !(method == Method::GET || method == Method::HEAD) {
        return None;
    }
    // Node's HTTP server hands an upgrade to the `upgrade` listener, so the
    // retired Express chain never received one.
    if headers.contains_key("upgrade") {
        return None;
    }
    let stripped = strip_prefix(uri.path())?;
    let original_url = uri.path_and_query().map(|value| value.as_str())?;
    let plan = static_web::path_plan(stripped);
    if dotfile_fallthrough(&plan) {
        return None;
    }
    for root in served_roots(app) {
        let resolved = match &plan {
            PathPlan::Fallthrough { .. } => None,
            PathPlan::Index { directory } => resolve_index(&root, directory),
            PathPlan::File { relative } => resolve_file(&root, relative, original_url),
        };
        if resolved.is_some() {
            return resolved;
        }
    }
    None
}

/// The two headers the retired mount's `setHeaders` stamped on every served
/// file, plus the conditional attachment disposition.
fn preset(disposition: Option<&str>) -> Vec<Header> {
    let mut preset = vec![
        Header::new("Cache-Control", "no-store, must-revalidate"),
        Header::new("X-Content-Type-Options", "nosniff"),
    ];
    if let Some(value) = disposition {
        preset.push(Header::new("Content-Disposition", value));
    }
    preset
}

/// `express.static(root, options)` for a resolved file.
async fn serve_file(ctx: &RequestCtx, file: &Path, disposition: Option<&str>) -> Response<Body> {
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
            return download::error_after_send(
                ctx,
                status,
                Some(code),
                &preset(disposition)[2..],
                &error.to_string(),
            );
        }
    };
    if meta.is_dir() {
        return express::not_found(ctx);
    }
    let stat = download::file_stat(&meta);
    let header = |name: &str| ctx.headers.get(name).map(str::to_string);
    match http_send::plan_with_preset(
        &text,
        &stat,
        ctx.method.as_str(),
        &header,
        &preset(disposition),
    ) {
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

/// The 301 `serve-static` writes for a directory without a trailing slash: a
/// raw-`http` response, not `res.redirect`. The headers middleware ran first,
/// so its attachment disposition rides along when the query asked for it.
fn directory(ctx: &RequestCtx, location: &str, disposition: Option<&str>) -> Response<Body> {
    let body = static_web::directory_document(location);
    let mut builder = express::with_base_headers(Response::builder().status(301), ctx);
    builder = express::header(builder, "Content-Type", "text/html; charset=UTF-8");
    builder = express::header(builder, "Content-Length", &body.len().to_string());
    builder = express::header(builder, "Content-Security-Policy", "default-src 'none'");
    builder = express::header(builder, "X-Content-Type-Options", "nosniff");
    if let Some(value) = disposition {
        builder = express::header(builder, "Content-Disposition", value);
    }
    builder = express::header(builder, "Location", location);
    express::log_request(ctx, 301);
    let body = if express::is_head(ctx) {
        Body::empty()
    } else {
        Body::from(body)
    };
    builder.body(body).expect("static response parts")
}

pub async fn handle(
    app: &App,
    ctx: &RequestCtx,
    peer: &str,
    snapshot: &Snapshot,
    resolved: Option<&Resolved>,
) -> Response<Body> {
    // Node's `gate('peer')` runs for every path, public ones included.
    if app.lan_only && !is_private_network_address(peer) {
        return express::json(
            ctx,
            403,
            &http_gate::public_peer_rejected_dto(&ctx.ids),
            &[],
        );
    }
    // The capability `<id>` cannot log in: exactly the shared HTTP-entry
    // exemptions skip the ordinary gate; everything else keeps it. The regex
    // is case-sensitive even though this router's mount point was not.
    let public =
        multicc_core::http_entry::public_path(ctx.method.as_str(), &ctx.path.as_str().into());
    if !public {
        if let Some(refusal) = app.gate(ctx, peer, snapshot).await {
            return refusal;
        }
    }
    let disposition = download_disposition(ctx);
    match resolved {
        Some(Resolved::File { file }) => serve_file(ctx, file, disposition.as_deref()).await,
        Some(Resolved::Directory { location }) => directory(ctx, location, disposition.as_deref()),
        Some(Resolved::Failed { code, detail }) => {
            let headers = match disposition {
                Some(value) => vec![Header::new("Content-Disposition", &value)],
                None => Vec::new(),
            };
            download::error_after_send(ctx, 500, Some(code), &headers, detail)
        }
        // `claim` is the only producer and it never claims without one.
        None => express::error(ctx, 500, "artifacts claimed without a resolution"),
    }
}
