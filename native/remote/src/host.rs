//! Desktop host：这台机器上的桌面 Agent 是谁、能做什么（移植 src/desktop-host.js）。
//!
//! 「🖥 屏幕」的能力不来自 MultiCC 自己，而来自本机装的那个 desktop agent。
//! 这里是唯一回答「能做什么」和「这件事怎么做」的地方，路由只消费它：
//!   · profile —— 每个 OS 一份画像：传输方式、agent socket、功能矩阵、键盘修饰键
//!   · macOS 独有的三件壳外调用（逻辑尺寸 / 图像处理 / 唤屏）收在这里
//!
//! 画像只描述「这台机器应该怎样」，不发起任何调用。壳外命令走注入的 `Exec`，
//! 单测里可以整体替换；平台也可以注入，所以 Linux/win32 的用例在 macOS 上照样跑。

use crate::agent::HostCall;
use crate::error::{AppError, AppResult};
use crate::region::{js_num, js_num_str, CropArea, Region};
use futures_util::future::BoxFuture;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// `exec(cmd, args, timeout) -> stdout`，由调用方注入（真实现是 tokio 进程）。
pub type Exec = Arc<
    dyn Fn(String, Vec<String>, Duration) -> BoxFuture<'static, Result<String, String>>
        + Send
        + Sync,
>;

/// 功能矩阵是前端与路由的判断依据：只按这里的名字判断，不按平台名判断。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Features {
    pub view: bool,
    pub control: bool,
    pub snapshot: bool,
    pub annotate: bool,
    pub stream: bool,
    pub wake: bool,
    pub unlock: bool,
    pub element_tree: bool,
}

impl Features {
    pub const NONE: Features = Features {
        view: false,
        control: false,
        snapshot: false,
        annotate: false,
        stream: false,
        wake: false,
        unlock: false,
        element_tree: false,
    };
    pub const MAC: Features = Features {
        view: true,
        control: true,
        snapshot: true,
        annotate: true,
        stream: true,
        wake: true,
        unlock: true,
        element_tree: true,
    };
    /// Linux v1 没有 stream（RFB 未做，前端自动回退轮询）、没有 wake（X11 没有「唤屏」
    /// 这种系统调用，灭屏靠 DPMS，注入本来就会唤醒）、没有 unlock（锁屏是另一个会话的
    /// 窗口，够不到也不该够到）。elementTree 没有：X11 没有可访问性树 API。
    pub const LINUX: Features = Features {
        view: true,
        control: true,
        snapshot: true,
        annotate: true,
        stream: false,
        wake: false,
        unlock: false,
        element_tree: false,
    };

    pub fn to_json(self) -> Value {
        let mut map = Map::new();
        map.insert("view".into(), json!(self.view));
        map.insert("control".into(), json!(self.control));
        map.insert("snapshot".into(), json!(self.snapshot));
        map.insert("annotate".into(), json!(self.annotate));
        map.insert("stream".into(), json!(self.stream));
        map.insert("wake".into(), json!(self.wake));
        map.insert("unlock".into(), json!(self.unlock));
        map.insert("elementTree".into(), json!(self.element_tree));
        Value::Object(map)
    }
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub platform: String,
    pub label: String,
    pub supported: bool,
    pub transport: String,
    pub agent_sock: Option<String>,
    pub rfb_sock: Option<String>,
    pub h264_sock: Option<String>,
    pub features: Features,
    pub modifier: String,
    pub install_hint: Option<String>,
}

/// JS 的 `env.X || fallback`：空串也算没设置。
fn env_value(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key).filter(|v| !v.is_empty()).cloned()
}

fn join(dir: &str, name: &str) -> String {
    Path::new(dir).join(name).to_string_lossy().into_owned()
}

