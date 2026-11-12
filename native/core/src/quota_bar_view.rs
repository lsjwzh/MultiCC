//! Canonical quota presentation. Native values retain missing fields and UTF-16.
use crate::js::{self, JsString, JsValue as V};
use std::sync::OnceLock;
mod claude;
#[cfg(test)]
mod tests;
mod vendors;
const GRAY: &str = "#8b949e";
const RED: &str = "#f85149";
const YELLOW: &str = "#d29922";
const BLUE: &str = "#58a6ff";
macro_rules! obj { ($($k:expr => $v:expr),* $(,)?) => { V::object(vec![$(($k, V::from($v))),*]) }; }
pub(super) use obj;
fn get<'a>(v: &'a V, k: &str) -> &'a V {
    v.get(k).unwrap_or(&V::Undefined)
}
fn field(v: &V, k: &str) -> V {
    get(v, k).clone()
}
fn string(v: &V) -> String {
    js::js_to_string(v).to_string_lossy()
}
fn strict_text(v: &V, k: &str) -> String {
    match get(v, k) {
        V::String(s) => s.to_string_lossy(),
        _ => String::new(),
    }
}
fn known_window(value: &V) -> bool {
    matches!(value, V::String(window) if window == "5h" || window == "1wk" || window == "1m")
}
fn text(v: &V, k: &str) -> String {
    string(get(v, k))
}
fn or(v: &V, fallback: &V) -> V {
    if js::truthy(v) {
        v.clone()
    } else {
        fallback.clone()
    }
}
fn empty(v: &V) -> String {
    string(&or(v, &V::from("")))
}
fn array(v: &V) -> &[V] {
    if let V::Array(a) = v {
        a
    } else {
        &[]
    }
}
fn is_array(v: &V) -> bool {
    matches!(v, V::Array(_))
}
fn is_object(v: &V) -> bool {
    matches!(v, V::Object(_) | V::Array(_))
}
fn finite(v: &V) -> Option<f64> {
    if matches!(v, V::Null | V::Bool(_)) || v == &V::from("") {
        return None;
    }
    let n = js::js_to_number(v);
    n.is_finite().then_some(n)
}
fn exact_number(v: &V) -> bool {
    matches!(v,V::Number(n) if n.is_finite())
}
fn num(v: Option<f64>) -> V {
    v.map(V::Number).unwrap_or(V::Null)
}
fn round(n: f64) -> f64 {
    (n + 0.5).floor()
}
fn remain(v: &V) -> Option<f64> {
    finite(v).map(|n| round(100.0 - n).clamp(0.0, 100.0))
}
fn color(rem: Option<f64>) -> &'static str {
    match rem {
        Some(n) if n <= 10.0 => RED,
        Some(n) if n <= 30.0 => YELLOW,
        _ => BLUE,
    }
}
fn fixed2(n: f64) -> String {
    // JS toFixed rounds the exact binary value, ties away from zero.
    if !n.is_finite() || n.abs() >= 1e21 {
        return js::number_to_string(n);
    }
    let a = n.abs();
    let bits = a.to_bits();
    let exp = ((bits >> 52) & 2047) as i32 - 1023 - 52;
    let mant = (bits & ((1u64 << 52) - 1))
        | if a == 0.0 || ((bits >> 52) & 2047) == 0 {
            0
        } else {
            1u64 << 52
        };
    let scaled = (mant as u128) * 100;
    let q = if exp >= 0 {
        scaled.checked_shl(exp as u32).unwrap_or(u128::MAX)
    } else {
        let shift = (-exp) as u32;
        if shift >= 128 {
            0
        } else {
            let half = 1u128 << (shift - 1);
            (scaled + half) >> shift
        }
    };
    format!(
        "{}{qint}.{frac:02}",
        if n < 0.0 { "-" } else { "" },
        qint = q / 100,
        frac = q % 100
    )
}
fn fmt(v: &V) -> V {
    let n = js::js_to_number(v);
    if n.is_finite() {
        V::from(js::number_to_string(js::js_string_to_number(&fixed2(n))))
    } else if v.is_nullish() {
        V::from("")
    } else {
        V::String(js::js_to_string(v))
    }
}
fn balance_text(v: &V, currency: &V) -> String {
    finite(v)
        .map(|n| {
            format!(
                "{}{}",
                if currency == &V::from("USD") {
                    "$"
                } else if currency == &V::from("CNY") {
                    "¥"
                } else {
                    ""
                },
                fixed2(n)
            )
        })
        .unwrap_or_default()
}
fn reset(v: &V) -> V {
    num(finite(v).filter(|n| *n > 0.0).map(|n| {
        if n < 1e10 {
            (n * 1000.0).trunc()
        } else {
            n.trunc()
        }
    }))
}
fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}
fn default_time(v: &V) -> f64 {
    if matches!(v, V::Undefined) {
        now()
    } else {
        js::js_to_number(v)
    }
}
fn time(v: &V) -> f64 {
    finite(v).unwrap_or_else(now)
}
#[derive(Clone)]
struct Reading {
    used: V,
    estimated: bool,
}
fn reading(used: &V, at: &V, measured: &V, now: f64) -> Reading {
    let u = finite(used);
    let estimated =
        matches!((u,finite(at),finite(measured)),(Some(_),Some(a),Some(m)) if !(a<=m || a>now));
    Reading {
        used: if estimated { V::Number(0.0) } else { num(u) },
        estimated,
    }
}
fn pct(v: &V, estimated: bool) -> V {
    concat(&[V::from(if estimated { "~" } else { "" }), v.clone()])
}
fn token(label: &V) -> Option<String> {
    let s = empty(label);
    let s = js::js_trim(&s).split('-').next().unwrap_or("");
    ["5h", "1wk", "1m"].contains(&s).then(|| s.to_string())
}
fn rank(label: &V) -> usize {
    match empty(label).split('-').next().unwrap_or("") {
        "5h" => 0,
        "1wk" => 1,
        "1m" => 2,
        _ => 3,
    }
}
fn cd(at: &V, label: &V) -> String {
    finite(at)
        .filter(|n| *n > 0.0)
        .map(|n| {
            format!(
                "{{cd:{}{}}}",
                js::number_to_string(n.trunc()),
                token(label).map(|s| format!("|{s}")).unwrap_or_default()
            )
        })
        .unwrap_or_default()
}
fn ago(at: &V) -> String {
    finite(at)
        .filter(|n| *n > 0.0)
        .map(|n| format!("{{ago:{}}}", js::number_to_string(n.trunc())))
        .unwrap_or_default()
}
fn seg_value(label: &V, r: &Reading, at: &V) -> V {
    remain(&r.used)
        .map(|n| {
            let t = cd(at, label);
            concat(&[
                label.clone(),
                V::from(" "),
                pct(&V::Number(n), r.estimated),
                V::from("%"),
                V::from(if t.is_empty() {
                    String::new()
                } else {
                    format!(" {t}")
                }),
            ])
        })
        .unwrap_or_else(|| V::from(""))
}
fn seg(label: &V, r: &Reading, at: &V) -> String {
    string(&seg_value(label, r, at))
}
fn join_values(values: impl IntoIterator<Item = V>, sep: &str) -> V {
    let values: Vec<_> = values.into_iter().filter(js::truthy).map(piece).collect();
    joined(&values, sep)
}
fn concat(values: &[V]) -> V {
    let mut units = Vec::new();
    for v in values {
        units.extend_from_slice(js::js_to_string(v).as_units());
    }
    V::String(JsString::from_units(units))
}
fn piece(s: impl Into<V>) -> V {
    V::object(vec![("s", s.into())])
}
fn piece_j(s: impl Into<V>, j: &str) -> V {
    V::object(vec![("s", s.into()), ("j", V::from(j))])
}
fn rendered(v: &V, name: &str) -> V {
    if v.is_nullish()
        && [
            "reset", "from", "limited", "weekly", "voucher", "cash", "current",
        ]
        .contains(&name)
    {
        V::from("")
    } else if let Some(s) = v.get("s") {
        s.clone()
    } else {
        v.clone()
    }
}
fn part(key: &str, params: Option<V>) -> V {
    static MESSAGES: OnceLock<serde_json::Value> = OnceLock::new();
    let messages = MESSAGES.get_or_init(|| {
        serde_json::from_str(include_str!("quota_bar_view/messages.json"))
            .expect("quota message catalog")
    });
    let template = messages[key].as_str().unwrap_or(key);
    let mut out = Vec::new();
    let mut tail = template;
    while let Some(start) = tail.find('{') {
        let Some(end) = tail[start..].find('}').map(|n| n + start) else {
            break;
        };
        out.push(V::from(&tail[..start]));
        let name = &tail[start + 1..end];
        out.push(
            params
                .as_ref()
                .map(|p| rendered(get(p, name), name))
                .unwrap_or_else(|| V::from("")),
        );
        tail = &tail[end + 1..];
    }
    out.push(V::from(tail));
    let mut p = obj!("s"=>concat(&out),"k"=>key);
    if let Some(params) = params {
        set(&mut p, "p", params);
    }
    p
}
fn p(key: &str) -> V {
    part(key, None)
}
fn set(v: &mut V, k: &str, x: V) {
    if let V::Object(a) = v {
        if let Some((_, v)) = a.iter_mut().find(|(key, _)| key == k) {
            *v = x
        } else {
            a.push((JsString::from_rust_str(k), x));
        }
    }
}
fn joined(parts: &[V], sep: &str) -> V {
    let mut values = Vec::new();
    for (i, p) in parts.iter().filter(|p| js::truthy(p)).enumerate() {
        if i > 0 {
            values.push(p.get("j").cloned().unwrap_or_else(|| V::from(sep)));
        }
        values.push(field(p, "s"));
    }
    concat(&values)
}
fn view(text: Vec<V>, color: &str, title: Vec<V>, action: V) -> V {
    let text: Vec<_> = text.into_iter().filter(js::truthy).collect();
    let title: Vec<_> = title.into_iter().filter(js::truthy).collect();
    obj!("text"=>joined(&text," · "),"color"=>color,"title"=>joined(&title,"\n"),"action"=>or(&action,&V::Null),"textParts"=>V::Array(text),"titleParts"=>V::Array(title))
}
fn simple(text: &str, color: &str, title: &str, action: &str) -> V {
    view(
        vec![p(text)],
        color,
        vec![p(title)],
        if action.is_empty() {
            V::Null
        } else {
            V::from(action)
        },
    )
}
fn unavailable(value: &V, prefix: &str, title: &str) -> V {
    view(
        vec![p(&format!("quota{prefix}UnavailableText"))],
        YELLOW,
        vec![if js::truthy(get(value, "error")) {
            piece(field(value, "error"))
        } else {
            p(title)
        }],
        V::Null,
    )
}
fn sync(at: &V) -> V {
    let a = ago(at);
    if a.is_empty() {
        V::Null
    } else {
        part("quotaSyncAt", Some(obj!("ago"=>a)))
    }
}
fn refresh() -> V {
    p("quotaClickBarRefresh")
}
fn estimated() -> V {
    p("quotaEstimatedNote")
}
fn tail(text: impl Into<V>, at: &V) -> Vec<V> {
    let mut out = vec![piece(text)];
    let a = ago(at);
    if !a.is_empty() {
        out.push(piece_j(a, " · "));
    }
    out.push(piece_j("⟳", " "));
    out
}
fn window_name(window: &V) -> V {
    match string(window).as_str() {
        "5h" => p("quotaWindowName5h"),
        "1wk" => p("quotaWindowNameWeekly"),
        "1m" => p("quotaWindowNameMonthly"),
        _ => V::Undefined,
    }
}
fn reset_suffix(at: &V, window: &V) -> V {
    let a = cd(at, window);
    if a.is_empty() {
        V::Null
    } else {
        part("quotaResetSuffix", Some(obj!("at"=>a)))
    }
}
fn detail(window: &V, r: &Reading, at: &V) -> V {
    part(
        "quotaClaudeWindowDetail",
        Some(
            obj!("window"=>window_name(window),"from"=>V::Null,"pct"=>pct(&V::Number(round(js::js_to_number(&r.used))),r.estimated),"reset"=>reset_suffix(at,window)),
        ),
    )
}
fn label(kind: &str) -> V {
    if kind == "ark" {
        p("quotaVendorArk")
    } else {
        piece(match kind {
            "claude" => "Claude",
            "opencode" => "OpenCode Go",
            "codex" => "Codex",
            "qoder" => "Qoder CN",
            "zhipu" => "Zhipu",
            "kimi" => "Kimi",
            other => other,
        })
    }
}
fn unreachable(kind: &str) -> V {
    let l = label(kind);
    view(
        vec![part("quotaUnreachableText", Some(obj!("label"=>l.clone())))],
        GRAY,
        vec![part("quotaUnreachableTitle", Some(obj!("label"=>l)))],
        V::Null,
    )
}
fn loading(kind: &str) -> V {
    let suffix = match kind {
        "opencode" => "Opencode",
        "claude" => "Claude",
        "codex" => "Codex",
        "qoder" => "Qoder",
        "ark" => "Ark",
        "zhipu" => "Zhipu",
        "kimi" => "Kimi",
        _ => "",
    };
    view(
        vec![part("quotaLoading", Some(obj!("label"=>label(kind))))],
        GRAY,
        if suffix.is_empty() {
            vec![]
        } else {
            vec![p(&format!("quotaLoadingTitle{suffix}"))]
        },
        V::Null,
    )
}
fn with_states(mut value: V, states: V) -> V {
    set(&mut value, "states", states);
    value
}
fn worst(readings: impl Iterator<Item = f64>) -> f64 {
    readings.fold(f64::NEG_INFINITY, |a, b| {
        if a.is_nan() || b.is_nan() {
            f64::NAN
        } else {
            a.max(b)
        }
    })
}
// Regex matching uses a one-character-per-UTF16-unit projection. Replacement
// slices the original units, so isolated surrogates never become U+FFFD.
fn replace_units(input: &JsString, regex: &regex::Regex, group: usize, all: bool) -> JsString {
    let mut projection = String::new();
    let mut offsets = Vec::new();
    for unit in input.as_units() {
        offsets.push(projection.len());
        projection.push(char::from_u32(*unit as u32).unwrap_or('\u{fffd}'));
    }
    offsets.push(projection.len());
    let mut out = Vec::new();
    let mut last = 0;
    for captures in regex.captures_iter(&projection) {
        let Some(m) = captures.get(group) else {
            continue;
        };
        let from = offsets.binary_search(&m.start()).expect("unit boundary");
        let to = offsets.binary_search(&m.end()).expect("unit boundary");
        out.extend_from_slice(&input.as_units()[last..from]);
        last = to;
        if !all {
            break;
        }
    }
    out.extend_from_slice(&input.as_units()[last..]);
    JsString::from_units(out)
}
fn compact(text: &V, keep_cd: bool) -> V {
    if !js::truthy(text) {
        return V::from("");
    }
    static TOKENS: OnceLock<regex::Regex> = OnceLock::new();
    static AGE: OnceLock<regex::Regex> = OnceLock::new();
    static REFRESH: OnceLock<regex::Regex> = OnceLock::new();
    let tokens =
        TOKENS.get_or_init(|| regex::Regex::new(r"\{[a-z]+:-?[0-9]+(?:\|[0-9a-z]+)?\}").unwrap());
    let age = AGE.get_or_init(|| regex::Regex::new(r"\{ago:-?[0-9]+\}").unwrap());
    // JavaScript's `$` without `m` requires the actual end of input. A final
    // line terminator blocks this replacement; trimming happens only afterwards.
    let refresh=REFRESH.get_or_init(||regex::Regex::new(r"([\t\n\v\f\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*⟳[^\r\n\u{2028}\u{2029}]*)\z").unwrap());
    let mut s = js::js_to_string(text);
    if keep_cd {
        s = replace_units(&s, refresh, 1, false);
        s = replace_units(&s, age, 0, true);
    } else {
        s = replace_units(&s, tokens, 0, true);
        s = replace_units(&s, refresh, 1, true);
    }
    let cells = s
        .as_units()
        .split(|n| *n == 0xb7)
        .map(|units| JsString::from_units(units.to_vec()).trim())
        .filter(|s| !s.is_empty())
        .map(V::String);
    join_values(cells, " · ")
}
pub fn normalize_balance(info: &V) -> V {
    if !is_object(info) || get(info, "kind") != &V::from("balance") {
        return V::Null;
    }
    let total = finite(get(info, "total"));
    if total.is_none() && get(info, "available") != &V::Bool(false) {
        return V::Null;
    }
    // Relay-panel balances (gateway `panel-auto`) carry `source`; keep them
    // apart from DeepSeek so the cached bar keeps the right tooltip.
    let provider = match (get(info, "source"), get(info, "scope")) {
        (V::String(_), scope) if scope == &V::from("token") => "relay-token",
        (V::String(_), _) => "relay",
        _ => "deepseek",
    };
    obj!("kind"=>"balance","provider"=>provider,"available"=>get(info,"available")!=&V::Bool(false),"currency"=>if matches!(get(info,"currency"),V::String(_)){field(info,"currency")}else{V::Null},"total"=>num(total))
}
pub fn balance_bar(value: &V) -> V {
    if !js::truthy(value) {
        return V::Null;
    }
    let total = finite(get(value, "total"));
    let b = balance_text(&num(total), get(value, "currency"));
    let c = if get(value, "available") == &V::Bool(false) || total.is_some_and(|n| n <= 5.0) {
        RED
    } else if total.is_some_and(|n| n <= 20.0) {
        YELLOW
    } else {
        BLUE
    };
    let mut text = vec![piece(if b.is_empty() { String::from("—") } else { b })];
    if get(value, "available") == &V::Bool(false) {
        let mut p = p("quotaBalanceInsufficient");
        set(&mut p, "j", V::from(""));
        text.push(p);
    }
    let title = match get(value, "provider") {
        v if v == &V::from("relay") => "quotaRelayBalanceTitle",
        v if v == &V::from("relay-token") => "quotaRelayTokenBalanceTitle",
        _ if matches!(get(value, "source"), V::String(_)) => {
            if get(value, "scope") == &V::from("token") {
                "quotaRelayTokenBalanceTitle"
            } else {
                "quotaRelayBalanceTitle"
            }
        }
        _ => "quotaDeepSeekBalanceTitle",
    };
    view(text, c, vec![p(title)], V::Null)
}
pub fn normalize_window(info: &V, now: f64) -> V {
    if !matches!(info, V::Object(_)) {
        return V::Null;
    }
    if !js::truthy(get(info, "provider")) || get(info, "provider") == &V::from("claude") {
        return js::from_serde(
            &crate::claude_quota::normalize(&js::to_serde(info), now)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    let typ = strict_text(info, "rateLimitType");
    let status = strict_text(info, "status");
    if !["five_hour", "weekly"].contains(&typ.as_str())
        || !["allowed", "allowed_warning", "rejected"].contains(&status.as_str())
    {
        return V::Null;
    }
    let provider = match strict_text(info, "provider").as_str() {
        "glm" => "glm",
        "codex" => "codex",
        "opencode" => "opencode",
        _ => "claude",
    };
    if typ == "weekly" && provider == "claude" {
        return V::Null;
    }
    let windows: Vec<_> = if provider == "claude" {
        vec![]
    } else {
        array(get(info, "windows"))
            .iter()
            .filter_map(|w| {
                let window = get(w, "window");
                if !known_window(window) {
                    return None;
                }
                let used = finite(get(w, "usedPercent"))?;
                Some(obj!("window"=>window.clone(),"usedPercent"=>used.clamp(0.0,100.0),"resetsAtMs"=>reset(get(w,"resetMs"))))
            })
            .collect()
    };
    let mut out = obj!("schemaVersion"=>1.0,"kind"=>typ,"status"=>status,"usedPercentage"=>num(finite(get(info,"utilization")).map(|n|round((n*100.0).clamp(0.0,100.0)*1000.0)/1000.0)),"resetsAtMs"=>reset(get(info,"resetsAt")),"observedAtMs"=>now.trunc(),"source"=>if provider=="opencode"{"opencode_log"}else{"claude_code"},"provider"=>provider);
    if !windows.is_empty() {
        set(&mut out, "windows", V::Array(windows));
    }
    out
}
pub fn window_bar(info: &V, now: f64) -> V {
    if !js::truthy(info) {
        return V::Null;
    }
    let provider = strict_text(info, "provider");
    let title = match provider.as_str() {
        "glm" => "quotaGlmWindowTitle",
        "codex" => "quotaCodexWindowTitle",
        "opencode" => "quotaOpenCodeWindowTitle",
        _ => return V::Null,
    };
    let prefix = if provider == "opencode" {
        "OpenCode Go · "
    } else {
        ""
    };
    let windows = array(get(info, "windows"));
    let mut lines = vec![p(title)];
    let (s, used) = if !windows.is_empty() {
        let mut rows: Vec<_> = windows
            .iter()
            .map(|w| {
                (
                    w,
                    reading(
                        get(w, "usedPercent"),
                        get(w, "resetsAtMs"),
                        get(info, "observedAtMs"),
                        now,
                    ),
                )
            })
            .collect();
        rows.sort_by_key(|(w, _)| rank(get(w, "window")));
        let s = join_values(
            rows.iter()
                .map(|(w, r)| seg_value(get(w, "window"), r, get(w, "resetsAtMs"))),
            " · ",
        );
        lines.extend(
            rows.iter()
                .map(|(w, r)| detail(get(w, "window"), r, get(w, "resetsAtMs"))),
        );
        if rows.iter().any(|(_, r)| r.estimated) {
            lines.push(estimated());
        }
        let used = if get(info, "status") == &V::from("rejected") {
            100.0
        } else {
            worst(rows.iter().map(|(_, r)| js::js_to_number(&r.used)))
        };
        (s, V::Number(used))
    } else {
        let used = if get(info, "status") == &V::from("rejected") {
            V::Number(100.0)
        } else {
            num(finite(get(info, "usedPercentage")))
        };
        let r = reading(
            &used,
            get(info, "resetsAtMs"),
            get(info, "observedAtMs"),
            now,
        );
        let token = if get(info, "kind") == &V::from("weekly") {
            "1wk"
        } else {
            "5h"
        };
        let s = seg(&V::from(token), &r, get(info, "resetsAtMs"));
        if r.estimated {
            lines.push(estimated());
        }
        (
            V::from(if s.is_empty() { token.to_string() } else { s }),
            r.used,
        )
    };
    view(
        vec![piece(concat(&[V::from(prefix), s]))],
        color(remain(&used)),
        lines,
        V::Null,
    )
}
fn cycle(v: &V) -> V {
    match string(v).as_str() {
        "session" | "five_hour" => V::from("5h"),
        "7d" | "weekly" | "seven_day" => V::from("1wk"),
        "monthly" | "30d" => V::from("1m"),
        _ => v.clone(),
    }
}
pub fn provider_limit(entry: &V, now: f64) -> V {
    if !js::truthy(entry) {
        return V::Null;
    }
    let summary = get(entry, "summary");
    let mut windows = array(get(summary, "windows")).to_vec();
    if windows.is_empty() && finite(get(summary, "usedPercentage")).is_some() {
        let cached = empty(&or(get(entry, "barText"), get(entry, "summaryText")));
        let token = regex::Regex::new(r"(?-u:\b)(5h|1wk|1m)[\t\n\v\f\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+[0-9]")
            .unwrap()
            .captures(&cached)
            .map(|c| V::from(c.get(1).unwrap().as_str()))
            .unwrap_or(V::Null);
        windows.push(obj!("window"=>or(get(summary,"window"),&or(&token,&V::from(if get(summary,"provider")==&V::from("codex"){"1wk"}else{"5h"}))),"usedPercent"=>if get(summary,"status")==&V::from("rejected"){V::Number(100.0)}else{field(summary,"usedPercentage")},"resetMs"=>field(summary,"resetsAtMs")));
    }
    let mut rows: Vec<_> = windows
        .iter()
        .filter(|w| js::truthy(w) && finite(get(w, "usedPercent")).is_some())
        .map(|w| {
            let window = cycle(&or(get(w, "window"), get(w, "label")));
            let r = reading(
                get(w, "usedPercent"),
                get(w, "resetMs"),
                get(entry, "fetchedAt"),
                now,
            );
            (w, window, r)
        })
        .collect();
    rows.sort_by_key(|(_, w, _)| rank(w));
    let base = if !rows.is_empty() {
        let mut title: Vec<_> = rows
            .iter()
            .filter(|(_, window, _)| ["5h", "1wk", "1m"].contains(&string(window).as_str()))
            .map(|(w, window, r)| detail(window, r, get(w, "resetMs")))
            .collect();
        if rows.iter().any(|(_, _, r)| r.estimated) {
            title.push(estimated());
        }
        let segments = join_values(
            rows.iter().map(|(w, window, r)| {
                let name = if (get(entry, "kind") == &V::from("claude")
                    || get(summary, "provider") == &V::from("claude"))
                    && js::truthy(get(w, "label"))
                    && get(w, "label") != window
                {
                    claude::row_name(window, get(w, "label"))
                } else {
                    window.clone()
                };
                seg_value(&name, r, get(w, "resetMs"))
            }),
            " · ",
        );
        view(
            vec![piece(segments)],
            color(remain(&V::Number(worst(
                rows.iter().map(|(_, _, r)| js::js_to_number(&r.used)),
            )))),
            title,
            V::Null,
        )
    } else if get(entry, "kind") == &V::from("balance") {
        balance_bar(summary)
    } else {
        let text = compact(&or(get(entry, "barText"), get(entry, "summaryText")), true);
        view(
            if js::truthy(&text) {
                vec![piece(text)]
            } else {
                vec![]
            },
            GRAY,
            vec![],
            V::Null,
        )
    };
    let mut text_parts = array(get(&base, "textParts")).to_vec();
    if js::truthy(get(entry, "lastError")) {
        text_parts.push(p("limitFetchFailed"));
    } else {
        let a = ago(get(entry, "fetchedAt"));
        if !a.is_empty() {
            text_parts.push(part("limitUpdatedAgo", Some(obj!("ago"=>a))));
        }
    }
    if js::truthy(get(entry, "stale")) && js::truthy(get(&base, "text")) {
        text_parts.push(p("limitStale"));
    }
    if text_parts.is_empty() {
        return V::Null;
    }
    let v = view(
        text_parts,
        &text(&base, "color"),
        array(get(&base, "titleParts")).to_vec(),
        V::Null,
    );
    let kind = strict_text(entry, "kind");
    let kind = if [
        "claude", "opencode", "codex", "qoder", "ark", "zhipu", "kimi",
    ]
    .contains(&kind.as_str())
    {
        kind
    } else {
        strict_text(summary, "provider")
    };
    let kind = if kind == "glm" { "zhipu" } else { &kind };
    if ![
        "claude", "opencode", "codex", "qoder", "ark", "zhipu", "kimi",
    ]
    .contains(&kind)
    {
        return v;
    }
    with_states(
        v,
        obj!("loading"=>loading(kind),"unreachable"=>unreachable(kind)),
    )
}
pub fn render(kind: &str, value: &V, opts: &V) -> V {
    let now = time(get(opts, "nowMs"));
    let base = match kind {
        "opencode" => vendors::open_code(value, now),
        "qoder" => vendors::qoder(value, now),
        "codex" => vendors::codex(value, now),
        "ark" => vendors::ark(value, get(opts, "baseUrl"), now),
        "zhipu" => vendors::zhipu(value, now),
        "kimi" => vendors::kimi(value, get(opts, "cached"), now),
        "claude" => return claude::bar(value, get(opts, "live"), now),
        _ => return V::Null,
    };
    let mut states = obj!("loading"=>loading(kind),"unreachable"=>unreachable(kind));
    if kind == "ark" {
        set(
            &mut states,
            "installing",
            simple(
                "quotaArkInstallingText",
                GRAY,
                "quotaArkInstallingTitle",
                "",
            ),
        );
    }
    with_states(base, states)
}
fn routed(bar: &V, provider: &V, balance: bool) -> V {
    if !js::truthy(bar) {
        return V::Null;
    }
    let source = match (if matches!(provider, V::String(_)) {
        string(provider)
    } else {
        String::new()
    })
    .as_str()
    {
        "glm" => "GLM",
        "codex" => "Codex",
        _ => "Claude",
    };
    let mut texts = vec![if balance {
        p("quotaDeepSeekBalancePrefix")
    } else {
        part("quotaRoutedProviderPrefix", Some(obj!("source"=>source)))
    }];
    texts.extend(if js::truthy(get(bar, "textParts")) {
        array(get(bar, "textParts")).to_vec()
    } else {
        vec![piece(field(bar, "text"))]
    });
    let mut titles = if js::truthy(get(bar, "titleParts")) {
        array(get(bar, "titleParts")).to_vec()
    } else {
        vec![piece(if balance {
            field(bar, "title")
        } else {
            V::from(format!("{source} 额度"))
        })]
    };
    if !balance {
        titles.push(p("quotaRoutedProviderNote"));
    }
    view(texts, &text(bar, "color"), titles, field(bar, "action"))
}
pub fn provider_balance(strategy: &V, dto: &V, fetched: &V, now: f64) -> V {
    if !js::truthy(dto) {
        return V::Null;
    }
    if get(dto, "kind") == &V::from("balance") {
        return balance_bar(dto);
    }
    if get(dto, "kind") != &V::from("window") {
        return V::Null;
    }
    let used = js::js_to_number(get(dto, "utilization")) * 100.0;
    if !used.is_finite() {
        return V::Null;
    }
    let weekly = js::js_to_number(get(dto, "weeklyUtilization")) * 100.0;
    if get(dto, "provider") == &V::from("claude") && !array(get(dto, "windows")).is_empty() {
        return provider_limit(
            &obj!("kind"=>"claude","summary"=>obj!("windows"=>field(dto,"windows")),"fetchedAt"=>fetched.clone()),
            now,
        );
    }
    if strategy == &V::from("codex-oauth-usage") || get(dto, "provider") == &V::from("codex") {
        let mut v = obj!("status"=>"ok","fetchedAt"=>fetched.clone(),"planType"=>or(get(dto,"tier"),&V::Null));
        if !array(get(dto, "windows")).is_empty() {
            set(&mut v,"windows",V::Array(array(get(dto,"windows")).iter().map(|w|obj!("window"=>field(w,"window"),"usedPercent"=>field(w,"usedPercent"),"resetsAt"=>if get(w,"resetMs").is_nullish(){V::Null}else{V::Number(js::js_to_number(get(w,"resetMs"))/1000.0)})).collect()));
        }
        set(
            &mut v,
            "weekly",
            obj!("usedPercent"=>used,"remainingPercent"=>(100.0-used).max(0.0),"resetsAt"=>or(get(dto,"resetsAt"),&V::Null)),
        );
        return render("codex", &v, &obj!("nowMs"=>now));
    }
    let mut site = obj!("site"=>"relay","host"=>"relay","ok"=>true,"usedPercent"=>used,"resetsAt"=>or(get(dto,"resetsAt"),&V::Null));
    if weekly.is_finite() {
        set(&mut site, "weeklyUsedPercent", V::Number(weekly));
        set(
            &mut site,
            "weeklyResetsAt",
            or(get(dto, "weeklyResetsAt"), &V::Null),
        );
    }
    render(
        "zhipu",
        &obj!("status"=>"ok","fetchedAt"=>fetched.clone(),"sites"=>V::Array(vec![site])),
        &obj!("nowMs"=>now),
    )
}
/// Direct native-value surface shared by the addon and quota recorder.
pub fn request(op: &str, input: &V) -> V {
    match op {
        "renderQuotaBar" => render(
            &strict_text(input, "kind"),
            get(input, "value"),
            get(input, "opts"),
        ),
        "idleQuotaBars" => V::object(
            ["opencode", "qoder", "codex", "ark", "kimi", "claude"]
                .into_iter()
                .map(|kind| (kind, render(kind, &V::Null, &V::Undefined)))
                .collect(),
        ),
        "normalizeBalance" => normalize_balance(get(input, "info")),
        "balanceBar" => balance_bar(get(input, "value")),
        "normalizeWindowEvent" => normalize_window(get(input, "info"), time(get(input, "nowMs"))),
        "windowEventBar" => window_bar(get(input, "info"), default_time(get(input, "nowMs"))),
        "claudeBar" => claude::bar(
            get(input, "usage"),
            get(input, "live"),
            default_time(get(input, "nowMs")),
        ),
        "labelRoutedProvider" => routed(get(input, "bar"), get(input, "provider"), false),
        "labelRoutedBalance" => routed(get(input, "bar"), &V::Undefined, true),
        "arkPlanFromBaseUrl" => vendors::ark_plan(get(input, "baseUrl")),
        "arkWindowLabel" => vendors::ark_window(get(input, "label")),
        "compactBarText" => compact(get(input, "text"), false),
        "providerLimitBar" => {
            provider_limit(get(input, "entry"), default_time(get(input, "nowMs")))
        }
        "providerBalanceBar" => provider_balance(
            get(input, "strategy"),
            get(input, "dto"),
            get(input, "fetchedAt"),
            time(get(input, "nowMs")),
        ),
        "colors" => obj!("gray"=>GRAY,"red"=>RED,"yellow"=>YELLOW,"blue"=>BLUE),
        _ => V::Undefined,
    }
}
