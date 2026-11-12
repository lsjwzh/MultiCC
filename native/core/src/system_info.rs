//! The retired `src/routes/system.js` rules: semver comparison, remote tag
//! selection, LAN address ranking, and the `limit` query semantics of the two
//! ring-buffer diagnostics (`scan.js` and the Codex proxy trace). Everything
//! here is a pure function of its JSON input so the gateway, the differential
//! harness and the unit tests all share one implementation.

use serde_json::{json, Map, Value};

use crate::http_gate::QueryValue;
use crate::js::number::js_string_to_number;
use crate::js::string::js_trim;

/// `String(value || '')` — the Node helpers all coerce their input that way.
fn js_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(true)) => "true".to_owned(),
        Some(Value::Bool(false)) | None | Some(Value::Null) => String::new(),
        Some(Value::Number(number)) => number.to_string(),
        // Arrays/objects never reach these helpers with meaningful content in
        // production; String([]) is '' and String({}) is '[object Object]'.
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// One `Number(segment)` of a dotted version: full `Number()` semantics
/// (trim, radix prefixes, exponents), not a digit parse.
fn number_segment(segment: &str) -> f64 {
    js_string_to_number(segment)
}

/// `compareSemver(a, b)`: three dotted numeric segments, `pa[i] || 0`, first
/// difference wins. The return value keeps the JS sign convention (negative =
/// a < b); callers only ever test the sign.
pub fn compare_semver(a: &str, b: &str) -> f64 {
    let pa: Vec<f64> = a.split('.').map(number_segment).collect();
    let pb: Vec<f64> = b.split('.').map(number_segment).collect();
    for index in 0..3 {
        // `NaN || 0` is 0; so is a missing segment.
        let na = pa.get(index).copied().unwrap_or(0.0);
        let na = if na.is_nan() { 0.0 } else { na };
        let nb = pb.get(index).copied().unwrap_or(0.0);
        let nb = if nb.is_nan() { 0.0 } else { nb };
        if na != nb {
            return na - nb;
        }
    }
    0.0
}

/// One `line.match(/refs\/tags\/(v\d+\.\d+\.\d+)/)` without the global flag:
/// the first occurrence on the line, captured tag only.
fn first_tag_on_line(line: &str) -> Option<String> {
    let mut rest = line;
    while let Some(at) = rest.find("refs/tags/") {
        let after = &rest[at + "refs/tags/".len()..];
        let parsed = parse_version_tag(after);
        if let Some((tag, _)) = parsed {
            return Some(tag);
        }
        // Advance one full character: a partial UTF-8 slice would panic.
        let skip = after.chars().next().map(char::len_utf8).unwrap_or(0);
        rest = &after[skip..];
    }
    None
}

/// `v\d+\.\d+\.\d+` anchored at the start of `text`.
fn parse_version_tag(text: &str) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    if bytes.first() != Some(&b'v') {
        return None;
    }
    let mut index = 1;
    let mut dots = 0;
    let mut digits = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'0'..=b'9' => {
                digits += 1;
                index += 1;
            }
            b'.' if digits > 0 && dots < 2 => {
                dots += 1;
                digits = 0;
                index += 1;
            }
            _ => break,
        }
    }
    if dots == 2 && digits > 0 {
        Some((text[..index].to_owned(), index))
    } else {
        None
    }
}

