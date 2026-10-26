//! 代理探测与上游隧道：TCP 可达性 + 通过代理取出口 IP（支持代理认证）。
//!
//! 只用 std 的 TcpStream —— http 代理发绝对 URL 的 GET（有凭据时带
//! Proxy-Authorization: Basic），socks5 手写握手（无认证或 RFC 1929 用户名
//! 密码认证），不引 reqwest/tokio。socks5_connect 同时被 relay.rs 复用：
//! 中继把客户端流量经认证 socks5 上游隧道送出去。

use crate::store::ProxyConfig;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

const IP_ENDPOINTS: [(&str, &str, &str); 2] = [
    // (host, path, 说明)
    ("ifconfig.me", "/ip", "ifconfig.me"),
    ("api.ip.sb", "/ip", "api.ip.sb"),
];

pub fn tcp_reachable(host: &str, port: u16, timeout: Duration) -> bool {
    connect_tcp(host, port, timeout).is_ok()
}

/// 解析 + 限时连接（探测 / 中继共用的第一步）。
pub fn connect_tcp(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let addr: SocketAddr = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|err| format!("解析代理地址失败：{err}"))?
        .next()
        .ok_or("代理地址解析为空")?;
    let stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|err| format!("连接代理失败：{err}"))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();
    Ok(stream)
}

pub fn looks_like_ip(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() || text.len() > 45 {
        return false;
    }
    text.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ':')
}

/// 标准字母表 base64（只为 Basic 认证头，不值得为此引 crate）。
pub fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// 标准字母表 base64 解码（机场订阅常把 base64 包在 yaml 外面）。
/// 容忍换行与 URL-safe 变体；其余非法字符直接判错。
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for ch in input.chars() {
        let value = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            c if c.is_whitespace() => continue,
            _ => return Err("不是 base64 文本".into()),
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    if out.is_empty() {
        return Err("不是 base64 文本".into());
    }
    Ok(out)
}

pub fn basic_authorization(username: &str, password: &str) -> String {    format!(
        "Proxy-Authorization: Basic {}",
        base64_encode(format!("{username}:{password}").as_bytes())
    )
}

fn http_get_over(mut stream: TcpStream, host: &str, path: &str) -> Result<String, String> {
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: multicc-plugin/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("发送请求失败：{err}"))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|err| format!("读取响应失败：{err}"))?;
    let text = String::from_utf8_lossy(&buf);
    let body = match text.find("\r\n\r\n") {
        Some(at) => &text[at + 4..],
        None => "",
    };
    let body = body.trim();
    if !text.starts_with("HTTP/") || !looks_like_ip(body) {
        return Err(format!("出口 IP 应答不合规：{}", &body[..body.len().min(60)]));
    }
    Ok(body.to_string())
}

/// 通过 http/https 代理取出口 IP（GET 绝对 URL，有凭据时带 Basic 认证）。
fn exit_ip_via_http_proxy(config: &ProxyConfig, timeout: Duration) -> Result<String, String> {
    let mut stream = connect_tcp(&config.host, config.port, timeout)?;
    let auth_line = match (config.has_credentials(), &config.username, &config.password) {
        (true, Some(user), Some(pass)) => format!("{}\r\n", basic_authorization(user, pass)),
        _ => String::new(),
    };
    let request = format!(
        "GET http://{endpoint}{path} HTTP/1.1\r\nHost: {endpoint}\r\n{auth_line}User-Agent: multicc-plugin/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        endpoint = IP_ENDPOINTS[0].0, path = IP_ENDPOINTS[0].1
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("发送请求失败：{err}"))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|err| format!("读取响应失败：{err}"))?;
    let text = String::from_utf8_lossy(&buf);
    let status = text.lines().next().unwrap_or_default().to_string();
    if status.contains(" 407 ") {
        return Err("代理要求认证（407）：账号或密码不对".into());
    }
    let body = match text.find("\r\n\r\n") {
        Some(at) => text[at + 4..].trim().to_string(),
        None => String::new(),
    };
    if !looks_like_ip(&body) {
        return Err("代理应答里没有出口 IP".into());
    }
    Ok(body)
}

/// socks5 CONNECT：greeting（无认证或 RFC 1929 用户名密码）→ CONNECT 按域名
/// （DNS 由代理解析）。成功返回已建好的隧道流。
pub fn socks5_connect(config: &ProxyConfig, target: &str, target_port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let stream = connect_tcp(&config.host, config.port, timeout)?;
    socks5_over(stream, config, target, target_port)
}

