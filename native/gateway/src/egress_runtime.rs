//! Rust 侧「Chrome 隔离出口启动器（`chrome-proxy-launcher`）」运行时解析器与本机代理执行桥。
//!
//! 严格遵循 fail-closed 契约（与 `src/claude-auth/egress-agent.js` 一致）：
//! - 不缓存解析结果：每次登录或回合执行前实时向插件查询 `egress`，确保出口切换立刻生效；
//! - 插件缺失、身份不存在或出口不可用时立刻返回明确中文错误，绝不静默回落直连。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use multicc_core::agy_accounts::{self as agy_store, ResolvedAgyAccount};
use multicc_core::egress_plugin::{
    plan_remote_proxy, resolve_plugin_binary, EgressBinding, RemoteProxyPlan, LOOPBACK_NO_PROXY,
};
use multicc_core::state_file;

const PLUGIN_TIMEOUT: Duration = Duration::from_secs(20);
const HOST_RUNTIME_REL_PATH: &str = ".multicc/host-runtime.json";

fn candidate_plugin_roots(extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for dir in extra {
        if !dir.as_os_str().is_empty() {
            roots.push(dir.clone());
        }
    }
    if let Ok(raw) = std::env::var("MULTICC_PLUGINS_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            roots.push(PathBuf::from(trimmed));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("plugins"));
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        for _ in 0..5 {
            if let Some(dir) = cur {
                roots.push(dir.join("plugins"));
                cur = dir.parent();
            } else {
                break;
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
    {
        roots.push(PathBuf::from(home).join(".multicc").join("plugins"));
    }
    roots
}

/// 将本机（Host）`multicc-gateway` 与 `plugins` 目录路径写入 `~/.multicc/host-runtime.json`
/// （零密钥，权限 `0600`），供远端 Client 经 SSH 调用 `agy-host-exec` 时准确定位 Host 运行时。
pub fn publish_host_runtime_manifest(home: &Path) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let plugins_dir = candidate_plugin_roots(&[])
        .into_iter()
        .find(|dir| dir.is_dir());
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let payload = json!({
        "schema": 1,
        "gatewayBin": exe.to_string_lossy(),
        "pluginsDir": plugins_dir.map(|d| d.to_string_lossy().into_owned()),
        "updatedAt": updated_at,
    });
    let manifest_path = home.join(HOST_RUNTIME_REL_PATH);
    let _ = state_file::write_json_atomic(&manifest_path, &payload);
}

pub fn publish_host_runtime_manifest_default() {
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
    {
        publish_host_runtime_manifest(Path::new(&home));
    }
}

fn pick_proxy_remote_port(avoid: Option<u16>) -> u16 {
    for _ in 0..8 {
        let mut bytes = [0u8; 2];
        let _ = getrandom::fill(&mut bytes);
        let port = 34_000 + (u16::from_le_bytes(bytes) % 24_000);
        if Some(port) != avoid {
            return port;
        }
    }
    44_556
}

/// 实时调用出口插件 `egress` 命令，拿到代理 URL（fail-closed，不缓存）。
pub async fn resolve_egress_proxy_url(binding: &EgressBinding) -> Result<String, String> {
    resolve_egress_proxy_url_with_roots(binding, &[]).await
}

pub async fn resolve_egress_proxy_url_with_roots(
    binding: &EgressBinding,
    extra_roots: &[PathBuf],
) -> Result<String, String> {
    if let Ok(override_url) = std::env::var("MULTICC_EGRESS_PROXY_OVERRIDE") {
        let trimmed = override_url.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let roots = candidate_plugin_roots(extra_roots);
    let binary = resolve_plugin_binary(&binding.plugin_id, &roots).ok_or_else(|| {
        format!(
            "未安装「{}」插件或其可执行文件不可用，无法解析该账号绑定的专用出口。请先在 Air → 资料与插件里安装并配置出口身份。",
            binding.plugin_id
        )
    })?;

    let mut child = Command::new(&binary)
        .arg("egress")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("启动出口插件失败（{}）: {err}", binary.display()))?;

    let payload = json!({ "id": binding.profile_id }).to_string();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.as_bytes()).await;
        drop(stdin);
    }

    let output = tokio::time::timeout(PLUGIN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "出口插件响应超时（20s），已阻止直连".to_string())?
        .map_err(|err| format!("读取出口插件结果失败: {err}"))?;

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        let err_tail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "专用出口插件未返回有效结果（exit {}）{}",
            output.status.code().unwrap_or(-1),
            if err_tail.is_empty() {
                String::new()
            } else {
                format!("：{err_tail}")
            }
        ));
    }

    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| "专用出口插件返回的 JSON 格式异常，已阻止直连".to_string())?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let msg = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("专用出口不可用：{msg}"));
    }
    let proxy_url = parsed
        .pointer("/data/proxyUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "专用出口未返回 proxyUrl，已阻止直连".to_string())?;
    Ok(proxy_url.to_string())
}

