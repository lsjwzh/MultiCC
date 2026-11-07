//! The Express 4 behavior a native route has to reproduce so a client cannot
//! tell it apart from the Node route it replaced: `res.send`/`res.json`
//! (weak ETag, `req.fresh` → 304, 204/304 stripping), `res.redirect` with its
//! `res.format` body, `express.json({ limit: '50mb' })` (body-parser), the
//! terminal `safeErrorHandler`, the `/api/*` JSON gzip middleware, the
//! request-id headers and the `http_request` log line.

use std::io::{Read, Write};
use std::time::Instant;

use axum::body::Body;
use axum::http::{request::Parts, HeaderValue, Method, Response, StatusCode};
use base64::Engine;
use http_body_util::BodyExt;
use multicc_core::http_gate::{self, NodeHeaders};
use multicc_core::js::serde::js_json_stringify;
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};

use super::accept;

/// `express.json({ limit: '50mb' })`.
pub const JSON_LIMIT: usize = 50 * 1024 * 1024;
const GZIP_MIN_BYTES: usize = 1024;

/// What one request looks like to the Node middleware stack.
pub struct RequestCtx {
    pub method: Method,
    /// `req.path`: the raw pathname.
    pub path: String,
    /// `req.originalUrl`: the raw request target.
    pub original_url: String,
    pub headers: NodeHeaders,
    pub ids: (String, String),
    started: Instant,
}

impl RequestCtx {
    pub fn new(parts: &Parts) -> Self {
        let headers = NodeHeaders::from_raw(
            parts
                .headers
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_bytes())),
        );
        let path = parts.uri.path().to_string();
        let original_url = parts
            .uri
            .path_and_query()
            .map(|value| value.as_str().to_string())
            .unwrap_or_else(|| path.clone());
        let ids = http_gate::request_ids(&headers);
        Self {
            method: parts.method.clone(),
            path,
            original_url,
            headers,
            ids,
            started: Instant::now(),
        }
    }

    fn is_head(&self) -> bool {
        self.method == Method::HEAD
    }
}

// ── responses ──────────────────────────────────────────────────────────────

/// The `etag` package, weak: `W/"<byte length hex>-<sha1 base64, 27 chars>"`.
pub fn weak_etag(body: &[u8]) -> String {
    if body.is_empty() {
        return "W/\"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk\"".to_string();
    }
    let digest = base64::engine::general_purpose::STANDARD.encode(Sha1::digest(body));
    format!("W/\"{:x}-{}\"", body.len(), &digest[..27])
}

/// The `fresh` package's token list split (spaces and commas).
fn token_list(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let (mut start, mut end) = (0, 0);
    let mut list = Vec::new();
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b' ' => {
                if start == end {
                    start = index + 1;
                    end = index + 1;
                }
            }
            b',' => {
                list.push(&text[start..end]);
                start = index + 1;
                end = index + 1;
            }
            _ => end = index + 1,
        }
    }
    list.push(&text[start..end]);
    list
}

/// `fresh(req.headers, { etag })` (no Last-Modified is ever set here).
fn fresh(headers: &NodeHeaders, etag: &str) -> bool {
    let modified_since = headers.get("if-modified-since").filter(|v| !v.is_empty());
    let none_match = headers.get("if-none-match").filter(|v| !v.is_empty());
    if modified_since.is_none() && none_match.is_none() {
        return false;
    }
    if let Some(cache_control) = headers.get("cache-control").filter(|v| !v.is_empty()) {
        let no_cache = cache_control.split(',').any(|part| {
            part.trim_start_matches([' ', '\t'])
                .trim_end_matches([' ', '\t'])
                == "no-cache"
        });
        if no_cache {
            return false;
        }
    }
    if let Some(none_match) = none_match.filter(|value| *value != "*") {
        let matched = token_list(none_match).into_iter().any(|token| {
            token == etag || format!("W/{etag}") == token || format!("W/{token}") == etag
        });
        if !matched {
            return false;
        }
    }
    // A response without Last-Modified is never fresh against If-Modified-Since.
    modified_since.is_none()
}

