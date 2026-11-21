//! Codex exec adapter. The host supplies existing model/error/SDK ports.
use crate::js_live::LiveValue as L;
use multicc_core::js::{JsString, JsValue as V};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;
mod events;

pub(super) fn text<'a>(anchor: L<'a>, value: &str) -> Result<L<'a>> {
    anchor.from_value(&V::from(value))
}
pub(super) fn object<'a>(anchor: L<'a>, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
    let out = anchor.from_value(&V::Object(vec![]))?;
    for (key, value) in fields {
        out.set(key, *value)?;
    }
    Ok(out)
}
pub(super) fn array(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&V::Array(vec![]))
}
pub(super) fn push(values: L<'_>, fields: &[L<'_>]) -> Result<()> {
    values.get(c"push")?.call(values, fields)?;
    Ok(())
}
pub(super) fn row(value: L<'_>) -> Result<L<'_>> {
    let out = array(value)?;
    push(out, &[value])?;
    Ok(out)
}
pub(super) fn or<'a>(value: L<'a>, next: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        next()
    }
}
pub(super) fn property<'a>(
    value: L<'a>,
    key: &CStr,
    fallback: impl FnOnce() -> Result<L<'a>>,
) -> Result<L<'a>> {
    or(value.get(key)?, fallback)
}
pub(super) fn concat<'a>(anchor: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut out = JsString::new();
    for part in parts {
        out.push(&part.coerce_string()?);
    }
    anchor.from_value(&V::String(out))
}
pub(super) fn string(value: L<'_>) -> Result<L<'_>> {
    value.global()?.get(c"String")?.call_plain(&[value])
}
pub(super) fn boolean<'a>(anchor: L<'a>, value: bool) -> Result<L<'a>> {
    anchor.from_value(&V::Bool(value))
}
pub(super) fn port<'a>(ports: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    ports.get(key)?.call_plain(args)
}
pub(super) fn json(value: L<'_>) -> Result<L<'_>> {
    let json = value.global()?.get(c"JSON")?;
    json.get(c"stringify")?.call(json, &[value])
}
pub(super) fn parse(value: L<'_>) -> Result<L<'_>> {
    let json = value.global()?.get(c"JSON")?;
    json.get(c"parse")?.call(json, &[value])
}
pub(super) fn join<'a>(array: L<'a>, separator: &str) -> Result<L<'a>> {
    array.get(c"join")?.call(array, &[text(array, separator)?])
}
pub(super) fn matches(value: L<'_>, pattern: &str, flags: &str) -> Result<bool> {
    let regex = value
        .global()?
        .get(c"RegExp")?
        .construct(&[text(value, pattern)?, text(value, flags)?])?;
    regex.get(c"test")?.call(regex, &[value])?.truthy()
}

