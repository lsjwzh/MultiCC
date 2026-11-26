//! Request-only Responses record identity. Tool call correlation IDs and
//! opaque vendor items are outside this namespace.
use crate::js::JsString;
use sha2::{Digest, Sha256};

pub const ITEM_PREFIXES: [(&str, &str); 5] = [
    ("message", "msg"),
    ("function_call", "fc"),
    ("function_call_output", "fco"),
    ("custom_tool_call", "ctc"),
    ("custom_tool_call_output", "ctco"),
];

pub fn optional_item_field(field: &str) -> bool {
    matches!(
        field,
        "id" | "status" | "internal_chat_message_metadata_passthrough"
    )
}

/// The preimage is the ECMAScript JSON encoding of [type, original ID, index, salt].
pub fn converted_id(prefix: &str, preimage: &JsString) -> String {
    let digest = Sha256::digest(preimage.utf8_lossy_bytes());
    format!("{prefix}_{:.32}", format!("{digest:x}"))
}
