//! Account quota protection, shared by the front door settings API and the
//! inference host. Node only supplies its cache entry and invokes callbacks.
pub mod settings;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;

use crate::js::{js_to_number, js_to_string, truthy, JsValue};

pub const PERCENT_KEYS: [&str; 3] = ["fiveHourPercent", "weeklyPercent", "monthlyPercent"];
const DEFAULT_AGE: f64 = 1_800_000.0;
const UNDEFINED: JsValue = JsValue::Undefined;

pub fn prop<'a>(value: &'a JsValue, key: &str) -> &'a JsValue {
    value.get(key).unwrap_or(&UNDEFINED)
}

pub fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::object(entries)
}

pub fn set(value: &mut JsValue, key: &str, member: JsValue) {
    if let JsValue::Object(entries) = value {
        if let Some((_, old)) = entries.iter_mut().find(|(name, _)| name == key) {
            *old = member;
        } else {
            entries.push((key.into(), member));
        }
    }
}

pub fn merge(left: &JsValue, right: &JsValue) -> JsValue {
    let mut result = left.clone();
    if let JsValue::Object(entries) = right {
        for (name, value) in entries {
            set(&mut result, &name.to_string_lossy(), value.clone());
        }
    }
    result
}

pub fn clean(value: &JsValue) -> String {
    if value.is_nullish() {
        String::new()
    } else {
        js_to_string(value).trim().to_string_lossy()
    }
}

fn empty_string(value: &JsValue) -> bool {
    matches!(value, JsValue::String(text) if text.is_empty())
}

pub fn percent_of(value: &JsValue) -> Option<f64> {
    let number = js_to_number(value);
    (!value.is_nullish() && !empty_string(value) && number.is_finite()).then(|| {
        if number <= 0.0 {
            0.0
        } else {
            number.min(100.0)
        }
    })
}

pub fn reading_age_of(value: &JsValue) -> Option<f64> {
    let number = js_to_number(value);
    (!value.is_nullish() && !empty_string(value) && (60_000.0..=604_800_000.0).contains(&number))
        .then(|| number.trunc())
}

pub fn defaults() -> JsValue {
    object(vec![
        ("enabled", true.into()),
        ("fiveHourPercent", 98.0.into()),
        ("weeklyPercent", 98.0.into()),
        ("monthlyPercent", 98.0.into()),
        ("scope", "official".into()),
        ("maxReadingAgeMs", DEFAULT_AGE.into()),
    ])
}

pub fn normalize_config(source: &JsValue) -> JsValue {
    let mut result = defaults();
    set(
        &mut result,
        "enabled",
        (!matches!(prop(source, "enabled"), JsValue::Bool(false))).into(),
    );
    for key in PERCENT_KEYS {
        set(
            &mut result,
            key,
            percent_of(prop(source, key)).unwrap_or(98.0).into(),
        );
    }
    if clean(prop(source, "scope")).to_lowercase() == "all" {
        set(&mut result, "scope", "all".into());
    }
    set(
        &mut result,
        "maxReadingAgeMs",
        reading_age_of(prop(source, "maxReadingAgeMs"))
            .unwrap_or(DEFAULT_AGE)
            .into(),
    );
    result
}

pub fn env_config(env: &JsValue) -> JsValue {
    let mut patch = object(vec![]);
    let enabled = prop(env, "MULTICC_QUOTA_GUARD");
    if !enabled.is_nullish() && !empty_string(enabled) {
        let enabled = !matches!(
            clean(enabled).to_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        );
        set(&mut patch, "enabled", enabled.into());
    }
    if let Some(all) = percent_of(prop(env, "MULTICC_QUOTA_GUARD_PERCENT")) {
        for key in PERCENT_KEYS {
            set(&mut patch, key, all.into());
        }
    }
    for (key, name) in PERCENT_KEYS.into_iter().zip([
        "MULTICC_QUOTA_GUARD_5H_PERCENT",
        "MULTICC_QUOTA_GUARD_WEEKLY_PERCENT",
        "MULTICC_QUOTA_GUARD_MONTHLY_PERCENT",
    ]) {
        if let Some(number) = percent_of(prop(env, name)) {
            set(&mut patch, key, number.into());
        }
    }
    let scope = clean(prop(env, "MULTICC_QUOTA_GUARD_SCOPE")).to_lowercase();
    if matches!(scope.as_str(), "all" | "official") {
        set(&mut patch, "scope", scope.into());
    }
    if let Some(age) = reading_age_of(prop(env, "MULTICC_QUOTA_GUARD_MAX_READING_AGE_MS")) {
        set(&mut patch, "maxReadingAgeMs", age.into());
    }
    patch
}

pub fn window_kind(value: &JsValue) -> Option<&'static str> {
    match clean(value).to_lowercase().as_str() {
        "5h" | "five_hour" | "five-hour" | "session" | "5-hour" => Some("five_hour"),
        "7d" | "1wk" | "weekly" | "week" | "7-day" | "seven_day" => Some("weekly"),
        "1m" | "30d" | "monthly" | "month" | "30-day" => Some("monthly"),
        _ => None,
    }
}

