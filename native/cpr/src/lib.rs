//! Rust CPR。宿主只负责授权、凭据和事件桥接，协议和上游传输由 Rust 持有。
pub mod claude_quota;
pub mod error_policy;
pub mod observer;
pub mod plan;
pub mod settings;
pub mod transport;

pub mod provider_host;
pub mod codex_official;
