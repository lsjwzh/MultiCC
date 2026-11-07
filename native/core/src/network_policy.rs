//! Bind address / port policy — the single implementation behind both the
//! Rust front door (`multicc-gateway`) and `src/network-policy.js`, which is
//! now only a bridge onto these functions.
//!
//! The JavaScript original read `process.env` and relied on JS coercions:
//! `String(value || '')`, `Number.parseInt(...)`, truthiness, `===`. Those
//! rules are reproduced here rather than narrowed to "well-typed" input, so a
//! caller that passes a number, an empty string or a missing key keeps exactly
//! the meaning it always had. Error texts are byte-for-byte the JS ones.

use serde::Serialize;
use serde_json::{Map, Value};
use std::net::{Ipv6Addr, TcpListener};

pub const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "::1", "localhost"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicy {
    pub host: String,
    pub port: u16,
    pub development: bool,
    pub allow_remote: bool,
    pub access_token: String,
    pub lan_only: bool,
}

/// ECMAScript WhiteSpace and LineTerminator — what `String#trim` removes.
/// Not Rust's `char::is_whitespace`: JS trims U+FEFF and keeps U+0085.
fn is_js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `String(value)` for the JSON values an env object can hold.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "undefined".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// `value || ''` followed by `String(...)`.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Bool(false)) => String::new(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => {
            if js_truthy(Some(other)) {
                js_string(Some(other))
            } else {
                String::new()
            }
        }
    }
}

/// `Boolean(value)` for the JSON values an env object can hold.
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `Number.parseInt(text, 10)`.
fn parse_int_10(text: &str) -> f64 {
    let trimmed = js_trim(text);
    let bytes = trimmed.as_bytes();
    let mut index = 0;
    let mut sign = 1.0;
    match bytes.first() {
        Some(b'+') => index = 1,
        Some(b'-') => {
            sign = -1.0;
            index = 1;
        }
        _ => {}
    }
    let start = index;
    let mut value = 0.0_f64;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        value = value * 10.0 + f64::from(bytes[index] - b'0');
        index += 1;
    }
    if index == start {
        f64::NAN
    } else {
        sign * value
    }
}

/// `net.isIP`: 4, 6 or 0. Node rejects leading zeros in IPv4 octets and accepts
/// an IPv6 zone suffix (`fe80::1%en0`).
pub fn is_ip(text: &str) -> u8 {
    if is_ipv4(text) {
        4
    } else if is_ipv6(text) {
        6
    } else {
        0
    }
}

fn is_ipv4(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|part| {
        !part.is_empty()
            && part.len() <= 3
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && !(part.len() > 1 && part.starts_with('0'))
            && part.parse::<u16>().is_ok_and(|value| value <= 255)
    })
}

fn is_ipv6(text: &str) -> bool {
    let address = match text.split_once('%') {
        Some((address, zone)) => {
            if zone.is_empty() {
                return false;
            }
            address
        }
        None => text,
    };
    address.parse::<Ipv6Addr>().is_ok()
}

/// One code point through the non-Unicode `ignoreCase` Canonicalize operation
/// (ECMA-262 §22.2.2.8.2): uppercase, but keep the original when uppercasing
/// would cross from non-ASCII into ASCII (`ſ` must not match `s`, nor `K` `k`).
fn js_canonicalize(c: char) -> char {
    let mut upper = c.to_uppercase();
    let Some(u) = upper.next() else { return c };
    if upper.next().is_some() {
        return c;
    }
    if (c as u32) >= 128 && (u as u32) < 128 {
        return c;
    }
    u
}

fn js_case_equals(left: &str, right: &str) -> bool {
    let mut left = left.chars().map(js_canonicalize);
    let mut right = right.chars().map(js_canonicalize);
    loop {
        match (left.next(), right.next()) {
            (None, None) => return true,
            (Some(a), Some(b)) if a == b => {}
            _ => return false,
        }
    }
}

/// `/^(1|true|yes|on)$/i.test(String(value || '').trim())`.
pub fn env_enabled(value: &str) -> bool {
    let trimmed = js_trim(value);
    ["1", "true", "yes", "on"]
        .iter()
        .any(|word| js_case_equals(trimmed, word))
}

/// `LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase())`.
pub fn is_loopback_host(host: &str) -> bool {
    let lowered = js_trim(host).to_lowercase();
    LOOPBACK_HOSTS.contains(&lowered.as_str())
}

