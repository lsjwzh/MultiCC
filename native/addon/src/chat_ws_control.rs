use multicc_core::chat_ws_control::{self, Action};
use napi_derive::napi;

#[napi]
pub fn chat_ws_control_action(message_type: String, share_permission: String) -> &'static str {
    match chat_ws_control::action(&message_type, &share_permission) {
        Action::Pong => "pong",
        Action::Ignore => "ignore",
        Action::Continue => "continue",
    }
}
