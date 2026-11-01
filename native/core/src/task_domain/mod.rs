//! 任务规则与卡片投影；宿主只提供权威事实，不在桥接层重做决策。
pub mod air;
pub mod board;
pub mod card_cache;
pub mod cards;
pub mod classification;
pub mod handle;
pub mod host;
pub mod normalize;
pub mod planning;
pub mod repository;
pub mod retention;
pub mod routing;
pub mod view;
use serde_json::{json, Value};
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
// 保留旧接口的 ECMAScript 数值转换（包括数组和进制字符串）。
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(_) => wire(v),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
pub fn number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        Value::Array(_) => number(&json!(js_string(v))),
        Value::String(s) => {
            let s = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            if s.is_empty() {
                return 0.0;
            }
            for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
                if s.to_ascii_lowercase().starts_with(prefix) {
                    return u64::from_str_radix(&s[2..], radix)
                        .map(|n| n as f64)
                        .unwrap_or(f64::NAN);
                }
            }
            s.parse().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    }
}
pub fn num(v: &Value) -> f64 {
    let n = number(v);
    if n.is_finite() {
        n
    } else {
        0.0
    }
}
pub fn clean(v: &Value, max: usize) -> String {
    let mut size = 0;
    text(v)
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .chars()
        .take_while(|c| {
            size += c.len_utf16();
            size <= max
        })
        .collect()
}
pub fn array(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
// 只读遍历对象成员，避免先把整张表克隆成 Vec。
pub fn objects(v: &Value) -> impl Iterator<Item = &Value> + '_ {
    v.as_object().into_iter().flat_map(|m| m.values())
}
pub fn invalid(code: &str) -> Value {
    json!({"ok":false,"error":code})
}
pub fn run(input: &str) -> Result<String, String> {
    let v: Value = crate::json_lenient::from_str(input).map_err(|_| "invalid_task_domain_input")?;
    Ok(run_value(&v)?.to_string())
}
fn run_value(v: &Value) -> Result<Value, String> {
    let result = match text(&v["op"]) {
        "planning" => planning::run(v)?,
        "board" => board::run(v)?,
        "airInputs" => air::run(v),
        "airVisible" => json!(air::visible(&v["board"], &v["shellTasks"])
            .iter()
            .map(|t| t["id"].clone())
            .collect::<Vec<_>>()),
        "normalize" => normalize::run(v),
        "classification" => classification::run(v),
        "repository" => repository::run(v)?,
        "routing" => routing::run(v),
        "view" => view::run(v),
        "retention" => retention::run(v),
        "lastInteraction" => json!(retention::interaction(&v["task"], &v["record"])),
        "cardBase" => cards::base(v),
        "cardOverlay" => cards::overlay(v),
        "cardOverlayBatch" => {
            let mut cards = v["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| {
                    let id = text(&e["card"]["id"]);
                    cards::overlay_parts(
                        &e["t"],
                        &e["card"],
                        &v["facts"],
                        num(&v["now"]),
                        &v["merges"][id],
                        &v["capacityReasons"][id],
                    )
                })
                .collect::<Vec<_>>();
            cards::sort(&mut cards);
            json!(cards)
        }
        "runState" => cards::run_state(&v["task"], &v["facts"], num(&v["now"])),
        "attention" => cards::attention(v),
        "capacity" => {
            let count = array(&v["tasks"])
                .iter()
                .filter(|t| t["dirId"] == v["dirId"])
                .count();
            json!({"count":count,"limit":1024,"atCapacity":count>=1024})
        }
        _ => return Err("invalid_task_domain_command".into()),
    };
    Ok(result)
}

// JSON.stringify 的数字格式是签名和角色哈希协议的一部分。
pub fn wire(v: &Value) -> String {
    let mut out = String::new();
    append_wire(v, &mut out);
    out
}
fn append_wire(v: &Value, out: &mut String) {
    match v {
        Value::Number(n) => {
            out.push_str(ryu_js::Buffer::new().format_finite(n.as_f64().unwrap_or(0.0)))
        }
        Value::Array(a) => {
            out.push('[');
            for (i, value) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                append_wire(value, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (key, value)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap());
                out.push(':');
                append_wire(value, out);
            }
            out.push('}');
        }
        _ => out.push_str(&v.to_string()),
    }
}
