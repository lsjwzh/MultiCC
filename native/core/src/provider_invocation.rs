//! Physical child identity, shared by resident Provider execution owners.
use crate::js::JsString;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

pub fn spawn_key(serialized_contract: &JsString) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(serialized_contract.utf8_lossy_bytes()))
}
