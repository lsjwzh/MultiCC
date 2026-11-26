use regex::Regex;
use std::sync::LazyLock;

/// arkcli may append human-readable upgrade notices to either stream.
pub fn object_range(source: &[u16]) -> Option<std::ops::Range<usize>> {
    let start = source.iter().position(|c| *c == 123)?;
    let (mut depth, mut quoted, mut escaped) = (0, false, false);
    for (i, &c) in source.iter().enumerate().skip(start) {
        if quoted {
            if escaped {
                escaped = false
            } else if c == 92 {
                escaped = true
            } else if c == 34 {
                quoted = false
            }
        } else {
            match c {
                34 => quoted = true,
                123 => depth += 1,
                125 => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(start..i + 1);
                    }
                }
                _ => {}
            }
        }
    }
    None
}
pub fn needs_auth(message: &str) -> bool {
    static AUTH: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i-u:not configured|auth login|volc-sso|\bsso\b|refresh_token|\.arkcli|logged_in|unauthoriz|credential)").unwrap()
    });
    AUTH.is_match(message)
}
