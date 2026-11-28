//! Voice ACP text rules. All text offsets are ECMAScript UTF-16 units.
use crate::js::{
    regex::{ascii_ci, from_unit_view, to_unit_view, SPACE},
    JsString,
};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

pub const ADMISSION_MIN: f64 = 60_000.;
pub const ADMISSION_MAX: f64 = 290_000.;
pub const ADMISSION_DEFAULT: f64 = 270_000.;
pub const UNCERTAIN: &str = "这条任务的提交状态还没有确认，请稍后在 MultiCC 任务板上查看。";
pub const HANDLED: &str = "MultiCC 已处理这条语音请求。";
pub const INSTRUCTIONS_PATTERN: &str =
    r"<qwen_audio_agent_backend_instructions>[\s\S]*?</qwen_audio_agent_backend_instructions>\s*";
static ENVELOPE: LazyLock<Regex> = LazyLock::new(|| {
    let tag = ascii_ci("qwen_audio_agent_request");
    Regex::new(&format!("(?s)<{tag}>(.*?)</{tag}>")).unwrap()
});
static INSTRUCTIONS: LazyLock<Regex> = LazyLock::new(|| {
    let tag = ascii_ci("qwen_audio_agent_backend_instructions");
    Regex::new(&format!("(?s)<{tag}>.*?</{tag}>[{SPACE}]*")).unwrap()
});

pub fn envelopes(raw: &JsString) -> (Vec<JsString>, JsString) {
    let view = to_unit_view(raw);
    let values = ENVELOPE
        .captures_iter(&view)
        .map(|v| from_unit_view(&v[1]))
        .collect();
    let legacy = ENVELOPE.replace_all(&view, "");
    let legacy = INSTRUCTIONS.replace_all(&legacy, "");
    (values, from_unit_view(&legacy).trim())
}
pub fn request_text(final_asr: JsString, objective: JsString) -> JsString {
    let a = final_asr.trim().truncate_units(12_000);
    let b = objective.trim().truncate_units(12_000);
    if !a.is_empty() && !b.is_empty() && a != b {
        let mut out = JsString::from("用户语音原话：");
        out.push(&a);
        out.push_str("\n\n整理后的任务目标：");
        out.push(&b);
        out
    } else if a.is_empty() {
        b
    } else {
        a
    }
}
pub fn assistant_delta(prior: &JsString, value: &JsString, snapshot: bool) -> (JsString, JsString) {
    if !snapshot {
        let mut next = prior.clone();
        next.push(value);
        return (value.clone(), next);
    }
    if value.as_units().starts_with(prior.as_units()) {
        return (value.slice_units(prior.len(), value.len()), value.clone());
    }
    if prior.as_units().starts_with(value.as_units()) {
        return (JsString::new(), prior.clone());
    }
    (value.clone(), value.clone())
}
pub fn queue_entry(session: &JsString, client: &JsString) -> String {
    let mut key = session.clone();
    key.push_str("\0key:");
    key.push(client);
    let hash = format!("{:x}", Sha256::digest(key.utf8_lossy_bytes()));
    format!("session-work:{}", &hash[..40])
}
pub fn tool_kind(name: &JsString) -> &'static str {
    let name = name.to_string_lossy().to_lowercase();
    for (words, kind) in [
        (&["read", "search", "find", "list", "status"][..], "read"),
        (&["edit", "write", "patch", "create"][..], "edit"),
        (&["delete", "remove"][..], "delete"),
        (&["bash", "shell", "exec", "command"][..], "execute"),
    ] {
        if words.iter().any(|v| name.contains(v)) {
            return kind;
        }
    }
    "other"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn envelope_count_and_legacy_instructions_keep_utf16_units() {
        let raw = JsString::from("<QWEN_AUDIO_AGENT_REQUEST>{}</QWEN_AUDIO_AGENT_REQUEST><qwen_audio_agent_request>bad</qwen_audio_agent_request>fallback");
        let (frames, legacy) = envelopes(&raw);
        assert_eq!(frames.len(), 2);
        assert_eq!(legacy, JsString::from("fallback"));
        let raw = JsString::from_units(vec![0xdfff, 32, 0xfeff]);
        assert_eq!(envelopes(&raw).1.as_units(), &[0xdfff]);
    }
    #[test]
    fn request_limits_and_snapshot_overlap_use_units() {
        let a = JsString::from_units(vec![0xd83d; 12_001]);
        assert_eq!(request_text(a.clone(), a.clone()).len(), 12_000);
        let (delta, snapshot) = assistant_delta(&a, &a.truncate_units(20), true);
        assert!(delta.is_empty());
        assert_eq!(snapshot, a);
    }
    #[test]
    fn queue_id_uses_node_utf8_surrogate_replacement() {
        assert_eq!(
            queue_entry(&JsString::from_units(vec![0xdfff]), &"id".into()),
            queue_entry(&"�".into(), &"id".into())
        );
        assert_eq!(tool_kind(&"write_status".into()), "read");
    }
}