pub fn profile_for(platform: &str, home: &str, env: &HashMap<String, String>) -> Profile {
    if platform == "darwin" {
        let dir = env_value(env, "MULTICC_AGENT_DIR")
            .unwrap_or_else(|| join(home, ".multicc/agent"));
        return Profile {
            platform: platform.into(),
            label: "macOS".into(),
            supported: true,
            transport: "unix".into(),
            agent_sock: Some(
                env_value(env, "MULTICC_AGENT_SOCK").unwrap_or_else(|| join(&dir, "agent.sock")),
            ),
            rfb_sock: Some(
                env_value(env, "MULTICC_AGENT_RFB_SOCK").unwrap_or_else(|| join(&dir, "rfb.sock")),
            ),
            h264_sock: Some(
                env_value(env, "MULTICC_AGENT_H264_SOCK").unwrap_or_else(|| join(&dir, "h264.sock")),
            ),
            features: Features::MAC,
            modifier: "cmd".into(),
            // macOS 的 agent 随服务端启动自动装，不需要提示。
            install_hint: None,
        };
    }
    if platform == "win32" {
        // 计划中的 Windows agent：命名管道 + DXGI Desktop Duplication + SendInput，
        // v1 不做 unlock（安全桌面够不到）。
        return Profile {
            platform: platform.into(),
            label: "Windows".into(),
            supported: false,
            transport: "named-pipe".into(),
            agent_sock: Some(
                env_value(env, "MULTICC_AGENT_PIPE").unwrap_or_else(|| "\\\\.\\pipe\\multicc-agent".into()),
            ),
            rfb_sock: None,
            h264_sock: None,
            features: Features::NONE,
            modifier: "ctrl".into(),
            install_hint: None,
        };
    }
    // Linux agent：X11 走 XShm + XTEST。Wayland 会话里 XWayland 其实连得上，
    // 所以 supported 依然报 true —— 由 agent 自己认出 XWayland 后回 wayland-session，
    // 这比「整个平台不支持」更好排查，也不会在 XWayland 上假成功。
    //
    // installHint：Linux 的 agent 不随服务端自动装（要本机编译），连不上 agent 时
    // 前端把这条命令原样给用户。路径相对服务端目录（发行包里同样存在）。
    let runtime = env_value(env, "XDG_RUNTIME_DIR").unwrap_or_else(|| format!("/run/user/{}", uid()));
    Profile {
        platform: "linux".into(),
        label: "Linux".into(),
        supported: true,
        transport: "unix".into(),
        agent_sock: Some(
            env_value(env, "MULTICC_AGENT_SOCK")
                .unwrap_or_else(|| join(&join(&runtime, "multicc-agent"), "agent.sock")),
        ),
        rfb_sock: None,
        h264_sock: None,
        features: Features::LINUX,
        modifier: "ctrl".into(),
        install_hint: Some("sh scripts/linux-agent/install.sh install".into()),
    }
}

#[cfg(unix)]
fn uid() -> u32 {
    // SAFETY: getuid 无参数、无失败分支，随时可调。
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn uid() -> u32 {
    0
}

/// 编译目标 → Node 的 `process.platform` 拼法。
pub fn target_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".into(),
        "windows" => "win32".into(),
        other => other.into(),
    }
}

pub fn process_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

pub fn home_dir(env: &HashMap<String, String>) -> String {
    env_value(env, "HOME")
        .or_else(|| env_value(env, "USERPROFILE"))
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// 一次截图的结果：整屏逻辑尺寸 + 实际生效的裁剪框。
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureInfo {
    /// **整屏**逻辑尺寸（不是裁剪后的）：前端要靠它把图上的点映射回坐标。
    pub width: f64,
    pub height: f64,
    /// 实际生效的裁剪框。macOS 那条路带 pixelX/pixelY/pixelWidth/pixelHeight
    /// （shot.json 里要原样留着），Linux 那条路是 agent 回显的 crop。
    pub region: Option<Value>,
}

impl CaptureInfo {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("width".into(), js_num(self.width));
        map.insert("height".into(), js_num(self.height));
        map.insert("region".into(), self.region.clone().unwrap_or(Value::Null));
        Value::Object(map)
    }

    /// 逻辑域的四至（表头与标注换算要的是这四个数）。
    pub fn region_logical(&self) -> Option<Region> {
        self.region.as_ref().map(|v| Region {
            x: number_field(v, "x"),
            y: number_field(v, "y"),
            width: number_field(v, "width"),
            height: number_field(v, "height"),
        })
    }
}