pub fn header(
    builder: axum::http::response::Builder,
    name: &str,
    value: &str,
) -> axum::http::response::Builder {
    match HeaderValue::from_str(value) {
        Ok(value) => builder.header(name, value),
        Err(_) => builder,
    }
}

fn gzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).ok()?;
    encoder.finish().ok()
}

/// The headers every Express response here carries before the route runs:
/// `X-Powered-By` (expressInit), then the request-id middleware's three.
pub fn with_base_headers(
    builder: axum::http::response::Builder,
    ctx: &RequestCtx,
) -> axum::http::response::Builder {
    let builder = header(builder, "X-Powered-By", "Express");
    let builder = header(builder, "X-Multicc-Request-Id", &ctx.ids.0);
    let builder = header(builder, "X-Correlation-Id", &ctx.ids.1);
    header(builder, "X-Multicc-API-Version", http_gate::API_VERSION)
}

pub fn is_head(ctx: &RequestCtx) -> bool {
    ctx.is_head()
}

/// `res.send(body)` after `res.type(content_type)` and `res.status(status)`,
/// then the JSON gzip middleware around `res.end`, then the log line.
pub fn send(
    ctx: &RequestCtx,
    status: u16,
    content_type: &str,
    body: Vec<u8>,
    extra: &[(&str, &str)],
) -> Response<Body> {
    let etag = weak_etag(&body);
    let mut status = status;
    let get_like = ctx.method == Method::GET || ctx.is_head();
    if get_like && ((200..300).contains(&status) || status == 304) && fresh(&ctx.headers, &etag) {
        status = 304;
    }
    let empty = status == 204 || status == 304;
    let content_type = (!empty).then_some(content_type);
    let mut body = if empty { Vec::new() } else { body };

    let mut builder = with_base_headers(Response::builder().status(status), ctx);
    for (name, value) in extra {
        builder = header(builder, name, value);
    }
    if let Some(content_type) = content_type {
        builder = header(builder, "Content-Type", content_type);
    }
    builder = header(builder, "ETag", &etag);

    // src/http/json-compression.js: /api/* only, never HEAD.
    let json = content_type.is_some_and(|value| {
        value.len() >= 16 && value[..16].eq_ignore_ascii_case("application/json")
    });
    if !ctx.is_head() && ctx.path.starts_with("/api/") && json {
        builder = header(builder, "Vary", "Accept-Encoding");
        let accepts_gzip = ctx.headers.get("accept-encoding").is_some_and(|value| {
            value
                .to_ascii_lowercase()
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .any(|word| word == "gzip")
        });
        if accepts_gzip && body.len() >= GZIP_MIN_BYTES && status >= 200 {
            if let Some(compressed) = gzip(&body) {
                builder = header(builder, "Content-Encoding", "gzip");
                body = compressed;
            }
        }
    }
    if !empty {
        builder = header(builder, "Content-Length", &body.len().to_string());
    }
    log_request(ctx, status);
    let body = if ctx.is_head() { Vec::new() } else { body };
    builder
        .body(Body::from(body))
        .expect("static response parts")
}

