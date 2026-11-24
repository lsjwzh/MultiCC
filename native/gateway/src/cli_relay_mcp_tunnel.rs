//! 通用「MCP-over-WSS 隧道」：在远程 CLI 模式下将 Client 本机第三方 MCP Server 安全透传给远端大脑。
//!
//! 架构（与 `multicc_router` WSS 桥同构，零凭据外泄）：
//! 1. **Client 发现与门禁**：扫描项目 `.mcp.json`、用户 `~/.claude.json`、`~/.claude/settings.json`、
//!    `~/.gemini/config/mcp_config.json`（以及测试/显式覆盖 `MULTICC_RELAY_MCP_CONFIG_JSON`），
//!    排除内置 `multicc_*` 服务，按可选 `MULTICC_RELAY_MCP_ALLOWLIST` 过滤；
//!    **仅将合法服务名列表 `["playwright", ...]` 随 `start` 帧发往 Host**，命令/环境变量/API Key 100% 留在 Client！
//! 2. **Host 轻量代理**：Host 为每个名称挂载 `multicc-gateway mcp-relay-proxy --server <name>`，
//!    将远端 CLI 的 stdio JSON-RPC 请求转发至环回 `POST $MULTICC_HOST_EXEC_URL/mcp/<name>`，再经同一条 WSS
//!    以 `mcp_rpc_req` / `mcp_rpc_res` 帧送回 Client；
//! 3. **Client 懒加载会话池（`ClientMcpManager`）**：Client 按需在本机启动并复用真实 stdio / HTTP MCP Server，
//!    对 stdio JSON-RPC `id` 做内部重映射（彻底防多路并发 `id` 冲突与 stdout 杂音），回合结束自动销毁全部子进程。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};

use crate::cli_relay_skills::client_home_dir;

pub const MAX_BRIDGED_MCP_SERVERS: usize = 16;
/// 单条 MCP JSON-RPC 消息（请求或响应）的体积上限。超过即拒绝，避免一次超大
/// 响应撑爆 32 MiB 的 WSS 帧上限连带断掉整个回合。
pub const MAX_MCP_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
/// 同一回合内同时在途的 MCP 调用上限，防止 Host 无节制并发把 Client 打爆。
pub const MAX_CONCURRENT_MCP_CALLS: usize = 4;
const CLIENT_MCP_CALL_TIMEOUT: Duration = Duration::from_secs(300);
const CLIENT_MCP_QUEUE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub enum ClientMcpTransport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
    Http {
        url: String,
        headers: HashMap<String, String>,
    },
}

#[derive(Debug, Clone)]
pub struct ClientMcpSpec {
    pub name: String,
    pub transport: ClientMcpTransport,
}

