//! Message prompt text and UTF-16 budgets. Live ports and object identity stay in the N-API edge.
use crate::js::JsString;

pub const AUTO_ON: &str = r###"[AutoCommit status as of this message] The page-header AutoCommit switch for this session is currently ON. This is a factual status readout, not an instruction: MultiCC will attempt to commit (and merge, if configured) your changes after this turn on its own; you do not need to run git commit/merge yourself. Do not commit or merge in this prompt unless the user explicitly asked you to in this message -- keep your own statements about committing consistent with this status rather than assuming the opposite.

"###;
pub const AUTO_OFF: &str = r###"[AutoCommit status as of this message] The page-header AutoCommit switch for this session is currently OFF. This is a factual status readout, not an instruction: nothing outside this conversation will commit your changes after this turn. Do not commit or merge in this prompt unless the user explicitly asked you to in this message -- keep your own statements about committing consistent with this status rather than assuming the opposite.

"###;
pub const VOICE_PLAIN: &str = r###"[Voice input] The user message below was dictated and transcribed by speech recognition and has not been proofread by the user. Expect homophone/near-homophone errors (Chinese), English technical terms split or transliterated into Chinese (e.g. "work tree" -> worktree, "瑞迪斯" -> Redis), misheard numbers/file/function/branch names, and wrong punctuation.
- Infer the intended words from the current conversation, the files being worked on, and identifiers that have already appeared.
- If you act on a corrected reading, state it in one line at the top of your reply, e.g. "（按语音纠正理解为：…）". Say nothing if no correction was needed.
- Ask before acting only when different readings lead to different irreversible actions (delete, commit, send, config change); otherwise proceed with the most likely reading.
- Do not comment on transcription quality or ask the user to repeat.
[End of voice input note]

"###;
const VOICE_EDITED_PREFIX: &str = r###"[Voice input] The user message below was dictated and transcribed by speech recognition, then edited before sending (by the user or an automatic cleanup pass). Expect homophone/near-homophone errors (Chinese), English technical terms split or transliterated into Chinese (e.g. "work tree" -> worktree, "瑞迪斯" -> Redis), misheard numbers/file/function/branch names, and wrong punctuation.
- Infer the intended words from the current conversation, the files being worked on, and identifiers that have already appeared.
- If you act on a corrected reading, state it in one line at the top of your reply, e.g. "（按语音纠正理解为：…）". Say nothing if no correction was needed.
- Ask before acting only when different readings lead to different irreversible actions (delete, commit, send, config change); otherwise proceed with the most likely reading.
- Do not comment on transcription quality or ask the user to repeat.
- Raw transcript before editing (prefer the message below; consult this when a word there looks wrong or seems to have been added):
<raw_transcript>
"###;
const VOICE_EDITED_SUFFIX: &str = r###"
</raw_transcript>
[End of voice input note]

"###;
pub const ULTRACODE_SUFFIX: &str =
    "\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]";
pub const ENGLISH_SUFFIX: &str = "\n\nAll output must be in English.";
pub const CHINESE_SUFFIX: &str = "\n\n所有输出都用中文输出。";
pub const NOTES_PREFIX: &str =
    "[multicc cross-agent notes - from other agents in the same directory]\n";
pub const NOTES_SUFFIX: &str = "[End of notes]\n\n";

pub fn voice_prompt(raw: &JsString, edited: bool) -> JsString {
    if !edited {
        return JsString::from_rust_str(VOICE_PLAIN);
    }
    let mut text = JsString::from_rust_str(VOICE_EDITED_PREFIX);
    text.push(raw);
    text.push_str(VOICE_EDITED_SUFFIX);
    text
}

pub fn clip_notes(text: JsString) -> JsString {
    if text.len() <= 4000 {
        return text;
    }
    let mut clipped = text.truncate_units(4000);
    clipped.push_str("\n...(truncated)\n\n");
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipping_keeps_the_historical_utf16_boundary() {
        let mut text = JsString::from_rust_str(&"x".repeat(3999));
        text.push_str("😀tail");
        let clipped = clip_notes(text);
        assert_eq!(clipped.code_unit_at(3999), Some(0xd83d));
        assert_eq!(clipped.code_unit_at(4000), Some(10));
        assert_eq!(
            clip_notes(JsString::from_rust_str(&"x".repeat(4000))).len(),
            4000
        );
    }
    #[test]
    fn voice_prompts_preserve_lone_surrogates_and_hide_unedited_raw_text() {
        let raw = JsString::from_units(vec![0xd800, 65]);
        assert_eq!(
            voice_prompt(&raw, false),
            JsString::from_rust_str(VOICE_PLAIN)
        );
        assert!(voice_prompt(&raw, true)
            .as_units()
            .windows(2)
            .any(|w| w == raw.as_units()));
        assert!(AUTO_ON.contains("unless the user explicitly asked"));
        assert!(AUTO_OFF.contains("currently OFF"));
    }
}
