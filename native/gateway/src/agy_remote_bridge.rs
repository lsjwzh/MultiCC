//! `multicc-gateway agy-remote-bridge` — 远端 VPS `agy` 单回合桥接器 + 连通性探针。
//!
//! 执行流程（对上层完全透明，stdout 输出标准 `agy --output-format stream-json` NDJSON）：
//! 1. 解析目标配置（优先读环境变量 `MULTICC_AGY_REMOTE_ACCOUNT_JSON`，不暴露于 argv）；
//! 2. SSH 幂等引导远端 VPS：部署零依赖 `~/.multicc-remote/bin/host-exec-mcp.cjs`、写入
//!    `$HOME/.gemini/config/mcp_config.json`（无密钥），并创建/解析远端工作区绝对路径；
//! 3. 若 `fileMode == "mutagen"`，校验并创建/刷新 Mutagen 纯源码双向同步会话；
//! 4. 在本机 `127.0.0.1:0` 启动一次性 Host-Exec 环回服务（256-bit 随机 Bearer Token + 严格
//!    工作区路径越狱防护），并在每次命令前后自动 `mutagen sync flush`；
//! 5. 通过 `ssh -R 127.0.0.1:<remotePort>:127.0.0.1:<localPort>` 建立反向隧道，经 stdin
//!    安全下发远端 `agy --settings '{"permissions":{"deny":["command(*)"]}}'` 命令并透传 NDJSON；
//! 6. 回合结束后再次 `mutagen sync flush`，关闭环回服务并以远端 `agy` 的退出码退出。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use multicc_core::agy_remote::{
    build_remote_agy_exec_command, build_remote_bootstrap_script, mutagen_session_name,
    parse_remote_target, posix_shell_quote, remote_workspace_rel_or_abs, resolve_mutagen_ignores,
    RemoteAgyTarget, RemoteExecSpec, DEFAULT_REMOTE_AGY_BIN, FILE_MODE_MUTAGEN,
};
use multicc_core::mutagen_runtime::{
    executable_name, has_complete_managed_install, managed_mutagen_agents, managed_mutagen_bin,
    managed_mutagen_dir, release_asset_for, resolve_mutagen_bin, MUTAGEN_VERSION,
};

use crate::host_exec::{generate_token, start_host_exec_server, AsyncHook, HostExecServerConfig};

const REMOTE_WS_MARKER: &str = "MULTICC_REMOTE_WS=";

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn ssh_bin() -> String {
    std::env::var("MULTICC_SSH_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "ssh".to_string())
}

fn mutagen_bin() -> String {
    resolve_mutagen_bin(home_dir().as_deref())
}

fn mutagen_install_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn build_ssh_base_args(target: &RemoteAgyTarget) -> Vec<String> {
    let mut args = vec![
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
        "-o".to_string(),
        "ConnectTimeout=20".to_string(),
    ];
    if let Some(port) = target.ssh_port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    if let Some(key) = &target.ssh_identity_file {
        args.push("-i".to_string());
        args.push(key.clone());
    }
    args
}

/// 发出一条符合 `agy --output-format stream-json` 协议的错误帧，确保 MultiCC
/// 聊天视图能清晰展示远端桥接失败原因（如缺少 mutagen / SSH 不可达）。
fn emit_bridge_error(message: &str) {
    let evt = json!({
        "event": "result",
        "result": {
            "conversation_id": "",
            "status": "ERROR",
            "error": message,
            "finished_reason": "remote_bridge_error",
        }
    });
    println!("{evt}");
}

fn resolve_or_create_machine_id(explicit: Option<&str>) -> String {
    if let Some(id) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return multicc_core::agy_remote::sanitize_id_segment(id);
    }
    let home = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let id_file = home.map(|h| h.join(".multicc").join("remote-machine-id"));
    if let Some(path) = &id_file {
        if let Ok(raw) = std::fs::read_to_string(path) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return multicc_core::agy_remote::sanitize_id_segment(trimmed);
            }
        }
    }
    let mut rand = [0u8; 4];
    let _ = getrandom::fill(&mut rand);
    let suffix: String = rand.iter().map(|b| format!("{b:02x}")).collect();
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| std::env::consts::OS.to_string());
    let host_clean = multicc_core::agy_remote::sanitize_id_segment(&host);
    let short_host: String = host_clean.chars().take(12).collect();
    let generated = format!("{short_host}-{suffix}");
    if let Some(path) = id_file {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, format!("{generated}\n"));
    }
    generated
}

