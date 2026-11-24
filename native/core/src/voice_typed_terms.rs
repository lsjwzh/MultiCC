//! Count spellings in message order. One message casts one vote for a word,
//! while every occurrence of each spelling contributes to its preferred form.
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use std::sync::LazyLock;

static WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*").expect("ASCII hotword pattern")
});

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
