//! Four-character display handles. Salt zero preserves the codes shown before
//! the persistent registry was introduced. The full task ID remains authoritative.
use crate::js::JsString;
use sha2::{Digest, Sha256};

pub const ALPHABET: &[u8; 36] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
pub const CODE_LEN: usize = 4;
pub const MAX_ATTEMPTS: u32 = 4096;

pub fn valid(code: &JsString) -> bool {
    code.len() == CODE_LEN
        && code
            .as_units()
            .iter()
            .all(|&unit| matches!(unit, 48..=57 | 65..=90))
}

pub fn candidate(id: &str, salt: u32) -> String {
    let mut hash = Sha256::new();
    hash.update(id.as_bytes());
    if salt != 0 {
        hash.update(b"#");
        hash.update(salt.to_string().as_bytes());
    }
    let bytes = hash.finalize();
    let mut n = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    let mut code = [0; CODE_LEN];
    for digit in code.iter_mut().rev() {
        *digit = ALPHABET[(n % 36) as usize];
        n /= 36;
    }
    String::from_utf8(code.to_vec()).expect("base36 alphabet is ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn salt_and_wire_encoding_match_existing_handles() {
        assert_eq!(candidate("tsk_abc", 0), "EKJF");
        assert_eq!(candidate("tsk_abc", 1), "DS8Y");
        assert_eq!(candidate("任务✨", 1), "VFIH");
        assert_eq!(
            candidate(&JsString::from_units(vec![0xd800]).to_string_lossy(), 0),
            "UDOS"
        );
    }
}