fn pick_remote_port() -> u16 {
    let mut bytes = [0u8; 2];
    let _ = getrandom::fill(&mut bytes);
    let n = u16::from_le_bytes(bytes);
    32_000 + (n % 26_000)
}

fn parse_target_and_egress_from_json(
    raw: &str,
) -> Result<
    (
        RemoteAgyTarget,
        Option<multicc_core::egress_plugin::EgressBinding>,
    ),
    String,
> {
    let value: Value =
        serde_json::from_str(raw).map_err(|err| format!("远程 VPS 配置 JSON 解析失败: {err}"))?;
    let target_val = value.get("remote").unwrap_or(&value);
    let target = parse_remote_target(target_val)?;
    let egress = multicc_core::egress_plugin::parse_egress_binding(
        value
            .get("egressBinding")
            .or_else(|| target_val.get("egressBinding")),
    )?;
    Ok((target, egress))
}

/// 拆分 `agy` 原始 argv：分离 `-p <prompt>` 中的 prompt 与其余标志。
fn split_agy_args_and_prompt(raw: &[String]) -> (Vec<String>, String) {
    if let Some(pos) = raw.iter().rposition(|a| a == "-p") {
        if pos + 1 < raw.len() {
            let mut flags = raw[..=pos].to_vec();
            let prompt = raw[pos + 1].clone();
            if pos + 2 < raw.len() {
                flags.extend_from_slice(&raw[pos + 2..]);
            }
            return (flags, prompt);
        }
    }
    if let Some((last, rest)) = raw.split_last() {
        return (rest.to_vec(), last.clone());
    }
    (Vec::new(), String::new())
}

