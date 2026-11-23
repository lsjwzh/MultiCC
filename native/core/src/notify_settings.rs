//! Notification destination display and unchanged-placeholder comparison.
use url::Url;

pub struct SecretUrl {
    pub configured: bool,
    pub origin: String,
    pub masked: String,
}

/// Only the origin of a notification destination is safe to display: the path,
/// query and userinfo can carry a device key or webhook token.
pub fn summarize_secret_url(value: Option<&str>) -> SecretUrl {
    let raw = match value {
        Some(text) if !text.is_empty() => text,
        _ => {
            return SecretUrl {
                configured: false,
                origin: String::new(),
                masked: String::new(),
            }
        }
    };
    let origin = Url::parse(raw)
        .ok()
        .filter(|url| url.scheme() == "http" || url.scheme() == "https")
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    SecretUrl {
        masked: if origin.is_empty() {
            "\u{2022}\u{2022}\u{2022}\u{2022}".to_string()
        } else {
            format!("{origin}/\u{2022}\u{2022}\u{2022}\u{2022}")
        },
        configured: true,
        origin,
    }
}

/// The read route and the write transaction must recognize the same placeholder.
pub fn is_current_placeholder(submitted: &str, current: Option<&str>, configured: bool) -> bool {
    configured && submitted == summarize_secret_url(current).masked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_urls_keep_only_the_origin() {
        let full = summarize_secret_url(Some("https://h.example:8443/a/b?token=1"));
        assert!(full.configured);
        assert_eq!(full.origin, "https://h.example:8443");
        assert_eq!(
            full.masked,
            "https://h.example:8443/\u{2022}\u{2022}\u{2022}\u{2022}"
        );
        let default_port = summarize_secret_url(Some("http://H.Example:80/x"));
        assert_eq!(default_port.origin, "http://h.example");
        let userinfo = summarize_secret_url(Some("https://user:secret@h.example/x"));
        assert_eq!(userinfo.origin, "https://h.example");
        let relative = summarize_secret_url(Some("/not-a-url"));
        assert!(relative.configured);
        assert_eq!(relative.origin, "");
        assert_eq!(relative.masked, "\u{2022}\u{2022}\u{2022}\u{2022}");
        let empty = summarize_secret_url(Some(""));
        assert!(!empty.configured);
        assert_eq!(empty.masked, "");
        assert!(!summarize_secret_url(None).configured);
    }
}
