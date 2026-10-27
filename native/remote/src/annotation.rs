//! 标注 → 动作（移植 src/remote-screen.js 的 handleAnnotation / isOwnShot）。
//!
//! 标注器对 `dir` 下 shot-*.png 画的标记：点 = 单击、框 = 点框中心、箭头 = 拖动、
//! 重新截 = 重拍；执行后把新画面写回**同一个文件**，标注器原地刷新。
//! 坐标单位是标注图上的像素，要按逻辑尺寸换算回主屏逻辑点（选区还要加回偏移）。

use crate::describe::describe;
use crate::jsval::{display as js_display, truthy};
use crate::region::{js_num_str, js_number, parse_region, Region};
use crate::routes::{build_input, AppState};
use serde_json::{json, Map, Value};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

fn result(ok: bool, refresh: bool, text: impl Into<String>) -> Value {
    let mut map = Map::new();
    map.insert("ok".into(), json!(ok));
    map.insert("refresh".into(), json!(refresh));
    map.insert("text".into(), json!(text.into()));
    Value::Object(map)
}

/// Node `path.resolve`：相对路径接 cwd，然后纯词法消掉 `.` / `..` / 重复分隔符
/// （不解析符号链接 —— 那是 realpath）。
pub fn resolve_path(src: &str) -> PathBuf {
    let raw = Path::new(src);
    let absolute = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(raw)
    };
    let mut out = PathBuf::from("/");
    for part in absolute.components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::ParentDir => {
                out.pop();
            }
            _ => {}
        }
    }
    out
}

pub fn is_own_shot(dir: &Path, src: &Path) -> bool {
    let parent = src.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    parent == resolve_path(&dir.to_string_lossy())
        && src
            .file_name()
            .and_then(|n| n.to_str())
            .map(crate::capture::is_shot_name)
            .unwrap_or(false)
}

/// 标注图上的一个点 → 主屏逻辑点。非对象输入在 JS 里会算出 NaN，这里用 None 表示。
fn to_screen(
    point: Option<&Value>,
    region: Option<Region>,
    scale_x: f64,
    scale_y: f64,
) -> Option<(f64, f64)> {
    let point = point?;
    if !truthy(Some(point)) {
        return None;
    }
    let x = point.get("x").and_then(js_number).unwrap_or(f64::NAN);
    let y = point.get("y").and_then(js_number).unwrap_or(f64::NAN);
    let offset_x = region.map(|r| r.x).unwrap_or(0.0);
    let offset_y = region.map(|r| r.y).unwrap_or(0.0);
    Some((
        (offset_x + x * scale_x).round(),
        (offset_y + y * scale_y).round(),
    ))
}