async fn run_ssh_script(
    target: &RemoteAgyTarget,
    script: &str,
    timeout: Duration,
) -> Result<(i32, String, String), String> {
    let mut args = build_ssh_base_args(target);
    args.push(target.ssh_target.clone());
    args.push("--".to_string());
    args.push("sh".to_string());
    args.push("-s".to_string());

    let mut child = Command::new(ssh_bin())
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON")
        .spawn()
        .map_err(|err| format!("无法启动 SSH 客户端 ({}): {err}", ssh_bin()))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(script.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        drop(stdin);
    }

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "SSH 连接超时，请检查网络、SSH 密钥或 VPS 状态".to_string())?
        .map_err(|err| format!("等待 SSH 返回失败: {err}"))?;

    Ok((
        output.status.code().unwrap_or(1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

async fn bootstrap_remote_workspace(
    target: &RemoteAgyTarget,
    remote_ws_rel_or_abs: &str,
) -> Result<String, String> {
    let bootstrap = build_remote_bootstrap_script(target.remote_home.as_deref());
    let ws_expr = if remote_ws_rel_or_abs.starts_with('/') {
        posix_shell_quote(remote_ws_rel_or_abs)
    } else {
        format!("\"$HOME/\"{}", posix_shell_quote(remote_ws_rel_or_abs))
    };
    let full_script =
        format!("{bootstrap}\nmkdir -p {ws_expr}\ncd {ws_expr}\nprintf '{REMOTE_WS_MARKER}%s\\n' \"$(pwd)\"\n");

    let (code, stdout, stderr) =
        run_ssh_script(target, &full_script, Duration::from_secs(30)).await?;
    if code != 0 {
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            stdout.trim()
        } else {
            detail
        };
        return Err(format!(
            "远端 VPS 引导失败（exit {code}）: {}",
            if detail.is_empty() {
                "请确认已配置免密 SSH 且远端已安装 Node.js"
            } else {
                detail
            }
        ));
    }

    for line in stdout.lines().rev() {
        if let Some(path) = line.strip_prefix(REMOTE_WS_MARKER) {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Ok(remote_ws_rel_or_abs.to_string())
}

async fn probe_mutagen_version(bin: &str) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(bin)
            .arg("version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(if ver.is_empty() {
        "installed".to_string()
    } else {
        ver.lines().next().unwrap_or("installed").trim().to_string()
    })
}

async fn check_mutagen_available() -> Result<(), String> {
    let bin = mutagen_bin();
    match probe_mutagen_version(&bin).await {
        Some(_) => Ok(()),
        None => Err(
            "本机未检测到 mutagen。请在「Provider 配置 → 反重力账号」点击「一键安装 Mutagen」（将自动下载到 ~/.multicc/bin/mutagen/），或将该远程 VPS 账号切换为「纯远程 MCP（零落盘）」模式。".to_string(),
        ),
    }
}

/// 探测本机 Mutagen 安装状态（优先检测 MultiCC 托管版 `~/.multicc/bin/mutagen/`）。
pub async fn mutagen_status_for(home: Option<&Path>) -> Value {
    let managed_ready = home.is_some_and(has_complete_managed_install);
    let bin = resolve_mutagen_bin(home);
    let version = probe_mutagen_version(&bin).await;
    let installed = version.is_some();
    json!({
        "installed": installed,
        "managed": installed && managed_ready,
        "path": if installed { json!(bin) } else { Value::Null },
        "version": version.map_or(Value::Null, |v| json!(v)),
        "targetVersion": MUTAGEN_VERSION,
    })
}

pub async fn mutagen_status() -> Value {
    mutagen_status_for(home_dir().as_deref()).await
}

/// 按需下载官方 Mutagen 压缩包并安装到 `<home>/.multicc/bin/mutagen/`（不打进 MultiCC 安装包）。
pub async fn install_managed_mutagen_to(
    home: &Path,
    base_url_override: Option<&str>,
) -> Result<Value, String> {
    let _guard = mutagen_install_lock().lock().await;

    let asset = release_asset_for(std::env::consts::OS, std::env::consts::ARCH)?;
    let env_base = std::env::var("MULTICC_MUTAGEN_DOWNLOAD_BASE").ok();
    let url = asset.download_url(base_url_override.or(env_base.as_deref()));

    let target_dir = managed_mutagen_dir(home);
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|err| format!("无法创建 Mutagen 托管目录: {err}"))?;

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging_dir = target_dir.join(format!(".staging-{}-{nonce}", std::process::id()));
    tokio::fs::create_dir_all(&staging_dir)
        .await
        .map_err(|err| format!("无法创建临时解压目录: {err}"))?;

    let result: Result<Value, String> = async {
        // 允许走本机系统/环境变量 HTTP(S)_PROXY，方便国内环境通过代理下载 GitHub Release。
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|err| format!("初始化下载客户端失败: {err}"))?;

        let resp = client
            .get(&url)
            .header("User-Agent", "MultiCC-Mutagen-Installer")
            .send()
            .await
            .map_err(|err| format!("下载 Mutagen 失败（{url}）: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "下载 Mutagen 失败（HTTP {}，{url}）",
                resp.status().as_u16()
            ));
        }

        let archive_path = staging_dir.join(asset.filename);
        let bytes = resp
            .bytes()
            .await
            .map_err(|err| format!("读取 Mutagen 安装包失败: {err}"))?;
        tokio::fs::write(&archive_path, &bytes)
            .await
            .map_err(|err| format!("写入 Mutagen 临时文件失败: {err}"))?;

        let extract_out = if asset.is_zip {
            Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "Expand-Archive -Force -LiteralPath '{}' -DestinationPath '{}'",
                        archive_path.display(),
                        staging_dir.display()
                    ),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .output()
                .await
                .map_err(|err| format!("调用 PowerShell 解压 zip 失败: {err}"))?
        } else {
            Command::new("tar")
                .arg("-xzf")
                .arg(&archive_path)
                .arg("-C")
                .arg(&staging_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .output()
                .await
                .map_err(|err| format!("调用 tar 解压失败: {err}"))?
        };
        if !extract_out.status.success() {
            let detail = String::from_utf8_lossy(&extract_out.stderr);
            return Err(format!("解压 Mutagen 安装包失败: {}", detail.trim()));
        }

        let bin_name = executable_name(cfg!(windows));
        let staged_bin = staging_dir.join(bin_name);
        let staged_agents = staging_dir.join("mutagen-agents.tar.gz");
        if !staged_bin.is_file() || !staged_agents.is_file() {
            return Err(format!(
                "解压结果缺少必要文件（需要 {bin_name} 与 mutagen-agents.tar.gz）"
            ));
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&staged_bin, std::fs::Permissions::from_mode(0o755));
        }

        // 先试跑 version 验证二进制与本机架构匹配。
        let version = probe_mutagen_version(&staged_bin.to_string_lossy())
            .await
            .ok_or_else(|| {
                "下载的 Mutagen 二进制无法在本机运行，请检查系统架构或手动安装".to_string()
            })?;

        let final_bin = managed_mutagen_bin(home);
        let final_agents = managed_mutagen_agents(home);
        tokio::fs::rename(&staged_agents, &final_agents)
            .await
            .map_err(|err| format!("落盘 mutagen-agents.tar.gz 失败: {err}"))?;
        tokio::fs::rename(&staged_bin, &final_bin)
            .await
            .map_err(|err| format!("落盘 {bin_name} 失败: {err}"))?;

        Ok(json!({
            "installed": true,
            "managed": true,
            "path": final_bin.to_string_lossy(),
            "version": version,
            "targetVersion": MUTAGEN_VERSION,
        }))
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&staging_dir).await;
    result
}

