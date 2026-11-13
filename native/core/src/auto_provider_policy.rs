//! Auto Provider route policy: the pure decisions the Auto runtime takes on
//! every turn —
//!
//! * [`limit_state`]: how one provider-limit cache entry reads *now*;
//! * [`choose_candidate`]: which line of the pool to try next;
//! * [`failover_safety`]: whether a failed attempt may move to another line.
//!
//! `src/chat/auto-provider-policy.js` carries in only the fields these rules
//! read, each exactly as JavaScript held it (see [`Js`]). The rules were
//! written against JS values — `String(x || '')`, `Number(x)`, truthiness,
//! `===` — and the runtime still builds those values in JS, so the coercions
//! are reproduced here rather than narrowed to "well-typed" input: a numeric
//! string, a missing field and a `NaN` all keep the meaning they always had.
use serde_json::{json, Map, Value};
use std::borrow::Cow;

/// Failover is a blocklist, not an allowlist: any failure may move the turn to
/// another line unless switching provably cannot help or would be harmful. An
/// unrecognised provider error (a new upstream wording, an opaque exit code)
/// is exactly the case Auto exists for. The replay-safety gates (phase,
/// visible output, tool intent, side effects) still apply to every category.
///
/// * `cancel_shutdown` — a local stop (user, restart, shutdown); never replay.
/// * `context_token_limit` — the request itself is too large; the remedy is
///   compaction, and every line would refuse it again.
/// * `tool_protocol` — our tool call is malformed; a replay reproduces it.
///
/// Everything else switches, including a missing classification (an opaque
/// crash, non-zero exit, watchdog kill) and `adapter_configuration` (a spawn
/// failure or a provider-specific configuration error): the pool exists to try
/// another line, and the replay gates below still decide whether the switch is
/// safe or must become a continuation handoff.
pub const NON_FAILOVER_CATEGORIES: [&str; 3] =
    ["cancel_shutdown", "context_token_limit", "tool_protocol"];
/// Categories whose failover reason keeps its historical name. Anything else
/// that switches on an upstream 4xx keeps reporting `failover_http_4xx`.
const PROVIDER_FAULT_CATEGORIES: [&str; 6] = [
    "billing_quota",
    "rate_limit",
    "provider_transient",
    "network",
    "timeout",
    "authentication_permission",
];
pub const SAFE_PHASES: [&str; 3] = ["connect", "request", "before_first_token"];

/// Usage at or above this share of a window counts as "about to run dry" when
/// choosing a new route. It does not evict an existing usable sticky route.
pub const NEAR_LIMIT_PERCENT: f64 = 90.0;
/// Quota-first steering (`preferMaxQuota`) treats a line with less than this
/// share of its window remaining — usage above `100 - this` — as running low:
/// it yields to any measured line with more than that left, ahead of
/// stickiness. The buffer between this threshold and
/// [`NEAR_LIMIT_PERCENT`]/exhaustion is what lets the switch happen between
/// turns instead of as a mid-task 429.
pub const QUOTA_LOW_REMAINING_PERCENT: f64 = 20.0;
/// A usage reading stays a useful steering hint for longer than it stays a
/// trustworthy exhaustion verdict (the per-account sweeper runs every ~10 min).
const USAGE_HINT_MS: f64 = 30.0 * 60_000.0;
const DEFAULT_STALE_AFTER_MS: f64 = 5.0 * 60_000.0;
const EXHAUSTED_STATUSES: [&str; 3] = ["exhausted", "quota_exhausted", "blocked"];

/// Model ids arrive as wire ids ("claude-fable-5-1[1m]"), bare aliases
/// ("fable") or differently-versioned ids of one family. Exact
/// (case-insensitive) match wins; otherwise the family token decides. A pair
/// of unrelated families never matches, so a Fable-only block leaves
/// Sonnet/Opus available.
const MODEL_FAMILIES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];
const MODEL_FAMILY_STOPWORDS: [&str; 4] = ["claude", "anthropic", "model", "models"];

// ── JavaScript values ───────────────────────────────────────────────────────

/// One value as JavaScript held it. JSON carries strings, finite numbers,
/// booleans and null as themselves; the bridge tags what JSON cannot spell:
/// `{"$u":1}` is undefined (an absent field is undefined too), `{"$num":"NaN"}`
/// a non-finite number, and `{"$js":id,"text":…,"num":…}` any other value —
/// its identity within the request and its `String()` / `Number()`.
#[derive(Clone, Copy, Debug)]
enum Js<'a> {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(&'a str),
    Obj {
        id: Option<u64>,
        text: &'a str,
        num: f64,
    },
}

fn js(value: Option<&Value>) -> Js<'_> {
    match value {
        None => Js::Undefined,
        Some(Value::Null) => Js::Null,
        Some(Value::Bool(flag)) => Js::Bool(*flag),
        Some(Value::Number(number)) => Js::Num(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(text)) => Js::Str(text),
        Some(Value::Object(tagged)) => tagged_value(tagged),
        Some(Value::Array(_)) => Js::Obj {
            id: None,
            text: "",
            num: f64::NAN,
        },
    }
}

fn tagged_value(tagged: &Map<String, Value>) -> Js<'_> {
    if tagged.contains_key("$u") {
        return Js::Undefined;
    }
    if let Some(spelled) = tagged.get("$num") {
        return Js::Num(match spelled.as_str() {
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            _ => f64::NAN,
        });
    }
    // Anything else — including an array hole — is an object that only
    // equals itself (and a hole has no identity, so it equals nothing).
    Js::Obj {
        id: tagged.get("$js").and_then(Value::as_u64),
        text: tagged.get("text").and_then(Value::as_str).unwrap_or(""),
        num: js(tagged.get("num")).number(),
    }
}

impl<'a> Js<'a> {
    fn truthy(self) -> bool {
        match self {
            Js::Undefined | Js::Null => false,
            Js::Bool(flag) => flag,
            Js::Num(n) => n != 0.0 && !n.is_nan(),
            Js::Str(text) => !text.is_empty(),
            Js::Obj { .. } => true,
        }
    }

    /// `value == null`
    fn nullish(self) -> bool {
        matches!(self, Js::Undefined | Js::Null)
    }