/// `latestTagFromRemote(output)`: first tag per line, first-seen dedup, stable
/// semver ascending, last one wins.
pub fn latest_tag_from_remote(output: &str) -> Option<String> {
    let mut tags: Vec<String> = Vec::new();
    for line in output.split('\n') {
        // `.filter(Boolean)`: empty lines carry no tag anyway.
        if line.is_empty() {
            continue;
        }
        if let Some(tag) = first_tag_on_line(line) {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    tags.sort_by(|a, b| {
        let ordering = compare_semver(
            a.strip_prefix('v').unwrap_or(a),
            b.strip_prefix('v').unwrap_or(b),
        );
        if ordering < 0.0 {
            std::cmp::Ordering::Less
        } else if ordering > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    tags.pop()
}

/// `ipv4Priority(address)`: private/LAN ranges rank above routable space;
/// anything unparsable or unroutable ranks below the "no answer" floor.
pub fn ipv4_priority(address: &str) -> i64 {
    let parts: Vec<f64> = address.split('.').map(number_segment).collect();
    let integer = |value: f64| value.fract() == 0.0 && value.is_finite();
    if parts.len() != 4
        || parts
            .iter()
            .any(|part| !integer(*part) || *part < 0.0 || *part > 255.0)
    {
        return -1;
    }
    let a = parts[0] as i64;
    let b = parts[1] as i64;
    if a == 0 || a == 127 || a >= 224 || (a == 169 && b == 254) {
        return -1;
    }
    if a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) {
        return 300;
    }
    if a == 100 && (64..=127).contains(&b) {
        return 100;
    }
    0
}

/// `VIRTUAL_INTERFACE` — every alternative reduces to a case-insensitive
/// prefix because none of them anchors the tail (`\d*` accepts zero digits).
fn is_virtual_interface(name: &str) -> bool {
    let lower = name.to_lowercase();
    for prefix in [
        "lo",
        "utun",
        "tun",
        "tap",
        "tailscale",
        "docker",
        "br-",
        "veth",
        "vmnet",
        "virbr",
        "vethernet",
        "awdl",
        "llw",
        "bridge",
        "wg",
        "zt",
    ] {
        if lower.starts_with(prefix) {
            return true;
        }
    }
    false
}

/// `PREFERRED_INTERFACE`: `en\d+` needs at least one digit; the rest are plain
/// prefixes (`wi-?fi` is exactly "wifi" or "wi-fi").
fn is_preferred_interface(name: &str) -> bool {
    let lower = name.to_lowercase();
    if let Some(rest) = lower.strip_prefix("en") {
        if !rest.is_empty() && rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    for prefix in [
        "eth", "enp", "eno", "ens", "wlan", "wlp", "wifi", "wi-fi", "ethernet",
    ] {
        if lower.starts_with(prefix) {
            return true;
        }
    }
    false
}

/// `net.isIP(host) === 4`: dotted quads, 1-3 digits each, no leading zeros
/// beyond a bare "0".
fn is_ipv4_literal(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|part| {
        !part.is_empty()
            && part.len() <= 3
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && (part.len() == 1 || !part.starts_with('0'))
            && part.parse::<u32>().is_ok_and(|value| value <= 255)
    })
}

/// `selectLanAddresses(os.networkInterfaces())`: skip virtual interfaces, rank
/// private ranges, stable order, dedup first-wins.
pub fn select_lan_addresses(interfaces: &Value) -> Vec<String> {
    let Some(map) = interfaces.as_object() else {
        return Vec::new();
    };
    let mut candidates: Vec<(String, i64, usize)> = Vec::new();
    let mut order = 0usize;
    for (name, entries) in map {
        if is_virtual_interface(name) {
            continue;
        }
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for entry in entries {
            let family = entry.get("family");
            let ipv4 = matches!(family, Some(Value::String(text)) if text == "IPv4")
                || matches!(family, Some(Value::Number(number)) if number.as_f64() == Some(4.0));
            let internal = entry
                .get("internal")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !ipv4 || internal {
                continue;
            }
            let address = entry
                .get("address")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let priority = ipv4_priority(address);
            if priority <= 0 {
                continue;
            }
            let boost = if is_preferred_interface(name) { 50 } else { 0 };
            candidates.push((address.to_owned(), priority + boost, order));
            order += 1;
        }
    }
    candidates.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then(left.2.cmp(&right.2))
            .then(left.0.cmp(&right.0))
    });
    let mut seen: Vec<String> = Vec::new();
    for (address, _, _) in candidates {
        if !seen.contains(&address) {
            seen.push(address);
        }
    }
    seen
}

/// `reachableLanAddresses(interfaces, bindHost)`.
pub fn reachable_lan_addresses(interfaces: &Value, bind_host: Option<&Value>) -> Vec<String> {
    let host = js_trim(&match bind_host {
        Some(value) => js_string(Some(value)),
        None => "0.0.0.0".to_owned(),
    })
    .to_lowercase();
    if host == "localhost" || host == "::1" || host.starts_with("127.") {
        return Vec::new();
    }
    if is_ipv4_literal(&host) && host != "0.0.0.0" {
        return if ipv4_priority(&host) >= 0 {
            vec![host]
        } else {
            Vec::new()
        };
    }
    select_lan_addresses(interfaces)
}

/// `GET /api/server-info`: facts are Node's (interfaces, bind host, port, the
/// process's own uptime); the ranking and the response shape are this
/// function. Field order is the retired handler's literal key order.
pub fn server_info(facts: &Value) -> Value {
    let interfaces = facts.get("interfaces").cloned().unwrap_or(Value::Null);
    let bind_host = facts.get("bindHost").cloned().unwrap_or(Value::Null);
    let lan = reachable_lan_addresses(&interfaces, Some(&bind_host));
    let ip = lan
        .first()
        .cloned()
        .unwrap_or_else(|| "127.0.0.1".to_owned());
    let port = facts.get("port").cloned().unwrap_or(Value::Null);
    let port_text = match &port {
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        _ => "null".to_owned(),
    };
    let mut body = Map::new();
    body.insert("product".to_owned(), Value::String("multicc".to_owned()));
    body.insert("appProtocolVersion".to_owned(), Value::from(1));
    // `...(serverVersion ? { version } : {})`: a missing or empty version
    // omits the key entirely.
    if let Some(version) = facts.get("version").and_then(Value::as_str) {
        if !version.is_empty() {
            body.insert("version".to_owned(), Value::String(version.to_owned()));
        }
    }
    body.insert("ip".to_owned(), Value::String(ip.clone()));
    body.insert("port".to_owned(), port);
    body.insert("proto".to_owned(), Value::String("http".to_owned()));
    body.insert(
        "url".to_owned(),
        Value::String(format!("http://{ip}:{port_text}")),
    );
    body.insert(
        "bindHost".to_owned(),
        if bind_host.is_null() {
            Value::String("0.0.0.0".to_owned())
        } else {
            bind_host
        },
    );
    body.insert("lanAvailable".to_owned(), Value::Bool(!lan.is_empty()));
    body.insert(
        "lanAddresses".to_owned(),
        Value::Array(lan.iter().map(|item| Value::String(item.clone())).collect()),
    );
    body.insert(
        "lanUrls".to_owned(),
        Value::Array(
            lan.iter()
                .map(|item| Value::String(format!("http://{item}:{port_text}")))
                .collect(),
        ),
    );
    body.insert(
        "authRequired".to_owned(),
        Value::Bool(
            facts
                .get("authRequired")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    body.insert(
        "startedAt".to_owned(),
        facts.get("startedAt").cloned().unwrap_or(Value::Null),
    );
    body.insert(
        "uptimeMs".to_owned(),
        facts.get("uptimeMs").cloned().unwrap_or(Value::Null),
    );
    Value::Object(body)
}

/// `resolveVersionInfo` minus its I/O: the local metadata and the discovered
/// tag come in, the DTO comes out.
pub fn version_check(input: &Value) -> Value {
    let current = input
        .get("current")
        .and_then(Value::as_str)
        .unwrap_or("0.0.0");
    let channel = input
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("dev");
    let latest = input.get("latest").and_then(Value::as_str);
    let api_error = input
        .get("apiError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let latest_version = latest.map(|tag| tag.strip_prefix('v').unwrap_or(tag));
    json!({
        "current": current,
        "channel": channel,
        "latest": latest,
        "latestVersion": latest_version,
        "updateAvailable": latest_version
            .is_some_and(|version| compare_semver(current, version) < 0.0),
        "apiError": api_error,
    })
}

/// `String(queryValue)` for the two ring-buffer routes: qs gives a string, an
/// array (joined on ","), an object, or nothing.
fn query_to_string(value: &QueryValue) -> String {
    match value {
        QueryValue::Missing => "undefined".to_owned(),
        QueryValue::Text(text) => text.clone(),
        QueryValue::List(items) => items
            .iter()
            .map(query_to_string)
            .collect::<Vec<_>>()
            .join(","),
        QueryValue::Object => "[object Object]".to_owned(),
    }
}

/// `parseInt(text, 10)`: left-trimmed, optional sign, then the longest run of
/// ASCII digits; anything else is NaN.
fn js_parse_int_10(text: &str) -> f64 {
    let trimmed = text.trim_start_matches(|c: char| c.is_whitespace());
    let (sign, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1.0, &trimmed[1..]),
        Some(b'+') => (1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    let end = digits
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return f64::NAN;
    }
    digits[..end]
        .parse::<f64>()
        .map(|value| sign * value)
        .unwrap_or(f64::NAN)
}

/// `Math.min(parseInt(req.query.limit, 10) || 20, maxPasses)` — the cap itself
/// stays on the Node side, which owns the ring and its `maxPasses` constant;
/// this is the parse-and-default half. `parseInt` of a very long digit run is
/// Infinity in JS; JSON cannot carry that, so it is clamped to ±f64::MAX,
/// which the host's `Math.min` and `slice(0, …)` read identically.
pub fn scan_history_limit(query: &QueryValue) -> f64 {
    let parsed = js_parse_int_10(&query_to_string(query));
    let parsed = if parsed.is_nan() || parsed == 0.0 {
        20.0
    } else {
        parsed
    };
    if parsed.is_infinite() {
        parsed.signum() * f64::MAX
    } else {
        parsed
    }
}

/// `Number(req.query.limit)` then `Number.isInteger(r) && r > 0 ? min(r, 200) : 100`.
pub fn proxy_trace_limit(query: &QueryValue) -> u64 {
    let number = match query {
        QueryValue::Missing | QueryValue::Object => f64::NAN,
        other => js_string_to_number(&query_to_string(other)),
    };
    if number.is_finite() && number.fract() == 0.0 && number > 0.0 {
        number.min(200.0) as u64
    } else {
        100
    }
}

/// The JS `\s` set (White_Space plus the zero-width no-break space).
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `/^# channel:\s*(\S+)/m` on the `.multicc_channel` sidecar: the anchor is
/// any line start (after \n, \r,   or  ), and `\s*` may eat the line
/// break itself, so the value can come from the next line.
pub fn channel_from_sidecar(content: &str) -> Option<String> {
    let mut start = 0usize;
    loop {
        let rest = &content[start..];
        if let Some(after) = rest.strip_prefix("# channel:") {
            let trimmed = after.trim_start_matches(is_js_whitespace);
            let capture: String = trimmed
                .chars()
                .take_while(|c| !is_js_whitespace(*c))
                .collect();
            if !capture.is_empty() {
                return Some(capture);
            }
        }
        let next = rest.find(['\n', '\r', '\u{2028}', '\u{2029}'])?;
        start += next + rest[next..].chars().next().map(char::len_utf8)?;
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `readInstallMetadata`: package.json parse failure is the caller's cue to
/// answer the frozen default DTO; a missing sidecar only means `dev`.
pub fn install_metadata(
    package_json: &str,
    channel_sidecar: Option<&str>,
) -> Option<(String, String)> {
    let pkg: Value = serde_json::from_str(package_json).ok()?;
    let version = match pkg.get("version") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(value) if js_truthy(value) => js_string(Some(value)),
        _ => "0.0.0".to_owned(),
    };
    let channel = channel_sidecar
        .and_then(channel_from_sidecar)
        .unwrap_or_else(|| "dev".to_owned());
    Some((version, channel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compares_three_numeric_segments() {
        assert!(compare_semver("1.2.3", "1.2.10") < 0.0);
        assert!(compare_semver("2.0.0", "1.9.9") > 0.0);
        assert_eq!(compare_semver("1.2", "1.2.0"), 0.0);
        // `Number('')` is 0 and `NaN || 0` is 0.
        assert_eq!(compare_semver("", "0.0.0"), 0.0);
        assert_eq!(compare_semver("1..2", "1.0.2"), 0.0);
        assert_eq!(compare_semver("abc", "0.0.0"), 0.0);
        // Radix prefixes and exponents are `Number()`, not digit parsing.
        assert_eq!(compare_semver("0x10.0.0", "16.0.0"), 0.0);
        assert_eq!(compare_semver("1e1.0.0", "10.0.0"), 0.0);
    }

    #[test]
    fn latest_tag_picks_the_semver_max() {
        let output =
            "deadbeef\trefs/tags/v1.9.0\nbeef\trefs/tags/v1.10.0\ncafe\trefs/tags/v1.9.1\n";
        assert_eq!(latest_tag_from_remote(output).as_deref(), Some("v1.10.0"));
        // Dedup keeps the first occurrence; ties keep a stable order.
        let dup = "a\trefs/tags/v1.0.0\nb\trefs/tags/v1.0.0\n";
        assert_eq!(latest_tag_from_remote(dup).as_deref(), Some("v1.0.0"));
        assert_eq!(latest_tag_from_remote(""), None);
        assert_eq!(latest_tag_from_remote("no tags here\n"), None);
        // Non-semver tags are ignored; a tag later in the line still matches.
        let mixed = "x\trefs/tags/nightly\ny\tsee refs/tags/v2.0.1 too\n";
        assert_eq!(latest_tag_from_remote(mixed).as_deref(), Some("v2.0.1"));
    }

    #[test]
    fn ipv4_priority_ranks_lan_ranges() {
        assert_eq!(ipv4_priority("10.0.0.2"), 300);
        assert_eq!(ipv4_priority("192.168.1.5"), 300);
        assert_eq!(ipv4_priority("172.16.0.1"), 300);
        assert_eq!(ipv4_priority("172.15.0.1"), 0);
        assert_eq!(ipv4_priority("172.32.0.1"), 0);
        assert_eq!(ipv4_priority("100.64.0.1"), 100);
        assert_eq!(ipv4_priority("100.63.0.1"), 0);
        assert_eq!(ipv4_priority("127.0.0.1"), -1);
        assert_eq!(ipv4_priority("169.254.1.1"), -1);
        assert_eq!(ipv4_priority("224.0.0.1"), -1);
        assert_eq!(ipv4_priority("0.0.0.0"), -1);
        assert_eq!(ipv4_priority("8.8.8.8"), 0);
        // `Number('')` is 0, so a trailing dot still parses.
        assert_eq!(ipv4_priority("10.0.0."), 300);
        assert_eq!(ipv4_priority("1.2.3.4.5"), -1);
        assert_eq!(ipv4_priority("10.0.0.256"), -1);
        assert_eq!(ipv4_priority("junk"), -1);
    }

    #[test]
    fn interface_prefixes_match_the_regex_semantics() {
        assert!(is_virtual_interface("lo0"));
        assert!(is_virtual_interface("utun3"));
        assert!(is_virtual_interface("Tailscale0"));
        assert!(is_virtual_interface("vEthernet (WSL)"));
        assert!(is_virtual_interface("zt0"));
        // "loop" matches `lo\d*` because the regex never anchors the tail.
        assert!(is_virtual_interface("loopback-ish"));
        assert!(!is_virtual_interface("en0"));
        assert!(!is_virtual_interface("llbean"));
        assert!(is_preferred_interface("en0"));
        assert!(is_preferred_interface("Ethernet"));
        assert!(is_preferred_interface("Wi-Fi"));
        assert!(is_preferred_interface("wlp2s0"));
        assert!(is_preferred_interface("enp3s0"));
        assert!(!is_preferred_interface("enx0"));
    }

    #[test]
    fn ipv4_literal_rejects_leading_zeros_like_node() {
        assert!(is_ipv4_literal("0.0.0.0"));
        assert!(is_ipv4_literal("192.168.0.1"));
        assert!(!is_ipv4_literal("01.2.3.4"));
        assert!(!is_ipv4_literal("1.2.3.04"));
        assert!(!is_ipv4_literal("1.2.3"));
        assert!(!is_ipv4_literal("1.2.3.256"));
        assert!(!is_ipv4_literal("::1"));
    }

    #[test]
    fn lan_addresses_rank_dedup_and_skip_virtual() {
        let interfaces = json!({
            "lo0": [{ "address": "127.0.0.1", "family": "IPv4", "internal": true }],
            "utun9": [{ "address": "10.99.0.1", "family": "IPv4", "internal": false }],
            "en0": [
                { "address": "192.168.1.20", "family": "IPv4", "internal": false },
                { "address": "10.0.0.5", "family": "IPv4", "internal": false }
            ],
            "en1": [{ "address": "192.168.1.21", "family": "IPv4", "internal": false }],
            "rndis": [{ "address": "192.168.7.1", "family": "IPv4", "internal": false }]
        });
        // en0's pair outranks en1's single entry (preferred boost); utun and
        // lo0 drop out entirely; the tie inside en0 keeps interface order.
        assert_eq!(
            select_lan_addresses(&interfaces),
            vec!["192.168.1.20", "10.0.0.5", "192.168.1.21", "192.168.7.1"]
        );
        assert_eq!(select_lan_addresses(&Value::Null), Vec::<String>::new());
    }

    #[test]
    fn reachable_addresses_respect_bind_host() {
        let interfaces = json!({
            "en0": [{ "address": "192.168.1.20", "family": "IPv4", "internal": false }]
        });
        assert!(reachable_lan_addresses(&interfaces, Some(&json!("127.0.0.1"))).is_empty());
        assert!(reachable_lan_addresses(&interfaces, Some(&json!("localhost"))).is_empty());
        assert!(reachable_lan_addresses(&interfaces, Some(&json!("::1"))).is_empty());
        assert_eq!(
            reachable_lan_addresses(&interfaces, Some(&json!("192.168.1.9"))),
            vec!["192.168.1.9"]
        );
        assert!(reachable_lan_addresses(&interfaces, Some(&json!("0.0.0.0"))).len() == 1);
        // A bind address outside the routable set yields nothing.
        assert!(reachable_lan_addresses(&interfaces, Some(&json!("169.254.0.1"))).is_empty());
    }

    #[test]
    fn server_info_keeps_the_legacy_key_order_and_omissions() {
        let facts = json!({
            "interfaces": {
                "en0": [{ "address": "192.168.1.20", "family": "IPv4", "internal": false }]
            },
            "bindHost": "0.0.0.0",
            "port": 45123,
            "authRequired": true,
            "version": "2.20.1",
            "startedAt": "2026-11-11T00:00:00.000Z",
            "uptimeMs": 60000
        });
        let body = server_info(&facts);
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "product",
                "appProtocolVersion",
                "version",
                "ip",
                "port",
                "proto",
                "url",
                "bindHost",
                "lanAvailable",
                "lanAddresses",
                "lanUrls",
                "authRequired",
                "startedAt",
                "uptimeMs"
            ]
        );
        assert_eq!(body["ip"], "192.168.1.20");
        assert_eq!(body["url"], "http://192.168.1.20:45123");
        assert_eq!(body["lanUrls"], json!(["http://192.168.1.20:45123"]));
        // An empty version omits the key entirely.
        let without = server_info(&json!({
            "interfaces": {}, "bindHost": "127.0.0.1", "port": 1, "authRequired": false,
            "version": "", "startedAt": null, "uptimeMs": 0
        }));
        assert!(without.get("version").is_none());
        assert_eq!(without["ip"], "127.0.0.1");
        assert_eq!(without["lanAvailable"], false);
    }

    #[test]
    fn version_check_assembles_the_dto() {
        let body = version_check(&json!({
            "current": "2.20.0", "channel": "release", "latest": "v2.21.0", "apiError": false
        }));
        assert_eq!(body["latestVersion"], "2.21.0");
        assert_eq!(body["updateAvailable"], true);
        assert_eq!(body["apiError"], false);
        let fresh = version_check(&json!({
            "current": "2.21.0", "channel": "dev", "latest": "v2.21.0", "apiError": false
        }));
        assert_eq!(fresh["updateAvailable"], false);
        let failed = version_check(&json!({
            "current": "2.20.0", "channel": "dev", "latest": null, "apiError": true
        }));
        assert_eq!(failed["latest"], Value::Null);
        assert_eq!(failed["latestVersion"], Value::Null);
        assert_eq!(failed["updateAvailable"], false);
        assert_eq!(failed["apiError"], true);
    }

    #[test]
    fn scan_limit_matches_parseint_or_default() {
        assert_eq!(scan_history_limit(&QueryValue::Missing), 20.0);
        assert_eq!(scan_history_limit(&QueryValue::Text("7".into())), 7.0);
        assert_eq!(scan_history_limit(&QueryValue::Text("7abc".into())), 7.0);
        assert_eq!(scan_history_limit(&QueryValue::Text("abc".into())), 20.0);
        assert_eq!(scan_history_limit(&QueryValue::Text("".into())), 20.0);
        assert_eq!(scan_history_limit(&QueryValue::Text("0".into())), 20.0);
        assert_eq!(scan_history_limit(&QueryValue::Text("-5".into())), -5.0);
        assert_eq!(scan_history_limit(&QueryValue::Text(" 12 ".into())), 12.0);
        // parseInt("0x10", 10) stops at 'x' → 0 → `0 || 20` → 20.
        assert_eq!(scan_history_limit(&QueryValue::Text("0x10".into())), 20.0);
        assert_eq!(
            scan_history_limit(&QueryValue::List(vec![QueryValue::Text("5".into())])),
            5.0
        );
        assert_eq!(
            scan_history_limit(&QueryValue::List(vec![
                QueryValue::Text("5".into()),
                QueryValue::Text("6".into())
            ])),
            5.0
        );
        assert_eq!(scan_history_limit(&QueryValue::Object), 20.0);
        // parseInt of a 400-digit run is Infinity; the wire-safe clamp must
        // still rank above any host-side maxPasses.
        assert_eq!(
            scan_history_limit(&QueryValue::Text("9".repeat(400))),
            f64::MAX
        );
        assert_eq!(
            scan_history_limit(&QueryValue::Text(format!("-{}", "9".repeat(400)))),
            -f64::MAX
        );
    }

    #[test]
    fn channel_sidecar_matches_the_multiline_regex() {
        assert_eq!(
            channel_from_sidecar("# channel: stable\n"),
            Some("stable".into())
        );
        assert_eq!(
            channel_from_sidecar("# channel:beta\n"),
            Some("beta".into())
        );
        // `\s*` eats the line break, so the value may live on the next line.
        assert_eq!(
            channel_from_sidecar("# channel:\nfoo\n"),
            Some("foo".into())
        );
        // The anchor is a line start: leading indentation does not match.
        assert_eq!(channel_from_sidecar("  # channel: x\n"), None);
        // `\S+` stops at the first whitespace.
        assert_eq!(channel_from_sidecar("# channel: a b\n"), Some("a".into()));
        assert_eq!(channel_from_sidecar("# channel:   \n"), None);
        assert_eq!(channel_from_sidecar(""), None);
        assert_eq!(
            channel_from_sidecar("# channel:\r\nnext\r"),
            Some("next".into())
        );
    }

    #[test]
    fn install_metadata_reads_version_and_channel() {
        assert_eq!(
            install_metadata(r#"{"version":"1.4.0"}"#, Some("# channel: stable\n")),
            Some(("1.4.0".to_owned(), "stable".to_owned()))
        );
        assert_eq!(
            install_metadata(r#"{"version":"1.4.0"}"#, None),
            Some(("1.4.0".to_owned(), "dev".to_owned()))
        );
        // `pkg.version || '0.0.0'`.
        assert_eq!(
            install_metadata(r#"{"name":"x"}"#, None),
            Some(("0.0.0".to_owned(), "dev".to_owned()))
        );
        assert_eq!(
            install_metadata(r#"{"version":""}"#, None),
            Some(("0.0.0".to_owned(), "dev".to_owned()))
        );
        // A malformed package.json is the DEFAULT_VERSION_RESULT path.
        assert_eq!(install_metadata("{oops", None), None);
    }

    #[test]
    fn trace_limit_matches_number_isinteger_gate() {
        assert_eq!(proxy_trace_limit(&QueryValue::Missing), 100);
        assert_eq!(proxy_trace_limit(&QueryValue::Text("5".into())), 5);
        assert_eq!(proxy_trace_limit(&QueryValue::Text(" 5 ".into())), 5);
        // Number('') is 0 — not a positive integer.
        assert_eq!(proxy_trace_limit(&QueryValue::Text("".into())), 100);
        assert_eq!(proxy_trace_limit(&QueryValue::Text("5.9".into())), 100);
        assert_eq!(proxy_trace_limit(&QueryValue::Text("1e3".into())), 200);
        assert_eq!(proxy_trace_limit(&QueryValue::Text("0x10".into())), 16);
        assert_eq!(proxy_trace_limit(&QueryValue::Text("Infinity".into())), 100);
        assert_eq!(proxy_trace_limit(&QueryValue::Text("-3".into())), 100);
        assert_eq!(
            proxy_trace_limit(&QueryValue::List(vec![QueryValue::Text("5".into())])),
            5
        );
        assert_eq!(
            proxy_trace_limit(&QueryValue::List(vec![
                QueryValue::Text("5".into()),
                QueryValue::Text("6".into())
            ])),
            100
        );
        assert_eq!(proxy_trace_limit(&QueryValue::Object), 100);
    }
}