/// `resolveNetworkPolicy(env)`.
pub fn resolve_network_policy(env: &Map<String, Value>) -> Result<NetworkPolicy, String> {
    let configured_host = [env.get("HOST"), env.get("MULTICC_HOST")]
        .into_iter()
        .map(|value| js_trim(&js_text(value)).to_string())
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    let port_value = env.get("PORT");
    let port_text = if js_truthy(port_value) {
        js_string(port_value)
    } else {
        "3000".to_string()
    };
    let port = parse_int_10(&port_text);
    let development = env.get("NODE_ENV").and_then(Value::as_str) == Some("development")
        || env_enabled(&js_text(env.get("MULTICC_DEV")));
    let access_token = js_text(env.get("ACCESS_TOKEN"));
    let remote_setting = js_trim(&js_text(env.get("MULTICC_ALLOW_REMOTE"))).to_string();
    // The installer always creates an ACCESS_TOKEN. When the operator has not
    // chosen a bind policy, that token is the safe signal to make a normal
    // installation reachable from the IPv4 LAN without another setup step.
    let auto_lan = configured_host.is_empty()
        && remote_setting.is_empty()
        && js_trim(&access_token).encode_utf16().count() >= 6;
    let allow_remote = if remote_setting.is_empty() {
        auto_lan
    } else {
        env_enabled(&remote_setting)
    };
    let host = if !configured_host.is_empty() {
        configured_host
    } else if allow_remote {
        "0.0.0.0".to_string()
    } else {
        "127.0.0.1".to_string()
    };
    if host.is_empty() || (is_ip(&host) == 0 && host != "localhost") {
        return Err(format!(
            "Invalid bind host: {}",
            if host.is_empty() { "<empty>" } else { &host }
        ));
    }
    if !(port.is_finite() && port.fract() == 0.0 && (1.0..=65535.0).contains(&port)) {
        return Err(format!("Invalid PORT: {port_text}"));
    }
    if !is_loopback_host(&host) && !allow_remote {
        return Err(format!(
            "Refusing non-loopback bind {host}: set MULTICC_ALLOW_REMOTE=1 explicitly"
        ));
    }
    Ok(NetworkPolicy {
        host,
        port: port as u16,
        development,
        allow_remote,
        access_token,
        lan_only: auto_lan,
    })
}

