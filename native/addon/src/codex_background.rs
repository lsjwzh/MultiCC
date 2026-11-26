use crate::{
    js_bridge::{read_value, write_value},
    js_live::LiveValue as L,
};
use multicc_core::{codex_background::Background, js::JsValue as V};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::cell::RefCell;

#[napi]
pub struct RustCodexBackground {
    state: RefCell<Background>,
}
#[napi]
impl RustCodexBackground {
    #[napi(constructor)]
    pub fn new(env: Env, main: Unknown<'_>, throttle: f64, attach: bool) -> Result<Self> {
        let main = L::new(&env, main);
        let main = unsafe { read_value(main.env(), main.raw(), 0, &mut Vec::new()) }?;
        Ok(Self {
            state: RefCell::new(Background::new(main, throttle, attach)),
        })
    }
    #[napi]
    pub fn call(
        &self,
        env: Env,
        op: String,
        value: Unknown<'_>,
        index: f64,
        now: f64,
        failed: bool,
    ) -> Result<sys::napi_value> {
        let anchor = L::new(&env, value);
        // Fully read the host value before borrowing state: getters may reenter.
        let value = unsafe { read_value(anchor.env(), anchor.raw(), 0, &mut Vec::new()) }?;
        let (result, effects) = {
            let mut state = self.state.borrow_mut();
            let result = match op.as_str() {
                "consume" => state.consume(&value, now),
                "timer" => {
                    state.fire(index as u64, now);
                    V::Undefined
                }
                "attached" => {
                    state.attached(index as usize, &value, failed, now);
                    V::Undefined
                }
                "main" => {
                    state.set_main(value);
                    V::Undefined
                }
                "dispose" => {
                    state.dispose();
                    V::Undefined
                }
                "count" => V::Number(state.active_count() as f64),
                _ => {
                    return Err(napi::Error::from_reason(
                        "unknown_codex_background_operation",
                    ))
                }
            };
            (result, state.effects())
        };
        let output = V::object(vec![("result", result), ("effects", V::Array(effects))]);
        unsafe { write_value(anchor.env(), &output) }
    }
}
#[napi]
pub fn codex_background_text(
    env: Env,
    op: String,
    value: Unknown<'_>,
    limit: Unknown<'_>,
) -> Result<sys::napi_value> {
    let anchor = L::new(&env, value);
    let value = if op == "safe" {
        let value = if anchor.truthy()? {
            anchor
        } else {
            anchor.from_value(&V::from(""))?
        };
        V::String(
            value
                .global()?
                .get(c"String")?
                .call_plain(&[value])?
                .coerce_string()?,
        )
    } else {
        unsafe { read_value(anchor.env(), anchor.raw(), 0, &mut Vec::new()) }?
    };
    let output = match op.as_str() {
        "safe" => {
            let text = multicc_core::codex_background::safe_text(&value, usize::MAX);
            let limit = L::new(&env, limit).number()?;
            let end = if limit < 0.0 {
                text.len().saturating_sub((-limit).trunc() as usize)
            } else {
                limit as usize
            };
            text.truncate_units(end)
        }
        "command" => multicc_core::codex_background::unwrap_command(&value),
        "detail" => multicc_core::codex_background::tool_detail(&value),
        _ => {
            return Err(napi::Error::from_reason(
                "unknown_codex_background_text_operation",
            ))
        }
    };
    unsafe { write_value(anchor.env(), &V::String(output)) }
}

mod host {
    use super::*;
    use crate::host_methods::{arg, default_object, env, function, raw};
    use crate::route_response::{call, fields, null, num, text};
    use napi::bindgen_prelude::FromNapiValue;
    use std::{ffi::CStr, rc::Rc};

