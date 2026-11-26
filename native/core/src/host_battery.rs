//! Normalize host observations; unavailable is distinct from an empty battery.
use crate::js::js_trim;
use regex::Regex;
use std::sync::LazyLock;

pub struct Battery {
    pub percent: f64,
    pub charging: bool,
    pub plugged_in: bool,
    pub remaining_minutes: Option<f64>,
}

// ECMAScript whitespace (not Unicode White_Space: U+0085 is excluded).
const SPACE: &str =
    r"[\t-\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
static PERCENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"([0-9]{{1,3}}){SPACE}*%")).unwrap());
static STATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"%;{SPACE}*([^;]+);")).unwrap());
static REMAINING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([0-9]+):([0-9]{2}) remaining").unwrap());

pub fn valid_percent(percent: f64) -> bool {
    (0.0..=100.0).contains(&percent)
}

pub fn pmset(source: &str) -> Option<Battery> {
    let line = source
        .split('\n')
        .find(|line| line.contains("InternalBattery"))?;
    let percent = PERCENT.captures(line)?[1].parse().ok()?;
    if !valid_percent(percent) {
        return None;
    }
    let state = STATE.captures(line);
    let state = state.as_ref().map(|c| js_trim(&c[1])).unwrap_or("");
    let remaining_minutes = REMAINING
        .captures(line)
        .map(|c| c[1].parse::<f64>().unwrap() * 60.0 + c[2].parse::<f64>().unwrap());
    Some(Battery {
        percent,
        charging: state.eq_ignore_ascii_case("charging")
            || state.eq_ignore_ascii_case("finishing charge"),
        plugged_in: source.contains("AC Power"),
        remaining_minutes,
    })
}

pub fn linux(percent: f64, status: &str) -> Battery {
    let status = js_trim(status);
    let charging = status.eq_ignore_ascii_case("charging");
    Battery {
        percent,
        charging,
        plugged_in: charging || status.eq_ignore_ascii_case("full"),
        remaining_minutes: None,
    }
}
