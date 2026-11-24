//! CLI-agnostic 本地真机执行服务（Host Exec Loopback Server）与 Rust 原生 stdio MCP 桥接。
//!
//! 任何远端/容器承载的编码 Agent（首期 `agy`，后续可扩展到 Claude Code / Codex / Gemini）
//! 均可通过 SSH 反向端口转发回连到本机临时启动的 `127.0.0.1:<ephemeral>` HTTP 服务，
//! 凭单回合 256-bit 随机 Bearer Token 在受工作区路径越狱保护的范围内执行真机命令与文件操作。

use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use multicc_core::host_exec::{
    apply_fs_edit, clamp_timeout_ms, map_remote_to_local_cwd, map_remote_to_local_path,
    truncate_utf8_bytes, verify_bearer_token, HostExecRequest, HostExecResponse, HostFsEditRequest,
    HostFsListRequest, HostFsReadRequest, HostFsWriteRequest, HostViewImageRequest,
    MAX_OUTPUT_BYTES,
};

use crate::cli_relay_attachments::{image_media_type_for_path, MAX_RELAY_IMAGE_BYTES};
use crate::cli_relay_skills::{client_home_dir, default_readonly_skill_roots};

pub type AsyncHook =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

pub struct HostExecServerConfig {
    pub local_root: PathBuf,
    pub remote_root: String,
    pub file_mode: String,
    pub token: String,
    pub before_exec: Option<AsyncHook>,
    pub after_exec: Option<AsyncHook>,
}

struct ServerState {
    local_root: PathBuf,
    canonical_root: Option<PathBuf>,
    canonical_temp_dir: Option<PathBuf>,
    /// 只读技能根目录，在服务启动时（每回合一次）快照。
    readonly_roots: Vec<PathBuf>,
    remote_root: String,
    file_mode: String,
    token: String,
    before_exec: Option<AsyncHook>,
    after_exec: Option<AsyncHook>,
    exec_lock: Mutex<()>,
}

/// 生成 256-bit 随机十六进制 Bearer Token（每回合一次性使用）。
pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "系统随机源不可用".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn unauthorized_response(headers: &HeaderMap, expected: &str) -> Option<Response> {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok());
    if verify_bearer_token(auth, expected) {
        None
    } else {
        Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "ok": false, "error": "unauthorized" })),
            )
                .into_response(),
        )
    }
}

/// 防止通过符号链接逃逸工作区根目录（校验目标路径或最近已存在祖先的 canonicalize）。
fn verify_no_symlink_escape(target: &Path, canonical_root: Option<&Path>) -> Result<(), String> {
    let Some(root) = canonical_root else {
        return Ok(());
    };
    let mut cursor = target.to_path_buf();
    loop {
        if cursor.exists() {
            let resolved =
                std::fs::canonicalize(&cursor).map_err(|err| format!("无法校验目标路径: {err}"))?;
            if !resolved.starts_with(root) {
                return Err(format!(
                    "路径越界：符号链接指向工作区之外 ({})",
                    target.display()
                ));
            }
            return Ok(());
        }
        if !cursor.pop() {
            return Ok(());
        }
    }
}

/// 共享临时目录下只认自己创建的条目：仅看文件名前缀挡不住同机其他用户
/// 抢先放置同名文件。
#[cfg(unix)]
fn temp_entry_owned_by_current_user(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path)
        .map(|meta| meta.uid() == unsafe { libc::geteuid() })
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn temp_entry_owned_by_current_user(_path: &Path) -> bool {
    true
}

fn expand_tilde_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = client_home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    trimmed.to_string()
}

