use super::*;

const RETENTION: [&str; 6] = [
    "ENABLED",
    "TASK_DAYS",
    "OUTBOX_DAYS",
    "BATCH_SIZE",
    "MAX_RECORDS",
    "INTERVAL_MS",
];

pub(super) fn create<'a>(ports: L<'a>, options: L<'a>, deps: L<'a>) -> Result<L<'a>> {
    let o = default_object(options)?;
    let file = o.get(c"file")?;
    let legacy = or_default(o.get(c"legacyFile")?, null(o)?)?;
    let clock = or_default(o.get(c"now")?, o.global()?.get(c"Date")?.get(c"now")?)?;
    if !file.truthy()? || file.kind()? != sys::ValueType::napi_string {
        return Err(
            o.type_error("[orchestration-sqlite-store] create requires an injected { file }")
        );
    }
    if !is_func(clock)? {
        return Err(o.type_error("[orchestration-sqlite-store] now must be a function"));
    }
    let hooks = default_object(o.get(c"hooks")?)?;
    let s = fields(
        o,
        &[
            ("ports", ports),
            ("deps", deps),
            ("file", file),
            ("legacyFile", legacy),
            ("now", clock),
            ("hooks", hooks),
        ],
    )?;
    let native = ports.get(c"native")?;
    let owner = (|| {
        if !call(native, c"orchestrationStoreProtocol", &[])?.is_number(11.)? {
            return Err(deps
                .get(c"OrchestrationSqliteError")?
                .construct(&[
                    text(s, "编排原生模块版本不匹配，请重新构建 Rust 模块")?,
                    fields(s, &[("file", file)])?,
                ])?
                .throw_error());
        }
        let environment = s.global()?.get(c"process")?.get(c"env")?;
        let values = fields(s, &[])?;
        for suffix in RETENTION {
            let name = format!("MULTICC_ORCHESTRATION_RETENTION_{suffix}");
            set(values, &name, get(environment, &name)?)?;
        }
        let opts = fields(
            s,
            &[
                ("env", values),
                ("policy", default_object(o.get(c"retention")?)?),
            ],
        )?;
        let mut binary = o.get(c"ownerBinary")?;
        if !binary.truthy()? {
            let path = string_value(ports.get(c"addonPath")?.call_plain(&[])?)?;
            let companion = if cfg!(windows) {
                "multicc-gateway.exe"
            } else {
                "multicc-gateway"
            };
            binary = text(
                s,
                &std::path::Path::new(&path)
                    .with_file_name(companion)
                    .to_string_lossy(),
            )?;
        }
        native.get(c"RustIsolatedOrchestrationStore")?.construct(&[
            file,
            legacy,
            now(s)?,
            opts,
            binary,
        ])
    })()
    .map_err(|e| rethrow(s, e, |err| normalize(s, err)))?;
    s.set(c"handle", owner)?;
    let info = request(s, "info", fields(s, &[])?)?;
    s.set(c"metrics", request(s, "metrics", fields(s, &[])?)?)?;
    s.set(c"revision", info.get(c"state")?.get(c"revision")?)?;
    s.set(c"tail", resolve(undefined(s)?)?)?;
    s.set(c"queued", num(s, 0.)?)?;
    s.set(c"closed", flag(s, false)?)?;
    s.set(c"detached", flag(s, false)?)?;
    s.set(c"als", ports.get(c"AsyncLocalStorage")?.construct(&[])?)?;
    let api = fields(
        s,
        &[
            ("backend", text(s, "sqlite")?),
            ("file", file),
            ("legacyFile", legacy),
            ("migration", spread(info.get(c"migration")?)?.freeze()?),
        ],
    )?;
    transaction::install(s, api)?;
    state::install(s, api)?;
    schedule::install(s, api)?;
    if keys(hooks)?.get(c"length")?.is_number(0.)? {
        specialized::install(s, api)?
    }
    maintenance::install(s, api)?;
    api.freeze()
}
pub(super) fn normalize<'a>(s: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let msg = e.optional(c"message")?;
    let m = string_value(if msg.truthy()? { msg } else { e })?;
    let deps = s.get(c"deps")?;
    let file = s.get(c"file")?;
    if let Some(id) = m.strip_prefix("OUTBOX_PAYLOAD_CONFLICT:") {
        return s
            .get(c"ports")?
            .get(c"getOutboxConflictError")?
            .call_plain(&[])?
            .construct(&[text(s, id)?]);
    }
    if let Some(revs) = m.strip_prefix("ORCHESTRATION_SQLITE_CONFLICT:") {
        if let Some((a, b)) = revs.split_once(':') {
            if !a.is_empty()
                && !b.is_empty()
                && a.bytes().chain(b.bytes()).all(|x| x.is_ascii_digit())
            {
                return deps.get(c"OrchestrationSqliteConflictError")?.construct(&[
                    file,
                    num(s, a.parse().unwrap_or(f64::INFINITY))?,
                    num(s, b.parse().unwrap_or(f64::INFINITY))?,
                ]);
            }
        }
    }
    for (prefix, kind) in [
        (
            "ORCHESTRATION_STORE_CORRUPT:",
            c"OrchestrationStoreCorruptError",
        ),
        ("ORCHESTRATION_SQLITE_ERROR:", c"OrchestrationSqliteError"),
    ] {
        if let Some(detail) = m.strip_prefix(prefix) {
            return deps.get(kind)?.construct(&[
                text(s, detail)?,
                fields(s, &[("file", file), ("cause", e)])?,
            ]);
        }
    }
    if let Some(detail) = m.strip_prefix("ORCHESTRATION_TASK_ACTIVITY_INPUT:") {
        let err = error(s, detail)?;
        err.set(c"statusCode", num(s, 400.)?)?;
        return Ok(err);
    }
    if m == "OUTBOX_BACKOFF_INVALID" {
        return s.global()?.get(c"TypeError")?.construct(&[text(
            s,
            "[outbox] backoff must return a non-negative finite number",
        )?]);
    }
    Ok(e)
}
pub(super) fn ensure_open(s: L<'_>) -> Result<()> {
    if s.get(c"closed")?.truthy()? {
        let file = s.get(c"file")?;
        return Err(s
            .get(c"deps")?
            .get(c"OrchestrationSqliteError")?
            .construct(&[
                text(
                    s,
                    &format!("orchestration database is closed: {}", string_value(file)?),
                )?,
                fields(s, &[("file", file)])?,
            ])?
            .throw_error());
    }
    Ok(())
}
pub(super) fn parse_rows(rows: L<'_>) -> Result<L<'_>> {
    let out = array(rows, &[])?;
    for i in 0..rows.get(c"length")?.number()? as u32 {
        out.set_element(i, parse(rows.element(i)?)?)?
    }
    Ok(out)
}
pub(super) fn request<'a>(s: L<'a>, op: &str, input: L<'a>) -> Result<L<'a>> {
    (|| {
        let r = call(s.get(c"handle")?, c"request", &[text(s, op)?, input])?;
        if r.kind()? != sys::ValueType::napi_object {
            return Ok(r);
        }
        if has(r, "valueJson")? {
            r.set(c"value", parse(r.get(c"valueJson")?)?)?
        }
        if has(r, "keysJson")? {
            return parse(r.get(c"keysJson")?);
        }
        if op == "claimMetadata" {
            return fields(
                s,
                &[
                    ("keys", r.get(c"keys")?),
                    ("leasedKeys", r.get(c"leasedKeys")?),
                    ("rows", parse_rows(r.get(c"rowsJson")?)?),
                ],
            );
        }
        if has(r, "rowsJson")? {
            return parse_rows(r.get(c"rowsJson")?);
        }
        Ok(r)
    })()
    .map_err(|err| rethrow(s, err, |e| normalize(s, e)))
}
pub(super) fn refresh(s: L<'_>) {
    let r = (|| {
        s.set(c"metrics", request(s, "metrics", fields(s, &[])?)?)?;
        undefined(s)
    })();
    ignore(s, r)
}
pub(super) fn request_async<'a>(s: L<'a>, op: &str, input: L<'a>) -> Result<L<'a>> {
    async_transport(s, "requestAsync", op, input, None)
}
pub(super) fn async_transport<'a>(
    s: L<'a>,
    method: &str,
    op: &str,
    input: L<'a>,
    bytes: Option<L<'a>>,
) -> Result<L<'a>> {
    let mut args = vec![text(s, op)?, input];
    if let Some(b) = bytes {
        args.push(b)
    }
    let p = match call(s.get(c"handle")?, &key(method), &args) {
        Ok(value) => resolve(value)?,
        Err(err) => async_result(s, || Err(err))?,
    };
    let admission = bytes.is_some();
    let metrics = op != "close";
    let ok = cb(s, 1, move |s, a| {
        if admission && a[0].get(c"resultBuffer")?.truthy()? {
            a[0].set(
                c"resultJson",
                s.get(c"ports")?
                    .get(c"intrinsics")?
                    .get(c"encode")?
                    .call(a[0].get(c"resultBuffer")?, &[text(s, "utf8")?])?,
            )?;
        }
        if metrics {
            refresh(s)
        }
        Ok(a[0])
    })?;
    let bad = cb(s, 1, move |s, a| {
        let e = normalize(s, a[0])?;
        if metrics {
            refresh(s)
        }
        Err(e.throw_error())
    })?;
    call(p, c"then", &[ok, bad])
}
