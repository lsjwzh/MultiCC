//! Battery telemetry in the gateway process. Concurrent requests share one probe.
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Reader(Mutex<Option<(Instant, Value)>>);

impl Reader {
    pub async fn read(&self) -> Value {
        let mut cache = self.0.lock().await;
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(5) {
                return value.clone();
            }
        }
        let value = probe().await.unwrap_or_else(|| json!({"available": false}));
        *cache = Some((Instant::now(), value.clone()));
        value
    }
}

#[cfg(target_os = "macos")]
async fn probe() -> Option<Value> {
    parse_pmset(&multicc_core::host_battery::pmset_output().await?)
}

#[cfg(any(target_os = "macos", test))]
fn parse_pmset(text: &str) -> Option<Value> {
    use regex::Regex;
    use std::sync::LazyLock;
    static PERCENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([0-9]{1,3})\s*%").unwrap());
    static STATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"%;\s*([^;]+);").unwrap());
    static TIME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"([0-9]+):([0-9]{2}) remaining").unwrap());
    let line = text.lines().find(|row| row.contains("InternalBattery"))?;
    let pct = PERCENT.captures(line)?[1]
        .parse::<u8>()
        .ok()
        .filter(|n| *n <= 100)?;
    let state = STATE
        .captures(line)
        .map(|m| m[1].trim().to_ascii_lowercase());
    let remaining = TIME
        .captures(line)
        .and_then(|m| Some(m[1].parse::<f64>().ok()? * 60.0 + m[2].parse::<f64>().ok()?));
    Some(
        json!({"available":true, "percent":pct, "charging":matches!(state.as_deref(), Some("charging" | "finishing charge")),
        "pluggedIn":text.contains("AC Power"), "remainingMinutes":remaining}),
    )
}

#[cfg(target_os = "linux")]
async fn probe() -> Option<Value> {
    let (percent, status) =
        multicc_core::host_battery::linux_supply(std::path::Path::new("/sys/class/power_supply"))
            .await?;
    let charging = status.trim().eq_ignore_ascii_case("charging");
    Some(
        json!({"available":true, "percent":percent, "charging":charging,
        "pluggedIn":charging || status.trim().eq_ignore_ascii_case("full"), "remainingMinutes":null}),
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
async fn probe() -> Option<Value> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn battery_line_selects_the_charge_state_and_time() {
        let source = "Now drawing from 'AC Power'\n -InternalBattery-0    25%; finishing charge; 1:26 remaining";
        assert_eq!(
            parse_pmset(source).unwrap(),
            json!({"available":true,"percent":25,"charging":true,"pluggedIn":true,"remainingMinutes":86.0})
        );
        assert!(parse_pmset("AC Power").is_none());
        assert!(parse_pmset("InternalBattery 101%; charged;").is_none());
    }
}
