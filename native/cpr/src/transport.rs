use crate::{
    error_policy::classify,
    observer::Observer,
    plan::{rate_limit, Plan},
};
use multicc_core::model_stream_progress::ModelStreamProgress;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Response,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::Duration,
};
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const MAX_PENDING: usize = 1024 * 1024;
const MAX_ERROR: usize = 64 * 1024;
const MAX_CLIENTS: usize = 16;
static CLIENTS: OnceLock<StdMutex<ClientCache<Client>>> = OnceLock::new();

// Preserve the causal chain while keeping URLs and known credentials out of
// the CLI response, session state, and logs. The structured code stays stable
// so existing retry and timeout policies do not change.
fn transport_error(code: &str, error: reqwest::Error, plan: &Plan) -> String {
    let error = error.without_url();
    format_transport_error(code, &error, plan)
}

/// Sanitize an adapter/egress failure with the same credential boundaries as
/// the native transport, without serializing the potentially large body.
pub fn sanitize_adapter_error(plan: &Plan, message: &str, code: &str) -> String {
    format_transport_error(
        if code == "RUST_CPR_EGRESS_UNSUPPORTED" {
            code
        } else {
            "RUST_CPR_REQUEST_FAILED"
        },
        &std::io::Error::other(message.to_owned()),
        plan,
    )
}

