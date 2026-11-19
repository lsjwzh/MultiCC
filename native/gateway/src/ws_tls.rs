//! The TLS client the machines bridge uses for a `wss://` peer.
//!
//! Node reached the same peer through the `ws` library, i.e. Node's own TLS:
//! the platform trust store plus `NODE_EXTRA_CA_CERTS`, with the certificate
//! verified against the URL's host name even though the address is pinned by
//! the ticket. [`crate::outbound`] already encodes that trust policy for
//! HTTP; this is the same policy expressed with the `rustls` types a raw
//! WebSocket stream needs.
//!
//! The root store is read once per process, off the request path, for the
//! reason documented on [`crate::outbound`]: a cold macOS keychain read costs
//! seconds and must not be charged to the dial budget.

use std::sync::Arc;

use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName};
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::{client::TlsStream, TlsConnector};

static CONFIG: tokio::sync::OnceCell<Arc<ClientConfig>> = tokio::sync::OnceCell::const_new();

/// `NODE_EXTRA_CA_CERTS` is a PEM bundle. Only the certificate blocks are
/// read, and a block whose base64 does not decode is skipped rather than
/// failing the whole bundle — the same tolerance the HTTP client's bundle
/// parse has.
fn extra_roots() -> Vec<CertificateDer<'static>> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let Some(pem) = std::env::var_os("NODE_EXTRA_CA_CERTS")
        .map(std::path::PathBuf::from)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
    else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    let mut rest = pem.as_str();
    while let Some(start) = rest.find(BEGIN) {
        let body = &rest[start + BEGIN.len()..];
        let Some(stop) = body.find(END) else { break };
        let base64: String = body[..stop]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if let Ok(der) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &base64)
        {
            roots.push(CertificateDer::from(der));
        }
        rest = &body[stop + END.len()..];
    }
    roots
}

fn build() -> Result<Arc<ClientConfig>, &'static str> {
    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        // A root the parser rejects is skipped, exactly as the HTTP client
        // skips it; only an entirely unusable store fails the build.
        let _ = roots.add(cert);
    }
    for cert in extra_roots() {
        let _ = roots.add(cert);
    }
    if roots.is_empty() {
        return Err("upstream tls roots");
    }
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

async fn config() -> Result<Arc<ClientConfig>, &'static str> {
    CONFIG
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(build)
                .await
                .unwrap_or(Err("upstream tls roots"))
        })
        .await
        .map(Arc::clone)
}

/// Completes the TLS handshake on an already connected, ticket-pinned socket.
/// The name checked is the URL's host, never the pinned address.
pub async fn connect(stream: TcpStream, host: &str) -> Result<TlsStream<TcpStream>, &'static str> {
    let config = config().await?;
    let name = ServerName::try_from(host.to_string()).map_err(|_| "upstream tls name")?;
    TlsConnector::from(config)
        .connect(name, stream)
        .await
        .map_err(|_| "upstream tls handshake")
}