/// 严格校验第三方 MCP 服务名：仅允许 `[A-Za-z0-9_-]{1,48}`，且禁止覆盖 `multicc_` 保留命名空间。
pub fn is_valid_external_mcp_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 48 {
        return false;
    }
    if name.to_ascii_lowercase().starts_with("multicc_")
        || name.to_ascii_lowercase().starts_with("multicc-")
    {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn parse_start_mcp_servers(start_val: &Value) -> Vec<String> {
    let Some(arr) = start_val.get("mcpServers").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr.iter().take(MAX_BRIDGED_MCP_SERVERS) {
        if let Some(name) = item.as_str().map(str::trim) {
            if is_valid_external_mcp_name(name) && !out.iter().any(|x| x == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

fn parse_allowlist_filter() -> Option<Vec<String>> {
    let raw = std::env::var("MULTICC_RELAY_MCP_ALLOWLIST").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("all") || trimmed == "*" {
        return None;
    }
    if matches!(
        trimmed.to_ascii_lowercase().as_str(),
        "0" | "off" | "none" | "false"
    ) {
        return Some(Vec::new());
    }
    Some(
        trimmed
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

fn parse_mcp_entry_json(name: &str, entry: &Value) -> Option<ClientMcpSpec> {
    if !is_valid_external_mcp_name(name) {
        return None;
    }
    let obj = entry.as_object()?;
    if obj.get("disabled").and_then(Value::as_bool) == Some(true)
        || obj.get("enabled").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    // 1) stdio transport: { command, args?, env? }
    if let Some(cmd) = obj
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let args = obj
            .get("args")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut env = HashMap::new();
        if let Some(env_obj) = obj.get("env").and_then(Value::as_object) {
            for (k, v) in env_obj {
                if let Some(val) = v.as_str() {
                    env.insert(k.clone(), val.to_string());
                }
            }
        }
        return Some(ClientMcpSpec {
            name: name.to_string(),
            transport: ClientMcpTransport::Stdio {
                command: cmd.to_string(),
                args,
                env,
            },
        });
    }
    // 2) streamable HTTP transport: { url, headers? }
    let transport_type = obj.get("type").and_then(Value::as_str).unwrap_or("http");
    if matches!(
        transport_type,
        "http" | "streamable-http" | "streamable_http"
    ) {
        if let Some(url) = obj
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        {
            let mut headers = HashMap::new();
            if let Some(hdrs) = obj.get("headers").and_then(Value::as_object) {
                for (k, v) in hdrs {
                    if let Some(val) = v.as_str() {
                        headers.insert(k.clone(), val.to_string());
                    }
                }
            }
            return Some(ClientMcpSpec {
                name: name.to_string(),
                transport: ClientMcpTransport::Http {
                    url: url.to_string(),
                    headers,
                },
            });
        }
    }
    None
}

fn collect_from_mcp_json_value(root: &Value, out: &mut HashMap<String, ClientMcpSpec>) {
    let candidates = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .or_else(|| root.as_object());
    let Some(map) = candidates else {
        return;
    };
    for (name, entry) in map {
        if out.len() >= MAX_BRIDGED_MCP_SERVERS || out.contains_key(name) {
            continue;
        }
        if let Some(spec) = parse_mcp_entry_json(name, entry) {
            out.insert(name.clone(), spec);
        }
    }
}

fn collect_from_json_file(path: &Path, out: &mut HashMap<String, ClientMcpSpec>) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    if let Ok(val) = serde_json::from_str::<Value>(&raw) {
        if val.get("mcpServers").is_some() {
            collect_from_mcp_json_value(&val, out);
        }
    }
}

/// 发现 Client 本机配置的第三方 MCP Server 映射表。
pub fn discover_client_mcp_servers(local_root: &Path) -> HashMap<String, ClientMcpSpec> {
    let allowlist = parse_allowlist_filter();
    if let Some(list) = allowlist.as_ref() {
        if list.is_empty() {
            return HashMap::new();
        }
    }

    let mut found = HashMap::new();

    // 1. 显式环境变量覆盖/注入（支持内联 JSON 或文件路径）
    if let Ok(override_raw) = std::env::var("MULTICC_RELAY_MCP_CONFIG_JSON") {
        let trimmed = override_raw.trim();
        if !trimmed.is_empty() {
            if trimmed.starts_with('{') {
                if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                    collect_from_mcp_json_value(&val, &mut found);
                }
            } else {
                collect_from_json_file(Path::new(trimmed), &mut found);
            }
        }
    }

    // 2. 项目级 `.mcp.json`
    let project_mcp = local_root.join(".mcp.json");
    if let Ok(raw) = std::fs::read_to_string(&project_mcp) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            collect_from_mcp_json_value(&val, &mut found);
        }
    }

    // 3. 用户级标准 MCP 配置（Claude / Gemini）
    if let Some(home) = client_home_dir() {
        for candidate in [
            home.join(".claude.json"),
            home.join(".claude").join("settings.json"),
            home.join(".gemini").join("config").join("mcp_config.json"),
        ] {
            collect_from_json_file(&candidate, &mut found);
        }
    }

    if let Some(allowed) = allowlist {
        found.retain(|name, _| allowed.iter().any(|a| a == name));
    }
    found
}

/// 按行读取，单行超过 `limit` 字节时整行丢弃并返回 `Ok(Some(false))`；
/// 返回 `Ok(None)` 表示 EOF。读到换行为止，因此丢弃后下一次仍从新行开始。
async fn read_line_capped<R>(
    reader: &mut R,
    out: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<Option<bool>>
where
    R: AsyncBufRead + Unpin,
{
    out.clear();
    let mut truncated = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(None);
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            if !truncated {
                if out.len() + pos > limit {
                    out.clear();
                    truncated = true;
                } else {
                    out.extend_from_slice(&available[..pos]);
                }
            }
            reader.consume(pos + 1);
            return Ok(Some(!truncated));
        }
        let len = available.len();
        if !truncated {
            if out.len() + len > limit {
                out.clear();
                truncated = true;
            } else {
                out.extend_from_slice(available);
            }
        }
        reader.consume(len);
    }
}

struct LiveStdioMcp {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    /// 子进程读端已退出（EOF / 协议损坏被主动终止）即为 false，后续调用应重建实例。
    alive: Arc<AtomicBool>,
    next_id: AtomicU64,
    _child: Mutex<Child>,
}

impl LiveStdioMcp {
    async fn spawn(
        spec: &ClientMcpSpec,
        command: &str,
        args: &[String],
        extra_env: &HashMap<String, String>,
        cwd: &Path,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // 第三方 MCP 是外部进程：本进程携带的全部 `MULTICC_*` 控制面变量
        // （宿主席位 token、router capability、各 CLI 借道凭据）一律不往下传。
        for (key, _) in std::env::vars_os() {
            if let Some(key) = key.to_str() {
                if key.starts_with("MULTICC_") {
                    cmd.env_remove(key);
                }
            }
        }
        for (k, v) in extra_env {
            if !k.starts_with("MULTICC_") {
                cmd.env(k, v);
            }
        }
        let mut child = cmd
            .spawn()
            .map_err(|err| format!("启动本机 MCP `{}` ({command}) 失败: {err}", spec.name))?;
        let mut child_stdin = child.stdin.take().ok_or("MCP stdin unavailable")?;
        let child_stdout = child.stdout.take().ok_or("MCP stdout unavailable")?;

        let alive = Arc::new(AtomicBool::new(true));
        let alive_writer = alive.clone();
        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(mut line) = stdin_rx.recv().await {
                if !line.ends_with('\n') {
                    line.push('\n');
                }
                if child_stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = child_stdin.flush().await;
            }
            alive_writer.store(false, Ordering::SeqCst);
        });

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        let alive_reader = alive.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(child_stdout);
            let mut buf = Vec::new();
            loop {
                match read_line_capped(&mut reader, &mut buf, MAX_MCP_MESSAGE_BYTES).await {
                    // 单行超过上限：协议流已不可信，结束本会话让调用方立即失败并在下次重建。
                    Ok(Some(false)) => break,
                    Ok(Some(true)) => {}
                    Ok(None) | Err(_) => break,
                }
                let text = String::from_utf8_lossy(&buf);
                let trimmed = text.trim();
                if !trimmed.starts_with('{') {
                    continue;
                }
                let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                if let Some(id_num) = val.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = pending_reader.lock().await.remove(&id_num) {
                        let _ = tx.send(val);
                    }
                }
            }
            alive_reader.store(false, Ordering::SeqCst);
            pending_reader.lock().await.clear();
        });

        Ok(Arc::new(Self {
            stdin_tx,
            pending,
            alive,
            next_id: AtomicU64::new(1),
            _child: Mutex::new(child),
        }))
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn mark_dead(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }

    async fn send_notification(&self, msg: &Value) -> Result<(), String> {
        let mut clean = msg.clone();
        if let Some(obj) = clean.as_object_mut() {
            obj.remove("id");
        }
        let encoded = clean.to_string();
        if encoded.len() > MAX_MCP_MESSAGE_BYTES {
            return Err(format!(
                "MCP 请求超过 {} MiB 上限",
                MAX_MCP_MESSAGE_BYTES / (1024 * 1024)
            ));
        }
        self.stdin_tx
            .send(encoded)
            .map_err(|_| "本机 MCP 进程已退出".to_string())
    }

    async fn call(&self, msg: &Value) -> Result<Value, String> {
        let orig_id = msg.get("id").cloned().unwrap_or(Value::Null);
        let internal_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut rewritten = msg.clone();
        if let Some(obj) = rewritten.as_object_mut() {
            obj.insert("id".to_string(), json!(internal_id));
        }
        let encoded = rewritten.to_string();
        if encoded.len() > MAX_MCP_MESSAGE_BYTES {
            return Err(format!(
                "MCP 请求超过 {} MiB 上限",
                MAX_MCP_MESSAGE_BYTES / (1024 * 1024)
            ));
        }
        let (tx, rx) = oneshot::channel::<Value>();
        self.pending.lock().await.insert(internal_id, tx);
        if self.stdin_tx.send(encoded).is_err() {
            self.pending.lock().await.remove(&internal_id);
            self.mark_dead();
            return Err("本机 MCP 进程输入管道已关闭".to_string());
        }
        match tokio::time::timeout(CLIENT_MCP_CALL_TIMEOUT, rx).await {
            Ok(Ok(mut resp)) => {
                if let Some(obj) = resp.as_object_mut() {
                    obj.insert("id".to_string(), orig_id);
                }
                Ok(resp)
            }
            Ok(Err(_)) => Err("本机 MCP 进程在返回结果前退出".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&internal_id);
                Err("等待本机 MCP 响应超时".to_string())
            }
        }
    }
}