/// `res.status(status).json(value)`.
pub fn json(
    ctx: &RequestCtx,
    status: u16,
    value: &Value,
    extra: &[(&str, &str)],
) -> Response<Body> {
    send(
        ctx,
        status,
        "application/json; charset=utf-8",
        js_json_stringify(value).into_bytes(),
        extra,
    )
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// `res.redirect(location)`: 302, `res.format({ text, html, default })`.
pub fn redirect(ctx: &RequestCtx, location: &str) -> Response<Body> {
    let accept = ctx.headers.get("accept");
    let (content_type, body) = match accept::prefer(accept, &["text/plain", "text/html"]) {
        Some(0) => (
            Some("text/plain; charset=utf-8"),
            format!("Found. Redirecting to {location}"),
        ),
        Some(_) => (
            Some("text/html; charset=utf-8"),
            format!("<p>Found. Redirecting to {}</p>", escape_html(location)),
        ),
        None => (None, String::new()),
    };
    let mut builder = with_base_headers(Response::builder().status(StatusCode::FOUND), ctx);
    builder = header(builder, "Location", location);
    builder = header(builder, "Vary", "Accept");
    if let Some(content_type) = content_type {
        builder = header(builder, "Content-Type", content_type);
    }
    builder = header(builder, "Content-Length", &body.len().to_string());
    log_request(ctx, 302);
    let body = if ctx.is_head() { String::new() } else { body };
    builder
        .body(Body::from(body))
        .expect("static response parts")
}

/// `safeErrorHandler`: a body-parser (or any) error with `status`, no
/// message leaked. Logged like the Node handler, minus the stack.
pub fn error(ctx: &RequestCtx, status: u16, detail: &str) -> Response<Body> {
    let message = if status >= 500 {
        "internal_error"
    } else {
        "request_error"
    };
    let body = http_gate::error_dto(message, message, &[], &ctx.ids);
    log_http_error(ctx, status, detail);
    json(ctx, status, &body, &[])
}

/// `safeErrorHandler`'s `http_error` log line (detail without a JS stack).
pub fn log_http_error(ctx: &RequestCtx, status: u16, detail: &str) {
    log_line(
        "error",
        "http_error",
        &[
            ("requestId", Value::String(ctx.ids.0.clone())),
            ("correlationId", Value::String(ctx.ids.1.clone())),
            ("method", Value::String(ctx.method.to_string())),
            ("path", Value::String(ctx.path.clone())),
            ("status", Value::from(status)),
            ("detail", Value::String(detail.to_string())),
        ],
    );
}

// ── logging (src/observability.js createLogger) ────────────────────────────

fn now_iso() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0);
    multicc_core::js::date_to_iso_string(millis).unwrap_or_default()
}

/// One structured line, the shape `createLogger` writes: info to stdout,
/// errors to stderr (the same destinations Node's console uses here).
pub fn log_line(level: &str, event: &str, fields: &[(&str, Value)]) {
    let mut record = Map::new();
    record.insert("ts".into(), Value::String(now_iso()));
    record.insert("level".into(), Value::String(level.into()));
    record.insert("service".into(), Value::String("multicc".into()));
    record.insert("event".into(), Value::String(event.into()));
    for (key, value) in fields {
        record.insert((*key).into(), value.clone());
    }
    let line = js_json_stringify(&Value::Object(record));
    if level == "error" || level == "warn" {
        let _ = writeln!(std::io::stderr(), "{line}");
    } else {
        let _ = writeln!(std::io::stdout(), "{line}");
    }
}

pub fn log_request(ctx: &RequestCtx, status: u16) {
    let elapsed = ctx.started.elapsed().as_secs_f64() * 1000.0;
    let rounded = (elapsed * 1000.0).round() / 1000.0;
    log_line(
        "info",
        "http_request",
        &[
            ("requestId", Value::String(ctx.ids.0.clone())),
            ("correlationId", Value::String(ctx.ids.1.clone())),
            ("method", Value::String(ctx.method.to_string())),
            ("path", Value::String(ctx.path.clone())),
            ("status", Value::from(status)),
            (
                "durationMs",
                serde_json::Number::from_f64(rounded)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            ),
        ],
    );
}

// ── express.json (body-parser 1.x) ─────────────────────────────────────────

/// A body-parser failure: the status `safeErrorHandler` answers with.
#[derive(Debug, PartialEq, Eq)]
pub struct BodyError {
    pub status: u16,
    pub reason: &'static str,
}

fn fail(status: u16, reason: &'static str) -> BodyError {
    BodyError { status, reason }
}

