use crate::route_response::*;
use napi_derive::napi;

#[napi]
pub fn workspace_overview(
    env: Env,
    deps: Unknown<'_>,
    newest_first: Unknown<'_>,
) -> Result<sys::napi_value> {
    let d = L::new(&env, deps);
    let runtime = call(d, c"getHibernation", &[])?;
    let buckets = d.global()?.get(c"Map")?.construct(&[])?;
    let zero = num(d, 0.0)?;
    call(d.get(c"directories")?, c"values", &[])?.for_each(|dir| {
        let key = dir.get(c"id")?;
        let bucket = fields(
            d,
            &[
                ("id", dir.get(c"id")?),
                ("path", dir.get(c"path")?),
                ("awake", zero),
                ("hibernated", zero),
                ("transitioning", zero),
                ("planned", zero),
                ("total", zero),
            ],
        )?;
        call(buckets, c"set", &[key, bucket])?;
        Ok(())
    })?;
    let (mut awake, mut hibernated) = (0.0, 0.0);
    call(d.get(c"records")?, c"values", &[])?.for_each(|record| {
        if !record.optional(c"kind")?.is_string("chat")? || !record.get(c"dirId")?.truthy()? {
            return Ok(());
        }
        let bucket = call(buckets, c"get", &[record.get(c"dirId")?])?;
        if !bucket.truthy()? {
            return Ok(());
        }
        let state = fallback(record.get(c"workspaceState")?, "awake".into())?;
        let key = if state.is_string("awake")? {
            awake += 1.0;
            c"awake"
        } else if state.is_string("hibernated")? {
            hibernated += 1.0;
            c"hibernated"
        } else if state.is_string("planned")? {
            c"planned"
        } else {
            c"transitioning"
        };
        for key in [c"total", key] {
            bucket.set(key, num(d, bucket.get(key)?.number()? + 1.0)?)?
        }
        Ok(())
    })?;
    let audit = d.from_value(&V::Array(vec![]))?;
    call(d.get(c"records")?, c"values", &[])?.for_each(|r| {
        let removed = r.optional(c"hibernateRemovedIgnored")?;
        if removed.optional(c"at")?.truthy()? && removed.get(c"entries")?.is_array()? {
            let entry = fields(
                d,
                &[
                    ("sessionId", r.get(c"id")?),
                    ("title", fallback(r.get(c"title")?, V::Null)?),
                    ("at", removed.get(c"at")?),
                    ("entries", removed.get(c"entries")?),
                ],
            )?;
            call(audit, c"push", &[entry])?;
        }
        Ok(())
    })?;
    call(audit, c"sort", &[L::new(&env, newest_first)])?;
    let status = if runtime.truthy()? {
        call(runtime, c"status", &[])?
    } else {
        null(d)?
    };
    let totals = fields(
        d,
        &[
            ("awake", num(d, awake)?),
            ("hibernated", num(d, hibernated)?),
        ],
    )?;
    let dirs = d.from_value(&V::Array(vec![]))?;
    call(buckets, c"values", &[])?.for_each(|b| {
        if b.get(c"total")?.positive()? {
            call(dirs, c"push", &[b])?;
        }
        Ok(())
    })?;
    let audit = call(audit, c"slice", &[zero, num(d, 20.0)?])?;
    let scanner = call(d, c"getOrphanScanner", &[])?;
    let orphans = if scanner.nullish()? {
        null(d)?
    } else {
        fallback(call(scanner, c"report", &[])?, V::Null)?
    };
    Ok(fields(
        d,
        &[
            ("status", status),
            ("totals", totals),
            ("directories", dirs),
            ("removedIgnoredAudit", audit),
            ("orphans", orphans),
        ],
    )?
    .raw())
}