/// Client 侧单回合第三方 MCP 生命周期管理器。
pub struct ClientMcpManager {
    specs: HashMap<String, ClientMcpSpec>,
    local_root: PathBuf,
    live_stdio: Mutex<HashMap<String, Arc<LiveStdioMcp>>>,
    http_client: reqwest::Client,
    calls: Semaphore,
}

impl ClientMcpManager {
    pub fn new(specs: HashMap<String, ClientMcpSpec>, local_root: PathBuf) -> Self {
        // 本机 MCP 常常是本地服务：走 HTTP 时不能落到用户代理上。
        let http_client = reqwest::Client::builder()
            .no_proxy()
            .timeout(CLIENT_MCP_CALL_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            specs,
            local_root,
            live_stdio: Mutex::new(HashMap::new()),
            http_client,
            calls: Semaphore::new(MAX_CONCURRENT_MCP_CALLS),
        }
    }

    pub fn server_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.specs.keys().cloned().collect();
        names.sort();
        names
    }

    pub async fn shutdown_all(&self) {
        let drained: Vec<Arc<LiveStdioMcp>> = self
            .live_stdio
            .lock()
            .await
            .drain()
            .map(|(_, v)| v)
            .collect();
        for inst in drained {
            let mut child = inst._child.lock().await;
            let _ = child.kill().await;
        }
    }

    async fn get_or_spawn_stdio(
        &self,
        spec: &ClientMcpSpec,
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Arc<LiveStdioMcp>, String> {
        let mut map = self.live_stdio.lock().await;
        if let Some(existing) = map.get(&spec.name) {
            if existing.is_alive() {
                return Ok(existing.clone());
            }
            // 上一实例已退出：丢弃（`kill_on_drop` 负责收尸）后重建。
            map.remove(&spec.name);
        }
        let spawned = LiveStdioMcp::spawn(spec, command, args, env, &self.local_root).await?;
        map.insert(spec.name.clone(), spawned.clone());
        Ok(spawned)
    }

    pub async fn handle_rpc(
        &self,
        server_name: &str,
        message: &Value,
        expect_reply: bool,
    ) -> Option<Value> {
        let orig_id = message.get("id").cloned().unwrap_or(Value::Null);
        let Some(spec) = self.specs.get(server_name) else {
            return expect_reply.then(|| {
                json!({
                    "jsonrpc": "2.0",
                    "id": orig_id,
                    "error": { "code": -32601, "message": format!("Unknown Client MCP server: {server_name}") }
                })
            });
        };

        // 并发闸：Host 侧若一口气发来大量 `mcp_rpc_req`，在这里排队而不是全部 spawn 出去。
        let _permit =
            match tokio::time::timeout(CLIENT_MCP_QUEUE_TIMEOUT, self.calls.acquire()).await {
                Ok(Ok(permit)) => permit,
                Ok(Err(_)) => {
                    return expect_reply.then(|| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": orig_id,
                            "error": { "code": -32000, "message": "MCP 隧道已关闭" }
                        })
                    });
                }
                Err(_) => {
                    return expect_reply.then(|| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": orig_id,
                            "error": { "code": -32000, "message": "MCP 调用排队超时，请减少并发" }
                        })
                    });
                }
            };

        match &spec.transport {
            ClientMcpTransport::Stdio { command, args, env } => {
                let inst = match self.get_or_spawn_stdio(spec, command, args, env).await {
                    Ok(i) => i,
                    Err(err) => {
                        return expect_reply.then(|| {
                            json!({
                                "jsonrpc": "2.0",
                                "id": orig_id,
                                "error": { "code": -32000, "message": err }
                            })
                        });
                    }
                };
                if !expect_reply {
                    let _ = inst.send_notification(message).await;
                    return None;
                }
                match inst.call(message).await {
                    Ok(resp) => Some(resp),
                    Err(err) => Some(json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "error": { "code": -32000, "message": err }
                    })),
                }
            }
            ClientMcpTransport::Http { url, headers } => {
                let mut req = self
                    .http_client
                    .post(url)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json");
                for (k, v) in headers {
                    req = req.header(k, v);
                }
                let payload = serde_json::to_vec(message).unwrap_or_default();
                if payload.len() > MAX_MCP_MESSAGE_BYTES {
                    return expect_reply.then(|| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": orig_id,
                            "error": { "code": -32000, "message": format!("MCP 请求超过 {} MiB 上限", MAX_MCP_MESSAGE_BYTES / (1024 * 1024)) }
                        })
                    });
                }
                let sent = req.body(payload).send().await;
                if !expect_reply {
                    return None;
                }
                let over_limit = |orig_id: Value| {
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "error": { "code": -32000, "message": format!("MCP 响应超过 {} MiB 上限", MAX_MCP_MESSAGE_BYTES / (1024 * 1024)) }
                    }))
                };
                match sent {
                    Ok(resp) => {
                        if resp
                            .content_length()
                            .is_some_and(|n| n > MAX_MCP_MESSAGE_BYTES as u64)
                        {
                            return over_limit(orig_id);
                        }
                        let mut body: Vec<u8> = Vec::new();
                        let mut stream = resp.bytes_stream();
                        while let Some(chunk) = stream.next().await {
                            match chunk {
                                Ok(bytes) => {
                                    if body.len() + bytes.len() > MAX_MCP_MESSAGE_BYTES {
                                        return over_limit(orig_id);
                                    }
                                    body.extend_from_slice(&bytes);
                                }
                                Err(err) => {
                                    return Some(json!({
                                        "jsonrpc": "2.0",
                                        "id": orig_id,
                                        "error": { "code": -32000, "message": format!("Read MCP HTTP body failed: {err}") }
                                    }));
                                }
                            }
                        }
                        match serde_json::from_slice::<Value>(&body) {
                            Ok(val) => Some(val),
                            Err(err) => Some(json!({
                                "jsonrpc": "2.0",
                                "id": orig_id,
                                "error": { "code": -32000, "message": format!("Invalid MCP HTTP JSON: {err}") }
                            })),
                        }
                    }
                    Err(err) => Some(json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "error": { "code": -32000, "message": format!("Client MCP HTTP request failed: {err}") }
                    })),
                }
            }
        }
    }
}

