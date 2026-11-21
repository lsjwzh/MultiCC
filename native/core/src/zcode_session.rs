//! ZCode native identities and the narrowly scoped legacy bridge sentinels.
use crate::js::JsString;

pub fn is_session_id(value: &JsString) -> bool {
    let Some(suffix) = value.as_units().strip_prefix(&[115, 101, 115, 115, 95]) else {
        return false;
    };
    !suffix.is_empty()
        && suffix
            .iter()
            .all(|unit| matches!(unit, 65..=90 | 97..=122 | 48..=57 | 95 | 45))
}

pub fn is_legacy_bridge_id(value: &JsString) -> bool {
    if [
        "zcode-settings",
        "zcode-err",
        "zcode-no-engine",
        "zcode-parse",
    ]
    .iter()
    .any(|marker| value.as_units().iter().copied().eq(marker.encode_utf16()))
    {
        return true;
    }
    let Some(suffix) = value.as_units().strip_prefix(&[122, 99, 111, 100, 101, 45]) else {
        return false;
    };
    !suffix.is_empty() && suffix.iter().all(|unit| matches!(unit, 48..=57))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_ids_require_a_nonempty_ascii_suffix() {
        for value in ["sess_a", "sess_Z09_-", "sess_0"] {
            assert!(is_session_id(&JsString::from_rust_str(value)));
        }
        for value in [
            "sess_",
            "sess_a\n",
            "sess_a\r\n",
            "sess_a\u{2028}",
            "sess_中",
            "sess_é",
        ] {
            assert!(!is_session_id(&JsString::from_rust_str(value)));
        }
        assert!(!is_session_id(&JsString::from_units(vec![
            115, 101, 115, 115, 95, 0xd800
        ])));
    }

    #[test]
    fn repair_only_recognizes_proven_bridge_labels() {
        for value in [
            "zcode-settings",
            "zcode-err",
            "zcode-no-engine",
            "zcode-parse",
            "zcode-0",
            "zcode-1788653210000",
        ] {
            assert!(is_legacy_bridge_id(&JsString::from_rust_str(value)));
        }
        for value in [
            "zcode-",
            "zcode--1",
            "zcode-1\n",
            "zcode-１２",
            "zcode-future",
            "sess_original",
            "future-native-format",
        ] {
            assert!(!is_legacy_bridge_id(&JsString::from_rust_str(value)));
        }
    }
}
