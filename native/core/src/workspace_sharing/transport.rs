//! Bounded, redirect-free remote workspace transport. Resolve once and pin the
//! checked addresses for the connection; never retry a capability mutation.
use super::{
    remote::{self, Plan},
    *,
};
use reqwest::{redirect::Policy, Client, Method};
use std::{net::IpAddr, time::Duration};
pub type Upload =
    std::pin::Pin<Box<dyn futures_util::Stream<Item = std::io::Result<bytes::Bytes>> + Send>>;

pub struct Response {
    pub value: V,
    pub bytes: Vec<u8>,
}
fn safe_ip(ip: IpAddr) -> bool {
    if let IpAddr::V6(ip) = ip {
        if let Some(mapped) = ip.to_ipv4_mapped() {
            return safe_ip(mapped.into());
        }
    }
    !remote::blocked_address(&V::string(&ip.to_string()))
}
fn connection_error(error: &reqwest::Error, plan: &Plan) -> Error {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            let code = match io.kind() {
                std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
                std::io::ErrorKind::ConnectionReset => "ECONNRESET",
                std::io::ErrorKind::TimedOut => "ETIMEDOUT",
                _ => "REMOTE_UNAVAILABLE",
            };
            return remote::connection_error(code, &io.to_string(), &plan.correlation);
        }
        source = current.source();
    }
    // reqwest's Display includes the credential-bearing URL; never expose it.
    remote::connection_error(
        "REMOTE_UNAVAILABLE",
        "无法连接共享工作区",
        &plan.correlation,
    )
}
async fn client(plan: &Plan) -> Result<Client> {
    let hostname = plan.url.host_str().unwrap_or("").trim_matches(['[', ']']);
    if [
        "metadata.google.internal",
        "metadata.google",
        "instance-data",
    ]
    .contains(&hostname.trim_end_matches('.'))
    {
        return Err(Error::new("UNSAFE_SHARE_URL", "该分享地址不允许访问", 400));
    }
    let addresses: Vec<_> =
        tokio::net::lookup_host((hostname, plan.url.port_or_known_default().unwrap_or(80)))
            .await
            .map_err(|_| remote::connection_error("ENOTFOUND", "无法解析分享地址", &V::Null))?
            .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !safe_ip(a.ip())) {
        return Err(Error::new("UNSAFE_SHARE_URL", "该分享地址不允许访问", 400));
    }
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .resolve_to_addrs(hostname, &addresses);
    if let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|p| !p.is_empty()) {
        let certs = tokio::fs::read(path).await.map_err(|_| {
            remote::connection_error(
                "REMOTE_TLS_CONFIG_INVALID",
                "无法读取远端证书配置",
                &plan.correlation,
            )
        })?;
        for cert in reqwest::Certificate::from_pem_bundle(&certs).map_err(|_| {
            remote::connection_error(
                "REMOTE_TLS_CONFIG_INVALID",
                "远端证书配置无效",
                &plan.correlation,
            )
        })? {
            builder = builder.add_root_certificate(cert);
        }
    }
    builder.build().map_err(|e| connection_error(&e, plan))
}
async fn exchange(plan: &Plan, body: Option<Vec<u8>>, stream: Option<Upload>) -> Result<Response> {
    let client = client(plan).await?;
    let method = Method::from_bytes(plan.method.as_bytes()).map_err(|_| {
        remote::connection_error("REMOTE_UNAVAILABLE", "远端请求方法无效", &plan.correlation)
    })?;
    if ["CONNECT", "TRACE", "TRACK"].contains(&plan.method.to_ascii_uppercase().as_str()) {
        return Err(remote::connection_error(
            "REMOTE_UNAVAILABLE",
            "远端请求方法无效",
            &plan.correlation,
        ));
    }
    // Fetch normalizes common HTTP methods but preserves extension methods.
    let method = match plan.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "HEAD" => Method::HEAD,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        "OPTIONS" => Method::OPTIONS,
        _ => method,
    };
    let mut request = client.request(method.clone(), plan.url.clone());
    for (name, value) in &plan.headers {
        let bytes: Option<Vec<u8>> = value
            .chars()
            .map(|c| u8::try_from(u32::from(c)).ok())
            .collect();
        let header = bytes
            .and_then(|b| reqwest::header::HeaderValue::from_bytes(&b).ok())
            .ok_or_else(|| {
                remote::connection_error("REMOTE_UNAVAILABLE", "远端请求头无效", &plan.correlation)
            })?;
        request = request.header(name, header);
    }
    if method != Method::GET && method != Method::HEAD {
        if let Some(body) = plan.body.as_ref().or(body.as_ref()) {
            request = request.body(body.clone());
        } else if let Some(stream) = stream {
            request = request.body(reqwest::Body::wrap_stream(stream));
        }
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| connection_error(&e, plan))?;
    let status = response.status().as_u16();
    let headers = V::Object(
        response
            .headers()
            .keys()
            .map(|name| {
                let mut units = Vec::new();
                for (index, value) in response.headers().get_all(name).iter().enumerate() {
                    if index > 0 {
                        units.extend_from_slice(&[44, 32]);
                    }
                    units.extend(value.as_bytes().iter().map(|b| u16::from(*b)));
                }
                (
                    JsString::from_rust_str(name.as_str()),
                    V::String(JsString::from_units(units)),
                )
            })
            .collect(),
    );
    // Reject redirects and advertised oversize responses before reading bytes.
    if (300..400).contains(&status) {
        return plan.complete(status, &headers, &[]).map(|value| Response {
            value,
            bytes: vec![],
        });
    }
    if response
        .content_length()
        .is_some_and(|n| n > plan.limit() as u64)
    {
        return Err(plan.too_large());
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| plan.unreadable())? {
        if bytes.len().saturating_add(chunk.len()) > plan.limit() {
            return Err(plan.too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = plan.complete(status, &headers, &bytes)?;
    Ok(Response {
        value,
        bytes: if plan.kind == "proxy" { bytes } else { vec![] },
    })
}

pub async fn execute(
    input: V,
    body: Option<Vec<u8>>,
    stream: Option<Upload>,
    timeout_ms: f64,
) -> Result<Response> {
    let plan = Plan::new(&input)?;
    // Node timers use 1ms for non-positive/non-finite/out-of-range durations.
    let ms = if timeout_ms.is_finite() && (1.0..=i32::MAX as f64).contains(&timeout_ms) {
        timeout_ms.trunc() as u64
    } else {
        1
    };
    tokio::time::timeout(Duration::from_millis(ms), exchange(&plan, body, stream))
        .await
        .map_err(|_| {
            remote::connection_error("REMOTE_TIMEOUT", "远端工作区请求超时", &plan.correlation)
        })?
}
