//! `multicc-gateway` — the Rust front door that owns the public port and
//! supervises the Node server behind it.
//!
//! Step 1 is an L4 transparent proxy: one upstream connection per client, a
//! PROXY v1 header written before any client byte, then a bidirectional byte
//! copy. The contract (command line, port policy, child environment, PROXY
//! line, forwarding, supervision) is `docs/gateway.md`.

pub mod args;
pub mod backoff;
pub mod daemon;
pub mod proxy_header;

/// Version of the front-door ⇄ Node contract. Must match the probe in
/// `scripts/build-rust-kernels.js` and `src/gateway-child.js`.
pub const PROTOCOL_VERSION: u32 = 2;

pub fn version_line() -> String {
    format!(
        "multicc-gateway {PROTOCOL_VERSION} {}",
        env!("CARGO_PKG_VERSION")
    )
}
