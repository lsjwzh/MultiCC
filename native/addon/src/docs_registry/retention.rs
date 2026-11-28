//! Capture the graph input on the JS thread. Scans for async callers run on a
//! worker, and a mutation invalidates a cleanup or eviction decision in flight.
use super::*;
use multicc_core::artifact_retention;
use napi::bindgen_prelude::JsValue as _;
use serde_json::{json, Value};
use std::path::PathBuf;

fn input(entries: L<'_>, roots: L<'_>) -> Result<(Vec<Value>, Vec<PathBuf>)> {
    let mut rows = Vec::new();
    entries.for_each(|row| {
        let url = row.get(c"url")?.string()?.map(|s| s.to_string_lossy());
        let permanent = row.get(c"permanent")?.truthy()?;
        let related = row.get(c"relatedArtifactIds")?;
        let mut ids = Vec::new();
        if related.is_array()? {
            related.for_each(|id| {
                if let Some(s) = id.string()? {
                    ids.push(s.to_string_lossy());
                }
                Ok(())
            })?;
        }
        rows.push(json!({"url":url,"permanent":permanent,"relatedArtifactIds":ids}));
        Ok(())
    })?;
    let mut paths = Vec::new();
    roots.for_each(|root| {
        paths.push(PathBuf::from(word(root)?));
        Ok(())
    })?;
    Ok((rows, paths))
}
pub(super) fn roots(p: L<'_>) -> Result<L<'_>> {
    p.get(c"servedRoots")?.call_plain(&[])
}
pub(super) fn scan<'a>(rows: L<'a>, dirs: L<'a>) -> Result<L<'a>> {
    let (entries, roots) = input(rows, dirs)?;
    let kept = artifact_retention::retained(&entries, &roots)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    rows.from_value(&V::Array(kept.into_iter().map(V::from).collect()))
}
fn background<'a>(rows: L<'a>, dirs: L<'a>) -> Result<L<'a>> {
    let (entries, roots) = input(rows, dirs)?;
    let e = env(rows);
    let promise = e.spawn_future(async move {
        tokio::task::spawn_blocking(move || {
            artifact_retention::retained(&entries, &roots)
                .map(|set| set.into_iter().collect::<Vec<_>>())
        })
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))?
        .map_err(|e| napi::Error::from_reason(e.to_string()))
    })?;
    Ok(L::from_raw(rows.env(), promise.raw()))
}
pub(super) fn view(p: L<'_>) -> Result<L<'_>> {
    let rows = p.get(c"entries")?;
    let result = match p.catch(|| scan(rows, roots(p)?))? {
        Some(list) => list,
        None => scan(rows, array(p)?)?,
    };
    p.global()?.get(c"Set")?.construct(&[result])
}
pub(super) fn snapshot_async<'a>(p: L<'a>, rows: L<'a>) -> Result<L<'a>> {
    let promise = async_result(p, || background(rows, roots(p)?))?;
    call(
        promise,
        c"catch",
        &[function(rows, "", 1, 1, |rows, _| {
            scan(rows, array(rows)?)
        })?],
    )
}
pub(super) fn consistent<'a>(p: L<'a>, dirs: L<'a>) -> Result<L<'a>> {
    let state = fields(
        p,
        &[
            ("registry", p),
            ("dirs", dirs),
            ("revision", p.get(c"revision")?),
        ],
    )?;
    let promise = background(p.get(c"entries")?, dirs)?;
    call(
        promise,
        c"then",
        &[function(state, "", 1, 1, |s, a| {
            let p = s.get(c"registry")?;
            if s.get(c"revision")?.equals(p.get(c"revision")?)? {
                Ok(a[0])
            } else {
                consistent(p, s.get(c"dirs")?)
            }
        })?],
    )
}
pub(super) fn register_async<'a>(p: L<'a>, entry: L<'a>) -> Result<L<'a>> {
    let entries = p.get(c"entries")?;
    if length(entries)? < MAX_ENTRIES || find(entries, c"url", entry.get(c"url")?)?.is_some() {
        return store_entry(p, entry, None);
    }
    let s = fields(
        p,
        &[
            ("registry", p),
            ("entry", entry),
            ("revision", p.get(c"revision")?),
        ],
    )?;
    let promise = async_result(p, || background(with_incoming(entries, entry)?, roots(p)?))?;
    let ok = function(s, "", 1, 1, |s, a| {
        let p = s.get(c"registry")?;
        let entry = s.get(c"entry")?;
        if !s.get(c"revision")?.equals(p.get(c"revision")?)? {
            return register_async(p, entry);
        }
        store_entry(p, entry, Some(p.global()?.get(c"Set")?.construct(&[a[0]])?))
    })?;
    let fail = function(p, "", 1, 1, |p, _| failure(p, SCAN_FAILED))?;
    call(promise, c"then", &[ok, fail])
}