pub async fn install_managed_mutagen() -> Result<Value, String> {
    let home =
        home_dir().ok_or_else(|| "无法定位 HOME 目录，无法安装托管版 Mutagen".to_string())?;
    install_managed_mutagen_to(&home, None).await
}

fn mutagen_remote_endpoint(target: &RemoteAgyTarget, remote_abs_ws: &str) -> String {
    if let Some(port) = target.ssh_port {
        if !target.ssh_target.contains(':') {
            return format!("{}:{port}:{remote_abs_ws}", target.ssh_target);
        }
    }
    format!("{}:{remote_abs_ws}", target.ssh_target)
}

async fn ensure_mutagen_session(
    target: &RemoteAgyTarget,
    session_name: &str,
    local_cwd: &Path,
    remote_abs_ws: &str,
) -> Result<(), String> {
    let bin = mutagen_bin();
    let check = Command::new(&bin)
        .args(["sync", "list", session_name])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    if check.is_ok_and(|s| s.success()) {
        return Ok(());
    }

    let mut args = vec![
        "sync".to_string(),
        "create".to_string(),
        "--name".to_string(),
        session_name.to_string(),
        "--sync-mode".to_string(),
        "two-way-resolved".to_string(),
    ];
    for pattern in resolve_mutagen_ignores(&target.extra_ignores) {
        args.push("--ignore".to_string());
        args.push(pattern);
    }
    args.push(local_cwd.to_string_lossy().into_owned());
    args.push(mutagen_remote_endpoint(target, remote_abs_ws));

    let out = tokio::time::timeout(
        Duration::from_secs(45),
        Command::new(&bin)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "创建 Mutagen 同步会话超时".to_string())?
    .map_err(|err| format!("启动 mutagen sync create 失败: {err}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!("创建 Mutagen 同步会话失败: {detail}"));
    }
    Ok(())
}

async fn flush_mutagen_session(session_name: &str) -> Result<(), String> {
    let bin = mutagen_bin();
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(&bin)
            .args(["sync", "flush", session_name])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "mutagen sync flush 超时".to_string())?
    .map_err(|err| format!("执行 mutagen sync flush 失败: {err}"))?;

    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr);
        return Err(format!("mutagen sync flush 失败: {}", detail.trim()));
    }
    Ok(())
}

