//! Final speech text emitted by the dispatch gateway and the voice ACP bridge.
//! Match each ECMAScript code unit so private values containing a lone surrogate
//! can be removed without altering nearby speech.
use crate::js::{
    regex::{ascii_ci, from_unit_view, to_unit_view, BOUNDARY, SPACE},
    string::{is_js_whitespace_char, js_trim},
    JsString,
};
use regex::Regex;
use std::borrow::Cow;
use std::sync::LazyLock;

fn envelope(tag: &str) -> Regex {
    let tag = ascii_ci(tag);
    Regex::new(&format!(r"(?s)<{tag}>.*?</{tag}>")).expect("fixed voice envelope")
}

static INSTRUCTIONS: LazyLock<Regex> =
    LazyLock::new(|| envelope("qwen_audio_agent_backend_instructions"));
static REQUEST: LazyLock<Regex> = LazyLock::new(|| envelope("qwen_audio_agent_request"));

// Expand the old (dispatch|route) backreference into two alternatives. Keeping
// one leftmost search matters when the two different tags are nested.
static MARKER: LazyLock<Regex> = LazyLock::new(|| {
    let branches = ["dispatch", "route"].map(|tag| {
        let tag = ascii_ci(tag);
        format!(r"<<[{SPACE}]*{tag}{BOUNDARY}[^>]*>.*?</[{SPACE}]*{tag}[{SPACE}]*>>?")
    });
    Regex::new(&format!("(?s){}", branches.join("|"))).expect("fixed voice marker")
});
static CLOSING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"</[{SPACE}]*(?:{}|{})[{SPACE}]*>>?",
        ascii_ci("dispatch"),
        ascii_ci("route")
    ))
    .expect("fixed closing marker")
});
static UNIX_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"/(?:Users|home|tmp|var|private|opt|Volumes)/[^{SPACE}，。！？；：]+"
    ))
    .expect("fixed Unix path")
});
static WINDOWS_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"[A-Za-z]:\\[^{SPACE}，。！？；：]+")).expect("fixed Windows path")
});
static LINE_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+\n").unwrap());
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{2,}").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]{2,}").unwrap());

fn replace(text: &mut String, regex: &Regex, by: &str) {
    if let Cow::Owned(next) = regex.replace_all(text, by) {
        *text = next;
    }
}

fn strip_suffix(mut text: &str) -> &str {
    while let Some(at) = text.rfind("<<") {
        let suffix = text[at + 2..].trim_start_matches(is_js_whitespace_char);
        let token = suffix
            .split(|c| is_js_whitespace_char(c) || matches!(c, '=' | '>'))
            .next()
            .unwrap_or("");
        let token = token.to_lowercase();
        if !["dispatch", "route"]
            .iter()
            .any(|tag| tag.starts_with(&token) || token.starts_with(tag))
        {
            break;
        }
        text = &text[..at];
    }
    text
}

pub fn strip_truncated(text: &JsString) -> JsString {
    from_unit_view(strip_suffix(&to_unit_view(text)))
}

pub fn sanitize(raw: &JsString, private_values: &[JsString]) -> JsString {
    let mut text = to_unit_view(raw);
    if text.contains('<') {
        for regex in [&*INSTRUCTIONS, &*REQUEST, &*MARKER, &*CLOSING] {
            replace(&mut text, regex, "");
        }
        text.truncate(strip_suffix(&text).len());
    }
    for value in private_values {
        let value = to_unit_view(value);
        let needle = js_trim(&value);
        if !needle.is_empty() && text.contains(needle) {
            text = text.replace(needle, "");
        }
    }
    if text.contains('/') {
        replace(&mut text, &UNIX_PATH, "");
    }
    if text.contains('\\') {
        replace(&mut text, &WINDOWS_PATH, "");
    }
    if text.contains('\n') {
        replace(&mut text, &LINE_END, "\n");
        replace(&mut text, &BLANK_LINES, "\n");
    }
    replace(&mut text, &SPACES, " ");
    from_unit_view(js_trim(&text))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_mixed_tags_use_the_close_for_the_first_opening_tag() {
        let raw = JsString::from("a<<route>x<<dispatch>y</route>>z</dispatch>>b");
        assert_eq!(sanitize(&raw, &[]), JsString::from("azb"));
    }
    #[test]
    fn removing_half_a_pair_preserves_the_other_code_unit() {
        let raw = JsString::from_units(vec![0xd83d, 0xde00, 0xdfff]);
        let private = JsString::from_units(vec![0xde00]);
        assert_eq!(sanitize(&raw, &[private]).as_units(), &[0xd83d, 0xdfff]);
    }
}
