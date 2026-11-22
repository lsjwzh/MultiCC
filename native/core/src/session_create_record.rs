//! Pure decisions used when creating a session record.
//!
//! JavaScript values are coerced at the addon boundary, preserving the legacy
//! regular expression's character and end-of-input semantics.

/// The model identifier regexp is `/^[A-Za-z0-9._:\/\[\]-]{1,100}$/`.
pub fn valid_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b':' | b'/' | b'[' | b']' | b'-')
        })
}

pub fn chat_only_cli(cli: &str) -> bool {
    matches!(cli, "claude-exp" | "codex-exp")
}

pub fn provider_family(cli: &str) -> &str {
    match cli {
        "codex-exp" => "codex",
        "claude-exp" => "claude",
        _ => cli,
    }
}

/// The virtual native line has no concrete provider record.
pub fn is_vendor_native_line(provider_id: &str) -> bool {
    [
        "qoder",
        "codebuddy",
        "gemini",
        "pi",
        "commandcode",
        "dsh",
        "grok",
        "agy",
    ]
    .iter()
    .any(|vendor| {
        provider_id
            .strip_prefix(vendor)
            .is_some_and(|tail| tail.starts_with("-native:"))
    })
}

pub fn deferred_workspace(kind_is_chat: bool, has_task: bool, has_owner: bool) -> bool {
    kind_is_chat && has_task && !has_owner
}

pub fn default_subagent_allowed(kind_is_chat: bool, has_login_flow: bool, ephemeral: bool) -> bool {
    kind_is_chat && !has_login_flow && !ephemeral
}

/// Explicit `false` is the only way to disable auto-commit.
pub fn auto_commit(is_explicit_false: bool) -> bool {
    !is_explicit_false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_regexp_ascii_and_length_boundaries() {
        assert!(valid_model("vendor/model-v1:foo[bar]"));
        assert!(valid_model(&"a".repeat(100)));
        assert!(!valid_model(""));
        assert!(!valid_model(&"a".repeat(101)));
        assert!(!valid_model("你好"));
        assert!(!valid_model("invalid model"));
        assert!(!valid_model("a\nb"));
    }

    #[test]
    fn model_dollar_anchor_rejects_line_terminators() {
        for suffix in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
            assert!(!valid_model(&format!("x{suffix}")));
        }
        assert!(!valid_model("x\n\n"));
        assert!(!valid_model("\n"));
    }

    #[test]
    fn native_provider_lines_use_the_exact_case_sensitive_prefix() {
        for vendor in [
            "qoder",
            "codebuddy",
            "gemini",
            "pi",
            "commandcode",
            "dsh",
            "grok",
            "agy",
        ] {
            assert!(is_vendor_native_line(&format!("{vendor}-native:")));
            assert!(is_vendor_native_line(&format!("{vendor}-native:account")));
            assert!(!is_vendor_native_line(&format!("x{vendor}-native:account")));
            assert!(!is_vendor_native_line(&format!("{vendor}-native")));
        }
        assert!(!is_vendor_native_line("Claude-native:claude"));
        assert!(!is_vendor_native_line("codex-native:codex"));
    }

    #[test]
    fn workspace_and_subagent_default_truth_tables() {
        for chat in [false, true] {
            for flag in [false, true] {
                for third in [false, true] {
                    assert_eq!(
                        deferred_workspace(chat, flag, third),
                        chat && flag && !third
                    );
                    assert_eq!(
                        default_subagent_allowed(chat, flag, third),
                        chat && !flag && !third
                    );
                }
            }
        }
    }

    #[test]
    fn cli_and_opt_out_rules() {
        assert!(chat_only_cli("claude-exp"));
        assert!(chat_only_cli("codex-exp"));
        assert!(!chat_only_cli("codex"));
        assert_eq!(provider_family("codex-exp"), "codex");
        assert_eq!(provider_family("claude-exp"), "claude");
        assert_eq!(provider_family("agy"), "agy");
        assert!(auto_commit(false));
        assert!(!auto_commit(true));
    }
}
