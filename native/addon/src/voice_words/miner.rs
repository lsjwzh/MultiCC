use super::*;
use multicc_core::{
    js::is_js_whitespace, voice_hotword_pairs, voice_typed_terms::Vocabulary, voice_words,
};

pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let api = methods(
        p,
        &[
            ("tokenize", 1, tokenize),
            ("minePairs", 2, pairs),
            ("mineTypedTerms", 1, typed),
            ("rankTypedHotwords", 2, rank),
            ("distinctive", 1, distinctive),
            ("pairKey", 2, pair_key),
            ("vetoedBy", 2, veto),
            ("buildHotwords", 2, build),
        ],
    )?;
    api.set(c"ACTIVATE_AT", num(p, 2.)?)?;
    Ok(api)
}
fn tokenize<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let Some(s) = a[0].string()? else {
        return tokenize_array_like(p, a[0]);
    };
    let units = s.as_units();
    let mut rows = vec![];
    let (mut i, mut gap) = (0, false);
    let word = |u: u16| u8::try_from(u).is_ok_and(|c| c.is_ascii_alphanumeric());
    while i < units.len() {
        if is_js_whitespace(units[i]) {
            gap = true;
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        if word(units[start]) {
            while i < units.len() && (word(units[i]) || matches!(units[i], 95 | 46 | 43 | 45)) {
                i += 1
            }
        }
        rows.push(V::object(vec![
            ("value", V::String(s.slice_units(start, i))),
            ("start", V::Number(start as f64)),
            ("end", V::Number(i as f64)),
            ("gap", V::Bool(gap)),
        ]));
        gap = false
    }
    p.from_value(&V::Array(rows))
}
// Indexed string-like objects may expose their own length, character and
// conversion getters. Match the original sticky RegExp against the object.
fn tokenize_array_like<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let out = array(p)?;
    let whitespace = regex(p, r"\s", "")?;
    let letter = regex(p, "[A-Za-z0-9]", "")?;
    let word = regex(p, "[A-Za-z0-9][A-Za-z0-9_.+-]*", "y")?;
    let mut at = num(p, 0.)?;
    let mut gap = false;
    loop {
        let length = crate::js_iteration::read(input, c"length")?;
        let before_end = match (at.string()?, length.string()?) {
            (Some(at), Some(length)) => at < length,
            _ => at.number()? < length.explicit_number()?,
        };
        if !before_end {
            break;
        }
        let ch = input.get_key(at)?;
        if call(whitespace, c"test", &[ch])?.truthy()? {
            gap = true;
            at = num(p, at.number()? + 1.)?;
            continue;
        }
        word.set(c"lastIndex", at)?;
        let mut value = ch;
        if call(letter, c"test", &[ch])?.truthy()? {
            let found = call(word, c"exec", &[input])?;
            if found.truthy()? {
                value = found.element(0)?;
            }
        }
        let advance = || -> Result<L<'a>> {
            let width = crate::js_iteration::read(value, c"length")?;
            if at.string()?.is_some() || width.string()?.is_some() {
                let mut next = at.coerce_string()?;
                next.push(&width.coerce_string()?);
                return ls(p, next);
            }
            num(p, at.number()? + width.number()?)
        };
        let end = advance()?;
        push(
            out,
            fields(
                p,
                &[
                    ("value", value),
                    ("start", at),
                    ("end", end),
                    ("gap", flag(p, gap)?),
                ],
            )?,
        )?;
        gap = false;
        at = advance()?;
    }
    Ok(out)
}
fn squash(s: &S) -> S {
    S::from_units(
        s.as_units()
            .iter()
            .copied()
            .filter(|&u| !is_js_whitespace(u))
            .collect(),
    )
    .to_lowercase()
}
fn pairs<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (raw, edited) = (
        a[0].string()?.unwrap_or_default().trim(),
        a[1].string()?.unwrap_or_default().trim(),
    );
    let corr = p.get(c"corrector")?;
    let mut out = Vec::new();
    for pair in voice_hotword_pairs::mine_pairs(
        &raw,
        &edited,
        |a, b| Ok(squash(a) == squash(b)),
        |x, y| -> Result<bool> {
            if x.len() != y.len() {
                return Ok(false);
            }
            let sa = corr.get(c"toSyllables")?.call_plain(&[ls(p, x.clone())?])?;
            let sb = corr.get(c"toSyllables")?.call_plain(&[ls(p, y.clone())?])?;
            if !sa.truthy()? || !sb.truthy()? {
                return Ok(true);
            }
            let ctx = fields(p, &[("target", sb), ("corrector", corr)])?;
            let close = call(
                sa,
                c"filter",
                &[function(ctx, "close", 2, 2, |c, v| {
                    let b = c.get(c"target")?.get_key(v[1])?;
                    if v[0].equals(b)? {
                        flag(c, true)
                    } else {
                        c.get(c"corrector")?
                            .get(c"nearSyllable")?
                            .call_plain(&[v[0], b])
                    }
                })?],
            )?;
            Ok(len(close)? * 2 >= x.len())
        },
    )? {
        let mut e = vec![("term", V::String(pair.term))];
        if let Some(alias) = pair.alias {
            e.push(("alias", V::String(alias)))
        }
        out.push(V::object(e))
    }
    p.from_value(&V::Array(out))
}
fn pair_key<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let mut key = lower(a[0])?.coerce_string()?;
    key.push_unit(0);
    let rest = call(a[1], c"replace", &[regex(p, r"\s+", "g")?, text(p, "")?])?;
    key.push(&lower(rest)?.coerce_string()?);
    ls(p, key)
}
fn distinctive<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    flag(
        p,
        voice_words::distinctive(&a[0].coerce_string()?.to_string_lossy()),
    )
}
fn vocabulary<'a>(p: L<'a>, messages: L<'a>) -> Result<(Vocabulary, L<'a>)> {
    let ids = p.global()?.get(c"Map")?.construct(&[])?;
    let mut vocab = Vocabulary::default();
    messages.for_each(|m| {
        let id = m.get(c"session")?;
        let value = m.get(c"text")?;
        let prose = voice_words::prose(&fold_string(fallback(value, V::string(""))?)?);
        if !call(ids, c"has", &[id])?.truthy()? {
            call(ids, c"set", &[id, ids.get(c"size")?])?;
        }
        vocab.observe(call(ids, c"get", &[id])?.number()? as u32, &prose);
        Ok(())
    })?;
    Ok((vocab, ids))
}
fn typed<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (v, ids) = vocabulary(p, a[0])?;
    let sessions = gcall(p, c"Array", c"from", &[call(ids, c"keys", &[])?])?;
    let map = p.global()?.get(c"Map")?;
    let out = map.construct(&[])?;
    let flags = v
        .spellings()
        .map(voice_words::distinctive)
        .collect::<Vec<_>>();
    for row in v.terms(&flags).map_err(napi::Error::from_reason)? {
        let set = p.global()?.get(c"Set")?.construct(&[])?;
        for &id in row.sessions {
            call(set, c"add", &[sessions.element(id)?])?;
        }
        let forms = map.construct(&[])?;
        for (name, &n) in row.forms {
            call(forms, c"set", &[text(p, name)?, num(p, n as f64)?])?;
        }
        call(
            out,
            c"set",
            &[
                text(p, row.key)?,
                fields(
                    p,
                    &[
                        ("term", text(p, row.spelling)?),
                        ("count", num(p, row.count as f64)?),
                        ("sessions", set),
                        ("forms", forms),
                    ],
                )?,
            ],
        )?;
    }
    Ok(out)
}
fn rank<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (u, _) = vocabulary(p, a[0])?;
    let (m, _) = vocabulary(p, a[1])?;
    p.from_value(&voice_words::ranked(&u, &m))
}
fn veto<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let alias = lower(a[0])?.coerce_string()?;
    let ascii = call(regex(p, r"^[\x20-\x7e]+$", "")?, c"test", &[a[0]])?.truthy()?;
    let mut hit = false;
    a[1].for_each_while(|v| {
        let s = lower(string(fallback(v, V::string(""))?)?)?.coerce_string()?;
        let units = s.as_units();
        let alias = alias.as_units();
        for start in 0..=units.len().saturating_sub(alias.len()) {
            if units.get(start..start + alias.len()) != Some(alias) {
                continue;
            }
            let word = |c: Option<&u16>| {
                c.is_some_and(|&u| {
                    u8::try_from(u).is_ok_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                })
            };
            if !ascii
                || (!word(start.checked_sub(1).and_then(|i| units.get(i)))
                    && !word(units.get(start + alias.len())))
            {
                hit = true;
                return Ok(false);
            }
        }
        Ok(true)
    })?;
    flag(p, hit)
}
fn build<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let state = a[0];
    let kept = with_default(a[1], array(p)?)?;
    let rejected = p
        .global()?
        .get(c"Set")?
        .construct(&[or_array(state.get(c"rejected")?)?])?;
    let pairs = gcall(
        p,
        c"Object",
        c"entries",
        &[fallback(state.get(c"pairs")?, V::Object(vec![]))?],
    )?;
    let typed = function(state, "typed", 0, 0, |s, _| or_array(s.get(c"typed")?))?;
    let ports = methods(
        p,
        &[
            ("alias", 1, |_, a| a[0].get(c"alias")),
            ("term", 1, |_, a| a[0].get(c"term")),
            ("lower", 1, |_, a| lower(a[0])),
            ("typedKey", 1, |p, a| pair_key(p, &mut [a[0], text(p, "")?])),
            ("activates", 1, |p, a| {
                flag(p, a[0].explicit_number()? >= 2.)
            }),
            ("vetoedBy", 2, veto),
        ],
    )?;
    let result = call(p, c"list", &[pairs, typed, rejected, kept, ports])?;
    let rows = array(p)?;
    result.get(c"active")?.for_each(|e| {
        let aliases = e.get(c"aliases")?;
        let term = e.get(c"term")?;
        if len(aliases)? == 0 {
            return push(rows, term);
        }
        let mut s = term.coerce_string()?;
        s.push_unit(61);
        s.push(&join(aliases, "/")?.coerce_string()?);
        push(rows, ls(p, s)?)
    })?;
    let out = fields(p, &[("list", join(rows, ", ")?)])?;
    out.spread_from(result)?;
    Ok(out)
}
