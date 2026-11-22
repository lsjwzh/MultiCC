//! Decisions for the login-terminal cleanup state machine.

/// A snapshot entry is processed only when it is truthy and its login flow is
/// strictly identical to the normalized requested flow.
pub fn should_dispose(record_truthy: bool, same_flow: bool) -> bool {
    record_truthy && same_flow
}

/// Persistence is called once after the loop, only when something was deleted
/// and the optional save port was provided.
pub fn should_save(disposed: u32, has_save_port: bool) -> bool {
    disposed > 0 && has_save_port
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_and_save_decisions_cover_both_boolean_axes() {
        for present in [false, true] {
            for equal in [false, true] {
                assert_eq!(should_dispose(present, equal), present && equal);
            }
        }
        assert!(!should_save(0, false));
        assert!(!should_save(0, true));
        assert!(!should_save(1, false));
        assert!(should_save(1, true));
        assert!(should_save(u32::MAX, true));
    }
}
