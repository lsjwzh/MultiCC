//! Canonical model identifiers and revisions for both ends of a provider relay.
use crate::js::string::js_trim;
use sha2::{Digest, Sha256};

pub const MAX_MODELS: usize = 100;
pub const MAX_RESPONSE_BYTES: usize = 128 * 1024;
pub const SYNC_INTERVAL: u32 = 15 * 60_000;
pub const RETRY_INTERVAL: u32 = 5 * 60_000;
pub const TIMEOUT: u32 = 5_000;

pub fn push_model(models: &mut Vec<String>, raw: &str) {
    let model = js_trim(raw);
    if model.len() <= 160
        && model
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && model.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-' | b'[' | b']')
        })
        && !models.iter().any(|s| s == model)
    {
        models.push(model.to_owned());
    }
}
pub fn normalize_models(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    for v in values {
        push_model(&mut out, &v);
        if out.len() == MAX_MODELS {
            break;
        }
    }
    out
}
pub fn revision(serialized: &[u8]) -> String {
    format!("{:x}", Sha256::digest(serialized))[..24].to_owned()
}
pub fn target_identity(url: &str, key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(url.as_bytes());
    digest.update([0]);
    digest.update(key.as_bytes());
    format!("{:x}", digest.finalize())
}
pub fn failure_reason(code: &str) -> &str {
    match code {
        "relay_models_timeout" | "remote_response_too_large" | "invalid_remote_catalog" => code,
        _ if code
            .strip_prefix("remote_http_")
            .is_some_and(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit())) =>
        {
            code
        }
        _ => "relay_models_unavailable",
    }
}
