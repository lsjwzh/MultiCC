//! Durable delivery runs on the Node event-loop thread. State for an invocation
//! is captured by V8-owned callbacks, including while a host Promise is parked.
use super::{after as then, fulfilled, port, recover, service as unit, undef};
use crate::{
    host_methods::{arg, async_result, env, function, raw},
    route_response::*,
};

mod descriptor;
mod execution;
mod selection;
use descriptor::*;
use execution::deliver;
use selection::select;

type Step = for<'a> fn(L<'a>, L<'a>) -> Result<L<'a>>;

fn empty(v: L<'_>) -> Result<L<'_>> {
    fields(v, &[])
}
fn array(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Array(vec![]))
}
fn or<'a>(a: L<'a>, b: L<'a>) -> Result<L<'a>> {
    Ok(if a.truthy()? { a } else { b })
}
fn is_fn(a: L<'_>) -> Result<bool> {
    Ok(a.kind()? == sys::ValueType::napi_function)
}
fn cb<'a>(state: L<'a>, step: Step) -> Result<L<'a>> {
    function(state, "", 1, 1, move |s, a| step(s, a[0]))
}
fn rescue<'a>(state: L<'a>, v: L<'a>, step: Step) -> Result<L<'a>> {
    recover(state, fulfilled(v)?, step)
}
fn ignore<'a>(s: L<'a>, _: L<'a>) -> Result<L<'a>> {
    undef(s)
}
fn saved<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    j.get(c"result")
}
fn concat<'a>(s: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    call(text(s, "")?, c"concat", parts)
}
fn json(value: L<'_>) -> Result<L<'_>> {
    call(value.global()?.get(c"JSON")?, c"stringify", &[value])
}
fn log<'a>(s: L<'a>, parts: &[L<'a>]) -> Result<()> {
    port(s, c"log", &[concat(s, parts)?])?;
    Ok(())
}
fn owner(j: L<'_>) -> Result<L<'_>> {
    j.get(c"state")
}
fn item(j: L<'_>) -> Result<L<'_>> {
    j.get(c"item")
}

fn timeout<'a>(j: L<'a>, interval: L<'a>, watchdog: bool) -> Result<L<'a>> {
    let timer_state = fields(j, &[("job", j), ("interval", interval)])?;
    let create = function(timer_state, "", 1, 1, move |t, a| {
        let j = t.get(c"job")?;
        let s = owner(j)?;
        let resolve = if watchdog {
            t.set(c"resolve", a[0])?;
            cb(t, |t, _| {
                let j = t.get(c"job")?;
                let s = owner(j)?;
                log(
                    s,
                    &[
                        text(s, "[orchestration] delivery ")?,
                        item(j)?.get(c"id")?,
                        text(s, " still unsettled after ")?,
                        t.get(c"interval")?,
                        text(s, "ms; releasing the worker tick")?,
                    ],
                )?;
                t.get(c"resolve")?.call_plain(&[])
            })?
        } else {
            a[0]
        };
        let handle = port(s, c"setTimeoutFn", &[resolve, t.get(c"interval")?])?;
        j.set(c"timer", handle)?;
        if handle.truthy()? && is_fn(handle.get(c"unref")?)? {
            call(handle, c"unref", &[])?;
        }
        undef(t)
    })?;
    j.global()?.get(c"Promise")?.construct(&[create])
}
fn clear<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let t = j.get(c"timer")?;
    if !t.equals(null(j)?)? {
        port(owner(j)?, c"clearTimeoutFn", &[t])?;
    }
    undef(j)
}
fn race<'a>(a: L<'a>, b: L<'a>) -> Result<L<'a>> {
    let list = array(a)?;
    call(list, c"push", &[a, b])?;
    call(a.global()?.get(c"Promise")?, c"race", &[list])
}
fn unpark<'a>(j: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let s = owner(j)?;
    let group = j.get(c"group")?;
    unit(s, c"inFlightDeliveries", c"delete", &[item(j)?.get(c"id")?])?;
    unit(s, c"pendingDeliveries", c"delete", &[j.get(c"delivery")?])?;
    let count = or(
        unit(s, c"inFlightDeliveryGroups", c"get", &[group])?,
        num(s, 1.)?,
    )?
    .number()?
        - 1.;
    if count > 0. {
        unit(
            s,
            c"inFlightDeliveryGroups",
            c"set",
            &[group, num(s, count)?],
        )?;
    } else {
        unit(s, c"inFlightDeliveryGroups", c"delete", &[group])?;
    }
    undef(s)
}
fn within_tick<'a>(s: L<'a>, it: L<'a>) -> Result<L<'a>> {
    let id = it.get(c"id")?;
    let j = fields(s, &[("state", s), ("item", it), ("timer", null(s)?)])?;
    let delivery = unit(
        s,
        c"deliveryScope",
        c"run",
        &[fields(s, &[("itemId", id)])?, cb(j, |j, _| deliver(j))?],
    )?;
    rescue(j, delivery, ignore)?;
    unit(s, c"inFlightDeliveries", c"add", &[id])?;
    unit(s, c"pendingDeliveries", c"add", &[delivery])?;
    let group = port(s, c"deliveryGroup", &[it.get(c"sessionId")?])?;
    let count = or(
        unit(s, c"inFlightDeliveryGroups", c"get", &[group])?,
        num(s, 0.)?,
    )?
    .number()?
        + 1.;
    unit(
        s,
        c"inFlightDeliveryGroups",
        c"set",
        &[group, num(s, count)?],
    )?;
    j.set(c"group", group)?;
    j.set(c"delivery", delivery)?;
    let release = cb(j, unpark)?;
    call(delivery, c"then", &[release, release])?;
    let interval = s.get(c"deliveryWatchdogMs")?;
    if interval.number()? > 0. {
        let timer = timeout(j, interval, true)?;
        return race(call(delivery, c"finally", &[cb(j, clear)?])?, timer);
    }
    Ok(delivery)
}
pub(super) fn process_outbox(s: L<'_>) -> Result<L<'_>> {
    async_result(s, || {
        let selector = function(s, "selectRunnableSessionItem", 3, 3, |s, a| {
            select(s, a[0], a[1], a[2])
        })?;
        let policy = fields(
            s,
            &[
                ("workerId", s.get(c"workerId")?),
                ("limit", s.get(c"claimLimit")?),
                ("selectSessionItem", selector),
                ("sessionGroup", s.get(c"deliveryGroup")?),
            ],
        )?;
        then(s, unit(s, c"outbox", c"claim", &[policy])?, |s, items| {
            let list = array(s)?;
            items.for_each(|it| {
                call(list, c"push", &[within_tick(s, it)?])?;
                Ok(())
            })?;
            let deliveries = call(s.global()?.get(c"Promise")?, c"all", &[list])?;
            rescue(s, deliveries, ignore)?;
            let j = fields(s, &[("state", s), ("items", items), ("timer", null(s)?)])?;
            let grace = s.get(c"deliveryTickGraceMs")?;
            let settled = if grace.number()? > 0. {
                let t = timeout(j, grace, false)?;
                call(race(deliveries, t)?, c"finally", &[cb(j, clear)?])?
            } else {
                deliveries
            };
            then(j, settled, |j, _| j.get(c"items")?.get(c"length"))
        })
    })
}