fn media_type(content_type: &str) -> (String, Option<String>) {
    let mut parts = content_type.split(';');
    let essence = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    let charset = parts.find_map(|param| {
        let (name, value) = param.split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"').to_ascii_lowercase())
    });
    (essence, charset)
}

async fn collect(body: Body, limit: usize) -> Result<Vec<u8>, BodyError> {
    let mut body = body;
    let mut out = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| fail(400, "request aborted"))?;
        if let Ok(data) = frame.into_data() {
            if out.len() + data.len() > limit {
                return Err(fail(413, "request entity too large"));
            }
            out.extend_from_slice(&data);
        }
    }
    Ok(out)
}

fn inflate(reader: impl Read, limit: usize) -> Result<Vec<u8>, BodyError> {
    let mut out = Vec::new();
    let read = reader
        .take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| fail(400, "invalid compressed body"))?;
    if read > limit {
        return Err(fail(413, "request entity too large"));
    }
    Ok(out)
}

/// `req.body` after `express.json({ limit })`: `{}` when there is no JSON
/// body, the parsed value otherwise (JS `JSON.parse` semantics, then the
/// JSON-safe view every Rust kernel takes).
pub async fn json_body(ctx: &RequestCtx, body: Body, limit: usize) -> Result<Value, BodyError> {
    let empty = Value::Object(Map::new());
    let headers = &ctx.headers;
    let has_body = headers.get("transfer-encoding").is_some()
        || headers
            .get("content-length")
            .is_some_and(|value| !multicc_core::js::js_string_to_number(value).is_nan());
    let Some(content_type) = headers.get("content-type").filter(|_| has_body) else {
        return Ok(empty);
    };
    let (essence, charset) = media_type(content_type);
    if essence != "application/json" {
        return Ok(empty);
    }
    let charset = charset.unwrap_or_else(|| "utf-8".to_string());
    if !charset.starts_with("utf-") {
        return Err(fail(415, "unsupported charset"));
    }
    // iconv-lite's canonical name: lower case, alphanumerics only.
    let canonical: String = charset
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    if !matches!(canonical.as_str(), "utf8" | "utf16" | "utf16le" | "utf16be") {
        // utf-32 and utf-7 also exist in iconv-lite; no client sends them.
        return Err(fail(415, "unsupported charset"));
    }
    let encoding = headers
        .get("content-encoding")
        .unwrap_or("identity")
        .to_ascii_lowercase();
    if !matches!(encoding.as_str(), "identity" | "gzip" | "deflate") {
        return Err(fail(415, "unsupported content encoding"));
    }
    if encoding == "identity" {
        if let Some(length) = headers
            .get("content-length")
            .and_then(|v| v.trim().parse::<usize>().ok())
        {
            if length > limit {
                return Err(fail(413, "request entity too large"));
            }
        }
    }
    let raw = collect(
        body,
        if encoding == "identity" {
            limit
        } else {
            usize::MAX >> 1
        },
    )
    .await?;
    let bytes = match encoding.as_str() {
        "gzip" => inflate(flate2::read::GzDecoder::new(&raw[..]), limit)?,
        "deflate" => inflate(flate2::read::ZlibDecoder::new(&raw[..]), limit)?,
        _ => raw,
    };
    let decoded = match canonical.as_str() {
        "utf16le" => decode_utf16(&bytes, false),
        "utf16be" => decode_utf16(&bytes, true),
        "utf16" => decode_utf16(&bytes, utf16_big_endian(&bytes)),
        _ => String::from_utf8_lossy(&bytes).into_owned(),
    };
    // iconv-lite strips one leading BOM.
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
    if text.is_empty() {
        return Ok(empty);
    }
    let first = text
        .bytes()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'));
    if !matches!(first, Some(b'{') | Some(b'[')) {
        return Err(fail(400, "entity.parse.failed"));
    }
    js_json_value(text).ok_or_else(|| fail(400, "entity.parse.failed"))
}

