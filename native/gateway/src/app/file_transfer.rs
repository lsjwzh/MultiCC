//! `GET/HEAD /api/files` and `POST /api/upload`, retired from
//! `src/routes/file-transfer.js` (`createFilesHandler` / `createUploadHandler`)
//! together with the multer pipeline that lived in `src/upload-middleware.js`.
//!
//! Everything a client can observe is decided here: Express route matching,
//! the `req.query.*.trim` semantics (including the TypeError an array query
//! throws), the directory listing shape and its `parent`, the multipart parser
//! with multer 2.2 / busboy 1.6 limits, the media-type policy, the
//! temp-directory quota, upload file naming, and the exact error table.
//!
//! Two facts stay on the Node side:
//!
//! * `/api/files` reads the in-process session table (`sessions` /
//!   `persistedSessions`) when only `?session=` is given, and orders entries
//!   with ICU `localeCompare` — a collation Rust cannot reproduce byte for
//!   byte. `src/routes/file-transfer-host.js` resolves the directory and
//!   returns its already-ordered entries; this module still owns the response
//!   shape, `parent`, status codes and the 400 error mapping.
//! * `POST /api/upload` needs no host round trip. The admission gate's slot is
//!   held for the parse and the write and released when the response is built,
//!   where Node released it on `res` `finish`/`close`; a concurrent burst sees
//!   the same 429 either way, one flush later.
//!
//! Body differences from the Node stack that are deliberate and bounded: the
//! whole multipart body is buffered (Node streamed it) with a 1 MiB allowance
//! over the 25 MiB file limit, so an oversized upload is rejected after at most
//! 26 MiB instead of being read to the end.

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{query_param, QueryParam};
use multicc_core::js::string::js_trim;
use serde_json::{json, Value};

use super::express::{self, RequestCtx};
use super::uploads;
use crate::host_port;

/// The host port the Node child serves (`src/routes/file-transfer-host.js`).
const HOST_PATH: &str = "/api/__host/file-transfer";

const MIB: usize = 1024 * 1024;
/// `UPLOAD_LIMITS` in the retired `src/upload-middleware.js`.
const FILE_SIZE_LIMIT: usize = 25 * MIB;
const MAX_ACTIVE_UPLOADS: usize = 4;
const TEMP_FILES_LIMIT: usize = 200;
const TEMP_BYTES_LIMIT: u64 = 512 * MIB as u64;
const FIELD_NAME_LIMIT: usize = 64;
const HEADER_PAIRS_LIMIT: usize = 100;
/// The file limit plus room for the boundary and part headers.
const MAX_BODY_BYTES: usize = FILE_SIZE_LIMIT + MIB;

const CHAT_APPLICATION_TYPES: [&str; 17] = [
    "application/octet-stream",
    "application/pdf",
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/zip",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    Files,
    Upload,
}

impl Route {
    /// Express's automatic OPTIONS lists the methods registered on the path.
    pub fn allow(self) -> &'static str {
        match self {
            Route::Files => "GET,HEAD",
            Route::Upload => "POST",
        }
    }
}

pub enum Claim {
    Handle(Route),
    Options(Route),
}

/// Express matched these paths case-insensitively with one optional trailing
/// slash; another method on the same path stayed in Node (404 there).
pub fn claim(method: &Method, path: &str) -> Option<Claim> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.eq_ignore_ascii_case("files") {
        return match method.as_str() {
            "GET" | "HEAD" => Some(Claim::Handle(Route::Files)),
            "OPTIONS" => Some(Claim::Options(Route::Files)),
            _ => None,
        };
    }
    if rest.eq_ignore_ascii_case("upload") {
        return match method.as_str() {
            "POST" => Some(Claim::Handle(Route::Upload)),
            "OPTIONS" => Some(Claim::Options(Route::Upload)),
            _ => None,
        };
    }
    None
}

// ── GET /api/files ─────────────────────────────────────────────────────────

/// `(req.query[name] || '').trim()`; an array or nested object has no `trim`
/// method and the retired handler threw on it.
fn query_text(ctx: &RequestCtx, name: &str) -> Result<String, String> {
    match query_param(&ctx.original_url, name) {
        QueryParam::Missing => Ok(String::new()),
        QueryParam::Text(text) => Ok(js_trim(&text).to_string()),
        QueryParam::Other => Err(format!("req.query.{name}.trim is not a function")),
    }
}

