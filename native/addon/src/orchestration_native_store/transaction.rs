use super::*;
use crate::host_methods::{arg, env, raw, variadic_method};
fn deps<'a>(s: L<'a>, k: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    s.get(c"deps")?.get(k)?.call_plain(args)
}
fn with_ctx<'a>(f: L<'a>, callback: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let mut p = vec![f.get(c"context")?, callback];
    p.extend_from_slice(args);
    call(f.get(c"s")?.get(c"als")?, c"run", &p)
}
fn begin<'a>(f: L<'a>, read_only: bool) -> Result<()> {
    let s = f.get(c"s")?;
    ensure_open(s)?;
    f.set(c"expected", s.get(c"revision")?)?;
    let opts = if read_only {
        fields(s, &[("readOnly", flag(s, true)?)])?
    } else {
        fields(s, &[])?
    };
    let row = request(s, "beginTrackedDraft", opts)?;
    let token = row.get(c"token")?;
    f.set(c"row", row)?;
    f.set(
        c"view",
        view::create(s, row.get(c"state")?, null(s)?, token)?,
    )?;
    f.set(
        c"context",
        fields(
            s,
            &[
                ("token", token),
                ("detached", flag(s, false)?),
                ("tracked", flag(s, true)?),
            ],
        )?,
    )?;
    Ok(())
}
fn setup_cow<'a>(f: L<'a>, claim: L<'a>) -> Result<L<'a>> {
    let v = f.get(c"view")?;
    let ports = fields(
        v,
        &[
            ("materialize", v.get(c"materialize")?),
            ("query", v.get(c"query")?),
        ],
    )?;
    if !claim.undefined()? {
        ports.set(c"claimMetadata", claim)?
    }
    let cow = deps(f.get(c"s")?, c"createDraft", &[v.get(c"root")?, ports])?;
    f.set(c"cow", cow)?;
    Ok(cow)
}
fn finish_cow(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    call(
        f.get(c"cow")?,
        c"finish",
        &[fields(f, &[("now", s.get(c"now")?)])?],
    )
}
fn collect_changes<'a>(f: L<'a>, change: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let items = array(f, &[])?;
    let persisted = change.get(c"persisted")?;
    let coll = persisted.get(c"collections")?;
    let collections = s.get(c"deps")?.get(c"COLLECTIONS")?;
    let visit = |name, map: L<'_>| -> Result<()> {
        map.for_each(|pair| {
            let e = pair.element(1)?;
            let row = fields(
                f,
                &[
                    ("collection", name),
                    ("key", pair.element(0)?),
                    ("deleted", e.get(c"deleted")?),
                    ("value", e.get(c"value")?),
                ],
            )?;
            items.set_element(items.get(c"length")?.number()? as u32, row)
        })
    };
    collections.for_each(|name| visit(name, coll.get_key(name)?))?;
    visit(text(f, "extras")?, persisted.get(c"extras")?)?;
    Ok(items)
}
fn hook(s: L<'_>, name: &CStr, change: L<'_>) -> Result<()> {
    let hooks = s.get(c"hooks")?;
    if is_func(hooks.get(name)?)? {
        call(
            hooks,
            name,
            &[fields(s, &[("file", s.get(c"file")?), ("change", change)])?],
        )?;
    }
    Ok(())
}
fn committed(s: L<'_>, res: L<'_>, change: L<'_>) -> Result<()> {
    revision(s, res)?;
    if res.get(c"redacted")?.truthy()? {
        hook(s, c"afterRedactionCheckpoint", change)?
    }
    hook(s, c"afterCommit", change)
}
fn on_failure<'a>(s: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    ignore(s, request(s, "end", fields(s, &[])?));
    let r = (|| {
        let info = request(s, "info", fields(s, &[])?)?;
        revision(s, info)?;
        undefined(s)
    })();
    ignore(s, r);
    Err(reason.throw_error())
}
fn cleanup(f: L<'_>, tracked: bool) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    s.set(c"detached", flag(s, false)?)?;
    let cow = f.get(c"cow")?;
    if cow.truthy()? {
        call(cow, c"revoke", &[])?;
    }
    let v = f.get(c"view")?;
    if v.truthy()? {
        view::revoke(v)?
    }
    if tracked {
        let row = f.get(c"row")?;
        if row.truthy()? {
            ignore(
                s,
                request(
                    s,
                    "discardTrackedDraft",
                    fields(s, &[("token", row.get(c"token")?)])?,
                ),
            )
        }
    } else {
        request(s, "end", fields(s, &[])?)?;
    }
    s.set(c"metrics", request(s, "metrics", fields(s, &[])?)?)?;
    undefined(s)
}
fn on_settle<'a>(f: L<'a>, result: Result<L<'a>>, read_only: bool) -> Result<L<'a>> {
    let saved = match result {
        Ok(v) => Ok(v),
        Err(e) => {
            let reason = f.exception_value()?;
            Err((e, reason))
        }
    };
    if let Err((_, Some(reason))) = &saved {
        if !read_only {
            let failed = on_failure(f.get(c"s")?, *reason);
            ignore(f, failed);
        }
    }
    cleanup(f, true)?;
    match saved {
        Ok(v) => Ok(v),
        Err((e, None)) => Err(e),
        Err((_, Some(e))) => Err(e.throw_error()),
    }
}
fn settle_value<'a>(f: L<'a>, value: L<'a>, read_only: bool) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    s.set(c"detached", flag(s, false)?)?;
    if read_only {
        let out = with_ctx(f, s.get(c"deps")?.get(c"cloneJson")?, &[value])?;
        let observed = f.get(c"row")?.get(c"state")?.get(c"revision")?.number()?;
        s.set(
            c"revision",
            num(s, s.get(c"revision")?.number()?.max(observed))?,
        )?;
        return Ok(out);
    }
    let raw = fields(f, &[("value", value), ("f", f)])?;
    let detached = with_ctx(
        f,
        cb(raw, 0, |r, _| {
            let f = r.get(c"f")?;
            let val = r.get(c"value")?;
            let uses = call(f.get(c"cow")?, c"containsOwnedProxy", &[val])?;
            fields(
                f,
                &[
                    ("uses", uses),
                    (
                        "result",
                        if uses.truthy()? {
                            deps(f.get(c"s")?, c"cloneJson", &[val])?
                        } else {
                            val
                        },
                    ),
                ],
            )
        })?,
        &[],
    )?;
    let change = with_ctx(
        f,
        cb(f, 0, |f, _| {
            let v = f.get(c"view")?;
            v.set(c"track", flag(v, false)?)?;
            let res = finish_cow(f);
            let exc = if res.is_err() {
                v.exception_value()?
            } else {
                None
            };
            v.set(c"track", flag(v, true)?)?;
            if let Some(e) = exc {
                return Err(e.throw_error());
            }
            res
        })?,
        &[],
    )?;
    if change.get(c"changed")?.truthy()? {
        let expected = f.get(c"expected")?;
        let row = f.get(c"row")?;
        let original = row.get(c"state")?.get(c"revision")?;
        if !expected.equals(original)? {
            return Err(s
                .get(c"deps")?
                .get(c"OrchestrationSqliteConflictError")?
                .construct(&[s.get(c"file")?, expected, original])?
                .throw_error());
        }
        change.set(c"expectedRevision", expected)?;
        let has_hooks = keys(s.get(c"hooks")?)?.get(c"length")?.truthy()?;
        let input = fields(
            f,
            &[
                ("token", row.get(c"token")?),
                ("headerReadsTracked", flag(f, true)?),
                ("expectedRevision", original),
                ("state", change.get(c"state")?),
                ("changes", collect_changes(f, change)?),
                ("prepareOnly", flag(f, has_hooks)?),
            ],
        )?;
        let mut res = request(s, "commitTrackedDraft", input)?;
        if has_hooks {
            hook(s, c"beforeCommit", change)?;
            res = request(s, "commit", fields(s, &[])?)?
        }
        committed(s, res, change)?;
    }
    let result = detached.get(c"result")?;
    if detached.get(c"uses")?.truthy()? {
        deps(s, c"deepFreeze", &[result])
    } else {
        Ok(result)
    }
}
fn tracked(f: L<'_>, read_only: bool) -> Result<L<'_>> {
    begin(f, read_only)?;
    let run = (|| {
        let s = f.get(c"s")?;
        let v = f.get(c"view")?;
        let root = v.get(c"root")?;
        let pred = f.get(c"predicate")?;
        if pred.truthy()? && !with_ctx(f, pred, &[root])?.truthy()? {
            let skip = f.get(c"skipped")?;
            let value = if is_func(skip)? {
                with_ctx(f, skip, &[])?
            } else {
                skip
            };
            let out = deps(s, c"deepFreeze", &[deps(s, c"cloneJson", &[value])?])?;
            return on_settle(f, Ok(out), false);
        }
        let callback = f.get(c"callback")?;
        let pending = if read_only && callback.undefined()? {
            root
        } else {
            let input = if read_only {
                root
            } else {
                setup_cow(f, undefined(s)?)?.get(c"draft")?
            };
            with_ctx(f, callback, &[input])?
        };
        view::detach(v)?;
        f.get(c"context")?.set(c"detached", flag(f, true)?)?;
        s.set(c"detached", flag(s, true)?)?;
        let ok = cb(f, 1, move |f, a| {
            on_settle(f, settle_value(f, a[0], read_only), read_only)
        })?;
        let bad = cb(f, 1, move |f, a| {
            on_settle(f, Err(a[0].throw_error()), read_only)
        })?;
        call(resolve(pending)?, c"then", &[ok, bad])
    })();
    if run.is_err() {
        on_settle(f, run, read_only)
    } else {
        run
    }
}
pub(super) fn mutate_in_slot<'a>(s: L<'a>, mutator: L<'a>) -> Result<L<'a>> {
    tracked(frame(s, &[("callback", mutator)])?, false)
}
fn command(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    ensure_open(s)?;
    let expected = s.get(c"revision")?;
    let header = request(s, "begin", fields(s, &[])?)?;
    let out = (|| {
        let name = f.get(c"name")?;
        let mut metadata = null(s)?;
        if name.is_string("outboxClaim")? {
            if let Some(r) = s.catch(|| request(s, "claimMetadata", fields(s, &[])?))? {
                metadata = r
            }
        }
        let v = view::create(s, header, metadata, null(s)?)?;
        f.set(c"view", v)?;
        let cow = setup_cow(f, metadata)?;
        let ctx = fields(
            f,
            &[("tracked", flag(f, false)?), ("detached", flag(f, false)?)],
        )?;
        f.set(c"context", ctx)?;
        let dispatch = cb(f, 0, |f, _| {
            let s = f.get(c"s")?;
            let ports = s.get(c"ports")?;
            let override_owner = ports.get(c"commandOverride")?.call_plain(&[])?;
            let draft = f.get(c"cow")?.get(c"draft")?;
            let snapshot = f.get(c"view")?.get(c"root")?;
            Ok(raw(
                s,
                crate::orchestration_command::orchestration_command_sync(
                    env(s),
                    arg(override_owner)?,
                    arg(f.get(c"name")?)?,
                    arg(draft)?,
                    arg(f.get(c"args")?)?,
                    arg(snapshot)?,
                    arg(ports.get(c"promiseThen")?)?,
                )?,
            ))
        })?;
        let val = with_ctx(f, dispatch, &[])?;
        let uses = call(cow, c"containsOwnedProxySafely", &[val])?.truthy()?;
        let out = if uses {
            deps(s, c"cloneJson", &[val])?
        } else {
            val
        };
        let change = finish_cow(f)?;
        if change.get(c"changed")?.truthy()? {
            change.set(c"expectedRevision", expected)?;
            request(
                s,
                "prepare",
                fields(
                    f,
                    &[
                        ("expectedRevision", expected),
                        ("state", change.get(c"state")?),
                        ("changes", collect_changes(f, change)?),
                    ],
                )?,
            )?;
            hook(s, c"beforeCommit", change)?;
            let r = request(s, "commit", fields(s, &[])?)?;
            committed(s, r, change)?;
        } else {
            request(s, "noop", fields(s, &[])?)?;
        }
        let result = if uses {
            deps(s, c"deepFreeze", &[out])?
        } else {
            out
        };
        Ok(raw(
            s,
            crate::orchestration_command::command_envelope(env(s), arg(result)?)?,
        ))
    })();
    let saved = if out.is_err() {
        f.exception_value()?
    } else {
        None
    };
    if let Some(e) = saved {
        ignore(s, on_failure(s, e));
    }
    cleanup(f, false)?;
    if let Some(e) = saved {
        return Err(e.throw_error());
    }
    out
}
fn read<'a>(s: L<'a>, selector: L<'a>) -> Result<L<'a>> {
    if !selector.undefined()? && !is_func(selector)? {
        return Err(s.type_error("[orchestration-sqlite-store] read selector must be a function"));
    }
    enqueue(frame(s, &[("callback", selector)])?, |f| tracked(f, true))
}
pub(super) fn install(s: L<'_>, api: L<'_>) -> Result<()> {
    attach(s, api, "read", 1, 1, |s, a| read(s, a[0]))?;
    attach(s, api, "snapshot", 0, 0, |s, _| read(s, undefined(s)?))?;
    attach(s, api, "mutate", 1, 1, |s, a| {
        if !is_func(a[0])? {
            return Err(s.type_error("[orchestration-sqlite-store] mutate requires a function"));
        }
        enqueue(frame(s, &[("callback", a[0])])?, |f| tracked(f, false))
    })?;
    attach(s, api, "mutateIf", 3, 3, |s, a| {
        if !is_func(a[0])? || !is_func(a[1])? {
            return Err(s.type_error(
                "[orchestration-sqlite-store] mutateIf requires predicate and mutator functions",
            ));
        }
        enqueue(
            frame(
                s,
                &[("predicate", a[0]), ("callback", a[1]), ("skipped", a[2])],
            )?,
            |f| tracked(f, false),
        )
    })?;
    let e = env(s);
    let cmd = variadic_method(&e, s, "runNativeCommandSync", 1, |s, a| {
        let name = a.first().copied().unwrap_or(undefined(s)?);
        let rest = if a.is_empty() { &[][..] } else { &a[1..] };
        enqueue(
            frame(s, &[("name", name), ("args", array(s, rest)?)])?,
            command,
        )
    })?;
    api.set(c"runNativeCommandSync", raw(s, cmd.raw()))?;
    for (name, m) in [("select", c"select"), ("count", c"count")] {
        set(
            api,
            name,
            function(s, name, 1, 2, move |s, a| {
                let f = fields(s, &[("c", a[0]), ("o", default_object(a[1])?)])?;
                read(
                    s,
                    cb(f, 1, move |f, a| {
                        call(a[0], m, &[f.get(c"c")?, f.get(c"o")?])
                    })?,
                )
            })?,
        )?;
    }
    Ok(())
}
