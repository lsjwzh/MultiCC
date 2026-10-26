//! JS 值语义的小工具：真值判断与 `String()`。
//!
//! 迁移前的判断到处是 `x || fallback`、`result?.reason || result?.error` ——
//! 这些都不是「有没有这个键」，而是「值是不是真值」。用 is_some/is_null 判会
//! 把 `""`、`0`、`false` 当成有值，前端的回退分支就走不到了。

use serde_json::Value;

/// JS 真值：空串、0（含 -0）、false、null、undefined、NaN 都是假；空数组/空对象是真。
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|v| v != 0.0 && !v.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        // 空数组、空对象在 JS 里都是真值。
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// JS `String(value)`（只用于拼文案与路径）。
pub fn display(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "undefined".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        // String([1,2]) 是 "1,2"（Array.prototype.join），不是 "[object Object]"；
        // null/undefined 元素按空串参与拼接，嵌套数组递归展开。
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => display(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_matches_javascript() {
        for falsy in [None, Some(json!(null)), Some(json!("")), Some(json!(0)), Some(json!(false))] {
            assert!(!truthy(falsy.as_ref()), "{falsy:?}");
        }
        for truthy_value in [json!(1), json!(-1), json!("x"), json!(true), json!([]), json!({})] {
            assert!(truthy(Some(&truthy_value)), "{truthy_value}");
        }
    }

    #[test]
    fn display_matches_javascript_string() {
        assert_eq!(display(Some(&json!([1, 2]))), "1,2");
        assert_eq!(display(Some(&json!([]))), "");
        assert_eq!(display(Some(&json!([null]))), "");
        assert_eq!(display(Some(&json!([[1, 2], [3]]))), "1,2,3");
        assert_eq!(display(Some(&json!({"a": 1}))), "[object Object]");
        assert_eq!(display(Some(&json!("x"))), "x");
    }
}
