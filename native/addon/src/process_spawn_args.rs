//! Spawn argument ordering, preserving live iterable and payload semantics.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn process_spawn_args(
    env: Env,
    invocation: Unknown<'_>,
    settings: Unknown<'_>,
) -> Result<sys::napi_value> {
    let invocation = L::new(&env, invocation);
    let args = invocation.from_value(&V::Array(vec![]))?;
    let mut index = 0usize;
    invocation.get(c"args")?.for_each(|value| {
        args.define_key(args.from_value(&V::from(index.to_string()))?, value)?;
        index += 1;
        Ok(())
    })?;
    let settings = L::new(&env, settings);
    if settings.truthy()? {
        let separated = args
            .get(c"at")?
            .call(args, &[args.from_value(&V::Number(-1.0))?])?
            .is_string("--")?;
        if separated {
            args.get(c"pop")?.call(args, &[])?;
        }
        args.get(c"push")?
            .call(args, &[args.from_value(&V::from("--settings"))?, settings])?;
        if separated {
            args.get(c"push")?
                .call(args, &[args.from_value(&V::from("--"))?])?;
        }
    }
    args.get(c"push")?
        .call(args, &[invocation.get(c"payload")?])?;
    Ok(args.raw())
}

/// Select a relay only for the four CLI lanes that support it. The provider
/// registry owns the target object; pass it back without cloning or serializing.
#[napi]
pub fn resolve_cli_relay_target(
    env: Env,
    providers: Unknown<'_>,
    cli: Unknown<'_>,
    provider_id: Unknown<'_>,
) -> Result<sys::napi_value> {
    let providers = L::new(&env, providers);
    let cli = L::new(&env, cli);
    let id = L::new(&env, provider_id);
    let absent = providers.from_value(&V::Null)?;
    if !id.truthy()?
        || !providers.truthy()?
        || providers.get(c"resolveCliRelayTarget")?.kind()? != sys::ValueType::napi_function
    {
        return Ok(absent.raw());
    }
    let family = if cli.is_string("claude")? || cli.is_string("claude-exp")? {
        "claude"
    } else if cli.is_string("codex")? || cli.is_string("codex-exp")? {
        "codex"
    } else {
        return Ok(absent.raw());
    };
    let resolve = providers.get(c"resolveCliRelayTarget")?;
    if resolve.kind()? != sys::ValueType::napi_function {
        return Err(resolve.type_error("providers.resolveCliRelayTarget is not a function"));
    }
    Ok(resolve
        .call(providers, &[providers.from_value(&family.into())?, id])?
        .raw())
}

fn persist_new_session<'a>(ports: L<'a>, persisted: L<'a>) -> Result<()> {
    let id = multicc_core::random_id::random_uuid_v4().map_err(|error| {
        napi::Error::from_reason(format!("secure random generation failed: {error}"))
    })?;
    ports.get(c"assignHostProperty")?.call_plain(&[
        persisted,
        ports.from_value(&"cliSessionId".into())?,
        ports.from_value(&id.into())?,
    ])?;
    let remember = ports.get(c"rememberActiveCliState")?;
    if remember.kind()? != sys::ValueType::napi_function {
        return Err(ports.type_error("rememberActiveCliState is not a function"));
    }
    remember.call_plain(&[persisted])?;
    let save = ports.get(c"savePersistedSessionsBestEffort")?;
    if save.kind()? != sys::ValueType::napi_function {
        return Err(ports.type_error("savePersistedSessionsBestEffort is not a function"));
    }
    save.call_plain(&[ports.from_value(&"runtime.cli-relay-session-id".into())?])?;
    Ok(())
}

/// args.push(flag, String(value)). The host string can contain unmatched UTF-16
/// units or a large prompt; keep it on the engine throughout the call.
fn push_text_arg<'a>(args: L<'a>, flag: &str, value: impl FnOnce() -> Result<L<'a>>) -> Result<()> {
    let push = args.get(c"push")?;
    let text = args.global()?.get(c"String")?.call_plain(&[value()?])?;
    push.call(args, &[args.from_value(&flag.into())?, text])?;
    Ok(())
}

#[napi]
pub fn apply_cli_relay_spawn(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::js_iteration::read;

    let ports = L::new(&env, ports);
    let envelope = ports.get(c"invocationEnvelope")?;
    let options = envelope.optional(c"spawnOpts")?;
    let options = if options.truthy()? {
        options
    } else {
        ports.from_value(&V::Object(vec![]))?
    };
    let raw = options.get(c"rawModel")?;
    let model = if raw.truthy()? {
        raw
    } else {
        options.get(c"effectiveModel")?
    };
    let effort = options.get(c"rawEffort")?;
    let first = envelope
        .optional(c"historyHandle")?
        .optional(c"isFirstTurn")?
        .is_true()?;
    let target = ports.get(c"target")?;
    let claude = read(target, c"appType")?.is_string("claude")?;
    let persisted = ports.get(c"persisted")?;
    let (command, env_key, resume) = if claude {
        let had_session = read(persisted, c"cliSessionId")?.truthy()?;
        if !had_session {
            persist_new_session(ports, persisted)?;
        }
        (
            "claude-remote-bridge",
            "MULTICC_CLAUDE_CLI_RELAY_JSON",
            had_session && !first,
        )
    } else {
        ("codex-remote-bridge", "MULTICC_CODEX_CLI_RELAY_JSON", false)
    };
    let json = ports.global()?.get(c"JSON")?;
    let encoded = json.get(c"stringify")?.call(json, &[target])?;
    ports.get(c"assignHostProperty")?.call_plain(&[
        ports.get(c"childEnv")?,
        ports.from_value(&env_key.into())?,
        encoded,
    ])?;

    let mut initial = vec![command.into(), "--local-cwd".into(), V::Undefined];
    if claude {
        initial.extend(["--session-id".into(), V::Undefined]);
    }
    let args = ports.from_value(&V::Array(initial))?;
    args.set_element(2, ports.get(c"cwd")?)?;
    if claude {
        args.set_element(4, read(persisted, c"cliSessionId")?)?;
        if resume {
            args.get(c"push")?
                .call(args, &[ports.from_value(&"--resume".into())?])?;
        }
    } else if read(persisted, c"cliSessionId")?.truthy()? && !first {
        push_text_arg(args, "--thread-id", || read(persisted, c"cliSessionId"))?;
    }
    if model.truthy()? {
        push_text_arg(args, "--model", || Ok(model))?;
    }
    if effort.truthy()? {
        push_text_arg(args, "--effort", || Ok(effort))?;
    }
    let invocation = ports.get(c"invocation")?;
    if claude {
        let append = read(invocation, c"sdkOptions")?.optional(c"systemPromptAppend")?;
        if append.truthy()? {
            push_text_arg(args, "--system-prompt-append", || Ok(append))?;
        }
    }
    push_text_arg(args, "--", || {
        let payload = read(invocation, c"payload")?;
        if payload.truthy()? {
            Ok(payload)
        } else {
            ports.from_value(&"".into())
        }
    })?;
    let result = ports.from_value(&V::Object(vec![]))?;
    result.set(c"spawnCmd", ports.get(c"gatewayBin")?)?;
    result.set(c"finalSpawnArgs", args)?;
    Ok(result.raw())
}
