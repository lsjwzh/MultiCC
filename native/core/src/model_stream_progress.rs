//! Incremental SSE model-progress recognition. Raw transport bytes stay untouched.
use crate::js::buffer::Utf8Decoder;
use crate::js::{js_to_string, json_parse, truthy, JsString, JsValue};
use crate::quota_guard::prop;

const MAX_PENDING_UNITS: usize = 262_144;

#[derive(Default)]
pub struct ModelStreamProgress {
    pending: Vec<u16>,
    decoder: Utf8Decoder,
    dropping: bool,
}

fn boundary(input: &[u16]) -> Option<(usize, usize)> {
    for i in 0..input.len() {
        let first = if input[i] == 13 && input.get(i + 1) == Some(&10) {
            2
        } else if input[i] == 10 {
            1
        } else {
            continue;
        };
        let j = i + first;
        if input.get(j) == Some(&10) {
            return Some((i, first + 1));
        }
        if input.get(j) == Some(&13) && input.get(j + 1) == Some(&10) {
            return Some((i, first + 2));
        }
    }
    None
}

fn value_length(value: &JsValue) -> bool {
    match value {
        JsValue::String(s) => !s.is_empty(),
        JsValue::Array(a) => !a.is_empty(),
        JsValue::Object(_) => truthy(prop(value, "length")),
        _ => false,
    }
}
fn frame_progress(frame: &[u16]) -> bool {
    let mut data = Vec::new();
    let mut first = true;
    for line in frame.split(|unit| *unit == 10) {
        let line = if line.last() == Some(&13) {
            &line[..line.len() - 1]
        } else {
            line
        };
        if !line.starts_with(&[100, 97, 116, 97, 58]) {
            continue;
        }
        if !first {
            data.push(10);
        }
        first = false;
        data.extend_from_slice(
            JsString::from_units(line[5..].to_vec())
                .trim_start()
                .as_units(),
        );
    }
    let Ok(event) = json_parse(&String::from_utf16_lossy(&data)) else {
        return false;
    };
    let event_type = prop(&event, "type");
    let typ = if truthy(event_type) {
        js_to_string(event_type).to_string_lossy()
    } else {
        String::new()
    };
    let delta = prop(&event, "delta");
    if typ == "content_block_delta"
        && truthy(delta)
        && ["text", "thinking", "partial_json", "signature"]
            .iter()
            .any(|key| matches!(prop(delta, key), JsValue::String(s) if !s.is_empty()))
    {
        return true;
    }
    if let Some(middle) = typ
        .strip_prefix("response.")
        .and_then(|s| s.strip_suffix(".delta"))
    {
        if !middle
            .chars()
            .any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            && matches!(delta, JsValue::String(s) if !s.is_empty())
        {
            return true;
        }
    }
    let block = prop(&event, "content_block");
    if typ == "content_block_start"
        && truthy(block)
        && (["text", "thinking"]
            .iter()
            .any(|key| value_length(prop(block, key)))
            || prop(block, "type") == &JsValue::from("tool_use"))
    {
        return true;
    }
    if typ == "response.output_item.added" {
        let item_type = prop(prop(&event, "item"), "type");
        let item_type = if truthy(item_type) {
            js_to_string(item_type).to_string_lossy()
        } else {
            String::new()
        };
        if item_type.contains("function_call") || item_type.contains("custom_tool_call") {
            return true;
        }
    }
    false
}

impl ModelStreamProgress {
    pub fn feed_text(&mut self, chunk: &str) -> bool {
        self.pending.extend(chunk.encode_utf16());
        self.drain()
    }
    pub fn feed_bytes(&mut self, bytes: &[u8]) -> bool {
        self.pending.extend(self.decoder.feed(bytes).encode_utf16());
        self.drain()
    }
    fn drain(&mut self) -> bool {
        let mut progress = false;
        while let Some((at, length)) = boundary(&self.pending) {
            if self.dropping {
                self.dropping = false;
            } else if frame_progress(&self.pending[..at]) {
                progress = true;
            }
            self.pending.drain(..at + length);
        }
        if self.pending.len() > MAX_PENDING_UNITS {
            self.pending.clear();
            self.dropping = true;
        }
        progress
    }
}

#[cfg(test)]
mod tests {
    use super::ModelStreamProgress;

    #[test]
    fn split_utf8_and_sse_frames_only_renew_for_model_output() {
        let mut state = ModelStreamProgress::default();
        assert!(!state.feed_bytes(b": keepalive\n\ndata: {\"type\":\"message_start\"}\n\n"));
        let event =
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\r\n\r\n".as_bytes();
        for part in event.chunks(2).take(event.len().div_ceil(2) - 1) {
            assert!(!state.feed_bytes(part));
        }
        let last = &event[(event.len().div_ceil(2) - 1) * 2..];
        assert!(state.feed_bytes(last));
        assert!(!state.feed_bytes(b"data: {\"type\":\"response.completed\"}\n\n"));
    }

    #[test]
    fn oversized_partial_frame_is_discarded_until_its_boundary() {
        let mut state = ModelStreamProgress::default();
        assert!(!state.feed_bytes(&vec![b'x'; 262_145]));
        assert!(!state.feed_bytes(b"data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\"}}\n\n"));
        assert!(state.feed_bytes(b"data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\"}}\n\n"));
    }
}