pub struct Host {
    pub profile: Profile,
    is_mac: bool,
    /// 只成功取到过才缓存；两个来源都失败时不缓存，下一次会重试。
    logical: Mutex<Option<Size>>,
    exec: Exec,
    /// Linux 的截图要走 agent 的 snap（抓屏 + 裁剪 + 编码一次做完），
    /// 而 socket 客户端不在这里 —— 由调用方注入，避免 host 里再实现一遍。
    call: Option<HostCall>,
}

impl Host {
    pub fn new(profile: Profile, exec: Exec, call: Option<HostCall>) -> Self {
        let is_mac = profile.platform == "darwin";
        Self { profile, is_mac, logical: Mutex::new(None), exec, call }
    }

    /// 按编译目标和进程环境推导画像。
    pub fn from_process(call: Option<HostCall>) -> Self {
        let env = process_env();
        let platform = target_platform();
        let profile = profile_for(&platform, &home_dir(&env), &env);
        Self::new(profile, default_exec(), call)
    }

    pub fn unsupported(&self) -> AppError {
        AppError::unsupported()
    }

    pub fn assert_supported(&self) -> AppResult<()> {
        if self.profile.supported {
            Ok(())
        } else {
            Err(self.unsupported())
        }
    }

    /// 逻辑点尺寸。macOS：Finder 桌面 bounds，失败按 Retina 物理宽 / 2。
    /// Linux：**逻辑点 == 像素** —— X11 下的缩放是切 XRandR 模式，不是把一帧更大的
    /// 图缩下来，两个域本来就是同一个。如实返回物理尺寸，前端那句「图上 1px = 1pt」
    /// 才成立（乘任何系数都会让坐标整体偏移）。
    pub async fn logical_size(&self, phys_w: f64, phys_h: f64) -> Size {
        if !self.profile.supported {
            return Size { width: 0.0, height: 0.0 };
        }
        if let Some(cached) = *self.logical.lock().unwrap() {
            return cached;
        }
        if !self.is_mac {
            let size = Size { width: phys_w.max(0.0), height: phys_h.max(0.0) };
            *self.logical.lock().unwrap() = Some(size);
            return size;
        }
        let out = (self.exec)(
            "osascript".into(),
            vec!["-e".into(), "tell application \"Finder\" to get bounds of window of desktop".into()],
            Duration::from_millis(4000),
        )
        .await;
        if let Ok(out) = out {
            let parts: Vec<Option<i64>> = out.split(',').map(parse_int_prefix).collect();
            let w = parts.get(2).copied().flatten().unwrap_or(0) as f64;
            let h = parts.get(3).copied().flatten().unwrap_or(0) as f64;
            if w > 0.0 && h > 0.0 {
                let size = Size { width: w, height: h };
                *self.logical.lock().unwrap() = Some(size);
                return size;
            }
        }
        if phys_w > 0.0 {
            let size = Size { width: (phys_w / 2.0).round(), height: (phys_h / 2.0).round() };
            *self.logical.lock().unwrap() = Some(size);
            return size;
        }
        Size { width: 0.0, height: 0.0 }
    }

    /// 已缓存的主屏逻辑尺寸（出过帧之后才非空）；标注换算需要它，且不能再触发采样。
    pub fn cached_logical_size(&self) -> Option<Size> {
        *self.logical.lock().unwrap()
    }

    pub fn reset(&self) {
        *self.logical.lock().unwrap() = None;
    }

    /// captureDirect 只在非 macOS 上挂出来：调用方用它的**有无**判断走哪条截图路。
    pub fn has_capture_direct(&self) -> bool {
        !self.is_mac
    }