fn format_transport_error(
    code: &str,
    error: &(dyn std::error::Error + 'static),
    plan: &Plan,
) -> String {
    static URLS: OnceLock<regex::Regex> = OnceLock::new();
    let urls = URLS
        .get_or_init(|| regex::Regex::new(r#"(?i)\b(?:https?|socks5h?)://[^\s"'<>]+"#).unwrap());
    let mut parts = Vec::new();
    let mut current = Some(error);
    while let Some(cause) = current {
        let mut detail = cause.to_string();
        for (name, value) in &plan.headers {
            let lower = name.to_ascii_lowercase();
            if [
                "authorization",
                "cookie",
                "token",
                "secret",
                "key",
                "account",
            ]
            .iter()
            .any(|marker| lower.contains(marker))
                && !value.is_empty()
            {
                detail = detail.replace(value, "[REDACTED]");
                if let Some((_, token)) = value.split_once(' ') {
                    if !token.is_empty() {
                        detail = detail.replace(token, "[REDACTED]");
                    }
                }
            }
        }
        for url in [Some(plan.url.as_str()), plan.proxy_url.as_deref()]
            .into_iter()
            .flatten()
        {
            if let Ok(parsed) = reqwest::Url::parse(url) {
                for secret in [Some(parsed.username()), parsed.password()]
                    .into_iter()
                    .flatten()
                    .filter(|s| !s.is_empty())
                {
                    detail = detail.replace(secret, "[REDACTED]");
                }
            }
        }
        detail = urls.replace_all(&detail, "[URL]").into_owned();
        detail = multicc_core::redaction::sanitize_message(
            &multicc_core::js::JsString::from_rust_str(&detail),
        )
        .to_string_lossy();
        if !detail.is_empty() && !parts.contains(&detail) {
            parts.push(detail);
        }
        if parts.len() >= 8 {
            break;
        }
        current = cause.source();
    }
    let detail: String = parts.join(": ").chars().take(1024).collect();
    if detail.is_empty() {
        code.to_owned()
    } else {
        format!("{code}: {detail}")
    }
}

// Evict only the least recently used configuration. Clearing the whole cache
// discards unrelated keep-alive connections whenever a seventeenth egress or
// timeout configuration is encountered.
struct ClientCache<T> {
    entries: VecDeque<(String, T)>,
}

impl<T> Default for ClientCache<T> {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
        }
    }
}

impl<T: Clone> ClientCache<T> {
    fn get(&mut self, key: &str) -> Option<T> {
        let index = self.entries.iter().position(|(k, _)| k == key)?;
        let entry = self.entries.remove(index)?;
        let value = entry.1.clone();
        self.entries.push_back(entry);
        Some(value)
    }

    fn insert(&mut self, key: String, value: T) {
        if self.entries.len() >= MAX_CLIENTS {
            self.entries.pop_front();
        }
        self.entries.push_back((key, value));
    }
}

fn client(plan: &Plan) -> Result<Client, String> {
    client_for_proxy_timeout(plan.proxy_url.as_deref(), plan.connect_timeout_ms)
}

pub(crate) fn client_for_proxy(proxy_url: Option<&str>) -> Result<Client, String> {
    client_for_proxy_timeout(proxy_url, None)
}

fn client_for_proxy_timeout(
    proxy_url: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<Client, String> {
    // An absent proxy explicitly means direct, never an environment override.
    let timeout_ms = timeout_ms.filter(|v| *v > 0).unwrap_or(30_000);
    let key = format!("{timeout_ms}\0{}", proxy_url.unwrap_or("direct"));
    let mut cache = CLIENTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Rust CPR 连接池不可用")?;
    if let Some(client) = cache.get(&key) {
        return Ok(client);
    }
    let mut builder = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(timeout_ms))
        .pool_idle_timeout(Duration::from_secs(60));
    if let Some(proxy) = proxy_url {
        builder = builder
            .no_proxy()
            .proxy(reqwest::Proxy::all(proxy).map_err(|_| "账号出口地址无效")?);
    }
    let client = builder
        .build()
        .map_err(|_| "无法初始化 Rust CPR TLS 传输")?;
    cache.insert(key, client.clone());
    Ok(client)
}

pub struct Exchange {
    cancel: CancellationToken,
    stream_watch: Arc<StreamWatch>,
    state: Mutex<State>,
}

struct StreamWatch {
    inner: StdMutex<StreamWatchState>,
    changed: Notify,
    cancel: CancellationToken,
}

#[derive(Default)]
struct StreamWatchState {
    started: bool,
    active: bool,
    completed: bool,
    cancelled: bool,
    timeout_notified: bool,
    idle_duration: Option<Duration>,
    idle_deadline: Option<Instant>,
    absolute_deadline: Option<Instant>,
    progressed: bool,
    timeout_code: Option<&'static str>,
}

impl StreamWatchState {
    fn expire_if_due(&mut self, now: Instant) -> bool {
        if !self.active {
            return false;
        }
        let idle = self.idle_deadline.filter(|deadline| *deadline <= now);
        let absolute = self.absolute_deadline.filter(|deadline| *deadline <= now);
        let code = match (absolute, idle) {
            (Some(a), Some(i)) if a <= i => Some("model_request_deadline"),
            (Some(_), None) => Some("model_request_deadline"),
            (_, Some(_)) => Some(if self.progressed {
                "stream_idle_timeout"
            } else {
                "response_stalled_before_response"
            }),
            (None, None) => None,
        };
        if let Some(code) = code {
            self.active = false;
            self.timeout_code = Some(code);
            return true;
        }
        false
    }
}

impl StreamWatch {
    fn progress(&self) -> bool {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !state.active {
            return false;
        }
        if state.expire_if_due(Instant::now()) {
            drop(state);
            self.cancel.cancel();
            self.changed.notify_one();
            return false;
        }
        state.progressed = true;
        if let Some(duration) = state.idle_duration {
            state.idle_deadline = Some(Instant::now() + duration);
        }
        drop(state);
        self.changed.notify_one();
        true
    }

    fn stop(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).active = false;
        self.changed.notify_one();
    }

    fn timeout_code(&self) -> Option<&'static str> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .timeout_code
    }
}
struct State {
    plan: Plan,
    client: Client,
    response: Option<Response>,
    observer: Observer,
    progress: ModelStreamProgress,
    stream_watch: Arc<StreamWatch>,
    opened: bool,
    done: bool,
    committed: bool,
    pending: Vec<u8>,
    attempt: usize,
    status: u16,
    headers: serde_json::Map<String, Value>,
    dial_at: Option<Instant>,
    headers_ms: u64,
    received_bytes: u64,
    metrics_at: Option<Instant>,
}
pub struct Chunk {
    pub data: Vec<u8>,
    pub meta: Value,
}
pub struct ErrorBody {
    pub data: Vec<u8>,
    pub complete: bool,
    /// 完整错误正文已确认是额度墙时，宿主据此让 CLI 停止重试。
    pub no_retry: bool,
    /// 429 的结构化归因（瞬时限流/额度窗口/模型权益/账单），供宿主向用户解释。
    pub rejection: Option<Value>,
    pub detail: Option<String>,
}

impl Exchange {
    pub fn new(input: String) -> Result<Self, String> {
        let plan: Plan = serde_json::from_str(&input).map_err(|_| "Rust CPR 请求计划无效")?;
        let http = client(&plan)?;
        let cancel = CancellationToken::new();
        let stream_watch = Arc::new(StreamWatch {
            inner: StdMutex::new(StreamWatchState::default()),
            changed: Notify::new(),
            cancel: cancel.clone(),
        });
        Ok(Self {
            cancel,
            stream_watch: stream_watch.clone(),
            state: Mutex::new(State {
                observer: Observer::new(plan.route.protocol == "claude", false),
                progress: ModelStreamProgress::default(),
                stream_watch,
                plan,
                client: http,
                response: None,
                opened: false,
                done: false,
                committed: false,
                pending: vec![],
                attempt: 1,
                status: 0,
                headers: serde_json::Map::new(),
                dial_at: None,
                headers_ms: 0,
                received_bytes: 0,
                metrics_at: None,
            }),
        })
    }

