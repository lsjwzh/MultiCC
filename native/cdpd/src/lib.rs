//! 一台机器上的 CDP 网关（三平台同一份实现）。
//!
//! Chrome 144+ 对「直连正在运行的真实 Chrome」按**每条 WebSocket 连接**弹一次
//! 「允许远程调试」，点允许只覆盖那一条。谁每命令开一条连接，用户就得每命令点一次。
//! 网关常驻、每个 Chrome 只保留一条上游连接，本地调用方经 unix socket / 命名管道
//! （或 loopback WebSocket 入口）复用它，所以每个浏览器会话只需要允许一次。
//!
//! 模块分工：
//! - [`router`]：纯状态机，决定每一帧去哪儿（不碰 IO，单测覆盖全部边界）；
//! - [`upstream`]：每个 Chrome 一个 actor，持有那条已授权的 WebSocket；
//! - [`pool`]：wsUrl → actor，建连 single-flight，审批失败后退避；
//! - [`ipc`] / [`front`]：本地行协议入口与 WebSocket 入口；
//! - [`paths`] / [`log`] / [`wire`]：落盘位置、日志、分帧。
//!
//! 协议契约见 docs/desktop-agent-protocol.md §4.4。

pub mod daemon;
pub mod front;
pub mod ipc;
pub mod log;
pub mod paths;
pub mod pool;
pub mod router;
pub mod upstream;
pub mod wire;

/// 本地协议版本。不兼容的改动才加一；Node 侧（src/cdpd.js）据此决定是否换掉旧进程。
pub const PROTOCOL_VERSION: u32 = 2;

pub fn version_line() -> String {
    format!(
        "multicc-cdpd {PROTOCOL_VERSION} {}",
        env!("CARGO_PKG_VERSION")
    )
}