/// 连通性探针（供 `POST /api/agy/accounts/:id/test` 调用）。
pub async fn probe_remote_target(target: &RemoteAgyTarget) -> Value {
    let agy_bin = target
        .remote_agy_bin
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_AGY_BIN);
    let home_export =
        multicc_core::agy_remote::render_remote_home_export(target.remote_home.as_deref());
    let script = format!(
        r#"{home_export}
AGY_VER="$({agy} --version 2>&1 | head -n 1 || true)"
NODE_VER="$(node -v 2>&1 | head -n 1 || true)"
HAS_AGY=0
command -v {agy} >/dev/null 2>&1 && HAS_AGY=1
HAS_NODE=0
command -v node >/dev/null 2>&1 && HAS_NODE=1
printf 'HAS_AGY=%s\nAGY_VER=%s\nHAS_NODE=%s\nNODE_VER=%s\n' "$HAS_AGY" "$AGY_VER" "$HAS_NODE" "$NODE_VER"
"#,
        home_export = home_export,
        agy = posix_shell_quote(agy_bin),
    );

    let mutagen_needed = target.file_mode == FILE_MODE_MUTAGEN;
    let mutagen_ok = if mutagen_needed {
        check_mutagen_available().await.is_ok()
    } else {
        true
    };

    match run_ssh_script(target, &script, Duration::from_secs(15)).await {
        Ok((0, stdout, _)) => {
            let mut has_agy = false;
            let mut has_node = false;
            let mut agy_version = String::new();
            let mut node_version = String::new();
            for line in stdout.lines() {
                if let Some(v) = line.strip_prefix("HAS_AGY=") {
                    has_agy = v.trim() == "1";
                } else if let Some(v) = line.strip_prefix("AGY_VER=") {
                    agy_version = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("HAS_NODE=") {
                    has_node = v.trim() == "1";
                } else if let Some(v) = line.strip_prefix("NODE_VER=") {
                    node_version = v.trim().to_string();
                }
            }
            let ok = has_agy && has_node && mutagen_ok;
            let mut issues = Vec::new();
            if !has_agy {
                issues.push(format!("远端未找到 `{agy_bin}` 命令"));
            }
            if !has_node {
                issues.push("远端未找到 `node`（Host-Exec MCP 桥接需要 Node.js）".to_string());
            }
            if !mutagen_ok {
                issues.push(
                    "本机未安装 `mutagen`（可执行 brew install mutagen-io/mutagen/mutagen 或切到纯远程 MCP 模式）"
                        .to_string(),
                );
            }
            json!({
                "ok": ok,
                "sshOk": true,
                "agyOk": has_agy,
                "agyVersion": if agy_version.is_empty() { Value::Null } else { json!(agy_version) },
                "nodeOk": has_node,
                "nodeVersion": if node_version.is_empty() { Value::Null } else { json!(node_version) },
                "mutagenNeeded": mutagen_needed,
                "mutagenOk": mutagen_ok,
                "error": if issues.is_empty() { Value::Null } else { json!(issues.join("；")) },
            })
        }
        Ok((code, stdout, stderr)) => {
            let detail = if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            };
            json!({
                "ok": false,
                "sshOk": false,
                "agyOk": false,
                "nodeOk": false,
                "mutagenNeeded": mutagen_needed,
                "mutagenOk": mutagen_ok,
                "error": format!("SSH 连接失败（exit {code}）: {detail}"),
            })
        }
        Err(err) => json!({
            "ok": false,
            "sshOk": false,
            "agyOk": false,
            "nodeOk": false,
            "mutagenNeeded": mutagen_needed,
            "mutagenOk": mutagen_ok,
            "error": err,
        }),
    }
}

