//! CLI 无关的「Chrome 隔离出口启动器（`chrome-proxy-launcher`）」插件解析与远端代理隧道规划。
//!
//! 职责：
//! - 校验与归一化 `egressBinding: { pluginId, profileId }`（复用 `provider_writes::normalize_egress_binding`）；
//! - 按与 `src/routes/plugins.js` 一致的规则定位插件二进制（内置 `plugins/` 优先，其次 `~/.multicc/plugins/`）；
//! - 把解析出来的 `proxyUrl` 规划为远端代理策略：
//!   - 指向本机环回（`127.0.0.1` / `localhost` / `::1`）→ 通过 SSH `-R` 反向隧道把本机出口端口映射到 VPS；
//!   - 指向外部地址 → 远端 `agy` 直接走该代理地址；
//! - 渲染 POSIX shell 代理环境变量（同时强制 `NO_PROXY=127.0.0.1,localhost,::1`，绝不劫持 Host-Exec 通道）。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::agy_remote::posix_shell_quote;
use crate::provider_writes::normalize_egress_binding;

pub const DEFAULT_EGRESS_PLUGIN_ID: &str = "chrome-proxy-launcher";
pub const LOOPBACK_NO_PROXY: &str = "127.0.0.1,localhost,::1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressBinding {
    pub plugin_id: String,
    pub profile_id: String,
}

impl EgressBinding {
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "pluginId": self.plugin_id,
            "profileId": self.profile_id,
        })
    }
}