    fn numeric(value: L<'_>) -> Result<f64> {
        unsafe { f64::from_napi_value(value.env(), value.raw()) }
    }
    fn dispatch<'a>(
        owner: Rc<RustCodexBackground>,
        ports: L<'a>,
        op: &str,
        value: L<'a>,
        index: f64,
        failed: bool,
    ) -> Result<L<'a>> {
        let now = numeric(ports.get(c"now")?.call_plain(&[])?)?;
        let plan = raw(
            ports,
            owner.call(env(ports), op.to_owned(), arg(value)?, index, now, failed)?,
        );
        plan.get(c"effects")?.for_each(|effect| {
            let kind = effect.get(c"kind")?;
            let timers = ports.get(c"timers")?;
            if kind.is_string("emit")? {
                ports.get(c"emit")?.call_plain(&[effect.get(c"event")?])?;
            } else if kind.is_string("cancel")? {
                let id = effect.get(c"id")?;
                ports
                    .get(c"clearTimer")?
                    .call_plain(&[timers.get_key(id)?])?;
                call(
                    ports.global()?.get(c"Reflect")?,
                    c"deleteProperty",
                    &[timers, id],
                )?;
            } else if kind.is_string("timer")? {
                let id = effect.get(c"id")?;
                let state = fields(ports, &[("ports", ports), ("id", id)])?;
                let owner = owner.clone();
                let timer = function(state, "", 0, 0, move |s, _| {
                    let p = s.get(c"ports")?;
                    let id = s.get(c"id")?;
                    call(
                        p.global()?.get(c"Reflect")?,
                        c"deleteProperty",
                        &[p.get(c"timers")?, id],
                    )?;
                    dispatch(owner.clone(), p, "timer", null(p)?, numeric(id)?, false)?;
                    p.from_value(&V::Undefined)
                })?;
                let handle = ports
                    .get(c"setTimer")?
                    .call_plain(&[timer, effect.get(c"delay")?])?;
                timers.set_key(id, handle)?;
                let unref = handle.optional(c"unref")?;
                if !unref.nullish()? {
                    unref.call(handle, &[])?;
                }
            } else if kind.is_string("attach")? {
                let state = fields(ports, &[("ports", ports), ("effect", effect)])?;
                let start = function(state, "", 0, 0, |s, _| {
                    s.get(c"ports")?
                        .get(c"attach")?
                        .call_plain(&[s.get(c"effect")?.get(c"id")?])
                })?;
                let continuation = |failed| {
                    let owner = owner.clone();
                    function(state, "", if failed { 0 } else { 1 }, 1, move |s, a| {
                        let p = s.get(c"ports")?;
                        dispatch(
                            owner.clone(),
                            p,
                            "attached",
                            if failed { null(p)? } else { a[0] },
                            numeric(s.get(c"effect")?.get(c"agent")?)?,
                            failed,
                        )
                    })
                };
                let begin = call(ports.global()?.get(c"Promise")?, c"resolve", &[])?;
                let attach = call(begin, c"then", &[start])?;
                let notified = call(attach, c"then", &[continuation(false)?])?;
                call(notified, c"catch", &[continuation(true)?])?;
            }
            Ok(())
        })?;
        plan.get(c"result")
    }
    #[napi]
    pub fn create_codex_background_events(e: Env, options: Unknown<'_>) -> Result<sys::napi_value> {
        let opts = default_object(L::new(&e, options))?;
        let global = opts.global()?;
        let read = |key| crate::js_iteration::read(opts, key);
        fn default<'a>(
            opts: L<'a>,
            key: &CStr,
            alt: impl FnOnce() -> Result<L<'a>>,
        ) -> Result<L<'a>> {
            let value = crate::js_iteration::read(opts, key)?;
            if value.undefined()? {
                alt()
            } else {
                Ok(value)
            }
        }
        let emit = read(c"emit")?;
        let attach = read(c"attach")?;
        let main = default(opts, c"mainThreadId", || null(opts))?;
        let now = default(opts, c"now", || global.get(c"Date")?.get(c"now"))?;
        let set = default(opts, c"setTimer", || global.get(c"setTimeout"))?;
        let clear = default(opts, c"clearTimer", || global.get(c"clearTimeout"))?;
        let throttle = numeric(default(opts, c"throttleMs", || num(opts, 1000.))?)?;
        let owner = Rc::new(RustCodexBackground::new(
            env(opts),
            arg(main)?,
            throttle,
            attach.truthy()?,
        )?);
        let p = fields(
            opts,
            &[
                ("emit", emit),
                ("attach", attach),
                ("now", now),
                ("setTimer", set),
                ("clearTimer", clear),
                ("timers", opts.from_value(&V::Array(vec![]))?),
            ],
        )?;
        let api = fields(opts, &[])?;
        for (name, op, count) in [
            ("consume", "consume", 1),
            ("activeCount", "count", 0),
            ("setMainThread", "main", 1),
            ("dispose", "dispose", 0),
        ] {
            let owner = owner.clone();
            api.set_key(
                text(opts, name)?,
                function(p, name, count, count, move |p, a| {
                    dispatch(
                        owner.clone(),
                        p,
                        op,
                        if count == 0 { null(p)? } else { a[0] },
                        0.,
                        false,
                    )
                })?,
            )?;
        }
        Ok(api.raw())
    }
}
