//! 出口地理识别：launch / probe 时经该出口取外网 IP 的国家与时区，
//! 让浏览器实例的时区与界面语言跟出口保持一致。
//!
//! 为什么：时区/语言与出口 IP 不匹配（中文系统 + Asia/Shanghai 报给一个
//! 加州 IP 的网站）是风控触发人机验证最廉价的判据之一。时区走进程环境
//! TZ（Intl / Date 立即生效），语言走 --accept-lang（请求头与
//! navigator.language）+ 界面 locale（macOS 见 chrome::ui_locale_args）；
//! 都只作用于这一个实例，不改系统设置。
//!
//! 探测服务必须支持明文 HTTP（本插件的手写探测不做 TLS）：用 ip-api.com
//! 的免费 JSON 端点（限 45 次/分钟，launch / probe 各一次远够）。识别失败
//! 只降级为「不套用时区/语言」，不影响出口可用性验证，也不阻塞启动。
//! 应答走明文、经第三方代理转手，所以 IP / 时区都要校验后才用。

use crate::store::ProxyConfig;
use serde::Serialize;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

const GEO_HOST: &str = "ip-api.com";
const GEO_PATH: &str = "/json/?fields=status,message,country,countryCode,timezone,query";
/// 真实应答不到 300 字节；超过这个量只可能是代理塞了错误页或在灌数据。
const MAX_RESPONSE: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitGeo {
    pub ip: String,
    pub country_code: String,
    pub country_name: String,
    /// IANA 时区（如 America/Los_Angeles）；空 = 服务没给或格式不合法，不套用 TZ。
    pub timezone: String,
    /// Chrome locale（--lang / --accept-lang），见 locale_for_country。
    pub locale: String,
}

/// 探测出口时的本地端口一律是 http 语义（meow mixed-port 与中继都讲 http）。
pub fn via_local_http(port: u16) -> ProxyConfig {
    ProxyConfig {
        scheme: "http".into(),
        host: "127.0.0.1".into(),
        port,
        username: None,
        password: None,
    }
}

/// 常用国家码 → Chrome locale。没列出的国家一律 en-US：宁可「英语 + 当地
/// 时区」，也不要「系统语言 + 国外 IP」这种一眼可疑的组合。
pub fn locale_for_country(code: &str) -> String {
    let code = code.trim().to_ascii_uppercase();
    let locale = match code.as_str() {
        "US" | "PR" | "GU" | "VI" | "AS" => "en-US",
        "GB" | "IE" | "MT" => "en-GB",
        "CA" => "en-CA",
        "AU" => "en-AU",
        "NZ" => "en-NZ",
        "ZA" => "en-ZA",
        "SG" => "en-SG",
        "MY" => "en-MY",
        "PH" => "en-PH",
        "IN" => "en-IN",
        "DE" | "AT" => "de-DE",
        "CH" => "de-CH",
        "FR" | "MC" => "fr-FR",
        "NL" => "nl-NL",
        "BE" => "nl-BE",
        "ES" => "es-ES",
        "MX" => "es-MX",
        // 拉美西语区在 Chrome 里统一用 es-419。
        "AR" | "CL" | "CO" | "PE" | "EC" | "VE" | "UY" | "PY" | "BO" | "CR"
        | "PA" | "GT" | "DO" | "HN" | "NI" | "SV" | "CU" => "es-419",
        "BR" => "pt-BR",
        "PT" => "pt-PT",
        "IT" => "it-IT",
        "JP" => "ja-JP",
        "KR" => "ko-KR",
        // 出口在大陆时保持中文：落到 en-US 兜底反而把中文环境改成英文。
        "CN" => "zh-CN",
        // 澳门没有独立的 Chrome 界面语言，按繁体中文香港处理。
        "HK" | "MO" => "zh-HK",
        "TW" => "zh-TW",
        "TH" => "th-TH",
        "VN" => "vi-VN",
        "ID" => "id-ID",
        "TR" => "tr-TR",
        "RU" | "BY" | "KZ" => "ru-RU",
        "UA" => "uk-UA",
        "PL" => "pl-PL",
        "SE" => "sv-SE",
        "NO" => "nb-NO",
        "DK" => "da-DK",
        "FI" => "fi-FI",
        "CZ" => "cs-CZ",
        "RO" => "ro-RO",
        "HU" => "hu-HU",
        "GR" => "el-GR",
        "IL" => "he-IL",
        "SA" => "ar-SA",
        "AE" => "ar-AE",
        _ => "en-US",
    };
    locale.to_string()
}

