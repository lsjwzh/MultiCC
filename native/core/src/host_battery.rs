//! Normalize host observations; unavailable is distinct from an empty battery.
use crate::js::js_trim;
use regex::Regex;
use std::sync::LazyLock;

#[derive(Clone)]
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

/// Read the operating system outside the host event loop. Both server paths
/// use the same command, locale, timeout, and child cancellation behavior.
#[cfg(target_os = "macos")]
pub async fn pmset_output() -> Option<String> {
    use std::time::Duration;
    let output = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::process::Command::new("/usr/bin/pmset")
            .args(["-g", "batt"])
            .env("LC_ALL", "C")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(any(target_os = "linux", test))]
pub async fn linux_supply(root: &std::path::Path) -> Option<(f64, String)> {
    for name in ["BAT0", "BAT1"] {
        let base = root.join(name);
        let Ok(capacity) = tokio::fs::read_to_string(base.join("capacity")).await else {
            continue;
        };
        let percent = crate::js::js_string_to_number(&capacity);
        if !(0.0..=100.0).contains(&percent) {
            continue;
        }
        let status = tokio::fs::read_to_string(base.join("status"))
            .await
            .unwrap_or_default();
        return Some((percent, status));
    }
    None
}

#[cfg(target_os = "macos")]
async fn probe() -> Option<Battery> {
    pmset(&pmset_output().await?)
}

#[cfg(target_os = "linux")]
async fn probe() -> Option<Battery> {
    let (percent, status) = linux_supply(std::path::Path::new("/sys/class/power_supply")).await?;
    Some(linux(percent, &status))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn probe() -> Option<Battery> {
    None
}

#[derive(Clone, Default)]
struct Sample {
    generation: u32,
    at_ms: Option<i128>,
    reading: Option<Battery>,
}

/// Cache per reader. One in-flight probe serves simultaneous requests and
/// the five-second window starts when that probe finishes, including failures.
#[derive(Default)]
pub struct HostReader(tokio::sync::Mutex<Sample>);

fn now_ms() -> i128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i128)
        .unwrap_or_else(|before| -(before.duration().as_millis() as i128))
}

impl HostReader {
    pub async fn read(&self) -> (u32, Option<Battery>) {
        self.read_with(now_ms, probe).await
    }

    async fn read_with<F: std::future::Future<Output = Option<Battery>>>(
        &self,
        now: impl Fn() -> i128,
        sample_host: impl FnOnce() -> F,
    ) -> (u32, Option<Battery>) {
        let mut sample = self.0.lock().await;
        if sample.at_ms.is_none_or(|at| now() - at >= 5000) {
            sample.reading = sample_host().await;
            sample.at_ms = Some(now());
            sample.generation = sample.generation.wrapping_add(1);
        }
        (sample.generation, sample.reading.clone())
    }
}

#[cfg(test)]
mod reader_tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn concurrent_reads_and_unavailable_samples_share_the_completion_window() {
        let reader = HostReader::default();
        let clock = Cell::new(0);
        let calls = Cell::new(0);
        let now = || clock.get();
        let sample = || async {
            calls.set(calls.get() + 1);
            tokio::task::yield_now().await;
            clock.set(clock.get() + 200);
            None
        };
        let (first, second) =
            tokio::join!(reader.read_with(now, sample), reader.read_with(now, sample));
        assert_eq!(first.0, second.0);
        assert!(first.1.is_none() && second.1.is_none());
        clock.set(-400);
        assert_eq!(reader.read_with(now, sample).await.0, first.0);
        clock.set(5199);
        assert_eq!(reader.read_with(now, sample).await.0, first.0);
        assert_eq!(calls.get(), 1);
        clock.set(5200);
        assert_ne!(reader.read_with(now, sample).await.0, first.0);
        assert_eq!(calls.get(), 2);
    }

    #[tokio::test]
    async fn linux_supply_skips_invalid_capacity_and_handles_absent_status() {
        let path = std::env::temp_dir().join(format!(
            "multicc-battery-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir(&path).unwrap();
        for (name, value) in [("BAT0", "invalid"), ("BAT1", "64\n")] {
            let battery = path.join(name);
            std::fs::create_dir(&battery).unwrap();
            std::fs::write(battery.join("capacity"), value).unwrap();
        }
        let (percent, status) = linux_supply(&path).await.unwrap();
        assert_eq!(percent, 64.0);
        assert_eq!(status, "");
        std::fs::write(path.join("BAT0/capacity"), "0").unwrap();
        std::fs::write(path.join("BAT0/status"), "Full\n").unwrap();
        let (percent, status) = linux_supply(&path).await.unwrap();
        assert_eq!(percent, 0.0);
        assert!(linux(percent, &status).plugged_in);
        std::fs::remove_dir_all(path).unwrap();
    }
}
