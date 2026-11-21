//! Bundled ZCode engine defaults and its classic JavaScript entrypoint gate.
use crate::js::JsString;

pub const DEFAULT_ENGINE: &str = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

pub fn is_script_path(value: &JsString) -> bool {
    let text = value.to_string_lossy().to_ascii_lowercase();
    text.ends_with(".js") || text.ends_with(".cjs")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_classic_js_entrypoints_are_considered() {
        for value in ["/app/zcode.cjs", "relative/engine.js", "engine.CJS", ".Js"] {
            assert!(is_script_path(&JsString::from_rust_str(value)));
        }
        for value in [
            "",
            "zcode",
            "engine.mjs",
            "engine.js\n",
            "engine.js\0",
            "engine.jſ",
        ] {
            assert!(!is_script_path(&JsString::from_rust_str(value)));
        }
    }

    #[test]
    fn utf16_prefixes_do_not_change_the_ascii_suffix_gate() {
        assert!(is_script_path(&JsString::from_units(vec![
            0xd800, 46, 99, 106, 115
        ])));
        assert!(!is_script_path(&JsString::from_units(vec![
            46, 99, 106, 115, 0xd800
        ])));
    }
}
