//! Shared policy for a session's staged configuration.

/// Reuse the same field order as session-fork configuration.
pub const CONFIG_FIELDS: [&str; 7] = crate::session_subagent::CONFIG_FIELDS;

/// Only these two preparation phases block configuration changes.
pub fn preparation_busy(phase: Option<&str>) -> bool {
    matches!(phase, Some("preparing" | "running"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_busy_is_exact_and_case_sensitive() {
        assert!(preparation_busy(Some("preparing")));
        assert!(preparation_busy(Some("running")));
        for other in [
            None,
            Some(""),
            Some("Preparing"),
            Some("queued"),
            Some("done"),
        ] {
            assert!(!preparation_busy(other));
        }
    }

    #[test]
    fn configuration_fields_preserve_wire_order() {
        assert_eq!(
            CONFIG_FIELDS,
            [
                "provider",
                "providerSelection",
                "model",
                "effort",
                "agent",
                "subagent",
                "rolePrompt"
            ]
        );
    }
}
