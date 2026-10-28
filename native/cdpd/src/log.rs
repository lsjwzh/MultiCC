//! 守护进程日志：detached 启动时 stdio 全是 /dev/null，没有它出了事只能猜。
//! 只记元数据（连接、上游、租约、错误），**绝不记 CDP 帧内容** —— 里面有 cookie。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 1 << 20;

struct Sink {
    path: PathBuf,
    file: File,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

fn open(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

pub fn init(path: &Path) {
    rotate_if_large(path);
    if let Ok(file) = open(path) {
        *SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(Sink {
            path: path.to_path_buf(),
            file,
        });
    }
}

fn rotate_if_large(path: &Path) {
    if std::fs::metadata(path)
        .map(|m| m.len() > MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

pub fn write(message: String) {
    let line = format!("{} {message}\n", timestamp());
    let mut guard = SINK.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Some(sink) => {
            let _ = sink.file.write_all(line.as_bytes());
            if sink
                .file
                .metadata()
                .map(|m| m.len() > MAX_BYTES)
                .unwrap_or(false)
            {
                let path = sink.path.clone();
                rotate_if_large(&path);
                if let Ok(file) = open(&path) {
                    sink.file = file;
                }
            }
        }
        None => eprint!("{line}"),
    }
}

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::log::write(format!($($arg)*)) };
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// UTC，RFC 3339 秒级。不为一个时间戳引入 chrono。
pub fn timestamp() -> String {
    format_utc(now_ms() / 1000)
}

pub fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant 的 civil_from_days。
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn utc_formatting_matches_known_instants() {
        assert_eq!(super::format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(super::format_utc(1_793_192_288), "2026-10-28T12:58:08Z");
        assert_eq!(super::format_utc(951_782_400), "2000-02-29T00:00:00Z");
    }
}
