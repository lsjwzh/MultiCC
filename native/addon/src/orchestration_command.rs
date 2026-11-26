//! Only these native commands may run within a synchronous store transaction.
//! Keep draft, snapshot, arguments and thrown errors live across the call.
use crate::{js_iteration::read, js_live::LiveValue as L};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
#[napi]
pub fn orchestration_command(
    env: Env,
    addon: Unknown<'_>,
    name: Unknown<'_>,
    draft: Unknown<'_>,
    args: Unknown<'_>,
    snapshot: Unknown<'_>,
) -> Result<sys::napi_value> {
    let name = L::new(&env, name);
    let owner = L::new(&env, addon);
    let draft = L::new(&env, draft);
    Ok(invoke(
        owner,
        name,
        draft,
        L::new(&env, args),
        L::new(&env, snapshot),
    )?
    .raw())
}
fn invoke<'a>(
    owner: L<'a>,
    name: L<'a>,
    draft: L<'a>,
    args: L<'a>,
    snapshot: L<'a>,
) -> Result<L<'a>> {
    let (key, mut argv) = if name.is_string("waitResolve")? {
        (c"waitResolveLive", vec![draft])
    } else if name.is_string("outboxClaim")? {
        (c"outboxClaimLive", vec![snapshot, draft])
    } else {
        return Err(name.type_error("unknown synchronous orchestration command"));
    };
    // An explicitly injected host can implement either command. Production
    // dispatches directly to the Rust implementation in this callback scope.
    let injected = if owner.undefined()? {
        None
    } else {
        let command = read(owner, key)?;
        if command.kind()? != sys::ValueType::napi_function {
            return Err(napi::Error::from_reason(format!(
                "missing Rust orchestration command: {}",
                key.to_string_lossy()
            )));
        }
        Some(command)
    };
    args.for_each(|v| {
        argv.push(v);
        Ok(())
    })?;
    if let Some(command) = injected {
        return command.call(owner, &argv);
    }
    use crate::host_methods::{arg, env, raw};
    let undefined = draft.from_value(&multicc_core::js::JsValue::Undefined)?;
    let at = |i| arg(argv.get(i).copied().unwrap_or(undefined));
    let result = if key == c"waitResolveLive" {
        crate::wait_resolve_live::wait_resolve_live(
            env(draft),
            at(0)?,
            at(1)?,
            at(2)?,
            at(3)?,
            at(4)?,
            at(5)?,
            at(6)?,
            at(7)?,
        )?
    } else {
        crate::outbox_claim_live::outbox_claim_live(env(draft), at(0)?, at(1)?, at(2)?)?
    };
    Ok(raw(draft, result))
}

#[napi]
pub fn orchestration_command_sync(
    env: Env,
    addon: Unknown<'_>,
    name: Unknown<'_>,
    draft: Unknown<'_>,
    args: Unknown<'_>,
    snapshot: Unknown<'_>,
    promise_then: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = invoke(
        L::new(&env, addon),
        L::new(&env, name),
        L::new(&env, draft),
        L::new(&env, args),
        L::new(&env, snapshot),
    )?;
    let mut promise = false;
    napi::check_status!(unsafe { sys::napi_is_promise(raw.env(), raw.raw(), &mut promise) })?;
    if promise {
        let undef = raw.from_value(&multicc_core::js::JsValue::Undefined)?;
        let ignore = crate::host_methods::method(&env, undef, "", 0, 0, |s, _| Ok(s))?;
        L::new(&env, promise_then).call(raw, &[undef, ignore])?;
        return Err(raw.type_error("synchronous Rust orchestration command returned a promise"));
    }
    Ok(raw.raw())
}
#[napi]
pub fn command_envelope(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::route_response::*;
    let value = L::new(&env, value);
    let object = value.global()?.get(c"Object")?;
    let output = call(object, c"create", &[null(value)?])?;
    let descriptor = fields(
        value,
        &[("value", value), ("enumerable", flag(value, true)?)],
    )?;
    Ok(call(
        object,
        c"defineProperty",
        &[output, text(value, "value")?, descriptor],
    )?
    .raw())
}