/// `findAvailablePort(startPort, host, { maxTries })`: bind-probe each port in
/// turn and drop the listener that succeeded. On Unix `std` sets SO_REUSEADDR,
/// matching `net.Server#listen`.
pub fn find_available_port(start_port: i64, host: &str, max_tries: i64) -> Result<u16, String> {
    for offset in 0..max_tries {
        let port = start_port + offset;
        if port > 65535 {
            break;
        }
        if !(0..=65535).contains(&port) {
            return Err(format!("No available port from {start_port} on {host}"));
        }
        match TcpListener::bind((host, port as u16)) {
            Ok(listener) => {
                drop(listener);
                return Ok(port as u16);
            }
            Err(_) => continue,
        }
    }
    Err(format!("No available port from {start_port} on {host}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resolve(value: Value) -> Result<NetworkPolicy, String> {
        let Value::Object(env) = value else {
            panic!("env must be an object");
        };
        resolve_network_policy(&env)
    }

    #[test]
    fn empty_env_is_loopback_on_3000() {
        assert_eq!(
            resolve(json!({})).unwrap(),
            NetworkPolicy {
                host: "127.0.0.1".into(),
                port: 3000,
                development: false,
                allow_remote: false,
                access_token: String::new(),
                lan_only: false,
            }
        );
    }

    #[test]
    fn installed_token_opens_the_lan_only_without_an_override() {
        let policy = resolve(json!({ "ACCESS_TOKEN": "installed-secret" })).unwrap();
        assert_eq!(policy.host, "0.0.0.0");
        assert!(policy.allow_remote);
        assert!(policy.lan_only);
        let opt_out = resolve(json!({
            "ACCESS_TOKEN": "installed-secret", "MULTICC_ALLOW_REMOTE": "0"
        }))
        .unwrap();
        assert_eq!(opt_out.host, "127.0.0.1");
        assert!(!opt_out.allow_remote);
        assert!(!opt_out.lan_only);
        // Exactly six UTF-16 units; five does not qualify, an emoji is two.
        assert_eq!(
            resolve(json!({ "ACCESS_TOKEN": "abcde" })).unwrap().host,
            "127.0.0.1"
        );
        assert_eq!(
            resolve(json!({ "ACCESS_TOKEN": "😀😀😀" })).unwrap().host,
            "0.0.0.0"
        );
        // The length check trims first, with JS whitespace and UTF-16 units.
        assert_eq!(
            resolve(json!({ "ACCESS_TOKEN": " 12345 " })).unwrap().host,
            "127.0.0.1"
        );
        assert_eq!(
            resolve(json!({ "ACCESS_TOKEN": "aaaaa\u{3000}" }))
                .unwrap()
                .host,
            "127.0.0.1"
        );
        assert_eq!(
            resolve(json!({ "ACCESS_TOKEN": "\u{feff}123456\u{feff}" }))
                .unwrap()
                .host,
            "0.0.0.0"
        );
    }

    #[test]
    fn host_precedence_and_validation_match_the_js_rules() {
        assert_eq!(
            resolve(json!({ "HOST": " 127.0.0.1 ", "MULTICC_HOST": "10.0.0.2" }))
                .unwrap()
                .host,
            "127.0.0.1"
        );
        assert_eq!(
            resolve(json!({ "HOST": "", "MULTICC_HOST": " ::1 " }))
                .unwrap()
                .host,
            "::1"
        );
        assert_eq!(
            resolve(json!({ "HOST": "localhost" })).unwrap().host,
            "localhost"
        );
        // Node's net.isIP rejects leading zeros; "LOCALHOST" is not the literal.
        assert!(resolve(json!({ "HOST": "127.0.0.01" })).is_err());
        assert!(resolve(json!({ "HOST": "LOCALHOST" })).is_err());
        assert_eq!(
            resolve(json!({ "HOST": "::ffff:1.2.3.4", "MULTICC_ALLOW_REMOTE": "1" }))
                .unwrap()
                .host,
            "::ffff:1.2.3.4"
        );
        assert_eq!(
            resolve(json!({ "HOST": "fe80::1%en0", "MULTICC_ALLOW_REMOTE": "1" }))
                .unwrap()
                .host,
            "fe80::1%en0"
        );
        assert_eq!(
            resolve(json!({ "HOST": "0.0.0.0" })).unwrap_err(),
            "Refusing non-loopback bind 0.0.0.0: set MULTICC_ALLOW_REMOTE=1 explicitly"
        );
        assert_eq!(
            resolve(json!({ "HOST": "example.com", "MULTICC_ALLOW_REMOTE": "1" })).unwrap_err(),
            "Invalid bind host: example.com"
        );
    }

    #[test]
    fn port_parsing_matches_parse_int() {
        for (raw, expected) in [
            ("3000", 3000),
            (" 3001 ", 3001),
            ("3000abc", 3000),
            ("+80", 80),
            ("07", 7),
            ("1e3", 1),
            ("1.9", 1),
        ] {
            assert_eq!(
                resolve(json!({ "PORT": raw })).unwrap().port,
                expected,
                "{raw}"
            );
        }
        for (raw, text) in [
            ("abc", "abc"),
            ("0", "0"),
            ("65536", "65536"),
            ("  ", "  "),
            ("0x10", "0x10"),
            ("-1", "-1"),
            ("Infinity", "Infinity"),
        ] {
            assert_eq!(
                resolve(json!({ "PORT": raw })).unwrap_err(),
                format!("Invalid PORT: {text}")
            );
        }
        // An absent or empty PORT falls back to 3000.
        assert_eq!(resolve(json!({ "PORT": "" })).unwrap().port, 3000);
    }

    #[test]
    fn development_is_strict_node_env_or_a_recognised_switch() {
        assert!(
            resolve(json!({ "NODE_ENV": "development" }))
                .unwrap()
                .development
        );
        assert!(
            !resolve(json!({ "NODE_ENV": "Development" }))
                .unwrap()
                .development
        );
        assert!(
            !resolve(json!({ "NODE_ENV": " development " }))
                .unwrap()
                .development
        );
        assert!(
            resolve(json!({ "MULTICC_DEV": " ON " }))
                .unwrap()
                .development
        );
        assert!(!resolve(json!({ "MULTICC_DEV": "0" })).unwrap().development);
    }

    #[test]
    fn enabled_words_and_loopback_names() {
        for value in ["1", "true", "TRUE", "yes", "On", " on \n"] {
            assert!(env_enabled(value), "{value:?}");
        }
        // Non-Unicode /i never folds a non-ASCII code point onto ASCII.
        for value in [
            "",
            "0",
            "2",
            "off",
            "no",
            "yess",
            "tru",
            "ye\u{17f}",
            "\u{212a}",
            "ON\u{17f}",
        ] {
            assert!(!env_enabled(value), "{value:?}");
        }
        // Unicode-mode /iu would accept it; JS `/i` here must not.
        assert!(!env_enabled("ye\u{17f}"));
        for value in ["127.0.0.1", "::1", "LOCALHOST", " localhost\u{feff}"] {
            assert!(is_loopback_host(value), "{value:?}");
        }
        for value in ["", "127.0.0.2", "::ffff:127.0.0.1", "localhost.example"] {
            assert!(!is_loopback_host(value), "{value:?}");
        }
    }

    #[test]
    fn ip_detection_follows_node() {
        assert_eq!(is_ip("127.0.0.1"), 4);
        assert_eq!(is_ip("0.0.0.0"), 4);
        assert_eq!(is_ip("127.0.0.01"), 0);
        assert_eq!(is_ip("256.1.1.1"), 0);
        assert_eq!(is_ip("::1"), 6);
        assert_eq!(is_ip("::"), 6);
        assert_eq!(is_ip("::ffff:1.2.3.4"), 6);
        assert_eq!(is_ip("fe80::1%en0"), 6);
        assert_eq!(is_ip("::1%"), 0);
        assert_eq!(is_ip("::g"), 0);
        assert_eq!(is_ip("localhost"), 0);
    }

    #[test]
    fn find_available_port_skips_an_occupied_port() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let start = occupied.local_addr().unwrap().port() as i64;
        let found = find_available_port(start, "127.0.0.1", 100).unwrap();
        assert_ne!(found, start as u16);
        assert!(find_available_port(start, "127.0.0.1", 1).is_err());
        assert_eq!(
            find_available_port(start, "127.0.0.1", 1).unwrap_err(),
            format!("No available port from {start} on 127.0.0.1")
        );
    }
}
