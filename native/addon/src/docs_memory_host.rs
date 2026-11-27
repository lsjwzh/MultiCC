//! Internal host of the docs, memory, memo and directory-events routes. The
//! public gateway owns their wire schema. Keep injected objects live here.
use crate::{
    docs_registry::sanitize::absolute_href,
    host_methods::{async_result, default_object, function},
    route_response::*,
};
use napi_derive::napi;

const PATH: &str = "/api/__host/docs-memory";
fn object(v: L<'_>) -> Result<L<'_>> {
    if v.kind()? == sys::ValueType::napi_object && !v.is_array()? {
        Ok(v)
    } else {
        fields(v, &[])
    }
}
fn arr(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Array(vec![]))
}
fn now(p: L<'_>) -> Result<f64> {
    call(p.global()?.get(c"Date")?, c"now", &[])?.number()
}
fn plain<'a>(o: L<'a>, key: &std::ffi::CStr, a: &[L<'a>]) -> Result<L<'a>> {
    o.get(key)?.call_plain(a)
}
fn facts<'a>(p: L<'a>, items: L<'a>) -> Result<L<'a>> {
    let (session_dir, exists, title) = (arr(p)?, arr(p)?, arr(p)?);
    if items.is_array()? {
        items.for_each(|item| {
            let row = object(item)?;
            let dir = plain(p, c"resolveDir", &[row.get(c"sessionId")?])?;
            call(
                session_dir,
                c"push",
                &[if dir.undefined()? { null(p)? } else { dir }],
            )?;
            let present = if row.get(c"artifactId")?.truthy()? {
                plain(p, c"artifactExists", &[row.get(c"artifactId")?])?
            } else {
                null(p)?
            };
            call(exists, c"push", &[present])?;
            let name = if row.get(c"taskId")?.truthy()? {
                plain(p, c"resolveTaskTitle", &[row.get(c"taskId")?])?
            } else {
                null(p)?
            };
            call(title, c"push", &[name])?;
            Ok(())
        })?;
    }
    fields(
        p,
        &[
            ("sessionDir", session_dir),
            ("exists", exists),
            ("taskTitle", title),
        ],
    )
}
fn refusal<'a>(p: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let mapped = plain(p.get(c"ports")?, c"mapError", &[error])?;
    let refused = fields(
        p,
        &[
            ("status", mapped.get(c"status")?),
            ("code", mapped.get(c"code")?),
            ("message", mapped.get(c"message")?),
        ],
    )?;
    fields(p, &[("refused", refused)])
}
fn caught<'a>(p: L<'a>, e: napi::Error) -> Result<L<'a>> {
    match p.exception_value()? {
        Some(value) => Ok(value),
        None => p.global()?.get(c"Error")?.construct(&[text(p, &e.reason)?]),
    }
}
fn memo<'a>(p: L<'a>, body: L<'a>, op: &str) -> Result<L<'a>> {
    let run = || {
        let args = fields(p, &[("directoryId", string(body.get(c"directoryId")?)?)])?;
        if op != "memo-read" {
            args.set(c"text", body.get(c"text")?)?;
        }
        if op == "memo-send" {
            args.set(c"sessionId", body.get(c"sessionId")?)?;
        }
        let method = match op {
            "memo-read" => c"read",
            "memo-write" => c"write",
            _ => c"send",
        };
        call(p.get(c"memo")?, method, &[args])
    };
    if op == "memo-send" {
        let promise = async_result(p, run)?;
        let data = function(p, "", 1, 1, |p, a| fields(p, &[("data", a[0])]))?;
        let error = function(p, "", 1, 1, |p, a| refusal(p, a[0]))?;
        call(promise, c"then", &[data, error])
    } else {
        match run() {
            Ok(data) => fields(p, &[("data", data)]),
            Err(e) => refusal(p, caught(p, e)?),
        }
    }
}
fn graph<'a>(p: L<'a>, body: L<'a>, tree: bool) -> Result<L<'a>> {
    let started = now(p)?;
    let memory = p.get(c"memory")?;
    let (sync, asynchronous, label) = if tree {
        (c"buildMemoryTree", c"buildMemoryTreeAsync", "tree build")
    } else {
        (c"buildMemoryGraph", c"buildMemoryGraphAsync", "graph build")
    };
    let run = || {
        let method = memory.get(asynchronous)?;
        let args = if tree {
            vec![]
        } else {
            vec![string(body.get(c"dirId")?)?]
        };
        if method.kind()? == sys::ValueType::napi_function {
            method.call(memory, &args)
        } else {
            call(memory, sync, &args)
        }
    };
    let resolved = async_result(p, run)?;
    let data = function(p, "", 1, 1, move |p, a| {
        fields(
            p,
            &[("data", a[0]), ("durationMs", num(p, now(p)? - started)?)],
        )
    })?;
    let error = function(p, "", 1, 1, move |p, a| {
        let safe = crate::memory_browser::public_failure(text(p, label)?, a[0])?;
        fields(p, &[("error", safe)])
    })?;
    call(resolved, c"then", &[data, error])
}
fn invoke<'a>(p: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let docs = p.get(c"docs")?;
    let op = body
        .get(c"op")?
        .string()?
        .unwrap_or_default()
        .to_string_lossy();
    match op.as_str() {
        "docs-list" => {
            let entries = call(docs, c"entriesSnapshot", &[])?;
            let order = call(docs, c"viewSortOrder", &[])?;
            let result = fields(p, &[("entries", entries), ("order", order)])?;
            if docs.get(c"retainedIdsAsync")?.truthy()? {
                let promise = async_result(p, || call(docs, c"retainedIdsAsync", &[entries]))?;
                let done = function(result, "", 1, 1, |r, a| {
                    r.set(c"retained", a[0])?;
                    Ok(r)
                })?;
                call(promise, c"then", &[done])
            } else {
                result.set(c"retained", call(docs, c"retainedIds", &[])?)?;
                Ok(result)
            }
        }
        "docs-facts" => facts(p, body.get(c"items")?),
        "docs-get" => {
            let entry = call(docs, c"entryById", &[string(body.get(c"id")?)?])?;
            fields(p, &[("found", flag(p, entry.truthy()?)?), ("entry", entry)])
        }
        "docs-replace" => fields(
            p,
            &[(
                "found",
                call(
                    docs,
                    c"replaceEntryById",
                    &[string(body.get(c"id")?)?, object(body.get(c"entry")?)?],
                )?,
            )],
        ),
        "docs-delete" | "docs-start" | "docs-stop" | "docs-log" => {
            let method = match op.as_str() {
                "docs-delete" => c"removeEntryById",
                "docs-start" => c"startService",
                "docs-stop" => c"stopService",
                _ => c"serviceLog",
            };
            call(docs, method, &[string(body.get(c"id")?)?])
        }
        "docs-register" => {
            let method = if docs.get(c"registerEntryAsync")?.truthy()? {
                c"registerEntryAsync"
            } else {
                c"registerEntry"
            };
            call(docs, method, &[object(body.get(c"entry")?)?])
        }
        "docs-probe-kick" => {
            let task = call(docs, c"probeAllServices", &[])?;
            call(
                task,
                c"catch",
                &[function(p, "", 0, 0, |p, _| p.from_value(&V::Undefined))?],
            )?;
            fields(p, &[])
        }
        "docs-task-id" => fields(
            p,
            &[(
                "taskId",
                plain(p, c"resolveTaskId", &[body.get(c"sessionId")?])?,
            )],
        ),
        "docs-dir" => fields(
            p,
            &[("dir", plain(p, c"resolveDir", &[body.get(c"sessionId")?])?)],
        ),
        "docs-clean-url" => {
            let url = body.get(c"url")?;
            fields(
                p,
                &[(
                    "href",
                    if url.kind()? == sys::ValueType::napi_string {
                        absolute_href(url)?
                    } else {
                        null(p)?
                    },
                )],
            )
        }
        "memory-graph" | "memory-tree" => graph(p, body, op == "memory-tree"),
        "memory-resolve" | "memory-read" | "memory-write" | "memory-delete" => {
            let method = match op.as_str() {
                "memory-resolve" => c"pathFacts",
                "memory-read" => c"readMemoryFile",
                "memory-write" => c"writeMemoryFile",
                _ => c"deleteMemoryFile",
            };
            let mut args = vec![string(body.get(c"rel")?)?];
            if op == "memory-write" {
                args.push(string(body.get(c"content")?)?);
            }
            call(p.get(c"memory")?, method, &args)
        }
        "memo-read" | "memo-write" | "memo-send" => memo(p, body, &op),
        "notes-events" => {
            let directories = p.get(c"directories")?;
            let dir = if directories.truthy()? {
                call(directories, c"get", &[string(body.get(c"directoryId")?)?])?
            } else {
                null(p)?
            };
            let found = dir.truthy()?;
            fields(
                p,
                &[
                    ("found", flag(p, found)?),
                    (
                        "events",
                        if found {
                            call(p.get(c"notes")?, c"recentEvents", &[dir.get(c"id")?])?
                        } else {
                            arr(p)?
                        },
                    ),
                ],
            )
        }
        _ => p.get(c"ports")?.get(c"unknown"),
    }
}
fn route<'a>(p: L<'a>, req: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let deps = p.get(c"deps")?;
    let local = deps.get(c"isLocal")?;
    let local = if local.kind()? == sys::ValueType::napi_function {
        deps.get(c"isLocal")?
    } else {
        p.get(c"ports")?.get(c"isLocalRequest")?
    };
    if !local.call_plain(&[req])?.truthy()? {
        return error(res, 404, "not found", false);
    }
    let ctx = fields(
        p,
        &[
            ("host", p),
            ("body", object(req.get(c"body")?)?),
            ("res", res),
        ],
    )?;
    let promise = call(p.global()?.get(c"Promise")?, c"resolve", &[])?;
    let work = call(
        promise,
        c"then",
        &[function(ctx, "", 0, 0, |s, _| {
            invoke(s.get(c"host")?, s.get(c"body")?)
        })?],
    )?;
    let ok = function(ctx, "", 1, 1, |s, a| {
        let res = s.get(c"res")?;
        if a[0].equals(s.get(c"host")?.get(c"ports")?.get(c"unknown")?)? {
            return error(res, 400, "unknown host operation", false);
        }
        send(
            res,
            None,
            fields(
                res,
                &[
                    ("ok", flag(res, true)?),
                    ("value", if a[0].undefined()? { null(res)? } else { a[0] }),
                ],
            )?,
        )
    })?;
    let failed = function(ctx, "", 1, 1, |s, a| {
        let logger = s.get(c"host")?.get(c"logger")?;
        let report = logger.optional(c"error")?;
        if !report.nullish()? {
            report.call(
                logger,
                &[
                    text(s, "[docs-memory-host] operation failed")?,
                    s.get(c"body")?.get(c"op")?,
                    a[0],
                ],
            )?;
        }
        error(s.get(c"res")?, 500, "host operation failed", false)
    })?;
    call(work, c"then", &[ok, failed])
}
fn mount<'a>(p: L<'a>, app: L<'a>) -> Result<L<'a>> {
    let handler = function(p, "", 2, 2, |p, a| route(p, a[0], a[1]))?;
    call(app, c"post", &[text(p, PATH)?, handler])?;
    call(p.get(c"docs")?, c"startProbeLoop", &[])?;
    p.from_value(&V::Undefined)
}
fn create<'a>(ports: L<'a>, deps: L<'a>) -> Result<L<'a>> {
    let deps = default_object(deps)?;
    let logger = deps.get(c"logger")?;
    let logger = if logger.truthy()? {
        logger
    } else {
        ports.global()?.get(c"console")?
    };
    let docs = deps.get(c"docs")?;
    let docs = if docs.truthy()? {
        docs
    } else {
        plain(ports, c"docs", &[])?
    };
    let p = fields(
        ports,
        &[
            ("ports", ports),
            ("deps", deps),
            ("logger", logger),
            ("docs", docs),
            ("memory", deps.get(c"memory")?),
            ("memo", deps.get(c"memo")?),
            ("notes", deps.get(c"notes")?),
            ("directories", deps.get(c"directories")?),
        ],
    )?;
    if !p.get(c"notes")?.truthy()? {
        p.set(c"notes", fields(p, &[])?)?;
    }
    let exists = deps.get(c"artifactExists")?;
    p.set(
        c"artifactExists",
        if exists.kind()? == sys::ValueType::napi_function {
            deps.get(c"artifactExists")?
        } else {
            call(docs, c"defaultArtifactExists", &[])?
        },
    )?;
    for key in [c"resolveTaskId", c"resolveTaskTitle", c"resolveDir"] {
        let callback = deps.get(key)?;
        p.set(
            key,
            if callback.kind()? == sys::ValueType::napi_function {
                deps.get(key)?
            } else {
                function(ports, "", 0, 0, |p, _| null(p))?
            },
        )?;
    }
    fields(
        p,
        &[
            (
                "handle",
                function(p, "handle", 1, 1, |p, a| {
                    async_result(p, || invoke(p, object(a[0])?))
                })?,
            ),
            ("mount", function(p, "mount", 1, 1, |p, a| mount(p, a[0]))?),
        ],
    )
}
#[napi]
pub fn docs_memory_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(
        c"unknown",
        p.global()?
            .get(c"Symbol")?
            .call_plain(&[text(p, "unknown")?])?,
    )?;
    Ok(fields(
        p,
        &[
            ("HOST_PATH", text(p, PATH)?),
            (
                "createDocsMemoryHost",
                function(p, "createDocsMemoryHost", 0, 1, |p, a| create(p, a[0]))?,
            ),
            (
                "mountDocsMemoryHostRoute",
                function(p, "mountDocsMemoryHostRoute", 1, 2, |p, a| {
                    call(create(p, a[1])?, c"mount", &[a[0]])
                })?,
            ),
        ],
    )?
    .raw())
}