    /// Transfer a successful stream's watchdog to the exchange. The caller
    /// supplies *remaining* time, so the budget still includes time spent in
    /// admission, connection, headers and previous request attempts.
    pub fn start_stream_watch(
        &self,
        idle_ms: u64,
        idle_remaining_ms: u64,
        deadline_remaining_ms: u64,
        progressed: bool,
    ) -> Result<(), String> {
        let mut state = self
            .stream_watch
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.started || self.cancel.is_cancelled() {
            return Err("Rust CPR 请求已结束或计时器已启动".into());
        }
        if idle_ms == 0 && deadline_remaining_ms == 0 {
            return Err("Rust CPR 流计时预算无效".into());
        }
        let now = Instant::now();
        state.started = true;
        state.active = true;
        state.idle_duration = (idle_ms > 0).then(|| Duration::from_millis(idle_ms));
        state.idle_deadline =
            (idle_ms > 0).then(|| now + Duration::from_millis(idle_remaining_ms.max(1)));
        state.absolute_deadline =
            (deadline_remaining_ms > 0).then(|| now + Duration::from_millis(deadline_remaining_ms));
        state.progressed = progressed;
        state.timeout_code = None;
        Ok(())
    }

    pub fn stop_stream_watch(&self) {
        self.stream_watch.stop();
    }

    pub fn note_stream_progress(&self) -> bool {
        self.stream_watch.progress()
    }

    pub fn stream_progressed(&self) -> bool {
        self.stream_watch
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .progressed
    }

