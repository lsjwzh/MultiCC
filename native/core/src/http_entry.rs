//! Public-path and provider-relay classification for the shared HTTP entry.
//! These are access-token exceptions, not authorization of the downstream
//! resource: share, artifact and callback handlers still validate their grants.
use crate::js::{
    regex::{ascii_ci, from_unit_view, to_unit_view, SPACE},
    JsString,
};
use regex::Regex;
use std::sync::OnceLock;

// JS non-multiline `$` is the absolute end. Rust's `$` has the same meaning
// without multi-line mode; explicit ASCII case folding avoids Unicode aliases.
fn pattern(slot: &'static OnceLock<Regex>, source: impl FnOnce() -> String) -> &'static Regex {
    slot.get_or_init(|| Regex::new(&source()).expect("static HTTP entry pattern"))
}

pub fn public_path(method: &str, path: &JsString) -> bool {
    if [
        "/login",
        "/logout",
        "/healthz",
        "/readyz",
        "/ios-ota/manifest.plist",
    ]
    .iter()
    .any(|candidate| path == *candidate)
    {
        return true;
    }
    let view = to_unit_view(path);
    static STATIC: OnceLock<Regex> = OnceLock::new();
    if !view.starts_with("/api/")
        && pattern(&STATIC, || {
            format!(
                r"\.({})$",
                [
                    "js", "css", "png", "jpg", "jpeg", "gif", "svg", "ico", "woff", "woff2", "ttf",
                    "json", "apk", "ipa"
                ]
                .map(ascii_ci)
                .join("|")
            )
        })
        .is_match(&view)
    {
        return true;
    }
    static SHARES: OnceLock<Regex> = OnceLock::new();
    if pattern(&SHARES, || r"^(?:/share/[^/]+|/api/share/[^/]+/(?:auth|session|entry|history)|/fleet-share/fleet_share_[A-Za-z0-9_-]+)$".into()).is_match(&view) { return true; }
    static ARTIFACTS: OnceLock<Regex> = OnceLock::new();
    if pattern(&ARTIFACTS, || r"^/artifacts/[A-Za-z0-9_-]+(?:/|$)".into()).is_match(&view) {
        return true;
    }
    if method == "POST" {
        static POST: OnceLock<Regex> = OnceLock::new();
        if pattern(&POST, || r"^(?:/api/wait/[^/]+/resolve|/api/fleet-shares/fleet_share_[A-Za-z0-9_-]+/(?:import|ws-ticket))$".into()).is_match(&view) { return true; }
    }
    if method == "GET" {
        static RESULT: OnceLock<Regex> = OnceLock::new();
        if pattern(&RESULT, || r"^/ios-ota/udid/result/[a-f0-9]{64}$".into()).is_match(&view) {
            return true;
        }
    }
    false
}

pub fn udid_callback_path(method: &str, path: &JsString) -> bool {
    static PATH: OnceLock<Regex> = OnceLock::new();
    method == "POST"
        && pattern(&PATH, || r"^/ios-ota/udid/callback/[a-f0-9]{64}$".into())
            .is_match(&to_unit_view(path))
}
pub fn udid_content_type(content: &JsString) -> bool {
    static TYPE: OnceLock<Regex> = OnceLock::new();
    pattern(&TYPE, || {
        format!(
            r"^(?:{}|{})(?:;|$)",
            ascii_ci("application/pkcs7-signature"),
            ascii_ci("application/x-apple-aspen-deviceinfo")
        )
    })
    .is_match(&to_unit_view(content))
}
pub fn relay_path(path: &JsString) -> bool {
    let path = to_unit_view(path);
    ["/claude-proxy", "/codex-proxy"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}
pub fn bearer(text: &JsString) -> Option<JsString> {
    static BEARER: OnceLock<Regex> = OnceLock::new();
    // JS dot excludes every LineTerminator, not only LF.
    pattern(&BEARER, || {
        format!(
            r"^{}[{SPACE}]+([^\n\r\x{{2028}}\x{{2029}}]+)$",
            ascii_ci("Bearer")
        )
    })
    .captures(&to_unit_view(text))
    .map(|captures| from_unit_view(&captures[1]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exceptions_do_not_open_adjacent_resources() {
        for path in [
            "/api/x.js",
            "/x.jſ",
            "/x.js\n",
            "/share/id/extra",
            "/artifacts/id%2Fbad",
            "/api/share/id/delete",
            "/api/wait/id/resolve/extra",
        ] {
            assert!(!public_path("GET", &path.into()), "{path}");
        }
        assert!(public_path("GET", &"/x.JS".into()));
        assert!(public_path("POST", &"/api/wait/id/resolve".into()));
        assert!(!public_path("GET", &"/api/wait/id/resolve".into()));
        assert!(!relay_path(&"/codex-proxy-fake".into()));
        assert!(relay_path(&"/codex-proxy/v1".into()));
    }

    #[test]
    fn udid_requires_exact_capability_path_and_media_type() {
        let path: JsString = format!("/ios-ota/udid/callback/{}", "a".repeat(64)).into();
        assert!(udid_callback_path("POST", &path));
        assert!(!udid_callback_path("GET", &path));
        assert!(udid_content_type(
            &"APPLICATION/PKCS7-SIGNATURE; x=1".into()
        ));
        assert!(!udid_content_type(
            &"application/pkcs7-signature-other".into()
        ));
        assert!(!udid_content_type(&"application/pkcs7-signature\n".into()));
    }

    #[test]
    fn bearer_matches_javascript_whitespace_without_unicode_case_aliases() {
        assert_eq!(bearer(&"bEaReR\u{feff}token".into()), Some("token".into()));
        for ending in ["\n", "\r", "\u{2028}", "\u{2029}"] {
            assert!(bearer(&format!("Bearer token{ending}").into()).is_none());
        }
        assert!(bearer(&"Bearer".into()).is_none());
        assert!(bearer(&"Bearer\u{200b}token".into()).is_none());
    }
}