/// 解析严格只读访问路径（供 `host_read_file`、`host_list_dir`、`host_view_image` 共用）：
/// 1. 工作区 `local_root` 内的常规路径；
/// 2. 只读白名单根目录（如 `~/.agents/skills`、`~/.claude/skills` 等）内的已存在路径；
/// 3. （仅 `allow_multicc_temp=true` 时）OS 临时目录中以 `multicc_` 开头的截图/上传图片。
/// 写操作（`host_write_file`/`host_edit_file`）绝不调用此函数，保持 100% 锁定在 `local_root` 内。
fn resolve_readonly_path(
    requested: Option<&str>,
    state: &ServerState,
    allow_multicc_temp: bool,
) -> Result<PathBuf, String> {
    let expanded = requested.map(expand_tilde_path);
    let raw_opt = expanded.as_deref();
    if let Ok(ws_path) = map_remote_to_local_path(raw_opt, &state.remote_root, &state.local_root) {
        verify_no_symlink_escape(&ws_path, state.canonical_root.as_deref())?;
        return Ok(ws_path);
    }
    let Some(raw) = raw_opt.filter(|s| !s.is_empty()) else {
        return Err("路径不能为空".to_string());
    };
    let candidate = Path::new(raw);
    if !candidate.is_absolute() {
        return Err(format!("路径越界：不允许访问工作区之外的路径 ({raw})"));
    }
    let canonical =
        std::fs::canonicalize(candidate).map_err(|_| format!("路径越界或文件不存在 ({raw})"))?;
    // 只读根目录用启动快照：本服务每回合重建，技能目录在回合间新建也能在下一回合可见；
    // 同时环境变量配置（MULTICC_HOST_EXEC_READONLY_DIRS）按启动时的语义固定，不受中途清空影响。
    if state
        .readonly_roots
        .iter()
        .any(|allowed_root| canonical.starts_with(allowed_root))
    {
        return Ok(canonical);
    }
    if allow_multicc_temp {
        if let Some(tmp_root) = state.canonical_temp_dir.as_deref() {
            if canonical.starts_with(tmp_root)
                && canonical
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|n| n.starts_with("multicc_"))
                && temp_entry_owned_by_current_user(&canonical)
            {
                return Ok(canonical);
            }
        }
    }
    Err(format!(
        "路径越界：不允许访问工作区或只读技能目录之外的路径 ({raw})"
    ))
}

async fn handle_health(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    if let Some(resp) = unauthorized_response(&headers, &state.token) {
        return resp;
    }
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

async fn handle_info(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    if let Some(resp) = unauthorized_response(&headers, &state.token) {
        return resp;
    }
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "hostOs": std::env::consts::OS,
            "hostArch": std::env::consts::ARCH,
            "localRoot": state.local_root.to_string_lossy(),
            "remoteRoot": state.remote_root,
            "fileMode": state.file_mode,
        })),
    )
        .into_response()
}

async fn handle_exec(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<HostExecRequest>,
) -> Response {
    if let Some(resp) = unauthorized_response(&headers, &state.token) {
        return resp;
    }
    if req.command.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "command 不能为空" })),
        )
            .into_response();
    }

    let resolved_cwd =
        match map_remote_to_local_cwd(req.cwd.as_deref(), &state.remote_root, &state.local_root) {
            Ok(dir) => dir,
            Err(err) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "ok": false, "error": err })),
                )
                    .into_response();
            }
        };
    if let Err(err) = verify_no_symlink_escape(&resolved_cwd, state.canonical_root.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response();
    }

    let _guard = state.exec_lock.lock().await;
    let started = Instant::now();

    if let Some(hook) = &state.before_exec {
        if let Err(err) = hook().await {
            return (
                StatusCode::OK,
                Json(HostExecResponse {
                    ok: false,
                    exit_code: None,
                    timed_out: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    duration_ms: started.elapsed().as_millis() as u64,
                    resolved_cwd: resolved_cwd.to_string_lossy().into_owned(),
                    error: Some(format!("命令执行前同步失败: {err}")),
                }),
            )
                .into_response();
        }
    }

    let timeout_ms = clamp_timeout_ms(req.timeout_ms);
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &req.command]);
        c
    } else {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", &req.command]);
        c
    };
    cmd.current_dir(&resolved_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON")
        .env_remove("MULTICC_HOST_EXEC_TOKEN")
        .env_remove("MULTICC_ROUTER_CAPABILITY");
    if let Some(extra_env) = &req.env {
        for (k, v) in extra_env {
            let key = k.trim();
            if !key.is_empty() && !key.starts_with("MULTICC_") {
                cmd.env(key, v);
            }
        }
    }

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return (
                StatusCode::OK,
                Json(HostExecResponse {
                    ok: false,
                    exit_code: None,
                    timed_out: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    duration_ms: started.elapsed().as_millis() as u64,
                    resolved_cwd: resolved_cwd.to_string_lossy().into_owned(),
                    error: Some(format!("无法启动本机命令: {err}")),
                }),
            )
                .into_response();
        }
    };

    let (ok, exit_code, timed_out, stdout, stderr, mut error) =
        match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
            .await
        {
            Ok(Ok(output)) => {
                let code = output.status.code();
                (
                    true,
                    code,
                    false,
                    truncate_utf8_bytes(&output.stdout, MAX_OUTPUT_BYTES),
                    truncate_utf8_bytes(&output.stderr, MAX_OUTPUT_BYTES),
                    None,
                )
            }
            Ok(Err(err)) => (
                false,
                None,
                false,
                String::new(),
                String::new(),
                Some(format!("等待命令结果失败: {err}")),
            ),
            Err(_) => (
                false,
                None,
                true,
                String::new(),
                String::new(),
                Some(format!("命令执行超过 {timeout_ms}ms 已终止")),
            ),
        };

    if let Some(hook) = &state.after_exec {
        if let Err(err) = hook().await {
            let note = format!("命令执行后同步警告: {err}");
            error = Some(match error {
                Some(prev) => format!("{prev}; {note}"),
                None => note,
            });
        }
    }

    (
        StatusCode::OK,
        Json(HostExecResponse {
            ok,
            exit_code,
            timed_out,
            stdout,
            stderr,
            duration_ms: started.elapsed().as_millis() as u64,
            resolved_cwd: resolved_cwd.to_string_lossy().into_owned(),
            error,
        }),
    )
        .into_response()
}

