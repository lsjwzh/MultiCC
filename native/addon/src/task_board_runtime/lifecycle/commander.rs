use super::*;

fn frame<'a>(p: L<'a>, owner: L<'a>, input: L<'a>) -> Result<L<'a>> {
    fields(p, &[("ports", p), ("owner", owner), ("input", input)])
}
fn owner<'a>(f: L<'a>, key: &CStr, extra: &[L<'a>]) -> Result<L<'a>> {
    let mut args = vec![f.get(c"input")?];
    args.extend_from_slice(extra);
    call(f.get(c"owner")?, key, &args)
}
fn sent<'a>(f: L<'a>, receipt: L<'a>) -> Result<L<'a>> {
    owner(f, c"sent", &[receipt])
}
fn bound_start<'a>(f: L<'a>, bound: L<'a>) -> Result<L<'a>> {
    let delivery = owner(f, c"bound", &[bound])?;
    if delivery.get(c"kind")?.is_string("send")? {
        after(f, delivery.get(c"pending")?, sent)
    } else {
        delivery.get(c"result")
    }
}
fn worker<'a>(f: L<'a>) -> Result<L<'a>> {
    let delivered = async_result(f, || {
        let delivery = owner(f, c"worker", &[])?;
        if delivery.get(c"kind")?.is_string("dispatch")? {
            after(f, delivery.get(c"pending")?, |f, r| {
                owner(f, c"receipt", &[r])
            })
        } else {
            delivery.get(c"result")
        }
    })?;
    let receipt = call(
        delivered,
        c"catch",
        &[function(f, "", 1, 1, |f, a| {
            call(f.get(c"owner")?, c"failure", &[a[0]])
        })?],
    )?;
    after(f, receipt, |f, r| owner(f, c"complete", &[r]))
}
pub(super) fn input<'a>(p: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    let start = p.get(c"native")?.get(c"TaskBoardStart")?;
    let input = call(
        start,
        c"prepare",
        &[p.get(c"startPorts")?, a[0], a[1], default_object(a[2])?],
    )?;
    if input.get(c"ok")?.is_false()? {
        return Ok(input);
    }
    let f = frame(p, start, input)?;
    held(p, input.get(c"taskId")?, || {
        let route = owner(f, c"route", &[])?;
        let kind = route.get(c"kind")?;
        if kind.is_string("bind")? {
            after(f, route.get(c"pending")?, bound_start)
        } else if kind.is_string("worker")? {
            worker(f)
        } else {
            route.get(c"result")
        }
    })
}
pub(super) fn followup<'a>(p: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    let owner = p.get(c"native")?.get(c"TaskBoardFollowup")?;
    let input = call(
        owner,
        c"prepare",
        &[
            p.get(c"followupPorts")?,
            a[0],
            a[1],
            a[2],
            default_object(a[3])?,
        ],
    )?;
    if input.get(c"ok")?.is_false()? {
        return Ok(input);
    }
    let f = frame(p, owner, input)?;
    after(f, input.get(c"pending")?, |f, bound| {
        let refusal = self::owner(f, c"bound", &[bound])?;
        if refusal.truthy()? {
            return Ok(refusal);
        }
        held(
            super::p(f)?,
            f.get(c"input")?.get(c"task")?.get(c"id")?,
            || after(f, self::owner(f, c"send", &[])?, sent),
        )
    })
}
