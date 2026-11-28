//! Identify the external task that a polling wait actually observes.
use regex::Regex;
use std::sync::LazyLock;

fn target_path(value: &str) -> Option<&str> {
    static PATH: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:https?://[^/?#[:space:]]+|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})?/api/detached/(d_[A-Za-z0-9_-]+)/?$").unwrap()
    });
    let path = value.split(['?', '#']).next()?;
    PATH.captures(path)?.get(1).map(|id| id.as_str())
}

pub fn detached_target<'a>(url: Option<&'a str>, command: Option<&'a str>) -> Option<&'a str> {
    // A URL probe takes precedence, including when it observes another route.
    if let Some(url) = url.filter(|url| !url.is_empty()) {
        return target_path(url.trim());
    }
    let command = command?.trim();
    if matches!(command.split_whitespace().next(), Some("echo" | "printf")) {
        return None;
    }
    // Inspect URL arguments without executing shell text. Ambiguous commands
    // observing multiple detached tasks cannot belong to a single wake-up.
    let mut ids = command
        .split(|c: char| c.is_whitespace() || "'\"()`|;&".contains(c))
        .filter_map(target_path);
    let first = ids.next()?;
    ids.all(|id| id == first).then_some(first)
}

/// Only a pending FIFO row can change state. A prior withdrawal is an
/// idempotent success even though the wait itself keeps its resolution receipt.
#[derive(Debug, PartialEq, Eq)]
pub enum WaitWithdrawal {
    CancelPending,
    AlreadyCancelled,
    NotPending,
}

pub fn wait_withdrawal(outbox_state: Option<&str>) -> WaitWithdrawal {
    match outbox_state {
        Some("pending") => WaitWithdrawal::CancelPending,
        Some("cancelled") => WaitWithdrawal::AlreadyCancelled,
        _ => WaitWithdrawal::NotPending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_unclaimed_wakeup_can_be_withdrawn_and_retried() {
        assert_eq!(
            wait_withdrawal(Some("pending")),
            WaitWithdrawal::CancelPending
        );
        assert_eq!(
            wait_withdrawal(Some("cancelled")),
            WaitWithdrawal::AlreadyCancelled
        );
        for state in [None, Some("leased"), Some("delivered"), Some("dead")] {
            assert_eq!(wait_withdrawal(state), WaitWithdrawal::NotPending);
        }
    }

    #[test]
    fn bind_only_the_effective_unambiguous_poll_target() {
        let cmd = Some("curl /api/detached/d_a-B_2?view=status");
        assert_eq!(detached_target(None, cmd), Some("d_a-B_2"));
        assert_eq!(detached_target(Some("/other"), cmd), None);
        assert_eq!(detached_target(Some("/api/detached/d_x"), cmd), Some("d_x"));
        assert_eq!(
            detached_target(None, Some("/api/detached/d_a /api/detached/d_b")),
            None
        );
        assert_eq!(detached_target(None, Some("/api/detached/d_")), None);
        assert_eq!(
            detached_target(Some("/health?ref=/api/detached/d_a"), None),
            None
        );
        assert_eq!(detached_target(Some("/api/detached/d_a/log"), None), None);
        assert_eq!(
            detached_target(None, Some("printf '%s' /api/detached/d_a")),
            None
        );
        assert_eq!(
            detached_target(
                None,
                Some(r#"curl -s "$MULTICC_BASE_URL/api/detached/d_a" | jq .done"#)
            ),
            Some("d_a")
        );
    }
}