fn usage(input: L<'_>) -> Result<L<'_>> {
    let source = or(input, || object(input, &[]))?;
    let cached = property(source, c"cached_input_tokens", || {
        property(source, c"cache_read_input_tokens", || {
            source.from_value(&V::Number(0.0))
        })
    })?
    .explicit_number()?;
    let total = property(source, c"input_tokens", || {
        source.from_value(&V::Number(0.0))
    })?
    .explicit_number()?;
    let out = object(input, &[])?;
    out.spread_from(source)?;
    let input_tokens = if source.get(c"cache_read_input_tokens")?.nullish()? {
        let delta = total - cached;
        if delta.is_nan() {
            f64::NAN
        } else if delta > 0.0 {
            delta
        } else {
            0.0
        }
    } else {
        total
    };
    out.set(c"input_tokens", input.from_value(&V::Number(input_tokens))?)?;
    out.set(
        c"cache_read_input_tokens",
        input.from_value(&V::Number(cached))?,
    )?;
    Ok(out)
}
fn mcp_text(item: L<'_>) -> Result<L<'_>> {
    if item.truthy()? && item.get(c"error")?.truthy()? {
        let error = item.get(c"error")?;
        return if error.kind()? == sys::ValueType::napi_string {
            item.get(c"error")
        } else {
            string(property(item.get(c"error")?, c"message", || {
                property(item.get(c"error")?, c"code", || {
                    text(item, "MCP tool failed")
                })
            })?)
        };
    }
    let result = if item.truthy()? {
        item.get(c"result")?
    } else {
        item
    };
    if result.kind()? == sys::ValueType::napi_string {
        return Ok(result);
    }
    if result.truthy()? && result.get(c"content")?.is_array()? {
        let filtered = array(item)?;
        let values = array(item)?;
        result.get(c"content")?.for_each(|block| {
            if block.truthy()? && block.get(c"type")?.is_string("text")? {
                push(filtered, &[block])?;
            }
            Ok(())
        })?;
        filtered.for_each(|block| {
            push(
                values,
                &[string(property(block, c"text", || text(item, ""))?)?],
            )
        })?;
        let value = join(values, "\n")?;
        if value.truthy()? {
            return Ok(value);
        }
    }
    if result.nullish()? {
        return text(item, "");
    }
    match result.catch(|| json(result))? {
        Some(value) => Ok(value),
        None => string(result),
    }
}
fn router<'a>(anchor: L<'a>, node: L<'a>, script: L<'a>) -> Result<L<'a>> {
    let out = array(anchor)?;
    if !node.truthy()? || !script.truthy()? {
        return Ok(out);
    }
    let vars = anchor.from_value(&V::Array(
        [
            "MULTICC_BASE_URL",
            "MULTICC_SESSION_ID",
            "MULTICC_TURN_ID",
            "MULTICC_ORIGIN_DISPATCH_ID",
            "MULTICC_ROUTER_CAPABILITY",
            "MULTICC_IMAGE_BRIDGE",
        ]
        .into_iter()
        .map(V::from)
        .collect(),
    ))?;
    for (prefix, value) in [
        ("mcp_servers.multicc_router.command=", json(string(node)?)?),
        ("mcp_servers.multicc_router.args=", {
            let values = array(anchor)?;
            push(values, &[string(script)?])?;
            json(values)?
        }),
        ("mcp_servers.multicc_router.env_vars=", json(vars)?),
    ] {
        push(out, &[concat(anchor, &[text(anchor, prefix)?, value])?])?;
    }
    for value in [
        "mcp_servers.multicc_router.enabled=true",
        "mcp_servers.multicc_router.required=true",
        "mcp_servers.multicc_router.startup_timeout_sec=60",
        "mcp_servers.multicc_router.tool_timeout_sec=21630",
        "mcp_servers.multicc_router.default_tools_approval_mode=\"approve\"",
    ] {
        push(out, &[text(anchor, value)?])?;
    }
    Ok(out)
}
fn configs<'a>(ports: L<'a>, session: L<'a>) -> Result<L<'a>> {
    let out = array(ports)?;
    let reasoning = port(ports, c"codexReasoningConfigArg", &[session])?;
    let model = port(ports, c"codexModelConfigArg", &[session])?;
    for value in [reasoning, model] {
        if value.truthy()? {
            push(out, &[value])?;
        }
    }
    Ok(out)
}
fn terminal<'a>(session: L<'a>, ports: L<'a>) -> Result<L<'a>> {
    let args = ports.get(c"args")?;
    let base = if args.get(c"length")?.truthy()? {
        concat(session, &[text(session, " ")?, join(args, " ")?])?
    } else {
        text(session, "")?
    };
    let all = configs(ports, session)?;
    or(session.get(c"turnHookConfigArgs")?, || array(session))?
        .for_each(|value| push(all, &[value]))?;
    let parts = array(session)?;
    all.for_each(|value| {
        push(
            parts,
            &[concat(
                session,
                &[text(session, " -c '")?, value, text(session, "'")?],
            )?],
        )
    })?;
    let mut command = concat(session, &[ports.get(c"cmd")?, base, join(parts, "")?])?;
    if session.get(c"cliSessionId")?.truthy()? {
        command = concat(
            session,
            &[
                command,
                text(session, " resume ")?,
                session.get(c"cliSessionId")?,
            ],
        )?;
    }
    Ok(command)
}
fn invocation<'a>(input: L<'a>, ports: L<'a>) -> Result<L<'a>> {
    let so = input.get(c"spawnOpts")?;
    let session = object(
        input,
        &[
            (c"effort", so.get(c"rawEffort")?),
            (
                c"model",
                property(so, c"rawModel", || {
                    property(so, c"effectiveModel", || input.from_value(&V::Null))
                })?,
            ),
            (c"effectiveModel", so.get(c"effectiveModel")?),
        ],
    )?;
    let first = input.get(c"historyHandle")?.get(c"isFirstTurn")?;
    let prompt = port(ports, c"renderPrompt", &[input])?;
    let mut payload = if first.truthy()? {
        let role = input.get(c"rolePrompt")?;
        let subagent = input.get(c"subagentHint")?;
        let prefixes = array(input)?;
        push(prefixes, &[ports.get(c"multiccImgHint")?])?;
        if ports.get(c"envConstraint")?.truthy()? {
            push(prefixes, &[ports.get(c"envConstraint")?])?;
        }
        if subagent.truthy()? {
            push(prefixes, &[subagent])?;
        }
        if role.truthy()? {
            push(
                prefixes,
                &[concat(
                    input,
                    &[
                        text(input, "[Role prompt]\n")?,
                        role,
                        text(input, "\n[End of role prompt]")?,
                    ],
                )?],
            )?;
        }
        concat(
            input,
            &[join(prefixes, "\n\n")?, text(input, "\n\n")?, prompt],
        )?
    } else if ports.get(c"envConstraint")?.truthy()? {
        concat(
            input,
            &[ports.get(c"envConstraint")?, text(input, "\n\n")?, prompt],
        )?
    } else {
        prompt
    };
    if ports.get(c"stayAlivePrompt")?.truthy()? {
        payload = concat(
            input,
            &[payload, text(input, "\n")?, ports.get(c"stayAlivePrompt")?],
        )?;
    }
    let args = array(input)?;
    push(args, &[text(input, "exec")?])?;
    let values = configs(ports, session)?;
    router(
        input,
        ports.get(c"routerMcpNode")?,
        ports.get(c"routerMcpScript")?,
    )?
    .for_each(|value| push(values, &[value]))?;
    values.for_each(|value| push(args, &[text(input, "-c")?, value]))?;
    if !first.truthy()? {
        push(
            args,
            &[
                text(input, "resume")?,
                input.get(c"historyHandle")?.get(c"cliSessionId")?,
            ],
        )?;
    }
    for flag in [
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
    ] {
        push(args, &[text(input, flag)?])?;
    }
    object(
        input,
        &[
            (c"cmd", ports.get(c"cmd")?),
            (c"args", args),
            (c"payload", payload),
        ],
    )
}

