//! 远端 VPS `agy` 承载配置、工作区映射、Mutagen 忽略规则与远端命令构造。
//!
//! 设计目标：
//! - 多台本地开发机（A / B / C）无需安装 `agy`，并发共用同一 VPS 上的同一个 `agy` 账号；
//! - 按 `<machine_id>/<workspace_hash>` 在 VPS 隔离纯源码目录，构建产物（`node_modules`、
//!   `target/` 等）留在本地真机；
//! - 远端 `agy` 禁用内置 `command(*)`（通过官方 `--settings` deny 规则），全部终端命令
//!   通过 `multicc_host_exec` stdio MCP 经反向隧道回连真机执行；
//! - 凭据（`MULTICC_HOST_EXEC_TOKEN` / URL）仅走环境变量不落盘，多机共用同一
//!   `mcp_config.json` 绝不串机。

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const FILE_MODE_MUTAGEN: &str = "mutagen";
pub const FILE_MODE_REMOTE_MCP: &str = "remote_mcp";
pub const DEFAULT_REMOTE_AGY_BIN: &str = "agy";
pub const DEFAULT_REMOTE_WORKSPACE_BASE: &str = ".multicc-remote/workspaces";

/// 纯源码同步默认忽略规则：排除大体积依赖、构建产物与二进制，确保跨网只同步纯源码。
pub const DEFAULT_MUTAGEN_IGNORES: &[&str] = &[
    "node_modules",
    "target",
    "native/target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".multicc-worktrees",
    ".DS_Store",
    "*.apk",
    "*.ipa",
    "*.node",
    "*.dylib",
    "*.so",
    "*.dll",
    "*.exe",
    "*.zip",
    "*.tar.gz",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgyTarget {
    pub ssh_target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_identity_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_agy_bin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_workspace_base: Option<String>,
    #[serde(default = "default_file_mode")]
    pub file_mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_ignores: Vec<String>,
}

fn default_file_mode() -> String {
    FILE_MODE_MUTAGEN.to_string()
}

fn reject_control_or_newline(value: &str, field: &str) -> Result<(), String> {
    if value
        .chars()
        .any(|c| c.is_control() || c == '\n' || c == '\r')
    {
        return Err(format!("{field} 包含非法控制字符"));
    }
    Ok(())
}

/// 校验并归一化远端 VPS `agy` 目标配置（防 SSH 选项注入与畸形字段）。
pub fn parse_remote_target(raw: &Value) -> Result<RemoteAgyTarget, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "remote 配置必须是 JSON 对象".to_string())?;

    let ssh_target = obj
        .get("sshTarget")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "请填写 SSH 目标（如 ubuntu@1.2.3.4 或 SSH Config 别名）".to_string())?;
    reject_control_or_newline(ssh_target, "sshTarget")?;
    if ssh_target.starts_with('-') || ssh_target.chars().any(char::is_whitespace) {
        return Err("sshTarget 不能以 '-' 开头或包含空白字符".to_string());
    }

    let ssh_port = match obj.get("sshPort") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => {
            let port = n
                .as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .filter(|&p| p >= 1)
                .ok_or_else(|| "sshPort 必须是 1-65535 的整数".to_string())?;
            Some(port)
        }
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => {
            let port = s
                .trim()
                .parse::<u16>()
                .ok()
                .filter(|&p| p >= 1)
                .ok_or_else(|| "sshPort 必须是 1-65535 的整数".to_string())?;
            Some(port)
        }
        Some(_) => return Err("sshPort 必须是 1-65535 的整数".to_string()),
    };

    let clean_opt = |key: &str, allow_spaces: bool| -> Result<Option<String>, String> {
        let Some(val) = obj.get(key).and_then(Value::as_str) else {
            return Ok(None);
        };
        let trimmed = val.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        reject_control_or_newline(trimmed, key)?;
        if !allow_spaces && trimmed.chars().any(char::is_whitespace) {
            return Err(format!("{key} 不能包含空白字符"));
        }
        Ok(Some(trimmed.to_string()))
    };

    let ssh_identity_file = clean_opt("sshIdentityFile", true)?;
    let remote_agy_bin = clean_opt("remoteAgyBin", false)?;
    let remote_home = clean_opt("remoteHome", true)?;
    let remote_workspace_base = clean_opt("remoteWorkspaceBase", false)?;

    let file_mode = match obj
        .get("fileMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None | Some(FILE_MODE_MUTAGEN) => FILE_MODE_MUTAGEN.to_string(),
        Some(FILE_MODE_REMOTE_MCP) => FILE_MODE_REMOTE_MCP.to_string(),
        Some(other) => {
            return Err(format!(
                "不支持的 fileMode: {other}（仅支持 mutagen 或 remote_mcp）"
            ))
        }
    };

    let mut extra_ignores = Vec::new();
    if let Some(arr) = obj.get("extraIgnores").and_then(Value::as_array) {
        for item in arr {
            if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                reject_control_or_newline(s, "extraIgnores")?;
                extra_ignores.push(s.to_string());
            }
        }
    }

    Ok(RemoteAgyTarget {
        ssh_target: ssh_target.to_string(),
        ssh_port,
        ssh_identity_file,
        remote_agy_bin,
        remote_home,
        remote_workspace_base,
        file_mode,
        extra_ignores,
    })
}

