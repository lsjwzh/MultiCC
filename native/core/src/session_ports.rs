//! Canonical port contract definitions for `src/session/` services
//! (former `src/session/ports.js`).

pub const RECORDS_PORT_NAME: &str = "records";
pub const RECORDS_PORT_METHODS: [&str; 2] = ["list", "get"];

pub const RUNTIME_PORT_NAME: &str = "runtime";
pub const RUNTIME_PORT_METHODS: [&str; 1] = ["read"];

pub const WORKSPACE_FACTS_PORT_NAME: &str = "workspaceFacts";
pub const WORKSPACE_FACTS_PORT_METHODS: [&str; 1] = ["read"];

pub const DIRECTORIES_PORT_NAME: &str = "directories";
pub const DIRECTORIES_PORT_METHODS: [&str; 2] = ["list", "get"];

pub const CHAT_HISTORY_PORT_NAME: &str = "history";
pub const CHAT_HISTORY_PORT_METHODS: [&str; 4] =
    ["read", "write", "deleteSession", "hasPersistedDelivery"];

pub fn port_required_error(name: &str) -> String {
    format!("[session] {name} port is required")
}

pub fn port_method_error(name: &str, method: &str) -> String {
    format!("[session] {name}.{method} must be a function")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_specs_and_error_messages_match_contract() {
        assert_eq!(RECORDS_PORT_METHODS, ["list", "get"]);
        assert_eq!(RUNTIME_PORT_METHODS, ["read"]);
        assert_eq!(WORKSPACE_FACTS_PORT_METHODS, ["read"]);
        assert_eq!(DIRECTORIES_PORT_METHODS, ["list", "get"]);
        assert_eq!(
            CHAT_HISTORY_PORT_METHODS,
            ["read", "write", "deleteSession", "hasPersistedDelivery"]
        );
        assert_eq!(
            port_required_error(CHAT_HISTORY_PORT_NAME),
            "[session] history port is required"
        );
        assert_eq!(
            port_method_error(RECORDS_PORT_NAME, "get"),
            "[session] records.get must be a function"
        );
    }
}
