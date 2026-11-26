//! Closing-child ownership and caller-specific deadlines over borrowed host
//! processes. A deadline never releases a child: only its exit does that.
use crate::{host_methods::method, js_iteration::read, route_response::*};
use napi_derive::napi;

fn undefined(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}

fn callback<'a>(
    owner: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let env = Env::from_raw(owner.env());
    let value = method(&env, owner, name, length, count, run)?;
    Ok(L::from_raw(owner.env(), value.raw()))
}

fn error<'a>(s: L<'a>, class: &std::ffi::CStr, message: &str, code: L<'a>) -> Result<L<'a>> {
    let value = s.global()?.get(class)?.construct(&[text(s, message)?])?;
    call(
        s.global()?.get(c"Object")?,
        c"assign",
        &[value, fields(s, &[("code", code)])?],
    )
}

fn values_array(value: L<'_>) -> Result<L<'_>> {
    let out = value.from_value(&V::Array(vec![]))?;
    let mut index = 0;
    value.for_each(|item| {
        out.define_key(text(out, &index.to_string())?, item)?;
        index += 1;
        Ok(())
    })?;
    Ok(out)
}

fn all_children<'a>(s: L<'a>, children: L<'a>) -> Result<L<'a>> {
    let values = if children.truthy()? {
        values_array(call(children, c"values", &[])?)?
    } else {
        s.from_value(&V::Array(vec![]))?
    };
    call(s.global()?.get(c"Promise")?, c"all", &[values])
}

fn track<'a>(s: L<'a>, name: L<'a>, proc: L<'a>) -> Result<L<'a>> {
    if !proc.truthy()?
        || read(proc, c"exitCode")?.kind()? != sys::ValueType::napi_null
        || !read(proc, c"signalCode")?.nullish()?
    {
        return undefined(s);
    }
    let closing = s.get(c"closing")?;
    let mut children = call(closing, c"get", &[name])?;
    if !children.truthy()? {
        children = s.global()?.get(c"Map")?.construct(&[])?;
        call(closing, c"set", &[name, children])?;
    }
    if call(children, c"has", &[proc])?.truthy()? {
        return undefined(s);
    }
    let state = fields(
        s,
        &[
            ("closing", closing),
            ("children", children),
            ("name", name),
            ("proc", proc),
        ],
    )?;
    let executor = callback(state, "", 1, 1, |s, a| {
        s.assign(c"finish", a[0])?;
        undefined(s)
    })?;
    let done = s.global()?.get(c"Promise")?.construct(&[executor])?;
    call(children, c"set", &[proc, done])?;
    state.set(
        c"exited",
        callback(state, "exited", 0, 0, |s, _| {
            let proc = s.get(c"proc")?;
            call(
                proc,
                c"removeListener",
                &[text(s, "exit")?, s.get(c"exited")?],
            )?;
            call(
                proc,
                c"removeListener",
                &[text(s, "error")?, s.get(c"failed")?],
            )?;
            let children = s.get(c"children")?;
            call(children, c"delete", &[proc])?;
            let closing = s.get(c"closing")?;
            let name = s.get(c"name")?;
            if !read(children, c"size")?.truthy()?
                && call(closing, c"get", &[name])?.equals(children)?
            {
                call(closing, c"delete", &[name])?;
            }
            s.get(c"finish")?.call_plain(&[])?;
            undefined(s)
        })?,
    )?;
    state.set(
        c"failed",
        callback(state, "failed", 0, 0, |s, _| {
            if !read(s.get(c"proc")?, c"pid")?.truthy()? {
                s.get(c"exited")?.call_plain(&[])?;
            }
            undefined(s)
        })?,
    )?;
    call(proc, c"once", &[text(s, "exit")?, state.get(c"exited")?])?;
    call(proc, c"once", &[text(s, "error")?, state.get(c"failed")?])?;
    undefined(s)
}

