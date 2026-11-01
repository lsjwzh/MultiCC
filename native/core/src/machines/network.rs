use super::{fail, Error};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Client, Method, Url};
use serde_json::{json, Value};
use std::{net::{IpAddr, SocketAddr}, time::Duration};

const BODY_LIMIT: usize = 48 * 1024 * 1024;

pub fn origin(raw: &str) -> Result<Url, Error> {
    let url = Url::parse(raw.trim()).map_err(|_| fail(400, "machine_origin_invalid", "请填写完整的电脑访问地址"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some()
        || url.fragment().is_some() || !matches!(url.path(), "" | "/") {
        return Err(fail(400, "machine_origin_invalid", "电脑地址只填写协议、主机和端口"));
    }
    Ok(url)
}

fn allowed_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast() && !ip.is_link_local(),
        IpAddr::V6(ip) => !ip.is_unspecified() && !ip.is_multicast() && (ip.segments()[0] & 0xffc0 != 0xfe80)
            && ip.to_ipv4_mapped().is_none_or(|ip| allowed_address(IpAddr::V4(ip))),
    }
}

pub async fn addresses(url: &Url) -> Result<Vec<SocketAddr>, Error> {
    let hostname = url.host_str().unwrap().trim_matches(['[', ']']);
    let port = url.port_or_known_default().unwrap();
    let addresses: Vec<SocketAddr> = tokio::time::timeout(Duration::from_secs(8), tokio::net::lookup_host((hostname, port))).await
        .map_err(|_| fail(502, "machine_unreachable", "电脑地址解析超时"))?
        .map_err(|_| fail(502, "machine_unreachable", "无法解析这台电脑的访问地址"))?.collect();
    if addresses.is_empty() || addresses.iter().any(|a| !allowed_address(a.ip())) {
        return Err(fail(400, "machine_address_blocked", "此地址不能用于电脑连接"));
    }
    Ok(addresses)
}

async fn client_with(url: &Url, timeout: Option<Duration>) -> Result<Client, Error> {
    let addresses = addresses(url).await?;
    let builder = Client::builder().redirect(Policy::none()).no_proxy()
        .connect_timeout(Duration::from_secs(8)).resolve_to_addrs(url.host_str().unwrap().trim_matches(['[', ']']), &addresses);
    let builder = match timeout { Some(timeout) => builder.timeout(timeout), None => builder };
    builder.build().map_err(|_| fail(503, "machine_transport_unavailable", "电脑连接暂时不可用"))
}

pub async fn client(url: &Url) -> Result<Client, Error> {
    client_with(url, Some(Duration::from_secs(90))).await
}

/// Event streams must not inherit the 90s total deadline: idle gaps are normal.
pub async fn stream_client(url: &Url) -> Result<Client, Error> { client_with(url, None).await }

pub(crate) fn has_certificate_error(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        let text = error.to_string().to_ascii_lowercase();
        if text.contains("certificate") || text.contains("unknownissuer") || text.contains("unknown issuer") { return true; }
        current = error.source();
    }
    false
}

pub fn transport_error(error: &reqwest::Error, message: &'static str) -> Error {
    if has_certificate_error(error) {
        return fail(502, "machine_certificate_untrusted", "目标电脑的 HTTPS 证书不受信任（暂不支持自签证书），请改用受信任证书、Tailscale 地址或局域网 http 地址");
    }
    if error.is_timeout() { return fail(502, "machine_unreachable", "连接这台电脑超时"); }
    fail(502, "machine_unreachable", message)
}

pub fn api_path(path: &str) -> bool {
    if path.len() > 16384 || !path.starts_with("/api/") || (path.contains(['\\', '#']) || path.chars().any(char::is_control)) { return false; }
    let encoded = path.split('?').next().unwrap_or("").to_ascii_lowercase();
    if encoded.contains('%') || encoded.split('/').any(|p| p == "." || p == "..") { return false; }
    !(encoded.starts_with("/api/machines") && !matches!(encoded.as_str(), "/api/machines/self" | "/api/machines/connection"))
        && !encoded.starts_with("/api/auth/exchange")
}