pub async fn handle_annotation(st: &AppState, payload: &Value) -> Value {
    let src_text = match payload.get("src") {
        Some(value) if truthy(Some(value)) => js_display(Some(value)),
        _ => String::new(),
    };
    let src = resolve_path(&src_text);
    if !is_own_shot(&st.screen.dir, &src) {
        return result(false, false, "不是远程屏幕截图");
    }
    // 选区坐标来自截图的 sidecar；没有它 = 整屏，读坏了才报错。
    let sidecar = PathBuf::from(format!("{}.json", src.display()));
    let mut region: Option<Region> = None;
    match std::fs::read_to_string(&sidecar) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return result(false, false, "选区坐标记录无效，请重新截取"),
        Ok(text) => {
            let parsed = match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(map)) => parse_region(&map).ok(),
                // JSON 里是 null 时 JS 的 parseRegion 会抛 TypeError。
                Ok(Value::Null) => return result(false, false, "选区坐标记录无效，请重新截取"),
                Ok(_) => Some(None),
                Err(_) => return result(false, false, "选区坐标记录无效，请重新截取"),
            };
            match parsed {
                // 不是「未给 region」，而是 region 的四个键不合规 —— 同样算坏记录。
                None => return result(false, false, "选区坐标记录无效，请重新截取"),
                Some(value) => region = value,
            }
        }
    }
    let payload_width = payload.get("width").and_then(js_number).unwrap_or(f64::NAN);
    let payload_height = payload
        .get("height")
        .and_then(js_number)
        .unwrap_or(f64::NAN);
    let (size_width, size_height) = match region {
        Some(r) => (r.width, r.height),
        None => match st.host.cached_logical_size() {
            Some(size) => (size.width, size.height),
            None => (
                payload
                    .get("width")
                    .and_then(js_number)
                    .filter(|v| *v != 0.0)
                    .unwrap_or(0.0),
                payload
                    .get("height")
                    .and_then(js_number)
                    .filter(|v| *v != 0.0)
                    .unwrap_or(0.0),
            ),
        },
    };
    let scale_x = if payload_width > 0.0 {
        size_width / payload_width
    } else {
        1.0
    };
    let scale_y = if payload_height > 0.0 {
        size_height / payload_height
    } else {
        scale_x
    };

    let a = to_screen(payload.get("a"), region, scale_x, scale_y);
    let b = to_screen(payload.get("b"), region, scale_x, scale_y);
    let kind = js_display(payload.get("kind"));
    // 三种手势共用同一段收尾：命中哪一种由 (kind 条件, 点) 一起决定，
    // 与 JS 的 `if (kind === 'point' && a) … else if (…)` 链一一对应。
    let is = |name: &str| payload.get("kind").and_then(|v| v.as_str()) == Some(name);
    let (point, boxed, arrow) = (is("point"), is("box"), is("arrow"));
    let mut request: Option<Value> = None;
    let mut text = String::new();
    if let (true, Some((x, y))) = (point, a) {
        if !x.is_finite() || !y.is_finite() {
            return result(false, false, "x and y are required");
        }
        request = Some(json!({ "op": "click", "x": x, "y": y }));
        text = format!("已点击 ({}, {})", js_num_str(x), js_num_str(y));
    } else if let (true, Some((ax, ay)), Some((bx, by))) = (boxed, a, b) {
        if !ax.is_finite() || !ay.is_finite() {
            return result(false, false, "x and y are required");
        }
        if !bx.is_finite() || !by.is_finite() {
            return result(false, false, "x2 and y2 are required");
        }
        let cx = ((ax + bx) / 2.0).round();
        let cy = ((ay + by) / 2.0).round();
        request = Some(json!({ "op": "click", "x": cx, "y": cy }));
        text = format!("已点击框中心 ({}, {})", js_num_str(cx), js_num_str(cy));
    } else if let (true, Some((ax, ay)), Some((bx, by))) = (arrow, a, b) {
        if !ax.is_finite() || !ay.is_finite() {
            return result(false, false, "x and y are required");
        }
        if !bx.is_finite() || !by.is_finite() {
            return result(false, false, "x2 and y2 are required");
        }
        request = Some(json!({ "op": "drag", "x": ax, "y": ay, "x2": bx, "y2": by, "ms": 400 }));
        text = format!(
            "已拖动 ({}, {}) → ({}, {})",
            js_num_str(ax),
            js_num_str(ay),
            js_num_str(bx),
            js_num_str(by)
        );
    } else if kind != "recapture" {
        return result(false, false, format!("不支持的标注：{kind}"));
    }
    let has_request = request.is_some();
    if let Some(request) = request {
        let built = match build_input(&request) {
            Ok(req) => req,
            Err(error) => return result(false, false, error.message.clone()),
        };
        let reply = st.agent.call(built, None).await;
        if crate::agent::agent_failed(&reply) {
            let why = describe(&reply, st.host.profile.install_hint.as_deref());
            return result(false, false, format!("未执行：{why}"));
        }
        // 注入生效到画面变化有个空窗：等一下再重拍，否则拍到的还是旧画面。
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    if let Err(error) = st.screen.capture(&src, region).await {
        let label = if text.is_empty() {
            "重拍"
        } else {
            text.as_str()
        };
        return result(
            has_request,
            false,
            format!("{label}；重拍失败：{}", error.message),
        );
    }
    let text = if text.is_empty() {
        "已重新截取".to_string()
    } else {
        text
    };
    result(true, true, text)
}
