//! 任务板 BM25 和消息全文索引共用的分词规则。输入已经过 NFKC 和小写转换。
use indexmap::{IndexMap, IndexSet};

pub const MAX_PHRASE_BIGRAMS: usize = 3;
pub const MAX_MATCH_TERMS: usize = 24;
const MAX_TERMS_PER_FIELD: usize = 8000;
const MAX_TF: f64 = 32.0;

fn cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x3040..=0x30ff | 0xac00..=0xd7af)
}

fn latin_runs(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || "+._-".contains(c)))
        .map(|run| run.trim_start_matches(['+', '.', '_', '-']))
        .filter(|run| run.len() >= 2)
}

fn cjk_runs(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c| !cjk(c)).filter(|run| !run.is_empty())
}

fn bigrams(run: &str) -> impl Iterator<Item = &str> {
    run.char_indices()
        .zip(run.chars().skip(1))
        .map(|((at, left), right)| &run[at..at + left.len_utf8() + right.len_utf8()])
}

pub fn weighted_terms(text: &str) -> IndexMap<&str, f64> {
    // 索引已满时仍给已有词计数。并列词的排名沿用首次出现的顺序。
    let mut terms = IndexMap::new();
    let mut add = |term, weight| {
        if let Some(count) = terms.get_mut(term) {
            *count = f64::min(*count + weight, MAX_TF);
        } else if terms.len() < MAX_TERMS_PER_FIELD {
            terms.insert(term, weight);
        }
    };
    for term in latin_runs(text) {
        add(term, 1.0);
    }
    for run in cjk_runs(text) {
        for term in bigrams(run) {
            add(term, 1.0);
        }
        for (at, letter) in run.char_indices() {
            add(&run[at..at + letter.len_utf8()], 0.5);
        }
    }
    terms
}

pub fn index_tokens(text: &str) -> Vec<&str> {
    latin_runs(text)
        .chain(cjk_runs(text).flat_map(bigrams))
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect()
}

pub fn match_groups(text: &str) -> Vec<Vec<&str>> {
    let mut groups: Vec<_> = latin_runs(text).map(|term| vec![term]).collect();
    for run in cjk_runs(text) {
        let words: IndexSet<_> = bigrams(run).collect();
        match words.len() {
            0 => {}
            1..=MAX_PHRASE_BIGRAMS => groups.push(words.into_iter().collect()),
            _ => groups.extend(words.into_iter().map(|term| vec![term])),
        }
    }
    groups
}

pub fn match_expression(text: &str) -> Option<String> {
    let mut remaining = MAX_MATCH_TERMS;
    let mut parts = Vec::new();
    for group in match_groups(text) {
        let kept = &group[..group.len().min(remaining)];
        // 分词器只返回拉丁词或中日韩字符，词内不会含引号。
        let quoted = kept
            .iter()
            .map(|term| format!(r#""{term}""#))
            .collect::<Vec<_>>()
            .join(" AND ");
        parts.push(if kept.len() > 1 {
            format!("({quoted})")
        } else {
            quoted
        });
        remaining -= kept.len();
        if remaining == 0 {
            break;
        }
    }
    (!parts.is_empty()).then(|| parts.join(" OR "))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranking_and_sqlite_keep_the_same_strong_terms_in_order() {
        let text = "中中中 ＃ ++-ab-x ..a zz. 缓存层";
        assert_eq!(index_tokens(text), ["ab-x", "zz.", "中中", "缓存", "存层"]);
        assert_eq!(weighted_terms(text)["中"], 1.5);
        assert_eq!(weighted_terms(text)["中中"], 2.0);
        assert_eq!(
            match_expression("缓存层"),
            Some(r#"("缓存" AND "存层")"#.into())
        );
    }
}
