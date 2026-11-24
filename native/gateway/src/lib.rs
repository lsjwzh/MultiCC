//! `multicc-gateway` — the Rust front door that owns the public port and
//! supervises the Node server behind it.
//!
//! It is an L7 HTTP front door: hyper's HTTP/1 server answers native routes
//! (none in production yet) and forwards everything else to Node over one
//! dedicated upstream connection per client connection, with a PROXY v1 header
//! written before the first request. The contract (command line, port policy,
//! child environment, PROXY line, forwarding, supervision) is
//! `docs/gateway.md`.

pub mod acp_bridge;
pub mod agy_relay_client;
pub mod agy_remote_bridge;
pub mod agy_remote_login;
pub mod app;
pub mod args;
pub mod auth_control;
pub mod backoff;
pub mod chat_bridge;
pub mod claude_relay_client;
pub mod cli_relay_bridge;
pub mod cli_relay_client;
pub mod codex_bridge;
pub mod codex_relay_client;
pub mod daemon;
pub mod egress_runtime;
pub mod forward;
pub mod host_exec;
pub mod host_port;
pub mod outbound;
pub mod proxy_header;
pub mod remote_child;
pub mod ws_agy_relay;
pub mod ws_chat;
pub mod ws_chat_hub;
mod ws_chat_native;
pub mod ws_claude_relay;
pub mod ws_codex_relay;
pub mod ws_handshake;
pub mod ws_machines;
pub mod ws_probe;
pub mod ws_registry;
pub mod ws_remote_screen;
pub mod ws_tls;

static RESTART_GENERATION: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Capture a restart marker once before serving requests. This also supports
/// launchd, whose static environment cannot carry a newly created generation.
pub fn init_restart_generation(cwd: &std::path::Path) -> bool {
    let base = std::env::current_dir().unwrap_or_else(|_| cwd.to_path_buf());
    let root = std::env::var_os("MULTICC_DATA_DIR")
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| base.clone());
    let root = if root.is_absolute() {
        root
    } else {
        base.join(root)
    };
    let marker = std::fs::read_to_string(root.join(".restart-generation")).ok();
    let valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    let marker = marker.map(|s| s.trim().to_owned()).filter(|s| valid(s));
    let exact = marker.is_some();
    let _ = RESTART_GENERATION.set(marker);
    exact
}

pub fn restart_generation() -> Option<&'static str> {
    RESTART_GENERATION.get().and_then(|value| value.as_deref())
}

/// Version of the front-door ⇄ Node contract. Must match the probe in
/// `scripts/build-rust-kernels.js` and `src/gateway-child.js`.
pub const PROTOCOL_VERSION: u32 = 15;

pub fn version_line() -> String {
    format!(
        "multicc-gateway {PROTOCOL_VERSION} {}",
        env!("CARGO_PKG_VERSION")
    )
}
