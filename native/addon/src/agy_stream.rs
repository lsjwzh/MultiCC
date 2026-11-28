//! Antigravity (`agy`) `--output-format stream-json` 协议的 N-API 入口。
//!
//! 命令构造、每轮用量状态机与 `mcp_config.json` 合并逻辑均位于
//! [`multicc_core::agy_stream`]，此处仅做零策略的 N-API 绑定。

use multicc_core::agy_stream::{self, AgyStreamDecoder, InvocationInput};
use napi_derive::napi;
use std::cell::RefCell;
use std::path::Path;

#[napi(object)]
pub struct AgyInvocationInput {
    pub cmd: String,
    pub model: Option<String>,
    pub effective_model: Option<String>,
    pub account_key: Option<String>,
    pub effort: Option<String>,
    pub conversation_id: Option<String>,
    pub is_first_turn: bool,
    pub role_prompt: Option<String>,
    pub prompt: String,
}

#[napi(object)]
pub struct AgyInvocationOutput {
    pub cmd: String,
    pub args: Vec<String>,
    pub payload: String,
}

#[napi]
pub fn agy_build_invocation(input: AgyInvocationInput) -> AgyInvocationOutput {
    let account = input
        .account_key
        .unwrap_or_else(|| multicc_core::agy_models::account_key(None));
    let out = agy_stream::build_for_account(
        &InvocationInput {
            cmd: input.cmd,
            model: input.model,
            effective_model: input.effective_model,
            effort: input.effort,
            conversation_id: input.conversation_id,
            is_first_turn: input.is_first_turn,
            role_prompt: input.role_prompt,
            prompt: input.prompt,
        },
        &account,
    );
    AgyInvocationOutput {
        cmd: out.cmd,
        args: out.args,
        payload: out.payload,
    }
}

#[napi]
pub fn agy_ensure_router_mcp(home_dir: String, node: String, script: String) -> napi::Result<bool> {
    agy_stream::ensure_router_mcp(Path::new(&home_dir), &node, &script)
        .map_err(napi::Error::from_reason)
}

#[derive(Default)]
#[napi]
pub struct RustAgyStreamDecoder {
    inner: RefCell<AgyStreamDecoder>,
}

#[napi]
impl RustAgyStreamDecoder {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn decode(&self, raw_json: String) -> napi::Result<String> {
        let value: serde_json::Value = match serde_json::from_str(&raw_json) {
            Ok(v) => v,
            Err(_) => return Ok("[]".to_string()),
        };
        let events = self.inner.borrow_mut().decode(&value);
        serde_json::to_string(&events).map_err(|err| napi::Error::from_reason(err.to_string()))
    }
}

/// Choose terminal flags against the live session; quoting uses the shell
/// string port, which retains JS UTF-16 and explicit String conversion.
#[napi]
pub fn agy_terminal(
    env: napi::Env,
    cmd: napi::bindgen_prelude::Unknown<'_>,
    session: napi::bindgen_prelude::Unknown<'_>,
    support: napi::bindgen_prelude::Unknown<'_>,
    quote: napi::bindgen_prelude::Unknown<'_>,
) -> napi::Result<napi::sys::napi_value> {
    use crate::{js_iteration::read, js_live::LiveValue as L};
    let session = L::new(&env, session);
    let quote = L::new(&env, quote);
    let support = L::new(&env, support);
    let mut command = quote.call_plain(&[L::new(&env, cmd)])?;
    let model = read(session, c"model")?
        .string()?
        .map(|s| s.to_string_lossy());
    let level = read(session, c"effort")?
        .string()?
        .map(|s| s.to_string_lossy());
    let pin = session
        .optional(c"cliAccounts")?
        .optional(c"agy")?
        .string()?
        .map(|s| s.to_string_lossy());
    let account = multicc_core::agy_models::account_key(pin.as_deref());
    let concrete = level.as_deref().and_then(|level| {
        agy_stream::effort::concrete(
            multicc_core::agy_models::cached(&account).as_ref(),
            model.as_deref(),
            level,
        )
    });
    let rejected = level.as_deref().is_some_and(|level| {
        agy_stream::effort::rejected(&account, model.as_deref().unwrap_or(""), level)
    });
    for (key, flag) in [
        (c"model", " --model "),
        (c"effort", " --effort "),
        (c"cliSessionId", " --conversation "),
    ] {
        if !read(session, key)?.truthy()? {
            continue;
        }
        if key == c"effort"
            && (concrete.is_some()
                || rejected
                || !support
                    .call_plain(&[
                        command.from_value(&"agy".into())?,
                        read(session, c"model")?,
                        read(session, key)?,
                    ])?
                    .truthy()?)
        {
            continue;
        }
        let raw = match (key == c"model", &concrete) {
            (true, Some(id)) => session.from_value(&id.as_str().into())?,
            _ => read(session, key)?,
        };
        let value = quote.call_plain(&[raw])?;
        command = crate::host_methods::call(
            command,
            c"concat",
            &[command.from_value(&flag.into())?, value],
        )?;
    }
    Ok(command.raw())
}

/// Read the live invocation envelope in host order. Prompt composition remains
/// injected because it dispatches through the session's message composer.
#[napi]
pub fn agy_host_invocation(
    env: napi::Env,
    _addon: napi::bindgen_prelude::Unknown<'_>,
    cmd: napi::bindgen_prelude::Unknown<'_>,
    envelope: napi::bindgen_prelude::Unknown<'_>,
    composer: napi::bindgen_prelude::Unknown<'_>,
) -> napi::Result<napi::sys::napi_value> {
    use crate::{
        host_methods::call,
        js_iteration::read,
        js_live::{fields, LiveValue as L},
    };
    use multicc_core::js::JsValue as V;
    let envelope = L::new(&env, envelope);
    let record = |k| {
        let value = read(envelope, k)?;
        if value.truthy()? {
            Ok(value)
        } else {
            fields(envelope, &[])
        }
    };
    let options = record(c"spawnOpts")?;
    let handle = record(c"historyHandle")?;
    fn string_option<'a>(v: L<'a>, key: &std::ffi::CStr) -> napi::Result<L<'a>> {
        if read(v, key)?.truthy()? {
            v.global()?.get(c"String")?.call_plain(&[read(v, key)?])
        } else {
            v.from_value(&V::Undefined)
        }
    }
    let model = string_option(options, c"rawModel")?;
    let effective = read(options, c"effectiveModel")?;
    let input = fields(
        envelope,
        &[
            ("cmd", L::new(&env, cmd)),
            ("model", model),
            ("accountKey", read(options, c"agyAccountKey")?),
            (
                "effectiveModel",
                if effective.truthy()? {
                    effective
                } else {
                    effective.from_value(&V::Undefined)?
                },
            ),
            ("effort", string_option(options, c"rawEffort")?),
            ("conversationId", string_option(handle, c"cliSessionId")?),
            (
                "isFirstTurn",
                envelope.from_value(&V::Bool(read(handle, c"isFirstTurn")?.truthy()?))?,
            ),
            ("rolePrompt", string_option(envelope, c"rolePrompt")?),
            (
                "prompt",
                call(L::new(&env, composer), c"renderPrompt", &[envelope])?,
            ),
        ],
    )?;
    let output = agy_build_invocation(crate::host_methods::typed(input)?);
    unsafe { napi::bindgen_prelude::ToNapiValue::to_napi_value(env.raw(), output) }
}
