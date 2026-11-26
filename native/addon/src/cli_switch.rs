use crate::js_live::LiveValue;
use multicc_core::{
    cli_switch,
    js::{coerce, JsValue as V},
};
use napi::{bindgen_prelude::AsyncTask, sys, Env, Result, Task};
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

fn read_live_value(value: LiveValue<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(value.env(), value.raw(), 0, &mut Vec::new()) }
}

pub(crate) struct CheckpointArgs {
    pub session: Option<V>,
    pub exclude_turn: Option<V>,
    pub max_messages: f64,
    pub max_chars: f64,
}

pub(crate) fn read_checkpoint_args(
    session: LiveValue<'_>,
    exclude_turn_id: LiveValue<'_>,
    max_messages: LiveValue<'_>,
    max_chars: LiveValue<'_>,
) -> Result<CheckpointArgs> {
    let session_val = if session.truthy()?
        && !session.is_array()?
        && session.kind()? == sys::ValueType::napi_object
    {
        let mut fields = Vec::new();
        for (name, c_name) in [("taskState", c"taskState"), ("summary", c"summary")] {
            let field = session.get(c_name)?;
            if !field.undefined()? {
                fields.push((name, read_live_value(field)?));
            }
        }
        Some(V::object(fields))
    } else {
        None
    };
    let exclude_turn = if exclude_turn_id.undefined()? || !exclude_turn_id.truthy()? {
        None
    } else {
        Some(read_live_value(exclude_turn_id)?)
    };
    let max_messages = if max_messages.undefined()? {
        cli_switch::DEFAULT_CHECKPOINT_MAX_MESSAGES
    } else {
        coerce::js_to_number(&read_live_value(max_messages)?)
    };
    let max_chars = if max_chars.undefined()? {
        cli_switch::DEFAULT_CHECKPOINT_MAX_CHARS
    } else {
        coerce::js_to_number(&read_live_value(max_chars)?)
    };
    Ok(CheckpointArgs {
        session: session_val,
        exclude_turn,
        max_messages,
        max_chars,
    })
}

pub(crate) fn checkpoint_live<'a>(
    session: LiveValue<'a>,
    history: LiveValue<'a>,
    exclude_turn_id: LiveValue<'a>,
    max_messages: LiveValue<'a>,
    max_chars: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let args = read_checkpoint_args(session, exclude_turn_id, max_messages, max_chars)?;
    let mut newest_first = Vec::new();
    if history.is_array()? {
        let len = history.get(c"length")?.number()? as u32;
        let limit = cli_switch::keep_limit(args.max_messages);
        let env = history.env();
        for index in (0..len).rev() {
            // 倒序直读尾部候选，仅在需要的那几条上读取 content/ts，不碰 tools 等无关大字段。
            let mut scope = std::ptr::null_mut();
            napi::check_status!(unsafe { sys::napi_open_handle_scope(env, &mut scope) })?;
            let result = (|| -> Result<bool> {
                let row = history.element(index)?;
                if !row.truthy()? {
                    return Ok(false);
                }
                let role = read_live_value(row.get(c"role")?)?;
                if !matches!(&role, V::String(r) if r == "user" || r == "assistant") {
                    return Ok(false);
                }
                if row.get(c"cliSwitch")?.truthy()? {
                    return Ok(false);
                }
                if let Some(excluded) = args.exclude_turn.as_ref() {
                    let turn_id = read_live_value(row.get(c"turnId")?)?;
                    if &turn_id == excluded {
                        return Ok(false);
                    }
                }
                let mut fields = vec![("role", role)];
                let content = row.get(c"content")?;
                if !content.undefined()? {
                    fields.push(("content", read_live_value(content)?));
                }
                let ts = row.get(c"ts")?;
                if !ts.undefined()? {
                    fields.push(("ts", read_live_value(ts)?));
                }
                newest_first.push(V::object(fields));
                Ok(limit.is_some_and(|max| newest_first.len() >= max))
            })();
            napi::check_status!(unsafe { sys::napi_close_handle_scope(env, scope) })?;
            if result? {
                break;
            }
        }
    }
    let built = cli_switch::checkpoint_from_newest_first(
        args.session.as_ref(),
        newest_first,
        args.max_chars,
    );
    history.from_value(&built)
}

#[napi]
pub fn cli_switch_checkpoint(
    env: Env,
    session: napi::bindgen_prelude::Unknown<'_>,
    history: napi::bindgen_prelude::Unknown<'_>,
    exclude_turn_id: napi::bindgen_prelude::Unknown<'_>,
    max_messages: napi::bindgen_prelude::Unknown<'_>,
    max_chars: napi::bindgen_prelude::Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    Ok(checkpoint_live(
        LiveValue::new(&env, session),
        LiveValue::new(&env, history),
        LiveValue::new(&env, exclude_turn_id),
        LiveValue::new(&env, max_messages),
        LiveValue::new(&env, max_chars),
    )?
    .raw())
}
