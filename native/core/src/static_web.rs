//! The path-resolution rules of `serve-static` 1.16.3 + `send` 0.19.2 that the
//! retired `express.static(publicDir, { extensions: ['html'] })` mount ran
//! before it ever touched a file, plus the two documents and the `Location`
//! that mount could produce on its own.
//!
//! The response a resolved file produces is [`crate::http_send`]; this module
//! is only the part that decides *which* file (if any) the request names, and
//! whether `serve-static`'s `fallthrough: true` would have turned the outcome
//! into a plain `next()` instead of a response.
//!
//! Separators: the kernel speaks `/` and treats `\` as a separator only on
//! Windows, the same split `path.normalize`/`path.split(sep)` performs there.
//! The segment list is therefore identical on both platforms, which is all the
//! dotfile rule and the extension retry read.

/// `decodeURIComponent(text)`, or `None` where it throws (a stray `%`, a bad
/// escape, or bytes that are not UTF-8).
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let nibble = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).copied().and_then(nibble)?;
            let low = bytes.get(index + 2).copied().and_then(nibble)?;
            out.push(high << 4 | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `path.isPathSeparator`: `/` everywhere, `\` on win32 as well.
fn is_separator(value: char) -> bool {
    value == '/' || (cfg!(windows) && value == '\\')
}

/// Node's internal `normalizeString(path, allowAboveRoot, '/', isPathSeparator)`
/// (`lib/path.js`), ported statement for statement.
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let chars: Vec<char> = path.chars().collect();
    let mut res = String::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    let mut code = '\0';
    let mut index: isize = 0;
    let length = chars.len() as isize;
    while index <= length {
        if index < length {
            code = chars[index as usize];
        } else if is_separator(code) {
            break;
        } else {
            code = '/';
        }
        if is_separator(code) {
            if last_slash == index - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let tail_is_dots = res.len() >= 2
                    && last_segment_length == 2
                    && res.ends_with("..")
                    && res.chars().rev().nth(1) == Some('.');
                if !tail_is_dots {
                    if res.chars().count() > 2 {
                        match res.rfind('/') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(cut) => {
                                res.truncate(cut);
                                last_segment_length = match res.rfind('/') {
                                    Some(previous) => {
                                        (res[previous + 1..].chars().count()) as isize
                                    }
                                    None => res.chars().count() as isize,
                                };
                            }
                        }
                        last_slash = index;
                        dots = 0;
                        index += 1;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = index;
                        dots = 0;
                        index += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if res.is_empty() {
                        res.push_str("..");
                    } else {
                        res.push_str("/..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let from = (last_slash + 1) as usize;
                let segment: String = chars[from..index as usize].iter().collect();
                if res.is_empty() {
                    res = segment;
                } else {
                    res.push('/');
                    res.push_str(&segment);
                }
                last_segment_length = index - last_slash - 1;
            }
            last_slash = index;
            dots = 0;
        } else if code == '.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        index += 1;
    }
    res
}

/// Node's `path.normalize` for the relative `'.' + sep + path` form `send`
/// builds, with `/` as the output separator.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with(is_separator);
    let trailing_separator = path.ends_with(is_separator);
    let mut normalized = normalize_string(path, !absolute);
    if normalized.is_empty() {
        if absolute {
            return "/".to_string();
        }
        return if trailing_separator { "./" } else { "." }.to_string();
    }
    if trailing_separator {
        normalized.push('/');
    }
    if absolute {
        format!("/{normalized}")
    } else {
        normalized
    }
}

/// `UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/`.
fn climbs_out(path: &str) -> bool {
    let mut start = 0;
    let bytes = path.as_bytes();
    while let Some(found) = path[start..].find("..") {
        let at = start + found;
        let before_ok = at == 0 || bytes[at - 1] == b'/' || bytes[at - 1] == b'\\';
        let after = bytes.get(at + 2);
        let after_ok = matches!(after, None | Some(b'/') | Some(b'\\'));
        if before_ok && after_ok {
            return true;
        }
        start = at + 1;
    }
    false
}

/// What the retired mount would do with a request path, before any `stat`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathPlan {
    /// `send` errored before stat and `serve-static`'s `fallthrough: true`
    /// turned it into a plain `next()`: the front door must not claim the
    /// request, exactly like the retired mount passing it on.
    Fallthrough { status: u16 },
    /// `sendIndex`: the raw path ends with `/`, so the index list is tried
    /// inside this directory (relative to the root, `/`-separated, no trailing
    /// separator; empty means the root itself).
    Index { directory: String },
    /// `sendFile`: this relative path, then the `extensions` retries.
    File { relative: String },
}

/// Strips the `./` (or bare `.`) Node's relative normalize keeps, plus any
/// trailing separator. A leading dot that starts a real segment stays: send
/// serves `/.hidden/bar.txt`, only a dot in the *last* segment is ignored.
fn clean(normalized: &str) -> String {
    let trimmed = if normalized == "." {
        ""
    } else {
        normalized.strip_prefix("./").unwrap_or(normalized)
    };
    trimmed.trim_matches('/').to_string()
}

/// `send`'s `pipe()` with `root` set, up to the `sendIndex`/`sendFile` fork.
///
/// `raw_path` is `parseUrl(req).pathname`, the undecoded pathname the retired
/// `app.use(express.static(...))` mount received.
pub fn path_plan(raw_path: &str) -> PathPlan {
    let Some(decoded) = decode_uri_component(raw_path) else {
        return PathPlan::Fallthrough { status: 400 };
    };
    if decoded.contains('\0') {
        return PathPlan::Fallthrough { status: 400 };
    }
    // `if (path) path = normalize('.' + sep + path)`; an empty path keeps the
    // root itself, which only a mounted static can produce.
    let normalized = if decoded.is_empty() {
        String::new()
    } else {
        normalize(&format!(".{}{decoded}", std::path::MAIN_SEPARATOR))
    };
    if climbs_out(&normalized) {
        return PathPlan::Fallthrough { status: 403 };
    }
    // The legacy dotfile rule (`dotfiles` left undefined, `hidden: false`).
    // Two tests, and both have to hold: `containsDotFile(parts)` needs a
    // segment *longer than one character* starting with `.`, and only then does
    // the last segment decide. So `/a/..` normalizes to `.`, whose single-char
    // segment is not a dotfile at all — it resolves to the root directory and
    // redirects, while `/.env` is the 404 `ignore` branch.
    let parts: Vec<&str> = normalized.split(['/', '\\']).collect();
    let contains_dot_file = parts
        .iter()
        .any(|part| part.chars().count() > 1 && part.starts_with('.'));
    let last = parts.last().copied().unwrap_or("");
    if contains_dot_file && last.starts_with('.') {
        return PathPlan::Fallthrough { status: 404 };
    }
    if raw_path.ends_with('/') {
        return PathPlan::Index {
            directory: clean(&normalized),
        };
    }
    PathPlan::File {
        relative: clean(&normalized),
    }
}

/// `path.extname(path)`: the retried `.html` candidate only exists for a
/// candidate without one.
pub fn has_extension(relative: &str) -> bool {
    let base = relative.rsplit(['/', '\\']).next().unwrap_or("");
    match base.rfind('.') {
        None | Some(0) => false,
        Some(_) => true,
    }
}

/// `escape-html` 1.0.3.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for value in text.chars() {
        match value {
            '"' => out.push_str("&quot;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&#39;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            other => out.push(other),
        }
    }
    out
}

/// `encodeurl` 2.0.0. Rust strings cannot hold an unmatched surrogate, so the
/// package's U+FFFD replacement pass has nothing to do here.
pub fn encode_url(text: &str) -> String {
    fn kept(value: char) -> bool {
        matches!(value,
            '\u{21}'
            | '\u{23}'..='\u{3b}'
            | '\u{3d}'
            | '\u{3f}'..='\u{5f}'
            | '\u{61}'..='\u{7a}'
            | '\u{7c}'
            | '\u{7e}')
    }
    let chars: Vec<char> = text.chars().collect();
    let hex = |byte: u8, out: &mut String| {
        out.push('%');
        out.push_str(&format!("{byte:02X}"));
    };
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let value = chars[index];
        // A valid `%XX` escape is the one kept character the regexp re-checks.
        if value == '%' {
            let valid = matches!(chars.get(index + 1), Some(c) if c.is_ascii_hexdigit())
                && matches!(chars.get(index + 2), Some(c) if c.is_ascii_hexdigit());
            if valid {
                out.push('%');
            } else {
                out.push_str("%25");
            }
            index += 1;
            continue;
        }
        if kept(value) {
            out.push(value);
        } else {
            let mut buffer = [0u8; 4];
            for byte in value.encode_utf8(&mut buffer).as_bytes() {
                hex(*byte, &mut out);
            }
        }
        index += 1;
    }
    out
}

/// `send`'s `createHtmlDocument(title, body)`; `body` is already escaped.
pub fn html_document(title: &str, body: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n</head>\n<body>\n<pre>{body}</pre>\n</body>\n</html>\n"
    )
}

/// `collapseLeadingSlashes`: more than one leading `/` becomes one.
fn collapse_leading_slashes(path: &str) -> String {
    let rest = path.trim_start_matches('/');
    if rest.len() == path.len() {
        path.to_string()
    } else {
        format!("/{rest}")
    }
}

/// `serve-static`'s directory `Location`: `req.originalUrl`'s pathname with a
/// trailing slash, the query/fragment kept verbatim, then `encodeUrl`.
pub fn directory_location(original_url: &str) -> String {
    let cut = original_url
        .find(['?', '#'])
        .unwrap_or(original_url.len());
    let (pathname, rest) = original_url.split_at(cut);
    encode_url(&format!(
        "{}{rest}",
        collapse_leading_slashes(&format!("{pathname}/"))
    ))
}

/// The 301 body both `send` and `serve-static` write for a directory.
pub fn directory_document(location: &str) -> String {
    html_document(
        "Redirecting",
        &format!("Redirecting to {}", escape_html(location)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_follows_node_path_normalize() {
        assert_eq!(normalize("./a/b"), "a/b");
        assert_eq!(normalize(".//"), "./");
        assert_eq!(normalize("./a/../b"), "b");
        assert_eq!(normalize("./a/b/../.."), ".");
        assert_eq!(normalize("./a/../../b"), "../b");
        assert_eq!(normalize("./a//b/"), "a/b/");
        assert_eq!(normalize("./a/./b"), "a/b");
        assert_eq!(normalize(""), ".");
        assert_eq!(normalize("/a/../../b"), "/b");
    }

    #[test]
    fn up_path_matches_the_send_regexp() {
        assert!(climbs_out(".."));
        assert!(climbs_out("../a"));
        assert!(climbs_out("a/../b"));
        assert!(climbs_out("a/.."));
        assert!(!climbs_out("..a"));
        assert!(!climbs_out("a..b"));
        assert!(!climbs_out("a/..b"));
        assert!(!climbs_out("a/b"));
    }

    #[test]
    fn path_plan_follows_the_pipe_order() {
        assert_eq!(
            path_plan("/air.css"),
            PathPlan::File {
                relative: "air.css".to_string()
            }
        );
        assert_eq!(
            path_plan("/"),
            PathPlan::Index {
                directory: String::new()
            }
        );
        assert_eq!(
            path_plan("/docs/"),
            PathPlan::Index {
                directory: "docs".to_string()
            }
        );
        assert_eq!(
            path_plan("/docs/a%20b.html"),
            PathPlan::File {
                relative: "docs/a b.html".to_string()
            }
        );
        // A bad escape and a null byte are both 400 before any stat.
        assert_eq!(path_plan("/%"), PathPlan::Fallthrough { status: 400 });
        assert_eq!(path_plan("/a%ZZ"), PathPlan::Fallthrough { status: 400 });
        assert_eq!(path_plan("/a%00b"), PathPlan::Fallthrough { status: 400 });
        // `..` escapes are 403, and the normalized form is what decides.
        assert_eq!(path_plan("/../etc"), PathPlan::Fallthrough { status: 403 });
        assert_eq!(path_plan("/a/../../etc"), PathPlan::Fallthrough { status: 403 });
        assert_eq!(path_plan("/%2e%2e/etc"), PathPlan::Fallthrough { status: 403 });
        // `/a/b/../..` normalizes to `.`, whose last segment is a dot: 404.
        // A dot in the last segment is ignored; an intermediate one is served.
        assert_eq!(path_plan("/.env"), PathPlan::Fallthrough { status: 404 });
        assert_eq!(
            path_plan("/.hidden/bar.txt"),
            PathPlan::File {
                relative: ".hidden/bar.txt".to_string()
            }
        );
        assert_eq!(path_plan("/pub/.secret"), PathPlan::Fallthrough { status: 404 });
        // Measured against the real packages: `/a/..` and `/.` normalize to `.`,
        // a single-character segment that `containsDotFile` does not count, so
        // they resolve to the root directory (which redirects) instead of
        // taking the dotfile 404. `/..` still keeps a `..` for UP_PATH.
        assert_eq!(
            path_plan("/a/.."),
            PathPlan::File {
                relative: String::new()
            }
        );
        assert_eq!(
            path_plan("/."),
            PathPlan::File {
                relative: String::new()
            }
        );
        assert_eq!(
            path_plan("/a/b/../.."),
            PathPlan::File {
                relative: String::new()
            }
        );
        assert_eq!(path_plan("/.."), PathPlan::Fallthrough { status: 403 });
        // A directory whose own name is a dotfile is the 404, not a redirect.
        assert_eq!(path_plan("/.hidden"), PathPlan::Fallthrough { status: 404 });
        // `/a/b/..` resolves back to the `a` directory, which redirects.
        assert_eq!(
            path_plan("/a/b/.."),
            PathPlan::File {
                relative: "a".to_string()
            }
        );
    }

    #[test]
    fn extension_retry_only_without_an_extension() {
        assert!(!has_extension("manage"));
        assert!(has_extension("air.css"));
        assert!(!has_extension("dir/.env"));
        assert!(has_extension("dir/a.b.c"));
        assert!(!has_extension("a.b/c"));
    }

    #[test]
    fn encode_url_keeps_escapes_and_encodes_the_rest() {
        assert_eq!(encode_url("/a/b?x=1&y=2"), "/a/b?x=1&y=2");
        assert_eq!(encode_url("/a b"), "/a%20b");
        assert_eq!(encode_url("/a%20b"), "/a%20b");
        assert_eq!(encode_url("/100%"), "/100%25");
        assert_eq!(encode_url("/a%zz"), "/a%25zz");
        assert_eq!(encode_url("/\"<>`{}"), "/%22%3C%3E%60%7B%7D");
        assert_eq!(encode_url("/中"), "/%E4%B8%AD");
    }

    #[test]
    fn directory_location_keeps_the_query_and_collapses_slashes() {
        assert_eq!(directory_location("/docs"), "/docs/");
        assert_eq!(directory_location("/docs?x=1&y=2"), "/docs/?x=1&y=2");
        assert_eq!(directory_location("//docs"), "/docs/");
        assert_eq!(directory_location("/a b"), "/a%20b/");
        assert_eq!(directory_location("/docs#top"), "/docs/#top");
    }

    #[test]
    fn the_two_documents_are_byte_exact() {
        assert_eq!(
            directory_document("/docs/"),
            "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to /docs/</pre>\n</body>\n</html>\n"
        );
        assert_eq!(escape_html("a&<>\"'b"), "a&amp;&lt;&gt;&quot;&#39;b");
    }
}