/// 单引号安全转义（POSIX sh / bash / zsh 通用）。
pub fn posix_shell_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\"'\"'");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

pub fn workspace_hash(local_cwd: &str) -> String {
    let digest = Sha256::digest(local_cwd.as_bytes());
    let mut hex = String::with_capacity(12);
    for b in &digest[..6] {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

pub fn sanitize_id_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    if cleaned.is_empty() {
        "local".to_string()
    } else {
        cleaned
    }
}

/// 计算远端 VPS 上按 `<machine_id>/<workspace_hash>` 隔离的工作区相对或绝对路径。
pub fn remote_workspace_rel_or_abs(
    base: Option<&str>,
    machine_id: &str,
    local_cwd: &str,
) -> String {
    let root = base
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_REMOTE_WORKSPACE_BASE)
        .trim_end_matches('/');
    let mid = sanitize_id_segment(machine_id);
    let wh = workspace_hash(local_cwd);
    format!("{root}/{mid}/{wh}")
}

/// 生成稳定的 Mutagen 会话名（每台开发机每个目录唯一）。
pub fn mutagen_session_name(machine_id: &str, local_cwd: &str) -> String {
    let mid: String = sanitize_id_segment(machine_id)
        .to_ascii_lowercase()
        .chars()
        .take(12)
        .collect();
    format!("multicc-{mid}-{}", workspace_hash(local_cwd))
}

pub fn resolve_mutagen_ignores(extra: &[String]) -> Vec<String> {
    let mut out: Vec<String> = DEFAULT_MUTAGEN_IGNORES
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    for item in extra {
        if !out.iter().any(|existing| existing == item) {
            out.push(item.clone());
        }
    }
    out
}

/// 构造传给远端 `agy --settings` 的权限 JSON：
/// - `mutagen` 模式：仅禁用内置 `command(*)`，文件工具直接本地高速操作同步目录；
/// - `remote_mcp` 零落盘模式：同时禁用 `command(*)`、`read_file(*)`、`write_file(*)`。
pub fn build_remote_permissions_settings(file_mode: &str) -> String {
    if file_mode == FILE_MODE_REMOTE_MCP {
        json!({
            "permissions": {
                "deny": ["command(*)", "read_file(*)", "write_file(*)"]
            }
        })
        .to_string()
    } else {
        json!({
            "permissions": {
                "deny": ["command(*)"]
            }
        })
        .to_string()
    }
}

/// 给发往远端 `agy` 的 prompt 附加清晰的执行环境说明。
pub fn wrap_remote_prompt(
    prompt: &str,
    local_root: &str,
    remote_root: &str,
    local_os: &str,
    file_mode: &str,
) -> String {
    let guidance = if file_mode == FILE_MODE_REMOTE_MCP {
        format!(
            "[Remote execution environment]\n\
You are running on a remote host, while the user's real workspace lives on their {local_os} machine at `{local_root}`.\n\
Built-in local command and file tools are disabled by policy.\n\
Use `mcp_multicc_host_exec_host_run_command` to run shell/build/test/git commands on the real {local_os} machine, \
and `mcp_multicc_host_exec_host_read_file` / `mcp_multicc_host_exec_host_write_file` / `mcp_multicc_host_exec_host_list_dir` to access workspace files.\n\
[End of remote execution environment]\n\n"
        )
    } else {
        format!(
            "[Remote execution environment]\n\
Your workspace files in `{remote_root}` are live-synced with the user's real {local_os} machine at `{local_root}` (source files only; build artifacts/dependencies live on the user's machine).\n\
You may use native file tools (`read_file`, `edit_file`, `write_file`, `grep_search`, `find_by_name`) directly on `{remote_root}`.\n\
Built-in `run_command` is intentionally disabled. For ALL shell, build, test, git, or local service commands, call `mcp_multicc_host_exec_host_run_command` — it automatically flushes file sync and executes on the user's real {local_os} machine.\n\
[End of remote execution environment]\n\n"
        )
    };
    format!("{guidance}{prompt}")
}

