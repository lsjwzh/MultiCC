use super::*;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Subject {
    Wait,
    Operation,
    Task,
    Reference,
}
impl Subject {
    fn collection(self) -> &'static CStr {
        match self {
            Self::Wait => c"waits",
            Self::Task => c"tasks",
            _ => c"operations",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Wait => "wait",
            Self::Task => "task",
            Self::Operation => "operation",
            Self::Reference => "reference",
        }
    }
}
pub(super) fn get<'a>(p: L<'a>, id: L<'a>, wait: bool) -> Result<L<'a>> {
    async_result(p, || {
        transaction(
            p,
            &[("id", id), ("wait", flag(p, wait)?)],
            c"read",
            |f, a| {
                let wait = f.get(c"wait")?.truthy()?;
                let row = a[0]
                    .get(if wait { c"waits" } else { c"operations" })?
                    .get_key(f.get(c"id")?)?;
                public(row, if wait { WAIT_PRIVATE } else { OP_PRIVATE }, false)
            },
        )
    })
}
fn sort(v: L<'_>) -> Result<L<'_>> {
    let compare = function(v, "", 2, 2, |p, a| {
        let delta = a[0].get(c"createdAt")?.number()? - a[1].get(c"createdAt")?.number()?;
        if delta != 0. && !delta.is_nan() {
            num(p, delta)
        } else {
            call(a[0].get(c"id")?, c"localeCompare", &[a[1].get(c"id")?])
        }
    })?;
    call(v, c"sort", &[compare])
}
fn reference(row: L<'_>) -> Result<L<'_>> {
    let out = pick(
        row,
        &[
            c"id",
            c"kind",
            c"ownerSessionId",
            c"status",
            c"createdAt",
            c"updatedAt",
            c"startedAt",
            c"completedAt",
            c"externalId",
            c"requestOutboxId",
        ],
    )?;
    let spec = row.get(c"spec")?;
    out.set(
        c"spec",
        if spec.truthy()? {
            pick(
                spec,
                &[c"chatId", c"targetId", c"taskId", c"resultMode", c"oneWay"],
            )?
        } else {
            undef(row)?
        },
    )?;
    Ok(out)
}
fn finish<'a>(f: L<'a>, raw: L<'a>, projected: bool) -> Result<L<'a>> {
    let subject = f.get(c"subject")?;
    let kind = f.get(c"kind")?;
    let owner = f.get(c"owner")?;
    let status = f.get(c"status")?;
    let wanted = f.get(c"wanted")?;
    let exclude = f.get(c"exclude")?.truthy()?;
    let key = if subject.is_string("wait")? {
        c"sessionId"
    } else if subject.is_string("task")? {
        c"parentSessionId"
    } else {
        c"ownerSessionId"
    };
    let filtered = array(f)?;
    raw.for_each(|row| {
        if (kind.truthy()? && !row.get(c"kind")?.equals(kind)?)
            || (owner.truthy()? && !row.get(key)?.equals(owner)?)
            || (status.truthy()? && !row.get(c"status")?.equals(status)?)
            || (wanted.truthy()? && !call(wanted, c"has", &[row.get(c"status")?])?.truthy()?)
            || (exclude
                && terminal(
                    f.get(c"state")?,
                    row.get(c"status")?,
                    c"TERMINAL_OPERATION_STATES",
                )?)
        {
            return Ok(());
        }
        call(filtered, c"push", &[row])?;
        Ok(())
    })?;
    sort(filtered)?;
    if projected || subject.is_string("task")? {
        return Ok(filtered);
    }
    let out = array(f)?;
    filtered.for_each(|row| {
        let item = if subject.is_string("reference")? {
            reference(row)?
        } else if subject.is_string("wait")? {
            public(row, WAIT_PRIVATE, false)?
        } else {
            public(row, OP_PRIVATE, false)?
        };
        call(out, c"push", &[item])?;
        Ok(())
    })?;
    Ok(out)
}
pub(super) fn list<'a>(p: L<'a>, options: L<'a>, subject: Subject) -> Result<L<'a>> {
    async_result(p, || {
        let o = default_object(options)?;
        let op = subject == Subject::Operation || subject == Subject::Reference;
        let kind = if op { read(o, c"kind")? } else { undef(p)? };
        let owner = read(o, if op { c"ownerSessionId" } else { c"sessionId" })?;
        let mut status = undef(p)?;
        let mut wanted = null(p)?;
        if subject == Subject::Wait {
            status = read(o, c"status")?;
        } else {
            let s = read(o, c"statuses")?;
            if !s.nullish()? {
                let arr = p.global()?.get(c"Array")?;
                let vals = if call(arr, c"isArray", &[s])?.truthy()? {
                    s
                } else {
                    let out = array(p)?;
                    call(out, c"push", &[s])?;
                    out
                };
                wanted = p.global()?.get(c"Set")?.construct(&[vals])?;
            }
        }
        let exclude = if subject == Subject::Reference {
            read(o, c"excludeTerminal")?
        } else {
            flag(p, false)?
        };
        let f = fields(
            p,
            &[
                ("state", p),
                ("subject", text(p, subject.name())?),
                ("kind", kind),
                ("owner", owner),
                ("status", status),
                ("wanted", wanted),
                ("exclude", exclude),
            ],
        )?;
        let filter = fields(p, &[])?;
        if kind.truthy()? {
            filter.set(c"kind", kind)?;
        }
        if owner.truthy()? {
            filter.set(
                if op {
                    c"ownerSessionId"
                } else if subject == Subject::Wait {
                    c"sessionId"
                } else {
                    c"parentSessionId"
                },
                owner,
            )?;
        }
        if status.truthy()? {
            filter.set(c"status", status)?;
        }
        if wanted.truthy()? {
            filter.set(
                c"status",
                call(p.global()?.get(c"Array")?, c"from", &[wanted])?,
            )?;
        } else if exclude.truthy()? {
            let list = call(
                p.global()?.get(c"Array")?,
                c"from",
                &[p.get(c"TERMINAL_OPERATION_STATES")?],
            )?;
            filter.set(c"status", fields(p, &[("$nin", list)])?)?;
        }
        let store = p.get(c"store")?;
        if subject == Subject::Reference && callable(store.get(c"select")?)? {
            let keys = array(p)?;
            for name in [
                "id",
                "kind",
                "ownerSessionId",
                "status",
                "createdAt",
                "updatedAt",
                "startedAt",
                "completedAt",
                "externalId",
                "requestOutboxId",
                "spec.chatId",
                "spec.targetId",
                "spec.taskId",
                "spec.resultMode",
                "spec.oneWay",
            ] {
                call(keys, c"push", &[text(p, name)?])?;
            }
            let result = call(
                store,
                c"select",
                &[
                    text(p, "operations")?,
                    fields(p, &[("where", filter), ("fields", keys)])?,
                ],
            )?;
            return then(result, f, |f, a| finish(f, a[0], true));
        }
        f.set(c"filter", filter)?;
        let selector = function(f, "", 1, 1, move |f, a| {
            let rows = if subject == Subject::Reference {
                call(
                    f.global()?.get(c"Object")?,
                    c"values",
                    &[a[0].get(c"operations")?],
                )?
            } else {
                candidates(a[0], subject.collection(), f.get(c"filter")?)?
            };
            finish(f, rows, false)
        })?;
        call(store, c"read", &[selector])
    })
}