    /// `Number(value)`
    fn number(self) -> f64 {
        match self {
            Js::Undefined => f64::NAN,
            Js::Null => 0.0,
            Js::Bool(flag) => f64::from(u8::from(flag)),
            Js::Num(n) => n,
            Js::Str(text) => string_to_number(text),
            Js::Obj { num, .. } => num,
        }
    }

    /// `String(value)`
    fn text(self) -> Cow<'a, str> {
        match self {
            Js::Undefined => Cow::Borrowed("undefined"),
            Js::Null => Cow::Borrowed("null"),
            Js::Bool(flag) => Cow::Borrowed(if flag { "true" } else { "false" }),
            Js::Num(n) => Cow::Owned(ryu_js::Buffer::new().format(n).to_string()),
            Js::Str(text) | Js::Obj { text, .. } => Cow::Borrowed(text),
        }
    }

    /// `String(value || '')`
    fn text_or_empty(self) -> Cow<'a, str> {
        if self.truthy() {
            self.text()
        } else {
            Cow::Borrowed("")
        }
    }

    /// `value === 'literal'`
    fn is(self, literal: &str) -> bool {
        matches!(self, Js::Str(text) if text == literal)
    }

    /// `left === right`
    fn strict_eq(self, other: Js<'_>) -> bool {
        match (self, other) {
            (Js::Undefined, Js::Undefined) | (Js::Null, Js::Null) => true,
            (Js::Bool(left), Js::Bool(right)) => left == right,
            (Js::Num(left), Js::Num(right)) => left == right,
            (Js::Str(left), Js::Str(right)) => left == right,
            (
                Js::Obj { id: Some(left), .. },
                Js::Obj {
                    id: Some(right), ..
                },
            ) => left == right,
            _ => false,
        }
    }

    /// `Set#has` equality: `===`, except that NaN finds NaN.
    fn same_value_zero(self, other: Js<'_>) -> bool {
        match (self, other) {
            (Js::Num(left), Js::Num(right)) if left.is_nan() && right.is_nan() => true,
            _ => self.strict_eq(other),
        }
    }

    /// The primitive `<` compares: an object compares by its string form
    /// (`valueOf` of a plain object or an array is the object itself).
    fn primitive(self) -> Js<'a> {
        match self {
            Js::Obj { text, .. } => Js::Str(text),
            other => other,
        }
    }
}

/// `left < right`: two strings compare by UTF-16 code units, anything else
/// numerically (NaN compares false).
fn js_less(left: Js<'_>, right: Js<'_>) -> bool {
    match (left.primitive(), right.primitive()) {
        (Js::Str(a), Js::Str(b)) => a.encode_utf16().lt(b.encode_utf16()),
        (a, b) => a.number() < b.number(),
    }
}

/// `left - right`
fn js_sub(left: Js<'_>, right: Js<'_>) -> f64 {
    left.number() - right.number()
}

/// `Math.max(a, b)` — NaN wins, and +0 is larger than -0.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)` — NaN wins, and -0 is smaller than +0.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// ECMAScript WhiteSpace and LineTerminator — what `String#trim` removes.
/// Not Rust's `char::is_whitespace`: JS trims U+FEFF and keeps U+0085.
fn is_js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `Number(string)`: StringToNumber, including `''` → 0, `Infinity`, and the
/// unsigned `0x` / `0o` / `0b` integer forms; anything else that is not a
/// decimal literal is NaN.
fn string_to_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            return radix_integer(&trimmed[2..], radix);
        }
    }
    let (sign, body) = match bytes[0] {
        b'+' => (1.0, &trimmed[1..]),
        b'-' => (-1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(body) {
        return f64::NAN;
    }
    // The grammar is checked above, so Rust's parser (which also accepts
    // "inf"/"nan") only ever sees a JS decimal literal; both round correctly.
    body.parse::<f64>().map_or(f64::NAN, |value| sign * value)
}

fn radix_integer(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0_f64;
    let mut exact: Option<u128> = Some(0);
    for c in digits.chars() {
        let Some(digit) = c.to_digit(radix) else {
            return f64::NAN;
        };
        exact = exact
            .and_then(|n| n.checked_mul(u128::from(radix)))
            .and_then(|n| n.checked_add(u128::from(digit)));
        value = value * f64::from(radix) + f64::from(digit);
    }
    exact.map_or(value, |n| n as f64)
}

fn is_decimal_literal(body: &str) -> bool {
    let bytes = body.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let mut at = digits(0);
    let mut significant = at;
    if bytes.get(at) == Some(&b'.') {
        let fraction = digits(at + 1);
        at += 1 + fraction;
        significant += fraction;
    }
    if significant == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = digits(at);
        if exponent == 0 {
            return false;
        }
        at += exponent;
    }
    at == bytes.len()
}

fn lower(text: &str) -> String {
    text.to_lowercase()
}

fn field<'a>(object: Option<&'a Map<String, Value>>, key: &str) -> Js<'a> {
    js(object.and_then(|map| map.get(key)))
}

fn parse(input: &str) -> Result<Value, String> {
    // The JS side JSON.stringify's whatever it was handed, including lone
    // surrogates from sliced strings; lenient parsing keeps those from
    // turning into transport errors (usage/search/task_store already do).
    crate::json_lenient::from_str(input).map_err(|error| format!("invalid_policy_request: {error}"))
}

// ── limit_state ─────────────────────────────────────────────────────────────

fn verdict(state: &str, reason: &str, used_percent: Option<f64>) -> Value {
    // `+ 0.0` turns a -0 into 0: the JS reading never reports -0.
    json!({ "state": state, "reason": reason, "usedPercent": used_percent.map(|n| n + 0.0) })
}

/// The fullest live window, 0..100, or None. A window whose reset time has
/// already passed no longer binds and is ignored.
fn used_percent_of(summary: Option<&Map<String, Value>>, now: f64) -> Option<f64> {
    let expired = |reset: f64| reset.is_finite() && reset > 0.0 && reset <= now;
    let mut values = Vec::new();
    for window in windows_of(summary) {
        let used = field(Some(window), "usedPercent");
        if used.nullish() {
            continue;
        }
        let percent = used.number();
        if !percent.is_finite() || expired(field(Some(window), "resetMs").number()) {
            continue;
        }
        values.push(percent);
    }
    let overall = field(summary, "usedPercentage");
    if !overall.nullish()
        && overall.number().is_finite()
        && !expired(field(summary, "resetsAtMs").number())
    {
        values.push(overall.number());
    }
    let fullest = values.into_iter().reduce(js_max)?;
    Some(js_max(0.0, js_min(100.0, fullest)))
}