/// Chrome 的 Accept-Language 列表：主 locale + 同语言兜底（en-US,en /
/// ja-JP,ja / es-419,es）。只给单个 locale 时部分站点仍按序回退，带上
/// 基础码更接近真实用户的浏览器配置。
pub fn accept_languages(locale: &str) -> String {
    let locale = locale.trim();
    if locale.is_empty() {
        return String::new();
    }
    match locale.split_once('-') {
        Some((base, _)) if !base.is_empty() => format!("{locale},{base}"),
        _ => locale.to_string(),
    }
}

/// IANA 时区名白名单：时区原样进 TZ 环境变量，而以 `:` 开头或带 `..` 的
/// TZ 会被 libc 当成文件路径解析。只放行 `Region/City` 形态（及 UTC 这类
/// 单段名）里实际会出现的字符。
pub fn valid_timezone(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 64
        && zone.starts_with(|c: char| c.is_ascii_alphabetic())
        && !zone.ends_with('/')
        && !zone.contains("..")
        && !zone.contains("//")
        && zone
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '+' | '-'))
}

/// 解析 ip-api.com 的 JSON 应答（独立成纯函数便于测试）。
pub fn parse_geo(body: &str) -> Result<ExitGeo, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "出口地理应答不是 JSON".to_string())?;
    if value["status"].as_str() != Some("success") {
        let message = value["message"].as_str().unwrap_or("未说明原因");
        return Err(format!("出口地理服务应答失败：{message}"));
    }
    let ip = value["query"].as_str().unwrap_or_default().trim().to_string();
    if !crate::proxy::looks_like_ip(&ip) {
        return Err("出口地理应答缺少有效 IP".into());
    }
    let country_code = value["countryCode"].as_str().unwrap_or_default().trim().to_string();
    let country_name = value["country"].as_str().unwrap_or_default().trim().to_string();
    let timezone = value["timezone"].as_str().unwrap_or_default().trim().to_string();
    Ok(ExitGeo {
        locale: locale_for_country(&country_code),
        ip,
        country_code,
        country_name,
        // 格式不合法只放弃时区这一半，语言照常套用。
        timezone: if valid_timezone(&timezone) { timezone } else { String::new() },
    })
}

