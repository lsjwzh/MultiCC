//! The host sends parsed replies through JSON.stringify. Delta byte limits must
//! count that wire encoding, including ECMAScript's finite-number formatting.
use serde_json::Value;
pub fn bytes(v: &Value) -> usize {
    match v {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(n) => ryu_js::Buffer::new()
            .format_finite(n.as_f64().unwrap())
            .len(),
        Value::String(s) => serde_json::to_string(s).unwrap().len(),
        Value::Array(a) => 2 + a.len().saturating_sub(1) + a.iter().map(bytes).sum::<usize>(),
        Value::Object(o) => {
            2 + o.len().saturating_sub(1)
                + o.iter()
                    .map(|(k, v)| serde_json::to_string(k).unwrap().len() + 1 + bytes(v))
                    .sum::<usize>()
        }
    }
}