pub fn threshold_for<'a>(kind: &JsValue, config: &'a JsValue) -> &'a JsValue {
    let key = match kind {
        JsValue::String(text) => match text.to_string_lossy().as_str() {
            "five_hour" => "fiveHourPercent",
            "weekly" => "weeklyPercent",
            "monthly" => "monthlyPercent",
            _ => return &JsValue::Null,
        },
        _ => return &JsValue::Null,
    };
    prop(config, key)
}

pub fn live_windows(entry: &JsValue) -> Vec<JsValue> {
    let summary = prop(entry, "summary");
    if matches!(prop(summary, "kind"), JsValue::String(text) if text == "availability" || text == "balance")
    {
        return vec![];
    }
    let mut rows = vec![];
    let mut push = |window: &JsValue, used: &JsValue, reset: &JsValue, top_level: bool| {
        if used.is_nullish() {
            return;
        }
        let Some(used) = percent_of(used) else {
            return;
        };
        let Some(kind) = window_kind(window).or(top_level.then_some("five_hour")) else {
            return;
        };
        let reset = js_to_number(reset);
        // Preserve the original UTF-16 window label, including lone surrogates.
        let window = if clean(window).is_empty() {
            kind.into()
        } else {
            JsValue::String(js_to_string(window).trim())
        };
        rows.push(object(vec![
            ("kind", kind.into()),
            ("window", window),
            ("usedPercent", used.into()),
            (
                "resetMs",
                if reset.is_finite() && reset > 0.0 {
                    reset.into()
                } else {
                    JsValue::Null
                },
            ),
        ]));
    };
    if let JsValue::Array(windows) = prop(summary, "windows") {
        for window in windows {
            push(
                prop(window, "window"),
                prop(window, "usedPercent"),
                prop(window, "resetMs"),
                false,
            );
        }
    }
    push(
        prop(summary, "window"),
        prop(summary, "usedPercentage"),
        prop(summary, "resetsAtMs"),
        true,
    );
    rows
}

fn verdict(reason: &str) -> JsValue {
    object(vec![("blocked", false.into()), ("reason", reason.into())])
}

pub fn guard_verdict(entry: &JsValue, config: &JsValue, now: f64) -> JsValue {
    let settings = normalize_config(config);
    if !truthy(prop(&settings, "enabled")) {
        return verdict("guard_disabled");
    }
    if !matches!(
        entry,
        JsValue::Object(_) | JsValue::Array(_) | JsValue::Bytes(_) | JsValue::Date(_)
    ) {
        return verdict("no_reading");
    }
    let mut hits: Vec<JsValue> = live_windows(entry)
        .into_iter()
        .filter_map(|mut row| {
            let threshold = threshold_for(prop(&row, "kind"), &settings).clone();
            if js_to_number(prop(&row, "usedPercent")) >= js_to_number(&threshold)
                && js_to_number(prop(&row, "resetMs")) > now
            {
                set(&mut row, "threshold", threshold);
                Some(row)
            } else {
                None
            }
        })
        .collect();
    hits.sort_by(|left, right| {
        js_to_number(prop(right, "usedPercent"))
            .partial_cmp(&js_to_number(prop(left, "usedPercent")))
            .unwrap()
            .then_with(|| {
                js_to_number(prop(right, "resetMs"))
                    .partial_cmp(&js_to_number(prop(left, "resetMs")))
                    .unwrap()
            })
    });
    let Some(top) = hits.first() else {
        return verdict("below_threshold");
    };
    let reading_at = ["fetchedAt", "lastAttemptAt"]
        .into_iter()
        .map(|key| js_to_number(prop(entry, key)))
        .filter(|stamp| stamp.is_finite() && *stamp > 0.0)
        .reduce(f64::max);
    let stale = reading_at
        .is_some_and(|stamp| now - stamp > js_to_number(prop(&settings, "maxReadingAgeMs")));
    let mut out = object(vec![
        ("blocked", (!stale).into()),
        (
            "reason",
            if stale {
                "stale_reading".into()
            } else {
                format!("quota_guard_{}", clean(prop(top, "kind"))).into()
            },
        ),
    ]);
    for key in ["window", "kind", "usedPercent", "threshold"] {
        set(&mut out, key, prop(top, key).clone());
    }
    set(&mut out, "resetsAtMs", prop(top, "resetMs").clone());
    if stale {
        set(&mut out, "readingAtMs", reading_at.unwrap().into());
    } else {
        set(&mut out, "blockedUntilMs", prop(top, "resetMs").clone());
    }
    out
}

pub fn applies_to(provider_id: &JsValue, config: &JsValue) -> bool {
    let id = clean(provider_id);
    if id.is_empty() {
        return false;
    }
    if clean(prop(config, "scope")) == "all" {
        return true;
    }
    let id = id.to_ascii_lowercase();
    let Some((vendor, rest)) = id.split_once('-') else {
        return false;
    };
    !vendor.is_empty()
        && vendor.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && (rest == "official" || rest.starts_with("official-"))
}

