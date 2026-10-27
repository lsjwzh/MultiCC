//! 截图、帧缓存与冻结快照（移植 src/remote-screen.js 的 capture/frame/snapshot）。
//!
//! 两条路：
//!   · macOS：agent 只落无损原始 PNG，服务端再分四步（snap → sips 量尺寸 →
//!     sips 裁 → sips 转）；
//!   · Linux：抓屏 + 裁剪 + 编码由 agent 一次做完（`host.capture_direct`）。
//! 用 capture_direct 的**有无**选路，不按平台名判断。

use crate::agent::{agent_failed, AgentClient};
use crate::error::{AppError, AppResult};
use crate::host::{CaptureInfo, Host};
use crate::region::{crop_geometry, js_num, Region};
use bytes::Bytes;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::OnceCell;

pub const SESSION: &str = "remote-screen";
pub const KEEP_SHOTS: usize = 20;

/// 帧缓存窗口要盖过两个真实客户端的轮询间隔（web 600ms / App 700ms）才能命中：
/// 450ms 时两者每轮都 miss，等于没缓存。取 650ms：单端隔帧共享（采集频率砍半），
/// web+App 同看时几乎全程共享同一帧。输入事件会清缓存，点完仍立刻拿到新帧。
pub const FRAME_CACHE_MS: u64 = 650;

#[derive(Clone, Debug)]
pub struct Frame {
    pub key: String,
    pub at: Instant,
    pub size: CaptureInfo,
    pub data: Bytes,
}

pub struct Screen {
    pub dir: PathBuf,
    pub host: Arc<Host>,
    pub agent: Arc<dyn AgentClient>,
    last_frame: Mutex<Option<Frame>>,
    inflight: Mutex<HashMap<String, Arc<OnceCell<AppResult<Frame>>>>>,
}

