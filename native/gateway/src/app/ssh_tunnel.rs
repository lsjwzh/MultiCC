//! `/api/tunnel/ssh` — One-click SSH (port 22) TCP tunnel preset & discovery.
//!
//! Completely independent from MultiCC's primary HTTP (port 3000) tunnel config
//! (`tunnel-config.json`), persisting its own state in `ssh-tunnel.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate;
use multicc_core::ssh_tunnel::{
    build_suggested_endpoint, cpolar_log_path, current_username, find_binary, is_pid_alive,
    load_config, now_epoch_ms, parse_cpolar_tcp_endpoint, parse_tailscale_ssh_host, probe_tcp,
    read_sakura_token, save_config, select_sakura_ssh_tunnel, start_cpolar_ssh, state_dir,
    stop_cpolar_ssh, validate_host, validate_port, validate_username, CandidatesSnapshot,
    CpolarCandidate, SakuraCandidateSummary, SshTunnelConfig, SshTunnelProvider, SshTunnelSnapshot,
    TailscaleCandidate, CPOLAR_BIN_CANDIDATES, DEFAULT_SSH_PORT, TAILSCALE_BIN_CANDIDATES,
    TAILSCALE_SSH_NOTE,
};
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    StatusGet,
    ApplyPost,
    StopPost,
    Options,
}

struct Layer {
    segs: &'static [&'static str],
    method: &'static str,
    kind: Route,
}

static LAYERS: &[Layer] = &[
    Layer {
        segs: &["tunnel", "ssh"],
        method: "GET",
        kind: Route::StatusGet,
    },
    Layer {
        segs: &["tunnel", "ssh"],
        method: "POST",
        kind: Route::ApplyPost,
    },
    Layer {
        segs: &["tunnel", "ssh", "stop"],
        method: "POST",
        kind: Route::StopPost,
    },
];

fn write_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn http_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(4))
                .build()
                .ok()
        })
        .as_ref()
}

fn segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() {
        return None;
    }
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(parts)
}

fn layer_matches(layer: &Layer, parts: &[&str]) -> bool {
    layer.segs.len() == parts.len()
        && layer
            .segs
            .iter()
            .zip(parts)
            .all(|(name, part)| part.eq_ignore_ascii_case(name))
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.as_str() == "OPTIONS" {
        return LAYERS
            .iter()
            .any(|layer| layer_matches(layer, &parts))
            .then_some(Route::Options);
    }
    let wanted = if method.as_str() == "HEAD" {
        "GET"
    } else {
        method.as_str()
    };
    LAYERS
        .iter()
        .find(|layer| layer.method == wanted && layer_matches(layer, &parts))
        .map(|layer| layer.kind)
}

pub fn options_share(path: &str) -> Option<String> {
    let parts = segments(path)?;
    let mut methods: Vec<&'static str> = Vec::new();
    let mut matched = false;
    for layer in LAYERS {
        if !layer_matches(layer, &parts) {
            continue;
        }
        matched = true;
        if !methods.contains(&layer.method) {
            methods.push(layer.method);
        }
        if layer.method == "GET" && !methods.contains(&"HEAD") {
            methods.push("HEAD");
        }
    }
    matched.then(|| methods.join(","))
}

async fn query_cpolar_api_endpoint() -> Option<(String, u16)> {
    let client = http_client()?;
    let res = client
        .get("http://127.0.0.1:4040/api/tunnels")
        .timeout(Duration::from_millis(800))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let text = res.text().await.ok()?;
    parse_cpolar_tcp_endpoint(&text)
}

