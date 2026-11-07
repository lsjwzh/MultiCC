//! The download link (docs/gateway.md §9):
//!
//! - `POST /api/auth/download-ticket` (was src/routes/auth.js) issues a
//!   [`multicc_core::download_ticket`] capability; the gate checks it.
//! - `GET|HEAD /api/download` (was `createDownloadHandler` in
//!   src/routes/file-transfer.js): `?path=` (retried once percent-decoded),
//!   `?inline=1` for `res.sendFile`, otherwise `res.download`. The response
//!   decision and headers are [`multicc_core::http_send`] (Express's `send`);
//!   the body streams from disk.

use std::io::SeekFrom;

use axum::body::Body;
use axum::http::{HeaderName, HeaderValue, Response};
use multicc_core::download_ticket;
use multicc_core::http_gate::{self, query_param, QueryParam};
use multicc_core::http_send::{self, FileStat, Header, SendPlan};
use multicc_core::js::string::js_trim;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::express::{self, RequestCtx};
use super::App;

const STREAM_CHUNK: usize = 64 * 1024;

/// `POST /api/auth/download-ticket` with `req.body` already parsed.
pub fn issue(app: &App, body: &Value, now: i64) -> (u16, Value) {
    let invalid = (400, json!({ "error": "invalid download target" }));
    let Some(path) = body
        .as_object()
        .and_then(|object| object.get("path"))
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    else {
        return invalid;
    };
    let inline = body.get("inline") == Some(&Value::Bool(true));
    let target = download_ticket::target(path, inline);
    let issued = app
        .tickets
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .issue(&target, now);
    match issued {
        Some(issued) => (
            200,
            json!({
                "ticket": issued.ticket,
                "expiresAt": issued.expires_at,
                "target": issued.target,
            }),
        ),
        None => invalid,
    }
}

/// Node's `fs.Stats`: `size` and `mtimeMs = sec * 1e3 + nsec / 1e6`.
pub fn file_stat(meta: &std::fs::Metadata) -> FileStat {
    #[cfg(unix)]
    let mtime_ms = {
        use std::os::unix::fs::MetadataExt;
        meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6
    };
    #[cfg(not(unix))]
    let mtime_ms = match meta.modified() {
        Ok(time) => match time.duration_since(std::time::UNIX_EPOCH) {
            Ok(after) => after.as_secs() as f64 * 1000.0 + f64::from(after.subsec_nanos()) / 1e6,
            Err(before) => -(before.duration().as_secs_f64() * 1000.0),
        },
        Err(_) => f64::NAN,
    };
    FileStat {
        size: meta.len(),
        mtime_ms,
    }
}