/// 入口：`multicc-gateway agy-remote-bridge --local-cwd <dir> [--machine-id <id>] [--target-json <json>] -- <agy args...>`
pub async fn serve(args: &[String]) -> i32 {
    let mut local_cwd: Option<String> = None;
    let mut machine_id_arg: Option<String> = None;
    let mut target_json_arg: Option<String> = None;
    let mut agy_args: Vec<String> = Vec::new();

    let mut idx = 0usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--local-cwd" => {
                idx += 1;
                if idx < args.len() {
                    local_cwd = Some(args[idx].clone());
                }
            }
            "--machine-id" => {
                idx += 1;
                if idx < args.len() {
                    machine_id_arg = Some(args[idx].clone());
                }
            }
            "--target-json" => {
                idx += 1;
                if idx < args.len() {
                    target_json_arg = Some(args[idx].clone());
                }
            }
            "--" => {
                agy_args.extend_from_slice(&args[idx + 1..]);
                break;
            }
            other => {
                agy_args.push(other.to_string());
            }
        }
        idx += 1;
    }

    let target_raw = target_json_arg
        .or_else(|| std::env::var("MULTICC_AGY_REMOTE_ACCOUNT_JSON").ok())
        .unwrap_or_default();
    if target_raw.trim().is_empty() {
        emit_bridge_error("缺少远端 VPS 反重力账号配置（MULTICC_AGY_REMOTE_ACCOUNT_JSON）");
        return 1;
    }
    let (target, egress_binding) = match parse_target_and_egress_from_json(&target_raw) {
        Ok(pair) => pair,
        Err(err) => {
            emit_bridge_error(&err);
            return 1;
        }
    };

    let local_root = match local_cwd
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
    {
        Some(dir) => dir,
        None => {
            emit_bridge_error("无法解析本地工作区目录");
            return 1;
        }
    };
    let local_root_str = local_root.to_string_lossy().into_owned();
    let machine_id = resolve_or_create_machine_id(machine_id_arg.as_deref());
    let remote_ws_rel = remote_workspace_rel_or_abs(
        target.remote_workspace_base.as_deref(),
        &machine_id,
        &local_root_str,
    );
    let use_mutagen = target.file_mode == FILE_MODE_MUTAGEN;
    let mutagen_session = mutagen_session_name(&machine_id, &local_root_str);

    if use_mutagen {
        if let Err(err) = check_mutagen_available().await {
            emit_bridge_error(&err);
            return 1;
        }
    }

    let remote_abs_ws = match bootstrap_remote_workspace(&target, &remote_ws_rel).await {
        Ok(ws) => ws,
        Err(err) => {
            emit_bridge_error(&err);
            return 1;
        }
    };

    if use_mutagen {
        if let Err(err) =
            ensure_mutagen_session(&target, &mutagen_session, &local_root, &remote_abs_ws).await
        {
            emit_bridge_error(&err);
            return 1;
        }
        if let Err(err) = flush_mutagen_session(&mutagen_session).await {
            emit_bridge_error(&err);
            return 1;
        }
    }

    let token = match generate_token() {
        Ok(t) => t,
        Err(err) => {
            emit_bridge_error(&err);
            return 1;
        }
    };

    let (before_exec, after_exec): (Option<AsyncHook>, Option<AsyncHook>) = if use_mutagen {
        let s1 = mutagen_session.clone();
        let s2 = mutagen_session.clone();
        (
            Some(Arc::new(move || {
                let s = s1.clone();
                Box::pin(async move { flush_mutagen_session(&s).await })
            })),
            Some(Arc::new(move || {
                let s = s2.clone();
                Box::pin(async move { flush_mutagen_session(&s).await })
            })),
        )
    } else {
        (None, None)
    };

    let (local_addr, server_handle) = match start_host_exec_server(HostExecServerConfig {
        local_root: local_root.clone(),
        remote_root: remote_abs_ws.clone(),
        file_mode: target.file_mode.clone(),
        token: token.clone(),
        before_exec,
        after_exec,
    })
    .await
    {
        Ok(pair) => pair,
        Err(err) => {
            emit_bridge_error(&err);
            return 1;
        }
    };

    let (flags, prompt) = split_agy_args_and_prompt(&agy_args);
    let remote_agy_bin = target
        .remote_agy_bin
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_AGY_BIN);

    // 反向隧道远端监听端口（测试可通过 MULTICC_REMOTE_TUNNEL_PORT 固定或覆盖）。
    let remote_port = std::env::var("MULTICC_REMOTE_TUNNEL_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|&p| p >= 1)
        .unwrap_or_else(pick_remote_port);

    // 若账号绑定了「Chrome 隔离出口启动器」身份，实时解析代理并规划远端代理反向隧道（fail-closed，绝不静默直连）。
    let proxy_plan = match crate::egress_runtime::prepare_remote_proxy(
        egress_binding.as_ref(),
        Some(remote_port),
    )
    .await
    {
        Ok(plan) => plan,
        Err(err) => {
            server_handle.abort();
            emit_bridge_error(&err);
            return 1;
        }
    };

    // 在单元测试无真实 sshd 隧道场景下允许直连本机环回端口，生产环境始终走 127.0.0.1:<remote_port>。
    let host_exec_url = if std::env::var("MULTICC_REMOTE_DIRECT_LOOPBACK").as_deref() == Ok("1") {
        format!("http://127.0.0.1:{}", local_addr.port())
    } else {
        format!("http://127.0.0.1:{remote_port}")
    };

    let remote_script = build_remote_agy_exec_command(&RemoteExecSpec {
        remote_agy_bin,
        remote_home: target.remote_home.as_deref(),
        remote_workspace_path: &remote_abs_ws,
        local_root: &local_root_str,
        local_os: std::env::consts::OS,
        file_mode: &target.file_mode,
        host_exec_url: &host_exec_url,
        host_exec_token: &token,
        remote_proxy_url: proxy_plan.as_ref().map(|p| p.remote_proxy_url()),
        agy_args: &flags,
        prompt: &prompt,
    });

    let mut ssh_args = build_ssh_base_args(&target);
    ssh_args.push("-o".to_string());
    ssh_args.push("ExitOnForwardFailure=yes".to_string());
    ssh_args.push("-R".to_string());
    ssh_args.push(format!(
        "127.0.0.1:{remote_port}:127.0.0.1:{}",
        local_addr.port()
    ));
    if let Some(forward_spec) = proxy_plan.as_ref().and_then(|p| p.ssh_forward_spec()) {
        ssh_args.push("-R".to_string());
        ssh_args.push(forward_spec);
    }
    ssh_args.push(target.ssh_target.clone());
    ssh_args.push("--".to_string());
    ssh_args.push("sh".to_string());
    ssh_args.push("-s".to_string());

    let mut child = match Command::new(ssh_bin())
        .args(&ssh_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON")
        .spawn()
    {
        Ok(c) => c,
        Err(err) => {
            server_handle.abort();
            emit_bridge_error(&format!("无法启动 SSH 反向隧道: {err}"));
            return 1;
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(remote_script.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        drop(stdin);
    }

    let child_stdout = child.stdout.take();
    let child_stderr = child.stderr.take();

    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(err_stream) = child_stderr {
            let mut reader = BufReader::new(err_stream).lines();
            let mut out = tokio::io::stderr();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = out.write_all(line.as_bytes()).await;
                let _ = out.write_all(b"\n").await;
                if collected.len() < 4096 {
                    if !collected.is_empty() {
                        collected.push('\n');
                    }
                    collected.push_str(&line);
                }
            }
        }
        collected
    });

    let mut saw_result_event = false;
    if let Some(out_stream) = child_stdout {
        let mut reader = BufReader::new(out_stream).lines();
        let mut out = tokio::io::stdout();
        while let Ok(Some(line)) = reader.next_line().await {
            if !saw_result_event && line.contains("\"event\"") && line.contains("\"result\"") {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v.get("event").and_then(Value::as_str) == Some("result") {
                        saw_result_event = true;
                    }
                }
            }
            let _ = out.write_all(line.as_bytes()).await;
            let _ = out.write_all(b"\n").await;
            let _ = out.flush().await;
        }
    }

    let status_code = match child.wait().await {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 1,
    };
    let stderr_tail = stderr_task.await.unwrap_or_default();

    if use_mutagen {
        if let Err(err) = flush_mutagen_session(&mutagen_session).await {
            eprintln!("[agy-remote-bridge] post-turn mutagen flush warning: {err}");
        }
    }

    server_handle.abort();

    if status_code != 0 && !saw_result_event {
        let detail = stderr_tail.trim();
        let message = if detail.is_empty() {
            format!("远端 VPS agy 执行异常退出（exit {status_code}）")
        } else {
            format!("远端 VPS agy 执行异常（exit {status_code}）：{detail}")
        };
        emit_bridge_error(&message);
    }

    status_code
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use axum::routing::get;
    use axum::Router;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn install_managed_mutagen_downloads_extracts_verifies_and_activates() {
        let root = std::env::temp_dir().join(format!(
            "multicc-mutagen-install-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let src_dir = root.join("src");
        let home_dir = root.join("home");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&home_dir).unwrap();

        let fake_mutagen = src_dir.join("mutagen");
        std::fs::write(&fake_mutagen, "#!/bin/sh\necho 0.18.1-test\n").unwrap();
        std::fs::set_permissions(&fake_mutagen, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(src_dir.join("mutagen-agents.tar.gz"), b"fake-agents").unwrap();

        let asset = release_asset_for(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        let archive_path = root.join(asset.filename);
        let status = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&archive_path)
            .arg("-C")
            .arg(&src_dir)
            .arg("mutagen")
            .arg("mutagen-agents.tar.gz")
            .status()
            .unwrap();
        assert!(status.success());
        let archive_bytes = Arc::new(std::fs::read(&archive_path).unwrap());

        let bytes_for_route = archive_bytes.clone();
        let route_path = format!("/{}", asset.filename);
        let app = Router::new().route(
            &route_path,
            get(move || {
                let b = bytes_for_route.clone();
                async move { b.as_ref().clone() }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        // Before install, managed directory is absent.
        assert!(!has_complete_managed_install(&home_dir));

        let base = format!("http://{addr}");
        let installed = install_managed_mutagen_to(&home_dir, Some(&base))
            .await
            .unwrap();
        assert_eq!(installed["installed"], true);
        assert_eq!(installed["managed"], true);
        assert_eq!(installed["version"], "0.18.1-test");
        assert!(has_complete_managed_install(&home_dir));

        let st = mutagen_status_for(Some(&home_dir)).await;
        assert_eq!(st["installed"], true);
        assert_eq!(st["managed"], true);
        assert_eq!(st["version"], "0.18.1-test");

        srv.abort();
        let _ = std::fs::remove_dir_all(&root);
    }
}
