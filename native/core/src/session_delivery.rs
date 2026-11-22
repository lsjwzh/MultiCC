//! Shared policy for continuation delivery to a session.

pub const SYSTEM_PREFIX: &str = "🔇";
pub const DEFAULT_KIND: &str = "continuation";

pub fn should_prefix(system: bool, already_prefixed: bool) -> bool {
    system && !already_prefixed
}

pub fn should_log_rejection(result_is_false: bool, ok_is_false: bool) -> bool {
    result_is_false || ok_is_false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_and_rejection_truth_tables() {
        for first in [false, true] {
            for second in [false, true] {
                assert_eq!(should_prefix(first, second), first && !second);
                assert_eq!(should_log_rejection(first, second), first || second);
            }
        }
        assert_eq!(SYSTEM_PREFIX, "🔇");
        assert_eq!(DEFAULT_KIND, "continuation");
    }
}
