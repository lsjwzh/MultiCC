//! Local speech model artifacts, resumable HTTP validation and installation ownership.
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const SV_DIR: &str = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
pub struct Artifact {
    pub id: &'static str,
    pub file: &'static str,
    pub bytes: u64,
}
pub const ARTIFACTS: [Artifact; 3] = [
    Artifact {
        id: "tokens",
        file: "tokens.txt",
        bytes: 315894,
    },
    Artifact {
        id: "vad",
        file: "silero_vad.onnx",
        bytes: 643854,
    },
    Artifact {
        id: "recognizer",
        file: "model.int8.onnx",
        bytes: 239233841,
    },
];
impl Artifact {
    pub fn relative(&self) -> String {
        if self.id == "vad" {
            self.file.into()
        } else {
            format!("{SV_DIR}/{}", self.file)
        }
    }
    pub fn sources(&self) -> [String; 2] {
        if self.id == "vad" {
            let gh = format!(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{}",
                self.file
            );
            [gh.clone(), format!("https://gh-proxy.com/{gh}")]
        } else {
            ["huggingface.co", "hf-mirror.com"].map(|host| {
                format!(
                    "https://{host}/csukuangfj/{SV_DIR}/resolve/main/{}",
                    self.file
                )
            })
        }
    }
}
pub fn total_bytes() -> u64 {
    ARTIFACTS.iter().map(|a| a.bytes).sum()
}

pub struct DownloadLock {
    // A stable inode serializes reclaimed markers and prevents a slow live owner from
    // being evicted when its marker is six hours old. Dropping the file unlocks it.
    _guard: File,
    marker: PathBuf,
}
impl DownloadLock {
    pub fn acquire(root: &Path, now_ms: f64) -> io::Result<Option<Self>> {
        fs::create_dir_all(root)?;
        let guard = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(".download.guard"))?;
        if guard.try_lock_exclusive().is_err() {
            return Ok(None);
        }
        let marker = root.join(".download.lock");
        match fs::metadata(&marker) {
            Ok(info) => {
                let modified = info
                    .modified()?
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64()
                    * 1000.;
                if now_ms - modified < 6. * 3_600_000. {
                    return Ok(None);
                }
                fs::remove_file(&marker)?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)?;
        let lock = Self {
            _guard: guard,
            marker,
        };
        writeln!(file, "{}", std::process::id())?;
        Ok(Some(lock))
    }
}
impl Drop for DownloadLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.marker);
    }
}

pub enum ResponsePlan {
    Complete,
    Body { offset: u64, expected: Option<u64> },
}

fn invalid_range() -> String {
    "传输不完整（Content-Range 无法验证）".into()
}
fn range_value(value: Option<&str>) -> Result<&str, String> {
    let (unit, value) = value
        .and_then(|v| v.trim().split_once(' '))
        .ok_or_else(invalid_range)?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return Err(invalid_range());
    }
    Ok(value)
}
fn byte_count(value: &str) -> Result<u64, String> {
    if !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid_range());
    }
    value.parse().map_err(|_| invalid_range())
}
pub fn response_plan(
    status: u16,
    have: u64,
    length: Option<&str>,
    range: Option<&str>,
) -> Result<ResponsePlan, String> {
    if status == 416 {
        // Older mirrors omit Content-Range on 416. They historically signal an
        // already complete partial through the status code alone.
        let total = match range {
            Some(_) => byte_count(
                range_value(range)?
                    .strip_prefix("*/")
                    .ok_or_else(invalid_range)?,
            )?,
            None => have,
        };
        return if have > 0 && total == have {
            Ok(ResponsePlan::Complete)
        } else {
            Err(invalid_range())
        };
    }
    let length = length.map(|s| byte_count(s.trim())).transpose()?;
    match status {
        206 => {
            if range.is_none() {
                let expected = length
                    .map(|n| have.checked_add(n).ok_or_else(invalid_range))
                    .transpose()?;
                return Ok(ResponsePlan::Body {
                    offset: have,
                    expected,
                });
            }
            let (span, total) = range_value(range)?
                .split_once('/')
                .ok_or_else(invalid_range)?;
            let (start, end) = span.split_once('-').ok_or_else(invalid_range)?;
            let (start, end, total) = (byte_count(start)?, byte_count(end)?, byte_count(total)?);
            if start != have
                || end < start
                || end.checked_add(1) != Some(total)
                || length.is_some_and(|n| n != total - start)
            {
                return Err(invalid_range());
            }
            Ok(ResponsePlan::Body {
                offset: have,
                expected: Some(total),
            })
        }
        200..=299 => Ok(ResponsePlan::Body {
            offset: 0,
            expected: length,
        }),
        _ => Err(format!("HTTP {status}")),
    }
}

