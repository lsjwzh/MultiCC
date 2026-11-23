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
    let out = agy_stream::build_invocation(&InvocationInput {
        cmd: input.cmd,
        model: input.model,
        effort: input.effort,
        conversation_id: input.conversation_id,
        is_first_turn: input.is_first_turn,
        role_prompt: input.role_prompt,
        prompt: input.prompt,
    });
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

#[napi]
pub struct RustAgyStreamDecoder {
    inner: RefCell<AgyStreamDecoder>,
}

#[napi]
impl RustAgyStreamDecoder {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: RefCell::new(AgyStreamDecoder::new()),
        }
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