/// Runtime-local file/config cache and refresh throttle. Files are tiny and
/// consulted once per five seconds; expensive scans never run on the host.
#[derive(Default)]
pub struct Guard {
    file: Option<PathBuf>,
    file_cache: Option<(SystemTime, JsValue)>,
    config_cache: Option<JsValue>,
    cached_at: f64,
    stale_notified_at: HashMap<String, f64>,
}

impl Guard {
    pub fn new(file: Option<PathBuf>) -> Self {
        Self {
            file,
            ..Self::default()
        }
    }

    pub fn config(&mut self, env: &JsValue, now: f64) -> JsValue {
        if let Some(config) = &self.config_cache {
            if now - self.cached_at < 5_000.0 {
                return config.clone();
            }
        }
        let saved = self
            .file
            .as_ref()
            .and_then(|file| {
                let modified = std::fs::metadata(file).ok()?.modified().ok()?;
                if let Some((mtime, raw)) = &self.file_cache {
                    if *mtime == modified {
                        return Some(raw.clone());
                    }
                }
                let bytes = std::fs::read(file).ok()?;
                let raw = crate::js::json_parse(&String::from_utf8_lossy(&bytes)).ok()?;
                self.file_cache = Some((modified, raw.clone()));
                Some(raw)
            })
            .unwrap_or_else(|| object(vec![]));
        let config = normalize_config(&merge(&merge(&object(vec![]), &saved), &env_config(env)));
        self.cached_at = now;
        self.config_cache = Some(config.clone());
        config
    }

    pub fn should_refresh(&mut self, id: &str, now: f64) -> bool {
        let elapsed = now - self.stale_notified_at.get(id).copied().unwrap_or(0.0);
        // `!(elapsed >= 60_000.0)` deliberately also rejects NaN, which a plain
        // `elapsed < 60_000.0` would let through; spell the partial order out.
        if !matches!(
            elapsed.partial_cmp(&60_000.0),
            Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
        ) {
            return false;
        }
        self.stale_notified_at.insert(id.to_string(), now);
        true
    }
}

pub fn request(op: &str, input: &JsValue) -> Result<JsValue, String> {
    Ok(match op {
        "defaults" => defaults(),
        "normalizeConfig" => normalize_config(input),
        "envConfig" => env_config(input),
        "windowKind" => window_kind(input)
            .map(JsValue::from)
            .unwrap_or(JsValue::Null),
        "readingAgeOf" => reading_age_of(input)
            .map(JsValue::from)
            .unwrap_or(JsValue::Null),
        "thresholdFor" => threshold_for(prop(input, "kind"), prop(input, "config")).clone(),
        "liveWindows" => JsValue::Array(live_windows(input)),
        "guardVerdict" => guard_verdict(
            prop(input, "entry"),
            prop(input, "config"),
            js_to_number(prop(input, "now")),
        ),
        "appliesTo" => applies_to(prop(input, "providerId"), prop(input, "config")).into(),
        _ => return Err(format!("QUOTA_GUARD_INVALID_OPERATION: {op}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::{from_serde, to_serde};
    use serde_json::json;

    #[test]
    fn threshold_and_staleness_boundaries_release_only_with_evidence() {
        let now = 1_800_000_000_000.0;
        let mut entry = from_serde(&json!({"fetchedAt": now - DEFAULT_AGE,
        "summary": {"windows": [
            {"window": "5h", "usedPercent": 99, "resetMs": now + 1000.0},
            {"window": "7d", "usedPercent": 99, "resetMs": now + 2000.0}
        ]}}));
        let held = to_serde(&guard_verdict(&entry, &defaults(), now));
        assert_eq!(held["blocked"], true);
        assert_eq!(held["kind"], "weekly");
        let stale = to_serde(&guard_verdict(&entry, &defaults(), now + 1.0));
        assert_eq!(stale["reason"], "stale_reading");
        set(&mut entry, "lastAttemptAt", now.into());
        assert_eq!(
            to_serde(&guard_verdict(&entry, &defaults(), now + 1.0))["blocked"],
            true
        );
        assert_eq!(
            to_serde(&guard_verdict(&entry, &defaults(), now + 2000.0))["reason"],
            "below_threshold"
        );
    }

    #[test]
    fn nonfinite_values_and_provider_scope_keep_js_semantics() {
        let config = object(vec![
            ("fiveHourPercent", f64::NAN.into()),
            ("weeklyPercent", 0.0.into()),
        ]);
        let config = to_serde(&normalize_config(&config));
        assert_eq!(config["fiveHourPercent"], 98);
        assert_eq!(config["weeklyPercent"], 0);
        for id in ["CLAUDE-official", "codex-official-abc", "x9-official-"] {
            assert!(applies_to(&id.into(), &defaults()), "{id}");
        }
        for id in [
            "-official",
            "claude_official",
            "claude-officially",
            "外部-official",
        ] {
            assert!(!applies_to(&id.into(), &defaults()), "{id}");
        }
        let mut guard = Guard::default();
        assert!(guard.should_refresh("a", 60_000.0));
        assert!(!guard.should_refresh("a", 119_999.0));
        assert!(guard.should_refresh("a", 120_000.0));
        assert!(!guard.should_refresh("b", f64::NAN));
    }
}
