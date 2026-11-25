use multicc_core::cli_switch;
use napi::Result;
use napi::{bindgen_prelude::AsyncTask, Env, Task};
use napi_derive::napi;

pub struct PrepareRoute {
    input: String,
}

impl Task for PrepareRoute {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        multicc_core::cli_switch_route::request(&self.input).map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[napi]
pub fn prepare_cli_switch_route(input: String) -> AsyncTask<PrepareRoute> {
    AsyncTask::new(PrepareRoute { input })
}

/// Supported chat CLI list (the JS module freezes it at load).
#[napi]
pub fn cli_switch_catalog() -> Result<String> {
    cli_switch::catalog().map_err(napi::Error::from_reason)
}

/// One JSON-in/JSON-out entry for active state, activation, summary, clear
/// planning, message text, checkpoint building and prompt rendering.
/// `cli_switch::request` parses the boundary payload with
/// `multicc_core::json_lenient::from_str`.
#[napi]
pub fn cli_switch_request(op: String, input: String) -> Result<String> {
    cli_switch::request(&op, &input).map_err(napi::Error::from_reason)
}

/// Merge the host home before the caller's own enumerable properties, as the
/// old JS entry did. The filesystem operation still runs on the Rust worker.
#[napi]
pub fn prepare_host_switch_route(
    env: Env,
    input: napi::bindgen_prelude::Unknown<'_>,
    home: napi::bindgen_prelude::Unknown<'_>,
) -> Result<AsyncTask<PrepareRoute>> {
    use crate::js_live::{fields, LiveValue as L};
    use napi::bindgen_prelude::FromNapiValue;
    let input = L::new(&env, input);
    let json = input.global()?.get(c"JSON")?;
    let stringify = json.get(c"stringify")?;
    let args = fields(input, &[("homeDir", L::new(&env, home))])?;
    args.spread_from(input)?;
    let raw = stringify.call(json, &[args])?;
    Ok(prepare_cli_switch_route(unsafe {
        String::from_napi_value(env.raw(), raw.raw())
    }?))
}

#[napi]
pub fn codex_profile_route_failure(
    env: Env,
    cause: napi::bindgen_prelude::Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    use crate::js_live::LiveValue as L;
    use multicc_core::js::JsValue as V;
    let cause = L::new(&env, cause);
    if !cause.truthy()? {
        return Ok(cause.raw());
    }
    if cause.get(c"code")?.kind()? != napi::sys::ValueType::napi_string {
        return Ok(cause.raw());
    }
    let code = cause.get(c"code")?;
    let Some(code_text) = code.string()? else {
        return Ok(cause.raw());
    };
    let text = code_text.to_string_lossy();
    if !text.starts_with("CODEX_SESSION_") {
        return Ok(cause.raw());
    }
    let message = match text.as_str() {
        "CODEX_SESSION_ROLLOUT_AMBIGUOUS" => {
            "Codex 原生会话历史存在多份副本，无法安全切换线路；请先清理重复的 rollout 文件。"
        }
        "CODEX_SESSION_ROUTE_SOURCE_CHANGED" => "Codex 会话历史在切换期间发生变化，请重试。",
        "CODEX_SESSION_ROLLOUT_RACE" => "Codex 会话历史在迁移期间发生并发变更，请重试。",
        _ => "Codex 会话历史校验失败，无法切换线路。",
    };
    let error = cause
        .global()?
        .get(c"Error")?
        .construct(&[cause.from_value(&message.into())?])?;
    error.set(c"code", code)?;
    error.set(c"status", cause.from_value(&V::Number(409.0))?)?;
    error.set(c"safe", cause.from_value(&V::Bool(true))?)?;
    error.set(c"cause", cause)?;
    Ok(error.raw())
}