async fn handle_fs_read(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<HostFsReadRequest>,
) -> Response {
    if let Some(resp) = unauthorized_response(&headers, &state.token) {
        return resp;
    }
    let path = match resolve_readonly_path(Some(req.path.as_str()), &state, false) {
        Ok(path) => path,
        Err(err) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": err })),
            )
                .into_response();
        }
    };
    let max_bytes = req
        .max_bytes
        .unwrap_or(MAX_OUTPUT_BYTES)
        .clamp(1, 1024 * 1024);
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "bytes": bytes.len(),
                "content": truncate_utf8_bytes(&bytes, max_bytes),
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::OK,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_fs_write(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<HostFsWriteRequest>,
) -> Response {
    if let Some(resp) = unauthorized_response(&headers, &state.token) {
        return resp;
    }
    let path = match map_remote_to_local_path(
        Some(req.path.as_str()),
        &state.remote_root,
        &state.local_root,
    ) {
        Ok(path) => path,
        Err(err) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": err })),
            )
                .into_response();
        }
    };
    if let Err(err) = verify_no_symlink_escape(&path, state.canonical_root.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response();
    }
    if let Some(parent) = path.parent() {
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            return (
                StatusCode::OK,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
                .into_response();
        }
    }
    let bytes = req.content.as_bytes();
    match tokio::fs::write(&path, bytes).await {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "bytes": bytes.len(),
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::OK,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_fs_edit(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<HostFsEditRequest>,
) -> Response {
    if let Some(resp) = unauthorized_response(&headers, &state.token) {
        return resp;
    }
    let path =
        match map_remote_to_local_path(Some(&req.path), &state.remote_root, &state.local_root) {
            Ok(path) => path,
            Err(err) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "ok": false, "error": err })),
                )
                    .into_response();
            }
        };
    if let Err(err) = verify_no_symlink_escape(&path, state.canonical_root.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response();
    }
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(err) => {
            return (
                StatusCode::OK,
                Json(json!({ "ok": false, "error": format!("读取待编辑文件失败: {err}") })),
            )
                .into_response();
        }
    };
    let (updated, replacements) =
        match apply_fs_edit(&raw, &req.old_text, &req.new_text, req.replace_all) {
            Ok(pair) => pair,
            Err(err) => {
                return (StatusCode::OK, Json(json!({ "ok": false, "error": err })))
                    .into_response();
            }
        };
    let bytes = updated.as_bytes();
    match tokio::fs::write(&path, bytes).await {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "replacements": replacements,
                "bytes": bytes.len(),
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::OK,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_fs_list(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<HostFsListRequest>,
) -> Response {
    if let Some(resp) = unauthorized_response(&headers, &state.token) {
        return resp;
    }
    let path = match resolve_readonly_path(req.path.as_deref(), &state, false) {
        Ok(path) => path,
        Err(err) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": err })),
            )
                .into_response();
        }
    };
    let mut rd = match tokio::fs::read_dir(&path).await {
        Ok(rd) => rd,
        Err(err) => {
            return (
                StatusCode::OK,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
                .into_response();
        }
    };
    let mut entries = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        if entries.len() >= 500 {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = entry.metadata().await.ok();
        let kind = match meta.as_ref() {
            Some(m) if m.is_dir() => "dir",
            Some(m) if m.is_file() => "file",
            _ => "other",
        };
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        entries.push(json!({ "name": name, "kind": kind, "size": size }));
    }
    entries.sort_by(|a, b| {
        let ka = a["name"].as_str().unwrap_or("");
        let kb = b["name"].as_str().unwrap_or("");
        ka.cmp(kb)
    });
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "entries": entries,
        })),
    )
        .into_response()
}

