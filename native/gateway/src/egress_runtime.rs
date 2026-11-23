//! Rust 侧「Chrome 隔离出口启动器（`chrome-proxy-launcher`）」运行时解析器与本机代理执行桥。
//!
//! 严格遵循 fail-closed 契约（与 `src/claude-auth/egress-agent.js` 一致）：
//! - 不缓存解析结果：每次登录或回合执行前实时向插件查询 `egress`，确保出口切换立刻生效；
//! - 插件缺失、身份不存在或出口不可用时立刻返回明确中文错误，绝不静默回落直连。

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use multicc_core::egress_plugin::{
    plan_remote_proxy, resolve_plugin_binary, EgressBinding, RemoteProxyPlan, LOOPBACK_NO_PROXY,
};

const PLUGIN_TIMEOUT: Duration = Duration::from_secs(20);

fn candidate_plugin_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
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
    if let Ok(override_url) = std::env::var("MULTICC_EGRESS_PROXY_OVERRIDE") {
        let trimmed = override_url.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let roots = candidate_plugin_roots();
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

    let Some(agy_bin) = bin.filter(|s| !s.trim().is_empty()) else {
        emit_agy_error("agy-egress-exec 缺少 --bin 参数");
        return 1;
    };
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn resolve_egress_plugin_executes_command_and_fails_closed_on_error() {
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
