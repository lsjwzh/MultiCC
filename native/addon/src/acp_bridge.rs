//! Test and integration entry to the ACP data kernel. Live JavaScript values
//! are intentionally not accepted: ACP itself carries JSON frames and argv.
use multicc_core::{
    acp_bridge,
    js::{self, JsValue as V},
};
use napi::{Error, Result};
use napi_derive::napi;

#[napi]
pub fn acp_bridge_kernel(input: String) -> Result<String> {
    let input =
        js::json_parse(&input).map_err(|_| Error::from_reason("invalid ACP kernel input"))?;
    let get = |name| input.get(name).cloned().unwrap_or(V::Undefined);
    let result = match get("operation") {
        V::String(operation) => match operation.to_string_lossy().as_str() {
            "parseArgs" => match get("args") {
                V::Array(args) => {
                    let args: Option<Vec<String>> = args
                        .into_iter()
                        .map(|arg| match arg {
                            V::String(value) => Some(value.to_string_lossy()),
                            _ => None,
                        })
                        .collect();
                    match args {
                        Some(args) => acp_bridge::parse_args(&args),
                        None => Err("argv must contain strings"),
                    }
                }
                _ => Err("argv must be an array"),
            },
            "routerMcpServers" => Ok(acp_bridge::router_servers(&get("router"), &get("env"))),
            "pickPermissionOption" => Ok(acp_bridge::pick_permission(&get("options"))),
            "normalizeUsage" => Ok(acp_bridge::normalize_usage(&get("usage"))),
            "rpcFrame" => Ok(acp_bridge::rpc_frame(&get("message"))),
            _ => Err("unknown ACP operation"),
        },
        _ => Err("unknown ACP operation"),
    };
    let output = match result {
        Ok(value) => V::object(vec![("ok", V::Bool(true)), ("value", value)]),
        Err(message) => V::object(vec![
            ("ok", V::Bool(false)),
            ("message", V::string(message)),
        ]),
    };
    js::json_stringify(&output).ok_or_else(|| Error::from_reason("invalid ACP kernel output"))
}
