//! Launch policy for the Gemini and Grok ACP agents. Option values remain
//! live through the ABI so a model is passed to argv without stringifying it.
use crate::{js_iteration::read, js_live::LiveValue as L};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn acp_launch_args(env: Env, lane: String, options: Unknown<'_>) -> Result<sys::napi_value> {
    let options = L::new(&env, options);
    let prefix: &[&str] = match lane.as_str() {
        "gemini" => &["--experimental-acp", "--yolo"],
        "grok" => &["agent", "--no-leader", "--always-approve"],
        _ => return Err(options.type_error("Unknown ACP launch policy")),
    };
    let mut args = prefix
        .iter()
        .map(|s| options.from_value(&V::from(*s)))
        .collect::<Result<Vec<_>>>()?;
    let mut option = |key, flag: &str| -> Result<()> {
        if read(options, key)?.truthy()? {
            args.push(options.from_value(&V::from(flag))?);
            args.push(read(options, key)?);
        }
        Ok(())
    };
    option(c"rawModel", "-m")?;
    if lane == "grok" {
        option(c"rawEffort", "--reasoning-effort")?;
        args.push(options.from_value(&V::from("stdio"))?);
    }
    let result = options.from_value(&V::Array(vec![]))?;
    for (i, arg) in args.into_iter().enumerate() {
        result.set_element(i as u32, arg)?;
    }
    Ok(result.raw())
}

#[napi]
pub fn acp_launch_terminal(
    env: Env,
    cmd: Unknown<'_>,
    session: Unknown<'_>,
    append: Unknown<'_>,
) -> Result<sys::napi_value> {
    let mut cmd = L::new(&env, cmd);
    let session = L::new(&env, session);
    let append = L::new(&env, append);
    for (key, flag) in [(c"model", "-m"), (c"cliSessionId", "--resume")] {
        if read(session, key)?.truthy()? {
            cmd =
                append.call_plain(&[cmd, cmd.from_value(&V::from(flag))?, read(session, key)?])?;
        }
    }
    Ok(cmd.raw())
}
