//! Pure rules for per-session subagent routing (`src/session/subagent.js`)
//! and fork configuration projection (`src/session/fork-configuration.js`).

pub const CONFIG_FIELDS: [&str; 9] = [
    "provider",
    "providerSelection",
    "model",
    "effort",
    "agent",
    "subagent",
    "rolePrompt",
    "claudeWorkflow",
    "preferSubtasks",
];

pub const ERR_UNSUPPORTED_CLI: &str = "subagent routing is only supported by Claude and Codex";
pub const ERR_INVALID_SUBAGENT: &str = "invalid subagent";
pub const ERR_INVALID_PROVIDER: &str = "invalid subagent provider";
pub const ERR_MODEL_REQUIRED: &str = "subagent model required";
pub const ERR_CODEX_MAIN_PROVIDER: &str =
    "Codex subagent routing requires a selected main provider";
pub const ERR_CODEX_NO_ENDPOINT: &str = "Codex subagent provider has no callable HTTP endpoint";

pub fn normalize_app_type(cli: Option<&str>) -> &str {
    match cli {
        Some("codex-exp") => "codex",
        Some("claude-exp") => "claude",
        Some(value) if !value.is_empty() => value,
        _ => "claude",
    }
}

pub fn is_supported_app_type(app_type: &str) -> bool {
    matches!(app_type, "claude" | "codex")
}

pub fn family_of_cli(cli: Option<&str>) -> Option<&'static str> {
    match cli {
        Some("claude" | "claude-exp") => Some("claude"),
        Some("codex" | "codex-exp") => Some("codex"),
        _ => None,
    }
}

pub fn should_mark_inherited(same_route: bool, previous_inherited: bool, inherited: bool) -> bool {
    inherited || (same_route && previous_inherited)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_cli_to_app_type_and_family() {
        assert_eq!(normalize_app_type(None), "claude");
        assert_eq!(normalize_app_type(Some("")), "claude");
        assert_eq!(normalize_app_type(Some("claude")), "claude");
        assert_eq!(normalize_app_type(Some("claude-exp")), "claude");
        assert_eq!(normalize_app_type(Some("codex")), "codex");
        assert_eq!(normalize_app_type(Some("codex-exp")), "codex");
        assert_eq!(normalize_app_type(Some("opencode")), "opencode");

        assert!(is_supported_app_type("claude"));
        assert!(is_supported_app_type("codex"));
        assert!(!is_supported_app_type("opencode"));
        assert!(!is_supported_app_type("gemini"));

        assert_eq!(family_of_cli(Some("claude")), Some("claude"));
        assert_eq!(family_of_cli(Some("claude-exp")), Some("claude"));
        assert_eq!(family_of_cli(Some("codex")), Some("codex"));
        assert_eq!(family_of_cli(Some("codex-exp")), Some("codex"));
        assert_eq!(family_of_cli(Some("opencode")), None);
        assert_eq!(family_of_cli(None), None);
    }

    #[test]
    fn provenance_inheritance_follows_route_identity() {
        assert!(should_mark_inherited(false, false, true));
        assert!(should_mark_inherited(true, true, false));
        assert!(!should_mark_inherited(false, true, false));
        assert!(!should_mark_inherited(true, false, false));
    }

    #[test]
    fn config_fields_match_canonical_order() {
        assert_eq!(
            CONFIG_FIELDS,
            [
                "provider",
                "providerSelection",
                "model",
                "effort",
                "agent",
                "subagent",
                "rolePrompt",
                "claudeWorkflow",
                "preferSubtasks",
            ]
        );
    }
}