fn internal(ctx: &RequestCtx, detail: &str) -> Response<Body> {
    express::error(ctx, 500, detail)
}

pub async fn files(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let path = match query_text(ctx, "path") {
        Ok(path) => path,
        Err(message) => return internal(ctx, &message),
    };
    let session = match query_text(ctx, "session") {
        Ok(session) => session,
        Err(message) => return internal(ctx, &message),
    };
    let answer = match host_port::call(
        host,
        HOST_PATH,
        &json!({ "op": "files", "path": path, "session": session }),
    )
    .await
    {
        Ok(answer) => answer,
        Err(_) => return internal(ctx, "file transfer host port unavailable"),
    };
    if answer.get("ok") != Some(&Value::Bool(true)) {
        // `res.status(400).json({ error: error.message })` for a listing that
        // threw in Node; anything else is a host-side fault.
        return match answer.get("message").and_then(Value::as_str) {
            Some(message) => express::json(ctx, 400, &json!({ "error": message }), &[]),
            None => internal(ctx, "file transfer host port returned no answer"),
        };
    }
    let dir = answer
        .get("dir")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let parent = match parent_of(&dir) {
        Some(parent) => Value::String(parent),
        None => Value::Null,
    };
    let files = answer
        .get("entries")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    express::json(
        ctx,
        200,
        &json!({ "path": dir, "parent": parent, "files": files }),
        &[],
    )
}

/// `dirPath !== path.parse(dirPath).root ? path.dirname(dirPath) : null`.
#[cfg(windows)]
fn parent_of(dir: &str) -> Option<String> {
    parent_of_with(dir, true)
}

#[cfg(not(windows))]
fn parent_of(dir: &str) -> Option<String> {
    parent_of_with(dir, false)
}

/// `path.parse(dir).root` for the platform whose separator rules are selected.
fn root_of(dir: &str, windows: bool) -> &str {
    if windows {
        if dir.starts_with("\\\\") || dir.starts_with("//") {
            // UNC: the root is `\\server\share\` (or the whole path when it
            // never gets that far).
            let rest = &dir[2..];
            let mut separators = 0;
            for (index, ch) in rest.char_indices() {
                if ch == '\\' || ch == '/' {
                    separators += 1;
                    if separators == 2 {
                        return &dir[..2 + index + 1];
                    }
                }
            }
            return dir;
        }
        let bytes = dir.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' {
            if bytes.len() >= 3 && (bytes[2] == b'\\' || bytes[2] == b'/') {
                return &dir[..3];
            }
            return &dir[..2];
        }
        return if bytes.first() == Some(&b'\\') || bytes.first() == Some(&b'/') {
            &dir[..1]
        } else {
            ""
        };
    }
    if dir.starts_with('/') {
        "/"
    } else {
        ""
    }
}