async fn query_sakura_candidate(
    data_root: &Path,
    home: &Path,
    local_port: u16,
    preferred_id: Option<&str>,
) -> SakuraCandidateSummary {
    let Some(token) = read_sakura_token(data_root, home) else {
        return SakuraCandidateSummary {
            has_token: false,
            tunnel: None,
            error: None,
        };
    };
    let Some(client) = http_client() else {
        return SakuraCandidateSummary {
            has_token: true,
            tunnel: None,
            error: Some("HTTP 客户端初始化失败".to_string()),
        };
    };
    let auth = format!("Bearer {token}");
    let (tunnels_res, nodes_res) = tokio::join!(
        client
            .get("https://api.natfrp.com/v4/tunnels")
            .header("Authorization", &auth)
            .header("User-Agent", "multicc")
            .send(),
        client
            .get("https://api.natfrp.com/v4/nodes")
            .header("Authorization", &auth)
            .header("User-Agent", "multicc")
            .send(),
    );
    let tunnels: Value = match tunnels_res {
        Ok(res) if res.status().is_success() => match res.text().await {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(v) => v,
                Err(_) => {
                    return SakuraCandidateSummary {
                        has_token: true,
                        tunnel: None,
                        error: Some("SakuraFrp 隧道列表解析失败".to_string()),
                    };
                }
            },
            Err(_) => {
                return SakuraCandidateSummary {
                    has_token: true,
                    tunnel: None,
                    error: Some("SakuraFrp 隧道列表解析失败".to_string()),
                };
            }
        },
        Ok(res) => {
            return SakuraCandidateSummary {
                has_token: true,
                tunnel: None,
                error: Some(format!("SakuraFrp /tunnels 响应 {}", res.status())),
            };
        }
        Err(_) => {
            return SakuraCandidateSummary {
                has_token: true,
                tunnel: None,
                error: Some("SakuraFrp API 不可达".to_string()),
            };
        }
    };
    let nodes: Value = match nodes_res {
        Ok(res) if res.status().is_success() => res
            .text()
            .await
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!({})),
        _ => json!({}),
    };
    let tunnel = select_sakura_ssh_tunnel(&tunnels, &nodes, local_port, preferred_id);
    SakuraCandidateSummary {
        has_token: true,
        tunnel,
        error: None,
    }
}

