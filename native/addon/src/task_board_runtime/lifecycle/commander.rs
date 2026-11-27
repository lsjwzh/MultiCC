use super::*;

use crate::{
    host_methods::{arg, env, raw},
    task_board_followup::TaskBoardFollowup,
    task_board_start::TaskBoardStart,
};

fn frame<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    fields(p, &[("ports", p), ("input", input)])
}
fn sent<'a>(f: L<'a>, receipt: L<'a>) -> Result<L<'a>> {
    Ok(raw(
        f,
        TaskBoardStart::sent(env(f), arg(f.get(c"input")?)?, arg(receipt)?)?,
    ))
}
fn bound_start<'a>(f: L<'a>, bound: L<'a>) -> Result<L<'a>> {
    let delivery = raw(
        f,
        TaskBoardStart::bound(env(f), arg(f.get(c"input")?)?, arg(bound)?)?,
    );
    if delivery.get(c"kind")?.is_string("send")? {
        after(f, delivery.get(c"pending")?, sent)
    } else {
        delivery.get(c"result")
    }
}
fn worker<'a>(f: L<'a>) -> Result<L<'a>> {
    let delivered = async_result(f, || {
        let delivery = raw(f, TaskBoardStart::worker(env(f), arg(f.get(c"input")?)?)?);
        if delivery.get(c"kind")?.is_string("dispatch")? {
            after(f, delivery.get(c"pending")?, |f, r| {
                Ok(raw(
                    f,
                    TaskBoardStart::receipt(env(f), arg(f.get(c"input")?)?, arg(r)?)?,
                ))
            })
        } else {
            delivery.get(c"result")
        }
    })?;
    let receipt = call(
        delivered,
        c"catch",
        &[function(f, "", 1, 1, |f, a| {
            Ok(raw(f, TaskBoardStart::failure(env(f), arg(a[0])?)?))
        })?],
    )?;
    after(f, receipt, |f, r| {
        Ok(raw(
            f,
            TaskBoardStart::complete(env(f), arg(f.get(c"input")?)?, arg(r)?)?,
        ))
    })
}
pub(super) fn input<'a>(p: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    let input = raw(
        p,
        TaskBoardStart::prepare(
            env(p),
            arg(p.get(c"startPorts")?)?,
            arg(a[0])?,
            arg(a[1])?,
            arg(default_object(a[2])?)?,
        )?,
    );
    if input.get(c"ok")?.is_false()? {
        return Ok(input);
    }
    let f = frame(p, input)?;
    held(p, input.get(c"taskId")?, || {
        let route = raw(f, TaskBoardStart::route(env(f), arg(input)?)?);
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
    let input = raw(
        p,
        TaskBoardFollowup::prepare(
            env(p),
            arg(p.get(c"followupPorts")?)?,
            arg(a[0])?,
            arg(a[1])?,
            arg(a[2])?,
            arg(default_object(a[3])?)?,
        )?,
    );
    if input.get(c"ok")?.is_false()? {
        return Ok(input);
    }
    let f = frame(p, input)?;
    after(f, input.get(c"pending")?, |f, bound| {
        let refusal = raw(
            f,
            TaskBoardFollowup::bound(env(f), arg(f.get(c"input")?)?, arg(bound)?)?,
        );
        if refusal.truthy()? {
            return Ok(refusal);
        }
        held(
            super::p(f)?,
            f.get(c"input")?.get(c"task")?.get(c"id")?,
            || {
                let pending = raw(f, TaskBoardFollowup::send(env(f), arg(f.get(c"input")?)?)?);
                after(f, pending, |f, receipt| {
                    Ok(raw(
                        f,
                        TaskBoardFollowup::sent(env(f), arg(f.get(c"input")?)?, arg(receipt)?)?,
                    ))
                })
            },
        )
    })
}