/// `path.dirname` for the platform whose separator rules are selected.
fn dirname_of(dir: &str, windows: bool) -> String {
    let root = root_of(dir, windows);
    let is_separator = |ch: char| ch == '/' || (windows && ch == '\\');
    let mut end = dir.len();
    while end > root.len() {
        let last = dir[..end].chars().next_back().expect("non-empty prefix");
        if !is_separator(last) {
            break;
        }
        end -= last.len_utf8();
    }
    let body = &dir[root.len()..end];
    if body.is_empty() {
        return if root.is_empty() {
            ".".to_string()
        } else {
            root.to_string()
        };
    }
    match body.char_indices().rev().find(|(_, ch)| is_separator(*ch)) {
        Some((index, _)) => {
            let mut trimmed = &dir[..root.len() + index];
            while trimmed.len() > root.len() {
                let last = trimmed.chars().next_back().expect("non-empty prefix");
                if !is_separator(last) {
                    break;
                }
                trimmed = &trimmed[..trimmed.len() - last.len_utf8()];
            }
            if trimmed.is_empty() {
                "/".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => {
            if root.is_empty() {
                ".".to_string()
            } else {
                root.to_string()
            }
        }
    }
}

fn parent_of_with(dir: &str, windows: bool) -> Option<String> {
    if dir == root_of(dir, windows) {
        return None;
    }
    Some(dirname_of(dir, windows))
}

// ── POST /api/upload ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct Failure {
    status: u16,
    code: &'static str,
    message: &'static str,
}

impl Failure {
    const fn failed() -> Self {
        Self {
            status: 500,
            code: "UPLOAD_FAILED",
            message: "upload failed",
        }
    }
    const fn too_large() -> Self {
        Self {
            status: 413,
            code: "UPLOAD_FILE_TOO_LARGE",
            message: "upload exceeds 25 MiB limit",
        }
    }
    const fn too_many_parts() -> Self {
        Self {
            status: 400,
            code: "UPLOAD_TOO_MANY_PARTS",
            message: "exactly one file and no fields are allowed",
        }
    }
    const fn unexpected_field() -> Self {
        Self {
            status: 400,
            code: "UPLOAD_UNEXPECTED_FIELD",
            message: "expected one file field named file",
        }
    }
    const fn field_invalid() -> Self {
        Self {
            status: 400,
            code: "UPLOAD_FIELD_INVALID",
            message: "multipart field exceeds limits",
        }
    }
    const fn unsupported_media_type() -> Self {
        Self {
            status: 415,
            code: "UPLOAD_UNSUPPORTED_MEDIA_TYPE",
            message: "unsupported upload media type",
        }
    }
    const fn quota_exceeded() -> Self {
        Self {
            status: 507,
            code: "UPLOAD_STORAGE_QUOTA_EXCEEDED",
            message: "temporary upload quota exceeded",
        }
    }
    const fn busy() -> Self {
        Self {
            status: 429,
            code: "UPLOAD_BUSY",
            message: "too many concurrent uploads",
        }
    }
}

fn failure_response(ctx: &RequestCtx, failure: Failure) -> Response<Body> {
    let body = json!({ "error": failure.message, "code": failure.code });
    if failure.status == 429 {
        return express::json(ctx, 429, &body, &[("Connection", "close")]);
    }
    express::json(ctx, failure.status, &body, &[])
}

/// `if (!req.file) return res.status(400).json({ error: 'No file' })` — no
/// `code` key on this path.
fn no_file(ctx: &RequestCtx) -> Response<Body> {
    express::json(ctx, 400, &json!({ "error": "No file" }), &[])
}

/// `createAdmissionGate(UPLOAD_LIMITS.maxActive)`: four concurrent uploads.
struct Admission;

/// Active uploads, process wide, like the gate's closure counter.
static ACTIVE_UPLOADS: AtomicUsize = AtomicUsize::new(0);

impl Admission {
    fn acquire() -> Option<Self> {
        let mut current = ACTIVE_UPLOADS.load(Ordering::Relaxed);
        loop {
            if current >= MAX_ACTIVE_UPLOADS {
                return None;
            }
            match ACTIVE_UPLOADS.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Some(Self),
                Err(actual) => current = actual,
            }
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        ACTIVE_UPLOADS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The `boundary` parameter, quotes aware.
fn boundary_of(content_type: &str) -> Option<String> {
    for parameter in split_params(content_type).into_iter().skip(1) {
        let Some((name, value)) = parameter.split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("boundary") {
            return Some(unquote(value.trim()));
        }
    }
    None
}

fn split_params(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (index, ch) in text.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                parts.push(&text[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        return value[1..value.len() - 1].to_string();
    }
    value.to_string()
}

/// busboy decodes header bytes as latin1 (`defParamCharset` defaults to it,
/// multer passes no override), which is what makes a UTF-8 file name arrive as
/// the same mojibake the Node route answered with.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| *byte as char).collect()
}

#[derive(Debug)]
struct FilePart {
    filename: String,
    data: Vec<u8>,
}

fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|index| from + index)
}

/// What busboy hands to multer for one part.
struct PartHeaders {
    /// `None` when the disposition carried no `name` parameter, or an empty
    /// one (`if (disp.params.name)` is falsy for `""`).
    name: Option<String>,
    /// `None` when the disposition carried no filename (or an empty one, which
    /// busboy ignores). `Some("")` happens when the raw name basenamed down to
    /// nothing, e.g. `/`.
    filename: Option<String>,
    content_type: Option<String>,
}

/// `None` is busboy's `skipPart`: no `content-disposition`, or one that is not
/// `form-data`. Such a part consumes no file or field slot and multer never
/// sees it.
fn part_headers(block: &[u8]) -> Result<Option<PartHeaders>, Failure> {
    let mut pairs = 0usize;
    let mut disposition: Option<String> = None;
    let mut content_type: Option<String> = None;
    for line in block.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        pairs += 1;
        if pairs > HEADER_PAIRS_LIMIT {
            return Err(Failure::failed());
        }
        let Some(colon) = line.iter().position(|byte| *byte == b':') else {
            return Err(Failure::failed());
        };
        let name = latin1(&line[..colon]).trim().to_ascii_lowercase();
        let value = latin1(&line[colon + 1..]).trim().to_string();
        // busboy reads `header[name][0]`, so a repeated header keeps the first.
        match name.as_str() {
            "content-disposition" if disposition.is_none() => disposition = Some(value),
            "content-type" if content_type.is_none() => content_type = Some(value),
            _ => {}
        }
    }
    let Some(disposition) = disposition else {
        return Ok(None);
    };
    let mut parameters = split_params(&disposition).into_iter();
    let kind = parameters.next().unwrap_or("").trim().to_ascii_lowercase();
    if kind != "form-data" {
        return Ok(None);
    }
    let mut name: Option<String> = None;
    let mut filename: Option<String> = None;
    let mut extended: Option<String> = None;
    for parameter in parameters {
        let Some((key, value)) = parameter.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "name" => name = non_empty(unquote(value.trim())),
            "filename" => filename = non_empty(unquote(value.trim())),
            "filename*" => extended = extended_filename(value.trim()),
            _ => {}
        }
    }
    // `if (disp.params['filename*']) filename = ...; else if (disp.params.filename)`
    let filename = extended.or(filename).map(|raw| path_basename(&raw));
    Ok(Some(PartHeaders {
        name,
        filename,
        content_type,
    }))
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// busboy basenames the raw filename (`preservePath` is off), splitting on `/`
/// only, before multer's `safeOriginalName` sees it.
fn path_basename(value: &str) -> String {
    value.rsplit('/').next().unwrap_or("").to_string()
}