fn probe_tailscale_host() -> TailscaleCandidate {
    let Some(bin) = find_binary(TAILSCALE_BIN_CANDIDATES, "tailscale") else {
        return TailscaleCandidate {
            available: false,
            host: None,
            note: TAILSCALE_SSH_NOTE.to_string(),
        };
    };
    let host = Command::new(bin)
        .args(["status", "--json"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| serde_json::from_slice::<Value>(&out.stdout).ok())
        .and_then(|val| parse_tailscale_ssh_host(&val));
    TailscaleCandidate {
        available: true,
        host,
        note: TAILSCALE_SSH_NOTE.to_string(),
    }
}

async fn gather_snapshot(
    s_dir: PathBuf,
    d_root: PathBuf,
    home: PathBuf,
    can_edit: bool,
) -> SshTunnelSnapshot {
    let config = load_config(&s_dir);
    let local_port = if config.local_port == 0 {
        DEFAULT_SSH_PORT
    } else {
        config.local_port
    };
    let config_pid = config.pid;
    let sakura_pref = config.sakura_tunnel_id.clone();

    let blocking_handle = tokio::task::spawn_blocking(move || {
        let local_user = current_username();
        let sshd_listening = probe_tcp("127.0.0.1", local_port, 250);
        let cpolar_bin = find_binary(CPOLAR_BIN_CANDIDATES, "cpolar");
        let pid_alive = config_pid.is_some_and(is_pid_alive);
        let log_ep = fs::read_to_string(cpolar_log_path(&s_dir))
            .ok()
            .and_then(|text| parse_cpolar_tcp_endpoint(&text));
        let tailscale = probe_tailscale_host();
        (
            local_user,
            sshd_listening,
            cpolar_bin,
            pid_alive,
            log_ep,
            tailscale,
        )
    });

    let (blocking_res, sakura, api_ep) = tokio::join!(
        blocking_handle,
        query_sakura_candidate(&d_root, &home, local_port, sakura_pref.as_deref()),
        query_cpolar_api_endpoint(),
    );

    let (local_user, sshd_listening, cpolar_bin, pid_alive, log_ep, tailscale) = blocking_res
        .unwrap_or_else(|_| {
            (
                current_username(),
                false,
                None,
                false,
                None,
                TailscaleCandidate {
                    available: false,
                    host: None,
                    note: TAILSCALE_SSH_NOTE.to_string(),
                },
            )
        });

    let cpolar_ep = api_ep.or(log_ep);
    let cpolar_alive = pid_alive || cpolar_ep.is_some();
    let cpolar = CpolarCandidate {
        available: cpolar_bin.is_some(),
        bin_path: cpolar_bin.map(|p| p.display().to_string()),
        running_pid: config_pid.filter(|pid| is_pid_alive(*pid)),
        alive: cpolar_alive,
        remote_host: cpolar_ep.as_ref().map(|(h, _)| h.clone()),
        remote_port: cpolar_ep.as_ref().map(|(_, p)| *p),
    };

    let active = config.enabled
        && match config.provider.as_str() {
            "cpolar" => cpolar.alive,
            "sakurafrp" => {
                sakura.tunnel.as_ref().is_some_and(|t| t.online) || !config.remote_host.is_empty()
            }
            "tailscale" => tailscale.host.is_some() || !config.remote_host.is_empty(),
            _ => !config.remote_host.is_empty() && config.remote_port > 0,
        };

    let suggested = build_suggested_endpoint(&config, &local_user, &cpolar, &sakura, &tailscale);
    SshTunnelSnapshot {
        can_edit,
        local_user,
        local_port,
        sshd_listening,
        config,
        active,
        pid_alive,
        candidates: CandidatesSnapshot {
            cpolar,
            sakurafrp: sakura,
            tailscale,
        },
        suggested,
    }
}

fn parse_port_field(body: &Value, key: &str, default_val: u16) -> Result<u16, String> {
    let Some(val) = body.get(key) else {
        return Ok(default_val);
    };
    if val.is_null() {
        return Ok(default_val);
    }
    let port = val
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .or_else(|| val.as_str().and_then(|s| s.trim().parse::<u16>().ok()))
        .ok_or_else(|| format!("{key} 必须是 1 到 65535 之间的整数"))?;
    validate_port(port)
}

async fn apply_post(
    s_dir: PathBuf,
    d_root: PathBuf,
    home: PathBuf,
    body: &Value,
) -> Result<(SshTunnelSnapshot, String), (u16, String)> {
    let requested = body
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let provider = SshTunnelProvider::parse(requested).map_err(|e| (400, e))?;
    let mut config = load_config(&s_dir);

    let local_port = parse_port_field(
        body,
        "localPort",
        if config.local_port == 0 {
            DEFAULT_SSH_PORT
        } else {
            config.local_port
        },
    )
    .map_err(|e| (400, e))?;
    let username = match body.get("username").and_then(Value::as_str) {
        Some(raw) => validate_username(raw).map_err(|e| (400, e))?,
        None => config.username.clone(),
    };
    let start_now = body
        .get("startNow")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let tunnel_id_req = body
        .get("tunnelId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let resolved = match provider {
        SshTunnelProvider::Auto => {
            let sakura =
                query_sakura_candidate(&d_root, &home, local_port, tunnel_id_req.as_deref()).await;
            if sakura.tunnel.as_ref().is_some_and(|t| t.online) {
                SshTunnelProvider::Sakurafrp
            } else if find_binary(CPOLAR_BIN_CANDIDATES, "cpolar").is_some() {
                SshTunnelProvider::Cpolar
            } else if probe_tailscale_host().host.is_some() {
                SshTunnelProvider::Tailscale
            } else {
                return Err((
                    400,
                    "未检测到可用的自动 SSH 映射通道：请先安装 cpolar，或在 SakuraFrp 控制台创建指向本机 22 端口的 TCP 隧道，或选择「自定义映射」填写地址".to_string(),
                ));
            }
        }
        other => other,
    };

    let message = match resolved {
        SshTunnelProvider::Custom => {
            let host_raw = body
                .get("remoteHost")
                .and_then(Value::as_str)
                .unwrap_or(&config.remote_host);
            let remote_host = validate_host(host_raw).map_err(|e| (400, e))?;
            let remote_port =
                parse_port_field(body, "remotePort", config.remote_port).map_err(|e| (400, e))?;
            if let Some(pid) = config.pid.take() {
                let _ = stop_cpolar_ssh(pid);
            }
            config = SshTunnelConfig {
                enabled: true,
                provider: "custom".to_string(),
                local_port,
                remote_host: remote_host.clone(),
                remote_port,
                username,
                sakura_tunnel_id: None,
                pid: None,
                updated_at: now_epoch_ms(),
            };
            format!("已保存自定义 SSH 映射：{remote_host}:{remote_port} → 127.0.0.1:{local_port}")
        }
        SshTunnelProvider::Sakurafrp => {
            let pref = tunnel_id_req.or(config.sakura_tunnel_id.clone());
            let sakura = query_sakura_candidate(&d_root, &home, local_port, pref.as_deref()).await;
            let Some(cand) = sakura.tunnel else {
                let reason = sakura.error.unwrap_or_else(|| {
                    if sakura.has_token {
                        format!("未在 SakuraFrp 找到指向本机 {local_port} 端口的 TCP 隧道，请先在官网控制台创建 TCP 隧道")
                    } else {
                        "尚未绑定 SakuraFrp 访问密钥，请先在上方中国大陆方案绑定密钥并创建 TCP 22 隧道".to_string()
                    }
                });
                return Err((400, reason));
            };
            if let Some(pid) = config.pid.take() {
                let _ = stop_cpolar_ssh(pid);
            }
            config = SshTunnelConfig {
                enabled: true,
                provider: "sakurafrp".to_string(),
                local_port,
                remote_host: cand.remote_host.clone(),
                remote_port: cand.remote_port,
                username,
                sakura_tunnel_id: Some(cand.tunnel_id.clone()),
                pid: None,
                updated_at: now_epoch_ms(),
            };
            if cand.online {
                format!(
                    "已绑定 SakuraFrp TCP 隧道：{} ({}:{})",
                    if cand.name.is_empty() {
                        &cand.tunnel_id
                    } else {
                        &cand.name
                    },
                    cand.remote_host,
                    cand.remote_port
                )
            } else {
                format!(
                    "已绑定 SakuraFrp TCP 隧道（当前离线，请在上方启动 SakuraFrp 后刷新）：{}:{}",
                    cand.remote_host, cand.remote_port
                )
            }
        }
        SshTunnelProvider::Tailscale => {
            let ts = tokio::task::spawn_blocking(probe_tailscale_host)
                .await
                .map_err(|_| (500, "探测 Tailscale 状态失败".to_string()))?;
            let Some(host) = ts.host else {
                return Err((
                    400,
                    "未检测到已登录的 Tailscale 节点，请先启动并登录 Tailscale".to_string(),
                ));
            };
            if let Some(pid) = config.pid.take() {
                let _ = stop_cpolar_ssh(pid);
            }
            config = SshTunnelConfig {
                enabled: true,
                provider: "tailscale".to_string(),
                local_port,
                remote_host: host.clone(),
                remote_port: local_port,
                username,
                sakura_tunnel_id: None,
                pid: None,
                updated_at: now_epoch_ms(),
            };
            format!("已启用 Tailscale 内网 SSH：{host}:{local_port}（仅限同一 Tailnet 设备直连）")
        }
        SshTunnelProvider::Cpolar => {
            let prev_pid = config.pid;
            let (remote_host, remote_port, pid) = if start_now {
                let s_dir_spawn = s_dir.clone();
                let d_root_spawn = d_root.clone();
                let home_spawn = home.clone();
                let spawned_pid = tokio::task::spawn_blocking(move || {
                    start_cpolar_ssh(
                        &s_dir_spawn,
                        &d_root_spawn,
                        &home_spawn,
                        local_port,
                        prev_pid,
                    )
                })
                .await
                .map_err(|_| (500, "启动 cpolar 线程异常".to_string()))?
                .map_err(|e| (400, e))?;

                let mut endpoint = None;
                for _ in 0..10 {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if let Some(ep) = query_cpolar_api_endpoint().await {
                        endpoint = Some(ep);
                        break;
                    }
                    if let Ok(text) = fs::read_to_string(cpolar_log_path(&s_dir)) {
                        if let Some(ep) = parse_cpolar_tcp_endpoint(&text) {
                            endpoint = Some(ep);
                            break;
                        }
                    }
                    if !is_pid_alive(spawned_pid) {
                        break;
                    }
                }
                let (h, p) = endpoint.unwrap_or_else(|| (String::new(), local_port));
                (h, p, Some(spawned_pid))
            } else {
                let alive = prev_pid.filter(|p| is_pid_alive(*p));
                (config.remote_host.clone(), config.remote_port, alive)
            };
            config = SshTunnelConfig {
                enabled: true,
                provider: "cpolar".to_string(),
                local_port,
                remote_host: remote_host.clone(),
                remote_port,
                username,
                sakura_tunnel_id: None,
                pid,
                updated_at: now_epoch_ms(),
            };
            if !remote_host.is_empty() {
                format!("已启动 cpolar TCP {local_port} 映射：{remote_host}:{remote_port}")
            } else {
                format!(
                    "已后台启动 cpolar tcp {local_port}，正在等待公网地址就绪（请稍候点「重新检测」，或检查 ~/.cpolar/cpolar.yml 鉴权配置）"
                )
            }
        }
        SshTunnelProvider::Auto => unreachable!(),
    };

    save_config(&s_dir, &config).map_err(|e| (500, format!("保存 SSH 映射配置失败: {e}")))?;
    let snapshot = gather_snapshot(s_dir, d_root, home, true).await;
    Ok((snapshot, message))
}

async fn stop_post(
    s_dir: PathBuf,
    d_root: PathBuf,
    home: PathBuf,
) -> Result<(SshTunnelSnapshot, String), (u16, String)> {
    let mut config = load_config(&s_dir);
    let mut stopped_pid = false;
    if let Some(pid) = config.pid.take() {
        let stop_res = tokio::task::spawn_blocking(move || stop_cpolar_ssh(pid))
            .await
            .map_err(|_| (500, "停止 cpolar 进程异常".to_string()))?
            .map_err(|e| (500, e))?;
        stopped_pid = stop_res;
    }
    config.enabled = false;
    config.updated_at = now_epoch_ms();
    save_config(&s_dir, &config).map_err(|e| (500, format!("保存 SSH 映射配置失败: {e}")))?;
    let snapshot = gather_snapshot(s_dir, d_root, home, true).await;
    let message = if stopped_pid {
        "已停止托管的 cpolar TCP 映射并关闭 SSH 映射 preset".to_string()
    } else {
        "已关闭 SSH 映射 preset".to_string()
    };
    Ok((snapshot, message))
}

pub async fn handle(
    app: &App,
    ctx: &RequestCtx,
    route: Route,
    body: &Value,
    peer: &str,
) -> Response<Body> {
    if route == Route::Options {
        let allow = options_share(&ctx.path).unwrap_or_default();
        return express::send(
            ctx,
            200,
            "text/html; charset=utf-8",
            allow.clone().into_bytes(),
            &[("Allow", allow.as_str())],
        );
    }

    let can_edit = http_gate::is_local_request(peer, &ctx.headers);
    let s_dir = state_dir(&app.data_root, &app.package_root, &app.home_dir);
    let d_root = app.data_root.clone();
    let home = app.home_dir.clone();

    match route {
        Route::StatusGet => {
            let snapshot = gather_snapshot(s_dir, d_root, home, can_edit).await;
            express::json(
                ctx,
                200,
                &json!({ "ok": true, "snapshot": snapshot }),
                &[("Cache-Control", "no-store")],
            )
        }
        Route::ApplyPost => {
            if !can_edit {
                return express::json(
                    ctx,
                    403,
                    &json!({ "error": "仅可在本机修改 SSH 映射" }),
                    &[],
                );
            }
            let _guard = write_lock().lock().await;
            match apply_post(s_dir, d_root, home, body).await {
                Ok((snapshot, message)) => express::json(
                    ctx,
                    200,
                    &json!({ "ok": true, "message": message, "snapshot": snapshot }),
                    &[("Cache-Control", "no-store")],
                ),
                Err((status, error)) => {
                    express::json(ctx, status, &json!({ "ok": false, "error": error }), &[])
                }
            }
        }
        Route::StopPost => {
            if !can_edit {
                return express::json(
                    ctx,
                    403,
                    &json!({ "error": "仅可在本机修改 SSH 映射" }),
                    &[],
                );
            }
            let _guard = write_lock().lock().await;
            match stop_post(s_dir, d_root, home).await {
                Ok((snapshot, message)) => express::json(
                    ctx,
                    200,
                    &json!({ "ok": true, "message": message, "snapshot": snapshot }),
                    &[("Cache-Control", "no-store")],
                ),
                Err((status, error)) => {
                    express::json(ctx, status, &json!({ "ok": false, "error": error }), &[])
                }
            }
        }
        Route::Options => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-gw-ssh-tunnel-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claims_and_options_match_case_insensitively() {
        assert_eq!(
            claim(&Method::GET, "/api/tunnel/ssh"),
            Some(Route::StatusGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Tunnel/SSH/"),
            Some(Route::StatusGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/tunnel/ssh"),
            Some(Route::ApplyPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/tunnel/ssh/stop"),
            Some(Route::StopPost)
        );
        assert_eq!(claim(&Method::GET, "/api/tunnel/ssh/stop"), None);
        assert_eq!(
            claim(&Method::OPTIONS, "/api/tunnel/ssh"),
            Some(Route::Options)
        );
        assert_eq!(claim(&Method::DELETE, "/api/tunnel/ssh"), None);

        assert_eq!(
            options_share("/api/tunnel/ssh").as_deref(),
            Some("GET,HEAD,POST")
        );
        assert_eq!(
            options_share("/api/tunnel/ssh/stop").as_deref(),
            Some("POST")
        );
        assert_eq!(options_share("/api/tunnel/funnel"), None);
    }

    #[test]
    fn custom_post_and_stop_roundtrip_and_non_local_rejected() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = temp_root("roundtrip");
            let (snapshot, msg) = apply_post(
                dir.clone(),
                dir.clone(),
                dir.clone(),
                &json!({
                    "provider": "custom",
                    "localPort": 22,
                    "remoteHost": "ssh.example.com",
                    "remotePort": 2222,
                    "username": "alice"
                }),
            )
            .await
            .unwrap();
            assert!(msg.contains("ssh.example.com:2222"));
            assert!(snapshot.active);
            let ep = snapshot.suggested.unwrap();
            assert_eq!(ep.ssh_target, "alice@ssh.example.com");
            assert_eq!(ep.ssh_port, 2222);

            let (stopped, _) = stop_post(dir.clone(), dir.clone(), dir.clone())
                .await
                .unwrap();
            assert!(!stopped.active);
            assert!(!stopped.config.enabled);

            // Locality gate denies forwarded/non-loopback peers and accepts local host
            let local_headers = multicc_core::http_gate::NodeHeaders::from_raw([(
                "host",
                b"127.0.0.1:3000" as &[u8],
            )]);
            assert!(!http_gate::is_local_request("192.168.1.50", &local_headers));
            assert!(http_gate::is_local_request("127.0.0.1", &local_headers));
            let _ = fs::remove_dir_all(&dir);
        });
    }
}
