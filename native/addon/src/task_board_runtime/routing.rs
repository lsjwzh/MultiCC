//! Map and Set views over the Rust task-domain routing commands. The ranking
//! port supplies V8 iterator materialisation, timestamps and availability.
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use napi_derive::napi;

fn rule<'a>(s: L<'a>, name: &str, args: L<'a>) -> Result<L<'a>> {
    let input = fields(
        s,
        &[("op", text(s, "routing")?), ("action", text(s, name)?)],
    )?;
    input.spread_from(args)?;
    call(s, c"taskDomain", &[input])
}
fn context<'a>(s: L<'a>, args: L<'a>) -> Result<L<'a>> {
    s.global()?
        .get(c"Map")?
        .construct(&[rule(s, "buildRoutingContext", args)?])
}
fn available<'a>(s: L<'a>, record: L<'a>, id: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if crate::js_iteration::read(opts, c"isAvailable")?.kind()? == sys::ValueType::napi_function {
        let yes = opts.catch(|| call(opts, c"isAvailable", &[id, record]))?;
        return flag(
            s,
            match yes {
                Some(v) => v.truthy()?,
                None => false,
            },
        );
    }
    rule(
        s,
        "recordAppearsAvailable",
        fields(s, &[("record", record)])?,
    )
}
fn rank<'a>(s: L<'a>, records: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let check = function(s, "recordAppearsAvailable", 2, 3, |s, a| {
        available(s, a[0], a[1], default_object(a[2])?)
    })?;
    let args = call(s, c"rankInputs", &[records, opts, check])?;
    rule(s, "rankRoutingCandidates", args)
}
fn unary<'a>(s: L<'a>, name: &'static str, key: &'static str) -> Result<L<'a>> {
    function(s, name, 1, 1, move |s, a| {
        let result = rule(s, name, fields(s, &[(key, a[0])])?)?;
        match name {
            "routingTerms" => s.global()?.get(c"Set")?.construct(&[result]),
            "buildSessionRoutingProfile" => s.global()?.get(c"Map")?.construct(&[result]),
            _ => Ok(result),
        }
    })
}

#[napi]
pub fn task_board_routing_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let s = L::new(&env, ports);
    let api = fields(s, &[])?;
    api.set(c"isRoutableRecord", unary(s, "isRoutableRecord", "record")?)?;
    api.set(
        c"resolveDirectoryCommander",
        function(s, "resolveDirectoryCommander", 2, 2, |s, a| {
            let result = rule(
                s,
                "resolveDirectoryCommander",
                fields(
                    s,
                    &[("records", call(s, c"entries", &[a[0]])?), ("dirId", a[1])],
                )?,
            )?;
            if result.get(c"ok")?.truthy()? {
                result.assign(c"record", call(a[0], c"get", &[result.get(c"sessionId")?])?)?
            }
            Ok(result)
        })?,
    )?;
    api.set(c"routingTerms", unary(s, "routingTerms", "value")?)?;
    api.set(
        c"buildRoutingContext",
        function(s, "buildRoutingContext", 0, 1, |s, a| {
            context(s, default_object(a[0])?)
        })?,
    )?;
    api.set(
        c"buildSessionRoutingProfile",
        unary(s, "buildSessionRoutingProfile", "record")?,
    )?;
    api.set(
        c"routingRelevanceScore",
        function(s, "routingRelevanceScore", 2, 2, |s, a| {
            rule(
                s,
                "routingRelevanceScore",
                fields(
                    s,
                    &[
                        ("contextTerms", call(s, c"entries", &[a[0]])?),
                        ("record", a[1]),
                    ],
                )?,
            )
        })?,
    )?;
    api.set(
        c"recordAppearsAvailable",
        function(s, "recordAppearsAvailable", 2, 3, |s, a| {
            available(s, a[0], a[1], default_object(a[2])?)
        })?,
    )?;
    api.set(
        c"rankRoutingCandidates",
        function(s, "rankRoutingCandidates", 1, 2, |s, a| rank(s, a[0], a[1]))?,
    )?;
    for (name, task_mode, count) in [("pickDirTarget", false, 4), ("pickRouteTarget", true, 5)] {
        api.set_key(
            text(s, name)?,
            function(s, name, count - 1, count, move |s, a| {
                let opts = default_object(a[count - 1])?;
                let id = a[count - 2];
                let records = if task_mode { a[2] } else { a[0] };
                if id.truthy()? {
                    let record = call(records, c"get", &[id])?;
                    let routable = rule(s, "isRoutableRecord", fields(s, &[("record", record)])?)?;
                    return if routable.truthy()? && available(s, record, id, opts)?.truthy()? {
                        Ok(id)
                    } else {
                        null(s)
                    };
                }
                let dir = if task_mode {
                    call(s, c"taskDirId", &[a[0], a[1]])?
                } else {
                    a[1]
                };
                let ctx = if task_mode {
                    fields(s, &[("board", a[0]), ("task", a[1])])?
                } else {
                    fields(s, &[])?
                };
                ctx.set(c"queryText", crate::js_iteration::read(opts, c"queryText")?)?;
                let args = fields(s, &[("dirId", dir), ("contextTerms", context(s, ctx)?)])?;
                if task_mode {
                    args.set(c"affinitySessionIds", call(s, c"affinity", &[a[1]])?)?
                }
                args.set(c"options", opts)?;
                let first = rank(s, records, args)?.element(0)?;
                fallback(first.optional(c"sid")?, V::Null)
            })?,
        )?;
    }
    for name in ["buildRoutedMessage", "buildCommanderRoutedMessage"] {
        api.set_key(
            text(s, name)?,
            function(s, name, 2, 2, move |s, a| {
                rule(s, name, fields(s, &[("task", a[0]), ("value", a[1])])?)
            })?,
        )?;
    }
    api.set(
        c"extractTaskMarker",
        unary(s, "extractTaskMarker", "value")?,
    )?;
    api.set(c"messageText", unary(s, "messageText", "message")?)?;
    Ok(api.raw())
}
