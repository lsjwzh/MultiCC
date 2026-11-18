//! Which dispatch target is a terminal, and when a user message named it.
//!
//! Terminal work is executed by a chat gateway because a raw terminal session
//! has no model turn/history channel. New records carry `gatewayFor`
//! explicitly; the `"<terminal-id>-gw-chat"` relation is retained only for
//! gateways created before that metadata existed. Labels never decide the
//! relation — only explicit targeting reads them.
//!
//! Every comparison here is on UTF-16 code units, because the host's
//! `String.prototype.includes`/`endsWith` are: a label carrying an isolated
//! surrogate must match exactly as far as, and no further than, it did in
//! Node.
use crate::js::JsString;

const LEGACY_GATEWAY_SUFFIX: &str = "-gw-chat";

/// `String(value).trim().toLocaleLowerCase()` for the host's default locale.
pub fn normalized(value: &JsString) -> JsString {
    value.trim().to_lowercase()
}

/// `haystack.includes(needle)` on code units. An empty needle is a match, as
/// in JavaScript; every caller here gates on a non-empty needle first.
fn units_contain(haystack: &[u16], needle: &[u16]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack.len() >= needle.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// The terminal id a legacy ephemeral chat gateway is named after.
///
/// Only the suffix carries the relation, so an id that is nothing but the
/// suffix names an empty terminal id, which the caller treats as "names no
/// terminal" rather than as a match.
pub fn legacy_gateway_terminal_id(id: &JsString) -> Option<JsString> {
    let suffix = JsString::from_rust_str(LEGACY_GATEWAY_SUFFIX);
    let units = id.as_units();
    let tail = suffix.as_units();
    if units.len() < tail.len() || units[units.len() - tail.len()..] != *tail {
        return None;
    }
    Some(id.truncate_units(units.len() - tail.len()))
}

/// "Install/configure a terminal" describes the task, not the destination.
/// Terminal routing is explicit only when the originating user text contains
/// the exact stable session id or the complete non-empty label.
pub fn explicitly_names_terminal(user_text: &JsString, id: &JsString, label: &JsString) -> bool {
    let text = normalized(user_text);
    if text.is_empty() {
        return false;
    }
    let id = normalized(id);
    let label = normalized(label);
    (!id.is_empty() && units_contain(text.as_units(), id.as_units()))
        || (!label.is_empty() && units_contain(text.as_units(), label.as_units()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    #[test]
    fn a_legacy_gateway_id_is_only_its_suffix_relation() {
        assert_eq!(
            legacy_gateway_terminal_id(&js("t-1-gw-chat")).map(|id| id.to_string_lossy()),
            Some("t-1".to_string())
        );
        assert!(legacy_gateway_terminal_id(&js("t-1")).is_none());
        assert!(legacy_gateway_terminal_id(&js("gw-chat")).is_none());
        // An id that is only the suffix leaves an empty terminal id, which the
        // caller treats as naming no terminal at all.
        assert_eq!(
            legacy_gateway_terminal_id(&js("-gw-chat")).map(|id| id.is_empty()),
            Some(true)
        );
    }

    #[test]
    fn explicit_targeting_takes_the_whole_id_or_the_whole_label() {
        assert!(explicitly_names_terminal(
            &js("use TERM-7 please"),
            &js("term-7"),
            &js("")
        ));
        assert!(explicitly_names_terminal(
            &js("run in Build Box"),
            &js("term-7"),
            &js("build box")
        ));
        // A prefix of the id is not the id: it must not steer terminal work.
        assert!(!explicitly_names_terminal(
            &js("use term- please"),
            &js("term-7"),
            &js("")
        ));
        assert!(!explicitly_names_terminal(
            &js(""),
            &js("term-7"),
            &js("build box")
        ));
    }

    #[test]
    fn an_empty_label_never_matches_and_blank_text_never_names() {
        assert!(!explicitly_names_terminal(
            &js("anything at all"),
            &js(""),
            &js("")
        ));
        assert!(!explicitly_names_terminal(
            &js("   "),
            &js("term-7"),
            &js("term-7")
        ));
        // Both sides are trimmed and lowercased before comparing.
        assert!(explicitly_names_terminal(
            &js("  TERM-7  "),
            &js("  term-7 "),
            &js("")
        ));
    }

    #[test]
    fn matching_is_on_code_units_not_utf8_bytes() {
        // A lone high surrogate is a single code unit that must compare as
        // itself; a UTF-8 round trip would have replaced it.
        let label = JsString::from_units(vec![0xd83d, 'a' as u16]);
        let text = JsString::from_units(vec!['x' as u16, 0xd83d, 'a' as u16]);
        assert!(explicitly_names_terminal(&text, &JsString::new(), &label));
        let other = JsString::from_units(vec!['x' as u16, 0xd83e, 'a' as u16]);
        assert!(!explicitly_names_terminal(&other, &JsString::new(), &label));
    }
}
