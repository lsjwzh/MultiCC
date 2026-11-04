//! Version compatibility for providers that discard structured causes.
//! Accept whole error messages, never substring matches in request/log dumps.
use super::EvidenceKind;
use regex::Regex;
use std::sync::LazyLock;

static OVERFLOW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)^(?:(?:OpenCode|Internal error):\s*)*(?:Conversation history too large to compact(?: - exceeds model context limit)?|context (?:length|window) exceeded|prompt (?:is )?too long)[.!]?$"
).unwrap()
});
static TOKEN_BUDGET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)^This model's maximum context length is (\d+) tokens\. However, you requested (\d+) output tokens and your prompt contains at least (\d+) input tokens\.$"
).unwrap()
});

pub(super) fn context_evidence(message: &str) -> Option<EvidenceKind> {
    if message.len() > 2048 {
        return None;
    }
    let text = message.trim();
    if let Some(parts) = TOKEN_BUDGET.captures(text) {
        let limit = parts[1].parse::<u64>().ok()?;
        let output = parts[2].parse::<u64>().ok()?;
        let input = parts[3].parse::<u64>().ok()?;
        return (limit > 0 && input.checked_add(output)? > limit)
            .then_some(EvidenceKind::TokenBudget);
    }
    OVERFLOW
        .is_match(text)
        .then_some(EvidenceKind::LegacyMessage)
}
