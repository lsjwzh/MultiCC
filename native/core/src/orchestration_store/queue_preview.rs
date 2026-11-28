//! Public queue text is a UTF-16 prefix of the delivery, including for old
//! wait rows with no explicit deliveryText. The live draft uses the same sink.
use crate::js::{js_to_string, json_quote, json_stringify_or_undefined, truthy, JsString, JsValue};

pub const LIMIT: usize = 20_000;
pub const WAIT_TYPES: [&str; 3] = ["wait.resolved", "wait.callback", "wait.result"];

pub fn default_wait_prefix(mode: Option<&JsString>) -> &'static str {
    match mode {
        Some(mode) if mode == "poll" => "[轮询条件已满足]",
        Some(mode) if mode == "delay" => "[延迟条件已到]",
        _ => "[等待的数据已返回]",
    }
}

pub struct WaitPreview(Vec<u16>);

impl WaitPreview {
    pub fn new(prefix: &JsString) -> Self {
        let mut out = Self(Vec::new());
        out.string(prefix, false);
        out.literal("\n");
        out
    }

    pub fn remaining(&self) -> usize {
        LIMIT - self.0.len()
    }

    pub fn literal(&mut self, text: &str) {
        self.0.extend(text.encode_utf16().take(self.remaining()));
    }

    pub fn string(&mut self, text: &JsString, quoted: bool) {
        if quoted {
            // One unit of lookahead preserves JSON.stringify's treatment of a
            // surrogate pair even when the public slice ends inside the pair.
            let units = text.as_units();
            if units.len() > self.remaining() + 1 {
                let head = JsString::from_units(units[..self.remaining() + 1].to_vec());
                self.literal(&json_quote(&head));
            } else {
                self.literal(&json_quote(text));
            }
        } else {
            self.0
                .extend_from_slice(&text.as_units()[..text.len().min(self.remaining())]);
        }
    }

    pub fn finish_wait(mut self) -> JsValue {
        // A clipped surrogate pair is not valid Unicode on the JSON/HTTP port.
        if self.remaining() == 0 && matches!(self.0.last(), Some(0xd800..=0xdbff)) {
            self.0.pop();
        }
        self.finish()
    }

    fn finish(self) -> JsValue {
        JsValue::String(JsString::from_units(self.0))
    }

    fn append(&mut self, data: &JsValue, quoted: bool) {
        match data {
            JsValue::String(s) => self.string(s, quoted),
            JsValue::Array(items) => {
                self.literal("[");
                for (index, item) in items.iter().enumerate() {
                    if self.remaining() == 0 {
                        break;
                    }
                    if index > 0 {
                        self.literal(",");
                    }
                    if matches!(item, JsValue::Undefined) {
                        self.literal("null");
                    } else {
                        self.append(item, true);
                    }
                }
                self.literal("]");
            }
            JsValue::Object(entries) => {
                self.literal("{");
                let mut first = true;
                for (key, value) in entries {
                    if self.remaining() == 0 {
                        break;
                    }
                    if matches!(value, JsValue::Undefined) {
                        continue;
                    }
                    if !first {
                        self.literal(",");
                    }
                    first = false;
                    self.string(key, true);
                    self.literal(":");
                    if self.remaining() > 0 {
                        self.append(value, true);
                    }
                }
                self.literal("}");
            }
            // Persisted wait data is normalized JSON. Handle the bridge's
            // Buffer representation without constructing an unbounded string.
            JsValue::Bytes(bytes) => {
                self.literal("{\"type\":\"Buffer\",\"data\":[");
                for (index, byte) in bytes.iter().enumerate() {
                    if self.remaining() == 0 {
                        break;
                    }
                    if index > 0 {
                        self.literal(",");
                    }
                    self.literal(&byte.to_string());
                }
                self.literal("]}");
            }
            scalar => self.literal(&json_stringify_or_undefined(scalar)),
        }
    }
}

pub(super) fn queue_text(payload: &JsValue) -> JsValue {
    for key in ["message", "taskText", "deliveryText"] {
        if let Some(value) = payload.get(key).filter(|v| truthy(v)) {
            let mut out = WaitPreview(Vec::new());
            match value {
                JsValue::String(s) => out.string(s, false),
                other => out.string(&js_to_string(other), false),
            }
            return out.finish();
        }
    }
    let string = |key| match payload.get(key) {
        Some(JsValue::String(s)) => Some(s),
        _ => None,
    };
    if !string("type").is_some_and(|kind| WAIT_TYPES.iter().any(|name| kind == *name)) {
        return JsValue::string("");
    }
    let mut out = match string("injectPrefix").filter(|prefix| !prefix.is_empty()) {
        Some(prefix) => WaitPreview::new(prefix),
        None => WaitPreview::new(&default_wait_prefix(string("mode")).into()),
    };
    if out.remaining() > 0 {
        out.append(payload.get("data").unwrap_or(&JsValue::Undefined), false);
    }
    out.finish_wait()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::{from_serde, json_parse};
    use serde_json::json;

    fn text(payload: JsValue) -> JsValue {
        queue_text(&payload)
    }

    #[test]
    fn stored_waits_use_the_delivery_prefix_and_js_json() {
        for (kind, mode, prefix) in [
            ("wait.resolved", "poll", "[轮询条件已满足]"),
            ("wait.result", "delay", "[延迟条件已到]"),
            ("wait.callback", "callback", "[等待的数据已返回]"),
        ] {
            let payload = from_serde(&json!({"type": kind, "mode": mode, "deliveryText": null,
                "injectPrefix": "", "data": ["中\n文", true, null, 2.5]}));
            assert_eq!(
                text(payload),
                JsValue::from(format!("{prefix}\n[\"中\\n文\",true,null,2.5]"))
            );
        }
        let payload = json_parse(
            r#"{"type":"wait.resolved","data":{"b":"\ud800","2":2,"1":1},"injectPrefix":"进度"}"#,
        )
        .unwrap();
        assert_eq!(
            text(payload),
            JsValue::from("进度\n{\"1\":1,\"2\":2,\"b\":\"\\ud800\"}")
        );
        for (fields, expected) in [
            (
                json!({"message":"m","taskText":"t","deliveryText":"d"}),
                "m",
            ),
            (json!({"message":"","taskText":"t","deliveryText":"d"}), "t"),
            (json!({"deliveryText":"d"}), "d"),
            (json!({"type":"dispatch.result"}), ""),
        ] {
            let mut payload = json!({"type":"wait.resolved","data":"from wait"});
            payload
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            assert_eq!(text(from_serde(&payload)), JsValue::from(expected));
        }
    }

    #[test]
    fn long_string_and_nested_json_match_the_first_20000_utf16_units() {
        let long = "😀\n".repeat(40_000);
        for data in [json!(long), json!({"output":[long],"tail":false})] {
            let rendered = data
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| data.to_string());
            let expected: String = format!("OK\n{rendered}")
                .chars()
                .scan(0, |used, c| {
                    *used += c.len_utf16();
                    (*used <= LIMIT).then_some(c)
                })
                .collect();
            let payload = from_serde(
                &json!({"type":"wait.resolved","mode":"poll","data":data,"injectPrefix":"OK"}),
            );
            assert_eq!(text(payload), JsValue::from(expected));
        }
    }
}
