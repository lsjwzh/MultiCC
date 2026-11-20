//! Admission for chat WebSocket messages after connection authorization.
//! Ping precedes the share permission gate, including for view-only guests.

use crate::js::{js_to_string, truthy, JsString, JsValue};

/// Resolve the session for an already authorized socket. Internal slots are
/// indistinguishable from missing records. The host owns lookup and facts.
pub fn open_session_error(
    session: &str,
    present: bool,
    internal: bool,
    kind: &JsValue,
    invalid_reason: Option<&JsString>,
) -> Option<JsValue> {
    let mut fields = vec![("type", JsValue::string("error"))];
    let message = if !present || internal {
        fields.push(("code", JsValue::string("session_not_found")));
        JsString::from_rust_str(&format!(
            "Chat session \"{session}\" does not exist. Create it via the dashboard first."
        ))
    } else if truthy(kind) && !matches!(kind, JsValue::String(value) if value == "chat") {
        let mut message = JsString::from_rust_str(&format!(
            "Session \"{session}\" is not a chat session (kind="
        ));
        message.push(&js_to_string(kind));
        message.push_str(").");
        message
    } else {
        let reason = invalid_reason?;
        let mut message = JsString::from_rust_str("会话已失效（");
        message.push(reason);
        message.push_str("），请删除后重建。");
        message
    };
    fields.push(("error", JsValue::String(message)));
    Some(JsValue::object(fields))
}

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

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Ignore,
    Typing,
    Cancel,
    ClearHistory,
    Message,
    ClearShellHistory,
    RouteShellInput,
    RequireShellRoute,
}

/// Dispatch after the heartbeat and sharing gate has accepted the message.
/// The caller performs the selected action against its session owner.
pub fn command(
    message_type: &str,
    share_permission: &str,
    needs_task_shell: bool,
    has_shell_query: bool,
    task_shell: bool,
    has_text: bool,
) -> Command {
    if needs_task_shell && message_type != "typing" {
        if share_permission.is_empty() && has_shell_query && message_type == "clear_history" {
            return Command::ClearShellHistory;
        }
        if matches!(message_type, "user_message" | "cancel")
            && (share_permission == "operate" || (share_permission.is_empty() && task_shell))
        {
            return Command::RouteShellInput;
        }
        return Command::RequireShellRoute;
    }
    match message_type {
        "typing" => Command::Typing,
        "cancel" => Command::Cancel,
        "clear_history" => Command::ClearHistory,
        "user_message" if has_text => Command::Message,
        _ => Command::Ignore,
    }
}

pub fn is_legacy_cancel(text: &str) -> bool {
    crate::js::js_trim(text).eq_ignore_ascii_case("cancel")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_slot_has_the_same_error_as_missing_record() {
        let denied = open_session_error("s", true, true, &JsValue::string("terminal"), None);
        assert_eq!(
            denied,
            open_session_error("s", false, false, &JsValue::Null, None)
        );
        assert_eq!(
            denied.as_ref().and_then(|value| value.get("code")),
            Some(&JsValue::string("session_not_found"))
        );
    }

    #[test]
    fn older_records_without_kind_open_but_terminal_and_invalid_records_do_not() {
        assert!(open_session_error("s", true, false, &JsValue::Undefined, None).is_none());
        let reason = JsString::from_rust_str("失效原因");
        let wrong_kind = open_session_error(
            "s",
            true,
            false,
            &JsValue::string("terminal"),
            Some(&reason),
        )
        .unwrap();
        assert_eq!(
            wrong_kind.get("error"),
            Some(&JsValue::string(
                "Session \"s\" is not a chat session (kind=terminal)."
            ))
        );
        let invalid =
            open_session_error("s", true, false, &JsValue::string("chat"), Some(&reason)).unwrap();
        assert_eq!(
            invalid.get("error"),
            Some(&JsValue::string("会话已失效（失效原因），请删除后重建。"))
        );
    }

    #[test]
    fn task_shell_control_keeps_share_and_session_boundaries() {
        for (kind, permission, needs, shell, marked, text, expected) in [
            (
                "user_message",
                "",
                true,
                false,
                false,
                true,
                Command::RequireShellRoute,
            ),
            (
                "user_message",
                "",
                true,
                false,
                true,
                true,
                Command::RouteShellInput,
            ),
            (
                "cancel",
                "operate",
                true,
                false,
                false,
                false,
                Command::RouteShellInput,
            ),
            ("cancel", "", false, false, false, false, Command::Cancel),
            (
                "clear_history",
                "",
                true,
                true,
                false,
                false,
                Command::ClearShellHistory,
            ),
            (
                "clear_history",
                "",
                true,
                false,
                false,
                false,
                Command::RequireShellRoute,
            ),
            (
                "clear_history",
                "",
                false,
                false,
                false,
                false,
                Command::ClearHistory,
            ),
            ("typing", "", true, true, false, false, Command::Typing),
            (
                "user_message",
                "",
                false,
                false,
                false,
                false,
                Command::Ignore,
            ),
            (
                "user_message",
                "",
                false,
                false,
                false,
                true,
                Command::Message,
            ),
        ] {
            assert_eq!(
                command(kind, permission, needs, shell, marked, text),
                expected
            );
        }
        assert!(is_legacy_cancel("\u{feff} CaNCeL\r"));
        assert!(!is_legacy_cancel("cancel it"));
    }
}