/// 为远端 VPS 账号解析出口绑定并生成远端代理/隧道计划（`None` 表示未绑定）。
pub async fn prepare_remote_proxy(
    binding: Option<&EgressBinding>,
    avoid_port: Option<u16>,
) -> Result<Option<RemoteProxyPlan>, String> {
    let Some(binding) = binding else {
        return Ok(None);
    };
    let proxy_url = resolve_egress_proxy_url(binding).await?;
    let remote_port = std::env::var("MULTICC_REMOTE_PROXY_TUNNEL_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|&p| p >= 1 && Some(p) != avoid_port)
        .unwrap_or_else(|| pick_proxy_remote_port(avoid_port));
    let plan = plan_remote_proxy(&proxy_url, remote_port)?;
    Ok(Some(plan))
}

fn emit_agy_error(message: &str) {
    let evt = json!({
        "event": "result",
        "result": {
            "conversation_id": "",
            "status": "ERROR",
            "error": message,
            "finished_reason": "egress_unavailable",
        }
    });
    println!("{evt}");
}

/// 入口：`multicc-gateway agy-egress-exec --bin <agy_cmd> -- <agy_args...>`
///
/// 用于本机 `agy` 账号绑定了 `chrome-proxy-launcher` 专用出口时：实时向插件解析
/// 代理地址并注入 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 后执行本机 `agy`；
/// 任何出口解析失败直接 fail-closed 输出错误帧，绝不静默直连。
pub async fn serve_local_egress_exec(args: &[String]) -> i32 {
    let mut bin: Option<String> = None;
    let mut passthrough: Vec<String> = Vec::new();
    let mut idx = 0usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--bin" => {
                idx += 1;
                if idx < args.len() {
                    bin = Some(args[idx].clone());
                }
            }
            "--" => {
                passthrough.extend_from_slice(&args[idx + 1..]);
                break;
            }
            other => passthrough.push(other.to_string()),
        }
        idx += 1;
    }

    let Some(raw_bin) = bin.filter(|s| !s.trim().is_empty()) else {
        emit_agy_error("agy-egress-exec 缺少 --bin 参数");
        return 1;
    };
    let agy_bin = crate::cli_bin::resolve_agy_bin_or_explicit(Some(&raw_bin));
    let raw_egress = std::env::var("MULTICC_AGY_EGRESS_JSON").unwrap_or_default();
    let parsed_val: Value = match serde_json::from_str(&raw_egress) {
        Ok(v) => v,
        Err(err) => {
            emit_agy_error(&format!("账号专用出口配置解析失败: {err}"));
            return 1;
        }
    };
    let binding = match multicc_core::egress_plugin::parse_egress_binding(Some(&parsed_val)) {
        Ok(Some(b)) => b,
        Ok(None) => {
            emit_agy_error("账号专用出口配置为空");
            return 1;
        }
        Err(err) => {
            emit_agy_error(&format!("账号专用出口配置无效: {err}"));
            return 1;
        }
    };

    let proxy_url = match resolve_egress_proxy_url(&binding).await {
        Ok(url) => url,
        Err(err) => {
            emit_agy_error(&err);
            return 1;
        }
    };

    let mut cmd = Command::new(&agy_bin);
    cmd.args(&passthrough)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env_remove("MULTICC_AGY_EGRESS_JSON")
        .env("HTTP_PROXY", &proxy_url)
        .env("HTTPS_PROXY", &proxy_url)
        .env("ALL_PROXY", &proxy_url)
        .env("http_proxy", &proxy_url)
        .env("https_proxy", &proxy_url)
        .env("all_proxy", &proxy_url)
        .env("NO_PROXY", LOOPBACK_NO_PROXY)
        .env("no_proxy", LOOPBACK_NO_PROXY);

    match cmd.status().await {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            emit_agy_error(&format!("启动本机 agy 失败（{agy_bin}）: {err}"));
            1
        }
    }
}