/// 状态码（"HTTP/1.x 200 OK" / "HTTP/1.1 200"）；不是 HTTP 应答时为 None。
fn status_code(text: &str) -> Option<u16> {
    let mut parts = text.lines().next()?.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

/// 完整 HTTP 响应文本 →（状态码检查 + 截 body + 解析）。请求发的是 HTTP/1.0，
/// 服务端不会用 chunked 编码，body 就是 header 之后的全部内容。
fn parse_full_response(text: &str) -> Result<ExitGeo, String> {
    match status_code(text) {
        Some(200) => {}
        Some(407) => return Err("代理要求认证（407）".into()),
        Some(code) => return Err(format!("地理服务应答异常：HTTP {code}")),
        None => return Err("地理服务应答异常：不是 HTTP 应答".into()),
    }
    let body = match text.find("\r\n\r\n") {
        Some(at) => text[at + 4..].trim(),
        None => "",
    };
    parse_geo(body)
}

/// path 是 origin-form（socks5 隧道）或 absolute-form（http 代理）。
/// HTTP/1.0：不会收到 chunked；no-cache：明文请求可能被沿途缓存，
/// 缓存命中会拿到别人的出口 IP / 时区。
fn get_request(path: &str, auth_line: &str) -> String {
    format!(
        "GET {path} HTTP/1.0\r\nHost: {GEO_HOST}\r\n{auth_line}User-Agent: multicc-plugin/1.0\r\nAccept: application/json\r\nCache-Control: no-cache\r\nPragma: no-cache\r\nConnection: close\r\n\r\n"
    )
}

/// 读到对端关闭为止，但受总 deadline 与大小上限约束：单次 read 的超时
/// 挡不住「每次只吐一点」的慢速应答。
fn read_bounded(stream: &mut TcpStream, deadline: Instant) -> Result<String, String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| "地理识别超时".to_string())?;
        stream.set_read_timeout(Some(left)).ok();
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                buf.extend_from_slice(&chunk[..count]);
                if buf.len() > MAX_RESPONSE {
                    return Err("地理识别应答过大".into());
                }
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Err("读取地理识别应答失败或超时".into()),
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 经指定出口识别地理信息，budget 是整次识别（连接 + 请求 + 读应答）的
/// 总时长上限。失败语义＝降级（调用方不阻塞启动）。
pub fn detect(config: &ProxyConfig, budget: Duration) -> Result<ExitGeo, String> {
    let deadline = Instant::now() + budget;
    // 连接阶段（含 socks5 握手）最多用一半预算，剩下的留给读应答。
    let connect_budget = (budget / 2).max(Duration::from_millis(200));
    let (mut stream, request) = match config.scheme.as_str() {
        "socks5" => (
            crate::proxy::socks5_connect(config, GEO_HOST, 80, connect_budget)?,
            get_request(GEO_PATH, ""),
        ),
        // 与 exit_ip 同一约定：https 代理也按 HTTP 语义发绝对 URL 请求，
        // 代理要求 TLS 时会失败——那只是 geo 降级，不是出口故障。
        _ => {
            let auth_line = match (config.has_credentials(), &config.username, &config.password) {
                (true, Some(user), Some(pass)) => {
                    format!("{}\r\n", crate::proxy::basic_authorization(user, pass))
                }
                _ => String::new(),
            };
            (
                crate::proxy::connect_tcp(&config.host, config.port, connect_budget)?,
                get_request(&format!("http://{GEO_HOST}{GEO_PATH}"), &auth_line),
            )
        }
    };
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "发送地理识别请求失败".to_string())?;
    parse_full_response(&read_bounded(&mut stream, deadline)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_geo_reads_country_timezone_and_maps_locale() {
        let geo = parse_geo(
            r#"{"status":"success","country":"United States","countryCode":"US",
                "timezone":"America/Los_Angeles","query":"203.160.113.175"}"#,
        )
        .unwrap();
        assert_eq!(geo.ip, "203.160.113.175");
        assert_eq!(geo.country_code, "US");
        assert_eq!(geo.timezone, "America/Los_Angeles");
        assert_eq!(geo.locale, "en-US");
    }

    #[test]
    fn parse_geo_reports_service_failure_and_missing_fields() {
        assert!(parse_geo(r#"{"status":"fail","message":"private range"}"#)
            .unwrap_err()
            .contains("private range"));
        assert!(parse_geo(r#"{"status":"success"}"#).unwrap_err().contains("有效 IP"));
        assert!(parse_geo(r#"{"status":"success","query":"<html>"}"#)
            .unwrap_err()
            .contains("有效 IP"));
        assert!(parse_geo("not json").unwrap_err().contains("不是 JSON"));
    }

    #[test]
    fn parse_geo_drops_unsafe_timezone_but_keeps_locale() {
        for zone in [":/etc/passwd", "../../etc/passwd", "America/../../x", "/abs", "a b", "Zone/"] {
            let body = format!(
                r#"{{"status":"success","countryCode":"US","timezone":"{zone}","query":"1.2.3.4"}}"#
            );
            let geo = parse_geo(&body).unwrap();
            assert_eq!(geo.timezone, "", "{zone}");
            assert_eq!(geo.locale, "en-US");
        }
        for zone in ["UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+5", "America/Port-au-Prince"] {
            assert!(valid_timezone(zone), "{zone}");
        }
    }

    #[test]
    fn parse_full_response_checks_status_and_splits_body() {
        let ok = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"success\",\"countryCode\":\"JP\",\"query\":\"1.2.3.4\"}";
        assert_eq!(parse_full_response(ok).unwrap().locale, "ja-JP");
        // 没有 reason phrase 的状态行也认。
        let bare = "HTTP/1.1 200\r\n\r\n{\"status\":\"success\",\"countryCode\":\"DE\",\"query\":\"1.2.3.4\"}";
        assert_eq!(parse_full_response(bare).unwrap().locale, "de-DE");
        assert!(parse_full_response("HTTP/1.1 503 Service Unavailable\r\n\r\n{}")
            .unwrap_err()
            .contains("HTTP 503"));
        assert!(parse_full_response("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            .unwrap_err()
            .contains("407"));
        assert!(parse_full_response("garbage").unwrap_err().contains("不是 HTTP"));
    }

    #[test]
    fn request_is_http10_and_uncached() {
        let request = get_request(GEO_PATH, "");
        assert!(request.starts_with("GET /json/?fields="));
        assert!(request.contains(" HTTP/1.0\r\n"));
        assert!(request.contains("Cache-Control: no-cache\r\n"));
    }

    #[test]
    fn unknown_countries_fall_back_to_english() {
        assert_eq!(locale_for_country("us"), "en-US");
        assert_eq!(locale_for_country("JP"), "ja-JP");
        assert_eq!(locale_for_country("BR"), "pt-BR");
        assert_eq!(locale_for_country("CN"), "zh-CN");
        assert_eq!(locale_for_country("MO"), "zh-HK");
        assert_eq!(locale_for_country("XX"), "en-US");
        assert_eq!(locale_for_country(""), "en-US");
    }

    #[test]
    fn accept_languages_appends_language_fallback() {
        assert_eq!(accept_languages("en-US"), "en-US,en");
        assert_eq!(accept_languages("ja-JP"), "ja-JP,ja");
        assert_eq!(accept_languages("es-419"), "es-419,es");
        assert_eq!(accept_languages("en"), "en");
        assert_eq!(accept_languages(""), "");
    }
}
