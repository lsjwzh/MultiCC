//! The transport awaits inject(); Rust owns deduplication and settlement.
use crate::js_live::LiveValue as L;
use multicc_core::{
    auto_provider_handoff::Handoffs,
    js::{JsString, JsValue as V},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{cell::RefCell, ffi::CStr};

fn text<'a>(anchor: L<'a>, value: &str) -> Result<L<'a>> {
    anchor.from_value(&V::from(value))
}
fn object<'a>(anchor: L<'a>, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
    let value = anchor.from_value(&V::Object(vec![]))?;
    for (key, field) in fields {
        value.set(key, *field)?;
    }
    Ok(value)
}
fn or<'a>(value: L<'a>, next: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        next()
    }
}
fn result<'a>(
    anchor: L<'a>,
    scheduled: bool,
    reason: L<'a>,
    fields: &[(&CStr, L<'a>)],
) -> Result<L<'a>> {
    let value = object(
        anchor,
        &[
            (c"scheduled", anchor.from_value(&V::Bool(scheduled))?),
            (c"reason", reason),
        ],
    )?;
    for (key, field) in fields {
        value.set(key, *field)?;
    }
    value.freeze()
}
fn concat<'a>(anchor: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut output = JsString::new();
    for value in parts {
        output.push(&value.coerce_string()?);
    }
    anchor.from_value(&V::String(output))
}
fn log<'a>(
    ports: L<'a>,
    method: &CStr,
    event: &str,
    fields: impl FnOnce() -> Result<L<'a>>,
) -> Result<()> {
    let logger = ports.get(c"logger")?;
    if logger.nullish()? {
        fields()?;
        return Ok(());
    }
    let callback = logger.get(method)?;
    if !callback.nullish()? {
        callback.call(logger, &[text(logger, event)?, fields()?])?;
    }
    Ok(())
}

#[napi]
pub fn auto_provider_handoff_ports(env: Env, options: Unknown<'_>) -> Result<sys::napi_value> {
    let options = L::new(&env, options);
    let inject = options.get(c"inject")?;
    if inject.kind()? != sys::ValueType::napi_function {
        return Err(options.type_error("[auto-provider-handoff] inject port is required"));
    }
    let background = options.get(c"hasLiveBackgroundTasks")?;
    let background = if background.kind()? == sys::ValueType::napi_function {
        options.get(c"hasLiveBackgroundTasks")?
    } else {
        options.from_value(&V::Null)?
    };
    let logger = or(options.get(c"logger")?, || options.from_value(&V::Null))?;
    Ok(object(
        options,
        &[
            (c"inject", inject),
            (c"background", background),
            (c"logger", logger),
        ],
    )?
    .raw())
}

#[napi]
#[derive(Default)]
pub struct RustAutoProviderHandoff {
    state: RefCell<Handoffs>,
}

