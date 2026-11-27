//! UTF-16 offsets are shared with pinyin-pro (one syllable per CJK unit).
use crate::js::JsString as S;
use std::collections::HashMap;
fn separator(c: u16) -> bool {
    matches!(c, 10 | 13 | 44 | 0xff0c | 59 | 0xff1b | 0x3001)
}
pub fn entries(raw: &S) -> Vec<(S, Vec<S>)> {
    let mut positions: HashMap<S, usize> = HashMap::new();
    let mut out: Vec<(S, Vec<S>)> = vec![];
    for item in raw.as_units().split(|&v| separator(v)) {
        let mut sides = item.splitn(2, |&v| v == 61);
        let term = S::from_units(sides.next().unwrap_or_default().to_vec()).trim();
        if term.is_empty() || term.len() > 40 {
            continue;
        }
        let i = *positions.entry(term.to_lowercase()).or_insert_with(|| {
            out.push((term.clone(), vec![]));
            out.len() - 1
        });
        if let Some(rest) = sides.next() {
            for word in rest.split(|&c| c == 47 || c == 124) {
                let alias = S::from_units(word.to_vec()).trim();
                if !alias.is_empty()
                    && alias.len() <= 40
                    && alias != term
                    && !out[i].1.contains(&alias)
                {
                    out[i].1.push(alias)
                }
            }
        }
        if positions.len() >= 200 {
            break;
        }
    }
    out
}
pub fn stripped(raw: &S) -> S {
    let mut out = S::new();
    let mut alias = false;
    for &c in raw.as_units() {
        if separator(c) {
            alias = false
        } else if c == 61 {
            alias = true
        }
        if !alias {
            out.push_unit(c)
        }
    }
    out
}
fn syllable(s: &[u16]) -> (&str, &[u16]) {
    for i in [
        "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x",
        "r", "z", "c", "s",
    ] {
        if s.len() > i.len() && s.iter().zip(i.bytes()).all(|(&u, b)| u == b as u16) {
            return (i, &s[i.len()..]);
        }
    }
    ("", s)
}
pub fn near(a: &S, b: &S) -> bool {
    let (i, a) = syllable(a.as_units());
    let (j, b) = syllable(b.as_units());
    if i != j
        && ![
            ("z", "zh"),
            ("c", "ch"),
            ("s", "sh"),
            ("n", "l"),
            ("f", "h"),
            ("l", "r"),
        ]
        .iter()
        .any(|&(x, y)| (i == x && j == y) || (j == x && i == y))
    {
        return false;
    }
    let (a, b) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    a == b
        || (b.strip_suffix(&[103]) == Some(a)
            && [[97, 110], [101, 110], [105, 110]]
                .iter()
                .any(|end| a.ends_with(end)))
}
pub fn spans(terms: &[Vec<S>], words: &[S]) -> Vec<(usize, usize, usize)> {
    let mut hits = vec![];
    for (n, term) in terms.iter().enumerate() {
        let len = term.len();
        if len == 0 || len > words.len() {
            continue;
        }
        let budget = if len >= 6 {
            2
        } else if len >= 3 {
            1
        } else {
            0
        };
        for (start, slice) in words.windows(len).enumerate() {
            let mut cost = 0;
            for (a, b) in term.iter().zip(slice) {
                if a != b {
                    cost += 1;
                    if cost > budget || !near(a, b) {
                        cost = budget + 1;
                        break;
                    }
                }
            }
            if cost <= budget {
                hits.push((n, start, len, cost));
            }
        }
    }
    hits.sort_by_key(|&(_, start, len, cost)| (std::cmp::Reverse(len), cost, start));
    let mut out = vec![];
    for (n, start, len, _) in hits {
        if !out.iter().any(|&(_, s, e)| start < e && s < start + len) {
            out.push((n, start, start + len));
        }
    }
    out.sort_by_key(|&(_, s, _)| s);
    out
}
