//! Pure text rules of the background-task owner: status normalisation, agent
//! report extraction and the output caps. File IO and redaction stay at the
//! addon boundary because both are host ports.
use crate::js::{
    coerce::{js_to_string, truthy},
    json_parse,
    string::JsString,
    JsValue,
};

/// `String(value || 'running').toLowerCase()` reduced to the four statuses the
/// ledger and frames use.
pub fn status_for_progress(value: Option<&JsValue>) -> &'static str {
    let text = match value {
        Some(value) if truthy(value) => js_to_string(value),
        _ => JsString::from_rust_str("running"),
    };
    classify_status(&text.to_lowercase(), "running")
}

/// `String(value || 'completed').toLowerCase()`; anything that is not a
/// completion or a failure is an interruption.
pub fn status_for_completion(value: Option<&JsValue>) -> &'static str {
    let text = match value {
        Some(value) if truthy(value) => js_to_string(value),
        _ => JsString::from_rust_str("completed"),
    };
    classify_status(&text.to_lowercase(), "interrupted")
}

fn classify_status(status: &JsString, fallback: &'static str) -> &'static str {
    if status == "completed" {
        "completed"
    } else if status == "failed" || status == "error" {
        "failed"
    } else if status == "cancelled"
        || status == "canceled"
        || status == "stopped"
        || status == "interrupted"
    {
        "interrupted"
    } else {
        fallback
    }
}

fn split_lines(text: &JsString) -> Vec<JsString> {
    let units = text.as_units();
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (index, unit) in units.iter().enumerate() {
        if *unit == 0x0a {
            lines.push(text.slice_units(start, index));
            start = index + 1;
        }
    }
    lines.push(text.slice_units(start, units.len()));
    lines
}

/// `agentReport(text)`: `null` when the transcript's first record is not a
/// sidechain record, otherwise the last assistant text (possibly `''`).
pub fn agent_report(text: &JsString) -> Option<JsString> {
    let lines = split_lines(text);
    let first = json_parse(&lines.first()?.to_string_lossy()).ok()?;
    match first.get("isSidechain") {
        Some(JsValue::Bool(true)) => {}
        _ => return None,
    }
    for line in lines.iter().rev() {
        let Ok(entry) = json_parse(&line.to_string_lossy()) else {
            continue;
        };
        let content = if matches!(entry.get("type"), Some(JsValue::String(kind)) if kind == "assistant")
        {
            entry
                .get("message")
                .and_then(|message| message.get("content"))
        } else {
            None
        };
        let report = match content {
            Some(JsValue::String(text)) => text.clone(),
            Some(JsValue::Array(blocks)) => {
                let parts: Vec<JsString> = blocks
                    .iter()
                    .filter(|block| {
                        matches!(block.get("type"), Some(JsValue::String(kind)) if kind == "text")
                    })
                    .map(|block| match block.get("text") {
                        Some(value) if !value.is_nullish() => js_to_string(value),
                        _ => JsString::new(),
                    })
                    .collect();
                JsString::join(&parts, &JsString::from_rust_str("\n"))
            }
            _ => JsString::new(),
        };
        if !report.trim().is_empty() {
            return Some(report);
        }
    }
    Some(JsString::new())
}

/// A report is read top-down and truncated at the head; a log keeps its tail.
pub fn report_snippet(text: &JsString, output_cap: f64) -> JsString {
    let limit = output_cap * 8.0;
    if (text.len() as f64) > limit {
        let mut out = text.truncate_units(limit.trunc() as usize);
        out.push_str("\n…（报告已截断）");
        out
    } else {
        text.clone()
    }
}

pub fn log_snippet(text: &JsString, output_cap: f64) -> JsString {
    if (text.len() as f64) > output_cap {
        let count = output_cap.trunc().max(0.0) as usize;
        text.slice_units(text.len().saturating_sub(count), text.len())
    } else {
        text.clone()
    }
}

/// Output that came from the SDK control channel replaces a buffered snippet:
/// it keeps a truncation marker on both ends depending on which side was cut.
pub fn control_snippet(output: &JsString, truncated: bool, output_cap: f64) -> JsString {
    let mut full = JsString::new();
    if truncated {
        full.push_str("…（前面输出过长已截断）\n");
    }
    full.push(output);
    let limit = output_cap * 8.0;
    if (full.len() as f64) > limit {
        let mut out = full.truncate_units(limit.trunc() as usize);
        out.push_str("\n…（输出已截断）");
        out
    } else {
        full
    }
}

/// `slice(-800)` used when merging several snippets.
pub fn tail_units(text: &JsString, count: usize) -> JsString {
    if text.len() > count {
        text.slice_units(text.len() - count, text.len())
    } else {
        text.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    #[test]
    fn progress_status_defaults_and_lowercases() {
        assert_eq!(status_for_progress(None), "running");
        assert_eq!(
            status_for_progress(Some(&JsValue::string("COMPLETED"))),
            "completed"
        );
        assert_eq!(
            status_for_progress(Some(&JsValue::string("error"))),
            "failed"
        );
        assert_eq!(
            status_for_progress(Some(&JsValue::string("Stopped"))),
            "interrupted"
        );
        assert_eq!(
            status_for_progress(Some(&JsValue::string("queued"))),
            "running"
        );
        assert_eq!(status_for_progress(Some(&JsValue::Number(0.0))), "running");
    }

    #[test]
    fn completion_status_only_keeps_completed_and_failed() {
        assert_eq!(status_for_completion(None), "completed");
        assert_eq!(
            status_for_completion(Some(&JsValue::string("completed"))),
            "completed"
        );
        assert_eq!(
            status_for_completion(Some(&JsValue::string("ERROR"))),
            "failed"
        );
        assert_eq!(
            status_for_completion(Some(&JsValue::string("cancelled"))),
            "interrupted"
        );
    }

    #[test]
    fn agent_report_reads_the_last_assistant_text() {
        let transcript = [
            r#"{"isSidechain":true}"#,
            r#"{"type":"user","message":{"content":"x"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"final"},{"type":"tool_use"}]}}"#,
            r#"not json"#,
        ]
        .join("\n");
        assert_eq!(agent_report(&text(&transcript)), Some(text("final")));
    }

    #[test]
    fn agent_report_rejects_non_sidechains_and_returns_empty_when_no_text() {
        assert_eq!(agent_report(&text(r#"{"isSidechain":false}"#)), None);
        assert_eq!(agent_report(&text("null")), None);
        assert_eq!(agent_report(&text("")), None);
        assert_eq!(
            agent_report(&text(
                r#"{"isSidechain":true}
{"type":"user"}"#
            )),
            Some(text(""))
        );
    }

    #[test]
    fn snippets_use_utf16_lengths_and_the_documented_caps() {
        let report = text(&"中".repeat(20));
        let cut = report_snippet(&report, 2.0);
        assert_eq!(cut.len(), 16 + "\n…（报告已截断）".encode_utf16().count());
        let log = text("abcdefghij");
        assert_eq!(log_snippet(&log, 3.0), text("hij"));
        assert_eq!(log_snippet(&log, 30.0), log);
        assert_eq!(tail_units(&log, 4), text("ghij"));
    }
}