#[napi]
impl RustAutoProviderHandoff {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn prepare(
        &self,
        env: Env,
        input: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let input = L::new(&env, input);
        let ports = L::new(&env, ports);
        let session = input.get(c"sessionId")?;
        let turn = input.get(c"turnId")?;
        let preparation = input.get(c"preparation")?;
        let lineage = input.get(c"lineage")?;
        let session = session.clean_text()?;
        let turn = turn.clean_text()?;
        let done = |reason| -> Result<sys::napi_value> {
            Ok(object(
                input,
                &[
                    (c"done", input.from_value(&V::Bool(true))?),
                    (c"result", result(input, false, text(input, reason)?, &[])?),
                ],
            )?
            .raw())
        };
        if !session.truthy()?
            || !turn.truthy()?
            || !preparation.optional(c"providerId")?.truthy()?
        {
            return done("handoff_not_prepared");
        }
        let background = ports.get(c"background")?;
        if background.truthy()? {
            let active = ports
                .catch(|| background.call_plain(&[session])?.is_true())?
                .unwrap_or(true);
            if active {
                return done("background_tasks_active");
            }
        }
        let key = concat(input, &[text(input, "auto-provider-handoff:")?, turn])?;
        let key_string = key.coerce_string()?;
        if self.state.borrow().contains(&key_string) {
            return Ok(object(
                input,
                &[
                    (c"done", input.from_value(&V::Bool(true))?),
                    (
                        c"result",
                        result(
                            input,
                            false,
                            text(input, "duplicate")?,
                            &[(c"idempotencyKey", key)],
                        )?,
                    ),
                ],
            )?
            .raw());
        }
        self.state
            .borrow_mut()
            .remember(key_string, session.coerce_string()?);
        let from = or(preparation.get(c"fromProviderName")?.clean_text()?, || {
            text(input, "上一个 Provider")
        })?;
        let to = or(preparation.get(c"providerName")?.clean_text()?, || {
            preparation.get(c"providerId")?.clean_text()
        })?;
        let lane = if preparation.get(c"cli")?.clean_text()?.truthy()? {
            concat(
                input,
                &[
                    text(input, "（切换到 ")?,
                    preparation.get(c"cli")?.clean_text()?,
                    text(input, " CLI）")?,
                ],
            )?
        } else {
            text(input, "")?
        };
        let message = concat(
            input,
            &[
                from,
                text(input, " 因上游限额或接口错误中断。请由 ")?,
                to,
                lane,
                text(
                    input,
                    " 基于已有对话和工具结果继续剩余任务；不要重复已经完成的操作。",
                )?,
            ],
        )?;
        let metadata = object(
            input,
            &[
                (c"originContinue", input.from_value(&V::Bool(true))?),
                (c"clientMsgId", key),
                (c"idempotencyKey", key),
                (c"taskSource", text(input, "auto_provider_handoff")?),
            ],
        )?;
        if lineage.optional(c"kind")?.is_string("dispatch")?
            && lineage.get(c"operationId")?.truthy()?
        {
            metadata.set(c"originDispatchId", lineage.get(c"operationId")?)?;
        }
        if lineage.optional(c"kind")?.is_string("trigger")? {
            metadata.set(c"originTrigger", input.from_value(&V::Bool(true))?)?;
        }
        let args = input.from_value(&V::Array(vec![]))?;
        for (i, value) in [
            session,
            message,
            input.from_value(&V::Number(0.0))?,
            metadata,
        ]
        .iter()
        .enumerate()
        {
            args.set_element(i as u32, *value)?;
        }
        Ok(object(
            input,
            &[
                (c"done", input.from_value(&V::Bool(false))?),
                (c"sessionId", session),
                (c"turnId", turn),
                (c"key", key),
                (c"preparation", preparation),
                (c"args", args),
            ],
        )?
        .raw())
    }

    #[napi]
    pub fn finish(
        &self,
        env: Env,
        plan: Unknown<'_>,
        admitted: Unknown<'_>,
        fault: Unknown<'_>,
        caught: bool,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let plan = L::new(&env, plan);
        let admitted = L::new(&env, admitted);
        let fault = L::new(&env, fault);
        let ports = L::new(&env, ports);
        let session = plan.get(c"sessionId")?;
        let turn = plan.get(c"turnId")?;
        let key = plan.get(c"key")?;
        let preparation = plan.get(c"preparation")?;
        let settlement = (|| -> Result<Option<L<'_>>> {
            if caught {
                return Ok(Some(fault));
            }
            if admitted.is_false()?
                || admitted.optional(c"ok")?.is_false()?
                || admitted.nullish()?
            {
                let code = or(admitted.optional(c"code")?, || text(plan, "inject_failed"))?;
                return Ok(Some(object(plan, &[(c"code", code)])?));
            }
            log(ports, c"info", "auto_provider_handoff_scheduled", || {
                object(
                    plan,
                    &[
                        (c"sessionId", session),
                        (c"turnId", turn),
                        (
                            c"fromProviderId",
                            or(preparation.get(c"fromProviderId")?, || {
                                plan.from_value(&V::Null)
                            })?,
                        ),
                        (c"toProviderId", preparation.get(c"providerId")?),
                    ],
                )
            })?;
            Ok(None)
        })();
        let failure = match settlement {
            Ok(failure) => failure,
            Err(error) => Some(plan.exception_value()?.ok_or(error)?),
        };
        if let Some(failure) = failure {
            self.state.borrow_mut().forget(&key.coerce_string()?);
            let code = or(failure.optional(c"code")?.clean_text()?, || {
                text(plan, "inject_failed")
            })?;
            log(ports, c"warn", "auto_provider_handoff_failed", || {
                object(
                    plan,
                    &[(c"sessionId", session), (c"turnId", turn), (c"code", code)],
                )
            })?;
            return Ok(result(plan, false, text(plan, "inject_failed")?, &[])?.raw());
        }
        Ok(result(
            plan,
            true,
            or(preparation.get(c"reasonCode")?, || {
                text(plan, "unsafe_replay_boundary")
            })?,
            &[
                (c"idempotencyKey", key),
                (c"providerId", preparation.get(c"providerId")?),
            ],
        )?
        .raw())
    }

    #[napi]
    pub fn clear_session(&self, env: Env, session: Unknown<'_>) -> Result<()> {
        let session = L::new(&env, session);
        if let Some(session) = session.string()? {
            self.state.borrow_mut().clear_session(&session);
        }
        Ok(())
    }
}