#[napi]
pub fn codex_adapter_ports(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    let ports = object(deps, &[])?;
    for key in [
        c"cmd",
        c"args",
        c"codexReasoningConfigArg",
        c"codexModelConfigArg",
        c"envConstraint",
        c"stayAlivePrompt",
        c"multiccImgHint",
        c"routerMcpNode",
        c"routerMcpScript",
        c"isResponseCompletedDisconnect",
        c"isTransportDisconnect",
    ] {
        let value = deps.get(key)?;
        ports.set(
            key,
            if key == c"args" && value.undefined()? {
                array(deps)?
            } else {
                value
            },
        )?;
    }
    Ok(ports.raw())
}

#[napi]
pub fn codex_adapter_call(
    env: Env,
    op: String,
    input: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let ports = L::new(&env, ports);
    let value = match op.as_str() {
        "usage" => usage(input)?,
        "mcp-text" => mcp_text(input)?,
        "router" => router(input, input.element(0)?, input.element(1)?)?,
        "noise" => boolean(
            input,
            matches(
                string(or(input, || text(input, ""))?)?,
                "failed to refresh available models|failed to load skill",
                "i",
            )?,
        )?,
        "terminal" => terminal(input, ports)?,
        "invocation" => invocation(input, ports)?,
        "decode" => events::decode(input, ports)?,
        _ => return Err(napi::Error::from_reason("unknown_codex_adapter_operation")),
    };
    Ok(value.raw())
}
