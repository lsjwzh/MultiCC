//! Session memory entries stay live objects. Only their text is copied into
//! code units for matching, so merging can return a caller's original entry.
use super::*;
use multicc_core::js::{
    string::{contains_units, is_js_whitespace},
    JsString,
};
use std::collections::HashSet;
pub(super) const TYPES: [&str; 5] = ["decision", "gotcha", "preference", "todo", "fact"];
pub(super) const EVICTION: [&str; 5] = ["todo", "fact", "gotcha", "decision", "preference"];

pub(super) fn array<'a>(owner: L<'a>, items: &[L<'a>]) -> Result<L<'a>> {
    let out = owner.from_value(&V::Array(vec![]))?;
    for (i, item) in items.iter().enumerate() {
        out.set_element(i as u32, *item)?
    }
    Ok(out)
}
pub(super) fn from_js(owner: L<'_>, s: JsString) -> Result<L<'_>> {
    owner.from_value(&V::String(s))
}
pub(super) fn print(v: L<'_>) -> Result<JsString> {
    string(v)?.coerce_string()
}
pub(super) fn count(entries: L<'_>) -> Result<usize> {
    Ok(entries.get(c"length")?.number()? as usize)
}
pub(super) fn get_entries(persisted: L<'_>) -> Result<L<'_>> {
    let memory = persisted.optional(c"memory")?;
    if memory.is_array()? {
        return filtered(memory);
    }
    if let Some(raw) = memory.string()? {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return array(memory, &[fact(memory, trimmed)?]);
        }
    }
    array(memory, &[])
}
fn fact(owner: L<'_>, value: JsString) -> Result<L<'_>> {
    fields(
        owner,
        &[
            ("type", text(owner, "fact")?),
            ("text", from_js(owner, value)?),
            ("ts", num(owner, 0.)?),
        ],
    )
}
fn filtered(entries: L<'_>) -> Result<L<'_>> {
    let predicate = function(entries, "", 1, 1, |owner, args| {
        let e = args[0];
        flag(
            owner,
            e.truthy()?
                && e.get(c"text")?.kind()? == sys::ValueType::napi_string
                && call(e.get(c"text")?, c"trim", &[])?.truthy()?,
        )
    })?;
    call(entries, c"filter", &[predicate])
}
pub(super) fn clock(options: L<'_>) -> Result<L<'_>> {
    let value = options.get(c"now")?;
    if value.truthy()? {
        Ok(value)
    } else {
        options.global()?.get(c"Date")?.get(c"now")
    }
}
pub(super) fn default_number<'a>(value: L<'a>, n: f64) -> Result<L<'a>> {
    if value.nullish()? {
        num(value, n)
    } else {
        Ok(value)
    }
}
pub(super) fn normalize<'a>(value: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let max = default_number(options.get(c"maxLength")?, 8000.)?;
    let now = clock(options)?;
    let out = if value.is_array()? {
        let filtered = filtered(value)?;
        let mut items = Vec::new();
        let mut total = 0;
        filtered.for_each(|e| {
            let kind = e.get(c"type")?;
            let kind = if kind
                .string()?
                .is_some_and(|s| TYPES.contains(&s.to_string_lossy().as_str()))
            {
                e.get(c"type")?
            } else {
                text(e, "fact")?
            };
            let trimmed = e.get(c"text")?.coerce_string()?.trim();
            total += trimmed.len();
            let ts = e.get(c"ts")?;
            let ts = if ts.truthy()? {
                ts
            } else {
                now.call_plain(&[])?
            };
            items.push(fields(
                e,
                &[("type", kind), ("text", from_js(e, trimmed)?), ("ts", ts)],
            )?);
            Ok(())
        })?;
        if total as f64 > max.number()? {
            return too_long(value, max, " chars");
        }
        array(value, &items)?
    } else if let Some(raw) = value.string()? {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            null(value)?
        } else {
            if raw.len() as f64 > max.number()? {
                return too_long(value, max, "");
            }
            array(value, &[fact(value, trimmed)?])?
        }
    } else {
        null(value)?
    };
    fields(value, &[("entries", out)])
}
fn too_long<'a>(owner: L<'a>, max: L<'a>, suffix: &str) -> Result<L<'a>> {
    fields(
        owner,
        &[(
            "error",
            text(
                owner,
                &format!(
                    "memory too long (max {}{})",
                    max.coerce_string()?.to_string_lossy(),
                    suffix
                ),
            )?,
        )],
    )
}
fn plain(v: L<'_>) -> Result<JsString> {
    if !v.truthy()? {
        return Ok(JsString::new());
    }
    Ok(call(call(v, c"trim", &[])?, c"toLowerCase", &[])?.coerce_string()?)
}
pub(super) fn similarity(a: L<'_>, b: L<'_>) -> Result<f64> {
    let a = plain(a)?;
    let b = plain(b)?;
    if a.is_empty() || b.is_empty() {
        return Ok(0.);
    }
    if a == b {
        return Ok(1.);
    }
    if a.len() < 40 || b.len() < 40 {
        return Ok(
            if contains_units(a.as_units(), b.as_units())
                || contains_units(b.as_units(), a.as_units())
            {
                0.7
            } else {
                0.
            },
        );
    }
    fn words(s: &JsString) -> HashSet<&[u16]> {
        s.as_units()
            .split(|u| {
                is_js_whitespace(*u)
                    || matches!(
                        *u,
                        44 | 0xff0c
                            | 0x3002
                            | 0xff1b
                            | 59
                            | 58
                            | 0xff1a
                            | 0x3001
                            | 0xff08
                            | 0xff09
                            | 40
                            | 41
                            | 91
                            | 93
                    )
            })
            .filter(|w| !w.is_empty())
            .collect()
    }
    let a = words(&a);
    let b = words(&b);
    Ok(if a.is_empty() || b.is_empty() {
        0.
    } else {
        a.intersection(&b).count() as f64 / a.union(&b).count() as f64
    })
}
pub(super) fn merge<'a>(prior: L<'a>, fresh: L<'a>) -> Result<L<'a>> {
    let mut list = Vec::new();
    prior.for_each(|e| {
        list.push(e);
        Ok(())
    })?;
    fresh.for_each(|e| {
        for old in &mut list {
            if similarity(e.get(c"text")?, old.get(c"text")?)? > 0.6 {
                *old = e;
                return Ok(());
            }
        }
        list.push(e);
        Ok(())
    })?;
    array(prior, &list)
}
fn entry_size(e: L<'_>) -> Result<f64> {
    let s = e.get(c"text")?;
    if !s.truthy()? {
        Ok(0.)
    } else {
        s.get(c"length")?.number()
    }
}
pub(super) fn total(entries: L<'_>) -> Result<f64> {
    let mut n = 0.;
    entries.for_each(|e| {
        n += entry_size(e)?;
        Ok(())
    })?;
    Ok(n)
}
fn rank(e: L<'_>) -> Result<usize> {
    let value = e.get(c"type")?.string()?;
    Ok(value
        .and_then(|v| EVICTION.iter().position(|k| *k == v.to_string_lossy()))
        .unwrap_or(EVICTION.len()))
}
pub(super) fn trim<'a>(entries: L<'a>, max: L<'a>) -> Result<L<'a>> {
    let mut size = total(entries)?;
    if size <= max.number()? {
        return Ok(entries);
    }
    let copied = entries.global()?.get(c"Array")?;
    let sorted = call(copied, c"from", &[entries])?;
    let compare = function(entries, "", 2, 2, |o, a| {
        let diff = rank(a[0])? as f64 - rank(a[1])? as f64;
        let order = if diff != 0. {
            diff
        } else {
            fallback(a[0].get(c"ts")?, V::Number(0.))?.number()?
                - fallback(a[1].get(c"ts")?, V::Number(0.))?.number()?
        };
        num(o, order)
    })?;
    call(sorted, c"sort", &[compare])?;
    let mut cut = 0;
    let length = count(sorted)?;
    while cut < length && size > max.number()? {
        size -= entry_size(sorted.element(cut as u32)?)?;
        cut += 1
    }
    call(sorted, c"slice", &[num(entries, cut as f64)?])
}
pub(super) fn parse<'a>(raw: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let scan = options.get(c"scanContent")?;
    let now = clock(options)?;
    let input = print(fallback(raw, "".into())?)?.trim();
    let mut units = input.as_units();
    if units.starts_with(&[96, 96, 96]) {
        units = &units[3..];
        while units.first().is_some_and(|u| matches!(*u,65..=90|97..=122)) {
            units = &units[1..]
        }
        if units.first() == Some(&10) {
            units = &units[1..]
        }
    }
    if units.ends_with(&[96, 96, 96]) {
        units = &units[..units.len() - 3]
    }
    let mut entries = Vec::new();
    // Match JS's non-dotAll type-prefix regexp, including line terminators.
    let pattern = raw
        .global()?
        .get(c"RegExp")?
        .construct(&[text(raw, r"^\[(\w+)\]\s*(.*)$")?])?;
    for line in units.split(|u| *u == 10) {
        let s = JsString::from_units(line.to_vec()).trim();
        if s.is_empty() || matches!(s.as_units(), [45] | [0x2014]) {
            continue;
        }
        let original = from_js(raw, s)?;
        let m = call(pattern, c"exec", &[original])?;
        let (kind, body) = if m.truthy()? {
            let ty = m
                .element(1)?
                .coerce_string()?
                .to_string_lossy()
                .to_ascii_lowercase();
            (
                if TYPES.contains(&ty.as_str()) {
                    ty
                } else {
                    "fact".into()
                },
                from_js(raw, m.element(2)?.coerce_string()?.trim())?,
            )
        } else {
            ("fact".into(), original)
        };
        if body.truthy()? && !(scan.truthy()? && scan.call_plain(&[body])?.truthy()?) {
            entries.push(fields(
                raw,
                &[
                    ("type", text(raw, &kind)?),
                    ("text", body),
                    ("ts", now.call_plain(&[])?),
                ],
            )?);
        }
    }
    array(raw, &entries)
}
