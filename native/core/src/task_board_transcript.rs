//! Pure helpers for the task-board transcript projections. The live event and
//! history reads stay with the host adapter; this module owns the hash, the
//! comparator policy and the string arithmetic that must match V8 byte for
//! byte.
use crate::js::string::JsString;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

/// `tsk-` + first 32 hex chars of sha256(`${source}\0${requestKey}`), with the
/// source pair encoded exactly the way Node's `crypto.update(text, 'utf8')`
/// encodes it: well-formed text as UTF-8, lone surrogates replaced by U+FFFD.
pub fn stable_task_id(source: &JsString, request_key: &JsString) -> JsString {
    let mut hasher = Sha256::new();
    hasher.update(source.utf8_lossy_bytes());
    hasher.update([0_u8]);
    hasher.update(request_key.utf8_lossy_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex.truncate(32);
    JsString::from_rust_str(&format!("tsk-{hex}"))
}

/// V8's Array#sort maps a NaN comparator result to +0, so a pair whose key
/// difference is NaN keeps its relative order. Rust's stable sort plus this
/// comparator is that behavior.
pub fn compare_number_keys(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

/// The `(value || 0)` key used by the transcript projections: falsy becomes
/// zero, everything else is coerced with JS number semantics.
pub fn number_or_zero(truthy: bool, number: f64) -> f64 {
    if truthy {
        number
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::{compare_number_keys, number_or_zero, stable_task_id};
    use crate::js::string::JsString;
    use std::cmp::Ordering;

    #[test]
    fn stable_task_id_matches_node_crypto_vectors() {
        // Precomputed with Node: crypto.createHash('sha256')
        //   .update(`${source}\0${requestKey}`, 'utf8').digest('hex').slice(0, 32).
        let id = stable_task_id(
            &JsString::from_rust_str("board-send:dir-1"),
            &JsString::from_rust_str("client-7"),
        );
        assert_eq!(id.to_string_lossy(), "tsk-c0f07d4d4b9f10225f2c1edc608a681a");
        let empty = stable_task_id(&JsString::new(), &JsString::new());
        assert_eq!(
            empty.to_string_lossy(),
            "tsk-6e340b9cffb37a989ca544e6bb780a2c"
        );
    }

    #[test]
    fn nan_key_difference_keeps_relative_order() {
        assert_eq!(compare_number_keys(f64::NAN, 1.0), Ordering::Equal);
        assert_eq!(compare_number_keys(1.0, f64::NAN), Ordering::Equal);
        assert_eq!(compare_number_keys(1.0, 2.0), Ordering::Less);
        assert_eq!(compare_number_keys(2.0, 1.0), Ordering::Greater);
        assert_eq!(number_or_zero(false, f64::NAN), 0.0);
        assert_eq!(number_or_zero(true, 12.5), 12.5);
    }
}