/// 校验并解析 `egressBinding`（`None` / `null` 表示未绑定）。
pub fn parse_egress_binding(raw: Option<&Value>) -> Result<Option<EgressBinding>, String> {
    let normalized = normalize_egress_binding(raw)?;
    let Some(val) = normalized else {
        return Ok(None);
    };
    let plugin_id = val
        .get("pluginId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let profile_id = val
        .get("profileId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if plugin_id.is_empty() || profile_id.is_empty() {
        return Err("egressBinding 必须包含合法的 pluginId 和 profileId".to_string());
    }
    Ok(Some(EgressBinding {
        plugin_id,
        profile_id,
    }))
}

pub fn node_platform_arch_for(os: &str, arch: &str) -> String {
    let p = match os {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let a = match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{p}-{a}")
}

/// 在给定的插件根目录列表中定位指定插件的可执行二进制（路径严格限制在插件目录内部）。
pub fn resolve_plugin_binary(plugin_id: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    resolve_plugin_binary_for(
        plugin_id,
        roots,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

pub fn resolve_plugin_binary_for(
    plugin_id: &str,
    roots: &[PathBuf],
    os: &str,
    arch: &str,
) -> Option<PathBuf> {
    if plugin_id.is_empty()
        || !plugin_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return None;
    }
    let plat_arch = node_platform_arch_for(os, arch);
    let is_windows = os == "windows";

    for root in roots {
        let dir = root.join(plugin_id);
        let manifest_path = dir.join("plugin.json");
        let Ok(raw) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if manifest.get("id").and_then(Value::as_str) != Some(plugin_id) {
            continue;
        }
        let has_egress = manifest
            .get("commands")
            .and_then(Value::as_array)
            .is_some_and(|arr| arr.iter().any(|c| c.as_str() == Some("egress")));
        if !has_egress {
            continue;
        }
        let Some(engine) = manifest.get("engine").and_then(Value::as_object) else {
            continue;
        };
        if engine.get("type").and_then(Value::as_str) != Some("command") {
            continue;
        }
        let Some(binary) = engine
            .get("binary")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };

        let base_name = Path::new(binary)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(binary);
        let mut names = vec![base_name.to_string()];
        if is_windows && !base_name.to_ascii_lowercase().ends_with(".exe") {
            names.push(format!("{base_name}.exe"));
        }

        let mut candidates = Vec::new();
        if let Some(plat_dir) = engine
            .get("binaryPlatformDir")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            for name in &names {
                candidates.push(dir.join(plat_dir).join(&plat_arch).join(name));
            }
        }
        candidates.push(dir.join(binary));
        if is_windows && !binary.to_ascii_lowercase().ends_with(".exe") {
            candidates.push(dir.join(format!("{binary}.exe")));
        }

        let Ok(canon_dir) = fs::canonicalize(&dir) else {
            continue;
        };
        for cand in candidates {
            if let Ok(canon_bin) = fs::canonicalize(&cand) {
                if canon_bin.starts_with(&canon_dir) && canon_bin.is_file() {
                    return Some(canon_bin);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteProxyPlan {
    /// 外部代理地址：远端 VPS 直接使用该代理。
    Direct { proxy_url: String },
    /// 本机环回代理（如 `chrome-proxy-launcher` 本地端口/中继）：经 SSH `-R` 反向隧道映射到 VPS。
    Tunnel {
        local_host: String,
        local_port: u16,
        remote_port: u16,
        remote_proxy_url: String,
    },
}

impl RemoteProxyPlan {
    pub fn remote_proxy_url(&self) -> &str {
        match self {
            RemoteProxyPlan::Direct { proxy_url } => proxy_url,
            RemoteProxyPlan::Tunnel {
                remote_proxy_url, ..
            } => remote_proxy_url,
        }
    }

    pub fn ssh_forward_spec(&self) -> Option<String> {
        match self {
            RemoteProxyPlan::Direct { .. } => None,
            RemoteProxyPlan::Tunnel {
                local_host,
                local_port,
                remote_port,
                ..
            } => Some(format!("127.0.0.1:{remote_port}:{local_host}:{local_port}")),
        }
    }
}

fn is_loopback_host(host: &str) -> bool {
    let lower = host.trim_matches(['[', ']']).to_ascii_lowercase();
    lower == "127.0.0.1" || lower == "localhost" || lower == "::1" || lower == "0.0.0.0"
}

/// 校验插件返回的 `proxyUrl` 并规划远端 VPS 访问方案。
pub fn plan_remote_proxy(proxy_url: &str, remote_port: u16) -> Result<RemoteProxyPlan, String> {
    let trimmed = proxy_url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control()) {
        return Err("专用出口返回的代理地址为空或包含非法字符".to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|err| format!("专用出口代理地址无效: {err}"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if !matches!(
        scheme.as_str(),
        "http" | "https" | "socks5" | "socks5h" | "socks4"
    ) {
        return Err(format!("不支持的代理协议: {scheme}"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "专用出口代理地址缺少主机名".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "专用出口代理地址缺少端口".to_string())?;

    if is_loopback_host(host) {
        let mut rewritten = parsed.clone();
        let _ = rewritten.set_host(Some("127.0.0.1"));
        let _ = rewritten.set_port(Some(remote_port));
        let target_host = if host.trim_matches(['[', ']']) == "::1" {
            "[::1]".to_string()
        } else {
            "127.0.0.1".to_string()
        };
        Ok(RemoteProxyPlan::Tunnel {
            local_host: target_host,
            local_port: port,
            remote_port,
            remote_proxy_url: rewritten.as_str().trim_end_matches('/').to_string(),
        })
    } else {
        Ok(RemoteProxyPlan::Direct {
            proxy_url: trimmed.to_string(),
        })
    }
}

/// 渲染远端 shell 代理导出片段（同时设 `NO_PROXY=127.0.0.1,localhost,::1` 保护 Host-Exec 环回隧道）。
pub fn render_remote_proxy_exports(proxy_url: Option<&str>) -> String {
    let Some(url) = proxy_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let q_url = posix_shell_quote(url);
    let q_no = posix_shell_quote(LOOPBACK_NO_PROXY);
    format!(
        "export HTTP_PROXY={q_url} HTTPS_PROXY={q_url} ALL_PROXY={q_url} \
         http_proxy={q_url} https_proxy={q_url} all_proxy={q_url} \
         NO_PROXY={q_no} no_proxy={q_no}; "
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_proxy_becomes_ssh_reverse_tunnel_and_preserves_credentials() {
        let plan = plan_remote_proxy("http://127.0.0.1:21001", 43210).unwrap();
        assert_eq!(
            plan,
            RemoteProxyPlan::Tunnel {
                local_host: "127.0.0.1".to_string(),
                local_port: 21001,
                remote_port: 43210,
                remote_proxy_url: "http://127.0.0.1:43210".to_string(),
            }
        );
        assert_eq!(
            plan.ssh_forward_spec().as_deref(),
            Some("127.0.0.1:43210:127.0.0.1:21001")
        );

        let socks = plan_remote_proxy("socks5://user:pass@localhost:1080", 43211).unwrap();
        assert_eq!(
            socks.remote_proxy_url(),
            "socks5://user:pass@127.0.0.1:43211"
        );
    }

    #[test]
    fn public_proxy_passes_through_directly_and_invalid_schemes_fail() {
        let plan = plan_remote_proxy("socks5://198.51.100.5:1080", 43210).unwrap();
        assert_eq!(
            plan,
            RemoteProxyPlan::Direct {
                proxy_url: "socks5://198.51.100.5:1080".to_string(),
            }
        );
        assert_eq!(plan.ssh_forward_spec(), None);
        assert!(plan_remote_proxy("ftp://1.2.3.4:21", 43210).is_err());
        assert!(plan_remote_proxy("http://127.0.0.1:80\nrm -rf /", 43210).is_err());
    }

    #[test]
    fn proxy_exports_always_bypass_loopback() {
        let s = render_remote_proxy_exports(Some("http://127.0.0.1:43210"));
        assert!(s.contains("HTTPS_PROXY='http://127.0.0.1:43210'"));
        assert!(s.contains("NO_PROXY='127.0.0.1,localhost,::1'"));
        assert_eq!(render_remote_proxy_exports(None), "");
    }
}