async fn handle_fs_view_image(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<HostViewImageRequest>,
) -> Response {
    if let Some(resp) = unauthorized_response(&headers, &state.token) {
        return resp;
    }
    let path = match resolve_readonly_path(Some(req.path.as_str()), &state, true) {
        Ok(path) => path,
        Err(err) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": err })),
            )
                .into_response();
        }
    };
    let Some(media_type) = image_media_type_for_path(&path) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": "仅支持查看 png/jpg/jpeg/gif/webp 格式图片"
            })),
        )
            .into_response();
    };
    // 打开后在同一句柄上取元数据再限长读取，避免「先 stat 后按路径重开」的 TOCTOU。
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(err) => {
            return (
                StatusCode::OK,
                Json(json!({ "ok": false, "error": format!("打开图片失败: {err}") })),
            )
                .into_response();
        }
    };
    let meta = match file.metadata().await {
        Ok(m) => m,
        Err(err) => {
            return (
                StatusCode::OK,
                Json(json!({ "ok": false, "error": format!("读取图片元数据失败: {err}") })),
            )
                .into_response();
        }
    };
    if !meta.is_file() || meta.len() == 0 {
        return (
            StatusCode::OK,
            Json(json!({ "ok": false, "error": "目标不是有效的非空图片文件" })),
        )
            .into_response();
    }
    if meta.len() as usize > MAX_RELAY_IMAGE_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "ok": false,
                "error": format!("图片体积超过 {} MiB 限制", MAX_RELAY_IMAGE_BYTES / (1024 * 1024))
            })),
        )
            .into_response();
    }
    // 即使 stat 通过也按上限截断读取：文件可能在检查后被追加。
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    match file
        .take(MAX_RELAY_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
    {
        Ok(_) if bytes.len() > MAX_RELAY_IMAGE_BYTES => (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "ok": false,
                "error": format!("图片体积超过 {} MiB 限制", MAX_RELAY_IMAGE_BYTES / (1024 * 1024))
            })),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "mediaType": media_type,
                "bytes": bytes.len(),
                "dataBase64": BASE64.encode(&bytes),
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::OK,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

/// 在 `127.0.0.1:0` 启动一次性真机执行 HTTP 服务。
pub async fn start_host_exec_server(
    config: HostExecServerConfig,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>), String> {
    let canonical_root = std::fs::canonicalize(&config.local_root).ok();
    let canonical_temp_dir = std::fs::canonicalize(std::env::temp_dir()).ok();
    let readonly_roots = default_readonly_skill_roots();
    let state = Arc::new(ServerState {
        local_root: config.local_root,
        canonical_root,
        canonical_temp_dir,
        readonly_roots,
        remote_root: config.remote_root,
        file_mode: config.file_mode,
        token: config.token,
        before_exec: config.before_exec,
        after_exec: config.after_exec,
        exec_lock: Mutex::new(()),
    });

    let app = Router::new()
        .route("/health", get(handle_health))
        .route("/info", get(handle_info))
        .route("/exec", post(handle_exec))
        .route("/fs/read", post(handle_fs_read))
        .route("/fs/write", post(handle_fs_write))
        .route("/fs/edit", post(handle_fs_edit))
        .route("/fs/list", post(handle_fs_list))
        .route("/fs/view_image", post(handle_fs_view_image))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("无法监听本机 Host-Exec 环回端口: {err}"))?;
    let addr = listener
        .local_addr()
        .map_err(|err| format!("无法获取 Host-Exec 监听地址: {err}"))?;
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((addr, handle))
}

