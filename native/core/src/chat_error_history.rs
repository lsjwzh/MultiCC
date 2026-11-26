//! Keep transient Codex reconnects out of history. A prefix alone is not
//! sufficient: a trailing failure must describe an interrupted stream.
use crate::js::js_trim;
use regex::Regex;
use std::sync::LazyLock;
static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^codex(?: exp| exec)? 出错：reconnecting\.\.\.[\t-\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*[0-9]+/[0-9]+").unwrap()
});
static DETAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\([^\n\r\x{2028}\x{2029}]*(?:stream disconnected before completion|response\.completed)[^\n\r\x{2028}\x{2029}]*\)\z").unwrap()
});
pub fn reconnect(text: &str) -> bool {
    let folded = js_trim(text).to_ascii_lowercase();
    PREFIX
        .find(&folded)
        .is_some_and(|m| m.end() == folded.len() || DETAIL.is_match(&folded))
}
