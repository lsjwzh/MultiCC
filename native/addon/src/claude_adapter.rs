//! Claude adapter decisions with live SDK ports and asynchronous disk work.
use crate::js_live::LiveValue as L;
use multicc_core::{
    claude_adapter,
    js::{JsString, JsValue as V},
};
use napi::{
    bindgen_prelude::{AsyncTask, Unknown},
    sys, Env, Result, Task,
};
use napi_derive::napi;
use std::{ffi::CStr, path::PathBuf};

fn text<'a>(anchor: L<'a>, value: &str) -> Result<L<'a>> {
    anchor.from_value(&V::from(value))
}
fn object<'a>(anchor: L<'a>, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
    let value = anchor.from_value(&V::Object(vec![]))?;
    for (key, field) in fields {
        value.set(key, *field)?;
    }
    Ok(value)
}
fn concat<'a>(anchor: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut out = JsString::new();
    for value in parts {
        out.push(&value.coerce_string()?);
    }
    anchor.from_value(&V::String(out))
}
fn or<'a>(value: L<'a>, next: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        next()
    }
}
fn port<'a>(ports: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    ports.get(key)?.call_plain(args)
}
fn push(array: L<'_>, values: &[L<'_>]) -> Result<()> {
    array.get(c"push")?.call(array, values)?;
    Ok(())
}

fn supports_ultracode(model: L<'_>) -> Result<bool> {
    let model = model
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    Ok(multicc_core::cli_capability::supports_effort(
        "claude", &model, "xhigh",
    ))
}

#[napi]
pub fn claude_adapter_ports(
    env: Env,
    deps: Unknown<'_>,
    bridge: String,
    executable: String,
) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    let ports = object(deps, &[])?;
    for key in [
        c"cmd",
        c"args",
        c"chatDisallowedTools",
        c"resolveSessionWireModel",
        c"cliEffortLevel",
        c"normalizeEffort",
        c"debugLogClaudeInvoke",
        c"routerMcpNode",
        c"routerMcpScript",
    ] {
        let value = deps.get(key)?;
        ports.set(
            key,
            if (key == c"args" || key == c"chatDisallowedTools") && value.undefined()? {
                deps.from_value(&V::Array(vec![]))?
            } else {
                value
            },
        )?;
    }
    ports.set(c"bridge", or(deps.get(c"bridge")?, || text(deps, &bridge))?)?;
    ports.set(c"executable", text(deps, &executable)?)?;
    Ok(ports.raw())
}

#[napi]
pub fn claude_adapter_terminal(
    env: Env,
    session: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let session = L::new(&env, session);
    let ports = L::new(&env, ports);
    let args = ports.get(c"args")?;
    let suffix = if args.get(c"length")?.truthy()? {
        concat(
            session,
            &[
                text(session, " ")?,
                args.get(c"join")?.call(args, &[text(session, " ")?])?,
            ],
        )?
    } else {
        text(session, "")?
    };
    let mut command = concat(session, &[ports.get(c"cmd")?, suffix])?;
    for (key, flag) in [(c"model", " --model "), (c"agent", " --agent ")] {
        if session.get(key)?.truthy()? {
            command = concat(session, &[command, text(session, flag)?, session.get(key)?])?;
        }
    }
    let effort = port(ports, c"cliEffortLevel", &[session])?;
    if effort.truthy()? {
        command = concat(session, &[command, text(session, " --effort ")?, effort])?;
    }
    if session.get(c"turnHookSettingsArg")?.truthy()? {
        command = concat(
            session,
            &[
                command,
                text(session, " --settings ")?,
                session.get(c"turnHookSettingsArg")?,
            ],
        )?;
    } else if (session.get(c"claudeWorkflow")?.is_true()?
        || session.optional(c"effort")?.is_string("ultracode")?)
        && supports_ultracode(session.optional(c"model")?)?
    {
        command = concat(
            session,
            &[
                command,
                text(session, " --settings '{\"ultracode\":true}'")?,
            ],
        )?;
    }
    if session.get(c"cliSessionId")?.truthy()? {
        command = concat(
            session,
            &[
                command,
                text(session, " --session-id ")?,
                session.get(c"cliSessionId")?,
            ],
        )?;
    }
    Ok(command.raw())
}

