//! `/api/tunnel/ssh` — Unified SSH (port 22) TCP endpoint configuration & probe.
//!
//! Vendor-agnostic: stores one independent `user@host:port` mapping in
//! `ssh-tunnel.json` (never touching port-3000 `tunnel-config.json`), parses
//! common pasted formats (`tcp://...`, `ssh -p ...`, `host:port`), and verifies
//! connectivity with a standard TCP + SSH banner probe.

use std::path::PathBuf;
use std::sync::OnceLock;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate;
use multicc_core::ssh_tunnel::{
    gather_snapshot_blocking, load_config, now_epoch_ms, open_remote_login_settings,
    parse_ssh_endpoint, save_config, state_dir, validate_host, validate_note, validate_port,
    validate_username, SshTunnelConfig, SshTunnelSnapshot, DEFAULT_SSH_PORT,
};
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    StatusGet,
    ApplyPost,
    StopPost,
    OpenSettingsPost,
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
    Layer {
        segs: &["tunnel", "ssh", "open-settings"],
        method: "POST",
        kind: Route::OpenSettingsPost,
    },
];

fn write_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
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
    body: &Value,
) -> Result<(SshTunnelSnapshot, String), (u16, String)> {
    let existing = load_config(&s_dir);
    let local_port = parse_port_field(
        body,
        "localPort",
        if existing.local_port == 0 {
            DEFAULT_SSH_PORT
        } else {
            existing.local_port
        },
    )
    .map_err(|e| (400, e))?;

    let parsed = match body
        .get("endpoint")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => Some(parse_ssh_endpoint(raw).map_err(|e| (400, e))?),
        None => None,
    };

    let remote_host = match parsed.as_ref() {
        Some(ep) => ep.remote_host.clone(),
        None => {
            let host_raw = body
                .get("remoteHost")
                .and_then(Value::as_str)
                .unwrap_or(&existing.remote_host);
            validate_host(host_raw).map_err(|e| (400, e))?
        }
    };

    let default_remote_port =
        parsed
            .as_ref()
            .and_then(|ep| ep.remote_port)
            .unwrap_or(if existing.remote_port == 0 {
                DEFAULT_SSH_PORT
            } else {
                existing.remote_port
            });
    let remote_port = if parsed.as_ref().and_then(|ep| ep.remote_port).is_some()
        && body.get("remotePort").is_none()
    {
        default_remote_port
    } else {
        parse_port_field(body, "remotePort", default_remote_port).map_err(|e| (400, e))?
    };

    let username = match body
        .get("username")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => validate_username(raw).map_err(|e| (400, e))?,
        None => parsed
            .as_ref()
            .and_then(|ep| ep.username.clone())
            .unwrap_or_else(|| {
                if body.get("username").is_some() {
                    String::new()
                } else {
                    existing.username.clone()
                }
            }),
    };

    let note = match body.get("note").and_then(Value::as_str) {
        Some(raw) => validate_note(raw).map_err(|e| (400, e))?,
        None => existing.note.clone(),
    };

    let config = SshTunnelConfig {
        enabled: true,
        local_port,
        remote_host: remote_host.clone(),
        remote_port,
        username,
        note,
        updated_at: now_epoch_ms(),
    };

    save_config(&s_dir, &config).map_err(|e| (500, format!("保存 SSH 映射配置失败: {e}")))?;

    let snapshot = tokio::task::spawn_blocking(move || gather_snapshot_blocking(&s_dir, true))
        .await
        .map_err(|_| (500, "检测 SSH 映射连通性失败".to_string()))?;

    let message = match (
        snapshot.sshd_listening,
        snapshot.remote_reachable,
        snapshot.remote_ssh_banner,
    ) {
        (false, Some(true), Some(false)) => {
            format!("已保存 {remote_host}:{remote_port}：公网穿透端口已通，但本机 {local_port} 端口尚未开启 SSH 服务，请先完成第 1 步开启本机远程登录后再检测")
        }
        (false, _, _) => {
            format!("已保存 {remote_host}:{remote_port}，但本机 {local_port} 端口尚未监听 SSH，请先完成第 1 步开启本机远程登录")
        }
        (true, Some(true), Some(true)) => {
            format!("已保存并验证通过：{remote_host}:{remote_port}（已检测到 SSH 服务）")
        }
        (true, Some(true), _) => {
            format!("已保存：{remote_host}:{remote_port} TCP 端口可达（未读到 SSH 协议头，请确认穿透本地端口指向 {local_port}）")
        }
        (true, _, _) => {
            format!("已保存 {remote_host}:{remote_port}，本机 SSH 正常但公网暂未探测通（请确认穿透客户端已启动）")
        }
    };
    Ok((snapshot, message))
}

