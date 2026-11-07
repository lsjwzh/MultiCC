//! `multicc-gateway` — the Rust front door that owns the public port and
//! supervises the Node server behind it.
//!
//! It is an L7 HTTP front door: hyper's HTTP/1 server answers native routes
//! (none in production yet) and forwards everything else to Node over one
//! dedicated upstream connection per client connection, with a PROXY v1 header
//! written before the first request. The contract (command line, port policy,
//! child environment, PROXY line, forwarding, supervision) is
//! `docs/gateway.md`.

pub mod args;
pub mod backoff;
pub mod daemon;
pub mod forward;
pub mod proxy_header;

/// Version of the front-door ⇄ Node contract. Must match the probe in
/// `scripts/build-rust-kernels.js` and `src/gateway-child.js`.
pub const PROTOCOL_VERSION: u32 = 3;

pub fn version_line() -> String {
    format!(
        "multicc-gateway {PROTOCOL_VERSION} {}",
        env!("CARGO_PKG_VERSION")
    )
}