/// Rust 原生 stdio MCP server（`multicc-gateway host-exec-mcp`），供已安装 `multicc-gateway`
/// 的远端机器零 Node 依赖运行；协议与 `render_remote_mcp_script()` 完全一致。
pub async fn serve_mcp_stdio() -> i32 {
    let base_url = std::env::var("MULTICC_HOST_EXEC_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let token = std::env::var("MULTICC_HOST_EXEC_TOKEN").unwrap_or_default();
    let local_root = std::env::var("MULTICC_HOST_EXEC_LOCAL_ROOT").unwrap_or_default();
    let remote_root = std::env::var("MULTICC_HOST_EXEC_REMOTE_ROOT").unwrap_or_default();
    let host_os = std::env::var("MULTICC_HOST_EXEC_OS").unwrap_or_else(|_| "unknown".to_string());
    let file_mode =
        std::env::var("MULTICC_HOST_EXEC_FILE_MODE").unwrap_or_else(|_| "mutagen".to_string());

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(610))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut tools = vec![
        json!({
            "name": "host_run_command",
            "description": format!("Execute a shell command on the user's REAL local development machine ({host_os})."),
            "inputSchema": {
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string" },
                    "timeout_seconds": { "type": "number" }
                }
            }
        }),
        json!({
            "name": "host_info",
            "description": "Return real host machine OS, workspace root mapping, and file sync mode.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "host_view_image",
            "description": "Inspect an image file (png/jpeg/gif/webp) from the user's real local machine and return it as a native multimodal image block.",
            "inputSchema": {
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" }
                }
            }
        }),
    ];
    if file_mode == "remote_mcp" {
        tools.push(json!({
            "name": "host_read_file",
            "description": "Read a file directly from the user's real local machine workspace.",
            "inputSchema": {
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" },
                    "max_bytes": { "type": "integer" }
                }
            }
        }));
        tools.push(json!({
            "name": "host_write_file",
            "description": "Write a file directly on the user's real local machine workspace.",
            "inputSchema": {
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                }
            }
        }));
        tools.push(json!({
            "name": "host_edit_file",
            "description": "Perform an exact search-and-replace edit on a file in the user's real local machine workspace (much cheaper than rewriting whole files).",
            "inputSchema": {
                "type": "object",
                "required": ["path", "old_text", "new_text"],
                "properties": {
                    "path": { "type": "string" },
                    "old_text": { "type": "string" },
                    "new_text": { "type": "string" },
                    "replace_all": { "type": "boolean" }
                }
            }
        }));
        tools.push(json!({
            "name": "host_list_dir",
            "description": "List directory entries on the user's real local machine workspace.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string" } }
            }
        }));
    }

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(id) = msg.get("id").filter(|v| !v.is_null()).cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let response = match method {
            "initialize" => {
                let proto = msg
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2024-11-05");
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": proto,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "multicc-host-exec", "version": "1.0.0" }
                    }
                })
            }
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": tools }
            }),
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            "tools/call" => {
                let name = msg
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let args = msg
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let result = call_mcp_tool(
                    &client,
                    &base_url,
                    &token,
                    &host_os,
                    &local_root,
                    &remote_root,
                    &file_mode,
                    name,
                    &args,
                )
                .await;
                json!({ "jsonrpc": "2.0", "id": id, "result": result })
            }
            other => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {other}") }
            }),
        };
        if let Ok(mut encoded) = serde_json::to_string(&response) {
            encoded.push('\n');
            if stdout.write_all(encoded.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    }
    0
}