async fn stop_post(s_dir: PathBuf) -> Result<(SshTunnelSnapshot, String), (u16, String)> {
    let mut config = load_config(&s_dir);
    config.enabled = false;
    config.updated_at = now_epoch_ms();
    save_config(&s_dir, &config).map_err(|e| (500, format!("保存 SSH 映射配置失败: {e}")))?;
    let snapshot = tokio::task::spawn_blocking(move || gather_snapshot_blocking(&s_dir, true))
        .await
        .map_err(|_| (500, "刷新 SSH 映射状态失败".to_string()))?;
    Ok((snapshot, "已停用 SSH 映射配置".to_string()))
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

    match route {
        Route::StatusGet => {
            let snapshot = match tokio::task::spawn_blocking(move || {
                gather_snapshot_blocking(&s_dir, can_edit)
            })
            .await
            {
                Ok(s) => s,
                Err(_) => {
                    return express::json(
                        ctx,
                        500,
                        &json!({ "ok": false, "error": "读取 SSH 映射状态失败" }),
                        &[],
                    );
                }
            };
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
            match apply_post(s_dir, body).await {
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
            match stop_post(s_dir).await {
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
        Route::OpenSettingsPost => {
            if !can_edit {
                return express::json(ctx, 403, &json!({ "error": "仅可在本机打开系统设置" }), &[]);
            }
            match tokio::task::spawn_blocking(open_remote_login_settings).await {
                Ok(Ok(message)) => express::json(
                    ctx,
                    200,
                    &json!({ "ok": true, "message": message }),
                    &[("Cache-Control", "no-store")],
                ),
                Ok(Err(error)) => {
                    express::json(ctx, 400, &json!({ "ok": false, "error": error }), &[])
                }
                Err(_) => express::json(
                    ctx,
                    500,
                    &json!({ "ok": false, "error": "打开系统设置失败" }),
                    &[],
                ),
            }
        }
        Route::Options => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
        assert_eq!(
            claim(&Method::POST, "/api/tunnel/ssh/open-settings"),
            Some(Route::OpenSettingsPost)
        );
        assert_eq!(claim(&Method::GET, "/api/tunnel/ssh/stop"), None);
        assert_eq!(claim(&Method::GET, "/api/tunnel/ssh/open-settings"), None);
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
        assert_eq!(
            options_share("/api/tunnel/ssh/open-settings").as_deref(),
            Some("POST")
        );
        assert_eq!(options_share("/api/tunnel/funnel"), None);
    }

    #[test]
    fn endpoint_paste_save_and_stop_roundtrip() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = temp_root("roundtrip");
            // Smart-paste tcp:// format
            let (snap, msg) = apply_post(
                dir.clone(),
                &json!({
                    "endpoint": "tcp://3.tcp.cpolar.top:12345",
                    "username": "alice",
                    "note": "cpolar"
                }),
            )
            .await
            .unwrap();
            assert!(msg.contains("3.tcp.cpolar.top:12345"));
            assert!(snap.active);
            assert!(!snap.platform.is_empty());
            let ep = snap.suggested.unwrap();
            assert_eq!(ep.ssh_target, "alice@3.tcp.cpolar.top");
            assert_eq!(ep.ssh_port, 12345);
            assert_eq!(ep.note, "cpolar");

            // Smart-paste ssh -p format
            let (snap2, _) = apply_post(
                dir.clone(),
                &json!({ "endpoint": "ssh -p 2222 bob@ssh.example.com" }),
            )
            .await
            .unwrap();
            let ep2 = snap2.suggested.unwrap();
            assert_eq!(ep2.ssh_target, "bob@ssh.example.com");
            assert_eq!(ep2.ssh_port, 2222);

            // Stop clears active & suggested
            let (stopped, _) = stop_post(dir.clone()).await.unwrap();
            assert!(!stopped.active);
            assert!(stopped.suggested.is_none());

            // Locality gate check
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
