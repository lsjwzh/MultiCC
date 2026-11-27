use crate::route_response::*;
use multicc_core::js::JsString;
use napi_derive::napi;

fn strip<'a>(s: &'a [u16], prefix: &str) -> Option<&'a [u16]> {
    (s.len() >= prefix.len()
        && s.iter()
            .zip(prefix.bytes())
            .all(|(&a, b)| a == u16::from(b)))
    .then(|| &s[prefix.len()..])
}
#[napi]
pub fn parse_orphan_worktrees(env: Env, source: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, source);
    let raw = p.coerce_string()?;
    let rows = p.from_value(&V::Array(vec![]))?;
    let mut current = None;
    for line in raw.as_units().split(|&c| c == 10) {
        if let Some(path) = strip(line, "worktree ") {
            let row = fields(
                p,
                &[
                    (
                        "path",
                        p.from_value(&V::String(JsString::from_units(path.to_vec()).trim()))?,
                    ),
                    ("branch", null(p)?),
                    ("detached", flag(p, false)?),
                ],
            )?;
            call(rows, c"push", &[row])?;
            current = Some(row);
        } else if let Some(row) = current {
            if let Some(branch) = strip(line, "branch ") {
                let name = JsString::from_units(branch.to_vec()).trim();
                let name = strip(name.as_units(), "refs/heads/").unwrap_or(name.as_units());
                row.set(
                    c"branch",
                    p.from_value(&V::String(JsString::from_units(name.to_vec())))?,
                )?;
            } else if JsString::from_units(line.to_vec()).trim() == "detached" {
                row.set(c"detached", flag(p, true)?)?
            }
        }
    }
    Ok(rows.raw())
}
#[napi]
pub fn declared_orphan_paths(
    env: Env,
    records: Unknown<'_>,
    task_paths: Unknown<'_>,
    canon: Unknown<'_>,
) -> Result<sys::napi_value> {
    let records = L::new(&env, records);
    let canon = L::new(&env, canon);
    let set = records.global()?.get(c"Set")?.construct(&[])?;
    let add = |path: L<'_>| -> Result<()> {
        call(set, c"add", &[canon.call_plain(&[path])?])?;
        Ok(())
    };
    call(records, c"values", &[])?.for_each(|record| {
        if record.optional(c"worktreePath")?.truthy()? {
            add(record.get(c"worktreePath")?)?;
        }
        let retired = record.optional(c"retiredWorktrees")?;
        if retired.truthy()? {
            retired.for_each(|r| {
                if r.optional(c"worktreePath")?.truthy()? {
                    add(r.get(c"worktreePath")?)?;
                }
                Ok(())
            })?;
        }
        Ok(())
    })?;
    let paths = L::new(&env, task_paths).call_plain(&[])?;
    if paths.truthy()? {
        paths.for_each(|path| if path.truthy()? { add(path) } else { Ok(()) })?;
    }
    Ok(set.raw())
}
#[napi]
pub fn orphan_candidates(
    env: Env,
    entries: Unknown<'_>,
    root: Unknown<'_>,
    claimed: Unknown<'_>,
    canon: Unknown<'_>,
) -> Result<sys::napi_value> {
    // Predicate is evaluated lazily by the host between asynchronous git calls.
    let p = L::new(&env, entries);
    let path = p.get(c"path")?;
    Ok(flag(
        p,
        call(path, c"startsWith", &[L::new(&env, root)])?.truthy()?
            && !call(
                L::new(&env, claimed),
                c"has",
                &[L::new(&env, canon).call_plain(&[path])?],
            )?
            .truthy()?,
    )?
    .raw())
}
#[napi]
pub fn orphan_removable(dirty: bool, ahead: f64) -> bool {
    !dirty && !(ahead > 0.)
}
#[napi]
pub fn orphan_report(
    env: Env,
    at: Unknown<'_>,
    delete: Unknown<'_>,
    rows: Unknown<'_>,
) -> Result<sys::napi_value> {
    let rows = L::new(&env, rows);
    let mut removed = 0.;
    rows.for_each(|row| {
        if row.get(c"removed")?.truthy()? {
            removed += 1.;
        }
        Ok(())
    })?;
    Ok(fields(
        rows,
        &[
            ("at", L::new(&env, at)),
            ("deleteOrphans", L::new(&env, delete)),
            ("total", rows.get(c"length")?),
            ("removed", num(rows, removed)?),
            ("orphans", rows),
        ],
    )?
    .freeze()?
    .raw())
}