/// 在「已经连到 socks5 服务器」的流上完成握手 + CONNECT。链式出口里这条流
/// 往往是经跳板内核建立的（不是本机直连），所以握手要能单独复用。
pub fn socks5_over(mut stream: TcpStream, config: &ProxyConfig, target: &str, target_port: u16) -> Result<TcpStream, String> {
    if config.has_credentials() {
        // 声明同时接受无认证(0x00)与用户名密码(0x02)，让两种上游都工作。
        stream.write_all(&[0x05, 0x02, 0x00, 0x02]).map_err(|err| format!("socks5 握手失败：{err}"))?;
        let mut greeting = [0u8; 2];
        stream.read_exact(&mut greeting).map_err(|err| format!("socks5 握手失败：{err}"))?;
        if greeting[0] != 0x05 {
            return Err("对方不是 socks5 代理".into());
        }
        match greeting[1] {
            0x00 => {}
            0x02 => {
                let (user, pass) = (
                    config.username.as_deref().unwrap_or_default(),
                    config.password.as_deref().unwrap_or_default(),
                );
                if user.len() > 255 || pass.len() > 255 {
                    return Err("socks5 账号/密码过长（>255 字节）".into());
                }
                let mut auth = vec![0x01, user.len() as u8];
                auth.extend_from_slice(user.as_bytes());
                auth.push(pass.len() as u8);
                auth.extend_from_slice(pass.as_bytes());
                stream.write_all(&auth).map_err(|err| format!("socks5 认证发送失败：{err}"))?;
                let mut verdict = [0u8; 2];
                stream.read_exact(&mut verdict).map_err(|err| format!("socks5 认证应答不完整：{err}"))?;
                if verdict[1] != 0x00 {
                    return Err("socks5 代理账号或密码不对".into());
                }
            }
            0xFF => return Err("socks5 代理不接受用户名密码认证".into()),
            other => return Err(format!("socks5 代理要求不支持的认证方式（0x{other:02x}）")),
        }
    } else {
        stream.write_all(&[0x05, 0x01, 0x00]).map_err(|err| format!("socks5 握手失败：{err}"))?;
        let mut greeting = [0u8; 2];
        stream.read_exact(&mut greeting).map_err(|err| format!("socks5 握手失败：{err}"))?;
        if greeting[0] != 0x05 || greeting[1] != 0x00 {
            return Err("socks5 代理要求认证（请在身份里填账号密码）".into());
        }
    }

    if target.len() > 255 {
        return Err("目标域名过长".into());
    }
    let mut request = vec![0x05, 0x01, 0x00, 0x03, target.len() as u8];
    request.extend_from_slice(target.as_bytes());
    request.push((target_port >> 8) as u8);
    request.push((target_port & 0xff) as u8);
    stream.write_all(&request).map_err(|err| format!("socks5 CONNECT 失败：{err}"))?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).map_err(|err| format!("socks5 应答不完整：{err}"))?;
    if head[1] != 0x00 {
        return Err(format!("socks5 代理拒绝连接（REP={}）", head[1]));
    }
    match head[3] {
        0x01 => { let mut rest = [0u8; 6]; stream.read_exact(&mut rest).map_err(|err| err.to_string())?; }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).map_err(|err| err.to_string())?;
            let mut rest = vec![0u8; len[0] as usize + 2];
            stream.read_exact(&mut rest).map_err(|err| err.to_string())?;
        }
        0x04 => { let mut rest = [0u8; 18]; stream.read_exact(&mut rest).map_err(|err| err.to_string())?; }
        other => return Err(format!("socks5 应答地址类型未知（{other}）")),
    }
    Ok(stream)
}

fn exit_ip_via_socks5(config: &ProxyConfig, timeout: Duration) -> Result<String, String> {
    let mut last_err = String::from("没有可用探测目标");
    for (target, path, _) in IP_ENDPOINTS {
        match socks5_connect(config, target, 80, timeout) {
            Ok(stream) => return http_get_over(stream, target, path),
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
}

/// 通过指定代理取出口 IP。返回 Err 时消息可直接展示给用户。
pub fn exit_ip(config: &ProxyConfig, timeout: Duration) -> Result<String, String> {
    match config.scheme.as_str() {
        "socks5" => exit_ip_via_socks5(config, timeout),
        // Chrome 对 https:// 代理同样先走 HTTP 语义的绝对 URL 请求可测通；
        // 若代理要求 TLS 而失败，报错文案会带出原因。
        _ => exit_ip_via_http_proxy(config, timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_ip_filters_html_garbage() {
        assert!(looks_like_ip("1.2.3.4"));
        assert!(looks_like_ip("2600::1"));
        assert!(!looks_like_ip("<html>blocked</html>"));
        assert!(!looks_like_ip(""));
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"abc"), "YWJj");
        assert_eq!(base64_encode(b""), "");
    }
}
