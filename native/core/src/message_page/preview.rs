use serde_json::{json, Value};

#[derive(Default)]
struct Size(usize);
impl std::io::Write for Size {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn size(value: &Value) -> usize {
    let mut n = Size::default();
    serde_json::to_writer(&mut n, value).expect("JSON value");
    n.0
}

pub(super) const MESSAGE_BYTES: usize = 32 * 1024;
pub(super) const PAGE_BYTES: usize = 256 * 1024;

/// Keep UTF-8 intact. Measure the actual serialized result as escaped text or
/// thousands of tiny tool calls can exceed the budget without any long string.
fn shorten(s: &mut String, budget: &mut usize) {
    let mut n = s.len().min(*budget);
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    s.truncate(n);
    *budget -= n;
}
fn clip(value: &mut Value, budget: &mut usize) {
    match value {
        Value::String(s) => shorten(s, budget),
        Value::Array(list) => {
            let mut kept = 0;
            for item in list.iter_mut() {
                if *budget < 2 {
                    break;
                }
                *budget -= 2;
                clip(item, budget);
                kept += 1;
            }
            list.truncate(kept);
        }
        Value::Object(map) => map.retain(|key, value| {
            if key.len() + 3 > *budget {
                return false;
            }
            *budget -= key.len() + 3;
            clip(value, budget);
            true
        }),
        other => *budget = budget.saturating_sub(other.to_string().len()),
    }
}

pub(super) fn preview(mut row: Value) -> (Value, usize) {
    let original = size(&row);
    if original <= MESSAGE_BYTES {
        return (row, original);
    }
    let mut out = json!({"truncated":true, "originalLength":original});
    if let Some(content) = row.get("content") {
        out["contentOriginalLength"] =
            json!(content.as_str().map_or_else(|| size(content), str::len));
    }
    if let Some(tools) = row.get("tools") {
        out["toolsOriginalLength"] = json!(size(tools));
    }
    let mut budget = MESSAGE_BYTES - 512;
    for field in [
        "messageKey",
        "id",
        "role",
        "ts",
        "sourceMessageId",
        "sourceSessionId",
        "contextMessageId",
        "taskId",
        "taskShortCode",
        "inherited",
        "canExpand",
        "turnId",
        "clientMsgId",
        "taskName",
        "usage",
        "inProgress",
        "_interim",
        "partial",
        "cancelled",
        "error",
        "content",
        "tools",
    ] {
        if let Some(mut value) = row.as_object_mut().and_then(|obj| obj.remove(field)) {
            clip(&mut value, &mut budget);
            out[field] = value;
        }
    }
    if size(&out) > MESSAGE_BYTES {
        let mut safe = MESSAGE_BYTES / 8;
        for value in out.as_object_mut().unwrap().values_mut() {
            clip(value, &mut safe);
        }
    }
    let n = size(&out);
    (out, n)
}