fn wait_step<'a>(s: L<'a>, name: L<'a>, stop: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = if options.undefined()? {
        fields(s, &[])?
    } else {
        options
    };
    let timeout = read(options, c"timeoutMs")?;
    let timeout = if timeout.undefined()? {
        s.get(c"defaultTimeout")?
    } else {
        timeout
    };
    let timeout = s.global()?.get(c"Number")?.call_plain(&[timeout])?;
    if !call(s.global()?.get(c"Number")?, c"isFinite", &[timeout])?.truthy()?
        || timeout.number()? < 1.0
    {
        let code = s.get(c"code")?;
        let code = s.from_value(&V::String(code.coerce_string()?))?;
        let code = call(code, c"concat", &[text(s, "_INVALID")?])?;
        return Err(error(s, c"TypeError", "valid close timeout required", code)?.throw_error());
    }
    crate::js_live::invoke(undefined(s)?, stop, &[], "stop")?;
    let children = call(s.get(c"closing")?, c"get", &[name])?;
    let had_process = !children.nullish()? && read(children, c"size")?.truthy()?;
    let result = fields(
        s,
        &[
            ("closed", flag(s, true)?),
            ("hadProcess", flag(s, had_process)?),
        ],
    )?;
    let step = fields(s, &[("value", result), ("code", s.get(c"code")?)])?;
    if !had_process {
        return Ok(step);
    }
    step.set(c"timer", undefined(s)?)?;
    step.set(
        c"finish",
        callback(step, "finish", 0, 0, |s, _| {
            s.global()?
                .get(c"clearTimeout")?
                .call_plain(&[s.get(c"timer")?])?;
            undefined(s)
        })?,
    )?;
    let pending = (|| {
        let all = all_children(s, children)?;
        let executor_state = fields(step, &[("step", step), ("timeout", timeout)])?;
        let executor = callback(executor_state, "", 2, 2, |s, a| {
            let step = s.get(c"step")?;
            let reject_state = fields(s, &[("reject", a[1]), ("code", step.get(c"code")?)])?;
            let reject = callback(reject_state, "", 0, 0, |s, _| {
                let error = error(
                    s,
                    c"Error",
                    "process did not exit before cleanup deadline",
                    s.get(c"code")?,
                )?;
                s.get(c"reject")?.call_plain(&[error])
            })?;
            let timer = s
                .global()?
                .get(c"setTimeout")?
                .call_plain(&[reject, s.get(c"timeout")?])?;
            step.assign(c"timer", timer)?;
            undefined(s)
        })?;
        let deadline = s.global()?.get(c"Promise")?.construct(&[executor])?;
        let list = s.from_value(&V::Array(vec![]))?;
        list.define_key(text(s, "0")?, all)?;
        list.define_key(text(s, "1")?, deadline)?;
        call(s.global()?.get(c"Promise")?, c"race", &[list])
    })();
    let pending = match pending {
        Ok(pending) => pending,
        Err(error) => {
            let original = s.exception_value()?;
            step.get(c"finish")?.call_plain(&[])?;
            return Err(original.map_or(error, |value| value.throw_error()));
        }
    };
    step.set(c"pending", pending)?;
    Ok(step)
}

#[napi]
pub fn process_closer_api(env: Env, async_wait: Unknown<'_>) -> Result<sys::napi_value> {
    let api = L::new(&env, async_wait);
    let create = callback(api, "createProcessCloser", 1, 1, |api, a| {
        if a[0].undefined()? {
            return Err(api.type_error(
                "Cannot destructure property 'timeoutMs' of 'undefined' as it is undefined.",
            ));
        }
        if a[0].kind()? == sys::ValueType::napi_null {
            return Err(api.type_error(
                "Cannot destructure property 'timeoutMs' of 'object null' as it is null.",
            ));
        }
        let default_timeout = read(a[0], c"timeoutMs")?;
        let code = read(a[0], c"code")?;
        let state = fields(
            api,
            &[
                ("defaultTimeout", default_timeout),
                ("code", code),
                ("closing", api.global()?.get(c"Map")?.construct(&[])?),
            ],
        )?;

        let wait_for_exit = callback(state, "wait", 2, 3, |s, a| {
            let step = wait_step(s, a[0], a[1], a[2])?;
            let pending = step.get(c"pending")?;
            if !pending.truthy()? {
                return step.get(c"value");
            }
            let done = callback(step, "", 0, 0, |s, _| {
                let value = s.get(c"value")?;
                s.get(c"finish")?.call_plain(&[])?;
                Ok(value)
            })?;
            let failed = callback(step, "", 1, 1, |s, a| {
                s.get(c"finish")?.call_plain(&[])?;
                Err(a[0].throw_error())
            })?;
            call(pending, c"then", &[done, failed])
        })?;
        let wait = api.call_plain(&[wait_for_exit])?;
        fields(
            api,
            &[
                (
                    "track",
                    callback(state, "track", 2, 2, |s, a| track(s, a[0], a[1]))?,
                ),
                ("wait", wait),
                (
                    "isClosing",
                    callback(state, "isClosing", 1, 1, |s, a| {
                        call(s.get(c"closing")?, c"has", &[a[0]])
                    })?,
                ),
                (
                    "drained",
                    callback(state, "drained", 1, 1, |s, a| {
                        let children = call(s.get(c"closing")?, c"get", &[a[0]])?;
                        all_children(s, children)
                    })?,
                ),
            ],
        )
    })?;
    Ok(fields(api, &[("createProcessCloser", create)])?.raw())
}
