//! Mutable documents registry for deployments with a live JS host. Rows retain
//! their JS identity for synchronous callers. Files and graph scans are native.
mod retention;
pub(crate) mod sanitize;
mod services;
use crate::{
    host_methods::{async_result, env, function},
    route_response::*,
};
use multicc_core::docs_memory_routes::{artifact_id_from_url, MAX_ENTRIES};
use napi_derive::napi;
use std::{ffi::CStr, fs, path::Path};

const SCAN_FAILED: &str = "artifact dependencies could not be verified; registry eviction skipped";
fn array(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Array(Vec::new()))
}
fn undefined(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn word(v: L<'_>) -> Result<String> {
    Ok(v.coerce_string()?.to_string_lossy())
}
fn length(v: L<'_>) -> Result<usize> {
    Ok(v.get(c"length")?.number()? as usize)
}
fn failure<'a>(p: L<'a>, s: &str) -> Result<L<'a>> {
    fields(p, &[("error", text(p, s)?)])
}
fn find(rows: L<'_>, key: &CStr, value: L<'_>) -> Result<Option<u32>> {
    for i in 0..length(rows)? as u32 {
        if rows.element(i)?.get(key)?.equals(value)? {
            return Ok(Some(i));
        }
    }
    Ok(None)
}
fn iso(p: L<'_>) -> Result<L<'_>> {
    call(
        p.global()?.get(c"Date")?.construct(&[])?,
        c"toISOString",
        &[],
    )
}
fn artifact_id(v: L<'_>) -> Result<L<'_>> {
    match v
        .string()?
        .and_then(|s| artifact_id_from_url(Some(&s.to_string_lossy())))
    {
        Some(id) => text(v, &id),
        None => null(v),
    }
}
fn uid(p: L<'_>) -> Result<L<'_>> {
    let g = p.global()?;
    let random = call(g.get(c"Math")?, c"random", &[])?;
    let prefix = call(
        call(random, c"toString", &[num(p, 36.)?])?,
        c"slice",
        &[num(p, 2.)?, num(p, 10.)?],
    )?;
    let now = call(g.get(c"Date")?, c"now", &[])?;
    let suffix = call(
        call(now, c"toString", &[num(p, 36.)?])?,
        c"slice",
        &[num(p, -4.)?],
    )?;
    call(text(p, "doc_")?, c"concat", &[prefix, suffix])
}
fn bump(p: L<'_>) -> Result<()> {
    p.set(c"revision", num(p, p.get(c"revision")?.number()? + 1.)?)
}
fn save(p: L<'_>) -> Result<L<'_>> {
    bump(p)?;
    let stored = (|| {
        let data = call(
            p.global()?.get(c"JSON")?,
            c"stringify",
            &[p.get(c"entries")?, null(p)?, num(p, 2.)?],
        )?;
        crate::runtime_security::atomic(
            p,
            p.get(c"STORE")?,
            &word(data)?,
            0o600,
            0o700,
            p.get(c"reportFailure")?,
        )
    })();
    if let Err(e) = stored {
        let message = match p.exception_value()? {
            Some(e) => e.get(c"message")?,
            None => text(p, &e.reason)?,
        };
        call(
            p.global()?.get(c"console")?,
            c"error",
            &[text(p, "[multicc/docs-registry] save failed:")?, message],
        )?;
    }
    undefined(p)
}
fn load(p: L<'_>) -> Result<L<'_>> {
    let file = word(p.get(c"STORE")?)?;
    let entries = if let Ok(bytes) = fs::read(file) {
        p.catch(|| {
            call(
                p.global()?.get(c"JSON")?,
                c"parse",
                &[text(p, &String::from_utf8_lossy(&bytes))?],
            )
        })?
    } else {
        None
    };
    let entries = match entries {
        Some(v) if v.is_array()? => v,
        _ => array(p)?,
    };
    p.set(c"entries", entries)?;
    let mut upgraded = false;
    entries.for_each(|entry| {
        if entry.truthy()?
            && entry.get(c"pinned")?.is_true()?
            && entry.get(c"permanent")?.undefined()?
        {
            entry.assign(c"permanent", flag(p, true)?)?;
            upgraded = true;
        }
        Ok(())
    })?;
    if upgraded {
        save(p)?;
    }
    undefined(p)
}
fn with_incoming<'a>(rows: L<'a>, entry: L<'a>) -> Result<L<'a>> {
    let snapshot = array(rows)?;
    rows.for_each(|r| {
        call(snapshot, c"push", &[r])?;
        Ok(())
    })?;
    call(snapshot, c"push", &[entry])?;
    Ok(snapshot)
}
fn set_defaults(entry: L<'_>) -> Result<()> {
    for (key, value) in [(c"kind", "page"), (c"source", "agent")] {
        if !entry.get(key)?.truthy()? {
            entry.set(key, text(entry, value)?)?;
        }
    }
    Ok(())
}
fn store_entry<'a>(p: L<'a>, raw: L<'a>, checked: Option<L<'a>>) -> Result<L<'a>> {
    let entry = crate::js_live::spread(raw)?;
    set_defaults(entry)?;
    let id = artifact_id(entry.get(c"url")?)?;
    if id.truthy()? {
        entry.set(c"artifactId", id)?;
    }
    let rows = p.get(c"entries")?;
    let existing = find(rows, c"url", entry.get(c"url")?)?;
    let now = iso(p)?;
    let stored = if let Some(i) = existing {
        let merged = crate::js_live::spread(rows.element(i)?)?;
        merged.spread_from(entry)?;
        merged.set(c"updatedAt", now)?;
        rows.set_element(i, merged)?;
        merged
    } else {
        if length(rows)? >= MAX_ENTRIES {
            let kept = match checked {
                Some(ids) if ids.truthy()? => ids,
                _ => match p.catch(|| {
                    let list = retention::scan(with_incoming(rows, entry)?, retention::roots(p)?)?;
                    p.global()?.get(c"Set")?.construct(&[list])
                })? {
                    Some(set) => set,
                    None => return failure(p, SCAN_FAILED),
                },
            };
            let mut victim = None;
            for i in 0..length(rows)? as u32 {
                let row = rows.element(i)?;
                if !row.get(c"permanent")?.truthy()?
                    && !call(kept, c"has", &[artifact_id(row.get(c"url")?)?])?.truthy()?
                {
                    victim = Some(i);
                    break;
                }
            }
            let Some(i) = victim else {
                return failure(p, "registry is full (all entries permanent)");
            };
            call(rows, c"splice", &[num(p, i.into())?, num(p, 1.)?])?;
        }
        entry.set(c"id", uid(p)?)?;
        entry.set(c"createdAt", now)?;
        call(rows, c"push", &[entry])?;
        entry
    };
    save(p)?;
    fields(
        p,
        &[("entry", stored), ("created", flag(p, existing.is_none())?)],
    )
}
fn register<'a>(p: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let body = if body.truthy()? {
        body
    } else {
        fields(p, &[])?
    };
    let entry = sanitize::incoming(p, body)?;
    set_defaults(entry)?;
    if !entry.get(c"title")?.truthy()? {
        return failure(p, "title is required");
    }
    if !entry.get(c"url")?.truthy()? {
        return failure(p, "a valid http(s) or root-relative url is required");
    }
    let kinds = p.get(c"kinds")?;
    if !call(kinds, c"has", &[entry.get(c"kind")?])?.truthy()? {
        let names = call(p.global()?.get(c"Array")?, c"from", &[kinds])?;
        return failure(
            p,
            &format!(
                "kind must be one of {}",
                word(call(names, c"join", &[text(p, "/")?])?)?
            ),
        );
    }
    store_entry(p, entry, None)
}
fn snapshot(p: L<'_>, retain: bool) -> Result<L<'_>> {
    let kept = if retain {
        Some(retention::view(p)?)
    } else {
        None
    };
    let out = array(p)?;
    p.get(c"entries")?.for_each(|row| {
        let copy = crate::js_live::spread(row)?;
        if let Some(ids) = kept {
            copy.set(
                c"retained",
                call(ids, c"has", &[artifact_id(row.get(c"url")?)?])?,
            )?;
        }
        call(out, c"push", &[copy])?;
        Ok(())
    })?;
    Ok(out)
}
fn rank(row: L<'_>, view: bool) -> Result<i32> {
    let permanent = row.get(c"permanent")?;
    Ok(
        if if view {
            permanent.is_true()?
        } else {
            permanent.truthy()?
        } {
            2
        } else if row.get(c"pinned")?.truthy()? {
            1
        } else {
            0
        },
    )
}
fn compare<'a>(p: L<'a>, a: L<'a>, b: L<'a>, normalized: bool) -> Result<L<'a>> {
    let delta = if normalized {
        b.get(c"rank")?.number()? - a.get(c"rank")?.number()?
    } else {
        (rank(b, false)? - rank(a, false)?) as f64
    };
    if delta != 0. {
        num(p, delta)
    } else {
        let b = string(b.get(c"createdAt")?)?;
        call(b, c"localeCompare", &[string(a.get(c"createdAt")?)?])
    }
}
fn order(p: L<'_>) -> Result<L<'_>> {
    let ranked = array(p)?;
    let rows = p.get(c"entries")?;
    for i in 0..length(rows)? as u32 {
        let row = rows.element(i)?;
        let item = fields(
            p,
            &[
                ("index", num(p, i.into())?),
                ("rank", num(p, rank(row, true)?.into())?),
                ("createdAt", string(row.get(c"createdAt")?)?),
            ],
        )?;
        call(ranked, c"push", &[item])?;
    }
    call(
        ranked,
        c"sort",
        &[function(p, "", 2, 2, |p, a| compare(p, a[0], a[1], true))?],
    )?;
    let out = array(p)?;
    ranked.for_each(|r| {
        call(out, c"push", &[r.get(c"index")?])?;
        Ok(())
    })?;
    Ok(out)
}
pub(super) fn by_id<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let rows = p.get(c"entries")?;
    match find(rows, c"id", id)? {
        Some(i) => rows.element(i),
        None => null(p),
    }
}
#[napi]
pub fn docs_registry_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let kinds = p.global()?.get(c"Set")?.construct(&[
        p.from_value(&V::Array(["page", "file", "service"].map(V::from).to_vec()))?
    ])?;
    p.set(c"kinds", kinds)?;
    p.set(c"revision", num(p, 0.)?)?;
    p.set(c"timer", null(p)?)?;
    load(p)?;
    let api = fields(p, &[("STORE", p.get(c"STORE")?), ("KINDS", kinds)])?;
    macro_rules! method {
        ($name:literal,$arity:literal,$run:expr) => {
            api.define_key(text(p, $name)?, function(p, $name, $arity, $arity, $run)?)?
        };
    }
    method!("register", 1, |p, a| register(p, a[0]));
    method!("registerEntry", 2, |p, a| store_entry(p, a[0], Some(a[1])));
    method!("registerEntryAsync", 1, |p, a| async_result(p, || {
        retention::register_async(p, a[0])
    }));
    method!("artifactIdFromUrl", 1, |_, a| artifact_id(a[0]));
    method!("normalizeDir", 1, |_, a| sanitize::directory(a[0]));
    method!("list", 0, |p, _| snapshot(p, true));
    method!("entriesSnapshot", 0, |p, _| snapshot(p, false));
    method!("byRetention", 2, |p, a| compare(p, a[0], a[1], false));
    method!("viewSortOrder", 0, |p, _| order(p));
    method!("retentionForView", 0, |p, _| retention::view(p));
    method!("listPermanentArtifactIds", 0, |p, _| retention::scan(
        p.get(c"entries")?,
        retention::roots(p)?
    ));
    method!("listPermanentArtifactIdsAsync", 0, |p, _| async_result(
        p,
        || retention::consistent(p, retention::roots(p)?)
    ));
    method!("retainedIds", 0, |p, _| call(
        p.global()?.get(c"Array")?,
        c"from",
        &[retention::view(p)?]
    ));
    method!("retainedIdsAsync", 1, |p, a| async_result(p, || {
        retention::snapshot_async(p, a[0])
    }));
    method!("entryById", 1, |p, a| by_id(p, a[0]));
    method!("replaceEntryById", 2, |p, a| {
        let rows = p.get(c"entries")?;
        let i = find(rows, c"id", a[0])?;
        if let Some(i) = i {
            rows.set_element(i, a[1])?;
            save(p)?;
        }
        flag(p, i.is_some())
    });
    method!("removeEntryById", 1, |p, a| {
        let rows = p.get(c"entries")?;
        let i = find(rows, c"id", a[0])?;
        let removed = if let Some(i) = i {
            let row = call(rows, c"splice", &[num(p, i.into())?, num(p, 1.)?])?.element(0)?;
            save(p)?;
            row
        } else {
            null(p)?
        };
        fields(p, &[("found", flag(p, i.is_some())?), ("removed", removed)])
    });
    method!("defaultArtifactExists", 0, |p, _| function(
        p,
        "",
        1,
        1,
        |p, a| {
            let mut exists = false;
            retention::roots(p)?.for_each_while(|root| {
                // path.join concatenates absolute components too, unlike Path::join.
                let path = format!(
                    "{}{}{}",
                    word(root)?,
                    std::path::MAIN_SEPARATOR,
                    word(a[0])?
                );
                exists = Path::new(&path).is_dir();
                Ok(!exists)
            })?;
            flag(p, exists)
        }
    ));
    method!("_resetForTests", 1, |p, a| {
        bump(p)?;
        p.set(c"entries", if a[0].is_array()? { a[0] } else { array(p)? })?;
        undefined(p)
    });
    method!("_saveForTests", 0, |p, _| save(p));
    method!("_loadForTests", 0, |p, _| load(p));
    method!("_entriesForTests", 0, |p, _| call(
        p.get(c"entries")?,
        c"slice",
        &[]
    ));
    services::install(api, p)?;
    Ok(api.raw())
}
