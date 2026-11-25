//! Count spellings in message order. One message casts one vote for a word,
//! while every occurrence of each spelling contributes to its preferred form.
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

static WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*").expect("ASCII hotword pattern")
});

pub const TEMPLATE_PREFIX_UNITS: usize = 24;

/// Each call covers one speaker. A third occurrence removes all messages
/// with that prefix, including the first two, without reordering other rows.
pub fn history_template_mask<'a>(messages: impl Iterator<Item = &'a [u16]> + Clone) -> Vec<u8> {
    let prefixes = messages.map(|s| &s[..s.len().min(TEMPLATE_PREFIX_UNITS)]);
    let mut counts = HashMap::new();
    for prefix in prefixes.clone() {
        *counts.entry(prefix).or_insert(0usize) += 1;
    }
    prefixes.map(|p| u8::from(counts[p] < 3)).collect()
}

#[derive(Default)]
struct Word {
    messages: usize,
    last_message: usize,
    sessions: IndexSet<u32>,
    forms: IndexMap<String, usize>,
}

#[derive(Default)]
pub struct Vocabulary {
    messages: usize,
    words: IndexMap<String, Word>,
}

pub struct Term<'a> {
    pub key: &'a str,
    pub spelling: &'a str,
    pub count: usize,
    pub sessions: &'a IndexSet<u32>,
    pub forms: &'a IndexMap<String, usize>,
}

pub struct RankedTerm<'a> {
    pub term: &'a str,
    pub count: usize,
    pub sessions: usize,
    pub source: &'static str,
}

/// User spellings win collisions before sorting. Equal counts keep encounter
/// order within each source, with user words first across the two sources.
pub fn rank_scan_terms<'a>(user: Vec<Term<'a>>, model: Vec<Term<'a>>) -> Vec<RankedTerm<'a>> {
    let user = user
        .into_iter()
        .filter(|t| t.count >= 3 && t.sessions.len() >= 2);
    let model = model.into_iter().filter(|t| {
        let acronym = t
            .spelling
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        t.sessions.len() >= if acronym { 10 } else { 5 }
    });
    let mut seen = IndexSet::new();
    let mut ranked = Vec::new();
    for (t, source) in user
        .map(|t| (t, "user"))
        .chain(model.map(|t| (t, "assistant")))
    {
        if seen.insert(t.key) {
            ranked.push(RankedTerm {
                term: t.spelling,
                count: t.count,
                sessions: t.sessions.len(),
                source,
            });
        }
    }
    ranked.sort_by_key(|t| std::cmp::Reverse(t.count));
    ranked.truncate(80);
    ranked
}

impl Vocabulary {
    pub fn observe(&mut self, session: u32, prose: &str) {
        self.messages += 1;
        for found in WORD.find_iter(prose) {
            let spelling = found.as_str();
            let word = self.words.entry(spelling.to_ascii_lowercase()).or_default();
            *word.forms.entry(spelling.to_owned()).or_default() += 1;
            if word.last_message != self.messages {
                word.last_message = self.messages;
                word.messages += 1;
                word.sessions.insert(session);
            }
        }
    }

    pub fn spellings(&self) -> impl Iterator<Item = &str> {
        self.words
            .values()
            .flat_map(|w| w.forms.keys().map(String::as_str))
    }

    /// JS classifies the distinct spellings in one batch using its public
    /// distinctive() predicate. Each flag follows spellings() insertion order.
    pub fn terms(&self, flags: &[bool]) -> Result<Vec<Term<'_>>, &'static str> {
        let mut flags = flags.iter();
        let mut output = Vec::new();
        for (key, word) in &self.words {
            let mut evidence = 0;
            let mut named_shape = false;
            let mut largest = 0;
            let mut preferred = "";
            let mut preferred_distinctive = false;
            for (spelling, &n) in &word.forms {
                let &distinctive = flags.next().ok_or("missing spelling classification")?;
                if distinctive {
                    evidence += n;
                    named_shape |= !spelling
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
                }
                if n > largest {
                    largest = n;
                    preferred = spelling;
                    preferred_distinctive = distinctive;
                }
            }
            if evidence >= 2 && (named_shape || preferred_distinctive) {
                output.push(Term {
                    key,
                    spelling: preferred,
                    count: word.messages,
                    sessions: &word.sessions,
                    forms: &word.forms,
                });
            }
        }
        if flags.next().is_some() {
            return Err("unexpected spelling classification");
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_count_utf16_prefixes_and_keep_the_original_order() {
        let mut prefix = vec![97; 23];
        prefix.push(0xd83d);
        let rows = [
            [prefix.as_slice(), &[0xde42]].concat(),
            vec![97, 0],
            prefix.clone(),
            vec![97],
            [prefix.as_slice(), &[0xde43]].concat(),
            vec![97, 0],
            vec![97, 0],
        ];
        assert_eq!(
            history_template_mask(rows.iter().map(Vec::as_slice)),
            [0, 0, 0, 1, 0, 0, 0]
        );
    }

    #[test]
    fn repeated_forms_vote_per_occurrence_and_sessions_once_per_message() {
        let mut words = Vocabulary::default();
        words.observe(7, "MultiCC MultiCC PM2");
        words.observe(9, "multicc multicc PM2");
        let forms = words.spellings().collect::<Vec<_>>();
        assert_eq!(forms, ["MultiCC", "multicc", "PM2"]);
        let terms = words.terms(&[true, false, true]).unwrap();
        assert_eq!(terms[0].spelling, "MultiCC");
        assert_eq!(terms[0].count, 2);
        assert_eq!(
            terms[0].sessions.iter().copied().collect::<Vec<_>>(),
            [7, 9]
        );
        assert_eq!(terms[1].spelling, "PM2");
    }
    #[test]
    fn caps_alone_do_not_activate_a_more_frequent_ordinary_spelling() {
        let mut words = Vocabulary::default();
        words.observe(0, "CLI CLI cli cli cli");
        assert!(words.terms(&[true, false]).unwrap().is_empty());
        assert!(words.terms(&[true]).is_err());
        assert!(words.terms(&[true, false, true]).is_err());
    }
}