/// The `filename*` extended value: `charset'lang'percent-encoded`. busboy
/// percent-decodes it and transcodes from `charset`; UTF-8 is the only charset
/// a browser sends, anything else falls back to one byte per character.
fn extended_filename(value: &str) -> Option<String> {
    let mut fields = value.splitn(3, '\'');
    let charset = fields.next()?.trim().to_ascii_lowercase();
    fields.next()?;
    let encoded = fields.next()?;
    let bytes = percent_decode(encoded)?;
    let text = if charset.is_empty() || charset == "utf-8" || charset == "utf8" {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        latin1(&bytes)
    };
    non_empty(text)
}

fn percent_decode(value: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut chars = value.bytes();
    while let Some(byte) = chars.next() {
        if byte != b'%' {
            bytes.push(byte);
            continue;
        }
        let high = chars.next()?;
        let low = chars.next()?;
        bytes.push((hex_value(high)? << 4) | hex_value(low)?);
    }
    Some(bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// busboy's `partType`: the parsed `type/subtype`, lowercased, falling back to
/// `text/plain` when the header is absent or malformed.
fn part_type(content_type: Option<&str>) -> String {
    let Some(value) = content_type else {
        return "text/plain".to_string();
    };
    let essence = value.split(';').next().unwrap_or("").trim();
    let Some((kind, subtype)) = essence.split_once('/') else {
        return "text/plain".to_string();
    };
    if !is_token(kind) || !is_token(subtype) {
        return "text/plain".to_string();
    }
    format!(
        "{}/{}",
        kind.to_ascii_lowercase(),
        subtype.to_ascii_lowercase()
    )
}

fn is_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

/// The one file part of a chat upload; `Ok(None)` means the form carried no
/// file at all and multer left `req.file` undefined.
fn parse_multipart(raw: &[u8], boundary: &str) -> Result<Option<FilePart>, Failure> {
    let mut delimiter = b"--".to_vec();
    delimiter.extend_from_slice(boundary.as_bytes());
    let mut terminator = b"\r\n".to_vec();
    terminator.extend_from_slice(&delimiter);

    let first = find_from(raw, &delimiter, 0).ok_or_else(Failure::failed)?;
    let mut cursor = first + delimiter.len();
    let mut file: Option<FilePart> = None;
    let mut parts = 0usize;
    loop {
        if raw[cursor..].starts_with(b"--") {
            return Ok(file);
        }
        if !raw[cursor..].starts_with(b"\r\n") {
            return Err(Failure::failed());
        }
        cursor += 2;
        let header_end = find_from(raw, b"\r\n\r\n", cursor).ok_or_else(Failure::failed)?;
        let headers = part_headers(&raw[cursor..header_end])?;
        let content_start = header_end + 4;
        let next = find_from(raw, &terminator, content_start).ok_or_else(Failure::failed)?;
        let data = &raw[content_start..next];
        cursor = next + terminator.len();

        // `limits.parts: 2` counts the separators: the second part of any kind
        // trips one of busboy's three limits (a second file trips filesLimit, a
        // second field fieldsLimit, a skipped part partsLimit) and all three
        // map to the same answer, so the part itself never has to be looked at.
        parts += 1;
        if parts >= 2 {
            return Err(Failure::too_many_parts());
        }

        // A part without a form-data disposition is ignored entirely.
        let Some(headers) = headers else {
            continue;
        };
        let part_type = part_type(headers.content_type.as_deref());
        let is_file = headers.filename.is_some() || part_type == "application/octet-stream";
        if !is_file {
            // `fields: 0`: the first non-file part is over the limit, before
            // multer ever runs its field-name checks.
            return Err(Failure::too_many_parts());
        }
        let Some(name) = headers.name else {
            // multer's file handler aborts on a part with no field name.
            return Err(Failure::failed());
        };
        let Some(filename) = headers.filename else {
            // An octet-stream part with no filename at all: multer resumes it.
            continue;
        };
        if filename.is_empty() {
            // `if (!filename) return fileStream.resume()` — before the field
            // name length check and the file filter.
            continue;
        }
        if name.len() > FIELD_NAME_LIMIT {
            return Err(Failure::field_invalid());
        }
        if name != "file" {
            return Err(Failure::unexpected_field());
        }
        if !chat_mime_allowed(&part_type) {
            return Err(Failure::unsupported_media_type());
        }
        // busboy emits `limit` the moment the byte count *reaches* the cap.
        if data.len() >= FILE_SIZE_LIMIT {
            return Err(Failure::too_large());
        }
        file = Some(FilePart {
            filename,
            data: data.to_vec(),
        });
    }
}

fn chat_mime_allowed(mime: &str) -> bool {
    ["image/", "text/", "audio/", "video/"]
        .iter()
        .any(|prefix| mime.starts_with(prefix))
        || CHAT_APPLICATION_TYPES.contains(&mime)
}

/// `safeOriginalName`.
fn sanitize_name(value: &str) -> String {
    let portable: String = value
        .chars()
        .map(|ch| if ch == '\\' { '/' } else { ch })
        .collect();
    let base = portable.rsplit('/').next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|ch| !matches!(*ch, '\u{0}'..='\u{1f}' | '\u{7f}'))
        .take(255)
        .collect();
    if cleaned.is_empty() {
        "upload.bin".to_string()
    } else {
        cleaned
    }
}

/// `path.posix.extname`, ported branch for branch.
fn extname(path: &str) -> String {
    let chars: Vec<char> = path.chars().collect();
    let (mut start_dot, mut start_part, mut end, mut matched_slash, mut pre_dot) =
        (-1i64, 0i64, -1i64, true, 0i64);
    for index in (0..chars.len()).rev() {
        let code = chars[index];
        if code == '/' {
            if !matched_slash {
                start_part = index as i64 + 1;
                break;
            }
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = index as i64 + 1;
        }
        if code == '.' {
            if start_dot == -1 {
                start_dot = index as i64;
            } else if pre_dot != 1 {
                pre_dot = 1;
            }
        } else if start_dot != -1 {
            pre_dot = -1;
        }
    }
    if start_dot == -1
        || end == -1
        || pre_dot == 0
        || (pre_dot == 1 && start_dot == end - 1 && start_dot == start_part + 1)
    {
        return String::new();
    }
    chars[start_dot as usize..end as usize].iter().collect()
}

/// `path.extname(name).replace(/[^a-z0-9.]/gi, '').slice(0, 12) || '.bin'`,
/// then prefixed with a dot when the sanitized suffix does not start with one.
fn upload_extension(name: &str) -> String {
    let cleaned: String = extname(name)
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '.')
        .take(12)
        .collect();
    if cleaned.is_empty() {
        ".bin".to_string()
    } else if cleaned.starts_with('.') {
        cleaned
    } else {
        format!(".{cleaned}")
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn unique_name(extension: &str) -> Result<String, Failure> {
    let mut random = [0u8; 4];
    getrandom::fill(&mut random).map_err(|_| Failure::failed())?;
    let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("multicc_{}_{hex}{extension}", now_ms()))
}

fn write_exclusive(target: &str, data: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(target)?;
    handle.write_all(data)
}

/// `persistChatUpload`: quota, name, three `wx` attempts.
fn persist(file: &FilePart) -> Result<(String, String), Failure> {
    let dir = uploads::tmpdir();
    let (count, bytes) = uploads::temp_usage(&dir).map_err(|_| Failure::failed())?;
    if count >= TEMP_FILES_LIMIT || bytes + file.data.len() as u64 > TEMP_BYTES_LIMIT {
        return Err(Failure::quota_exceeded());
    }
    let name = sanitize_name(&file.filename);
    let extension = upload_extension(&name);
    for attempt in 0..3 {
        let target = uploads::join(&dir, &unique_name(&extension)?);
        match write_exclusive(&target, &file.data) {
            Ok(()) => return Ok((target, name)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 2 => {}
            Err(_) => return Err(Failure::failed()),
        }
    }
    Err(Failure::failed())
}

/// `POST /api/upload`. Dispatched before the global `express.json` because
/// multer owns the raw multipart body; a JSON body still goes through
/// `express.json` first, exactly where it did in the Node stack.
pub async fn upload(ctx: &RequestCtx, body: Body) -> Response<Body> {
    let content_type = ctx.headers.get("content-type").unwrap_or("");
    let essence = express::media_type(content_type).0;
    if essence == "application/json" {
        if let Err(error) = express::json_body(ctx, body, express::JSON_LIMIT).await {
            return express::error(ctx, error.status, error.reason);
        }
        return no_file(ctx);
    }
    if essence != "multipart/form-data" {
        return no_file(ctx);
    }
    let Some(_slot) = Admission::acquire() else {
        return failure_response(ctx, Failure::busy());
    };
    let boundary = match boundary_of(content_type) {
        Some(boundary) if !boundary.is_empty() => boundary,
        _ => return failure_response(ctx, Failure::failed()),
    };
    let raw = match express::collect(body, MAX_BODY_BYTES).await {
        Ok(raw) => raw,
        Err(error) if error.status == 413 => return failure_response(ctx, Failure::too_large()),
        Err(error) => return express::error(ctx, error.status, error.reason),
    };
    let file = match parse_multipart(&raw, &boundary) {
        Ok(Some(file)) => file,
        Ok(None) => return no_file(ctx),
        Err(failure) => return failure_response(ctx, failure),
    };
    match persist(&file) {
        Ok((path, name)) => {
            println!("[multicc] Uploaded: {path} ({name})");
            express::json(ctx, 200, &json!({ "path": path, "name": name }), &[])
        }
        Err(failure) => failure_response(ctx, failure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One part: field name, optional (file name, media type), bytes.
    type Part<'a> = (&'a str, Option<(&'a str, &'a str)>, &'a [u8]);

    fn multipart(boundary: &str, parts: &[Part<'_>]) -> Vec<u8> {
        let mut body = Vec::new();
        for (name, file, data) in parts {
            body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            match file {
                Some((filename, mime)) => body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n\
                         Content-Type: {mime}\r\n\r\n"
                    )
                    .as_bytes(),
                ),
                None => body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                ),
            }
            body.extend_from_slice(data);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        body
    }

    /// Parts whose header block the caller spells out verbatim.
    fn multipart_raw(boundary: &str, parts: &[(&str, &[u8])]) -> Vec<u8> {
        let mut body = Vec::new();
        for (head, data) in parts {
            body.extend_from_slice(format!("--{boundary}\r\n{head}\r\n\r\n").as_bytes());
            body.extend_from_slice(data);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        body
    }

    #[test]
    fn extname_matches_node() {
        assert_eq!(extname("a.png"), ".png");
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(extname("a."), ".");
        assert_eq!(extname("a.."), ".");
        assert_eq!(extname(".."), "");
        assert_eq!(extname("dir.b/a"), "");
        assert_eq!(extname("dir/a.b.c"), ".c");
        assert_eq!(extname(""), "");
        assert_eq!(extname(".a.b"), ".b");
    }

    #[test]
    fn upload_name_policy() {
        assert_eq!(sanitize_name(""), "upload.bin");
        assert_eq!(sanitize_name("..\\..\\etc\\passwd"), "passwd");
        assert_eq!(sanitize_name("a/b/"), "upload.bin");
        assert_eq!(sanitize_name("x\u{1}y.png"), "xy.png");
        assert_eq!(upload_extension("a.png"), ".png");
        assert_eq!(upload_extension("a"), ".bin");
        assert_eq!(upload_extension("a.t?x"), ".tx");
        assert_eq!(upload_extension(".hidden"), ".bin");
    }

    #[test]
    fn parent_rules() {
        assert_eq!(parent_of_with("/a/b", false), Some("/a".to_string()));
        assert_eq!(parent_of_with("/a", false), Some("/".to_string()));
        assert_eq!(parent_of_with("/", false), None);
        assert_eq!(parent_of_with("C:\\a\\b", true), Some("C:\\a".to_string()));
        assert_eq!(parent_of_with("C:\\a", true), Some("C:\\".to_string()));
        assert_eq!(parent_of_with("C:\\", true), None);
        assert_eq!(
            parent_of_with("\\\\host\\share\\x", true),
            Some("\\\\host\\share\\".to_string())
        );
        assert_eq!(parent_of_with("\\\\host\\share\\", true), None);
    }

    #[test]
    fn one_chat_file_parses() {
        let body = multipart("X", &[("file", Some(("a.png", "image/png")), b"data")]);
        let file = parse_multipart(&body, "X").unwrap().expect("one file");
        assert_eq!(file.filename, "a.png");
        assert_eq!(file.data, b"data");
    }

    #[test]
    fn empty_form_has_no_file() {
        let body = b"--X--\r\n".to_vec();
        assert!(parse_multipart(&body, "X").unwrap().is_none());
    }

    /// The error table of the retired pipeline, taken from the oracle run in
    /// docs/rust-migration/differential/file-transfer.js against the frozen
    /// multer stack (`tests/helpers/legacy-file-transfer-routes.js`).
    #[test]
    fn policy_errors_match_the_table() {
        let code = |body: &[u8]| match parse_multipart(body, "X") {
            Ok(_) => "ok".to_string(),
            Err(failure) => failure.code.to_string(),
        };
        let status = |body: Vec<u8>| match parse_multipart(&body, "X") {
            Ok(_) => 200,
            Err(failure) => failure.status,
        };
        let file = || ("file", Some(("a.png", "image/png")), b"d" as &[u8]);

        // A first file part must be named `file`.
        let other = multipart("X", &[("other", Some(("a.png", "image/png")), b"d")]);
        assert_eq!(code(&other), "UPLOAD_UNEXPECTED_FIELD");

        // `fields: 0` rejects the first non-file part before any name check.
        let field = multipart("X", &[("note", None, b"d")]);
        assert_eq!(code(&field), "UPLOAD_TOO_MANY_PARTS");
        let long_field = "a".repeat(65);
        let field = multipart_raw(
            "X",
            &[(
                &format!("Content-Disposition: form-data; name=\"{long_field}\""),
                b"d",
            )],
        );
        assert_eq!(code(&field), "UPLOAD_TOO_MANY_PARTS");

        // A second part of any kind is one part too many: two files, a field
        // after a file, a file after a field, or a part with no disposition.
        let two_files = multipart("X", &[file(), file()]);
        assert_eq!(code(&two_files), "UPLOAD_TOO_MANY_PARTS");
        let field_after = multipart("X", &[file(), ("note", None, b"d")]);
        assert_eq!(code(&field_after), "UPLOAD_TOO_MANY_PARTS");
        let file_after = multipart("X", &[("note", None, b"d"), file()]);
        assert_eq!(code(&file_after), "UPLOAD_TOO_MANY_PARTS");
        let junk_after = multipart_raw(
            "X",
            &[
                (
                    "Content-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n\
                     Content-Type: image/png",
                    b"d",
                ),
                ("Content-Type: text/plain", b"d"),
            ],
        );
        assert_eq!(code(&junk_after), "UPLOAD_TOO_MANY_PARTS");

        // The media-type allowlist only runs on a file that survived the
        // name checks.
        let binary = multipart(
            "X",
            &[("file", Some(("a.exe", "application/x-msdownload")), b"d")],
        );
        assert_eq!(status(binary), 415);

        // `fieldNameSize: 64`, checked after the missing-filename skip.
        let long_file = multipart(
            "X",
            &[(long_field.as_str(), Some(("a.png", "image/png")), b"d")],
        );
        assert_eq!(code(&long_file), "UPLOAD_FIELD_INVALID");
        let long_empty = multipart(
            "X",
            &[(long_field.as_str(), Some(("", "text/plain")), b"d")],
        );
        assert_eq!(code(&long_empty), "UPLOAD_TOO_MANY_PARTS");

        // An empty filename is not a file at all (`if (disp.params.filename)`
        // is falsy), so the part is a field and dies on the field limit; a
        // filename that basenames to nothing (`/`) is a file multer resumes.
        let empty_filename = multipart("X", &[("file", Some(("", "text/plain")), b"d")]);
        assert_eq!(code(&empty_filename), "UPLOAD_TOO_MANY_PARTS");
        let slash_filename = multipart_raw(
            "X",
            &[(
                "Content-Disposition: form-data; name=\"file\"; filename=\"/\"\r\n\
                 Content-Type: image/png",
                b"d",
            )],
        );
        assert_eq!(code(&slash_filename), "ok");

        // An octet-stream part with no filename is a file busboy emits and
        // multer resumes: no bytes stored, so the form has no file.
        let octet = multipart_raw(
            "X",
            &[(
                "Content-Disposition: form-data; name=\"file\"\r\n\
                 Content-Type: application/octet-stream",
                b"d",
            )],
        );
        assert_eq!(code(&octet), "ok");
        assert!(parse_multipart(&octet, "X").unwrap().is_none());

        // A part with no form-data disposition is skipped, so a lone one
        // leaves the form empty.
        let skipped = multipart_raw("X", &[("Content-Type: text/plain", b"d")]);
        assert_eq!(code(&skipped), "ok");
        assert!(parse_multipart(&skipped, "X").unwrap().is_none());

        // multer aborts on a part without a field name.
        let unnamed = multipart_raw(
            "X",
            &[(
                "Content-Disposition: form-data; filename=\"a.png\"\r\n\
                 Content-Type: image/png",
                b"d",
            )],
        );
        assert_eq!(status(unnamed), 500);

        // busboy emits `limit` when the byte count reaches the cap.
        let exact = vec![b'x'; FILE_SIZE_LIMIT];
        let at_limit = multipart_raw(
            "X",
            &[(
                "Content-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n\
                 Content-Type: application/octet-stream",
                &exact,
            )],
        );
        assert_eq!(status(at_limit), 413);

        let truncated =
            b"--X\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a\"\r\n\r\ndata"
                .to_vec();
        assert_eq!(status(truncated), 500);
    }

    #[test]
    fn boundary_parameter_is_quotes_aware() {
        assert_eq!(
            boundary_of("multipart/form-data; charset=utf-8; boundary=\"a;b\"").as_deref(),
            Some("a;b")
        );
        assert_eq!(boundary_of("multipart/form-data").as_deref(), None);
    }
}