/// `path.resolve(path)` against the Node child's working directory.
#[cfg(not(windows))]
pub fn resolve(cwd: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{cwd}/{path}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// win32 `path.resolve` is approximated by the OS's own absolutization.
#[cfg(windows)]
pub fn resolve(cwd: &str, path: &str) -> String {
    let joined = std::path::Path::new(cwd).join(path);
    std::path::absolute(&joined)
        .unwrap_or(joined)
        .to_string_lossy()
        .into_owned()
}

/// `decodeURIComponent(text)`, or `None` where it throws.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let nibble = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).copied().and_then(nibble)?;
            let low = bytes.get(index + 2).copied().and_then(nibble)?;
            out.push(high << 4 | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `decodedPathCandidate`: markdown renderers percent-encode CJK/space names
/// and the client encodes them again, so a literal `%XX` path that does not
/// exist is retried once decoded. The literal path always wins.
fn decoded_candidate(path: &str) -> Option<String> {
    let has_escape = path
        .as_bytes()
        .windows(3)
        .any(|w| w[0] == b'%' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit());
    if !has_escape {
        return None;
    }
    decode_uri_component(path).filter(|decoded| decoded != path)
}

/// `GET|HEAD /api/download`.
pub async fn download(app: &App, ctx: &RequestCtx) -> Response<Body> {
    let raw = match query_param(&ctx.original_url, "path") {
        QueryParam::Missing => String::new(),
        QueryParam::Text(text) => text,
        // `(req.query.path || '').trim()` on an array or object.
        QueryParam::Other => {
            return express::error(ctx, 500, "req.query.path.trim is not a function")
        }
    };
    let inline = query_param(&ctx.original_url, "inline") == QueryParam::Text("1".into());
    let file_path = js_trim(&raw).to_string();
    if file_path.is_empty() {
        return express::json(ctx, 400, &json!({ "error": "path required" }), &[]);
    }
    let mut candidates = vec![file_path.clone()];
    candidates.extend(decoded_candidate(&file_path));
    for candidate in candidates {
        let resolved = resolve(&app.node_cwd, &candidate);
        let Ok(meta) = tokio::fs::metadata(&resolved).await else {
            continue;
        };
        if meta.is_dir() {
            return express::json(ctx, 400, &json!({ "error": "不能下载目录" }), &[]);
        }
        return send_file(ctx, &resolved, !inline).await;
    }
    express::json(ctx, 404, &json!({ "error": "文件不存在" }), &[])
}

/// The `code` an fs error carries (`err.code`), and the status send's
/// `onStatError` gives it.
fn fs_error(error: &std::io::Error) -> (u16, &'static str) {
    let raw = error.raw_os_error().unwrap_or(0);
    let name_too_long = if cfg!(target_os = "linux") { 36 } else { 63 };
    match raw {
        2 => (404, "ENOENT"),
        20 => (404, "ENOTDIR"),
        _ if raw == name_too_long && cfg!(unix) => (404, "ENAMETOOLONG"),
        1 => (500, "EPERM"),
        13 => (500, "EACCES"),
        21 => (500, "EISDIR"),
        24 => (500, "EMFILE"),
        _ => match error.kind() {
            std::io::ErrorKind::NotFound => (404, "ENOENT"),
            std::io::ErrorKind::PermissionDenied => (500, "EACCES"),
            _ => (500, "EIO"),
        },
    }
}

fn base(ctx: &RequestCtx, status: u16) -> axum::http::response::Builder {
    express::with_base_headers(Response::builder().status(status), ctx)
}

fn push(builder: axum::http::response::Builder, header: &Header) -> axum::http::response::Builder {
    match (
        HeaderName::from_bytes(header.name.as_bytes()),
        HeaderValue::from_bytes(&header.value),
    ) {
        (Ok(name), Ok(value)) => builder.header(name, value),
        _ => builder,
    }
}

fn find<'a>(headers: &'a [Header], name: &str) -> Option<&'a Header> {
    headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
}

/// `safeErrorHandler` after send failed: `res.status(status).json(dto)` on a
/// response that already carries send's headers. `res.json` keeps the file's
/// Content-Type (re-charset to utf-8) and its ETag; Content-Length is the
/// JSON's.
fn error_after_send(
    ctx: &RequestCtx,
    status: u16,
    code: Option<&str>,
    headers: &[Header],
    detail: &str,
) -> Response<Body> {
    let message = if status >= 500 {
        "internal_error"
    } else {
        "request_error"
    };
    let code = code.unwrap_or(message);
    let dto = http_gate::error_dto(message, code, &[], &ctx.ids);
    let body = multicc_core::js::serde::js_json_stringify(&dto).into_bytes();
    express::log_http_error(ctx, status, detail);

    let content_type = match find(headers, "Content-Type") {
        // content-type's setCharset(type, 'utf-8') on what send set.
        Some(existing) => {
            let text = String::from_utf8_lossy(&existing.value);
            let essence = text
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            format!("{essence}; charset=utf-8")
        }
        None => "application/json; charset=utf-8".to_string(),
    };
    let mut builder = base(ctx, status);
    for header in headers {
        if header.name.eq_ignore_ascii_case("Content-Type") {
            builder = express::header(builder, "Content-Type", &content_type);
        } else if !header.name.eq_ignore_ascii_case("Content-Length") {
            builder = push(builder, header);
        }
    }
    if find(headers, "Content-Type").is_none() {
        builder = express::header(builder, "Content-Type", &content_type);
    }
    if find(headers, "ETag").is_none() {
        builder = express::header(builder, "ETag", &express::weak_etag(&body));
    }
    let json =
        content_type.len() >= 16 && content_type[..16].eq_ignore_ascii_case("application/json");
    if json && !express::is_head(ctx) {
        // src/http/json-compression.js; the DTO is far below its gzip floor.
        builder = express::header(builder, "Vary", "Accept-Encoding");
    }
    builder = express::header(builder, "Content-Length", &body.len().to_string());
    express::log_request(ctx, status);
    let body = if express::is_head(ctx) {
        Vec::new()
    } else {
        body
    };
    builder
        .body(Body::from(body))
        .expect("static response parts")
}