#[allow(clippy::too_many_arguments)]
async fn call_mcp_tool(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    host_os: &str,
    local_root: &str,
    remote_root: &str,
    file_mode: &str,
    name: &str,
    args: &Value,
) -> Value {
    if name == "host_info" {
        return json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string_pretty(&json!({
                    "hostOs": host_os,
                    "localRoot": local_root,
                    "remoteRoot": remote_root,
                    "fileMode": file_mode,
                })).unwrap_or_default()
            }]
        });
    }
    if base_url.is_empty() || token.is_empty() {
        return json!({
            "isError": true,
            "content": [{ "type": "text", "text": "MULTICC_HOST_EXEC_URL / MULTICC_HOST_EXEC_TOKEN missing" }]
        });
    }

    let post_json = |endpoint: &str, body: Value| {
        let url = format!("{base_url}{endpoint}");
        let auth = format!("Bearer {token}");
        let payload = serde_json::to_vec(&body).unwrap_or_default();
        async move {
            let resp = client
                .post(url)
                .header("Authorization", auth)
                .header("Content-Type", "application/json")
                .body(payload)
                .send()
                .await
                .map_err(|err| err.to_string())?;
            let bytes = resp.bytes().await.map_err(|err| err.to_string())?;
            serde_json::from_slice::<Value>(&bytes).map_err(|err| err.to_string())
        }
    };

    match name {
        "host_run_command" => {
            let timeout_ms = args
                .get("timeout_seconds")
                .and_then(Value::as_f64)
                .map(|s| (s * 1000.0).round().clamp(1000.0, 600_000.0) as u64);
            let body = json!({
                "command": args.get("command").and_then(Value::as_str).unwrap_or(""),
                "cwd": args.get("cwd").and_then(Value::as_str),
                "timeoutMs": timeout_ms,
            });
            match post_json("/exec", body).await {
                Ok(res) => {
                    let timed_out = res
                        .get("timedOut")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let exit_code = res.get("exitCode").and_then(Value::as_i64);
                    let dur = res.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
                    let cwd = res
                        .get("resolvedCwd")
                        .and_then(Value::as_str)
                        .unwrap_or(local_root);
                    let mut parts = vec![if timed_out {
                        format!("Command timed out after {dur}ms (cwd: {cwd})")
                    } else {
                        format!(
                            "Exit code: {} ({dur}ms, cwd: {cwd})",
                            exit_code
                                .map(|c| c.to_string())
                                .unwrap_or_else(|| "unknown".into())
                        )
                    }];
                    if let Some(err) = res.get("error").and_then(Value::as_str) {
                        parts.push(format!("Error: {err}"));
                    }
                    if let Some(out) = res
                        .get("stdout")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        parts.push(format!("--- stdout ---\n{out}"));
                    }
                    if let Some(err) = res
                        .get("stderr")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        parts.push(format!("--- stderr ---\n{err}"));
                    }
                    let is_err = !res.get("ok").and_then(Value::as_bool).unwrap_or(false)
                        || timed_out
                        || exit_code.is_some_and(|c| c != 0);
                    json!({
                        "isError": is_err,
                        "content": [{ "type": "text", "text": parts.join("\n") }]
                    })
                }
                Err(err) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Host exec failed: {err}") }]
                }),
            }
        }
        "host_read_file" => {
            let body = json!({
                "path": args.get("path").and_then(Value::as_str).unwrap_or(""),
                "maxBytes": args.get("max_bytes").and_then(Value::as_u64),
            });
            match post_json("/fs/read", body).await {
                Ok(res) if res.get("ok").and_then(Value::as_bool) == Some(true) => json!({
                    "content": [{ "type": "text", "text": res.get("content").and_then(Value::as_str).unwrap_or("") }]
                }),
                Ok(res) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {}", res.get("error").and_then(Value::as_str).unwrap_or("read failed")) }]
                }),
                Err(err) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {err}") }]
                }),
            }
        }
        "host_write_file" => {
            let body = json!({
                "path": args.get("path").and_then(Value::as_str).unwrap_or(""),
                "content": args.get("content").and_then(Value::as_str).unwrap_or(""),
            });
            match post_json("/fs/write", body).await {
                Ok(res) if res.get("ok").and_then(Value::as_bool) == Some(true) => json!({
                    "content": [{ "type": "text", "text": format!("Wrote {} bytes to {}", res["bytes"], res["path"].as_str().unwrap_or("")) }]
                }),
                Ok(res) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {}", res.get("error").and_then(Value::as_str).unwrap_or("write failed")) }]
                }),
                Err(err) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {err}") }]
                }),
            }
        }
        "host_edit_file" => {
            let body = json!({
                "path": args.get("path").and_then(Value::as_str).unwrap_or(""),
                "oldText": args.get("old_text").or_else(|| args.get("oldText")).and_then(Value::as_str).unwrap_or(""),
                "newText": args.get("new_text").or_else(|| args.get("newText")).and_then(Value::as_str).unwrap_or(""),
                "replaceAll": args.get("replace_all").or_else(|| args.get("replaceAll")).and_then(Value::as_bool).unwrap_or(false),
            });
            match post_json("/fs/edit", body).await {
                Ok(res) if res.get("ok").and_then(Value::as_bool) == Some(true) => json!({
                    "content": [{
                        "type": "text",
                        "text": format!(
                            "Applied {} replacement(s) to {} ({} bytes)",
                            res["replacements"],
                            res["path"].as_str().unwrap_or(""),
                            res["bytes"]
                        )
                    }]
                }),
                Ok(res) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {}", res.get("error").and_then(Value::as_str).unwrap_or("edit failed")) }]
                }),
                Err(err) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {err}") }]
                }),
            }
        }
        "host_list_dir" => {
            let body = json!({ "path": args.get("path").and_then(Value::as_str) });
            match post_json("/fs/list", body).await {
                Ok(res) if res.get("ok").and_then(Value::as_bool) == Some(true) => json!({
                    "content": [{ "type": "text", "text": serde_json::to_string_pretty(&res["entries"]).unwrap_or_default() }]
                }),
                Ok(res) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {}", res.get("error").and_then(Value::as_str).unwrap_or("list failed")) }]
                }),
                Err(err) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {err}") }]
                }),
            }
        }
        "host_view_image" => {
            let body = json!({ "path": args.get("path").and_then(Value::as_str).unwrap_or("") });
            match post_json("/fs/view_image", body).await {
                Ok(res) if res.get("ok").and_then(Value::as_bool) == Some(true) => {
                    let resolved = res.get("path").and_then(Value::as_str).unwrap_or("");
                    let media_type = res
                        .get("mediaType")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png");
                    let bytes = res.get("bytes").and_then(Value::as_u64).unwrap_or(0);
                    let data = res.get("dataBase64").and_then(Value::as_str).unwrap_or("");
                    json!({
                        "content": [
                            {
                                "type": "text",
                                "text": format!("Viewed image {resolved} ({media_type}, {bytes} bytes)")
                            },
                            {
                                "type": "image",
                                "data": data,
                                "mimeType": media_type
                            }
                        ]
                    })
                }
                Ok(res) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {}", res.get("error").and_then(Value::as_str).unwrap_or("view_image failed")) }]
                }),
                Err(err) => json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: {err}") }]
                }),
            }
        }
        other => json!({
            "isError": true,
            "content": [{ "type": "text", "text": format!("Unknown tool: {other}") }]
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn host_exec_server_runs_commands_fs_ops_and_enforces_auth_and_jail() {
        let dir = std::env::temp_dir().join(format!(
            "multicc-host-exec-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("sub")).unwrap();

        let before_count = Arc::new(AtomicUsize::new(0));
        let after_count = Arc::new(AtomicUsize::new(0));
        let b = before_count.clone();
        let a = after_count.clone();
        let token = generate_token().unwrap();

        let (addr, handle) = start_host_exec_server(HostExecServerConfig {
            local_root: dir.clone(),
            remote_root: "/remote/ws/demo".to_string(),
            file_mode: "remote_mcp".to_string(),
            token: token.clone(),
            before_exec: Some(Arc::new(move || {
                let b = b.clone();
                Box::pin(async move {
                    b.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            })),
            after_exec: Some(Arc::new(move || {
                let a = a.clone();
                Box::pin(async move {
                    a.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            })),
        })
        .await
        .unwrap();

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{addr}");
        let post_raw = |url: String, auth: Option<&str>, body: Value| {
            let mut req = client
                .post(url)
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(&body).unwrap());
            if let Some(a) = auth {
                req = req.header("Authorization", a);
            }
            req.send()
        };

        // Unauthorized request must get 401
        let unauth = post_raw(
            format!("{base}/exec"),
            None,
            json!({ "command": "echo nope" }),
        )
        .await
        .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        // Authorized fs/write + fs/read + fs/list
        let auth = format!("Bearer {token}");
        let w: Value = serde_json::from_slice(
            &post_raw(
                format!("{base}/fs/write"),
                Some(&auth),
                json!({ "path": "sub/hello.txt", "content": "hello host" }),
            )
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(w["ok"], true);

        let r: Value = serde_json::from_slice(
            &post_raw(
                format!("{base}/fs/read"),
                Some(&auth),
                json!({ "path": "/remote/ws/demo/sub/hello.txt" }),
            )
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(r["ok"], true);
        assert_eq!(r["content"], "hello host");

        // Authorized fs/edit replaces exact text in-place
        let e: Value = serde_json::from_slice(
            &post_raw(
                format!("{base}/fs/edit"),
                Some(&auth),
                json!({
                    "path": "/remote/ws/demo/sub/hello.txt",
                    "oldText": "host",
                    "newText": "edited-host",
                }),
            )
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(e["ok"], true);
        assert_eq!(e["replacements"], 1);
        assert_eq!(
            std::fs::read_to_string(dir.join("sub/hello.txt")).unwrap(),
            "hello edited-host"
        );
        // Restore original content before subsequent cat assertion
        let _ = post_raw(
            format!("{base}/fs/edit"),
            Some(&auth),
            json!({
                "path": "sub/hello.txt",
                "oldText": "edited-host",
                "newText": "host",
            }),
        )
        .await
        .unwrap();

        // Escape attempt must be 403
        let esc = post_raw(
            format!("{base}/fs/read"),
            Some(&auth),
            json!({ "path": "../../etc/passwd" }),
        )
        .await
        .unwrap();
        assert_eq!(esc.status(), StatusCode::FORBIDDEN);

        // Authorized /exec maps remote cwd to local dir and runs before/after hooks
        let exec: Value = serde_json::from_slice(
            &post_raw(
                format!("{base}/exec"),
                Some(&auth),
                json!({
                    "command": "cat hello.txt",
                    "cwd": "/remote/ws/demo/sub"
                }),
            )
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(exec["ok"], true);
        assert_eq!(exec["exitCode"], 0);
        assert_eq!(exec["stdout"].as_str().unwrap().trim(), "hello host");
        assert_eq!(before_count.load(Ordering::SeqCst), 1);
        assert_eq!(after_count.load(Ordering::SeqCst), 1);

        handle.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn host_exec_allows_readonly_skill_dirs_and_view_image_while_blocking_writes() {
        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        let base_dir = std::env::temp_dir().join(format!(
            "multicc-host-exec-ro-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let ws = base_dir.join("ws");
        let ro_skills = base_dir.join("skills-ro");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(ro_skills.join("my-skill")).unwrap();
        std::fs::write(
            ro_skills.join("my-skill").join("SKILL.md"),
            "---\nname: my-skill\n---\n# Hello Skill\n",
        )
        .unwrap();
        let img_bytes: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        std::fs::write(ws.join("screen.png"), img_bytes).unwrap();

        std::env::set_var("MULTICC_HOST_EXEC_READONLY_DIRS", &ro_skills);
        let token = generate_token().unwrap();
        let (addr, handle) = start_host_exec_server(HostExecServerConfig {
            local_root: ws.clone(),
            remote_root: ws.to_string_lossy().into_owned(),
            file_mode: "remote_mcp".to_string(),
            token: token.clone(),
            before_exec: None,
            after_exec: None,
        })
        .await
        .unwrap();
        std::env::remove_var("MULTICC_HOST_EXEC_READONLY_DIRS");

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://127.0.0.1:{}", addr.port());
        let auth = format!("Bearer {token}");
        let skill_md = ro_skills.join("my-skill").join("SKILL.md");
        let post_val = |url: String, body: Value| {
            let c = client.clone();
            let a = auth.clone();
            async move {
                c.post(url)
                    .header("Authorization", a)
                    .header("Content-Type", "application/json")
                    .body(serde_json::to_vec(&body).unwrap())
                    .send()
                    .await
                    .unwrap()
            }
        };

        // 1. Reading SKILL.md inside readonly skill root succeeds
        let read_resp = post_val(
            format!("{base}/fs/read"),
            json!({ "path": skill_md.to_string_lossy() }),
        )
        .await;
        assert_eq!(read_resp.status(), StatusCode::OK);
        let read_json: Value = serde_json::from_slice(&read_resp.bytes().await.unwrap()).unwrap();
        assert_eq!(read_json["ok"], true);
        assert!(read_json["content"]
            .as_str()
            .unwrap()
            .contains("Hello Skill"));

        // 2. Writing into readonly skill root MUST be forbidden (403)!
        let write_resp = post_val(
            format!("{base}/fs/write"),
            json!({ "path": skill_md.to_string_lossy(), "content": "hacked" }),
        )
        .await;
        assert_eq!(write_resp.status(), StatusCode::FORBIDDEN);

        // 3. /fs/view_image returns base64 + mediaType
        let img_resp = post_val(
            format!("{base}/fs/view_image"),
            json!({ "path": "screen.png" }),
        )
        .await;
        assert_eq!(img_resp.status(), StatusCode::OK);
        let img_json: Value = serde_json::from_slice(&img_resp.bytes().await.unwrap()).unwrap();
        assert_eq!(img_json["ok"], true);
        assert_eq!(img_json["mediaType"], "image/png");
        assert_eq!(img_json["bytes"], img_bytes.len() as u64);
        assert!(!img_json["dataBase64"].as_str().unwrap().is_empty());

        handle.abort();
        let _ = std::fs::remove_dir_all(&base_dir);
    }

    #[test]
    #[cfg(unix)]
    fn temp_entry_ownership_only_accepts_entries_we_created() {
        let dir = std::env::temp_dir().join(format!(
            "multicc-host-exec-owner-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mine = dir.join("multicc_shot.png");
        std::fs::write(&mine, b"x").unwrap();

        assert!(temp_entry_owned_by_current_user(&mine));
        // 不存在的路径不能因为前缀而放行。
        assert!(!temp_entry_owned_by_current_user(&dir.join("multicc_missing.png")));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
