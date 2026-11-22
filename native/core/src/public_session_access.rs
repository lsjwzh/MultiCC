//! Pure policy for hiding internal task execution slots from public session
//! REST and WebSocket endpoints (former `src/session/public-session-access.js`).

pub const PUBLIC_SESSION_MOUNT_PATHS: [&str; 2] = ["/api/sessions/:id", "/api/v1/sessions/:id"];
pub const DENIED_LOG_EVENT: &str = "internal_execution_slot_public_access_denied";
pub const NOT_FOUND_STATUS: u16 = 404;
pub const NOT_FOUND_ERROR: &str = "session not found";
pub const ERR_RECORDS_REQUIRED: &str = "[public-session-access] records map is required";
pub const ERR_APP_REQUIRED: &str = "[public-session-access] express app is required";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicSessionAccessDecision {
    Allow,
    DelegateV1NotFound,
    Respond404Json,
}

pub fn is_v1_url(url: &str) -> bool {
    url.starts_with("/api/v1/")
}

pub fn decide_access(
    is_internal_slot: bool,
    url: &str,
    has_v1_handler: bool,
) -> PublicSessionAccessDecision {
    if !is_internal_slot {
        return PublicSessionAccessDecision::Allow;
    }
    if is_v1_url(url) && has_v1_handler {
        PublicSessionAccessDecision::DelegateV1NotFound
    } else {
        PublicSessionAccessDecision::Respond404Json
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_sessions_pass_through_regardless_of_url() {
        assert_eq!(
            decide_access(false, "/api/sessions/abc", true),
            PublicSessionAccessDecision::Allow
        );
        assert_eq!(
            decide_access(false, "/api/v1/sessions/abc/waits", true),
            PublicSessionAccessDecision::Allow
        );
    }

    #[test]
    fn internal_slots_hide_behind_404_or_v1_not_found() {
        assert_eq!(
            decide_access(true, "/api/sessions/slot-1", true),
            PublicSessionAccessDecision::Respond404Json
        );
        assert_eq!(
            decide_access(true, "/api/v1/sessions/slot-1/waits", true),
            PublicSessionAccessDecision::DelegateV1NotFound
        );
        assert_eq!(
            decide_access(true, "/api/v1/sessions/slot-1/waits", false),
            PublicSessionAccessDecision::Respond404Json
        );
        assert_eq!(
            decide_access(true, "", true),
            PublicSessionAccessDecision::Respond404Json
        );
    }

    #[test]
    fn mount_paths_cover_legacy_and_v1_session_routes() {
        assert_eq!(
            PUBLIC_SESSION_MOUNT_PATHS,
            ["/api/sessions/:id", "/api/v1/sessions/:id"]
        );
    }
}