#[napi]
pub fn create_auto_provider_handoff(e: Env, options: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::host_methods::{arg, default_object, env, function, raw};
    use crate::route_response::{call, fields};
    use std::rc::Rc;
    let input = default_object(L::new(&e, options))?;
    let ports = raw(input, auto_provider_handoff_ports(env(input), arg(input)?)?);
    let owner = Rc::new(RustAutoProviderHandoff::new());
    let schedule = owner.clone();
    let schedule = function(ports, "schedule", 0, 1, move |p, a| {
        let promise = p.global()?.get(c"Promise")?;
        let undefined = p.from_value(&V::Undefined)?;
        let start = || -> Result<L<'_>> {
            let plan = raw(
                p,
                schedule.prepare(env(p), arg(default_object(a[0])?)?, arg(p)?)?,
            );
            if plan.get(c"done")?.truthy()? {
                return call(promise, c"resolve", &[plan.get(c"result")?]);
            }
            let state = fields(p, &[("plan", plan), ("ports", p)])?;
            let finish = |failed| {
                let owner = schedule.clone();
                function(state, "", 1, 1, move |s, a| {
                    let undefined = s.from_value(&V::Undefined)?;
                    Ok(raw(
                        s,
                        owner.finish(
                            env(s),
                            arg(s.get(c"plan")?)?,
                            arg(if failed { undefined } else { a[0] })?,
                            arg(if failed { a[0] } else { undefined })?,
                            failed,
                            arg(s.get(c"ports")?)?,
                        )?,
                    ))
                })
            };
            let injected = (|| {
                let mut args = Vec::new();
                plan.get(c"args")?.for_each(|v| {
                    args.push(v);
                    Ok(())
                })?;
                p.get(c"inject")?.call_plain(&args)
            })();
            match injected {
                Ok(value) => call(
                    call(promise, c"resolve", &[value])?,
                    c"then",
                    &[finish(false)?, finish(true)?],
                ),
                Err(error) => {
                    let cause = exception(p, error)?;
                    let result = raw(
                        p,
                        schedule.finish(
                            env(p),
                            arg(plan)?,
                            arg(undefined)?,
                            arg(cause)?,
                            true,
                            arg(p)?,
                        )?,
                    );
                    call(promise, c"resolve", &[result])
                }
            }
        };
        match start() {
            Ok(promise) => Ok(promise),
            Err(error) => call(promise, c"reject", &[exception(p, error)?]),
        }
    })?;
    Ok(fields(
        ports,
        &[
            ("schedule", schedule),
            (
                "clearSession",
                function(ports, "clearSession", 1, 1, move |p, a| {
                    owner.clear_session(env(p), arg(a[0])?)?;
                    p.from_value(&V::Undefined)
                })?,
            ),
        ],
    )?
    .freeze()?
    .raw())
}

fn exception(anchor: L<'_>, error: napi::Error) -> Result<L<'_>> {
    match anchor.exception_value()? {
        Some(cause) => Ok(cause),
        None => anchor
            .global()?
            .get(c"Error")?
            .construct(&[text(anchor, &error.reason)?]),
    }
}