/// iconv-lite's `utf-16` detection: a BOM decides; otherwise count code
/// units that look like ASCII in each byte order over the first 100.
fn utf16_big_endian(bytes: &[u8]) -> bool {
    match bytes {
        [0xff, 0xfe, ..] => return false,
        [0xfe, 0xff, ..] => return true,
        _ => {}
    }
    let (mut big, mut little) = (0, 0);
    for [first, second] in code_unit_bytes(bytes).take(100) {
        if first == 0 && second != 0 {
            big += 1;
        }
        if first != 0 && second == 0 {
            little += 1;
        }
    }
    big > little
}

/// `Buffer.toString('utf16le')` (or the byte-swapped form): a trailing odd
/// byte is dropped. A lone surrogate becomes U+FFFD, which is what every
/// Rust kernel would make of it anyway (json_lenient).
fn decode_utf16(bytes: &[u8], big_endian: bool) -> String {
    let units: Vec<u16> = code_unit_bytes(bytes)
        .map(|pair| {
            if big_endian {
                u16::from_be_bytes(pair)
            } else {
                u16::from_le_bytes(pair)
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// Whole two-byte code units; a trailing odd byte is dropped.
fn code_unit_bytes(bytes: &[u8]) -> impl Iterator<Item = [u8; 2]> + '_ {
    (0..bytes.len() / 2).map(move |index| [bytes[2 * index], bytes[2 * index + 1]])
}

/// `JSON.parse(text)` with JS semantics (f64 numbers, lone surrogates,
/// duplicate keys), seen through `JSON.stringify` as the JSON-safe value the
/// Rust kernels take (a lone surrogate becomes U+FFFD, like json_lenient).
pub fn js_json_value(text: &str) -> Option<Value> {
    let parsed = multicc_core::js::json_parse(text).ok()?;
    let canonical = multicc_core::js::json_stringify(&parsed)?;
    multicc_core::json_lenient::from_str(&canonical).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_matches_the_etag_package() {
        // require('etag')('{"ok":true}', { weak: true })
        assert_eq!(
            weak_etag(b"{\"ok\":true}"),
            "W/\"b-Ai2R8hgEarLmHKwesT1qcY913ys\""
        );
        assert_eq!(weak_etag(b""), "W/\"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk\"");
    }

    #[test]
    fn freshness_follows_the_fresh_package() {
        let etag = "W/\"b-x\"";
        let with = |pairs: &[(&str, &str)]| {
            NodeHeaders::from_raw(pairs.iter().map(|(n, v)| (*n, v.as_bytes())))
        };
        assert!(!fresh(&with(&[]), etag));
        assert!(fresh(&with(&[("if-none-match", "W/\"b-x\"")]), etag));
        assert!(fresh(&with(&[("if-none-match", "\"a\", W/\"b-x\"")]), etag));
        assert!(fresh(&with(&[("if-none-match", "*")]), etag));
        assert!(!fresh(&with(&[("if-none-match", "\"a\"")]), etag));
        assert!(!fresh(
            &with(&[
                ("if-none-match", "W/\"b-x\""),
                ("cache-control", "no-cache")
            ]),
            etag
        ));
        assert!(!fresh(
            &with(&[("if-modified-since", "Sat, 01 Jan 2000 00:00:00 GMT")]),
            etag
        ));
    }

    #[test]
    fn js_parse_keeps_js_number_semantics() {
        assert_eq!(
            js_json_value("{\"a\":1e400}").unwrap(),
            serde_json::json!({"a": null})
        );
        assert_eq!(
            js_json_value("{\"a\":1,\"a\":2}").unwrap(),
            serde_json::json!({"a": 2})
        );
        assert_eq!(
            js_json_value("[\"\\ud834x\"]").unwrap(),
            serde_json::json!(["\u{fffd}x"])
        );
        assert!(js_json_value("{bad").is_none());
    }
}
