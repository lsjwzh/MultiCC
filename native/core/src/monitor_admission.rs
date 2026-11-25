//! Decode the CLI's task-notification envelope before any monitor is probed.
//! The prompt is a JavaScript string and the CLI's field limits count UTF-16 units.
use crate::js::{
    regex::{from_unit_view, to_unit_view},
    JsString, JsValue as V,
};
use std::borrow::Cow;

pub const CALLBACK_ID: &str = "multicc_monitor_admission";
pub const BLOCK_REASON: &str = "MultiCC queued this Monitor notification for an admitted turn.";
pub const MAX_PROMPT_UNITS: usize = 128 * 1024;
pub const OPEN: &str = "<task-notification>";
pub const CLOSE: &str = "</task-notification>";

fn decode(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut parts = text.split('&');
    out.push_str(parts.next().unwrap_or_default());
    for tail in parts {
        let entity = [
            ("lt;", '<'),
            ("gt;", '>'),
            ("quot;", '"'),
            ("apos;", '\''),
            ("amp;", '&'),
        ]
        .into_iter()
        .find_map(|(name, value)| tail.strip_prefix(name).map(|rest| (value, rest)));
        let (value, rest) = entity.unwrap_or(('&', tail));
        out.push(value);
        out.push_str(rest);
    }
    Cow::Owned(out)
}

fn field<'a>(block: &'a str, open: &str, close: &str) -> Cow<'a, str> {
    for (at, _) in block.match_indices(open) {
        let value = &block[at + open.len()..];
        if let Some(end) = value.find('<') {
            if value[end..].starts_with(close) {
                return decode(&value[..end]);
            }
        }
    }
    Cow::Borrowed("")
}

fn text(value: Cow<'_, str>, limit: usize, optional: bool) -> V {
    if optional && value.is_empty() {
        V::Undefined
    } else {
        V::String(from_unit_view(&value).truncate_units(limit))
    }
}

fn event(block: &str) -> Option<V> {
    let id = field(block, "<task-id>", "</task-id>");
    if !(1..=160).contains(&id.len())
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some(V::object(vec![
        ("type", V::string("system")),
        ("subtype", V::string("monitor_prompt")),
        ("task_id", V::string(&id)),
        ("event_id", V::Undefined),
        (
            "summary",
            text(field(block, "<summary>", "</summary>"), 240, false),
        ),
        (
            "status",
            V::String(from_unit_view(&field(block, "<status>", "</status>"))),
        ),
        (
            "output",
            text(field(block, "<event>", "</event>"), 8000, false),
        ),
        (
            "result",
            text(field(block, "<result>", "</result>"), 64 * 1024, true),
        ),
        (
            "output_file",
            text(field(block, "<output-file>", "</output-file>"), 4096, true),
        ),
        (
            "tool_use_id",
            text(field(block, "<tool-use-id>", "</tool-use-id>"), 160, true),
        ),
    ]))
}

/// Keep invalid slots until the host has read prompt_id for every valid slot.
/// A bad task id rejects the whole batch, including valid later siblings.
pub fn notifications(prompt: &JsString) -> Vec<Option<V>> {
    if prompt.len() > MAX_PROMPT_UNITS {
        return Vec::new();
    }
    let input = to_unit_view(prompt);
    if !input.starts_with(OPEN) {
        return Vec::new();
    }
    let mut events = Vec::new();
    let mut rest = input.as_str();
    while let Some((_, content)) = rest.split_once(OPEN) {
        let Some((block, tail)) = content.split_once(CLOSE) else {
            break;
        };
        events.push(event(block));
        rest = tail;
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_each_entity_once_and_uses_the_first_complete_text_field() {
        assert_eq!(decode("&amp;lt;&amp;&bad;&quot;"), "&lt;&&bad;\"");
        assert_eq!(field("<x>bad<b><x>ok</x>", "<x>", "</x>"), "ok");
    }
    #[test]
    fn rejects_an_oversize_prompt_and_preserves_mixed_batch_positions() {
        let tag = |id| format!("{OPEN}<task-id>{id}</task-id>{CLOSE}");
        let message = tag("bad.id") + "text" + &tag("valid");
        let rows = notifications(&JsString::from(message.as_str()));
        assert_eq!(rows.len(), 2);
        assert!(rows[0].is_none() && rows[1].is_some());
        let long = tag("abc") + &"x".repeat(128 * 1024);
        assert!(notifications(&JsString::from(long.as_str())).is_empty());
    }
}
