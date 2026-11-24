//! Align two bounded ASR transcripts in UTF-16 code units. An LCS tie consumes
//! an edited token first, matching the learner's original edit boundaries.
use crate::js::{string::is_js_whitespace, JsString};
use std::ops::Range;

const MAX_INPUT: usize = 600;
const MAX_SIDE: usize = 16;

pub struct Correction {
    pub term: JsString,
    pub alias: Option<JsString>,
}

#[derive(Clone)]
struct Token<'a> {
    start: usize,
    value: &'a [u16],
}

fn ascii_word(unit: u16) -> bool {
    unit <= 127 && (unit as u8).is_ascii_alphanumeric()
}

fn cjk(unit: u16) -> bool {
    (0x4e00..=0x9fff).contains(&unit)
}

fn tokens(text: &[u16]) -> Vec<Token<'_>> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let start = i;
        let first = text[i];
        i += 1;
        if is_js_whitespace(first) {
            continue;
        }
        if ascii_word(first) {
            while i < text.len()
                && (ascii_word(text[i])
                    || u8::try_from(text[i]).is_ok_and(|c| matches!(c, b'-' | b'.' | b'+' | b'_')))
            {
                i += 1;
            }
        }
        out.push(Token {
            start,
            value: &text[start..i],
        });
    }
    out
}

struct Edit {
    raw: Range<usize>,
    edited: Range<usize>,
}

fn align(a: &[Token<'_>], b: &[Token<'_>]) -> (Vec<Edit>, bool) {
    let stride = b.len() + 1;
    let mut lengths = vec![0u16; (a.len() + 1) * stride];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            let cell = i * stride + j;
            lengths[cell] = if a[i].value == b[j].value {
                lengths[cell + stride + 1] + 1
            } else {
                lengths[cell + stride].max(lengths[cell + 1])
            };
        }
    }
    let heavy_rewrite = usize::from(lengths[0]) * 5 < a.len().max(b.len()) * 3;
    let mut edits = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i].value == b[j].value {
            i += 1;
            j += 1;
            continue;
        }
        let (start_i, start_j) = (i, j);
        while (i < a.len() || j < b.len())
            && !(i < a.len() && j < b.len() && a[i].value == b[j].value)
        {
            let cell = i * stride + j;
            if j < b.len() && (i == a.len() || lengths[cell + 1] >= lengths[cell + stride]) {
                j += 1;
            } else {
                i += 1;
            }
        }
        edits.push(Edit {
            raw: start_i..i,
            edited: start_j..j,
        });
    }
    (edits, heavy_rewrite)
}

fn is_word(token: &Token<'_>) -> bool {
    ascii_word(token.value[0]) || cjk(token.value[0])
}

// Borrow matching CJK neighbours so a one-character edit names a word.
fn widen(edit: &mut Edit, raw: &[Token<'_>], edited: &[Token<'_>]) {
    if edited[edit.edited.clone()]
        .iter()
        .filter(|t| cjk(t.value[0]))
        .count()
        != 1
    {
        return;
    }
    let (a, b) = (edit.raw.start, edit.edited.start);
    if a > 0 && b > 0 && cjk(raw[a - 1].value[0]) && raw[a - 1].value == edited[b - 1].value {
        edit.raw.start -= 1;
        edit.edited.start -= 1;
        return;
    }
    let (a, b) = (edit.raw.end, edit.edited.end);
    if a < raw.len() && b < edited.len() && cjk(raw[a].value[0]) && raw[a].value == edited[b].value
    {
        edit.raw.end += 1;
        edit.edited.end += 1;
    }
}

fn span(source: &[u16], tokens: &[Token<'_>]) -> JsString {
    // The caller has checked that both sides contain a word. Punctuation and
    // original spacing between the endpoints remain part of the spelling.
    let first = tokens.iter().find(|t| is_word(t)).unwrap();
    let last = tokens.iter().rfind(|t| is_word(t)).unwrap();
    JsString::from_units(source[first.start..last.start + last.value.len()].to_vec())
}

fn valid_term(term: &[u16]) -> bool {
    if term.len() > MAX_SIDE
        || term.iter().any(|&unit| {
            char::from_u32(u32::from(unit)).is_some_and(|c| {
                matches!(
                    c,
                    '\n' | '\r' | ',' | '，' | ';' | '；' | '、' | '=' | '/' | '|'
                )
            })
        })
    {
        return false;
    }
    if term.iter().all(|&u| cjk(u)) {
        return (2..=8).contains(&term.len());
    }
    !term.iter().any(|&u| cjk(u))
        && term
            .iter()
            .any(|&u| u <= 127 && (u as u8).is_ascii_alphabetic())
        && term.iter().filter(|&&u| ascii_word(u)).count() >= 3
}

pub fn mine_pairs<E>(
    raw: &JsString,
    edited: &JsString,
    mut same_spelling: impl FnMut(&JsString, &JsString) -> Result<bool, E>,
    mut sound_alike: impl FnMut(&JsString, &JsString) -> Result<bool, E>,
) -> Result<Vec<Correction>, E> {
    let mut pairs = Vec::new();
    if raw.is_empty()
        || edited.is_empty()
        || raw == edited
        || raw.len().max(edited.len()) > MAX_INPUT
    {
        return Ok(pairs);
    }
    let (a, b) = (tokens(raw.as_units()), tokens(edited.as_units()));
    let (edits, heavy_rewrite) = align(&a, &b);
    for mut edit in edits {
        if !a[edit.raw.clone()].iter().any(is_word) || !b[edit.edited.clone()].iter().any(is_word) {
            continue;
        }
        widen(&mut edit, &a, &b);
        let term = span(edited.as_units(), &b[edit.edited]);
        let alias = span(raw.as_units(), &a[edit.raw]);
        if !valid_term(term.as_units()) || alias.len() > MAX_SIDE {
            continue;
        }
        let chinese = term.as_units().iter().all(|&u| cjk(u));
        if chinese && heavy_rewrite {
            continue;
        }
        if same_spelling(&alias, &term)? {
            if !chinese {
                pairs.push(Correction { term, alias: None });
            }
            continue;
        }
        if alias.len() > term.len() * 3 + 4 {
            continue;
        }
        if chinese && alias.as_units().iter().all(|&u| cjk(u)) && !sound_alike(&term, &alias)? {
            continue;
        }
        pairs.push(Correction {
            term,
            alias: Some(alias),
        });
    }
    Ok(pairs)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_boundaries_follow_utf16_and_ecmascript_spaces() {
        let input = [
            0xfeff, 65, 45, 46, 43, 95, 50, 0x4e00, 0xd83d, 0xde00, 0x0085,
        ];
        assert_eq!(
            tokens(&input)
                .iter()
                .map(|t| (t.start, t.value.len()))
                .collect::<Vec<_>>(),
            [(1, 6), (7, 1), (8, 1), (9, 1), (10, 1)]
        );
    }

    #[test]
    fn alignment_prefers_insertion_when_the_suffix_lengths_tie() {
        let a = JsString::from_rust_str("甲乙");
        let b = JsString::from_rust_str("乙甲");
        let (edits, heavy) = align(&tokens(a.as_units()), &tokens(b.as_units()));
        assert!(heavy);
        assert_eq!(edits.len(), 2);
        assert_eq!((&edits[0].raw, &edits[0].edited), (&(0..0), &(0..1)));
        assert_eq!((&edits[1].raw, &edits[1].edited), (&(1..2), &(2..2)));
    }
}
