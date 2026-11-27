//! Extract speech vocabulary from chat history on the worker pool. Keep the
//! original UTF-16 content for persisted vetoes even when it contains surrogates.
use crate::js::{json_parse, JsString as S, JsValue as V};
use crate::voice_typed_terms::{history_template_mask, rank_scan_terms, Vocabulary};
use regex::Regex;
use sha1::{Digest, Sha1};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::LazyLock,
};

pub fn example_id(raw: &S) -> String {
    format!("{:x}", Sha1::digest(raw.utf8_lossy_bytes()))[..16].to_owned()
}

pub fn distinctive(word: &str) -> bool {
    const COMMON: &[&str] = &[
        "THE", "AND", "FOR", "YOU", "NOT", "BUT", "API", "URL", "GET", "POST", "PUT", "DELETE",
        "HTTP", "HTTPS", "JSON", "HTML", "CSS", "TODO", "NOTE", "OK", "YES", "PDF", "PNG", "JPG",
        "GIF", "SVG", "CPU", "GPU", "RAM", "USB",
    ];
    let b = word.as_bytes();
    if !(3..=24).contains(&word.encode_utf16().count())
        || b.contains(&b'_')
        || b[0].is_ascii_digit()
        || b.iter().filter(|x| x.is_ascii_digit()).count() >= 3
    {
        return false;
    }
    if b.iter()
        .all(|x| x.is_ascii_uppercase() || x.is_ascii_digit())
    {
        return b.len() <= 4
            && b.windows(2).any(|p| p.iter().all(u8::is_ascii_uppercase))
            && !COMMON.contains(&word);
    }
    b.windows(2).any(|p| {
        (p[0].is_ascii_lowercase() && p[1].is_ascii_uppercase())
            || (p[0].is_ascii_alphabetic() && p[1].is_ascii_digit())
            || (p[0].is_ascii_digit() && p[1].is_ascii_alphabetic())
    }) || b
        .windows(3)
        .any(|p| p[0].is_ascii_alphabetic() && p[1] == b'-' && p[2].is_ascii_alphabetic())
}
pub fn prose(s: &str) -> String {
    // JavaScript WhiteSpace/LineTerminator excludes U+0085 and includes BOM.
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        let ws = r"\x09-\x0d \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";
        [
            r"(?s)```.*?```".to_owned(),
            r"`[^`\n]*`".to_owned(),
            format!(r"https?://[^{ws}]+"),
            format!(r#"[^{ws}"'`()（）]*[/\\][^{ws}"'`()（）]*"#),
            format!(r"(?:^|[{ws}])--?[A-Za-z][A-Za-z0-9_-]*"),
            r"\$[A-Z_][A-Z0-9_]*".to_owned(),
        ]
        .iter()
        .map(|p| Regex::new(p).expect("voice prose pattern"))
        .collect()
    });
    PATTERNS
        .iter()
        .fold(s.to_owned(), |s, re| re.replace_all(&s, " ").into_owned())
}
pub fn machine(s: &S) -> bool {
    let s = s.trim_start();
    let u = s.as_units();
    // Legacy JS regex has no /u: either surrogate in the mute emoji matches.
    matches!(u.first(), Some(0x3010 | 91 | 0xd83d | 0xdd07 | 60 | 123))
        || ["background", "task "].iter().any(|prefix| {
            u.len() >= prefix.len()
                && u.iter()
                    .zip(prefix.bytes())
                    .all(|(&c, b)| c < 128 && (c as u8).eq_ignore_ascii_case(&b))
        })
}
pub fn messages(input: &str) -> Vec<(S, S)> {
    fn take(v: V) -> Option<(S, S)> {
        match (v.get("role"), v.get("content")) {
            (Some(V::String(role)), Some(V::String(text))) => Some((role.clone(), text.clone())),
            _ => None,
        }
    }
    let t = S::from(input).trim_start().to_string_lossy();
    if t.starts_with('[') {
        if let Ok(V::Array(a)) = json_parse(&t) {
            return a.into_iter().filter_map(take).collect();
        }
    }
    input
        .lines()
        .filter(|s| s.contains("\"role\""))
        .filter_map(|s| json_parse(s).ok().and_then(take))
        .collect()
}
fn tail(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let offset = f.metadata()?.len().saturating_sub(512 * 1024);
    f.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    f.take(512 * 1024).read_to_end(&mut bytes)?;
    let start = if offset > 0 {
        bytes.iter().position(|x| *x == 10).map_or(0, |i| i + 1)
    } else {
        0
    };
    Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
}
pub fn ranked(user: &Vocabulary, model: &Vocabulary) -> V {
    let terms = |v: &Vocabulary| v.spellings().map(distinctive).collect::<Vec<_>>();
    let rank = rank_scan_terms(
        user.terms(&terms(user)).unwrap(),
        model.terms(&terms(model)).unwrap(),
    );
    V::Array(
        rank.into_iter()
            .map(|r| {
                V::object(vec![
                    ("term", V::string(r.term)),
                    ("count", V::Number(r.count as f64)),
                    ("sessions", V::Number(r.sessions as f64)),
                    ("source", V::string(r.source)),
                ])
            })
            .collect(),
    )
}
pub fn scan(dir: &Path) -> V {
    let Ok(entries) = fs::read_dir(dir) else {
        return V::Null;
    };
    let mut files = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name();
            let name = name.to_str()?;
            if name.starts_with("__") || !name.ends_with(".json") {
                return None;
            }
            let path = e.path();
            Some((fs::metadata(&path).ok()?.modified().ok()?, path))
        })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    files.truncate(300);
    let mut user = Vec::new();
    let mut assistant = Vec::new();
    for (id, (_, path)) in files.iter().enumerate() {
        let Ok(s) = tail(path) else {
            continue;
        };
        for (role, content) in messages(&s) {
            if content.len() > 1500 {
                continue;
            }
            if role == "user" && !machine(&content) {
                user.push((id as u32, content))
            } else if role == "assistant" {
                assistant.push((id as u32, content))
            }
        }
    }
    fn tally(rows: Vec<(u32, S)>) -> (Vocabulary, Vec<S>) {
        let mask = history_template_mask(rows.iter().map(|(_, s)| s.as_units()));
        let mut vocab = Vocabulary::default();
        let mut kept = Vec::new();
        for ((id, s), keep) in rows.into_iter().zip(mask) {
            if keep != 0 {
                vocab.observe(id, &prose(&s.to_string_lossy()));
                kept.push(s);
            }
        }
        (vocab, kept)
    }
    let (user, mut kept) = tally(user);
    let (model, _) = tally(assistant);
    let start = kept.len().saturating_sub(1000);
    V::object(vec![
        ("typed", ranked(&user, &model)),
        (
            "kept",
            V::Array(kept.drain(start..).map(V::String).collect()),
        ),
        ("files", V::Number(files.len() as f64)),
    ])
}
