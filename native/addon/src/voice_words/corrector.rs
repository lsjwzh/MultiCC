use super::*;
use multicc_core::hotword_corrector as kernel;

pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let state = fields(
        p,
        &[
            ("loadPinyin", p.get(c"loadPinyin")?),
            ("windows", p.get(c"windows")?),
        ],
    )?;
    methods(
        state,
        &[
            ("parseHotwords", 1, parse),
            ("stripAliases", 1, strip),
            ("nearSyllable", 2, near),
            ("toSyllables", 1, syllables),
            ("createMatcher", 1, matcher),
            ("correctWithHotwords", 2, correct_words),
        ],
    )
}
fn parse<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    p.from_value(&V::Array(
        kernel::entries(&a[0].string()?.unwrap_or_default())
            .into_iter()
            .map(|(term, aliases)| {
                V::object(vec![
                    ("term", V::String(term)),
                    (
                        "aliases",
                        V::Array(aliases.into_iter().map(V::String).collect()),
                    ),
                ])
            })
            .collect(),
    ))
}
fn strip<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    ls(p, kernel::stripped(&a[0].string()?.unwrap_or_default()))
}
fn split(v: L<'_>) -> Result<(&'static str, L<'_>)> {
    for s in [
        "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x",
        "r", "z", "c", "s",
    ] {
        if call(v, c"startsWith", &[text(v, s)?])?.truthy()?
            && v.get(c"length")?.number()? > s.len() as f64
        {
            return Ok((s, slice(v, s.len() as f64, None)?));
        }
    }
    Ok(("", v))
}
fn near<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if let (Some(x), Some(y)) = (a[0].string()?, a[1].string()?) {
        return flag(p, kernel::near(&x, &y));
    }
    let (i, x) = split(a[0])?;
    let (j, y) = split(a[1])?;
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
        .any(|&(u, v)| (u == i && v == j) || (u == j && v == i))
    {
        return flag(p, false);
    }
    if x.equals(y)? {
        return flag(p, true);
    }
    let (short, long) = if x.get(c"length")?.number()? <= y.get(c"length")?.number()? {
        (x, y)
    } else {
        (y, x)
    };
    let mut g = short.coerce_string()?;
    g.push_unit(103);
    flag(
        p,
        long.equals(ls(p, g)?)?
            && call(regex(p, "(an|en|in)$", "")?, c"test", &[short])?.truthy()?,
    )
}
fn syllables<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let mut py = p.get(c"pinyin")?;
    if py.undefined()? {
        py = p
            .catch(|| p.get(c"loadPinyin")?.call_plain(&[]))?
            .unwrap_or(null(p)?);
        p.set(c"pinyin", py)?;
    }
    if !py.truthy()? {
        return null(p);
    }
    Ok(p.catch(|| {
        let syl = py.call_plain(&[
            a[0],
            fields(
                p,
                &[("toneType", text(p, "none")?), ("type", text(p, "array")?)],
            )?,
        ])?;
        if !syl.is_array()? || !syl.get(c"length")?.equals(a[0].get(c"length")?)? {
            return null(p);
        }
        call(
            syl,
            c"map",
            &[function(p, "syllable", 1, 1, |_, v| lower(string(v[0])?))?],
        )
    })?
    .unwrap_or(null(p)?))
}
fn ascii_pattern(s: &str) -> Option<String> {
    let words = s.split_ascii_whitespace().collect::<Vec<_>>();
    if words.iter().map(|w| w.len()).sum::<usize>() < 3 {
        return None;
    }
    let pattern = words
        .iter()
        .map(|w| {
            w.chars()
                .map(|c| {
                    if r".*+?^${}()|[]\".contains(c) {
                        format!("\\{c}")
                    } else {
                        c.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("[ ]?")
        })
        .collect::<Vec<_>>()
        .join("[ ]+");
    Some(format!(
        r"(?<![A-Za-z0-9_./\\-]){pattern}(?![A-Za-z0-9_/\\=-])"
    ))
}
fn matcher<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let mut chinese = Vec::new();
    let ascii = array(p)?;
    a[0].for_each(|entry| {
        let term = entry.get(c"term")?;
        let aliases = entry.get(c"aliases")?;
        let mut forms = vec![term];
        aliases.for_each(|v| {
            forms.push(v);
            Ok(())
        })?;
        for form in forms {
            let s = form.coerce_string()?;
            if !s.is_empty() && s.as_units().iter().all(|c| (0x4e00..=0x9fff).contains(c)) {
                if len(form)? < 2 {
                    continue;
                }
                let syl = syllables(p, &mut [form])?;
                if syl.truthy()? {
                    chinese.push((s.len(), fields(p, &[("syl", syl), ("term", term)])?));
                }
            } else if !s.is_empty() && s.as_units().iter().all(|c| (32..=126).contains(c)) {
                let trimmed = call(form, c"trim", &[])?;
                if let Some(pattern) = ascii_pattern(&trimmed.coerce_string()?.to_string_lossy()) {
                    push(
                        ascii,
                        fields(p, &[("re", regex(p, &pattern, "gi")?), ("term", term)])?,
                    )?;
                }
            }
        }
        Ok(())
    })?;
    chinese.sort_by_key(|(n, _)| std::cmp::Reverse(*n));
    let terms = array(p)?;
    let syllable_rows = array(p)?;
    for (_, row) in chinese {
        push(syllable_rows, row.get(c"syl")?)?;
        push(terms, row.get(c"term")?)?
    }
    let windows = p.get(c"windows")?.construct(&[syllable_rows])?;
    let owner = fields(
        p,
        &[
            ("state", p),
            ("terms", terms),
            ("windows", windows),
            ("ascii", ascii),
        ],
    )?;
    fields(
        p,
        &[
            ("correct", function(owner, "correct", 1, 1, correct)?),
            ("size", num(p, (len(terms)? + len(ascii)?) as f64)?),
        ],
    )
}
fn correct<'a>(o: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let mut out = a[0];
    if !out.truthy()? {
        return Ok(out);
    }
    let terms = o.get(c"terms")?;
    if len(terms)? > 0 {
        let matches = call(out, c"matchAll", &[regex(o, "[一-鿿]+", "g")?])?;
        let mut spans = vec![];
        matches.for_each(|m| {
            let s = syllables(o.get(c"state")?, &mut [m.element(0)?])?;
            if !s.truthy()? {
                return Ok(());
            }
            let base = m.get(c"index")?.number()? as usize;
            call(o.get(c"windows")?, c"find", &[s])?.for_each(|span| {
                spans.push((
                    base + span.element(1)?.number()? as usize,
                    base + span.element(2)?.number()? as usize,
                    terms.element(span.element(0)?.number()? as u32)?,
                ));
                Ok(())
            })
        })?;
        if !spans.is_empty() {
            let input = out.coerce_string()?;
            let mut buf = S::new();
            let mut from = 0;
            for (start, end, term) in spans {
                buf.push(&input.slice_units(from, start));
                buf.push(&term.coerce_string()?);
                from = end
            }
            buf.push(&input.slice_units(from, input.len()));
            out = ls(o, buf)?;
        }
    }
    o.get(c"ascii")?.for_each(|r| {
        out = call(out, c"replace", &[r.get(c"re")?, r.get(c"term")?])?;
        Ok(())
    })?;
    Ok(out)
}
fn correct_words<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !a[0].truthy()? || a[1].string()?.is_none_or(|s| s.trim().is_empty()) {
        return Ok(a[0]);
    }
    if !p.get(c"raw")?.equals(a[1])? {
        let m = matcher(p, &mut [parse(p, &mut [a[1]])?])?;
        p.set(c"matcher", m)?;
        p.set(c"raw", a[1])?
    }
    call(p.get(c"matcher")?, c"correct", &[a[0]])
}