/// Host 侧轻量 stdio MCP 转发代理子命令：
/// `multicc-gateway mcp-relay-proxy --server <name>`
pub async fn serve_mcp_relay_proxy(args: &[String]) -> i32 {
    let mut server_name = String::new();
    let mut idx = 0usize;
    while idx < args.len() {
        if args[idx] == "--server" && idx + 1 < args.len() {
            server_name = args[idx + 1].trim().to_string();
            idx += 2;
            continue;
        }
        idx += 1;
    }
    if !is_valid_external_mcp_name(&server_name) {
        eprintln!("Invalid --server name for mcp-relay-proxy");
        return 1;
    }
    let base_url = std::env::var("MULTICC_HOST_EXEC_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let token = std::env::var("MULTICC_HOST_EXEC_TOKEN").unwrap_or_default();
    if base_url.is_empty() || token.is_empty() {
        eprintln!("MULTICC_HOST_EXEC_URL / MULTICC_HOST_EXEC_TOKEN missing");
        return 1;
    }

    let endpoint = format!("{base_url}/mcp/{server_name}");
    let auth_header = format!("Bearer {token}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(CLIENT_MCP_CALL_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(mut line) = out_rx.recv().await {
            if !line.ends_with('\n') {
                line.push('\n');
            }
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let has_id = msg.get("id").is_some_and(|v| !v.is_null());
        let orig_id = msg.get("id").cloned().unwrap_or(Value::Null);
        let c = client.clone();
        let url = endpoint.clone();
        let auth = auth_header.clone();
        let tx = out_tx.clone();
        tokio::spawn(async move {
            let payload = serde_json::to_vec(&msg).unwrap_or_default();
            let res = c
                .post(&url)
                .header("Authorization", auth)
                .header("Content-Type", "application/json")
                .body(payload)
                .send()
                .await;
            if !has_id {
                return;
            }
            let reply = match res {
                Ok(r) if r.status().as_u16() == 204 => return,
                Ok(r) if r.status().as_u16() == 413 => json!({
                    "jsonrpc": "2.0",
                    "id": orig_id,
                    "error": { "code": -32603, "message": "MCP 请求体超过中转桥上限，请减小参数体积" }
                }),
                Ok(r) => match r.bytes().await {
                    Ok(bytes) if bytes.len() > MAX_MCP_MESSAGE_BYTES => json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "error": { "code": -32603, "message": format!("MCP 响应超过 {} MiB 上限", MAX_MCP_MESSAGE_BYTES / (1024 * 1024)) }
                    }),
                    Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|err| {
                        json!({
                            "jsonrpc": "2.0",
                            "id": orig_id,
                            "error": { "code": -32603, "message": format!("Invalid MCP relay JSON: {err}") }
                        })
                    }),
                    Err(err) => json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "error": { "code": -32603, "message": format!("Read MCP relay body error: {err}") }
                    }),
                },
                Err(err) => json!({
                    "jsonrpc": "2.0",
                    "id": orig_id,
                    "error": { "code": -32603, "message": format!("MCP relay bridge error: {err}") }
                }),
            };
            let _ = tx.send(reply.to_string());
        });
    }

    drop(out_tx);
    let _ = writer.await;
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn capped_line_reader_keeps_the_boundary_and_drops_oversize_lines() {
        let data = b"{\"ok\":1}\n{\"big\":\"aaaaaaaaaa\"}\n{\"ok\":2}\n";
        let mut reader = BufReader::new(&data[..]);
        let mut buf = Vec::new();

        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 8).await.unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"{\"ok\":1}");
        // 超限整行丢弃，但下一个气泡从新行重新开始。
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 8).await.unwrap(),
            Some(false)
        );
        assert!(buf.is_empty());
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 8).await.unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"{\"ok\":2}");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 8).await.unwrap(),
            None
        );
    }

    #[test]
    fn validates_external_mcp_names_and_excludes_multicc_reserved_servers() {
        assert!(is_valid_external_mcp_name("playwright"));
        assert!(is_valid_external_mcp_name("postgres-prod_1"));
        assert!(!is_valid_external_mcp_name("multicc_router"));
        assert!(!is_valid_external_mcp_name("multicc_host_exec"));
        assert!(!is_valid_external_mcp_name("multicc-custom"));
        assert!(!is_valid_external_mcp_name("../evil"));
        assert!(!is_valid_external_mcp_name("a/b"));

        let mut map = HashMap::new();
        collect_from_mcp_json_value(
            &json!({
                "mcpServers": {
                    "multicc_router": { "command": "node", "args": ["r.js"] },
                    "playwright": { "command": "npx", "args": ["@playwright/mcp"], "env": { "API_KEY": "secret" } },
                    "disabled_one": { "command": "npx", "disabled": true }
                }
            }),
            &mut map,
        );
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("playwright"));
    }
}
