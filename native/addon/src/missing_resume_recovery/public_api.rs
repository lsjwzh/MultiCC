//! V8 supplies the live input and Error class. The recovery operations are
//! chosen at construction and call the same typed kernel as the wire API.
use crate::{
    host_methods::default_object,
    js_live::{fields, LiveValue as L},
    route_response::{call, flag, num, text},
};
use multicc_core::missing_resume_recovery::{self as recovery, Operation};
use napi::{
    bindgen_prelude::{JsValue as _, ToNapiValue, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;

fn zero_if_absent(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        num(value, 0.)
    } else {
        Ok(value)
    }
}

fn payload(input: L<'_>, op: Operation) -> Result<L<'_>> {
    if matches!(op, Operation::ClassifyResult) {
        return fields(input, &[("event", input)]);
    }
    let options = default_object(input)?;
    if options.nullish()? {
        let first = match op {
            Operation::Decide => "event",
            Operation::ProbeTranscript => "sessionId",
            Operation::ResumePlan => "cli",
            Operation::ClassifyResult => unreachable!(),
        };
        return Err(options.type_error(&format!("Cannot destructure property '{first}' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.")));
    }
    match op {
        Operation::Decide => fields(
            options,
            &[
                ("event", options.get(c"event")?),
                (
                    "lastSpawnWasResume",
                    flag(options, options.get(c"lastSpawnWasResume")?.is_true()?)?,
                ),
                (
                    "forwardedEventCount",
                    zero_if_absent(options.get(c"forwardedEventCount")?)?,
                ),
                ("attempt", zero_if_absent(options.get(c"attempt")?)?),
            ],
        ),
        Operation::ProbeTranscript => fields(
            options,
            &[
                ("sessionId", options.get(c"sessionId")?),
                ("configDir", options.get(c"configDir")?),
            ],
        ),
        Operation::ResumePlan => fields(
            options,
            &[
                ("cli", options.get(c"cli")?),
                ("turnCount", options.get(c"turnCount")?),
                (
                    "hasNativeSession",
                    flag(options, options.get(c"hasNativeSession")?.is_true()?)?,
                ),
                ("sessionId", options.get(c"sessionId")?),
                ("configDir", options.get(c"configDir")?),
            ],
        ),
        Operation::ClassifyResult => unreachable!(),
    }
}

#[napi]
pub fn missing_resume_recovery_api(env: Env, error_class: Unknown<'_>) -> Result<sys::napi_value> {
    let error = L::new(&env, error_class);
    let catalog = call(
        error.global()?.get(c"JSON")?,
        c"parse",
        &[text(
            error,
            &recovery::catalog().map_err(napi::Error::from_reason)?,
        )?],
    )?
    .freeze()?;
    let api = fields(
        error,
        &[
            ("CATALOG", catalog),
            ("OPS", catalog.get(c"ops")?.freeze()?),
            ("ACTIONS", catalog.get(c"actions")?.freeze()?),
            ("EVIDENCE", catalog.get(c"evidence")?.freeze()?),
            ("REASONS", catalog.get(c"reasons")?.freeze()?),
            ("MissingResumeRecoveryError", error),
        ],
    )?;
    for (name, op, length) in [
        ("classifyMissingResumeResult", Operation::ClassifyResult, 1.),
        ("decideMissingResume", Operation::Decide, 0.),
        ("probeTranscript", Operation::ProbeTranscript, 0.),
        ("resumePlan", Operation::ResumePlan, 0.),
    ] {
        let function = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            name,
            move |ctx| {
                let input = if ctx.length() == 0 {
                    ().into_unknown(ctx.env)?
                } else {
                    ctx.get(0)?
                };
                let input = payload(L::new(ctx.env, input), op)?;
                let value = unsafe {
                    crate::js_bridge::read_value(input.env(), input.raw(), 0, &mut Vec::new())
                }?;
                let output = op.evaluate_value(&value);
                Ok(input.from_value(&output)?.raw())
            },
        )?;
        let function = L::new(&env, function.into_unknown(&env)?);
        call(
            error.global()?.get(c"Object")?,
            c"defineProperty",
            &[
                function,
                text(error, "length")?,
                fields(error, &[("value", num(error, length)?)])?,
            ],
        )?;
        api.define_key(text(error, name)?, function)?;
    }
    Ok(api.raw())
}
