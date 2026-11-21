//! Front-door recognition of "the remote screen's own screenshot" annotations
//! for `POST /api/annotation-live`.
//!
//! Ported from `src/remote-screen-rust.js` lines 494–521 (`isOwnShot`,
//! `handleAnnotation`) so the front door can answer an own-shot relay itself,
//! before the request reaches the Node host and before Node's relay would
//! consult the webhook configuration. That is the prerequisite for deleting
//! `src/remote-screen.js`'s annotation dependency.
//!
//! ```text
//! src resolves under DIR and is shot-<digits>.png
//!   -> POST 127.0.0.1:<port>/internal/annotation
//!          body: JSON.stringify(payload)   x-multicc-remote-secret: <secret>
//!   -> { relayed: 1, results: [child answer] }
//! ```
//!
//! The returned relay value is shaped exactly like the Node host's
//! `annotation-relay` answer, so [`multicc_core::event_routes::annotation_relay_body`]
//! can wrap it unchanged (it reads only `relayed` and `results`).
//!
//! Wired from `daemon.rs` into `App::remote_annotation` (a `OnceLock`) and
//! consulted by `app::event_routes` for `AnnotationLivePost`; [`RemoteAnnotation`]
//! owns its [`Arc<RemoteChild>`] and the resolved screenshot dir.

use std::net::Ipv4Addr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1::Builder as ClientBuilder;
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};

use multicc_core::js::serde::{js_json_stringify, value_or_empty};

use crate::remote_child::{Ready, RemoteChild};

/// `ANNOTATION_TIMEOUT_MS` in src/remote-screen-rust.js line 62.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(20_000);

/// `'不是远程屏幕截图'`: the path check failed.
pub const NOT_OWN_SHOT: &str = "不是远程屏幕截图";
/// `'远控服务不可用'`: `ensureStarted()` threw.
pub const SERVICE_UNAVAILABLE: &str = "远控服务不可用";
/// `'远控服务无响应'`: non-200, timeout, or an unusable answer body.
pub const NO_RESPONSE: &str = "远控服务无响应";

/// The own-shot relay handler a wired route would hold.
pub struct RemoteAnnotation {
    child: Arc<RemoteChild>,
    dir: PathBuf,
    timeout: Duration,
}

