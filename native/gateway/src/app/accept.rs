//! `req.accepts(types)` for full media types (the `negotiator` package's
//! `mediaTypes`): q-values, specificity, then Accept order, then the order of
//! `types`. No Accept header accepts everything (the first type wins).

struct Accepted {
    kind: String,
    subtype: String,
    params: Vec<(String, String)>,
    q: f64,
    index: usize,
}

fn split_outside_quotes(text: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut quoted) = (0, false);
    for (index, ch) in text.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        } else if ch == separator && !quoted {
            parts.push(&text[start..index]);
            start = index + 1;
        }
    }
    parts.push(&text[start..]);
    parts
}

fn parse(accept: &str) -> Vec<Accepted> {
    let mut out = Vec::new();
    for (index, entry) in split_outside_quotes(accept, ',').into_iter().enumerate() {
        let mut pieces = split_outside_quotes(entry, ';').into_iter();
        let full = pieces.next().unwrap_or("").trim();
        let Some((kind, subtype)) = full.split_once('/') else {
            continue;
        };
        if kind.is_empty() || subtype.is_empty() || full.contains(char::is_whitespace) {
            continue;
        }
        let mut q = 1.0;
        let mut params = Vec::new();
        for param in pieces {
            let Some((name, value)) = param.split_once('=') else {
                continue;
            };
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().trim_matches('"').to_string();
            if name == "q" {
                q = value.parse().unwrap_or(0.0);
                break;
            }
            params.push((name, value));
        }
        out.push(Accepted {
            kind: kind.to_string(),
            subtype: subtype.to_string(),
            params,
            q,
            index,
        });
    }
    out
}

/// `(q, specificity, accept index)` of the best Accept entry for `media`.
fn priority(media: &str, accepted: &[Accepted]) -> Option<(f64, u8, usize)> {
    let (kind, subtype) = media.split_once('/')?;
    let mut best: Option<(f64, u8, usize)> = None;
    for entry in accepted {
        let mut specificity = 0u8;
        if entry.kind.eq_ignore_ascii_case(kind) {
            specificity |= 4;
        } else if entry.kind != "*" {
            continue;
        }
        if entry.subtype.eq_ignore_ascii_case(subtype) {
            specificity |= 2;
        } else if entry.subtype != "*" {
            continue;
        }
        if !entry.params.is_empty() {
            if entry.params.iter().all(|(_, value)| value == "*") {
                specificity |= 1;
            } else {
                continue;
            }
        }
        // negotiator: replace while (s, q, o) of the old pick is lower.
        let better = best.is_none_or(|(q, s, o)| (s, q, o) < (specificity, entry.q, entry.index));
        if better {
            best = Some((entry.q, specificity, entry.index));
        }
    }
    best
}

/// Index into `types` of the preferred one, or `None` when nothing is
/// acceptable (`res.format` then runs its `default`).
pub fn prefer(accept: Option<&str>, types: &[&str]) -> Option<usize> {
    let Some(accept) = accept else {
        return (!types.is_empty()).then_some(0);
    };
    let accepted = parse(accept);
    let mut ranked: Vec<(usize, (f64, u8, usize))> = types
        .iter()
        .enumerate()
        .filter_map(|(index, media)| priority(media, &accepted).map(|p| (index, p)))
        .filter(|(_, (q, _, _))| *q > 0.0)
        .collect();
    ranked.sort_by(|(ia, (qa, sa, oa)), (ib, (qb, sb, ob))| {
        qb.partial_cmp(qa)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(sb.cmp(sa))
            .then(oa.cmp(ob))
            .then(ia.cmp(ib))
    });
    ranked.first().map(|(index, _)| *index)
}

#[cfg(test)]
mod tests {
    use super::prefer;

    const TYPES: &[&str] = &["text/plain", "text/html"];

    #[test]
    fn browsers_get_html_and_bare_clients_get_text() {
        let browser = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
        assert_eq!(prefer(Some(browser), TYPES), Some(1));
        assert_eq!(prefer(None, TYPES), Some(0));
        assert_eq!(prefer(Some("*/*"), TYPES), Some(0));
        assert_eq!(prefer(Some("text/*, text/html"), TYPES), Some(1));
        assert_eq!(prefer(Some("application/json"), TYPES), None);
        assert_eq!(prefer(Some("text/html;q=0"), TYPES), None);
        assert_eq!(
            prefer(Some("text/html;q=0.5, text/plain;q=0.4"), TYPES),
            Some(1)
        );
    }
}
