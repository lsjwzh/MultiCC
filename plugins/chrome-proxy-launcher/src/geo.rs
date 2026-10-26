//! 出口地理识别：launch / probe 时经该出口取外网 IP 的国家与时区，
//! 让浏览器实例的时区与界面语言跟出口保持一致。
//!
//! 为什么：时区/语言与出口 IP 不匹配（中文系统 + Asia/Shanghai 报给一个
//! 加州 IP 的网站）是风控触发人机验证最廉价的判据之一。时区走进程环境
//! TZ（Intl / Date 立即生效），界面语言与 Accept-Language 走 --lang；
//! 都只作用于这一个实例，不改系统设置。
//!
//! 探测服务必须支持明文 HTTP（本插件的手写探测不做 TLS）：用 ip-api.com
//! 的免费 JSON 端点（限 45 次/分钟，launch / probe 各一次远够）。识别失败
//! 只降级为「不套用时区/语言」，不影响出口可用性验证，也不阻塞启动。

use crate::store::ProxyConfig;
use serde::Serialize;
use std::io::{Read, Write};
use std::time::Duration;

const GEO_HOST: &str = "ip-api.com";
const GEO_PATH: &str = "/json/?fields=status,message,country,countryCode,timezone,query";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitGeo {
    pub ip: String,
    pub country_code: String,
    pub country_name: String,
    /// IANA 时区（如 America/Los_Angeles）；空 = 服务没给，不套用 TZ。
    pub timezone: String,
    /// Chrome locale（--lang / Accept-Language），见 locale_for_country。
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
        "HK" => "zh-HK",
        "TW" => "zh-TW",
        "MO" => "zh-MO",
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

/// 解析 ip-api.com 的 JSON 应答（独立成纯函数便于测试）。
pub fn parse_geo(body: &str) -> Result<ExitGeo, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "出口地理应答不是 JSON".to_string())?;
    if value["status"].as_str() != Some("success") {
        let message = value["message"].as_str().unwrap_or("未说明原因");
        return Err(format!("出口地理服务应答失败：{message}"));
    }
    let ip = value["query"].as_str().unwrap_or_default().trim().to_string();
    if ip.is_empty() {
        return Err("出口地理应答缺少 IP".into());
    }
    let country_code = value["countryCode"].as_str().unwrap_or_default().trim().to_string();
    let country_name = value["country"].as_str().unwrap_or_default().trim().to_string();
    let timezone = value["timezone"].as_str().unwrap_or_default().trim().to_string();
    Ok(ExitGeo {
        locale: locale_for_country(&country_code),
        ip,
        country_code,
        country_name,
        timezone,
    })
}

/// 完整 HTTP 响应文本 →（状态行检查 + 截 body + 解析）。
fn parse_full_response(text: &str) -> Result<ExitGeo, String> {
    let status = text.lines().next().unwrap_or_default().to_string();
    if !status.contains(" 200 ") {
        return Err(format!("地理服务应答异常：{}", &status[..status.len().min(40)]));
    }
    let body = match text.find("\r\n\r\n") {
        Some(at) => text[at + 4..].trim(),
        None => "",
    };
    parse_geo(body)
}

fn get_request() -> String {
    format!(
        "GET {GEO_PATH} HTTP/1.1\r\nHost: {GEO_HOST}\r\nUser-Agent: multicc-plugin/1.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
}

fn read_to_string(stream: &mut std::net::TcpStream) -> Result<String, String> {
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|_| "读取地理识别应答失败".to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 经指定出口识别地理信息。失败语义＝降级（调用方不阻塞启动）。
pub fn detect(config: &ProxyConfig, timeout: Duration) -> Result<ExitGeo, String> {
    match config.scheme.as_str() {
        "socks5" => {
            let mut stream = crate::proxy::socks5_connect(config, GEO_HOST, 80, timeout)?;
            stream
                .write_all(get_request().as_bytes())
                .map_err(|_| "发送地理识别请求失败".to_string())?;
            parse_full_response(&read_to_string(&mut stream)?)
        }
        // 与 exit_ip 同一约定：https 代理也按 HTTP 语义发绝对 URL 请求，
        // 代理要求 TLS 时会失败——那只是 geo 降级，不是出口故障。
        _ => {
            let mut stream = crate::proxy::connect_tcp(&config.host, config.port, timeout)?;
            let auth_line = match (config.has_credentials(), &config.username, &config.password) {
                (true, Some(user), Some(pass)) => {
                    format!("{}\r\n", crate::proxy::basic_authorization(user, pass))
                }
                _ => String::new(),
            };
            let request = format!(
                "GET http://{GEO_HOST}{GEO_PATH} HTTP/1.1\r\nHost: {GEO_HOST}\r\n{auth_line}User-Agent: multicc-plugin/1.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
            );
            stream
                .write_all(request.as_bytes())
                .map_err(|_| "发送地理识别请求失败".to_string())?;
            let text = read_to_string(&mut stream)?;
            if text.lines().next().unwrap_or_default().contains(" 407 ") {
                return Err("代理要求认证（407）".into());
            }
            parse_full_response(&text)
        }
    }
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
        assert!(parse_geo(r#"{"status":"success"}"#).unwrap_err().contains("缺少 IP"));
        assert!(parse_geo("not json").unwrap_err().contains("不是 JSON"));
    }

    #[test]
    fn parse_full_response_checks_status_and_splits_body() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"success\",\"countryCode\":\"JP\",\"query\":\"1.2.3.4\"}";
        assert_eq!(parse_full_response(ok).unwrap().locale, "ja-JP");
        assert!(parse_full_response("HTTP/1.1 503 Service Unavailable\r\n\r\n{}")
            .unwrap_err()
            .contains("应答异常"));
        assert!(parse_full_response("garbage").unwrap_err().contains("应答异常"));
    }

    #[test]
    fn unknown_countries_fall_back_to_english() {
        assert_eq!(locale_for_country("us"), "en-US");
        assert_eq!(locale_for_country("JP"), "ja-JP");
        assert_eq!(locale_for_country("BR"), "pt-BR");
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
