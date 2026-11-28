//! FIFO admission, ICU ordering and lifecycle of a task read model on its V8 thread.
use super::RustTaskReadModel;
use crate::host_api::*;
use napi::bindgen_prelude::{AsyncTask, ToNapiValue};
use napi_derive::napi;

fn reject<'a>(s: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    call(s.global()?.get(c"Promise")?, c"reject", &[reason])
}

fn dispatch<'a>(s: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let frame = fields(s, &[("run", s.get(c"run")?), ("input", input)])?;
    let start = function(frame, "", 0, 0, |f, _| {
        f.get(c"run")?.call_plain(&[f.get(c"input")?])
    })?;
    s.get(c"queue")?.call_plain(&[start])
}
fn invoke<'a>(s: L<'a>, input: L<'a>) -> Result<L<'a>> {
    then(dispatch(s, input)?, s, |s, reply| {
        json_call(s, c"parse", reply[0].get(c"result")?)
    })
}
fn retry<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let message = fold_string(a[0].get(c"message")?)?;
    if !message.contains("read_model_identity_order_required")
        && !message.contains("read_model_identity_order_stale")
    {
        return Err(a[0].throw_error());
    }
    let command = f.get(c"command")?;
    let air = command.get(c"op")?.is_string("air")?;
    let query = if air {
        let nested = command.get(c"command")?;
        let ids = pick(nested, &[c"snapshot", c"partial", c"removed"])?;
        ids.set(c"op", text(f, "identities")?)?;
        json_call(
            f,
            c"stringify",
            fields(f, &[("op", text(f, "air")?), ("command", ids)])?,
        )?
    } else {
        text(f, r#"{"op":"identities"}"#)?
    };
    then(invoke(f.get(c"state")?, query)?, f, |f, a| {
        let s = f.get(c"state")?;
        let cmp = function(f, "", 2, 2, |_, values| {
            call(values[0], c"localeCompare", &[values[1]])
        })?;
        let order = call(a[0].get(c"ids")?, c"sort", &[cmp])?;
        let command = f.get(c"command")?;
        if command.get(c"op")?.is_string("air")? {
            let nested = command.get(c"command")?;
            let days = nested.get(c"dayStarts")?;
            nested.delete(c"idOrder")?;
            nested.delete(c"dayStarts")?;
            if days.truthy()? {
                nested.set(c"dayStarts", days)?;
            }
            nested.set(c"idOrder", order)?;
        } else {
            s.set(c"idOrder", order)?;
            command.set(c"idOrder", order)?;
        }
        invoke(s, json_call(f, c"stringify", command)?)
    })
}
fn execute<'a>(f: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let s = f.get(c"state")?;
    let mut input = f.get(c"input")?;
    let command = json_call(f, c"parse", input)?;
    let op = command.optional(c"op")?;
    let air_write = op.is_string("air")? && {
        let inner = command.get(c"command")?.optional(c"op")?;
        inner.is_string("apply")? || inner.is_string("publish")?
    };
    let refresh = op.is_string("refresh")?;
    if air_write || refresh || op.is_string("sync")? {
        if refresh {
            let order = s.get(c"idOrder")?;
            if order.truthy()? {
                command.set(c"idOrder", order)?;
                input = json_call(f, c"stringify", command)?;
            }
        }
        f.set(c"command", command)?;
        return recover(async_result(f, || invoke(s, input))?, f, retry);
    }
    let reply = invoke(s, input)?;
    if op.is_string("open")? {
        return then(reply, s, |s, a| {
            s.set(c"idOrder", undef(s)?)?;
            Ok(a[0])
        });
    }
    Ok(reply)
}
fn run<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if s.get(c"closing")?.truthy()? || s.get(c"closed")?.truthy()? {
        return reject(s, error_value(s, "read_model_closed")?);
    }
    if a[0].optional(c"op")?.is_string("close")? {
        return close(s, &mut []);
    }
    if s.get(c"pending")?.number()? >= s.get(c"maxPending")?.number()? {
        return reject(s, error_value(s, "read_model_queue_full")?);
    }
    let input = match json_call(s, c"stringify", a[0]) {
        Ok(value) => value,
        Err(err) => {
            return match s.exception_value()? {
                Some(reason) => reject(s, reason),
                None => Err(err),
            }
        }
    };
    let frame = fields(s, &[("state", s), ("input", input)])?;
    s.set(c"pending", num(s, s.get(c"pending")?.number()? + 1.)?)?;
    let result = then(s.get(c"tail")?, frame, execute)?;
    let release = function(s, "", 0, 0, |s, _| {
        s.set(c"pending", num(s, s.get(c"pending")?.number()? - 1.)?)?;
        undef(s)
    })?;
    let settled = call(result, c"finally", &[release])?;
    let ignore = s.get(c"ignore")?;
    s.set(c"tail", call(settled, c"then", &[ignore, ignore])?)?;
    Ok(settled)
}
fn close<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let prior = s.get(c"closePromise")?;
    if prior.truthy()? {
        return Ok(prior);
    }
    s.set(c"closing", flag(s, true)?)?;
    let job = then(s.get(c"tail")?, s, |s, _| {
        dispatch(s, text(s, r#"{"op":"close"}"#)?)
    })?;
    let result = then(job, s, |s, a| {
        s.set(c"closed", flag(s, true)?)?;
        json_call(s, c"parse", a[0].get(c"result")?)
    })?;
    let done = recover(result, s, |s, a| {
        s.set(c"closing", flag(s, false)?)?;
        s.set(c"closePromise", undef(s)?)?;
        Err(a[0].throw_error())
    })?;
    s.set(c"closePromise", done)?;
    Ok(done)
}
fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let addon = with_default(opts.get(c"addon")?, p.get(c"addon")?)?;
    let max = with_default(opts.get(c"maxPending")?, num(p, 16.)?)?;
    let ctor = addon.optional(c"RustTaskReadModel")?;
    if !callable(ctor)? {
        return Err(error_value(p, "read_model_backend_unavailable")?.throw_error());
    }
    if max.kind()? != sys::ValueType::napi_number
        || !(1. ..=16.).contains(&max.number()?)
        || max.number()?.fract() != 0.
    {
        return Err(error_value(p, "read_model_invalid_queue_limit")?.throw_error());
    }
    let reader = if ctor.equals(p.get(c"Owner")?)? {
        let model = RustTaskReadModel::new();
        function(p, "run", 1, 1, move |p, a| {
            let job = model.run(fold_string(a[0])?);
            let promise = unsafe { AsyncTask::to_napi_value(p.env(), job) }?;
            Ok(L::from_raw(p.env(), promise))
        })?
    } else {
        let injected = ctor.construct(&[])?;
        function(injected, "run", 1, 1, |reader, a| call(reader, c"run", a))?
    };
    let s = fields(
        p,
        &[
            ("run", reader),
            ("queue", p.get(c"runNative")?),
            ("maxPending", max),
            ("pending", num(p, 0.)?),
            ("tail", resolved(undef(p)?)?),
            ("ignore", function(p, "", 0, 0, |p, _| undef(p))?),
        ],
    )?;
    methods(s, &[("run", 1, run), ("close", 0, close)])
}
#[napi]
pub fn task_read_model_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(defaulted_methods(p, &[("createTaskReadModel", 0, 1, create)])?.raw())
}
