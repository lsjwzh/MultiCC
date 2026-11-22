//! Pure decisions for the hibernation reclaimer (former
//! `src/session/hibernation-reclaimer.js`). The addon owns every V8 read;
//! this module owns the numeric and boolean rules so both sides stay
//! byte-identical.

/// `Math.max(1, Math.min(64, Number(count) || 1))` with `count` already
/// coerced. A falsy coercion (`0`, `-0`, `NaN`) falls back to `1`.
pub fn capacity_limit(count: f64) -> f64 {
    let count = if count == 0.0 || count.is_nan() {
        1.0
    } else {
        count
    };
    // NaN and zero were replaced above, so clamp's NaN behavior is unreachable.
    count.clamp(1.0, 64.0)
}

/// How one settled `hibernate()` result moves the run counters. The legacy
/// loop reads `ok`/`hibernated` first, then `skipped`/`already`; anything
/// else counts as failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    Hibernated,
    Skipped,
    Failed,
}

pub fn classify_hibernate_result(
    ok: bool,
    hibernated: bool,
    skipped: bool,
    already: bool,
) -> RunOutcome {
    if ok && hibernated {
        RunOutcome::Hibernated
    } else if skipped || already {
        RunOutcome::Skipped
    } else {
        RunOutcome::Failed
    }
}

/// `idleMsOverride != null && Number.isFinite(Number(idleMsOverride))`: only a
/// non-nullish, finitely-coercible override replaces the runtime default.
pub fn use_idle_override(override_not_nullish: bool, override_finite: bool) -> bool {
    override_not_nullish && override_finite
}

/// `reportSkips ?? !ignoreIdle`: the first conjunct of the skip-publish gate,
/// split out so the caller can keep the legacy short-circuit (the record
/// reads for `taskBoundTaskId`/`kind` never happen when this is false).
/// `report_skips` is `None` when the option is nullish.
pub fn skip_gate(report_skips: Option<bool>, ignore_idle: bool) -> bool {
    report_skips.unwrap_or(!ignore_idle)
}

/// `(reportSkips ?? !ignoreIdle) && record?.taskBoundTaskId && record.kind === 'chat'`.
/// `report_skips` is `None` when the option is nullish, `Some(t)` with its
/// truthiness otherwise.
pub fn should_publish_skip(
    report_skips: Option<bool>,
    ignore_idle: bool,
    task_bound: bool,
    kind_is_chat: bool,
) -> bool {
    skip_gate(report_skips, ignore_idle) && task_bound && kind_is_chat
}

/// `hibernated >= limit`: the success budget check that ends the scan early.
pub fn run_limit_reached(hibernated: f64, limit: f64) -> bool {
    hibernated >= limit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_limit_clamps_and_replaces_falsy() {
        assert_eq!(capacity_limit(1.0), 1.0);
        assert_eq!(capacity_limit(0.0), 1.0);
        assert_eq!(capacity_limit(-0.0), 1.0);
        assert_eq!(capacity_limit(f64::NAN), 1.0);
        assert_eq!(capacity_limit(-5.0), 1.0);
        assert_eq!(capacity_limit(0.5), 1.0);
        assert_eq!(capacity_limit(2.7), 2.7);
        assert_eq!(capacity_limit(64.0), 64.0);
        assert_eq!(capacity_limit(100.0), 64.0);
        assert_eq!(capacity_limit(f64::INFINITY), 64.0);
    }

    #[test]
    fn classification_prefers_hibernated_then_skipped() {
        assert_eq!(
            classify_hibernate_result(true, true, false, false),
            RunOutcome::Hibernated
        );
        assert_eq!(
            classify_hibernate_result(true, true, true, false),
            RunOutcome::Hibernated
        );
        assert_eq!(
            classify_hibernate_result(false, false, true, false),
            RunOutcome::Skipped
        );
        assert_eq!(
            classify_hibernate_result(false, false, false, true),
            RunOutcome::Skipped
        );
        assert_eq!(
            classify_hibernate_result(true, false, false, false),
            RunOutcome::Failed
        );
        assert_eq!(
            classify_hibernate_result(false, false, false, false),
            RunOutcome::Failed
        );
    }

    #[test]
    fn idle_override_requires_value_and_finiteness() {
        assert!(use_idle_override(true, true));
        assert!(!use_idle_override(true, false));
        assert!(!use_idle_override(false, true));
        assert!(!use_idle_override(false, false));
    }

    #[test]
    fn skip_gate_is_the_nullish_default_conjunct() {
        assert!(skip_gate(None, false));
        assert!(!skip_gate(None, true));
        assert!(skip_gate(Some(true), true));
        assert!(!skip_gate(Some(false), false));
    }

    #[test]
    fn skip_publish_follows_report_default_and_record_shape() {
        assert!(should_publish_skip(None, false, true, true));
        assert!(!should_publish_skip(None, true, true, true));
        assert!(should_publish_skip(Some(true), true, true, true));
        assert!(!should_publish_skip(Some(false), false, true, true));
        assert!(!should_publish_skip(None, false, false, true));
        assert!(!should_publish_skip(None, false, true, false));
    }

    #[test]
    fn limit_reached_matches_ge_comparison() {
        assert!(!run_limit_reached(0.0, 1.0));
        assert!(run_limit_reached(1.0, 1.0));
        assert!(!run_limit_reached(2.0, 2.7));
        assert!(run_limit_reached(3.0, 2.7));
        assert!(!run_limit_reached(0.0, f64::NAN));
    }
}
