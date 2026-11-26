use super::*;

fn reply<'a>(s: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let out = fields(s, &[("value", value)])?;
    call(s.global()?.get(c"JSON")?, c"stringify", &[out])
}
fn rejected<'a>(s: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    // Retain the original exception only for the lifetime of this transaction.
    // Some errors are consumed for rollback, others reach JS and keep identity.
    let errors = s.get(c"errors")?;
    let index = errors.get(c"length")?;
    call(errors, c"push", &[reason])?;
    let details = project(
        reason,
        &[
            "code",
            "stderr",
            "operationId",
            "queueDepth",
            "operation",
            "result",
        ],
    )?;
    let details = if details.nullish()? {
        fields(s, &[])?
    } else {
        details
    };
    let msg = reason.optional(c"message")?;
    details.set(
        c"message",
        if msg.truthy()? {
            string(msg)?
        } else {
            string(reason)?
        },
    )?;
    details.set(c"exceptionIndex", index)?;
    call(
        s.global()?.get(c"JSON")?,
        c"stringify",
        &[fields(s, &[("error", details)])?],
    )
}
pub(super) fn packet<'a>(s: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    let res = async_result(s, || {
        let req = parse(s, &js_string(payload)?)?;
        let get = |i| req.element(i);
        let task = s.get(c"context")?;
        let opts = s.get(c"opts")?;
        match js_string(get(0)?)?.as_str() {
            "git" => {
                let custom = s.get(c"customGit")?;
                if !custom.undefined()? || task.nullish()? {
                    custom.call_plain(&[get(1)?, get(2)?, get(3)?])
                } else {
                    repo_actor::exec_context_git(task, get(1)?, get(2)?, get(3)?)
                }
            }
            "progress" => repo_actor::context_progress(task, get(1)?, get(2)?),
            "beforeRemove" => {
                let cb = opts.get(c"beforeRemove")?;
                if cb.kind()? == sys::ValueType::napi_function {
                    cb.call(opts, &[get(1)?])
                } else {
                    undefined(s)
                }
            }
            "evidence" => {
                let ev = opts.get(c"evidence")?;
                if !ev.truthy()? {
                    return undefined(s);
                }
                ev.get_key(get(1)?)?
                    .call(ev, &[get(2)?, task.get(c"execGit")?])
            }
            "operation" => {
                let raw = js_string(get(1)?)?;
                let name = METHODS
                    .iter()
                    .copied()
                    .chain([
                        "gitCarryCollect",
                        "gitCarryApply",
                        "gitSplitFacts",
                        "gitCarryVerify",
                    ])
                    .find(|name| *name == raw)
                    .ok_or_else(|| napi::Error::from_reason("unknown nested Git operation"))?;
                let arr = get(2)?;
                let len = arr.get(c"length")?.number()? as usize;
                let args = (0..len)
                    .map(|i| arr.element(i as u32))
                    .collect::<Result<Vec<_>>>()?;
                if let Some(x) = spec(name).opts.and_then(|i| args.get(i)) {
                    // Subtransactions explicitly clear hooks when performing compensation.
                    for k in [c"activeCheck", c"onProgress"] {
                        let inherited = opts.get(k)?;
                        if x.get(k)?.undefined()? && !inherited.undefined()? {
                            x.set(k, inherited)?;
                        }
                    }
                }
                schedule(s.get(c"service")?, name, &args)
            }
            _ => fail(s, "unknown Git host port"),
        }
    })?;
    call(
        res,
        c"then",
        &[
            function(s, "", 1, 1, |s, a| reply(s, a[0]))?,
            function(s, "", 1, 1, |s, a| rejected(s, a[0]))?,
        ],
    )
}
fn unpack<'a>(s: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    let v = parse(s, &js_string(payload)?)?;
    let failure = v.get(c"error")?;
    if failure.undefined()? {
        return v.get(c"value");
    }
    let i = failure.get(c"exceptionIndex")?;
    if let Some(n) = i.number_value()? {
        return Err(s.get(c"errors")?.element(n as u32)?.throw_error());
    }
    let err = s
        .global()?
        .get(c"Error")?
        .construct(&[failure.get(c"message")?])?;
    call(s.global()?.get(c"Object")?, c"assign", &[err, failure])?;
    Err(err.throw_error())
}
pub(super) fn launch<'a>(s: L<'a>, context: L<'a>, name: &'static str) -> Result<L<'a>> {
    use napi::bindgen_prelude::Function;
    s.set(c"context", context)?;
    let service = s.get(c"service")?;
    let callback = function(s, "gitHostPort", 1, 1, |s, a| packet(s, a[0]))?;
    let callback = service.get(c"bindContext")?.call_plain(&[callback])?;
    let port =
        unsafe { Function::<String, Promise<String>>::from_napi_value(s.env(), callback.raw())? }
            .build_threadsafe_function::<String>()
            .callee_handled::<false>()
            .build()?;
    let mut ctx = GitContext {
        id: if context.nullish()? {
            String::new()
        } else {
            js_string(context.get(c"operationId")?)?
        },
        node_exec_path: js_string(service.get(c"node")?)?,
        host: port,
    };
    let args: Vec<Value> = serde_json::from_str(&stringify(s.get(c"args")?)?)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let environment = env(s);
    let job = environment.spawn_future(async move {
        let result = match dispatch(name, &args, &mut ctx).await {
            Ok(v) => json!({"value":v}),
            Err(e) => json!({"error":e.packet()}),
        };
        Ok(result.to_string())
    })?;
    call(
        L::from_raw(s.env(), job.raw()),
        c"then",
        &[function(s, "", 1, 1, |s, a| unpack(s, a[0]))?],
    )
}