/// The windows of a summary that the rules read; a falsy window is skipped.
fn windows_of(summary: Option<&Map<String, Value>>) -> impl Iterator<Item = &Map<String, Value>> {
    summary
        .and_then(|map| map.get("windows"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

/// A window the last quota reading saw full stays full until the reset time it
/// published, however old that reading is: a weekly cap does not come back
/// just because nobody re-polled it in the last ten minutes.
fn full_until_reset(summary: Option<&Map<String, Value>>, now: f64) -> bool {
    let full = |used: Js<'_>, reset: Js<'_>| {
        let reset = reset.number();
        !used.nullish() && used.number() >= 100.0 && reset.is_finite() && reset > now
    };
    windows_of(summary).any(|window| {
        full(
            field(Some(window), "usedPercent"),
            field(Some(window), "resetMs"),
        )
    }) || full(
        field(summary, "usedPercentage"),
        field(summary, "resetsAtMs"),
    )
}

/// A window the last reading saw full, whose published reset time has since
/// passed. The reading itself is old news by then, but the one fact it carried
/// (this cap was the blocker, and it has rolled over) is exactly what makes the
/// line worth a fresh try.
fn full_window_reset_elapsed(summary: Option<&Map<String, Value>>, now: f64) -> bool {
    let elapsed = |used: Js<'_>, reset: Js<'_>| {
        let reset = reset.number();
        !used.nullish()
            && used.number() >= 100.0
            && reset.is_finite()
            && reset > 0.0
            && reset <= now
    };
    windows_of(summary).any(|window| {
        elapsed(
            field(Some(window), "usedPercent"),
            field(Some(window), "resetMs"),
        )
    }) || elapsed(
        field(summary, "usedPercentage"),
        field(summary, "resetsAtMs"),
    )
}

fn family_bounded(text: &str, family: &str) -> bool {
    let is_letter = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase());
    text.match_indices(family).any(|(at, _)| {
        !is_letter(text[..at].chars().next_back())
            && !is_letter(text[at + family.len()..].chars().next())
    })
}

fn model_family(value: &str) -> Option<String> {
    let text = lower(value);
    if let Some(known) = MODEL_FAMILIES
        .iter()
        .find(|family| family_bounded(&text, family))
    {
        return Some((*known).to_string());
    }
    // Unknown family: the first alphabetic token that is not the vendor name.
    text.split(|c: char| !c.is_ascii_lowercase())
        .find(|token| !token.is_empty() && !MODEL_FAMILY_STOPWORDS.contains(token))
        .map(str::to_string)
}

fn models_match(candidate: Js<'_>, blocked: Js<'_>) -> bool {
    let candidate = lower(js_trim(&candidate.text_or_empty()));
    let blocked = lower(js_trim(&blocked.text_or_empty()));
    if candidate.is_empty() || blocked.is_empty() {
        return false;
    }
    if candidate == blocked {
        return true;
    }
    match (model_family(&candidate), model_family(&blocked)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn exhausted_text(text: &str) -> bool {
    // `/(?:余额不足|insufficient (?:balance|quota)|quota exhausted|exhausted)/i`
    // over already lower-cased text: there `/i` adds nothing for an ASCII
    // pattern, and "quota exhausted" is covered by "exhausted".
    [
        "余额不足",
        "insufficient balance",
        "insufficient quota",
        "exhausted",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// How one provider-limit cache entry reads at `now`.
///
/// Request: `{ entry: null | { fetchedAt, status, summaryText, summary: null |
/// { kind, revoked, blockedUntilMs, status, scope, model, usedPercentage,
/// resetsAtMs, available, total, windows: [null | { usedPercent, resetMs }] } },
/// now, staleAfterMs?, model? }`. Answer: `{ state, reason, usedPercent }`.
pub fn limit_state(input: &str) -> Result<String, String> {
    let request = parse(input)?;
    Ok(limit_state_of(&request).to_string())
}

fn limit_state_of(request: &Value) -> Value {
    let now = js(request.get("now")).number();
    let stale_after = match js(request.get("staleAfterMs")) {
        Js::Undefined => DEFAULT_STALE_AFTER_MS,
        value => value.number(),
    };
    let model = js(request.get("model"));
    let Some(entry) = request.get("entry").and_then(Value::as_object) else {
        return verdict("unknown", "limit_unknown", None);
    };
    let summary = entry.get("summary").and_then(Value::as_object);
    let summary_status = lower(&field(summary, "status").text_or_empty());
    if field(summary, "kind").is("availability") {
        // A revoked credential has no self-recovery path inside multicc: only a
        // fresh login repairs it, which is what clears this flag. Reading the
        // flag instead of the timestamp keeps the account out of Auto's pool for
        // as long as the grant is dead, rather than until a timer lapses.
        if field(summary, "revoked").strict_eq(Js::Bool(true)) {
            return verdict("exhausted", "provider_credential_revoked", None);
        }
        let blocked_until = field(summary, "blockedUntilMs").number();
        if summary_status == "rejected" && blocked_until.is_finite() && blocked_until > now {
            // A model-scoped park only removes that model. Without a name on
            // either side we cannot prove the line avoids it, so it is skipped
            // conservatively.
            if lower(&field(summary, "scope").text_or_empty()) == "model" {
                let blocked = field(summary, "model");
                if !model.truthy() || !blocked.truthy() || models_match(model, blocked) {
                    return verdict("exhausted", "provider_model_cooldown_active", None);
                }
                return verdict("stale", "provider_model_cooldown_other_model", None);
            }
            return verdict("exhausted", "provider_cooldown_active", None);
        }
        return verdict("stale", "provider_cooldown_expired", None);
    }
    let fetched_at = field(Some(entry), "fetchedAt").number();
    let age = now - fetched_at;
    let used = if fetched_at.is_finite() && age <= js_max(stale_after, USAGE_HINT_MS) {
        used_percent_of(summary, now)
    } else {
        None
    };
    if !fetched_at.is_finite() || age > stale_after {
        if full_until_reset(summary, now) {
            return verdict("exhausted", "limit_window_full_until_reset", used);
        }
        // The cap that blocked this line has rolled over, but nothing re-read
        // the quota: a line that is not being used produces no new readings.
        // Waiting for one would leave the session on its fallback indefinitely,
        // so the line is offered back for its place — unless a window that is
        // still running is itself close to full. If it is rejected again the
        // failure records a fresh park, so the retry is bounded.
        let still_roomy = used_percent_of(summary, now).is_none_or(|n| n < NEAR_LIMIT_PERCENT);
        if full_window_reset_elapsed(summary, now) && still_roomy {
            return verdict("stale", "limit_window_reset_elapsed", used);
        }
        return verdict("stale", "limit_stale", used);
    }
    let status_value = field(Some(entry), "status");
    let status = lower(&status_value.text_or_empty());
    if EXHAUSTED_STATUSES.contains(&status.as_str()) {
        return verdict("exhausted", "fresh_limit_exhausted", used);
    }
    if status_value.truthy() && status != "ok" {
        return verdict("unknown", "limit_error", used);
    }
    let text = lower(&field(Some(entry), "summaryText").text_or_empty());
    let available = field(summary, "available");
    let balance = match (available, field(summary, "total")) {
        (Js::Num(n), _) | (_, Js::Num(n)) => Some(n),
        _ => None,
    };
    let exhausted = available.strict_eq(Js::Bool(false))
        || balance.is_some_and(|n| n <= 0.0)
        || summary_status == "rejected"
        || field(summary, "usedPercentage").number() >= 100.0
        || used.is_some_and(|n| n >= 100.0)
        || exhausted_text(&text);
    if exhausted {
        verdict("exhausted", "fresh_limit_exhausted", used)
    } else {
        verdict("available", "fresh_limit_available", used)
    }
}

// ── choose_candidate ────────────────────────────────────────────────────────

struct Line<'a> {
    /// Position in the caller's candidate list — what the answer names.
    at: usize,
    fields: &'a Map<String, Value>,
}

impl<'a> Line<'a> {
    fn get(&self, key: &str) -> Js<'a> {
        js(self.fields.get(key))
    }
    fn usage(&self) -> Option<f64> {
        let used = self.get("usedPercent");
        (!used.nullish()).then(|| used.number())
    }
    fn near_limit(&self) -> bool {
        self.usage().is_some_and(|used| used >= NEAR_LIMIT_PERCENT)
    }
    /// Between two official accounts the one with more headroom wins, compared
    /// in 20-point bands so small drifts do not bounce a session.
    fn official_band(&self) -> Option<f64> {
        if !self.get("trustDomain").is("official") {
            return None;
        }
        self.usage().map(|used| (used / 20.0).floor())
    }
    /// Whether less than [`QUOTA_LOW_REMAINING_PERCENT`] of the window is
    /// left. A non-finite reading (or none at all) is no opinion — see
    /// [`Order::compare`] for how that keeps unmeasured lines on their
    /// configured order.
    fn quota_tight(&self) -> Option<bool> {
        self.usage()
            .filter(|used| used.is_finite())
            .map(|used| 100.0 - used < QUOTA_LOW_REMAINING_PERCENT)
    }
    fn price(&self) -> Js<'a> {
        if self.get("priced").strict_eq(Js::Bool(true)) {
            self.get("blended")
        } else {
            Js::Num(f64::INFINITY)
        }
    }
    /// An earlier line the cache reports usable again (a fresh available
    /// reading, an availability park that has expired, or a full window whose
    /// reset time has passed) reclaims its place. A line that is merely
    /// unmeasured stays behind the sticky route, so neither an aged-out reading
    /// nor a one-off failure re-rolls the route on every turn.
    fn recovered_for_priority(&self) -> bool {
        self.get("limitState").is("available")
            || self.get("limitReason").is("provider_cooldown_expired")
            || self.get("limitReason").is("limit_window_reset_elapsed")
    }
}

/// The ordering inputs of one choice.
///
/// `preferred_tier` is the difficulty verdict for THIS turn. It outranks
/// stickiness: a follow-up that got harder must not stay pinned to the weak
/// model that answered the previous turn. It is a preference, never a filter.
/// The remaining keys only exist for cross-CLI and price-tiered pools and are
/// inert when absent, so a legacy pool orders exactly as before:
///
/// * `ladder` — the tier keys weakest first; with it, a miss on the preferred
///   tier climbs before it descends (the nearer stronger tier first);
/// * `pinned` — a reserved line ({providerId, cli, model}) from a handoff or a
///   planned lane switch; it outranks stickiness;
/// * `by_quota` — quota-first steering (`preferMaxQuota`): a line with less
///   than [`QUOTA_LOW_REMAINING_PERCENT`] of its window left yields to any
///   measured line with more than that, ahead of stickiness — riding a line
///   into the wall mid-task is the interruption the option exists to avoid.
///   Above that threshold quota never reorders a pool; when both lines are
///   running low the roomier one goes first (below stickiness, so a session
///   already on a low line does not churn between low lines). A line without a
///   reading expresses no opinion here, so an unmeasured pool (or an
///   unmeasured line of a mixed one) keeps the ordering it always had;
/// * `prefer_cli` — the session's current lane; a tie stays on it, since
///   leaving it costs a handoff;
/// * `by_price` — price-tiered pools prefer the cheaper line inside a tier.
struct Order<'a> {
    sticky: Js<'a>,
    preferred_tier: Js<'a>,
    ladder: Option<Vec<Js<'a>>>,
    pinned: Option<&'a Map<String, Value>>,
    prefer_cli: Js<'a>,
    by_price: bool,
    by_quota: bool,
}

impl Order<'_> {
    fn tier_rank(&self, line: &Line<'_>) -> f64 {
        if !self.preferred_tier.truthy() {
            return 0.0;
        }
        let tier = line.get("tier");
        if tier.strict_eq(self.preferred_tier) {
            return 0.0;
        }
        let Some(ladder) = self.ladder.as_ref().filter(|ladder| !ladder.is_empty()) else {
            return 1.0;
        };
        let index_of = |value: Js<'_>| ladder.iter().position(|item| item.strict_eq(value));
        let length = ladder.len() as f64;
        match (index_of(self.preferred_tier), index_of(tier)) {
            (Some(want), Some(have)) if have > want => (have - want) as f64,
            (Some(want), Some(have)) => length + (want - have) as f64,
            _ => length * 2.0,
        }
    }

    fn is_pinned(&self, line: &Line<'_>) -> bool {
        let Some(pin) = self.pinned else {
            return false;
        };
        let pinned = |key: &str| field(Some(pin), key);
        line.get("providerId").strict_eq(pinned("providerId"))
            && (!pinned("cli").truthy() || line.get("cli").strict_eq(pinned("cli")))
            && (pinned("model").nullish() || line.get("model").strict_eq(pinned("model")))
    }

    /// The comparator, returning what the JS one returned. Quota steering: a
    /// line at NEAR_LIMIT_PERCENT or above yields to roomier ones when
    /// choosing a new route, but the current (sticky) route stays selected
    /// until exhausted — unless an earlier, recovered, roomier line reclaims
    /// its place. That exception is deliberately not transitive, which is why
    /// the sort below must be the exact sequence of comparisons JS made.
    fn compare(&self, left: &Line<'_>, right: &Line<'_>) -> f64 {
        let tier = self.tier_rank(left) - self.tier_rank(right);
        if tier != 0.0 {
            return tier;
        }
        let rank = |first: bool| if first { 0.0 } else { 1.0 };
        if self.pinned.is_some() {
            let pin = rank(self.is_pinned(left)) - rank(self.is_pinned(right));
            if pin != 0.0 {
                return pin;
            }
        }
        // Quota-first steering: a line running low on quota (less than
        // QUOTA_LOW_REMAINING_PERCENT of its window left) yields to any
        // measured line with more than that — ahead of stickiness, so the
        // switch happens between turns instead of as a mid-task 429. Only a
        // pair of readings is judged: a line without a reading keeps the place
        // the keys below give it, so a mixed pool never demotes an unmeasured
        // line below a measured one merely for being unmeasured.
        if self.by_quota {
            if let (Some(a), Some(b)) = (left.quota_tight(), right.quota_tight()) {
                if a != b {
                    // `false` (still has headroom) sorts first.
                    return if a { 1.0 } else { -1.0 };
                }
            }
        }
        let left_sticky = left.get("providerId").strict_eq(self.sticky);
        let right_sticky = right.get("providerId").strict_eq(self.sticky);
        let reclaims = |earlier: &Line<'_>, sticky: &Line<'_>| {
            earlier.recovered_for_priority()
                && !earlier.near_limit()
                && js_less(earlier.get("priority"), sticky.get("priority"))
        };
        if left_sticky && !right_sticky {
            return if reclaims(right, left) { 1.0 } else { -1.0 };
        }
        if right_sticky && !left_sticky {
            return if reclaims(left, right) { -1.0 } else { 1.0 };
        }
        let pressure = rank(!left.near_limit()) - rank(!right.near_limit());
        if pressure != 0.0 {
            return pressure;
        }
        // Both lines running low on quota (and quota-first steering on): the
        // roomier one answers first — the official-account rule right below,
        // generalized to every line but confined to the low regime. Above it
        // the order the user configured stands. Stickiness has already spoken
        // by here, so this only orders lines the session is not on.
        if self.by_quota
            && matches!(left.quota_tight(), Some(true))
            && matches!(right.quota_tight(), Some(true))
        {
            if let (Some(a), Some(b)) = (left.usage(), right.usage()) {
                if a != b && (a - b).is_finite() {
                    return a - b;
                }
            }
        }
        if let (Some(a), Some(b)) = (left.official_band(), right.official_band()) {
            if a != b {
                return a - b;
            }
        }
        if self.prefer_cli.truthy() {
            let lane = |line: &Line<'_>| rank(line.get("cli").strict_eq(self.prefer_cli));
            let order = lane(left) - lane(right);
            if order != 0.0 {
                return order;
            }
        }
        if self.by_price {
            let (a, b) = (left.price(), right.price());
            if !a.strict_eq(b) {
                return if js_less(a, b) { -1.0 } else { 1.0 };
            }
        }
        let by_priority = js_sub(left.get("priority"), right.get("priority"));
        if by_priority != 0.0 && !by_priority.is_nan() {
            by_priority
        } else {
            js_sub(left.get("index"), right.get("index"))
        }
    }
}

/// `Array.prototype.sort` exactly as V8 (node 26) runs it below 64 elements.
/// Up to 7 elements it binary-inserts from the second element on; from 8 it
/// first counts the leading run (reversing it when strictly descending) and
/// binary-inserts the rest — TimSort's single-run path. A comparator answer of
/// NaN counts as 0. The policy comparator is not a consistent order, so the
/// exact sequence of comparisons decides the result; this keeps the one the JS
/// policy always produced (matched call-for-call against V8 on random
/// intransitive comparators for every length 2..63). A pool never reaches 64
/// lines (12 candidates, at most 32 after model expansion); past that this is
/// still a stable sort.
const SHORT_SORT: usize = 7;

fn js_sort<T>(items: &mut [T], compare: impl Fn(&T, &T) -> f64) {
    let order = |a: &T, b: &T| {
        let value = compare(a, b);
        if value.is_nan() {
            0.0
        } else {
            value
        }
    };
    let length = items.len();
    if length < 2 {
        return;
    }
    let mut run = 1;
    if length > SHORT_SORT {
        let descending = order(&items[1], &items[0]) < 0.0;
        run = 2;
        while run < length {
            let next = order(&items[run], &items[run - 1]);
            if (descending && next >= 0.0) || (!descending && next < 0.0) {
                break;
            }
            run += 1;
        }
        if descending {
            items[..run].reverse();
        }
    }
    for start in run..length {
        let (mut left, mut right) = (0, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if order(&items[start], &items[mid]) < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        items[left..=start].rotate_right(1);
    }
}

/// Which line of the pool to try next.
///
/// Request: `{ candidates: [null | { enabled, providerId, limitState,
/// limitReason, tier, cli, model, priority, index, usedPercent, trustDomain,
/// priced, blended }], attempted: [id], stickyProviderId, preferredTier,
/// ladder: null | [tier], pinned: null | { providerId, cli, model }, preferCli,
/// byPrice, byQuota }`. Answer: `{ candidate: position | null, skipped: [{
/// index: position, reason: string | null }] }` — a null reason is the
/// candidate's own `limitReason`.
pub fn choose_candidate(input: &str) -> Result<String, String> {
    let request = parse(input)?;
    Ok(choose_candidate_of(&request).to_string())
}

fn choose_candidate_of(request: &Value) -> Value {
    let list = |key: &str| request.get(key).and_then(Value::as_array);
    let attempted: Vec<Js<'_>> = list("attempted")
        .into_iter()
        .flatten()
        .map(|id| js(Some(id)))
        .collect();
    let order = Order {
        sticky: js(request.get("stickyProviderId")),
        preferred_tier: js(request.get("preferredTier")),
        ladder: list("ladder").map(|tiers| tiers.iter().map(|tier| js(Some(tier))).collect()),
        pinned: request.get("pinned").and_then(Value::as_object),
        prefer_cli: js(request.get("preferCli")),
        by_price: js(request.get("byPrice")).truthy(),
        by_quota: js(request.get("byQuota")).truthy(),
    };
    let mut usable = Vec::new();
    let mut skipped = Vec::new();
    for (at, candidate) in list("candidates").into_iter().flatten().enumerate() {
        let Some(fields) = candidate.as_object() else {
            continue;
        };
        let line = Line { at, fields };
        let id = line.get("providerId");
        if line.get("enabled").strict_eq(Js::Bool(false))
            || attempted.iter().any(|seen| seen.same_value_zero(id))
        {
            continue;
        }
        if line.get("limitState").is("exhausted") {
            let reason = if line.get("limitReason").truthy() {
                Value::Null
            } else {
                json!("fresh_limit_exhausted")
            };
            skipped.push(json!({ "index": at, "reason": reason }));
        } else {
            usable.push(line);
        }
    }
    js_sort(&mut usable, |left, right| order.compare(left, right));
    json!({ "candidate": usable.first().map(|line| line.at), "skipped": skipped })
}

// ── failover_safety ─────────────────────────────────────────────────────────

/// Whether a failed attempt may move to another line.
///
/// Request: `{ decision: null | { reason, error?: { retryBudgetExhausted,
/// httpStatus, category, phase, partialOutput, sideEffects } }, attempt: null |
/// { replayFence, visibleOutputObserved, toolIntentObserved,
/// sideEffectObserved } }`. Answer: `{ ok, reason }`.
///
/// A failure without a classified error decision is an opaque crash, non-zero
/// exit or watchdog kill — the case the pool exists for — so it switches as
/// `unknown`, still behind the replay fence. A spent same-provider retry or
/// request budget is likewise not a stop condition: the next line is the
/// remedy, and the caller's candidate pool bounds the loop.
pub fn failover_safety(input: &str) -> Result<String, String> {
    let request = parse(input)?;
    Ok(failover_safety_of(&request).to_string())
}

fn replay_fence_closed(request: &Value) -> bool {
    let attempt = request.get("attempt").and_then(Value::as_object);
    attempt.is_none()
        || !field(attempt, "replayFence").is("none")
        || [
            "visibleOutputObserved",
            "toolIntentObserved",
            "sideEffectObserved",
        ]
        .iter()
        .any(|key| field(attempt, key).truthy())
}

fn failover_safety_of(request: &Value) -> Value {
    let refuse = |reason: &str| json!({ "ok": false, "reason": reason });
    let decision = request.get("decision").and_then(Value::as_object);
    let Some(error) = decision
        .and_then(|d| d.get("error"))
        .and_then(Value::as_object)
    else {
        return if replay_fence_closed(request) {
            refuse("provider_replay_fence_closed")
        } else {
            json!({ "ok": true, "reason": "failover_unknown" })
        };
    };
    let error = Some(error);
    let status = field(error, "httpStatus").number();
    let upstream_4xx =
        status.is_finite() && status.trunc() == status && (400.0..=499.0).contains(&status);
    // A blocklisted category never switches, even when an adapter happens to
    // attach a 4xx status to it (a local cancellation dressed up as HTTP 499).
    let category = match field(error, "category") {
        value if value.truthy() => value,
        _ => Js::Str("unknown"),
    };
    if NON_FAILOVER_CATEGORIES.iter().any(|name| category.is(name)) {
        return refuse("category_not_failoverable");
    }
    if !SAFE_PHASES.contains(&field(error, "phase").text_or_empty().as_ref()) {
        return refuse("unsafe_failure_phase");
    }
    if field(error, "partialOutput").truthy() || field(error, "sideEffects").truthy() {
        return refuse("unsafe_replay_boundary");
    }
    if replay_fence_closed(request) {
        return refuse("provider_replay_fence_closed");
    }
    let provider_fault = PROVIDER_FAULT_CATEGORIES
        .iter()
        .any(|name| category.is(name));
    let reason = if !provider_fault && upstream_4xx {
        "failover_http_4xx".to_string()
    } else {
        format!("failover_{}", category.text())
    };
    json!({ "ok": true, "reason": reason })
}

/// The policy's exported constants.
pub fn facts() -> String {
    json!({
        "nonFailoverCategories": NON_FAILOVER_CATEGORIES,
        "safePhases": SAFE_PHASES,
        "nearLimitPercent": NEAR_LIMIT_PERCENT as u32,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(run: fn(&str) -> Result<String, String>, request: Value) -> Value {
        serde_json::from_str(&run(&request.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn string_to_number_follows_js() {
        for (text, expected) in [
            ("", 0.0),
            ("  42 ", 42.0),
            ("\u{feff}7", 7.0),
            ("-0", -0.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("0x1F", 31.0),
            ("0b101", 5.0),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(string_to_number(text), expected, "{text:?}");
        }
        for text in [
            "inf", "nan", "1_000", "-0x10", "0x", "1e", ".", "+", "\u{85}1",
        ] {
            assert!(string_to_number(text).is_nan(), "{text:?}");
        }
        assert!(string_to_number("-0").is_sign_negative());
    }

    #[test]
    fn number_text_matches_js() {
        assert_eq!(Js::Num(-0.0).text(), "0");
        assert_eq!(Js::Num(1e21).text(), "1e+21");
        assert_eq!(Js::Num(f64::NAN).text(), "NaN");
        assert_eq!(Js::Num(0.1 + 0.2).text(), "0.30000000000000004");
    }

    #[test]
    fn limit_state_reads_windows_and_parks() {
        let entry = |windows: Value| {
            json!({ "entry": { "fetchedAt": 990_000, "status": "ok",
                "summary": { "windows": windows } }, "now": 1_000_000 })
        };
        assert_eq!(
            call(
                limit_state,
                entry(json!([{ "usedPercent": 40, "resetMs": 2_000_000 },
                { "usedPercent": 72, "resetMs": 9_000_000 }]))
            ),
            json!({ "state": "available", "reason": "fresh_limit_available", "usedPercent": 72.0 })
        );
        assert_eq!(
            call(
                limit_state,
                entry(json!([{ "usedPercent": 100, "resetMs": 2_000_000 }]))
            )["state"],
            "exhausted"
        );
        let park = |model: Value| {
            json!({ "entry": { "summary": { "kind": "availability", "status": "rejected",
                "scope": "model", "model": "claude-fable-5-1", "blockedUntilMs": 5_000 } },
                "now": 1_000, "model": model })
        };
        assert_eq!(
            call(limit_state, park(json!("fable")))["reason"],
            "provider_model_cooldown_active"
        );
        assert_eq!(
            call(limit_state, park(json!("claude-sonnet-4")))["reason"],
            "provider_model_cooldown_other_model"
        );
        assert_eq!(call(limit_state, park(Value::Null))["state"], "exhausted");
        assert_eq!(
            call(limit_state, json!({ "entry": null, "now": 0 }))["reason"],
            "limit_unknown"
        );
    }

    #[test]
    fn a_full_window_whose_reset_has_passed_is_offered_back() {
        // The reading is hours old (the default staleness is five minutes) and
        // nothing has re-read the quota since: an unused line produces no new
        // readings, so the reset time is the only evidence there will be.
        let at = |windows: Value| {
            call(
                limit_state,
                json!({ "entry": { "fetchedAt": 1_000, "status": "ok",
                    "summary": { "windows": windows } }, "now": 20_000_000 }),
            )
        };
        let week = |used: u32| json!({ "usedPercent": used, "resetMs": 90_000_000 });
        let elapsed = json!({ "usedPercent": 100, "resetMs": 10_000_000 });
        let reason = |verdict: &Value| verdict["reason"].clone();

        let back = at(json!([elapsed, week(40)]));
        assert_eq!(back["state"], "stale");
        assert_eq!(reason(&back), json!("limit_window_reset_elapsed"));
        assert_eq!(
            back["usedPercent"],
            Value::Null,
            "an old reading steers nothing"
        );

        // The weekly cap is still running and nearly spent: stay away.
        assert_eq!(
            reason(&at(json!([elapsed, week(95)]))),
            json!("limit_stale")
        );
        // A cap that has not rolled over keeps the line out.
        let held = at(json!([{ "usedPercent": 100, "resetMs": 30_000_000 }, week(40)]));
        assert_eq!(held["state"], "exhausted");
        assert_eq!(reason(&held), json!("limit_window_full_until_reset"));
        // One rolled-over cap does not hide another that is still full.
        let still_full = at(json!([elapsed, { "usedPercent": 100, "resetMs": 80_000_000 }]));
        assert_eq!(still_full["state"], "exhausted");
        // Nothing was blocking: a window that was not full is just old news.
        let idle = at(json!([{ "usedPercent": 60, "resetMs": 10_000_000 }]));
        assert_eq!(reason(&idle), json!("limit_stale"));
        // Single-figure summaries (no window list) read the same way.
        let single = |reset: u32| {
            call(
                limit_state,
                json!({ "entry": { "fetchedAt": 1_000, "status": "ok",
                    "summary": { "usedPercentage": 100, "resetsAtMs": reset } },
                    "now": 20_000_000 }),
            )
        };
        assert_eq!(
            reason(&single(10_000_000)),
            json!("limit_window_reset_elapsed")
        );
        assert_eq!(single(30_000_000)["state"], "exhausted");
    }

    #[test]
    fn a_line_offered_back_after_its_reset_reclaims_its_place() {
        let line = |id: &str, priority: u32, state: &str, reason: &str| {
            json!({ "providerId": id, "priority": priority, "index": priority,
                "limitState": state, "limitReason": reason })
        };
        let choose = |lines: Value| {
            call(
                choose_candidate,
                json!({ "candidates": lines, "attempted": [], "stickyProviderId": "fallback" }),
            )["candidate"]
                .clone()
        };
        let fallback = line("fallback", 1, "available", "fresh_limit_available");
        assert_eq!(
            choose(json!([
                line("first", 0, "stale", "limit_window_reset_elapsed"),
                fallback
            ])),
            json!(0)
        );
        assert_eq!(
            choose(json!([line("first", 0, "stale", "limit_stale"), fallback])),
            json!(1),
            "an unmeasured line still stays behind"
        );
    }

    #[test]
    fn stickiness_yields_only_to_a_recovered_earlier_line() {
        let line = |id: &str, priority: u32, state: &str| json!({ "providerId": id, "priority": priority, "index": priority, "limitState": state });
        let choose = |sticky: &str, lines: Value| {
            call(
                choose_candidate,
                json!({ "candidates": lines, "attempted": [],
                "stickyProviderId": sticky }),
            )["candidate"]
                .clone()
        };
        let pool = json!([line("first", 0, "stale"), line("fallback", 1, "available")]);
        assert_eq!(
            choose("fallback", pool),
            json!(1),
            "an unmeasured line stays behind"
        );
        let pool = json!([
            line("first", 0, "available"),
            line("fallback", 1, "available")
        ]);
        assert_eq!(
            choose("fallback", pool),
            json!(0),
            "a recovered line reclaims its place"
        );
        let skipped = call(
            choose_candidate,
            json!({ "candidates": [line("dead", 0, "exhausted")], "attempted": [] }),
        );
        assert_eq!(
            skipped,
            json!({ "candidate": null, "skipped": [{ "index": 0, "reason": "fresh_limit_exhausted" }] })
        );
    }

    #[test]
    fn quota_first_only_intervenes_when_a_line_runs_low() {
        let line = |id: &str, used: Option<f64>, priority: u32| {
            let mut line = json!({ "providerId": id, "priority": priority, "index": priority,
                "limitState": "available" });
            if let Some(used) = used {
                line["usedPercent"] = json!(used);
            }
            line
        };
        let pick = |by_quota: bool, sticky: &str, lines: Value| {
            call(
                choose_candidate,
                json!({ "candidates": lines, "attempted": [],
                "stickyProviderId": sticky, "byQuota": by_quota }),
            )["candidate"]
                .clone()
        };
        // Healthy on both sides (each with over a fifth of the window left):
        // quota never reorders — the pool's own order and stickiness stand.
        let healthy = json!([
            line("prio-first", Some(70.0), 0),
            line("roomy", Some(10.0), 1)
        ]);
        assert_eq!(pick(true, "", healthy.clone()), json!(0));
        assert_eq!(pick(true, "prio-first", healthy), json!(0));
        // Under a fifth left (usage over 80%): the draining line yields to any
        // measured line with more than that — even the sticky route. That is
        // the mid-task interruption the option exists to avoid.
        let draining = json!([
            line("draining", Some(85.0), 0),
            line("spare", Some(40.0), 1)
        ]);
        assert_eq!(pick(true, "", draining.clone()), json!(1));
        assert_eq!(pick(true, "draining", draining.clone()), json!(1));
        // Off: the same draining route is kept until it actually dies.
        assert_eq!(pick(false, "draining", draining), json!(0));
        // Both draining, neither near-limit yet: the roomier one answers
        // first; a sticky route among draining lines does not churn.
        let both = json!([
            line("worse", Some(88.0), 0),
            line("less-bad", Some(82.0), 1)
        ]);
        assert_eq!(pick(true, "", both.clone()), json!(1));
        assert_eq!(pick(true, "worse", both), json!(0));
        // An unmeasured line is never judged tight: the sticky blind route
        // survives even a measured draining challenger.
        let mixed = json!([line("blind", None, 0), line("draining", Some(85.0), 1)]);
        assert_eq!(pick(true, "blind", mixed), json!(0));
    }

    #[test]
    fn lone_surrogate_reaches_rules_not_a_transport_error() {
        // The bridge JSON.stringify's sliced-emoji strings as "\ud834"; a
        // strict parse would fail every such call as invalid_policy_request
        // where the old JS implementation simply ran the rules.
        let input = r#"{"entry":{"summary":{"kind":"\ud834","status":"x"}},"now":100}"#;
        let answer = limit_state(input).expect("lenient parse must reach the rules");
        assert!(answer.starts_with(r#"{"state":"#));
    }

    #[test]
    fn sort_replays_v8_on_an_intransitive_comparator() {
        // 0 < 1 < 2 < 0: the answer depends on the comparison sequence alone.
        // Expected values are what node 26's Array.prototype.sort returns.
        let beats = |a: &u8, b: &u8| match (a, b) {
            (0, 1) | (1, 2) | (2, 0) => -1.0,
            (x, y) if x == y => 0.0,
            _ => 1.0,
        };
        for (input, expected) in [
            ([0, 1, 2], [0, 1, 2]),
            ([2, 1, 0], [1, 2, 0]),
            ([1, 0, 2], [0, 1, 2]),
            ([2, 0, 1], [2, 0, 1]),
            ([0, 2, 1], [2, 0, 1]),
            ([1, 2, 0], [1, 2, 0]),
        ] {
            let mut items: [u8; 3] = input;
            js_sort(&mut items, beats);
            assert_eq!(items, expected, "{input:?}");
        }
    }

    #[test]
    fn failover_is_a_blocklist_behind_replay_gates() {
        let safety = |error: Value, attempt: Value| {
            call(
                failover_safety,
                json!({ "decision": { "error": error }, "attempt": attempt }),
            )
        };
        let open = json!({ "replayFence": "none" });
        assert_eq!(
            safety(
                json!({ "category": "rate_limit", "phase": "request" }),
                open.clone()
            )["reason"],
            "failover_rate_limit"
        );
        assert_eq!(
            safety(json!({ "phase": "connect" }), open.clone())["reason"],
            "failover_unknown"
        );
        assert_eq!(
            safety(
                json!({ "category": "weird", "phase": "connect", "httpStatus": "418" }),
                open.clone()
            )["reason"],
            "failover_http_4xx"
        );
        assert_eq!(
            safety(
                json!({ "category": "cancel_shutdown", "phase": "connect", "httpStatus": 499 }),
                open.clone()
            )["reason"],
            "category_not_failoverable"
        );
        assert_eq!(
            safety(
                json!({ "category": "network", "phase": "streaming" }),
                open.clone()
            )["reason"],
            "unsafe_failure_phase"
        );
        assert_eq!(
            safety(
                json!({ "category": "network", "phase": "connect" }),
                Value::Null
            )["reason"],
            "provider_replay_fence_closed"
        );
        // A failure with no classified decision is an opaque crash or watchdog
        // kill: it switches unless the replay fence is closed.
        assert_eq!(
            call(
                failover_safety,
                json!({ "decision": null, "attempt": open.clone() })
            )["reason"],
            "failover_unknown"
        );
        assert_eq!(
            call(
                failover_safety,
                json!({ "decision": null, "attempt": null })
            )["reason"],
            "provider_replay_fence_closed"
        );
        // A spent same-provider retry/request budget is not a stop condition.
        assert_eq!(
            safety(
                json!({
                    "category": "network", "phase": "request",
                    "retryBudgetExhausted": true
                }),
                open.clone()
            )["reason"],
            "failover_network"
        );
        assert_eq!(
            call(
                failover_safety,
                json!({
                    "decision": { "reason": "request_budget_exhausted", "error": {
                        "category": "timeout", "phase": "request"
                    } },
                    "attempt": open.clone()
                })
            )["reason"],
            "failover_timeout"
        );
        // A spawn failure / provider-specific configuration error moves on.
        assert_eq!(
            safety(
                json!({ "category": "adapter_configuration", "phase": "connect" }),
                open.clone()
            )["reason"],
            "failover_adapter_configuration"
        );
    }
}
