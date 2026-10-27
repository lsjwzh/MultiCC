//! 区域（region）与裁剪几何。
//!
//! All regions use main-display logical points, independent of JPEG/RFB pixels.
//! 前端传的是逻辑点；只有 macOS 那条路要把它换算成物理像素交给 sips。

use crate::error::{AppError, AppResult};
use serde_json::{Map, Value};

/// 主屏逻辑点上的一个矩形。字段是 f64：cropGeometry 回的是取整后的逻辑值，
/// 可能是小数（物理像素四舍五入后再除回去）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Region {
    pub fn to_json(self) -> Value {
        let mut map = Map::new();
        map.insert("x".into(), js_num(self.x));
        map.insert("y".into(), js_num(self.y));
        map.insert("width".into(), js_num(self.width));
        map.insert("height".into(), js_num(self.height));
        Value::Object(map)
    }

    /// 帧缓存的键：JS 用 `JSON.stringify(region)`，null 也参与比较。
    pub fn cache_key(region: Option<Region>) -> String {
        match region {
            None => "null".to_string(),
            Some(r) => r.to_json().to_string(),
        }
    }
}

/// JS 的 NaN/Infinity 在 JSON 里是 null；这里只处理有限值。
pub fn js_num(v: f64) -> Value {
    serde_json::from_str(&js_num_str(v)).unwrap_or(Value::Null)
}

/// JS `String(number)` 等价的十进制形式（100 而不是 100.0）。
pub fn js_num_str(v: f64) -> String {
    if !v.is_finite() {
        return if v.is_nan() {
            "NaN".to_string()
        } else if v > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    let mut buf = ryu_js::Buffer::new();
    buf.format(v).to_string()
}

/// JS `Number(v)`：字符串按 JS 规则解析，布尔按 0/1，null 为 0，其余为 NaN。
pub fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) => js_parse_number(s),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// JS `Number(string)` 的常见形态：可带空白的十进制/指数/十六进制，空串是 0。
///
/// 只收有限值：JS 那边的调用点（`num()` 与 `Number.isFinite`）都会把
/// NaN/Infinity 当成「没给」。Rust 的 f64 解析却认 "nan"/"inf"/"infinity"，
/// 而 NaN 与任何数比较都是 false，会从范围校验里溜过去 —— 所以在这里挡掉。
fn js_parse_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).ok().map(|v| v as f64);
    }
    if let Some(oct) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return i64::from_str_radix(oct, 8).ok().map(|v| v as f64);
    }
    if let Some(bin) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return i64::from_str_radix(bin, 2).ok().map(|v| v as f64);
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// 解析请求里的 x/y/width/height。
///
/// 四个键**一个都没有**才当作「整屏」（返回 None）；只给了其中几个是调用方的错，
/// 不能悄悄补 0 —— 那会截出一块用户没要的区域。
pub fn parse_region(map: &Map<String, Value>) -> AppResult<Option<Region>> {
    let keys = ["x", "y", "width", "height"];
    if !keys.iter().any(|k| map.contains_key(*k)) {
        return Ok(None);
    }
    let mut values = [0f64; 4];
    for (i, key) in keys.iter().enumerate() {
        let raw = match map.get(*key) {
            Some(v) => v,
            None => return Err(AppError::invalid_region()),
        };
        // JS 只放行 typeof 为 number / string 的值（remote-screen-region.js:8）：
        // null、布尔、数组、对象都直接 400，不能按 Number() 的宽松语义补成 0/1。
        let parsed = match raw {
            Value::Number(_) | Value::String(_) => js_number(raw),
            _ => None,
        };
        // 空串、非有限数（"nan"/"inf"/1e999）都不算 —— 后者在下面还会被再挡一次。
        let text_empty = matches!(raw, Value::String(s) if s.trim().is_empty());
        match parsed {
            Some(v) if !text_empty => values[i] = v,
            _ => return Err(AppError::invalid_region()),
        }
    }
    let [x, y, width, height] = values;
    // 显式的有限性兜底：NaN 与任何数比较都是 false，只用范围判断会漏过去。
    if values.iter().any(|v| !v.is_finite())
        || x < 0.0
        || y < 0.0
        || width < 1.0
        || height < 1.0
        || values.iter().any(|v| *v > 100000.0)
    {
        return Err(AppError::invalid_region());
    }
    Ok(Some(Region {
        x,
        y,
        width,
        height,
    }))
}

/// 逻辑点上的裁剪框在物理像素里的落点，四舍五入到像素后再换算回逻辑点。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CropArea {
    pub region: Region,
    pub pixel_x: f64,
    pub pixel_y: f64,
    pub pixel_width: f64,
    pub pixel_height: f64,
}

impl CropArea {
    pub fn to_json(self) -> Value {
        let mut map = Map::new();
        let r = self.region;
        map.insert("x".into(), js_num(r.x));
        map.insert("y".into(), js_num(r.y));
        map.insert("width".into(), js_num(r.width));
        map.insert("height".into(), js_num(r.height));
        map.insert("pixelX".into(), js_num(self.pixel_x));
        map.insert("pixelY".into(), js_num(self.pixel_y));
        map.insert("pixelWidth".into(), js_num(self.pixel_width));
        map.insert("pixelHeight".into(), js_num(self.pixel_height));
        Value::Object(map)
    }
}