fn find_node_executable() -> String {
    if let Ok(explicit) = std::env::var("MULTICC_NODE_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    "node".to_string()
}

/// 幂等确保 Host 账号隔离的 `<account_home>/.gemini/config/mcp_config.json` 中已注册
/// 无密钥的 `multicc_host_exec` stdio MCP 条目（保留用户其它 MCP 服务器配置）。
fn ensure_host_exec_mcp_config(account_home: &Path, script_path: &str) -> Result<(), String> {
    let cfg_path = account_home
        .join(".gemini")
        .join("config")
        .join("mcp_config.json");
    let mut root = if cfg_path.is_file() {
        let raw = std::fs::read_to_string(&cfg_path)
            .map_err(|err| format!("读取 Host mcp_config.json 失败: {err}"))?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            json!({})
        } else {
            match serde_json::from_str::<Value>(trimmed) {
                Ok(Value::Object(map)) => Value::Object(map),
                _ => json!({}),
            }
        }
    } else {
        json!({})
    };

    let desired = json!({
        "command": find_node_executable(),
        "args": [script_path],
    });
    let servers = root
        .as_object_mut()
        .expect("json object")
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    let map = servers.as_object_mut().expect("mcpServers object");
    if map.get("multicc_host_exec") != Some(&desired) {
        map.insert("multicc_host_exec".to_string(), desired);
        state_file::write_json_atomic(&cfg_path, &root)
            .map_err(|err| format!("写入 Host mcp_config.json 失败: {err}"))?;
    }
    Ok(())
}