/// 构造远端 `HOME` 切换与目录创建片段：
/// - 绝对路径：直接 `export HOME='/path'`；
/// - `~/...` 或相对路径（如 `.multicc-remote/agy-accounts/<id>`）：按远端登录 `$HOME` 展开；
/// - 自动 `mkdir -p "$HOME"`，用户无需手工在 VPS 上建目录。
pub fn render_remote_home_export(remote_home: Option<&str>) -> String {
    let Some(raw) = remote_home.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    if raw.starts_with('/') {
        format!(
            "export HOME={}; mkdir -p \"$HOME\"; ",
            posix_shell_quote(raw)
        )
    } else {
        let rel = raw.strip_prefix("~/").unwrap_or(raw);
        format!(
            "export HOME=\"$HOME/\"{}; mkdir -p \"$HOME\"; ",
            posix_shell_quote(rel)
        )
    }
}

/// 从 `agy acp --login` 的输出行中提取 Google OAuth 授权链接。
pub fn extract_google_oauth_url(line: &str) -> Option<String> {
    let idx = line.find("https://accounts.google.com/o/oauth2/")?;
    let tail = &line[idx..];
    let url = tail
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')' || c == '>')
        .next()
        .unwrap_or("")
        .trim();
    if url.len() > 40 {
        Some(url.to_string())
    } else {
        None
    }
}

/// 校验并清理用户粘贴的授权码或完整回调 URL（防注入控制字符与换行）。
pub fn sanitize_oauth_callback(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请粘贴 Google 授权码或浏览器回调地址".to_string());
    }
    if trimmed.len() > 8192 {
        return Err("粘贴内容过长，请确认只复制了授权码或回调链接".to_string());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("粘贴内容包含非法换行或控制字符".to_string());
    }
    Ok(trimmed.to_string())
}

/// 构造在远端 VPS 上启动 `agy acp --login` 无浏览器交互授权的脚本。
///
/// 设置 `SSH_CONNECTION` + 清空 `DISPLAY` 强制 `agy` 走官方 `https://antigravity.google/oauth-callback`
/// 链接 + stdin 粘贴授权码/回调 URL 流程（无需端口转发、无需本地浏览器、无需 PTY）。
pub fn build_remote_login_script(remote_agy_bin: &str, remote_home: Option<&str>) -> String {
    let home_export = render_remote_home_export(remote_home);
    let agy = posix_shell_quote(remote_agy_bin);
    format!(
        r#"{home_export}set -e
rm -f "$HOME/.gemini/oauth_creds.json"
SSH_CONNECTION="1 1 1 1" DISPLAY="" BROWSER="/bin/false" {agy} acp --login
if [ -f "$HOME/.gemini/google_accounts.json" ]; then
  printf '\nMULTICC_LOGIN_ACCOUNTS_JSON=%s\n' "$(tr -d '\n\r' < "$HOME/.gemini/google_accounts.json")"
fi
"#,
        home_export = home_export,
        agy = agy,
    )
}

