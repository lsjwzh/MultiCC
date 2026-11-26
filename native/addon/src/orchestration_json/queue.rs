//! All observers see the same per-instance tail. Rejections propagate to the
//! original caller while the serialized tail always permits the next operation.
use super::*;
use crate::host_methods::{arg, async_result, env, raw, variadic_method};

fn cb<'a>(
    s: L<'a>,
    n: usize,
    f: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    function(s, "", n, n, f)
}
fn enqueue<'a>(s: L<'a>, op: L<'a>) -> Result<L<'a>> {
    let result = call(s.get(c"tail")?, c"then", &[op, op])?;
    let ignore = s.get(c"ignore")?;
    s.set(c"tail", call(result, c"then", &[ignore, ignore])?)?;
    Ok(result)
}
fn after<'a>(s: L<'a>, value: L<'a>, done: L<'a>) -> Result<L<'a>> {
    let p = async_result(s, || Ok(value))?;
    call(p, c"then", &[done])
}
fn begin<'a>(s: L<'a>) -> Result<L<'a>> {
    let current = s.get(c"state")?;
    fields(
        s,
        &[
            ("s", s),
            ("before", json(s, c"stringify", &[current])?),
            ("draft", state::clone_json(current)?),
        ],
    )
}
fn commit(tx: L<'_>) -> Result<()> {
    let s = tx.get(c"s")?;
    let p = s.get(c"ports")?;
    let file = s.get(c"file")?;
    let draft = tx.get(c"draft")?;
    state::validate(p, draft, file)?;
    if tx
        .get(c"before")?
        .equals(json(s, c"stringify", &[draft])?)?
    {
        return Ok(());
    }
    draft.assign(
        c"revision",
        num(s, s.get(c"state")?.get(c"revision")?.number()? + 1.)?,
    )?;
    draft.assign(
        c"updatedAt",
        num(s, s.get(c"now")?.call_plain(&[])?.explicit_number()?)?,
    )?;
    state::validate(p, draft, file)?;
    let res = disk::write(p, s, draft).and_then(|_| s.set(c"state", state::freeze(draft)?));
    if let Err(error) = res {
        let thrown = reason(s, error)?;
        s.set(c"state", state::freeze(disk::load(p, s)?)?)?;
        return Err(thrown.throw_error());
    }
    Ok(())
}
fn mutate<'a>(s: L<'a>, mutator: L<'a>) -> Result<L<'a>> {
    let tx = begin(s)?;
    let value = mutator.call_plain(&[tx.get(c"draft")?])?;
    after(
        s,
        value,
        cb(tx, 1, |tx, a| {
            commit(tx)?;
            Ok(a[0])
        })?,
    )
}
fn read<'a>(s: L<'a>, selector: L<'a>) -> Result<L<'a>> {
    if !selector.undefined()? && !func(selector)? {
        return Err(s.type_error("[orchestration-store] read selector must be a function"));
    }
    let job = fields(s, &[("s", s), ("selector", selector)])?;
    enqueue(
        s,
        cb(job, 0, |j, _| {
            let s = j.get(c"s")?;
            let selector = j.get(c"selector")?;
            let state = s.get(c"state")?;
            if selector.undefined()? {
                state::clone_json(state)
            } else {
                after(
                    s,
                    selector.call_plain(&[state])?,
                    cb(s, 1, |_, a| state::clone_json(a[0]))?,
                )
            }
        })?,
    )
}
fn command<'a>(s: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let name = args.first().copied().unwrap_or(undef(s)?);
    let argv = s.from_value(&V::Array(vec![]))?;
    for (i, item) in args.iter().skip(1).enumerate() {
        argv.set_element(i as u32, *item)?;
    }
    let job = fields(s, &[("s", s), ("name", name), ("args", argv)])?;
    enqueue(
        s,
        cb(job, 0, |j, _| {
            let s = j.get(c"s")?;
            let ports = s.get(c"ports")?;
            let tx = begin(s)?;
            let binding = ports.get(c"binding")?;
            let loader = binding.get(c"getNative")?;
            let addon = if loader.equals(ports.get(c"getNative")?)? {
                undef(s)?
            } else {
                loader.call(binding, &[])?
            };
            let value = crate::orchestration_command::orchestration_command_sync(
                env(s),
                arg(addon)?,
                arg(j.get(c"name")?)?,
                arg(tx.get(c"draft")?)?,
                arg(j.get(c"args")?)?,
                arg(s.get(c"state")?)?,
                arg(ports.get(c"promiseThen")?)?,
            )?;
            commit(tx)?;
            Ok(raw(
                s,
                crate::orchestration_command::command_envelope(env(s), arg(raw(s, value))?)?,
            ))
        })?,
    )
}

pub(super) fn facade(s: L<'_>) -> Result<L<'_>> {
    s.set(
        c"tail",
        call(s.global()?.get(c"Promise")?, c"resolve", &[])?,
    )?;
    s.set(c"ignore", cb(s, 0, |s, _| undef(s))?)?;
    let api = fields(
        s,
        &[("backend", text(s, "json")?), ("file", s.get(c"file")?)],
    )?;
    api.set(
        c"mutate",
        function(s, "mutate", 1, 1, |s, a| {
            if !func(a[0])? {
                return Err(s.type_error("[orchestration-store] mutate requires a function"));
            }
            let j = fields(s, &[("s", s), ("mutator", a[0])])?;
            enqueue(
                s,
                cb(j, 0, |j, _| mutate(j.get(c"s")?, j.get(c"mutator")?))?,
            )
        })?,
    )?;
    api.set(
        c"mutateIf",
        function(s, "mutateIf", 3, 3, |s, a| {
            if !func(a[0])? || !func(a[1])? {
                return Err(s.type_error(
                    "[orchestration-store] mutateIf requires predicate and mutator functions",
                ));
            }
            let j = fields(
                s,
                &[
                    ("s", s),
                    ("predicate", a[0]),
                    ("mutator", a[1]),
                    ("skipped", a[2]),
                ],
            )?;
            enqueue(
                s,
                cb(j, 0, |j, _| {
                    let s = j.get(c"s")?;
                    if j.get(c"predicate")?
                        .call_plain(&[s.get(c"state")?])?
                        .truthy()?
                    {
                        return mutate(s, j.get(c"mutator")?);
                    }
                    let skipped = j.get(c"skipped")?;
                    state::clone_json(if func(skipped)? {
                        skipped.call_plain(&[])?
                    } else {
                        skipped
                    })
                })?,
            )
        })?,
    )?;
    let e = env(s);
    let cmd = variadic_method(&e, s, "runNativeCommandSync", 1, |s, a| command(s, a))?;
    api.set(c"runNativeCommandSync", cmd)?;
    api.set(c"read", function(s, "read", 1, 1, |s, a| read(s, a[0]))?)?;
    api.set(c"snapshot", cb(s, 0, |s, _| read(s, undef(s)?))?)?;
    api.set(c"flush", cb(s, 0, |s, _| s.get(c"tail"))?)?;
    api.freeze()
}