    /// Linux 的截图：抓屏 →（可选）裁剪 → 编码，全部由 agent 一次做完，落一个文件。
    /// 返回值形状与 macOS 那条路一致：width/height 是整屏逻辑尺寸，region 是实际
    /// 生效的裁剪框（逻辑域）。
    pub async fn capture_direct(
        &self,
        out: &str,
        region: Option<Region>,
        session: &str,
        jpeg: bool,
        quality: u32,
    ) -> AppResult<CaptureInfo> {
        self.assert_supported()?;
        if self.is_mac {
            return Err(AppError::wrong_platform("captureDirect"));
        }
        let Some(call) = self.call.clone() else {
            return Err(AppError::new(500, "agent-call-missing"));
        };
        let mut req = Map::new();
        req.insert("op".into(), json!("snap"));
        req.insert("path".into(), json!(out));
        req.insert("session".into(), json!(session));
        req.insert("jpeg".into(), json!(jpeg));
        req.insert("quality".into(), json!(quality));
        if let Some(r) = region {
            let mut crop = Map::new();
            crop.insert("x".into(), js_num(r.x));
            crop.insert("y".into(), js_num(r.y));
            crop.insert("width".into(), js_num(r.width));
            crop.insert("height".into(), js_num(r.height));
            req.insert("crop".into(), Value::Object(crop));
        }
        let reply = call(Value::Object(req), Some(Duration::from_millis(15000))).await;
        if crate::agent::agent_failed(&reply) {
            let reason = reply.get("error").and_then(|v| v.as_str()).unwrap_or("snap-failed").to_string();
            // 裁到屏幕外面是调用方的错（400），其余是 agent 侧的问题（502）。
            let status = if reason == "region-outside-screen" { 400 } else { 502 };
            return Err(AppError::from_agent(status, reason, reply));
        }
        let width = number_field(&reply, "width");
        let height = number_field(&reply, "height");
        if width > 0.0 && height > 0.0 {
            *self.logical.lock().unwrap() = Some(Size { width, height });
        }
        Ok(CaptureInfo { width, height, region: region_value(&reply, "crop") })
    }

    fn mac_only(&self, name: &str) -> AppResult<()> {
        self.assert_supported()?;
        if self.is_mac {
            Ok(())
        } else {
            Err(AppError::wrong_platform(name))
        }
    }

    /// 原生物理像素尺寸（sips -g）。
    pub async fn image_size(&self, file: &str) -> AppResult<Size> {
        self.mac_only("imageSize")?;
        let out = (self.exec)(
            "sips".into(),
            vec!["-g".into(), "pixelWidth".into(), "-g".into(), "pixelHeight".into(), file.into()],
            Duration::from_millis(8000),
        )
        .await
        .map_err(|message| AppError::new(502, message))?;
        Ok(Size { width: grab_label(&out, "pixelWidth"), height: grab_label(&out, "pixelHeight") })
    }

    /// 先按原生像素裁，再编码：局部放大因此保留原始细节（v2.4.1）。
    pub async fn crop_image(&self, src: &str, area: CropArea, out: &str) -> AppResult<()> {
        self.mac_only("cropImage")?;
        (self.exec)(
            "sips".into(),
            vec![
                src.into(),
                "--cropToHeightWidth".into(),
                js_num_str(area.pixel_height),
                js_num_str(area.pixel_width),
                "--cropOffset".into(),
                js_num_str(area.pixel_y),
                js_num_str(area.pixel_x),
                "--out".into(),
                out.into(),
            ],
            Duration::from_millis(8000),
        )
        .await
        .map(|_| ())
        .map_err(|message| AppError::new(502, message))
    }

