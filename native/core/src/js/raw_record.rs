//! Read selected fields of a CLI JSON record without expanding nested messages.
use super::{json_parse, truthy, JsString, JsValue};
use serde::de::{Deserialize, Deserializer, Visitor};
use serde_json::value::RawValue;
use std::{borrow::Borrow, collections::HashMap, fmt};

// JSON.parse 接受含孤立代理项的字段名。只按 ASCII 协议字段查找，
// 其他名字即使无法表示为 Rust 字符串，也不应让整条停止回执失效。
#[derive(PartialEq, Eq, Hash)]
pub(crate) struct FieldName(String);

impl Borrow<str> for FieldName {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for FieldName {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct NameVisitor;
        impl Visitor<'_> for NameVisitor {
            type Value = FieldName;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON 字段名")
            }
            fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<FieldName, E> {
                Ok(FieldName(String::from_utf8_lossy(bytes).into_owned()))
            }
        }
        de.deserialize_bytes(NameVisitor)
    }
}

pub(crate) type Record<'a> = HashMap<FieldName, &'a RawValue>;

pub(crate) fn record(text: &str) -> Option<Record<'_>> {
    // RawValue 会校验整行，未使用的工具输出即使很深也不用递归展开。
    serde_json::from_str(text).ok()
}

pub(crate) fn string(raw: Option<&&RawValue>) -> Option<JsString> {
    let raw = raw?.get();
    if !raw.starts_with('"') {
        return None;
    }
    match json_parse(raw).ok()? {
        JsValue::String(value) => Some(value),
        _ => None,
    }
}

pub(crate) fn flag(raw: Option<&&RawValue>) -> bool {
    raw.is_some_and(|raw| match raw.get().as_bytes()[0] {
        b'{' | b'[' => true,
        _ => json_parse(raw.get()).is_ok_and(|v| truthy(&v)),
    })
}
