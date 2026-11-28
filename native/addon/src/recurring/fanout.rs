use super::*;
use multicc_core::{cron_fanout as core, js};
use napi_derive::napi;
use std::path::{Path, PathBuf};
fn encoded(v: &V) -> Result<String> {
    js::json_stringify(v).ok_or_else(|| napi::Error::from_reason("invalid migration value"))
}
fn path(v: L<'_>) -> Result<PathBuf> {
    Ok(PathBuf::from(strval(v)?))
}
fn default<'a>(v: L<'a>, d: L<'a>) -> Result<L<'a>> {
    Ok(if v.undefined()? { d } else { v })
}
fn summary(f: L<'_>) -> Result<L<'_>> {
    f.get(c"summary")
}
fn report_text(s: &V) -> String {
    let get = |k| core::prop(s, k);
    let string = |k| js::js_to_string(get(k)).to_string_lossy();
    if get("status") == &V::from("already_applied") {
        let when = if js::truthy(get("appliedAt")) {
            js::date_to_iso_string(js::js_to_number(get("appliedAt")))
                .map(|v| format!(" on {}", v))
                .unwrap_or_default()
        } else {
            String::new()
        };
        return format!("Cron task fan-out cleanup: already applied{when}; nothing to do.\n");
    }
    let origin = if js::truthy(get("fromVersion")) {
        format!("upgraded from {}", string("fromVersion"))
    } else {
        "version unknown".into()
    };
    let failures = match get("failures") {
        V::Array(a) => a.len(),
        _ => 0,
    };
    let mut text=format!("Cron task fan-out cleanup ({origin}): archived {} stale scheduled-task copy/copies from {} rule(s), {failures} skipped.\n",string("archivedCount"),string("ruleCount"));
    if get("status") == &V::from("archive_unavailable") {
        text.push_str(
            "  Task board archive port unavailable; the pass will retry on the next start.\n",
        );
    }
    if let V::Object(rows) = get("byRule") {
        for (id, v) in rows.iter().take(10) {
            text.push_str(&format!(
                "  - {} {}: {}\n",
                id.to_string_lossy(),
                js::js_to_string(core::prop(v, "name")),
                js::js_to_string(core::prop(v, "count"))
            ));
        }
    }
    text
}
fn write_report(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    opts.open(path)?.write_all(text.as_bytes())
}
fn finish<'a>(f: L<'a>, applied: Option<bool>, report: bool, remove: bool) -> Result<L<'a>> {
    let s = summary(f)?;
    let report_file = path(f.get(c"report")?)?;
    let marker = path(f.get(c"marker")?)?;
    let body = if let Some(applied) = applied {
        let m = spread(s)?;
        // The refused-overflow marker has a distinct on-disk field order.
        let at = f.get(c"startedAt")?;
        let applied_flag = flag(f, applied)?;
        let fields = if applied {
            [(c"applied", applied_flag), (c"appliedAt", at)]
        } else {
            [(c"appliedAt", at), (c"applied", applied_flag)]
        };
        for (key, value) in fields {
            m.set(key, value)?;
        }
        Some(strval(call(
            f.global()?.get(c"JSON")?,
            c"stringify",
            &[m, null(f)?, num(f, 2.)?],
        )?)?)
    } else {
        None
    };
    let report_body = if report {
        Some(report_text(&value(s)?))
    } else {
        None
    };
    let remove_first = remove && !s.get(c"status")?.is_string("refused_overflow")?;
    let job = work(f, move || {
        let mut failures = Vec::new();
        if remove_first {
            let _ = std::fs::remove_file(&report_file);
        }
        if let Some(body) = &body {
            if let Err(e) = multicc_core::state_file::write_bytes_atomic_traced(
                &marker,
                body.as_bytes(),
                0o600,
                0o700,
            ) {
                failures.push(serde_json::json!(["marker", e.error.to_string()]));
            }
        }
        if remove && !remove_first {
            let _ = std::fs::remove_file(&report_file);
        }
        if let Some(body) = &report_body {
            if let Err(e) = write_report(&report_file, body) {
                failures.push(serde_json::json!(["report", e.to_string()]));
            }
        }
        Ok(serde_json::Value::Array(failures).to_string())
    })?;
    then(job, f, |f, v| {
        let failures = json_parse(f, &strval(v)?)?;
        failures.for_each(|row| {
            let kind = strval(row.element(0)?)?;
            let target = if kind == "marker" {
                f.get(c"owner")?.get(c"logger")?
            } else {
                f.get(c"logger")?
            };
            call(
                target,
                c"error",
                &[
                    text(
                        f,
                        &format!("[multicc/cron] fan-out cleanup {kind} write failed:"),
                    )?,
                    row.element(1)?,
                ],
            )?;
            Ok(())
        })?;
        Ok(summary(f)?)
    })
}
fn after_archive<'a>(f: L<'a>, outcome: L<'a>) -> Result<L<'a>> {
    let outcome = either(
        outcome,
        fields(f, &[("archived", array(f)?), ("skipped", array(f)?)])?,
    )?;
    let s = summary(f)?;
    let archived = either(outcome.get(c"archived")?, array(f)?)?;
    s.set(c"archived", archived)?;
    s.set(c"archivedCount", archived.get(c"length")?)?;
    s.set(c"failures", either(outcome.get(c"skipped")?, array(f)?)?)?;
    let status = if !f.get(c"ids")?.get(c"length")?.truthy()? {
        "no_residue"
    } else if archived.get(c"length")?.truthy()? {
        "archived"
    } else {
        "archive_failed"
    };
    s.set(c"status", text(f, status)?)?;
    then(finish(f, Some(true), true, false)?, f, |f, v| {
        let s = summary(f)?;
        let suffix = if s.get(c"failures")?.get(c"length")?.truthy()? {
            format!(", {} skipped", strval(s.get(c"failures")?.get(c"length")?)?)
        } else {
            String::new()
        };
        logger(f,c"log",&[text(f,&format!("[multicc/cron] fan-out cleanup {}: archived {} of {} candidate(s) across {} rule(s){suffix}",strval(s.get(c"status")?)?,strval(s.get(c"archivedCount")?)?,strval(f.get(c"ids")?.get(c"length")?)?,strval(s.get(c"ruleCount")?)?))?])?;
        Ok(v)
    })
}
fn selected<'a>(f: L<'a>, raw: L<'a>) -> Result<L<'a>> {
    let selected = json_parse(f, &strval(raw)?)?;
    let s = summary(f)?;
    if selected.get(c"overflow")?.truthy()? {
        s.set(c"status", text(f, "refused_overflow")?)?;
        s.set(
            c"error",
            text(f, "more than 5000 candidates — refusing to archive")?,
        )?;
        logger(
            f,
            c"error",
            &[text(
                f,
                "[multicc/cron] fan-out cleanup more than 5000 candidates — refusing to archive",
            )?],
        )?;
        return finish(f, Some(false), false, true);
    }
    let ids = array(f)?;
    let by_rule = fields(f, &[])?;
    selected.get(c"archive")?.for_each(|entry| {
        append(ids, entry.get(c"taskId")?)?;
        let id = entry.get(c"ruleId")?;
        let current = by_rule.get_key(id)?;
        let row = if current.truthy()? {
            current
        } else {
            let row = fields(
                f,
                &[("name", entry.get(c"ruleName")?), ("count", num(f, 0.)?)],
            )?;
            by_rule.set_key(id, row)?;
            row
        };
        row.set(c"count", num(f, row.get(c"count")?.number()? + 1.)?)?;
        Ok(())
    })?;
    s.set(c"byRule", by_rule)?;
    s.set(
        c"ruleCount",
        call(f.global()?.get(c"Object")?, c"keys", &[by_rule])?.get(c"length")?,
    )?;
    f.set(c"ids", ids)?;
    if ids.get(c"length")?.number()? == 0. {
        return after_archive(
            f,
            fields(f, &[("archived", array(f)?), ("skipped", array(f)?)])?,
        );
    }
    let archive = f.get(c"options")?.get(c"archiveTasks")?;
    if archive.kind()? != sys::ValueType::napi_function {
        s.set(c"status", text(f, "archive_unavailable")?)?;
        s.set(c"error", text(f, "task board archive port is unavailable")?)?;
        let failures = array(f)?;
        ids.for_each(|id| {
            append(
                failures,
                fields(
                    f,
                    &[
                        ("taskId", id),
                        ("error", text(f, "archive_port_unavailable")?),
                    ],
                )?,
            )
        })?;
        s.set(c"failures", failures)?;
        logger(
            f,
            c"error",
            &[
                text(f, "[multicc/cron] fan-out cleanup could not archive:")?,
                s.get(c"error")?,
            ],
        )?;
        return finish(f, None, true, false);
    }
    then(
        async_result(f, || archive.call_plain(&[ids]))?,
        f,
        after_archive,
    )
}
fn evidence<'a>(f: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let s = summary(f)?;
    s.set(c"fromVersion", v.get(c"fromVersion")?)?;
    s.set(c"versionEvidence", v.get(c"source")?)?;
    if core::affected(&value(v.get(c"fromVersion")?)?) == Some(false) {
        s.set(c"status", text(f, "version_not_affected")?)?;
        return then(finish(f, Some(true), false, true)?, f, |f, v| {
            logger(
                f,
                c"log",
                &[text(
                    f,
                    &format!(
                        "[multicc/cron] fan-out cleanup skipped: data comes from {} (> 2.0.2)",
                        strval(summary(f)?.get(c"fromVersion")?)?
                    ),
                )?],
            )?;
            Ok(v)
        });
    }
    let tasks = value(default(f.get(c"options")?.get(c"tasks")?, array(f)?)?)?;
    let rules = value(default(f.get(c"options")?.get(c"rules")?, array(f)?)?)?;
    let job = work(f, move || {
        encoded(&core::collect(&tasks, &rules).map_err(napi::Error::from_reason)?)
    })?;
    then(job, f, selected)
}
fn after_marker<'a>(f: L<'a>, raw: L<'a>) -> Result<L<'a>> {
    let applied = json_parse(f, &strval(raw)?)?;
    let opts = f.get(c"options")?;
    if applied.optional(c"applied")?.truthy()? && !opts.get(c"force")?.truthy()? {
        summary(f)?.set(c"status", text(f, "already_applied")?)?;
        summary(f)?.set(c"appliedAt", either(applied.get(c"appliedAt")?, null(f)?)?)?;
        return finish(f, None, true, false);
    }
    if !opts.get(c"fromVersion")?.undefined()? {
        return evidence(
            f,
            fields(
                f,
                &[
                    ("fromVersion", opts.get(c"fromVersion")?),
                    (
                        "source",
                        either(opts.get(c"versionSource")?, text(f, "injected")?)?,
                    ),
                ],
            )?,
        );
    }
    if !opts.get(c"readEvidence")?.undefined()? {
        let v = opts
            .get(c"readEvidence")?
            .call_plain(&[f.get(c"pkgRoot")?, opts.get(c"dataDir")?])?;
        return evidence(f, v);
    }
    let pkg = path(f.get(c"pkgRoot")?)?;
    let data = path(opts.get(c"dataDir")?)?;
    then(
        work(f, move || encoded(&core::evidence(&pkg, Some(&data))))?,
        f,
        |f, v| evidence(f, json_parse(f, &strval(v)?)?),
    )
}
fn run<'a>(owner: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = default_object(options)?;
    let started = if options.get(c"now")?.undefined()? {
        now(owner)?
    } else {
        options.get(c"now")?.call_plain(&[])?
    };
    let s = fields(
        owner,
        &[
            ("ok", flag(owner, true)?),
            ("migration", text(owner, core::MIGRATION_ID)?),
            ("schemaVersion", num(owner, 1.)?),
            ("status", text(owner, "noop")?),
            ("at", iso(owner, started)?),
            (
                "appVersion",
                default(options.get(c"version")?, null(owner)?)?,
            ),
            ("fromVersion", null(owner)?),
            ("versionEvidence", text(owner, "unknown")?),
            ("ruleCount", num(owner, 0.)?),
            ("archivedCount", num(owner, 0.)?),
            ("byRule", fields(owner, &[])?),
            ("archived", array(owner)?),
            ("failures", array(owner)?),
            ("error", null(owner)?),
        ],
    )?;
    let f = fields(
        owner,
        &[
            ("owner", owner),
            ("options", options),
            ("summary", s),
            ("startedAt", started),
            (
                "logger",
                default(options.get(c"logger")?, owner.get(c"logger")?)?,
            ),
        ],
    )?;
    let operation = async_result(f, || {
        if !options.get(c"dataDir")?.truthy()? {
            return Err(failure(f, "", "dataDir is required")?);
        }
        let pkg = default(options.get(c"pkgRoot")?, owner.get(c"pkgRoot")?)?;
        f.set(c"pkgRoot", pkg)?;
        let marker = either(
            options.get(c"markerFile")?,
            text(
                f,
                &path(options.get(c"dataDir")?)?
                    .join("cron_fanout_migration.json")
                    .to_string_lossy(),
            )?,
        )?;
        f.set(c"marker", marker)?;
        f.set(
            c"report",
            either(
                options.get(c"reportFile")?,
                text(
                    f,
                    &path(pkg)?
                        .join("logs/cron-fanout-cleanup.log")
                        .to_string_lossy(),
                )?,
            )?,
        )?;
        let marker = path(marker)?;
        then(
            work(f, move || {
                let applied = std::fs::read(&marker)
                    .ok()
                    .and_then(|b| js::json_parse(&String::from_utf8_lossy(&b)).ok())
                    .filter(|v| matches!(v, V::Object(_) | V::Array(_)))
                    .unwrap_or(V::Null);
                encoded(&applied)
            })?,
            f,
            after_marker,
        )
    })?;
    caught(operation, f, |f, e| {
        let s = summary(f)?;
        s.set(c"ok", flag(f, false)?)?;
        s.set(c"error", message(e)?)?;
        logger(
            f,
            c"error",
            &[
                text(f, "[multicc/cron] fan-out cleanup failed:")?,
                s.get(c"error")?,
            ],
        )?;
        Ok(s)
    })
}
#[napi]
pub fn fanout_migration_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let owner = L::new(&env, ports);
    let api = fields(owner, &[])?;
    for (k, v) in [
        ("MIGRATION_ID", V::from(core::MIGRATION_ID)),
        ("SCHEMA_VERSION", V::Number(1.)),
        ("AFFECTED_CEILING", V::from("2.0.2")),
        ("MAX_CANDIDATES", V::Number(core::MAX_CANDIDATES as f64)),
    ] {
        api.set_key(text(owner, k)?, owner.from_value(&v)?)?;
    }
    for (name, length, count) in [
        ("collapse", 1, 1),
        ("parseVersion", 1, 1),
        ("compareVersions", 2, 2),
        ("mayContainResidue", 1, 1),
        ("readUpgradeEvidence", 0, 2),
        ("titleMatchesRule", 2, 2),
        ("collectResidue", 0, 2),
        ("run", 0, 1),
    ] {
        api.set_key(
            text(owner, name)?,
            function(owner, name, length, count, move |o, a| match name {
                "collapse" => o.from_value(&V::String(core::collapse(&value(a[0])?))),
                "parseVersion" => o.from_value(
                    &core::parse_version(&value(a[0])?)
                        .map(|a| V::Array(a.into_iter().map(V::Number).collect()))
                        .unwrap_or(V::Null),
                ),
                "compareVersions" => {
                    let left = [
                        a[0].element(0)?.number()?,
                        a[0].element(1)?.number()?,
                        a[0].element(2)?.number()?,
                    ];
                    let right = [
                        a[1].element(0)?.number()?,
                        a[1].element(1)?.number()?,
                        a[1].element(2)?.number()?,
                    ];
                    num(o, core::compare(left, right) as f64)
                }
                "mayContainResidue" => o.from_value(
                    &core::affected(&value(a[0])?)
                        .map(V::Bool)
                        .unwrap_or(V::Null),
                ),
                "titleMatchesRule" => o.from_value(
                    &core::title_match(&string(a[0])?.coerce_string()?, &value(a[1])?)
                        .map(V::from)
                        .unwrap_or(V::Null),
                ),
                "collectResidue" => o.from_value(
                    &core::collect(
                        &value(default(a[0], array(o)?)?)?,
                        &value(default(a[1], array(o)?)?)?,
                    )
                    .map_err(napi::Error::from_reason)?,
                ),
                "readUpgradeEvidence" => {
                    let pkg = path(default(a[0], o.get(c"pkgRoot")?)?)?;
                    let data = if a[1].truthy()? {
                        Some(path(a[1])?)
                    } else {
                        None
                    };
                    o.from_value(&core::evidence(&pkg, data.as_deref()))
                }
                "run" => async_result(o, || run(o, a[0])),
                _ => unreachable!(),
            })?,
        )?;
    }
    Ok(api.raw())
}