impl RemoteAnnotation {
    pub fn new(child: Arc<RemoteChild>, dir: impl Into<PathBuf>) -> Self {
        Self {
            child,
            dir: dir.into(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// Tests shrink the 20s budget.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn child(&self) -> &Arc<RemoteChild> {
        &self.child
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// `isOwnShot(payload.src)`: `String(src || '')`, then the directory must
    /// resolve to `DIR` and the file name must match `^shot-\d+\.png$`.
    pub fn is_own_shot(&self, payload: &Value) -> bool {
        is_own_shot(&source_of(payload), &self.dir)
    }

    /// The relay entry point: `Some({relayed:1,results:[answer]})` for an
    /// own-shot payload, `None` so the caller keeps going to Node. A miss never
    /// touches the child (no start attempt).
    pub async fn try_relay(&self, payload: &Value) -> Option<Value> {
        if !self.is_own_shot(payload) {
            return None;
        }
        let result = self.handle_annotation(payload).await;
        Some(json!({ "relayed": 1, "results": [result] }))
    }

    /// `handleAnnotation(payload)`: the path check runs again, then the child
    /// answers (or one of the three fixed failure shapes is returned).
    pub async fn handle_annotation(&self, payload: &Value) -> Value {
        if !self.is_own_shot(payload) {
            return failure(NOT_OWN_SHOT);
        }
        let ready = match self.child.ensure().await {
            Ok(ready) => ready,
            Err(_) => return failure(SERVICE_UNAVAILABLE),
        };
        // `JSON.stringify(payload)` — V8's serialization, not serde's.
        let body = js_json_stringify(payload).into_bytes();
        let Some((status, bytes)) = self.post(&ready, &body).await else {
            return failure(NO_RESPONSE);
        };
        if status != 200 {
            return failure(NO_RESPONSE);
        }
        let parsed: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return failure(NO_RESPONSE),
        };
        // `!result || typeof result !== 'object'`: `null`, numbers, strings and
        // booleans fail; arrays are `'object'` and pass through as the answer.
        match parsed {
            Value::Object(_) | Value::Array(_) => parsed,
            _ => failure(NO_RESPONSE),
        }
    }

    /// One POST to the child's loopback port, bounded by `timeout` as a whole
    /// (the retired module used the same budget as a socket idle timeout).
    async fn post(&self, ready: &Ready, body: &[u8]) -> Option<(u16, Vec<u8>)> {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/internal/annotation")
            .header("content-type", "application/json")
            .header("x-multicc-remote-secret", &ready.secret)
            .header("content-length", body.len().to_string())
            .body(Full::new(Bytes::copy_from_slice(body)))
            .ok()?;
        tokio::time::timeout(self.timeout, exchange(ready.port, request))
            .await
            .ok()?
    }
}

fn failure(text: &str) -> Value {
    json!({ "ok": false, "refresh": false, "text": text })
}

/// `String(payload.src || '')`.
fn source_of(payload: &Value) -> String {
    value_or_empty(payload.get("src"))
}

fn is_own_shot(src: &str, dir: &Path) -> bool {
    let file = resolve(src);
    if file.parent() != Some(resolve_path(dir).as_path()) {
        return false;
    }
    file.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_shot_name)
}

/// `/^shot-\d+\.png$/` — ASCII digits, nothing before or after.
fn is_shot_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("shot-") else {
        return false;
    };
    let Some(digits) = rest.strip_suffix(".png") else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// Node's `path.resolve(src)`: relative paths hang off the process cwd, `.`
/// and repeated separators collapse, `..` pops, a trailing separator is
/// dropped, and symlinks are never resolved.
fn resolve(src: &str) -> PathBuf {
    let path = Path::new(src);
    if path.is_absolute() {
        return normalize(path);
    }
    match std::env::current_dir() {
        Ok(cwd) => normalize(&cwd.join(path)),
        // No cwd (deleted, or not readable): the relative path stays relative,
        // which can never equal the resolved absolute DIR.
        Err(_) => normalize(path),
    }
}

/// `path.resolve(DIR)` for an already-built path.
fn resolve_path(dir: &Path) -> PathBuf {
    if dir.is_absolute() {
        return normalize(dir);
    }
    match std::env::current_dir() {
        Ok(cwd) => normalize(&cwd.join(dir)),
        Err(_) => normalize(dir),
    }
}

/// Normalization shared by [`resolve`] and [`resolve_path`]: drop `.`, apply
/// `..` (never above the root or a Windows prefix), collapse separators.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The HTTP exchange: connect, one request, read the whole answer.
async fn exchange(port: u16, request: Request<Full<Bytes>>) -> Option<(u16, Vec<u8>)> {
    let stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .ok()?;
    let _ = stream.set_nodelay(true);
    let (mut sender, connection) = ClientBuilder::new()
        .handshake::<_, Full<Bytes>>(TokioIo::new(stream))
        .await
        .ok()?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let response = sender.send_request(request).await.ok()?;
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .ok()?
        .to_bytes()
        .to_vec();
    Some((status, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = "/data/assist/remote-screen";

    #[test]
    fn own_shot_matches_the_js_path_check() {
        let dir = Path::new(DIR);
        assert!(is_own_shot("/data/assist/remote-screen/shot-12.png", dir));
        // `..`, `.` and repeated separators all resolve to the same file.
        assert!(is_own_shot(
            "/data/assist/remote-screen/sub/../shot-12.png",
            dir
        ));
        assert!(is_own_shot("/data/assist/remote-screen/./shot-12.png", dir));
        assert!(is_own_shot("/data/assist/remote-screen//shot-12.png", dir));
        // A trailing separator on the file itself is dropped by resolve.
        assert!(is_own_shot("/data/assist/remote-screen/shot-12.png/", dir));
        // `..` that leaves and returns still lands in DIR.
        assert!(is_own_shot(
            "/data/assist/remote-screen/../remote-screen/shot-1.png",
            dir
        ));
        assert!(is_own_shot("/../data/assist/remote-screen/shot-1.png", dir));
    }

    #[test]
    fn own_shot_rejects_everything_else() {
        let dir = Path::new(DIR);
        // Wrong directory, the directory itself, empty and non-shot names.
        assert!(!is_own_shot("/data/assist/remote-screen/other.png", dir));
        assert!(!is_own_shot(DIR, dir));
        assert!(!is_own_shot("/data/assist/remote-screen/", dir));
        assert!(!is_own_shot("/data/assist/remote-screen", dir));
        assert!(!is_own_shot("", dir));
        assert!(!is_own_shot(
            "/data/assist/remote-screen/shot-12.png.txt",
            dir
        ));
        assert!(!is_own_shot("/data/assist/remote-screen/xshot-1.png", dir));
        // The regex: ASCII digits only, exact prefix/suffix, at least one digit.
        assert!(!is_own_shot("/data/assist/remote-screen/shot-12.PNG", dir));
        assert!(!is_own_shot("/data/assist/remote-screen/shot-.png", dir));
        assert!(!is_own_shot("/data/assist/remote-screen/shot-1a.png", dir));
        assert!(!is_own_shot("/data/assist/remote-screen/shot-١.png", dir));
        // A parent that resolves outside DIR is a miss even with a shot name.
        assert!(!is_own_shot(
            "/data/assist/remote-screen/../shot-1.png",
            dir
        ));
        assert!(!is_own_shot(
            "/data/assist/remote-screen/sub/shot-1.png",
            dir
        ));
    }

    #[test]
    fn relative_paths_resolve_against_the_process_cwd() {
        let cwd = std::env::current_dir().expect("cwd");
        // The same file expressed relative to cwd is an own shot only if cwd
        // really is DIR; either way it is the resolved absolute path that the
        // check compares, exactly like path.resolve.
        let dir = cwd.join("remote-screen");
        let absolute = dir.join("shot-7.png");
        assert!(is_own_shot(absolute.to_str().expect("utf8"), &dir));
        assert!(!is_own_shot("remote-screen/shot-7.png", Path::new(DIR)));
        assert!(is_own_shot("remote-screen/shot-7.png", &dir));
        assert!(!is_own_shot("shot-7.png", &dir));
    }

    #[test]
    fn non_string_sources_coerce_like_js() {
        let dir = Path::new(DIR);
        // String(value || '') for the JSON shapes a client can send.
        assert_eq!(value_or_empty(Some(&json!(null))), "");
        assert_eq!(value_or_empty(Some(&json!(0))), "");
        assert_eq!(value_or_empty(Some(&json!(false))), "");
        assert_eq!(value_or_empty(Some(&json!(123))), "123");
        assert_eq!(value_or_empty(Some(&json!(true))), "true");
        assert_eq!(value_or_empty(Some(&json!({"a": 1}))), "[object Object]");
        assert_eq!(value_or_empty(Some(&json!([1, 2]))), "1,2");
        for source in [json!(null), json!(0), json!(false), json!(123), json!([1])] {
            assert!(!is_own_shot(&value_or_empty(Some(&source)), dir));
        }
    }

    #[test]
    fn a_one_element_array_source_joins_into_the_path_like_js() {
        // `String(["<dir>/shot-1.png"])` is the path itself, so in JS a
        // one-element array is indistinguishable from the string. Two elements
        // join with a comma and no longer match.
        let dir = Path::new(DIR);
        let shot = "/data/assist/remote-screen/shot-1.png";
        assert!(is_own_shot(&value_or_empty(Some(&json!([shot]))), dir));
        assert!(!is_own_shot(
            &value_or_empty(Some(&json!([shot, "x"]))),
            dir
        ));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_matches_node_posix() {
        // Truth values captured from Node's path.resolve on POSIX.
        assert_eq!(resolve("//foo"), PathBuf::from("/foo"));
        assert_eq!(resolve("/a/../../b"), PathBuf::from("/b"));
        assert_eq!(resolve("/a/./b/"), PathBuf::from("/a/b"));
        assert_eq!(resolve("/"), PathBuf::from("/"));
        assert_eq!(resolve(".."), {
            let cwd = std::env::current_dir().expect("cwd");
            normalize(&cwd.join(".."))
        });
        assert_eq!(resolve(""), std::env::current_dir().expect("cwd"));
    }

    #[test]
    fn failure_shapes_keep_the_js_field_order() {
        assert_eq!(
            js_json_stringify(&failure(NOT_OWN_SHOT)),
            r#"{"ok":false,"refresh":false,"text":"不是远程屏幕截图"}"#
        );
    }
}