/// 入口：`multicc-gateway agy-host-exec --account-id <16hex> [--plugins-dir <dir>] [--host-exec-mcp <script>] --bin <agy_cmd> -- <agy_args...>`
///
/// 标准 Host/Client 分离模式的 Host 侧执行器（运行在 VPS 上）：
/// 1. 严格按 `--account-id` 查找 Host 本地的 `agy` 账号与独立 `.home`（fail-closed）；
/// 2. 可选幂等注册无密钥 `multicc_host_exec` MCP（凭据仍仅走当前 SSH 会话的 `MULTICC_HOST_EXEC_*` 环境变量）；
/// 3. 若该 Host 账号绑定了 `chrome-proxy-launcher` 专用出口，在 Host 本地实时解析代理并注入
///    `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY=127.0.0.1,localhost,::1`（fail-closed，零绕路）；
/// 4. 以 Host 账号的 `HOME` 执行 `agy`。
pub async fn serve_host_exec(args: &[String]) -> i32 {
    let mut account_id: Option<String> = None;
    let mut plugins_dir: Option<PathBuf> = None;
    let mut host_exec_mcp: Option<String> = None;
    let mut bin: Option<String> = None;
    let mut passthrough: Vec<String> = Vec::new();
    let mut idx = 0usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--account-id" => {
                idx += 1;
                if idx < args.len() {
                    account_id = Some(args[idx].clone());
                }
            }
            "--plugins-dir" => {
                idx += 1;
                if idx < args.len() && !args[idx].trim().is_empty() {
                    plugins_dir = Some(PathBuf::from(&args[idx]));
                }
            }
            "--host-exec-mcp" => {
                idx += 1;
                if idx < args.len() && !args[idx].trim().is_empty() {
                    host_exec_mcp = Some(args[idx].clone());
                }
            }
            "--bin" => {
                idx += 1;
                if idx < args.len() {
                    bin = Some(args[idx].clone());
                }
            }
            "--" => {
                passthrough.extend_from_slice(&args[idx + 1..]);
                break;
            }
            other => passthrough.push(other.to_string()),
        }
        idx += 1;
    }

    let Some(account_id) = account_id.filter(|s| !s.trim().is_empty()) else {
        emit_agy_error("agy-host-exec 缺少 --account-id 参数");
        return 1;
    };
    let agy_bin = crate::cli_bin::resolve_agy_bin_or_explicit(bin.as_deref());

    let Some(host_home) = std::env::var_os("MULTICC_AGY_ACCOUNTS_HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()))
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
    else {
        emit_agy_error("Host 无法定位 HOME 目录，无法读取反重力账号");
        return 1;
    };

    let (account_home, egress_binding) = match agy_store::resolve_account(
        &host_home,
        Some(&account_id),
    ) {
        Ok(Some(ResolvedAgyAccount::Local {
            home,
            egress_binding,
        })) => (home, egress_binding),
        Ok(Some(ResolvedAgyAccount::Remote { .. })) => {
            emit_agy_error(&format!(
                "Host 上的账号（{account_id}）不是本机账号，不能作为 Host 承载账号使用"
            ));
            return 1;
        }
        Ok(None) | Err(_) => {
            emit_agy_error(&format!(
                    "Host（VPS）上未找到反重力账号（{account_id}），请确认已在 Host 的 MultiCC 中创建该账号"
                ));
            return 1;
        }
    };

    if let Some(script_path) = host_exec_mcp.as_deref() {
        if let Err(err) = ensure_host_exec_mcp_config(&account_home, script_path) {
            emit_agy_error(&err);
            return 1;
        }
    }

    let extra_roots: Vec<PathBuf> = plugins_dir.into_iter().collect();
    let proxy_url = if let Some(binding) = egress_binding.as_ref() {
        match resolve_egress_proxy_url_with_roots(binding, &extra_roots).await {
            Ok(url) => Some(url),
            Err(err) => {
                emit_agy_error(&format!("Host 账号专用出口不可用：{err}"));
                return 1;
            }
        }
    } else {
        None
    };

    let mut cmd = Command::new(&agy_bin);
    cmd.args(&passthrough)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env("HOME", &account_home)
        .env_remove("MULTICC_AGY_EGRESS_JSON")
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON");

    if let Some(url) = proxy_url.as_deref() {
        cmd.env("HTTP_PROXY", url)
            .env("HTTPS_PROXY", url)
            .env("ALL_PROXY", url)
            .env("http_proxy", url)
            .env("https_proxy", url)
            .env("all_proxy", url)
            .env("NO_PROXY", LOOPBACK_NO_PROXY)
            .env("no_proxy", LOOPBACK_NO_PROXY);
    }

    match cmd.status().await {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            emit_agy_error(&format!("Host 启动 agy 失败（{agy_bin}）: {err}"));
            1
        }
    }
}

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn resolve_egress_plugin_executes_command_and_fails_closed_on_error() {
        let _guard = TEST_ENV_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!(
            "multicc-egress-plugin-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let pdir = root.join("chrome-proxy-launcher");
        let bindir = pdir.join("bin");
        std::fs::create_dir_all(&bindir).unwrap();
        std::fs::write(
            pdir.join("plugin.json"),
            json!({
                "id": "chrome-proxy-launcher",
                "commands": ["list", "egress"],
                "engine": { "type": "command", "binary": "bin/chrome-proxy-launcher" }
            })
            .to_string(),
        )
        .unwrap();
        let bin = bindir.join("chrome-proxy-launcher");
        std::fs::write(
            &bin,
            r#"#!/bin/sh
INPUT="$(cat)"
case "$INPUT" in
  *prof-ok*)
    echo '{"ok":true,"data":{"proxyUrl":"http://127.0.0.1:21888"}}'
    exit 0
    ;;
  *)
    echo '{"ok":false,"error":"profile not found"}'
    exit 1
    ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var("MULTICC_PLUGINS_DIR", &root);
        std::env::remove_var("MULTICC_EGRESS_PROXY_OVERRIDE");

        let ok_binding = EgressBinding {
            plugin_id: "chrome-proxy-launcher".to_string(),
            profile_id: "prof-ok".to_string(),
        };
        let url = resolve_egress_proxy_url(&ok_binding).await.unwrap();
        assert_eq!(url, "http://127.0.0.1:21888");

        let plan = prepare_remote_proxy(Some(&ok_binding), Some(40000))
            .await
            .unwrap()
            .unwrap();
        assert!(plan
            .ssh_forward_spec()
            .unwrap()
            .ends_with(":127.0.0.1:21888"));

        let bad_binding = EgressBinding {
            plugin_id: "chrome-proxy-launcher".to_string(),
            profile_id: "prof-missing".to_string(),
        };
        assert!(resolve_egress_proxy_url(&bad_binding).await.is_err());

        std::env::remove_var("MULTICC_PLUGINS_DIR");
        let _ = std::fs::remove_dir_all(&root);
    }
}