    pub fn stream_timeout_code(&self) -> Option<&'static str> {
        self.stream_watch.timeout_code()
    }

    /// Atomically accept the terminal result or retain the already due
    /// timeout/cancellation. No deadline can win after a successful claim.
    pub fn finish_stream_watch(&self) -> Option<&'static str> {
        let mut state = self
            .stream_watch
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let expired = state.expire_if_due(Instant::now());
        let code = state
            .timeout_code
            .or(state.cancelled.then_some("CLIENT_DISCONNECTED"));
        if code.is_none() {
            state.active = false;
            state.completed = true;
        }
        drop(state);
        if expired {
            self.cancel.cancel();
        }
        self.stream_watch.changed.notify_one();
        code
    }

    /// A disconnect is ordered against the deadline under the same lock as
    /// progress and finish. A due timeout remains the terminal cause.
    pub fn abort(&self) -> Option<&'static str> {
        let mut state = self
            .stream_watch
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.expire_if_due(Instant::now());
        if state.timeout_code.is_none() && !state.completed {
            state.cancelled = true;
            state.active = false;
        }
        let code = state.timeout_code;
        drop(state);
        self.cancel.cancel();
        self.stream_watch.changed.notify_one();
        code
    }

    /// Wait independently of Node's event loop and response backpressure.
    /// A timeout is recorded before cancellation, so a racing read can retain
    /// the actual cause rather than reporting a generic disconnect.
    pub async fn wait_stream_timeout(&self) -> Option<(&'static str, bool)> {
        loop {
            let notified = self.stream_watch.changed.notified();
            let (next, timeout) = {
                let mut state = self
                    .stream_watch
                    .inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if let Some(code) = state.timeout_code {
                    if state.timeout_notified {
                        return None;
                    }
                    state.timeout_notified = true;
                    (None, Some((code, state.progressed)))
                } else if !state.active {
                    return None;
                } else {
                    let next = match (state.idle_deadline, state.absolute_deadline) {
                        (Some(idle), Some(absolute)) => idle.min(absolute),
                        (Some(idle), None) => idle,
                        (None, Some(absolute)) => absolute,
                        (None, None) => return None,
                    };
                    (Some(next), None)
                }
            };
            if let Some(detail) = timeout {
                // A queued read is cancelled; if the host is paused on
                // backpressure, this drop also closes the upstream socket.
                let mut state = self.state.lock().await;
                state.response = None;
                state.done = true;
                return Some(detail);
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => continue,
                _ = notified => continue,
                _ = tokio::time::sleep_until(next.expect("active watch has deadline")) => {}
            }
            let expired = {
                let mut state = self
                    .stream_watch
                    .inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                state.expire_if_due(Instant::now())
            };
            if expired {
                self.cancel.cancel();
            }
        }
    }
    async fn dial(state: &mut State, cancel: &CancellationToken) -> Result<Value, String> {
        state.dial_at = Some(Instant::now());
        state.headers_ms = 0;
        state.received_bytes = 0;
        state.metrics_at = None;
        let mut headers = HeaderMap::new();
        for (name, value) in &state.plan.headers {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| "上游请求头名称无效")?,
                HeaderValue::from_str(value).map_err(|_| "上游请求头内容无效")?,
            );
        }
        let method = reqwest::Method::from_bytes(state.plan.method.as_bytes())
            .map_err(|_| "请求方法无效")?;
        let request = state
            .client
            .request(method, &state.plan.url)
            .headers(headers)
            .body(state.plan.body.clone())
            .send();
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("CLIENT_DISCONNECTED".into()),
            result = tokio::time::timeout(Duration::from_millis(state.plan.headers_timeout_ms), request) => result.map_err(|_| format!("UPSTREAM_HEADERS_TIMEOUT: 等待上游响应头超过 {} 毫秒", state.plan.headers_timeout_ms))?.map_err(|error| {
                let code = if state.plan.connect_timeout_ms.is_some() && error.is_connect() && error.is_timeout() {
                    "MODEL_CONNECT_TIMEOUT"
                } else {
                    "UPSTREAM_CONNECT_FAILED"
                };
                transport_error(code, error, &state.plan)
            })?,
        };
        state.status = response.status().as_u16();
        state.headers_ms = state
            .dial_at
            .map(|t| t.elapsed().as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0);
        let mut headers = serde_json::Map::new();
        let connection: Vec<&str> = response
            .headers()
            .get("connection")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .collect();
        for (name, value) in response.headers() {
            if ![
                "connection",
                "keep-alive",
                "transfer-encoding",
                "te",
                "trailer",
                "upgrade",
                "content-length",
                "proxy-authenticate",
                "set-cookie",
            ]
            .contains(&name.as_str())
                && !connection.contains(&name.as_str())
            {
                if let Ok(v) = value.to_str() {
                    headers.insert(name.to_string(), v.into());
                }
            }
        }
        let sse = headers
            .get("content-type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
            .contains("text/event-stream");
        state.observer = Observer::new(state.plan.route.protocol == "claude", sse);
        if sse {
            headers.insert("x-accel-buffering".into(), "no".into());
            headers.insert("cache-control".into(), "no-cache".into());
        }
        let rate = rate_limit(&headers);
        state.headers = headers.clone();
        state.response = Some(response);
        Ok(json!({"status":state.status,"headers":headers,"isStream":sse,"rateLimit":rate}))
    }
    pub async fn open(&self) -> Result<Value, String> {
        let mut state = self.state.lock().await;
        if state.opened || state.done {
            return Err("Rust CPR 请求已经打开或结束".into());
        }
        state.opened = true;
        Self::dial(&mut state, &self.cancel).await
    }
    pub async fn error_body(&self) -> Result<ErrorBody, String> {
        let mut state = self.state.lock().await;
        let mut out = vec![];
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let response = state.response.as_mut().ok_or("Rust CPR 尚未收到上游响应")?;
            let chunk = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err("CLIENT_DISCONNECTED".into()),
                result = tokio::time::timeout_at(deadline, response.chunk()) => result.map_err(|_| "UPSTREAM_ERROR_TIMEOUT: 读取上游错误响应超过 5000 毫秒")?,
            };
            let chunk = chunk
                .map_err(|error| transport_error("UPSTREAM_STREAM_FAILED", error, &state.plan))?;
            let Some(chunk) = chunk else { break };
            out.extend_from_slice(&chunk);
            if out.len() > MAX_ERROR {
                // 大错误不截断、不修复，保留连接由宿主按背压继续转发。
                return Ok(ErrorBody {
                    data: out,
                    complete: false,
                    no_retry: false,
                    rejection: None,
                    detail: None,
                });
            }
        }
        state.response = None;
        state.done = true;
        let rejection = classify(
            state.status,
            &state.headers,
            &out,
            Some(&state.plan.route.model),
        );
        let no_retry = rejection
            .as_ref()
            .is_some_and(|result| result["kind"].as_str() != Some("transient"));
        // Lift structured messages or explicitly plain-text errors, not HTML.
        // The original HTTP body continues through the normal protocol path.
        let detail = serde_json::from_slice::<Value>(&out)
            .ok()
            .and_then(|body| {
                body.pointer("/error/message")
                    .and_then(Value::as_str)
                    .or_else(|| body.get("message").and_then(Value::as_str))
                    .or_else(|| body.get("error").and_then(Value::as_str))
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| {
                        format_transport_error(
                            "UPSTREAM_HTTP_ERROR",
                            &std::io::Error::other(value.to_owned()),
                            &state.plan,
                        )
                    })
            })
            .or_else(|| {
                state
                    .headers
                    .get("content-type")
                    .and_then(Value::as_str)
                    .filter(|content_type| {
                        content_type.to_ascii_lowercase().starts_with("text/plain")
                    })
                    .and_then(|_| std::str::from_utf8(&out).ok())
                    .filter(|message| !message.trim().is_empty())
                    .map(|message| {
                        format_transport_error(
                            "UPSTREAM_HTTP_ERROR",
                            &std::io::Error::other(message.to_owned()),
                            &state.plan,
                        )
                    })
            });
        Ok(ErrorBody {
            data: out,
            complete: true,
            no_retry,
            rejection,
            detail,
        })
    }
    pub async fn read(&self) -> Result<Chunk, String> {
        let mut state = self.state.lock().await;
        if !state.opened {
            return Err("Rust CPR 尚未打开请求".into());
        }
        loop {
            if let Some(code) = self.stream_watch.timeout_code() {
                return Err(code.into());
            }
            if state.done {
                return Ok(state.chunk(vec![], true));
            }
            let response = state.response.as_mut().ok_or("Rust CPR 上游连接已关闭")?;
            let next = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => { state.response = None; state.done = true; return Err(self.stream_watch.timeout_code().unwrap_or("CLIENT_DISCONNECTED").into()); },
                result = response.chunk() => result,
            };
            let next = match next {
                Ok(v) => v,
                Err(error) => {
                    state.response = None;
                    state.done = true;
                    return Err(transport_error(
                        "UPSTREAM_STREAM_FAILED",
                        error,
                        &state.plan,
                    ));
                }
            };
            if let Some(bytes) = &next {
                state.received_bytes = state.received_bytes.saturating_add(bytes.len() as u64);
                state.observer.feed(bytes);
            } else {
                state.observer.finish();
            }
            let compat =
                state.plan.mode == "responses-compat" && (200..300).contains(&state.status);
            if compat
                && !state.committed
                && state.observer.failed
                && !state.observer.saw_output
                && state.observer.busy()
                && state.attempt < 5
            {
                state.response = None;
                state.pending.clear();
                let delay = [250, 600, 1200, 2200][state.attempt - 1];
                state.attempt += 1;
                tokio::select! { biased; _ = self.cancel.cancelled() => return Err("CLIENT_DISCONNECTED".into()), _ = tokio::time::sleep(Duration::from_millis(delay)) => () }
                Self::dial(&mut state, &self.cancel).await?;
                if !(200..300).contains(&state.status) {
                    return Err("UPSTREAM_HTTP_ERROR".into());
                }
                continue;
            }
            let mut data = next.as_ref().map(|v| v.to_vec()).unwrap_or_default();
            if compat && !state.committed {
                state.pending.append(&mut data);
                if state.observer.saw_output
                    || state.observer.completed
                    || state.observer.failed
                    || next.is_none()
                    || state.pending.len() >= MAX_PENDING
                {
                    state.committed = true;
                    data = std::mem::take(&mut state.pending);
                }
            }
            let done =
                next.is_none() || compat && (state.observer.completed || state.observer.failed);
            if done {
                if compat && !state.observer.completed && !state.observer.failed {
                    data.extend_from_slice(&state.observer.completion());
                }
                state.response = None;
                state.done = true;
            }
            if !data.is_empty() || done {
                return Ok(state.chunk(data, done));
            }
        }
    }
    pub async fn close(&self) {
        self.abort();
        let mut state = self.state.lock().await;
        state.response = None;
        state.pending.clear();
        state.done = true;
    }
}
impl State {
    fn chunk(&mut self, data: Vec<u8>, done: bool) -> Chunk {
        let model_progress = self.progress.feed_bytes(&data);
        if model_progress {
            self.stream_watch.progress();
        }
        let now = Instant::now();
        let metrics = self.dial_at.and_then(|start| {
            if !done
                && self
                    .metrics_at
                    .is_some_and(|last| now.duration_since(last) < Duration::from_secs(1))
            {
                return None;
            }
            self.metrics_at = Some(now);
            Some(json!({"attempt":self.attempt,"bytes":self.received_bytes,
                "elapsedMs":now.duration_since(start).as_millis().min(u64::MAX as u128) as u64,
                "headersMs":self.headers_ms}))
        });
        Chunk {
            data,
            meta: json!({"done":done,"events":std::mem::take(&mut self.observer.events),"usage":self.observer.usage,"failed":self.observer.failed,"statusCode":self.status,"modelProgress":model_progress,"transportMetrics":metrics}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    #[test]
    fn transport_cause_preserves_os_reason_but_removes_urls_and_credentials() {
        let plan: Plan = serde_json::from_value(json!({
            "route": { "protocol":"claude", "providerId":"p", "mainProviderId":"p", "sessionId":"s",
                "role":"main", "agentRole":"", "routeName":"main", "model":"m", "apiPath":"/v1/messages", "query":"", "isStream":true },
            "providerName":"p", "url":"https://example.invalid/v1", "method":"POST",
            "headers":{"authorization":"Bearer sample-secret-42"}, "body":"", "mode":"raw",
            "proxyUrl":"http://proxyuser:proxypass@proxy.invalid:80"
        })).unwrap();
        let error = std::io::Error::other("connection refused (os error 61) https://example.invalid/path?foo=sample-secret-42 proxyuser proxypass");
        let text = format_transport_error("UPSTREAM_CONNECT_FAILED", &error, &plan);
        assert!(text.contains("connection refused (os error 61)"));
        for secret in [
            "sample-secret-42",
            "proxyuser",
            "proxypass",
            "example.invalid",
        ] {
            assert!(
                !text.contains(secret),
                "credential or URL appeared in diagnostic"
            );
        }
    }

    #[test]
    fn client_cache_evicts_only_the_least_recently_used_configuration() {
        let mut cache = ClientCache::default();
        for i in 0..MAX_CLIENTS {
            cache.insert(i.to_string(), i);
        }
        assert_eq!(cache.get("0"), Some(0));
        cache.insert("new".into(), MAX_CLIENTS);
        assert_eq!(cache.get("1"), None);
        assert_eq!(cache.get("0"), Some(0));
        for i in 2..MAX_CLIENTS {
            assert_eq!(cache.get(&i.to_string()), Some(i));
        }
        assert_eq!(cache.get("new"), Some(MAX_CLIENTS));
        assert_eq!(cache.entries.len(), MAX_CLIENTS);
    }

    #[tokio::test]
    async fn cached_client_reuses_connection_after_seventeenth_configuration() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let stopped = Arc::new(AtomicBool::new(false));
        let accepted = Arc::new(AtomicUsize::new(0));
        let server = std::thread::spawn({
            let stopped = stopped.clone();
            let accepted = accepted.clone();
            move || {
                let mut workers = Vec::new();
                while !stopped.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut socket, _)) => {
                            accepted.fetch_add(1, Ordering::Relaxed);
                            workers.push(std::thread::spawn(move || {
                                socket.set_nonblocking(false).unwrap();
                                socket
                                    .set_read_timeout(Some(Duration::from_secs(30)))
                                    .unwrap();
                                let mut request = Vec::new();
                                let mut byte = [0];
                                while socket.read_exact(&mut byte).is_ok() {
                                    request.push(byte[0]);
                                    if request.ends_with(b"\r\n\r\n") {
                                        if socket
                                            .write_all(
                                                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
                                            )
                                            .is_err()
                                        {
                                            break;
                                        }
                                        request.clear();
                                    }
                                }
                            }));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(1))
                        }
                        Err(error) => panic!("listener failed: {error}"),
                    }
                }
                for worker in workers {
                    worker.join().unwrap();
                }
            }
        });
        let mut cache = ClientCache::default();
        for i in 0..MAX_CLIENTS {
            let client = Client::builder().no_proxy().build().unwrap();
            client
                .get(&url)
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap();
            if i == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                client
                    .get(&url)
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap();
                assert_eq!(
                    accepted.load(Ordering::Relaxed),
                    1,
                    "fixture must support keep-alive"
                );
            }
            cache.insert(i.to_string(), client);
        }
        let first = cache.get("0").unwrap();
        let extra = Client::builder().no_proxy().build().unwrap();
        extra.get(&url).send().await.unwrap().bytes().await.unwrap();
        cache.insert("extra".into(), extra);
        tokio::time::sleep(Duration::from_millis(20)).await;
        cache
            .get("0")
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(
            accepted.load(Ordering::Relaxed),
            MAX_CLIENTS + 1,
            "the hot first configuration should reuse its existing TCP connection"
        );
        drop(first);
        drop(cache);
        stopped.store(true, Ordering::Relaxed);
        tokio::task::spawn_blocking(move || server.join().unwrap())
            .await
            .unwrap();
    }

    fn upstream(finish: bool) -> (Arc<Exchange>, mpsc::Receiver<()>) {
        let (exchange, _, closed) = upstream_with_ready(finish);
        (exchange, closed)
    }

    fn upstream_with_ready(
        finish: bool,
    ) -> (Arc<Exchange>, mpsc::Receiver<()>, mpsc::Receiver<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (closed_tx, closed_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = [0u8; 4096];
            // Consume the full request head before answering: a single read may
            // return only part of it, and responding mid-write can reset the peer.
            let mut received = 0usize;
            loop {
                let read = socket.read(&mut buffer[received..]).unwrap();
                if read == 0 {
                    break;
                }
                received += read;
                if buffer[..received]
                    .windows(4)
                    .any(|part| part == b"\r\n\r\n")
                {
                    break;
                }
            }
            assert!(received > 0, "upstream received no request bytes");
            let frame = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"x\"}}\n\n";
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n", frame.len()).unwrap();
            socket.write_all(frame).unwrap();
            socket.write_all(b"\r\n").unwrap();
            let _ = ready_tx.send(());
            if finish {
                socket.write_all(b"0\r\n\r\n").unwrap();
            } else {
                while let Ok(n) = socket.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                }
            }
            let _ = closed_tx.send(());
        });
        let plan = json!({
            "route": { "protocol":"claude", "providerId":"p", "mainProviderId":"p", "sessionId":"s",
                "role":"main", "agentRole":"", "routeName":"main", "model":"m", "apiPath":"/v1/messages", "query":"", "isStream":true },
            "providerName":"p", "url":format!("http://{addr}/v1/messages"), "method":"POST", "headers":{},
            "body":"", "mode":"raw", "headersTimeoutMs":1000
        });
        (
            Arc::new(Exchange::new(plan.to_string()).unwrap()),
            ready_rx,
            closed_rx,
        )
    }

    #[tokio::test]
    async fn stream_watch_closes_a_real_upstream_even_without_an_active_read() {
        let (exchange, closed) = upstream(false);
        exchange.open().await.unwrap();
        exchange.start_stream_watch(100, 100, 1000, false).unwrap();
        let watch = tokio::spawn({
            let exchange = exchange.clone();
            async move { exchange.wait_stream_timeout().await }
        });
        let first = exchange.read().await.unwrap();
        assert!(!first.data.is_empty());
        assert!(exchange.stream_progressed());
        assert_eq!(watch.await.unwrap(), Some(("stream_idle_timeout", true)));
        assert_eq!(
            exchange.read().await.err().as_deref(),
            Some("stream_idle_timeout")
        );
        tokio::task::spawn_blocking(move || closed.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn no_watch_keeps_normal_completion_and_has_no_timeout_code() {
        let (exchange, closed) = upstream(true);
        exchange.open().await.unwrap();
        let mut received = 0;
        loop {
            let chunk = exchange.read().await.unwrap();
            received += chunk.data.len() as u64;
            if chunk.meta["done"] == true {
                assert_eq!(chunk.meta["transportMetrics"]["bytes"], received);
                assert_eq!(chunk.meta["transportMetrics"]["attempt"], 1);
                assert!(chunk.meta["transportMetrics"]["headersMs"].is_u64());
                break;
            }
        }
        assert_eq!(exchange.stream_timeout_code(), None);
        exchange.close().await;
        tokio::task::spawn_blocking(move || closed.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancellation_stops_the_watch_without_fabricating_a_timeout() {
        let (exchange, ready, closed) = upstream_with_ready(false);
        exchange.open().await.unwrap();
        tokio::task::spawn_blocking(move || ready.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
        exchange.start_stream_watch(200, 200, 500, false).unwrap();
        let watch = tokio::spawn({
            let exchange = exchange.clone();
            async move { exchange.wait_stream_timeout().await }
        });
        exchange.close().await;
        assert_eq!(watch.await.unwrap(), None);
        assert_eq!(exchange.stream_timeout_code(), None);
        tokio::task::spawn_blocking(move || closed.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn progress_renews_idle_but_never_the_transferred_absolute_deadline() {
        let (exchange, closed) = upstream(false);
        exchange.open().await.unwrap();
        exchange.start_stream_watch(500, 500, 140, false).unwrap();
        let watch = tokio::spawn({
            let exchange = exchange.clone();
            async move { exchange.wait_stream_timeout().await }
        });
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(30)).await;
            exchange.note_stream_progress();
        }
        assert_eq!(watch.await.unwrap(), Some(("model_request_deadline", true)));
        assert_eq!(
            exchange.stream_timeout_code(),
            Some("model_request_deadline")
        );
        tokio::task::spawn_blocking(move || closed.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stopped_stream_watch_cannot_be_restarted_on_the_same_exchange() {
        let (exchange, ready, closed) = upstream_with_ready(false);
        exchange.open().await.unwrap();
        exchange.start_stream_watch(500, 500, 0, false).unwrap();
        let watch = tokio::spawn({
            let exchange = exchange.clone();
            async move { exchange.wait_stream_timeout().await }
        });
        exchange.stop_stream_watch();
        assert!(exchange.start_stream_watch(500, 500, 0, false).is_err());
        assert_eq!(watch.await.unwrap(), None);
        // Keep the peer open until the fixture has written its first frame.
        // Otherwise the test can close the exchange while the fixture is
        // writing headers, producing an unrelated BrokenPipe panic.
        tokio::task::spawn_blocking(move || ready.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
        exchange.close().await;
        tokio::task::spawn_blocking(move || closed.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
    }

    #[test]
    fn deadline_comparison_is_inclusive_and_chooses_the_first_due_budget() {
        let at = Instant::now();
        let mut state = StreamWatchState {
            active: true,
            idle_deadline: Some(at),
            ..Default::default()
        };
        assert!(!state.expire_if_due(at - Duration::from_nanos(1)));
        assert!(state.expire_if_due(at));
        assert_eq!(state.timeout_code, Some("response_stalled_before_response"));
        let mut state = StreamWatchState {
            active: true,
            progressed: true,
            idle_deadline: Some(at),
            absolute_deadline: Some(at + Duration::from_millis(1)),
            ..Default::default()
        };
        assert!(state.expire_if_due(at + Duration::from_millis(10)));
        assert_eq!(state.timeout_code, Some("stream_idle_timeout"));
    }

    #[tokio::test]
    async fn overdue_progress_and_final_frame_cannot_revive_a_delayed_watcher() {
        let (exchange, closed) = upstream(false);
        exchange.open().await.unwrap();
        exchange.start_stream_watch(100, 1, 1000, false).unwrap();
        tokio::time::sleep(Duration::from_millis(15)).await;
        assert!(!exchange.note_stream_progress());
        assert!(!exchange.stream_progressed());
        assert_eq!(
            exchange.finish_stream_watch(),
            Some("response_stalled_before_response")
        );
        assert_eq!(
            exchange.wait_stream_timeout().await,
            Some(("response_stalled_before_response", false))
        );
        assert_eq!(
            exchange.read().await.err().as_deref(),
            Some("response_stalled_before_response")
        );
        tokio::task::spawn_blocking(move || closed.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn disconnect_and_deadline_are_arbitrated_before_notification() {
        let (late, late_closed) = upstream(false);
        late.open().await.unwrap();
        late.start_stream_watch(100, 1, 1000, false).unwrap();
        tokio::time::sleep(Duration::from_millis(15)).await;
        assert_eq!(late.abort(), Some("response_stalled_before_response"));
        assert_eq!(
            late.finish_stream_watch(),
            Some("response_stalled_before_response")
        );
        assert_eq!(
            late.wait_stream_timeout().await,
            Some(("response_stalled_before_response", false))
        );
        tokio::task::spawn_blocking(move || {
            late_closed.recv_timeout(Duration::from_secs(2)).unwrap()
        })
        .await
        .unwrap();

        let (early, early_closed) = upstream(false);
        early.open().await.unwrap();
        early.start_stream_watch(500, 500, 1000, false).unwrap();
        assert_eq!(early.abort(), None);
        assert_eq!(early.finish_stream_watch(), Some("CLIENT_DISCONNECTED"));
        assert_eq!(early.wait_stream_timeout().await, None);
        early.close().await;
        tokio::task::spawn_blocking(move || {
            early_closed.recv_timeout(Duration::from_secs(2)).unwrap()
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn success_and_disconnect_concurrently_have_one_winner() {
        let (exchange, closed) = upstream(false);
        exchange.open().await.unwrap();
        exchange
            .start_stream_watch(1000, 1000, 2000, false)
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let finish = std::thread::spawn({
            let exchange = exchange.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                exchange.finish_stream_watch()
            }
        });
        let abort = std::thread::spawn({
            let exchange = exchange.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                exchange.abort()
            }
        });
        barrier.wait();
        let result = finish.join().unwrap();
        assert_eq!(abort.join().unwrap(), None);
        {
            let state = exchange
                .stream_watch
                .inner
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if result.is_none() {
                assert!(state.completed && !state.cancelled);
            } else {
                assert_eq!(result, Some("CLIENT_DISCONNECTED"));
                assert!(state.cancelled && !state.completed);
            }
        }
        exchange.close().await;
        tokio::task::spawn_blocking(move || closed.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
    }
}
