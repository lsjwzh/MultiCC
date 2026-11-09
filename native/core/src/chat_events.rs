//! Pure decisions for the per-event chat reducer.
//!
//! `applyClaudeChatEvent` used to keep these as small JavaScript helpers next to
//! its mutation code (`statusOf`, `apiErrorMessageOf`, the error-only test and
//! the envelope-body selection). They are string/boolean rules with no host
//! state, so they live here and are unit tested directly. The live-object walk
//! stays in `native/addon/src/chat_events.rs`.
use crate::js::JsString;

/// `statusOf`: `Number(value)` keeps only a finite HTTP status and rounds it.
/// `None` represents `null`.
pub fn status_of(value: Option<f64>) -> Option<f64> {
    let number = value?;
    if !number.is_finite() || !(100.0..=599.0).contains(&number) {
        return None;
    }
    Some(number.round())
}

/// `apiErrorMessageOf`: uuid identifies a delivery, otherwise the request id
/// plus the message text does. Without either there is no identity to drop.
pub fn api_error_key(
    uuid: Option<&JsString>,
    request_id: Option<&JsString>,
    text: &JsString,
) -> Option<JsString> {
    if let Some(uuid) = uuid {
        return Some(uuid.clone());
    }
    request_id.map(|request| JsString::concat(&[request, &JsString::from_units(vec![0]), text]))
}

/// An error-only turn: no accumulated answer text and no tool output yet.
/// Only then may the envelope be appended (the pre-existing retry semantics).
pub fn is_error_only(base_text: &JsString, tool_count: usize) -> bool {
    base_text.trim().is_empty() && tool_count == 0
}

/// `apiErrorEnvelope().body`: an appended envelope carries the text it replaced
/// (`bodyBefore`); otherwise the turn's current answer is the partial body.
/// `None` means the body is JS `null`.
pub fn envelope_body(
    appended: bool,
    body_before: Option<&JsString>,
    current_text: Option<&JsString>,
) -> Option<JsString> {
    if appended {
        return body_before.filter(|text| !text.trim().is_empty()).cloned();
    }
    current_text.filter(|text| !text.trim().is_empty()).cloned()
}

/// `httpStatus: pending.httpStatus ?? parsed?.httpStatus ?? null`.
pub fn pick_http_status(pending: Option<f64>, parsed: Option<f64>) -> Option<f64> {
    pending.or(parsed)
}

/// `resultSucceeded && !envelopeError && (cs.currentAssistantText || cs.currentToolCalls.length)`.
/// `text_present` and `tool_present` are the already-lifted truthiness values.
pub fn has_result_output(text_present: bool, tool_present: bool) -> bool {
    text_present || tool_present
}

/// `resultCompletion.state === 'failed' && resultCompletion.source === 'protocol'`.
pub fn is_api_failure(state: Option<&JsString>, source: Option<&JsString>) -> bool {
    matches!(state, Some(value) if value.as_units() == utf16("failed"))
        && matches!(source, Some(value) if value.as_units() == utf16("protocol"))
}

fn utf16(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    #[test]
    fn status_keeps_only_finite_http_codes() {
        assert_eq!(status_of(Some(429.0)), Some(429.0));
        assert_eq!(status_of(Some(429.4)), Some(429.0));
        assert_eq!(status_of(Some(99.0)), None);
        assert_eq!(status_of(Some(600.0)), None);
        assert_eq!(status_of(Some(f64::INFINITY)), None);
        assert_eq!(status_of(Some(f64::NAN)), None);
        assert_eq!(status_of(None), None);
    }

    #[test]
    fn key_prefers_uuid_then_request_id_plus_text() {
        let body = text("API Error");
        assert_eq!(
            api_error_key(Some(&text("uuid-1")), Some(&text("req-1")), &body),
            Some(text("uuid-1"))
        );
        assert_eq!(
            api_error_key(None, Some(&text("req-1")), &body),
            Some(JsString::concat(&[
                &text("req-1"),
                &JsString::from_units(vec![0]),
                &body
            ]))
        );
        assert_eq!(api_error_key(None, None, &body), None);
    }

    #[test]
    fn error_only_requires_empty_answer_and_no_tools() {
        assert!(is_error_only(&text(""), 0));
        assert!(is_error_only(&text("   \n\t"), 0));
        assert!(!is_error_only(&text("answer"), 0));
        assert!(!is_error_only(&text(""), 1));
    }

    #[test]
    fn envelope_body_keeps_only_meaningful_text() {
        assert_eq!(envelope_body(true, Some(&text("")), None), None);
        assert_eq!(envelope_body(true, Some(&text("  ")), None), None);
        assert_eq!(
            envelope_body(true, Some(&text("answer")), None),
            Some(text("answer"))
        );
        assert_eq!(envelope_body(false, None, Some(&text(""))), None);
        assert_eq!(
            envelope_body(false, None, Some(&text("body"))),
            Some(text("body"))
        );
        assert_eq!(envelope_body(false, None, None), None);
    }

    #[test]
    fn http_status_uses_first_non_nullish() {
        assert_eq!(pick_http_status(Some(429.0), Some(500.0)), Some(429.0));
        assert_eq!(pick_http_status(None, Some(500.0)), Some(500.0));
        assert_eq!(pick_http_status(None, None), None);
    }

    #[test]
    fn output_presence_is_text_or_tools() {
        assert!(has_result_output(true, false));
        assert!(has_result_output(false, true));
        assert!(!has_result_output(false, false));
    }

    #[test]
    fn api_failure_needs_failed_protocol() {
        assert!(is_api_failure(
            Some(&text("failed")),
            Some(&text("protocol"))
        ));
        assert!(!is_api_failure(
            Some(&text("completed")),
            Some(&text("protocol"))
        ));
        assert!(!is_api_failure(Some(&text("failed")), Some(&text("exit"))));
        assert!(!is_api_failure(None, None));
    }
}
