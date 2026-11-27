//! Registration through the synchronous JS API accepts live values, including
//! UTF-16 strings cut between surrogate halves. HTTP input uses the JSON kernel.
use super::*;
use multicc_core::{docs_memory_routes as policy, js::JsString};
use std::collections::HashSet;

fn clean(value: L<'_>, max: usize) -> Result<L<'_>> {
    let units = value.string()?.unwrap_or_default().into_units();
    let printable = JsString::from_units(
        units
            .into_iter()
            .filter(|n| *n >= 32 && *n != 127)
            .collect(),
    );
    value.from_value(&V::String(printable.trim().truncate_units(max)))
}
pub(super) fn directory(v: L<'_>) -> Result<L<'_>> {
    let Some(input) = v.string()? else {
        return null(v);
    };
    let trimmed = input.trim();
    if !policy::is_absolute(&trimmed.to_string_lossy()) {
        return null(v);
    }
    let sep = std::path::MAIN_SEPARATOR as u16;
    let parts: Vec<_> = trimmed.as_units().split(|u| *u == sep).collect();
    let marker: Vec<_> = policy::WORKTREE_SUBDIR.encode_utf16().collect();
    let mut units = match parts.iter().position(|s| *s == marker.as_slice()) {
        Some(index) if index > 0 => parts[..index].join(&sep),
        _ => trimmed.into_units(),
    };
    while units.last() == Some(&(b'/' as u16)) {
        units.pop();
    }
    if units.is_empty() {
        units.push(sep);
    }
    v.from_value(&V::String(JsString::from_units(units)))
}
pub(crate) fn absolute_href(v: L<'_>) -> Result<L<'_>> {
    if let Some(url) = v.catch(|| v.global()?.get(c"URL")?.construct(&[v]))? {
        let protocol = url.get(c"protocol")?;
        if protocol.is_string("http:")? || protocol.is_string("https:")? {
            return url.get(c"href");
        }
    }
    null(v)
}
fn url(v: L<'_>) -> Result<L<'_>> {
    let Some(value) = v.string()? else {
        return null(v);
    };
    let value = value.trim();
    if value.is_empty()
        || value.len() > policy::MAX_URL
        || value.as_units().iter().any(|u| *u == 10 || *u == 13)
    {
        return null(v);
    }
    if value.as_units().first() == Some(&(b'/' as u16)) {
        return match policy::clean_relative_url(&value.to_string_lossy()) {
            Some(s) => text(v, &s),
            None => null(v),
        };
    }
    absolute_href(v.from_value(&V::String(value))?)
}
pub(super) fn incoming<'a>(p: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let out = fields(p, &[])?;
    let kind = body.get(c"kind")?;
    if !kind.undefined()? {
        out.set(
            c"kind",
            if call(p.get(c"kinds")?, c"has", &[kind])?.truthy()? {
                body.get(c"kind")?
            } else {
                text(p, "page")?
            },
        )?;
    }
    for (key, limit) in [
        (c"title", policy::MAX_TITLE),
        (c"url", 0),
        (c"note", policy::MAX_NOTE),
        (c"sessionId", 128),
    ] {
        if !body.get(key)?.undefined()? {
            let v = body.get(key)?;
            let v = if key == c"url" {
                url(v)?
            } else {
                clean(v, limit)?
            };
            if !v.nullish()? {
                out.set(key, v)?;
            }
        }
    }
    if body.get(c"relatedArtifactIds")?.is_array()? {
        let mut seen = HashSet::new();
        let ids = array(p)?;
        body.get(c"relatedArtifactIds")?.for_each(|v| {
            if let Some(s) = v.string()? {
                let s = s.to_string_lossy();
                if policy::valid_artifact_id(&s) && seen.insert(s) {
                    call(ids, c"push", &[v])?;
                }
            }
            Ok(())
        })?;
        out.set(c"relatedArtifactIds", ids)?;
    }
    for (key, limit) in [
        (c"taskId", 160),
        (c"source", 32),
        (c"pinned", 0),
        (c"permanent", 0),
        (c"dir", 500),
        (c"port", 0),
        (c"startCmd", 500),
        (c"cwd", 500),
    ] {
        if body.get(key)?.undefined()? {
            continue;
        }
        let value = body.get(key)?;
        let v = match key {
            k if k == c"pinned" || k == c"permanent" => flag(p, value.is_true()?)?,
            k if k == c"port" => {
                let n = value.explicit_number()?;
                if n.fract() != 0.0 || !(1.0..=65535.0).contains(&n) {
                    continue;
                }
                num(p, n)?
            }
            k if k == c"dir" => {
                let v = directory(clean(value, limit)?)?;
                if v.nullish()? {
                    continue;
                }
                v
            }
            k if k == c"cwd" => {
                let v = clean(value, limit)?;
                if !policy::is_absolute(&word(v)?) {
                    continue;
                }
                v
            }
            k if k == c"source" => fallback(clean(value, limit)?, "agent".into())?,
            _ => clean(value, limit)?,
        };
        out.set(key, v)?;
    }
    Ok(out)
}