pub fn ws_path(path: &str) -> bool {
    let pathname = path.split('?').next().unwrap_or("");
    if path.len() > 8192 || (path.contains(['\\', '#']) || path.chars().any(char::is_control)) || pathname.contains('%') { return false; }
    matches!(pathname, "/" | "/ws/chat" | "/ws/workspace" | "/ws/meta" | "/ws/aux" | "/ws/voice" | "/ws/tts" | "/ws/remote-screen")
}

pub async fn request(origin: &str, path: &str, method: &str, credential: (&str, &str), body: Option<Vec<u8>>, input: &Value) -> Result<Value, Error> {
    let base = self::origin(origin)?;
    let url = base.join(path).map_err(|_| fail(400, "machine_path_invalid", "电脑请求地址无效"))?;
    if url.origin() != base.origin() { return Err(fail(400, "machine_path_invalid", "电脑请求地址无效")); }
    let method = match method {
        "GET" => Method::GET, "POST" => Method::POST, "PUT" => Method::PUT,
        "PATCH" => Method::PATCH, "DELETE" => Method::DELETE, "HEAD" => Method::HEAD,
        _ => return Err(fail(400, "machine_method_invalid", "不支持此请求方式")),
    };
    let mut request = client(&base).await?.request(method, url).header(credential.0, credential.1);
    for name in ["content-type", "accept", "if-none-match", "if-modified-since", "range"] {
        if let Some(value) = input["headers"][name].as_str() { request = request.header(name, value); }
    }
    if let Some(body) = body {
        if body.len() > BODY_LIMIT { return Err(fail(413, "machine_body_too_large", "电脑请求内容过大，超过 48MB 的文件请在目标电脑上直接打开或下载")); }
        request = request.body(body);
    }
    let mut response = request.send().await.map_err(|e| transport_error(&e, "暂时连接不上这台电脑，请检查网络或访问地址"))?;
    let status = response.status().as_u16();
    if response.status().is_redirection() { return Err(fail(502, "machine_redirect_rejected", "电脑地址发生跳转，请填写最终访问地址后重新连接")); }
    let mut headers = json!({});
    for name in ["content-type", "etag", "last-modified", "content-disposition", "content-range", "accept-ranges", "x-request-id", "x-correlation-id"] {
        if let Some(value) = response.headers().get(name).and_then(|h| h.to_str().ok()) { headers[name] = json!(value); }
    }
    if response.content_length().is_some_and(|size| size > BODY_LIMIT as u64) { return Err(fail(502, "machine_response_too_large", "这台电脑返回的内容过大，超过 48MB 的文件请在目标电脑上直接打开或下载")); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| fail(502, "machine_response_incomplete", "电脑响应中断，请刷新后重试"))? {
        if bytes.len() + chunk.len() > BODY_LIMIT { return Err(fail(502, "machine_response_too_large", "这台电脑返回的内容过大，超过 48MB 的文件请在目标电脑上直接打开或下载")); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(json!({ "status": status, "headers": headers, "body": STANDARD.encode(&bytes) }))
}

/// Pairing uses the access password, not a grant: 401/403 means that password
/// was rejected or none is configured, never that a stored grant expired.
pub fn response_json_pairing(response: &Value) -> Result<Value, Error> {
    if matches!(response["status"].as_u64(), Some(401 | 403)) {
        return Err(fail(403, "machine_password_invalid", "目标电脑访问密码不正确，或目标电脑尚未设置访问密码"));
    }
    response_json(response)
}

pub fn response_json(response: &Value) -> Result<Value, Error> {
    if response["status"].as_u64().is_none_or(|status| !(200..300).contains(&status)) {
        return Err(match response["status"].as_u64() {
            Some(401 | 403) => fail(403, "machine_authorization_required", "电脑访问授权已失效，请重新连接"),
            Some(404) => fail(409, "machine_version_unsupported", "目标电脑尚不支持多电脑连接，请先更新并手动重启目标服务"),
            _ => fail(502, "machine_remote_error", "这台电脑暂时无法完成请求"),
        });
    }
    let bytes = STANDARD.decode(response["body"].as_str().unwrap_or("")).map_err(|_| fail(502, "machine_response_invalid", "电脑响应无效"))?;
    serde_json::from_slice(&bytes).map_err(|_| fail(502, "machine_response_invalid", "目标地址没有返回有效的电脑数据"))
}
