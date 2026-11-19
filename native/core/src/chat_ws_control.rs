//! Admission for chat WebSocket messages after connection authorization.
//! Ping precedes the share permission gate, including for view-only guests.

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Pong,
    Ignore,
    Continue,
}

pub fn action(message_type: &str, share_permission: &str) -> Action {
    if message_type == "ping" {
        return Action::Pong;
    }
    if share_permission == "view"
        || (share_permission == "operate"
            && !matches!(message_type, "user_message" | "cancel" | "typing"))
    {
        return Action::Ignore;
    }
    Action::Continue
}
