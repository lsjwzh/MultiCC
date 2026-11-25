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
    let (key, mut argv) = if name.is_string("waitResolve")? {
        (c"waitResolveLive", vec![draft])
    } else if name.is_string("outboxClaim")? {
        (c"outboxClaimLive", vec![L::new(&env, snapshot), draft])
    } else {
        return Err(name.type_error("unknown synchronous orchestration command"));
    };
    let command = read(owner, key)?;
    if command.kind()? != sys::ValueType::napi_function {
        return Err(napi::Error::from_reason(format!(
            "missing Rust orchestration command: {}",
            key.to_string_lossy()
        )));
    }
    L::new(&env, args).for_each(|v| {
        argv.push(v);
        Ok(())
    })?;
    Ok(command.call(owner, &argv)?.raw())
}