#[napi]
pub fn claude_adapter_invocation(
    env: Env,
    input: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let ports = L::new(&env, ports);
    let so = input.get(c"spawnOpts")?;
    let raw = so.get(c"rawModel")?;
    let facts = object(
        input,
        &[
            (c"providerModel", so.get(c"providerModel")?),
            (c"providerModels", so.get(c"providerModels")?),
            (c"skipDefaultModel", so.get(c"skipDefaultModel")?),
            (
                c"defaultModel",
                or(so.get(c"effectiveModel")?, || input.from_value(&V::Null))?,
            ),
        ],
    )?;
    let model = port(ports, c"resolveSessionWireModel", &[raw, facts])?;
    let effort = port(
        ports,
        c"cliEffortLevel",
        &[object(
            input,
            &[(c"effort", so.get(c"rawEffort")?), (c"model", model)],
        )?],
    )?;
    let args = input.from_value(&V::Array(vec![]))?;
    push(args, &[ports.get(c"bridge")?])?;
    let flag = if input.get(c"historyHandle")?.get(c"isFirstTurn")?.truthy()? {
        "--session-id"
    } else {
        "--resume"
    };
    push(
        args,
        &[
            text(input, flag)?,
            input.get(c"historyHandle")?.get(c"cliSessionId")?,
        ],
    )?;
    for (flag, value) in [("--model", model), ("--effort", effort)] {
        if value.truthy()? {
            push(args, &[text(input, flag)?, value])?;
        }
    }
    if so.get(c"rawAgent")?.truthy()? {
        push(args, &[text(input, "--agent")?, so.get(c"rawAgent")?])?;
    }
    if input.get(c"systemPrompt")?.truthy()? {
        push(
            args,
            &[text(input, "--system-prompt")?, input.get(c"systemPrompt")?],
        )?;
    }
    let tools = ports.get(c"chatDisallowedTools")?;
    if tools.get(c"length")?.truthy()? {
        let json = input.global()?.get(c"JSON")?;
        push(
            args,
            &[
                text(input, "--disallowed-tools-json")?,
                json.get(c"stringify")?.call(json, &[tools])?,
            ],
        )?;
    }
    if so.get(c"maxTurns")?.positive()? {
        push(
            args,
            &[
                text(input, "--max-turns")?,
                input
                    .global()?
                    .get(c"String")?
                    .call_plain(&[so.get(c"maxTurns")?])?,
            ],
        )?;
    }
    if ports.get(c"routerMcpNode")?.truthy()? && ports.get(c"routerMcpScript")?.truthy()? {
        push(
            args,
            &[
                text(input, "--router-node")?,
                ports.get(c"routerMcpNode")?,
                text(input, "--router-script")?,
                ports.get(c"routerMcpScript")?,
            ],
        )?;
    }
    push(args, &[text(input, "--")?])?;
    let ultracode = (so.get(c"ultracode")?.is_true()?
        || so.get(c"rawEffort")?.is_string("ultracode")?)
        && supports_ultracode(model)?;
    let debug = ports.get(c"debugLogClaudeInvoke")?;
    if !debug.nullish()? {
        let meta = object(
            input,
            &[
                (c"model", so.get(c"rawModel")?),
                (c"effort", so.get(c"rawEffort")?),
            ],
        )?;
        let logged = input.from_value(&V::Array(vec![]))?;
        args.for_each(|value| push(logged, &[value]))?;
        push(
            logged,
            &[crate::message_composer::render_prompt(&env, input)?],
        )?;
        debug.call_plain(&[meta, logged])?;
    }
    let output = object(
        input,
        &[
            (c"cmd", ports.get(c"executable")?),
            (c"args", args),
            (
                c"payload",
                crate::message_composer::render_prompt(&env, input)?,
            ),
            (
                c"sdkOptions",
                object(
                    input,
                    &[
                        (c"model", model),
                        (c"effort", effort),
                        (c"agent", so.get(c"rawAgent")?),
                        (c"systemPrompt", input.get(c"systemPrompt")?),
                        (c"disallowedTools", tools),
                        (c"maxTurns", so.get(c"maxTurns")?),
                        (c"routerNode", ports.get(c"routerMcpNode")?),
                        (c"routerScript", ports.get(c"routerMcpScript")?),
                    ],
                )?,
            ),
        ],
    )?;
    if ultracode {
        output.set(
            c"settings",
            object(input, &[(c"ultracode", input.from_value(&V::Bool(true))?)])?,
        )?;
    }
    Ok(output.raw())
}

#[napi]
pub fn claude_adapter_decode(
    env: Env,
    event: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let event = L::new(&env, event);
    let ports = L::new(&env, ports);
    let rows = event.from_value(&V::Array(vec![]))?;
    let out = if event.optional(c"type")?.is_string("system")?
        && event.get(c"subtype")?.is_string("sdk_error")?
    {
        object(
            event,
            &[
                (c"type", text(event, "error")?),
                (c"label", ports.get(c"displayName")?),
                (c"kind", text(event, "provider")?),
                (
                    c"message",
                    or(event.get(c"error")?, || {
                        text(event, "Claude Agent SDK bridge failed")
                    })?,
                ),
            ],
        )?
    } else {
        if event.optional(c"type")?.is_string("result")?
            && !crate::cli_completion::main_result(event)?
        {
            return Ok(rows.raw());
        }
        if event.truthy()?
            && event.get(c"type")?.is_string("system")?
            && event.get(c"subtype")?.is_string("init")?
        {
            object(
                event,
                &[
                    (c"type", text(event, "session_init")?),
                    (c"model", event.get(c"model")?),
                    (c"raw", event),
                ],
            )?
        } else {
            object(
                event,
                &[(c"type", text(event, "claude_event")?), (c"raw", event)],
            )?
        }
    };
    push(rows, &[out])?;
    Ok(rows.raw())
}

pub struct PrepareSpawn {
    home: Option<PathBuf>,
    session: Option<String>,
}
impl Task for PrepareSpawn {
    type Output = f64;
    type JsValue = f64;
    fn compute(&mut self) -> Result<f64> {
        Ok(match (&self.home, &self.session) {
            (Some(home), Some(session)) => {
                claude_adapter::sanitize_history(home, session).unwrap_or(0) as f64
            }
            _ => 0.0,
        })
    }
    fn resolve(&mut self, _: Env, value: f64) -> Result<f64> {
        Ok(value)
    }
}
#[napi]
pub fn claude_adapter_prepare_spawn(
    env: Env,
    session: Unknown<'_>,
    home: Unknown<'_>,
) -> Result<AsyncTask<PrepareSpawn>> {
    let session = L::new(&env, session);
    let home = L::new(&env, home);
    let plan = session
        .catch(|| {
            if !session.truthy()? {
                Ok(None)
            } else {
                let home = home.call_plain(&[])?.coerce_string()?.to_string_lossy();
                Ok(Some((
                    PathBuf::from(home),
                    session.coerce_string()?.to_string_lossy(),
                )))
            }
        })?
        .flatten();
    let (home, session) = match plan {
        Some((home, session)) => (Some(home), Some(session)),
        None => (None, None),
    };
    Ok(AsyncTask::new(PrepareSpawn { home, session }))
}