/// `res.sendFile(path)` / `res.download(path)` for a file the route stat'ed.
async fn send_file(ctx: &RequestCtx, path: &str, attachment: bool) -> Response<Body> {
    // send stats the file again itself.
    let meta = match tokio::fs::metadata(path).await {
        Ok(meta) => meta,
        Err(error) => {
            let (status, code) = fs_error(&error);
            return error_after_send(ctx, status, Some(code), &[], &error.to_string());
        }
    };
    let stat = file_stat(&meta);
    let header = |name: &str| ctx.headers.get(name).map(str::to_string);
    let plan = http_send::plan(path, &stat, ctx.method.as_str(), &header, attachment);
    match plan {
        SendPlan::Error { status, headers } => {
            let detail = match status {
                404 => "Not Found",
                412 => "Precondition Failed",
                416 => "Range Not Satisfiable",
                _ => "send error",
            };
            error_after_send(ctx, status, None, &headers, detail)
        }
        SendPlan::NotModified { status, headers } => {
            let mut builder = base(ctx, status);
            for header in &headers {
                builder = push(builder, header);
            }
            express::log_request(ctx, status);
            builder.body(Body::empty()).expect("static response parts")
        }
        SendPlan::File {
            status,
            headers,
            start,
            content_length,
            head_only,
            ..
        } => {
            let body = if head_only {
                Body::empty()
            } else {
                match open_range(path, start, content_length).await {
                    Ok(body) => body,
                    Err(error) => {
                        let (status, code) = fs_error(&error);
                        return error_after_send(
                            ctx,
                            status,
                            Some(code),
                            &headers,
                            &error.to_string(),
                        );
                    }
                }
            };
            let mut builder = base(ctx, status);
            for header in &headers {
                builder = push(builder, header);
            }
            // The JSON gzip middleware's res.end hook: only an empty body
            // reaches it before the headers are flushed (HEAD never does).
            let json = find(&headers, "Content-Type").is_some_and(|value| {
                value.value.len() >= 16
                    && value.value[..16].eq_ignore_ascii_case(b"application/json")
            });
            if !head_only && content_length == 0 && json {
                builder = express::header(builder, "Vary", "Accept-Encoding");
            }
            express::log_request(ctx, status);
            builder.body(body).expect("static response parts")
        }
    }
}

async fn open_range(path: &str, start: u64, length: u64) -> std::io::Result<Body> {
    let mut file = tokio::fs::File::open(path).await?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await?;
    }
    let reader = file.take(length);
    Ok(Body::from_stream(
        tokio_util::io::ReaderStream::with_capacity(reader, STREAM_CHUNK),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn resolve_follows_node_path_resolve() {
        assert_eq!(resolve("/srv/app", "a/../b//c/."), "/srv/app/b/c");
        assert_eq!(resolve("/srv/app", "/x/./y/"), "/x/y");
        assert_eq!(resolve("/srv/app", "/../.."), "/");
        assert_eq!(resolve("/srv", "../../etc"), "/etc");
        assert_eq!(resolve("/srv", "~/a"), "/srv/~/a");
    }

    #[test]
    fn decoded_candidates_follow_decode_uri_component() {
        assert_eq!(
            decoded_candidate("/h/%E7%A4%BE%E5%AA%92%20x.png").as_deref(),
            Some("/h/社媒 x.png")
        );
        assert_eq!(decoded_candidate("/h/plain.png"), None);
        // A stray `%` makes decodeURIComponent throw: no second candidate.
        assert_eq!(decoded_candidate("/h/100%.png"), None);
        assert_eq!(decoded_candidate("/h/%41%zz"), None);
        // Bytes that are not UTF-8.
        assert_eq!(decoded_candidate("/h/%E7%A4.png"), None);
        assert_eq!(decoded_candidate("/h/%2B+").as_deref(), Some("/h/++"));
    }
}