/// 构造在远端 VPS 上幂等部署 `host-exec-mcp.cjs` 并注册进 `$HOME/.gemini/config/mcp_config.json` 的 shell 脚本。
pub fn build_remote_bootstrap_script(remote_home: Option<&str>) -> String {
    let script_b64 = base64::engine::general_purpose::STANDARD
        .encode(crate::host_exec::render_remote_mcp_script().as_bytes());
    let home_export = render_remote_home_export(remote_home);
    format!(
        r#"{home_export}set -e
mkdir -p "$HOME/.multicc-remote/bin" "$HOME/.gemini/config"
SCRIPT="$HOME/.multicc-remote/bin/host-exec-mcp.cjs"
printf '%s' {b64} | base64 -d > "$SCRIPT.tmp"
chmod 700 "$SCRIPT.tmp"
mv -f "$SCRIPT.tmp" "$SCRIPT"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "MULTICC_REMOTE_BOOTSTRAP_ERROR: node is required on the remote VPS for multicc_host_exec MCP" >&2
  exit 12
fi
"$NODE_BIN" -e '
const fs = require("fs"), path = require("path");
const cfgPath = path.join(process.env.HOME, ".gemini", "config", "mcp_config.json");
let root = {{}};
if (fs.existsSync(cfgPath)) {{
  const raw = fs.readFileSync(cfgPath, "utf8").trim();
  if (raw) {{
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed;
  }}
}}
if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) root.mcpServers = {{}};
const desired = {{ command: process.execPath, args: [process.argv[1]] }};
if (JSON.stringify(root.mcpServers.multicc_host_exec) !== JSON.stringify(desired)) {{
  root.mcpServers.multicc_host_exec = desired;
  fs.writeFileSync(cfgPath, JSON.stringify(root, null, 2) + "\n", "utf8");
}}
' "$SCRIPT"
"#,
        home_export = home_export,
        b64 = posix_shell_quote(&script_b64),
    )
}

pub struct RemoteExecSpec<'a> {
    pub remote_agy_bin: &'a str,
    pub remote_home: Option<&'a str>,
    pub remote_workspace_path: &'a str,
    pub local_root: &'a str,
    pub local_os: &'a str,
    pub file_mode: &'a str,
    pub host_exec_url: &'a str,
    pub host_exec_token: &'a str,
    pub agy_args: &'a [String],
    pub prompt: &'a str,
}