pub fn crop_geometry(
    region: Region,
    screen: (f64, f64),
    pixels: (f64, f64),
) -> AppResult<CropArea> {
    let x = region.x.floor();
    let y = region.y.floor();
    let right = screen.0.min((region.x + region.width).ceil());
    let bottom = screen.1.min((region.y + region.height).ceil());
    // 裁到屏幕外是调用方的错（400），不是 agent 故障。
    if right <= x || bottom <= y {
        return Err(AppError::region_outside());
    }
    let sx = pixels.0 / screen.0;
    let sy = pixels.1 / screen.1;
    let px = (x * sx).floor();
    let py = (y * sy).floor();
    let pw = pixels.0.min((right * sx).ceil()) - px;
    let ph = pixels.1.min((bottom * sy).ceil()) - py;
    // Return the actual covered area after physical-pixel rounding.
    Ok(CropArea {
        region: Region {
            x: px / sx,
            y: py / sy,
            width: pw / sx,
            height: ph / sy,
        },
        pixel_x: px,
        pixel_y: py,
        pixel_width: pw,
        pixel_height: ph,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn absent_keys_mean_full_screen() {
        assert_eq!(parse_region(&map(json!({}))).unwrap(), None);
    }

    #[test]
    fn partial_or_invalid_regions_are_400() {
        for bad in [
            json!({"x": -1, "y": 0, "width": 5, "height": 5}),
            json!({"x": 1}),
            json!({"x": 0, "y": 0, "width": f64::INFINITY, "height": 5}),
            json!({"x": [], "y": 0, "width": 5, "height": 5}),
            json!({"x": " ", "y": 0, "width": 5, "height": 5}),
            json!({"x": 0, "y": 0, "width": 0, "height": 5}),
            json!({"x": 0, "y": 0, "width": 5, "height": 100001}),
        ] {
            let err = parse_region(&map(bad.clone())).unwrap_err();
            assert_eq!(err.status, 400, "{bad}");
            assert_eq!(err.message, "invalid-region");
        }
    }

    #[test]
    fn strings_are_coerced_like_js() {
        let r = parse_region(&map(
            json!({"x": "100", "y": " 80 ", "width": "400", "height": 240}),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            r,
            Region {
                x: 100.0,
                y: 80.0,
                width: 400.0,
                height: 240.0
            }
        );
    }

    #[test]
    fn non_finite_numbers_are_not_numbers_like_js() {
        // Rust 的 f64 解析认 "nan"/"inf"；JS 的 Number.isFinite 不认，必须回 400。
        for bad in ["nan", "NaN", "inf", "-inf", "infinity", "1e999", "  nan  "] {
            let err =
                parse_region(&map(json!({"x": bad, "y": 0, "width": 5, "height": 5}))).unwrap_err();
            assert_eq!(
                (err.status, err.message.as_str()),
                (400, "invalid-region"),
                "{bad}"
            );
        }
        assert_eq!(js_number(&json!("nan")), None);
        assert_eq!(js_number(&json!("Infinity")), None);
    }

    #[test]
    fn null_booleans_and_containers_are_rejected_by_the_type_whitelist() {
        // JS：typeof null = 'object'、typeof false = 'boolean' —— 都不是 number/string。
        for bad in [
            json!(null),
            json!(true),
            json!(false),
            json!([1]),
            json!({"n": 1}),
        ] {
            let err =
                parse_region(&map(json!({"x": bad, "y": 0, "width": 5, "height": 5}))).unwrap_err();
            assert_eq!((err.status, err.message.as_str()), (400, "invalid-region"));
        }
        // 但 buildInput 用的 Number(v) 语义不变：null 就是 0。
        assert_eq!(js_number(&Value::Null), Some(0.0));
        assert_eq!(js_number(&json!(false)), Some(0.0));
    }

    #[test]
    fn crop_geometry_rounds_to_physical_pixels() {
        let area = crop_geometry(
            Region {
                x: 100.0,
                y: 80.0,
                width: 400.0,
                height: 240.0,
            },
            (1470.0, 956.0),
            (2940.0, 1912.0),
        )
        .unwrap();
        assert_eq!(
            (
                area.pixel_x,
                area.pixel_y,
                area.pixel_width,
                area.pixel_height
            ),
            (200.0, 160.0, 800.0, 480.0)
        );
        assert_eq!(
            area.region,
            Region {
                x: 100.0,
                y: 80.0,
                width: 400.0,
                height: 240.0
            }
        );
    }

    #[test]
    fn crop_geometry_clamps_to_the_screen_edge() {
        let area = crop_geometry(
            Region {
                x: 1460.0,
                y: 950.0,
                width: 100.0,
                height: 100.0,
            },
            (1470.0, 956.0),
            (2940.0, 1912.0),
        )
        .unwrap();
        assert_eq!((area.region.width, area.region.height), (10.0, 6.0));
    }

    #[test]
    fn crop_geometry_rejects_regions_off_the_screen() {
        let err = crop_geometry(
            Region {
                x: 2000.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            (1470.0, 956.0),
            (2940.0, 1912.0),
        )
        .unwrap_err();
        assert_eq!(
            (err.status, err.message.as_str()),
            (400, "region-outside-screen")
        );
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(js_num_str(100.0), "100");
        assert_eq!(js_num_str(100.5), "100.5");
        assert_eq!(js_num_str(80.0), "80");
        assert_eq!(Region::cache_key(None), "null");
        assert_eq!(
            Region {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0
            }
            .to_json()
            .to_string(),
            "{\"x\":1,\"y\":2,\"width\":3,\"height\":4}"
        );
    }
}