use crate::host_methods::{arg, async_result, env as host_env, function, raw};

/// The actor owns git serialization. The scanner owns its flight, report and
/// cancellable timers, with all JS references traced by the same V8 instance.
#[napi]
pub fn worktree_orphan_scanner(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    for key in [c"records", c"directories"] {
        if !p.get(key)?.instance_of(p.global()?.get(c"Map")?)? {
            return Err(p.type_error("orphan scan requires record and directory maps"));
        }
    }
    if p.get(c"repoActor")?.optional(c"run")?.kind()? != sys::ValueType::napi_function {
        return Err(p.type_error("orphan scan requires a repo actor"));
    }
    let timers = p.from_value(&V::Array(vec![]))?;
    let state = fields(
        p,
        &[
            ("p", p),
            ("timers", timers),
            ("stopped", flag(p, false)?),
            ("report", null(p)?),
            ("flight", null(p)?),
        ],
    )?;
    let scan = function(state, "scan", 0, 0, |s, _| {
        async_result(s, || {
            let flight = s.get(c"flight")?;
            if flight.truthy()? {
                return Ok(flight);
            }
            let p = s.get(c"p")?;
            // Create the async frame before invoking task-path getters, so even
            // synchronous failures are released by finally on the same flight.
            let run = async_result(s, || {
                let claimed = raw(
                    p,
                    declared_orphan_paths(
                        host_env(p),
                        arg(p.get(c"records")?)?,
                        arg(p.get(c"listTaskWorktreePaths")?)?,
                        arg(p.get(c"canon")?)?,
                    )?,
                );
                let finish = function(s, "finish", 1, 1, |s, a| {
                    let p = s.get(c"p")?;
                    let report = raw(
                        p,
                        orphan_report(
                            host_env(p),
                            arg(call(p, c"stamp", &[])?)?,
                            arg(p.get(c"deleteOrphans")?)?,
                            arg(a[0])?,
                        )?,
                    );
                    s.set(c"report", report)?;
                    let count = a[0].get(c"length")?;
                    if count.truthy()? {
                        call(
                            p,
                            c"warn",
                            &[
                                text(p, "worktree_orphans_found")?,
                                fields(
                                    p,
                                    &[("count", count), ("removed", report.get(c"removed")?)],
                                )?,
                            ],
                        )?;
                    }
                    Ok(report)
                })?;
                call(p, c"collect", &[claimed, finish])
            })?;
            let release = function(s, "", 0, 0, |s, _| {
                s.set(c"flight", null(s)?)?;
                s.from_value(&V::Undefined)
            })?;
            let promise = call(run, c"finally", &[release])?;
            s.set(c"flight", promise)?;
            Ok(promise)
        })
    })?;
    state.set(c"scan", scan)?;
    let start = function(state, "start", 0, 0, |s, _| {
        let timers = s.get(c"timers")?;
        if s.get(c"stopped")?.truthy()? || timers.get(c"length")?.truthy()? {
            return flag(s, false);
        }
        let p = s.get(c"p")?;
        for (schedule, delay) in [
            (c"setTimeoutFn", c"startupDelayMs"),
            (c"setIntervalFn", c"intervalMs"),
        ] {
            let tick = call(p, c"tick", &[s.get(c"scan")?])?;
            let timer = p.get(schedule)?.call_plain(&[tick, p.get(delay)?])?;
            call(timers, c"push", &[timer])?;
        }
        timers.for_each(|timer| {
            let unref = timer.optional(c"unref")?;
            if !unref.nullish()? {
                unref.call(timer, &[])?;
            }
            Ok(())
        })?;
        flag(s, true)
    })?;
    let stop = function(state, "stop", 0, 0, |s, _| {
        s.set(c"stopped", flag(s, true)?)?;
        let timers = s.get(c"timers")?;
        timers.for_each(|timer| {
            call(s.get(c"p")?, c"clear", &[timer])?;
            Ok(())
        })?;
        timers.assign(c"length", num(s, 0.)?)?;
        s.from_value(&V::Undefined)
    })?;
    let report = function(state, "report", 0, 0, |s, _| s.get(c"report"))?;
    Ok(fields(
        p,
        &[
            ("scan", scan),
            ("start", start),
            ("stop", stop),
            ("report", report),
        ],
    )?
    .freeze()?
    .raw())
}