/// 构造在远端 VPS 上执行一次 `agy --output-format stream-json` 回合的完整 POSIX shell 命令。
/// `agy_args` 应为原始 `agy` 参数（不含 `-p` 后的 prompt；若末尾带 `-p`，自动在其前插入 `--settings`）。
pub fn build_remote_agy_exec_command(spec: &RemoteExecSpec<'_>) -> String {
    let settings_json = build_remote_permissions_settings(spec.file_mode);
    let wrapped_prompt = wrap_remote_prompt(
        spec.prompt,
        spec.local_root,
        spec.remote_workspace_path,
        spec.local_os,
        spec.file_mode,
    );

    let mut final_args: Vec<String> = Vec::with_capacity(spec.agy_args.len() + 4);
    let mut inserted_settings = false;
    for arg in spec.agy_args {
        if !inserted_settings && arg == "-p" {
            final_args.push("--settings".to_string());
            final_args.push(settings_json.clone());
            inserted_settings = true;
        }
        final_args.push(arg.clone());
    }
    if !inserted_settings {
        final_args.push("--settings".to_string());
        final_args.push(settings_json);
        final_args.push("-p".to_string());
    }
    final_args.push(wrapped_prompt);

    let mut env_parts = Vec::new();
    env_parts.push(format!(
        "MULTICC_HOST_EXEC_URL={}",
        posix_shell_quote(spec.host_exec_url)
    ));
    env_parts.push(format!(
        "MULTICC_HOST_EXEC_TOKEN={}",
        posix_shell_quote(spec.host_exec_token)
    ));
    env_parts.push(format!(
        "MULTICC_HOST_EXEC_LOCAL_ROOT={}",
        posix_shell_quote(spec.local_root)
    ));
    env_parts.push(format!(
        "MULTICC_HOST_EXEC_REMOTE_ROOT={}",
        posix_shell_quote(spec.remote_workspace_path)
    ));
    env_parts.push(format!(
        "MULTICC_HOST_EXEC_OS={}",
        posix_shell_quote(spec.local_os)
    ));
    env_parts.push(format!(
        "MULTICC_HOST_EXEC_FILE_MODE={}",
        posix_shell_quote(spec.file_mode)
    ));

    let ws_expr = if spec.remote_workspace_path.starts_with('/') {
        posix_shell_quote(spec.remote_workspace_path)
    } else {
        format!(
            "\"$HOME/\"{}",
            posix_shell_quote(spec.remote_workspace_path)
        )
    };

    let quoted_args: Vec<String> = final_args.iter().map(|a| posix_shell_quote(a)).collect();

    format!(
        "set -e; {} mkdir -p {ws} && cd {ws} && exec env {} {} {}",
        render_remote_home_export(spec.remote_home),
        env_parts.join(" "),
        posix_shell_quote(spec.remote_agy_bin),
        quoted_args.join(" "),
        ws = ws_expr,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remote_target_validates_ssh_target_and_defaults() {
        let parsed = parse_remote_target(&json!({
            "sshTarget": "ubuntu@10.0.0.5",
            "sshPort": 2222,
            "extraIgnores": ["*.log"]
        }))
        .unwrap();
        assert_eq!(parsed.ssh_target, "ubuntu@10.0.0.5");
        assert_eq!(parsed.ssh_port, Some(2222));
        assert_eq!(parsed.file_mode, "mutagen");
        assert_eq!(parsed.extra_ignores, vec!["*.log"]);

        assert!(parse_remote_target(&json!({ "sshTarget": "-oProxyCommand=bad" })).is_err());
        assert!(parse_remote_target(&json!({ "sshTarget": "host with space" })).is_err());
        assert!(parse_remote_target(&json!({ "sshTarget": "vps", "fileMode": "ftp" })).is_err());
    }

    #[test]
    fn remote_workspace_and_mutagen_session_are_isolated_per_machine_and_cwd() {
        let ws_a = remote_workspace_rel_or_abs(None, "mac-a", "/Users/me/app");
        let ws_b = remote_workspace_rel_or_abs(None, "mac-b", "/Users/me/app");
        assert_ne!(ws_a, ws_b);
        assert!(ws_a.starts_with(".multicc-remote/workspaces/mac-a/"));
        assert!(ws_b.starts_with(".multicc-remote/workspaces/mac-b/"));

        let s_a = mutagen_session_name("mac-a", "/Users/me/app");
        let s_b = mutagen_session_name("mac-b", "/Users/me/app");
        assert_ne!(s_a, s_b);
    }

    #[test]
    fn remote_exec_command_denies_builtin_command_and_injects_host_exec_env() {
        let cmd = build_remote_agy_exec_command(&RemoteExecSpec {
            remote_agy_bin: "agy",
            remote_home: Some("/home/ubuntu/.agy-acct-1"),
            remote_workspace_path: ".multicc-remote/workspaces/mac-a/1234567890ab",
            local_root: "/Users/dev/proj",
            local_os: "darwin",
            file_mode: FILE_MODE_MUTAGEN,
            host_exec_url: "http://127.0.0.1:41234",
            host_exec_token: "tok_secret_abc",
            agy_args: &[
                "--output-format".into(),
                "stream-json".into(),
                "--dangerously-skip-permissions".into(),
                "--model".into(),
                "gemini-4-neon".into(),
                "-p".into(),
            ],
            prompt: "run tests",
        });
        assert!(cmd.contains("MULTICC_HOST_EXEC_URL='http://127.0.0.1:41234'"));
        assert!(cmd.contains("MULTICC_HOST_EXEC_TOKEN='tok_secret_abc'"));
        assert!(cmd.contains("command(*)"));
        assert!(cmd.contains("mcp_multicc_host_exec_host_run_command"));
        assert!(cmd.contains("run tests"));
    }

    #[test]
    fn remote_home_export_and_oauth_helpers_work() {
        assert_eq!(render_remote_home_export(None), "");
        assert!(render_remote_home_export(Some("/home/u/a1")).contains("export HOME='/home/u/a1'"));
        assert!(
            render_remote_home_export(Some(".multicc-remote/agy-accounts/abcd"))
                .contains("export HOME=\"$HOME/\"'.multicc-remote/agy-accounts/abcd'")
        );
        let url = extract_google_oauth_url(
            "  https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz  ",
        )
        .unwrap();
        assert_eq!(
            url,
            "https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz"
        );
        assert!(sanitize_oauth_callback("4/0AfJohX...").is_ok());
        assert!(
            sanitize_oauth_callback("https://antigravity.google/oauth-callback?code=123").is_ok()
        );
        assert!(sanitize_oauth_callback("").is_err());
        assert!(sanitize_oauth_callback("abc\ndef").is_err());
    }
}