pub struct Progress {
    pub phase: &'static str,
    pub error: Option<String>,
    pub current: Option<usize>,
    pub started: f64,
    pub finished: f64,
    pub rate: f64,
    pub done: u64,
    pub total: u64,
    base: u64,
    last_at: f64,
    last_bytes: u64,
}
impl Default for Progress {
    fn default() -> Self {
        Self {
            phase: "missing",
            error: None,
            current: None,
            started: 0.,
            finished: 0.,
            rate: 0.,
            done: 0,
            total: total_bytes(),
            base: 0,
            last_at: 0.,
            last_bytes: 0,
        }
    }
}
impl Progress {
    pub fn begin(&mut self, at: f64) {
        *self = Self {
            phase: "downloading",
            started: at,
            ..Self::default()
        };
    }
    pub fn fail(&mut self, error: String) {
        self.phase = "failed";
        self.error = Some(error);
    }
    pub fn artifact(&mut self, index: usize) {
        self.current = Some(index);
        self.base = ARTIFACTS[..index].iter().map(|a| a.bytes).sum();
        self.done = self.base;
    }
    pub fn update(&mut self, at: f64, received: u64, expected: Option<u64>) {
        let i = self.current.expect("download in progress");
        self.done = self.base.saturating_add(received);
        if let Some(expected) = expected.filter(|n| *n > 0) {
            self.total = (total_bytes() - ARTIFACTS[i].bytes).saturating_add(expected);
        }
        if self.last_at != 0. {
            let elapsed = at - self.last_at;
            if elapsed < 1000. {
                return;
            }
            let instant = (self.done as f64 - self.last_bytes as f64) * 1000. / elapsed;
            self.rate = if self.rate != 0. {
                self.rate * 0.6 + instant * 0.4
            } else {
                instant
            };
        }
        self.last_at = at;
        self.last_bytes = self.done;
    }
    pub fn finish(&mut self, at: f64, ready: bool) {
        self.done = self.total;
        self.finished = at;
        if ready {
            self.phase = "ready";
        } else {
            self.fail("下载完成但模型文件校验失败".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_content_ranges_are_validated() {
        assert!(matches!(
            response_plan(206, 6, Some("4"), Some("bytes 6-9/10")),
            Ok(ResponsePlan::Body {
                offset: 6,
                expected: Some(10)
            })
        ));
        for range in [
            Some("bytes 5-8/9"),
            Some("bytes 6-8/10"),
            Some("bytes 6-9/*"),
            Some("bytes 6-4/5"),
        ] {
            assert!(response_plan(206, 6, None, range).is_err());
        }
        assert!(response_plan(206, 6, Some("3"), Some("bytes 6-9/10")).is_err());
        assert!(response_plan(416, 6, None, Some("bytes */5")).is_err());
        assert!(matches!(
            response_plan(416, 6, None, None),
            Ok(ResponsePlan::Complete)
        ));
        assert!(matches!(
            response_plan(416, 6, None, Some("bytes */6")),
            Ok(ResponsePlan::Complete)
        ));
    }
}