    pub async fn convert_image(
        &self,
        src: &str,
        out: &str,
        jpeg: bool,
        quality: Option<u32>,
        resample_width: Option<f64>,
    ) -> AppResult<()> {
        self.mac_only("convertImage")?;
        let mut args = vec!["-s".to_string(), "format".to_string(), if jpeg { "jpeg".into() } else { "png".into() }];
        if jpeg {
            if let Some(q) = quality {
                args.push("-s".into());
                args.push("formatOptions".into());
                args.push(q.to_string());
            }
        }
        if let Some(width) = resample_width {
            args.push("--resampleWidth".into());
            args.push(js_num_str(width));
        }
        args.push(src.into());
        args.push("--out".into());
        args.push(out.into());
        (self.exec)("sips".into(), args, Duration::from_millis(8000))
            .await
            .map(|_| ())
            .map_err(|message| AppError::new(502, message))
    }

    /// 唤屏：macOS 是 caffeinate -u；Linux 上没有等价物（X11 的灭屏是 DPMS，一次
    /// XTest 注入就够，而注入本来就会唤醒）。路由按 features.wake 判，走不到这里。
    pub async fn wake_display(&self) -> AppResult<()> {
        self.mac_only("wakeDisplay")?;
        (self.exec)(
            "/usr/bin/caffeinate".into(),
            vec!["-u".into(), "-t".into(), "1".into()],
            Duration::from_millis(3000),
        )
        .await
        .map(|_| ())
        .map_err(|message| AppError::new(502, message))
    }

    /// 前端据此决定显不显示 🖥、快捷键行出 ⌘ 还是 Ctrl。画像进程内不变，所以这是个
    /// 常量回答；agent 装没装不在这里判断 —— 那由各路由真实失败时回各自的 reason。
    pub fn info(&self) -> Value {
        let p = &self.profile;
        let mut map = Map::new();
        map.insert("ok".into(), json!(true));
        map.insert("platform".into(), json!(p.platform));
        map.insert("label".into(), json!(p.label));
        map.insert("supported".into(), json!(p.supported));
        map.insert("transport".into(), json!(p.transport));
        map.insert("features".into(), p.features.to_json());
        map.insert("modifier".into(), json!(p.modifier));
        map.insert("installHint".into(), p.install_hint.clone().map(Value::String).unwrap_or(Value::Null));
        map.insert("reason".into(), if p.supported { Value::Null } else { json!("platform-unsupported") });
        Value::Object(map)
    }
}

/// JS execFile 的默认实现：起子进程、超时杀掉、stdout 当 utf8。
pub fn default_exec() -> Exec {
    Arc::new(|cmd, args, timeout| {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&cmd);
            command
                .args(&args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            match tokio::time::timeout(timeout, command.output()).await {
                Err(_) => Err(format!("{cmd}: timeout")),
                Ok(Err(error)) => Err(format!("{cmd}: {error}")),
                Ok(Ok(output)) if !output.status.success() => Err(format!("{cmd}: exit {}", output.status)),
                Ok(Ok(output)) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
            }
        })
    })
}

/// JS `parseInt(s, 10)`：忽略前后空白，读到第一个非数字为止。
fn parse_int_prefix(text: &str) -> Option<i64> {
    let trimmed = text.trim_start();
    let mut end = 0;
    for (index, ch) in trimmed.char_indices() {
        if index == 0 && (ch == '-' || ch == '+') {
            end = ch.len_utf8();
            continue;
        }
        if ch.is_ascii_digit() {
            end = index + ch.len_utf8();
        } else {
            break;
        }
    }
    trimmed[..end].parse().ok()
}

fn grab_label(out: &str, label: &str) -> f64 {
    // 对应 /pixelWidth:\s*(\d+)/
    let needle = format!("{label}:");
    let Some(pos) = out.find(&needle) else { return 0.0 };
    let rest = out[pos + needle.len()..].trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0.0)
}

fn number_field(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(|v| v.as_f64()).filter(|v| v.is_finite()).unwrap_or(0.0)
}

fn region_value(value: &Value, key: &str) -> Option<Value> {
    value.get(key).filter(|v| !v.is_null()).cloned()
}