impl Screen {
    pub fn new(dir: PathBuf, host: Arc<Host>, agent: Arc<dyn AgentClient>) -> Self {
        Self {
            dir,
            host,
            agent,
            last_frame: Mutex::new(None),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    /// 输入事件之后画面一定变了：清缓存，下一次请求立刻重拍。
    pub fn invalidate(&self) {
        *self.last_frame.lock().unwrap() = None;
    }

    pub async fn capture(&self, out: &Path, region: Option<Region>) -> AppResult<CaptureInfo> {
        self.host.assert_supported()?;
        let out_str = out.to_string_lossy().into_owned();
        let want_jpeg = is_jpeg_path(&out_str);
        let quality = if region.is_some() { 85 } else { 60 };
        let _ = std::fs::create_dir_all(&self.dir);
        // Linux：agent 一次做完抓屏 + 裁剪 + 编码。
        if self.host.has_capture_direct() {
            return self
                .host
                .capture_direct(&out_str, region, SESSION, want_jpeg, quality)
                .await;
        }
        let work = mkdtemp(&self.dir, ".capture-")?;
        let result = self
            .capture_mac(&work, &out_str, region, want_jpeg, quality)
            .await;
        let _ = std::fs::remove_dir_all(&work);
        result
    }

    async fn capture_mac(
        &self,
        work: &Path,
        out: &str,
        region: Option<Region>,
        want_jpeg: bool,
        quality: u32,
    ) -> AppResult<CaptureInfo> {
        let raw = work.join("raw.png");
        let raw_str = raw.to_string_lossy().into_owned();
        let reply = self
            .agent
            .call(
                json!({ "op": "snap", "path": raw_str, "session": SESSION }),
                Some(Duration::from_millis(10000)),
            )
            .await;
        if agent_failed(&reply) {
            let message = reply
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("snap-failed")
                .to_string();
            return Err(AppError::from_agent(502, message, reply));
        }
        let phys = self.host.image_size(&raw_str).await?;
        // 先按原生像素裁，再编码：局部放大因此保留原始细节（v2.4.1）。
        let size = self.host.logical_size(phys.width, phys.height).await;
        let mut source = raw_str.clone();
        let mut area: Option<Value> = None;
        if let Some(region) = region {
            let geometry =
                crop_geometry(region, (size.width, size.height), (phys.width, phys.height))?;
            let crop = work.join("crop.png").to_string_lossy().into_owned();
            self.host.crop_image(&raw_str, geometry, &crop).await?;
            source = crop;
            area = Some(geometry.to_json());
        }
        let resample = if region.is_none() && size.width > 0.0 && size.width < phys.width {
            Some(size.width)
        } else {
            None
        };
        self.host
            .convert_image(&source, out, want_jpeg, Some(quality), resample)
            .await?;
        Ok(CaptureInfo {
            width: if size.width > 0.0 {
                size.width
            } else {
                phys.width
            },
            height: if size.height > 0.0 {
                size.height
            } else {
                phys.height
            },
            region: area,
        })
    }

    /// 并发请求共用一次截图；同一区域在缓存窗口内直接命中。
    pub async fn frame(&self, region: Option<Region>) -> AppResult<Frame> {
        let key = Region::cache_key(region);
        if let Some(last) = self.last_frame.lock().unwrap().clone() {
            if last.key == key && last.at.elapsed() < Duration::from_millis(FRAME_CACHE_MS) {
                return Ok(last);
            }
        }
        let cell = {
            let mut inflight = self.inflight.lock().unwrap();
            inflight
                .entry(key.clone())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        let result = cell
            .get_or_init(|| self.capture_frame(key.clone(), region))
            .await
            .clone();
        let mut inflight = self.inflight.lock().unwrap();
        if inflight
            .get(&key)
            .map(|existing| Arc::ptr_eq(existing, &cell))
            .unwrap_or(false)
        {
            inflight.remove(&key);
        }
        result
    }

    async fn capture_frame(&self, key: String, region: Option<Region>) -> AppResult<Frame> {
        // Output files cannot be shared across different selections or snapshots.
        let work = mkdtemp(&self.dir, ".frame-")?;
        let out = work.join("live.jpg");
        let result = async {
            let size = self.capture(&out, region).await?;
            let data = tokio::fs::read(&out)
                .await
                .map_err(|error| AppError::new(502, error.to_string()))?;
            Ok(Frame {
                key,
                at: Instant::now(),
                size,
                data: Bytes::from(data),
            })
        }
        .await;
        let _ = std::fs::remove_dir_all(&work);
        let frame = result?;
        *self.last_frame.lock().unwrap() = Some(frame.clone());
        Ok(frame)
    }

    pub async fn snapshot(&self, region: Option<Region>) -> AppResult<Value> {
        let file = self
            .dir
            .join(format!("shot-{}{:03}.png", now_ms(), random_below(1000)));
        let size = self.capture(&file, region).await?;
        if let Some(region_json) = &size.region {
            let _ = std::fs::write(
                format!("{}.json", file.display()),
                serde_json::to_string(region_json).unwrap_or_default(),
            );
        }
        self.prune_shots();
        let mut map = Map::new();
        map.insert("ok".into(), json!(true));
        map.insert("path".into(), json!(file.to_string_lossy()));
        map.insert("width".into(), js_num(size.width));
        map.insert("height".into(), js_num(size.height));
        map.insert("region".into(), size.region.clone().unwrap_or(Value::Null));
        map.insert("url".into(), json!(download_url(&file)));
        Ok(Value::Object(map))
    }

    /// 只留最近 KEEP_SHOTS 张：文件名排序即时间序，连 `.json` 一起删。
    pub fn prune_shots(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut shots: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(|s| s.to_string()))
            .filter(|name| is_shot_name(name))
            .collect();
        shots.sort();
        let keep = shots.len().saturating_sub(KEEP_SHOTS);
        for name in shots.into_iter().take(keep) {
            let _ = std::fs::remove_file(self.dir.join(&name));
            let _ = std::fs::remove_file(self.dir.join(format!("{name}.json")));
        }
    }
}

pub fn is_shot_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("shot-") else {
        return false;
    };
    let Some(digits) = rest.strip_suffix(".png") else {
        return false;
    };
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

pub fn download_url(file: &Path) -> String {
    format!(
        "/api/download?path={}&inline=1",
        encode_uri_component(&file.to_string_lossy())
    )
}

/// JS `encodeURIComponent`：A-Z a-z 0-9 - _ . ! ~ * ' ( ) 之外一律 %XX（UTF-8）。
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                *byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn is_jpeg_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".jpg") || lower.ends_with(".jpeg")
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn random_below(limit: u32) -> u32 {
    let mut buf = [0u8; 4];
    if getrandom::getrandom(&mut buf).is_err() {
        return 0;
    }
    u32::from_le_bytes(buf) % limit.max(1)
}

/// JS `fs.mkdtempSync(path.join(dir, prefix))`：同前缀 + 6 位随机后缀。
fn mkdtemp(dir: &Path, prefix: &str) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|error| AppError::new(502, error.to_string()))?;
    for _ in 0..64 {
        let suffix: String = {
            const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
            let mut buf = [0u8; 6];
            let _ = getrandom::getrandom(&mut buf);
            buf.iter()
                .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
                .collect()
        };
        let path = dir.join(format!("{prefix}{suffix}"));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::new(502, error.to_string())),
        }
    }
    Err(AppError::new(502, "mkdtemp-failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_urls_are_percent_encoded_like_the_browser_expects() {
        assert_eq!(
            download_url(Path::new("/Users/x/.multicc/assist/remote-screen/shot-1.png")),
            "/api/download?path=%2FUsers%2Fx%2F.multicc%2Fassist%2Fremote-screen%2Fshot-1.png&inline=1"
        );
        assert_eq!(encode_uri_component("a b'c(d)"), "a%20b'c(d)");
    }

    #[test]
    fn shot_names_are_timestamp_plus_three_digits() {
        assert!(is_shot_name("shot-1759000000000123.png"));
        assert!(!is_shot_name("shot-1.jpg"));
        assert!(!is_shot_name("shot-.png"));
        assert!(!is_shot_name("live.jpg"));
        assert!(!is_shot_name("shot-1.png.json"));
    }
}
