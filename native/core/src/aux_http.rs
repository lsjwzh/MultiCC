//! Aux wire transport: one bounded request, no session state or retry loop.
use crate::js::JsString;
pub const LIMIT: usize = 16 * 1024 * 1024;
/// Per-request ownership stays native; JS only holds the opaque socket/timer.
#[derive(Default)]
pub struct ResponseState {
    pub settled: bool,
    pub data: JsString,
    bytes: usize,
}
impl ResponseState {
    pub fn append(&mut self, chunk: &JsString) -> bool {
        self.bytes += chunk.utf8_lossy_bytes().len();
        if self.bytes > LIMIT {
            return false;
        }
        self.data.push(chunk);
        true
    }
    pub fn settle(&mut self) -> bool {
        if self.settled {
            false
        } else {
            self.settled = true;
            true
        }
    }
}
/// Keep event extraction separate from response/text decoding: Doctor consumes
/// the entire completed object, including function_call and reasoning items.
pub fn payloads(data: &JsString) -> Vec<JsString> {
    let units = data.as_units();
    let mut normalized = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        if units[i] == 13 && units.get(i + 1) == Some(&10) {
            normalized.push(10);
            i += 2;
        } else {
            normalized.push(units[i]);
            i += 1;
        }
    }
    let mut events = Vec::new();
    let mut start = 0;
    for end in 0..=normalized.len() {
        if end != normalized.len()
            && !(normalized[end] == 10 && normalized.get(end + 1) == Some(&10))
        {
            continue;
        }
        if end < start {
            continue;
        }
        let event = &normalized[start..end];
        let mut lines = Vec::new();
        for line in event.split(|u| *u == 10) {
            if line.starts_with(&[100, 97, 116, 97, 58]) {
                lines.push(JsString::from_units(line[5..].to_vec()).trim_start());
            }
        }
        let value = JsString::join(&lines, &JsString::from("\n"));
        if !value.is_empty() && value != "[DONE]" {
            events.push(value);
        }
        start = end + 2;
    }
    events
}
pub fn is_failure_event(kind: &str) -> bool {
    matches!(kind, "error" | "response.failed" | "response.incomplete")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_settles_once_and_counts_utf8_bytes() {
        let mut state = ResponseState::default();
        assert!(state.append(&JsString::from("😀")));
        assert_eq!(state.bytes, 4);
        assert!(state.settle());
        assert!(!state.settle());
        let mut capped = ResponseState::default();
        assert!(!capped.append(&JsString::from("x".repeat(LIMIT + 1).as_str())));
        assert!(capped.data.is_empty());
    }
    #[test]
    fn events_preserve_multiline_data_and_ecmascript_whitespace() {
        let data = JsString::from("event: ignored\r\ndata: \u{feff}{\r\ndata: \"type\":\"response.completed\"}\r\n\r\ndata: [DONE]\n\n");
        assert_eq!(
            payloads(&data),
            vec![JsString::from("{\n\"type\":\"response.completed\"}")]
        );
        assert!(is_failure_event("response.incomplete"));
        assert!(!is_failure_event("response.output_text.delta"));
    }
}
