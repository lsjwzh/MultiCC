use crate::{
    error_policy::classify,
    observer::Observer,
    plan::{rate_limit, Plan},
};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Response,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex as StdMutex, OnceLock},
    time::Duration,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const MAX_PENDING: usize = 1024 * 1024;
const MAX_ERROR: usize = 64 * 1024;
static CLIENTS: OnceLock<StdMutex<HashMap<String, Client>>> = OnceLock::new();

fn client(plan: &Plan) -> Result<Client, String> {
    client_for_proxy(plan.proxy_url.as_deref())
}

pub(crate) fn client_for_proxy(proxy_url: Option<&str>) -> Result<Client, String> {
    // An absent proxy explicitly means direct, never an environment override.
    let key = proxy_url.unwrap_or("direct").to_owned();
    let mut cache = CLIENTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Rust CPR 连接池不可用")?;
    if let Some(client) = cache.get(&key) {
        return Ok(client.clone());
    }
    let mut builder = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(60));
    if let Some(proxy) = proxy_url {
        builder = builder
            .no_proxy()
            .proxy(reqwest::Proxy::all(proxy).map_err(|_| "账号出口地址无效")?);
    }
    let client = builder
        .build()
        .map_err(|_| "无法初始化 Rust CPR TLS 传输")?;
    if cache.len() >= 16 {
        cache.clear();
    }
    cache.insert(key, client.clone());
    Ok(client)
}

pub struct Exchange {
    pub cancel: CancellationToken,
    state: Mutex<State>,
}
struct State {
    plan: Plan,
    client: Client,
    response: Option<Response>,
    observer: Observer,
    opened: bool,
    done: bool,
    committed: bool,
    pending: Vec<u8>,
    attempt: usize,
    status: u16,
    headers: serde_json::Map<String, Value>,
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
}

impl Exchange {
    pub fn new(input: String) -> Result<Self, String> {
        let plan: Plan = serde_json::from_str(&input).map_err(|_| "Rust CPR 请求计划无效")?;
        let http = client(&plan)?;
        Ok(Self {
            cancel: CancellationToken::new(),
            state: Mutex::new(State {
                observer: Observer::new(plan.route.protocol == "claude", false),
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
            }),
        })
    }
    async fn dial(state: &mut State, cancel: &CancellationToken) -> Result<Value, String> {
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
            result = tokio::time::timeout(Duration::from_millis(state.plan.headers_timeout_ms), request) => result.map_err(|_| "UPSTREAM_HEADERS_TIMEOUT")?.map_err(|_| "UPSTREAM_CONNECT_FAILED")?,
        };
        state.status = response.status().as_u16();
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
        let response = state.response.as_mut().ok_or("Rust CPR 尚未收到上游响应")?;
        let mut out = vec![];
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let chunk = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err("CLIENT_DISCONNECTED".into()),
                result = tokio::time::timeout_at(deadline, response.chunk()) => result.map_err(|_| "UPSTREAM_ERROR_TIMEOUT")?.map_err(|_| "UPSTREAM_STREAM_FAILED")?,
            };
            let Some(chunk) = chunk else { break };
            out.extend_from_slice(&chunk);
            if out.len() > MAX_ERROR {
                // 大错误不截断、不修复，保留连接由宿主按背压继续转发。
                return Ok(ErrorBody {
                    data: out,
                    complete: false,
                    no_retry: false,
                    rejection: None,
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
        Ok(ErrorBody {
            data: out,
            complete: true,
            no_retry,
            rejection,
        })
    }
    pub async fn read(&self) -> Result<Chunk, String> {
        let mut state = self.state.lock().await;
        if !state.opened {
            return Err("Rust CPR 尚未打开请求".into());
        }
        loop {
            if state.done {
                return Ok(state.chunk(vec![], true));
            }
            let response = state.response.as_mut().ok_or("Rust CPR 上游连接已关闭")?;
            let next = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => { state.response = None; state.done = true; return Err("CLIENT_DISCONNECTED".into()); },
                result = response.chunk() => result,
            };
            let next = match next {
                Ok(v) => v,
                Err(_) => {
                    state.response = None;
                    state.done = true;
                    return Err("UPSTREAM_STREAM_FAILED".into());
                }
            };
            if let Some(bytes) = &next {
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
        self.cancel.cancel();
        let mut state = self.state.lock().await;
        state.response = None;
        state.pending.clear();
        state.done = true;
    }
}
impl State {
    fn chunk(&mut self, data: Vec<u8>, done: bool) -> Chunk {
        Chunk {
            data,
            meta: json!({"done":done,"events":std::mem::take(&mut self.observer.events),"usage":self.observer.usage,"failed":self.observer.failed,"statusCode":self.status}),
        }
    }
}
