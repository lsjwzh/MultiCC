//! Physical attempts resolve their route on every preparation. Node supplies
//! existing CLI/SDK ports; ordering, identity and failure cleanup live here.
use crate::js_live::LiveValue as L;
use multicc_core::{cli_capability, js::JsValue as V, provider_invocation};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

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
fn copy<'a>(source: L<'a>) -> Result<L<'a>> {
    let value = object(source, &[])?;
    value.spread_from(source)?;
    Ok(value)
}
fn method<'a>(value: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    value.get(key)?.call(value, args)
}
fn or<'a>(left: L<'a>, right: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if left.truthy()? {
        Ok(left)
    } else {
        right()
    }
}
fn clean_callback(anchor: L<'_>) -> Result<L<'_>> {
    unsafe extern "C" fn callback(
        env: sys::napi_env,
        info: sys::napi_callback_info,
    ) -> sys::napi_value {
        let mut argc = 1;
        let mut value = std::ptr::null_mut();
        if unsafe {
            sys::napi_get_cb_info(
                env,
                info,
                &mut argc,
                &mut value,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } != sys::Status::napi_ok
        {
            return std::ptr::null_mut();
        }
        match L::from_raw(env, value).clean_text() {
            Ok(value) => value.raw(),
            Err(_) => std::ptr::null_mut(),
        }
    }
    let mut value = std::ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_create_function(
            anchor.env(),
            c"clean".as_ptr(),
            5,
            Some(callback),
            std::ptr::null_mut(),
            &mut value,
        )
    })?;
    Ok(L::from_raw(anchor.env(), value))
}
fn protocol<'a>(cli: L<'a>, summary: L<'a>) -> Result<L<'a>> {
    let explicit = if summary.truthy()? {
        or(summary.get(c"apiFormat")?, || summary.get(c"protocol"))?
    } else {
        summary
    }
    .clean_text()?;
    if explicit.truthy()? {
        return Ok(explicit);
    }
    let name = cli.clean_text()?;
    if let Some(family) =
        cli_capability::protocol_family_of(&name.coerce_string()?.to_string_lossy(), true)
    {
        text(cli, family)
    } else {
        or(name, || text(cli, "native"))
    }
}

#[napi]
pub fn provider_invocation_protocol(
    env: Env,
    cli: Unknown<'_>,
    summary: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(protocol(L::new(&env, cli), L::new(&env, summary))?.raw())
}

#[napi]
pub fn provider_retry_route_options(env: Env, attempt: Unknown<'_>) -> Result<sys::napi_value> {
    let attempt = L::new(&env, attempt);
    let route = if attempt.truthy()? && attempt.kind()? == sys::ValueType::napi_object {
        attempt
    } else {
        object(attempt, &[])?
    };
    let provider = route.get(c"providerId")?;
    let model = if route.get(c"model")?.is_string("_default_")? {
        route.from_value(&V::Null)?
    } else {
        route.get(c"model")?
    };
    let options = object(route, &[(c"providerId", provider), (c"model", model)])?;
    if !route.get(c"claudeWorkflow")?.undefined()? {
        options.set(c"claudeWorkflow", route.get(c"claudeWorkflow")?)?;
    }
    if !route.get(c"effort")?.undefined()? {
        options.set(c"effort", route.get(c"effort")?)?;
    }
    Ok(options.raw())
}

#[napi]
pub fn provider_invocation_validate(env: Env, options: Unknown<'_>) -> Result<sys::napi_value> {
    let options = L::new(&env, options);
    let router = options.get(c"providerRouterRuntime")?;
    let attempts = options.get(c"providerAttemptRuntime")?;
    let effective = options.get(c"effectiveSessionModel")?;
    if !router.truthy()?
        || router.get(c"createBinding")?.kind()? != sys::ValueType::napi_function
        || router.get(c"resolveSpawnEnv")?.kind()? != sys::ValueType::napi_function
        || router.get(c"getProviderSummary")?.kind()? != sys::ValueType::napi_function
    {
        return Err(options.type_error("provider router runtime is required"));
    }
    if !attempts.truthy()?
        || attempts.get(c"beginAttempt")?.kind()? != sys::ValueType::napi_function
        || attempts.get(c"proxySessionId")?.kind()? != sys::ValueType::napi_function
    {
        return Err(options.type_error("provider attempt runtime is required"));
    }
    if effective.kind()? != sys::ValueType::napi_function {
        return Err(options.type_error("effective session model resolver is required"));
    }
    Ok(object(
        options,
        &[
            (c"router", router),
            (c"attempts", attempts),
            (c"effective", effective),
        ],
    )?
    .raw())
}

#[napi]
pub fn provider_invocation_prepare(
    env: Env,
    input: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let ports = L::new(&env, ports);
    let request = input.get(c"request")?;
    let turn = input.get(c"turn")?;
    let session = input.get(c"session")?;
    let provider = input.get(c"provider")?;
    let envelope = input.get(c"envelope")?;
    if !request.truthy()?
        || !turn.truthy()?
        || !session.truthy()?
        || !provider.truthy()?
        || !envelope.truthy()?
        || provider.get(c"buildInvocation")?.kind()? != sys::ValueType::napi_function
    {
        return Err(input.type_error("provider invocation input is incomplete"));
    }
    let router = ports.get(c"router")?;
    let attempts = ports.get(c"attempts")?;
    let undefined = input.from_value(&V::Undefined)?;
    let null = input.from_value(&V::Null)?;
    let yes = input.from_value(&V::Bool(true))?;
    let no = input.from_value(&V::Bool(false))?;
    let empty = text(input, "")?;
    let default = text(input, "_default_")?;
    let native = !ports
        .get(c"nativeOpenCodeId")?
        .call_plain(&[input.get(c"providerId")?])?
        .nullish()?
        || !ports
            .get(c"nativeVendorOf")?
            .call_plain(&[input.get(c"providerId")?])?
            .nullish()?;
    let spawn_provider = if native {
        empty
    } else {
        input.get(c"providerId")?
    };
    let overrides = object(input, &[])?;
    if !input.get(c"providerId")?.undefined()? {
        overrides.set(c"providerId", spawn_provider)?;
    }
    if !input.get(c"model")?.undefined()? {
        overrides.set(c"model", input.get(c"model")?)?;
    }
    overrides.freeze()?;
    let model_override = !input.get(c"model")?.undefined()?;
    let route_binding = method(router, c"createBinding", &[session, overrides])?;
    let resolution = method(router, c"resolveSpawnEnv", &[session, overrides])?;
    let raw_model = or(resolution.get(c"qualifiedModel")?.clean_text()?, || {
        or(route_binding.get(c"model")?.clean_text()?, || {
            if model_override {
                Ok(null)
            } else {
                envelope.get(c"spawnOpts")?.get(c"rawModel")
            }
        })
    })?;
    let effective = if model_override {
        or(route_binding.get(c"model")?.clean_text()?, || {
            or(resolution.get(c"providerModel")?.clean_text()?, || Ok(null))
        })?
    } else {
        ports.get(c"effective")?.call_plain(&[session])?
    };
    let base = copy(envelope)?;
    let spawn = copy(envelope.get(c"spawnOpts")?)?;
    for key in [c"skipDefaultModel", c"providerModel", c"providerModels"] {
        spawn.set(key, resolution.get(key)?)?;
    }
    spawn.set(c"effectiveModel", effective)?;
    spawn.set(c"rawModel", raw_model)?;
    let effort = input.get(c"effort")?;
    if !effort.undefined()? {
        spawn.set(c"rawEffort", effort)?;
        if effort.is_string("ultracode")? {
            spawn.set(
                c"rawEffort",
                crate::cli_capability::legacy_effort_value(spawn.get(c"rawModel")?)?,
            )?;
            spawn.set(c"ultracode", yes)?;
        }
    }
    if !input.get(c"claudeWorkflow")?.undefined()? {
        spawn.set(c"ultracode", input.get(c"claudeWorkflow")?)?;
    }
    base.set(c"spawnOpts", spawn)?;
    let invocation_envelope = if input.get(c"bareText")?.undefined()? {
        base
    } else {
        let value = copy(base)?;
        value.set(c"contextLayers", input.from_value(&V::Array(vec![]))?)?;
        value.set(
            c"userText",
            input
                .global()?
                .get(c"String")?
                .call_plain(&[input.get(c"bareText")?])?,
        )?;
        value.set(c"suffix", empty)?;
        let history = copy(base.get(c"historyHandle")?)?;
        history.set(
            c"isFirstTurn",
            if input.get(c"firstTurn")?.is_true()? {
                yes
            } else {
                no
            },
        )?;
        history.set(c"cliSessionId", session.get(c"cliSessionId")?)?;
        value.set(c"historyHandle", history)?;
        let spawn = copy(base.get(c"spawnOpts")?)?;
        if spawn.get(c"ultracode")?.undefined()? {
            spawn.set(c"ultracode", no)?;
        }
        value.set(c"spawnOpts", spawn)?;
        value
    };
    let invocation = method(provider, c"buildInvocation", &[invocation_envelope])?;
    let spawn = invocation_envelope.get(c"spawnOpts")?;
    let model = or(spawn.get(c"rawModel")?.clean_text()?, || {
        or(spawn.get(c"effectiveModel")?.clean_text()?, || {
            or(resolution.get(c"providerModel")?.clean_text()?, || {
                or(route_binding.get(c"model")?.clean_text()?, || Ok(default))
            })
        })
    })?;
    let binding_options = copy(overrides)?;
    binding_options.set(c"model", model)?;
    let binding = method(router, c"createBinding", &[session, binding_options])?;
    let provider_id = or(binding.get(c"providerId")?, || Ok(default))?;
    let selected = or(route_binding.get(c"model")?.clean_text()?, || {
        or(resolution.get(c"providerModel")?.clean_text()?, || {
            let models = resolution.get(c"providerModels")?;
            if models.is_array()? {
                let mapped = method(
                    resolution.get(c"providerModels")?,
                    c"map",
                    &[clean_callback(input)?],
                )?;
                let value = method(mapped, c"find", &[input.global()?.get(c"Boolean")?])?;
                or(value, || Ok(null))
            } else {
                Ok(null)
            }
        })
    })?;
    let route_overrides = object(
        input,
        &[
            (c"providerId", binding.get(c"providerId")?),
            (c"model", selected),
        ],
    )?
    .freeze()?;
    let summary = if binding.get(c"providerId")?.truthy()? {
        method(
            router,
            c"getProviderSummary",
            &[undefined, binding.get(c"providerId")?],
        )?
    } else {
        null
    };
    let wire_protocol = protocol(binding.get(c"cli")?, summary)?;
    let name = or(resolution.get(c"providerName")?.clean_text()?, || {
        or(
            if summary.truthy()? {
                summary.get(c"name")?
            } else {
                summary
            }
            .clean_text()?,
            || Ok(provider_id),
        )
    })?;
    let revision_input = object(
        input,
        &[
            (c"cli", binding.get(c"cli")?),
            (c"providerId", provider_id),
            (c"protocol", wire_protocol),
            (c"model", model),
            (c"summary", summary),
        ],
    )?;
    let revision = ports.get(c"revision")?.call_plain(&[revision_input])?;
    let attempt_input = object(
        input,
        &[
            (c"sessionId", binding.get(c"sessionId")?),
            (c"turnId", turn.get(c"turnId")?),
            (c"cli", binding.get(c"cli")?),
            (c"providerId", provider_id),
            (c"providerName", name),
            (c"protocol", wire_protocol),
            (c"model", model),
            (c"providerRevision", revision),
            (
                c"subagentProviderId",
                if session.get(c"subagent")?.truthy()? {
                    session.get(c"subagent")?.get(c"providerId")?
                } else {
                    session.get(c"subagent")?
                },
            ),
            (c"attemptNo", input.get(c"attemptNo")?),
            (c"reasonCode", input.get(c"reasonCode")?),
            (
                c"continuation",
                if input.get(c"continuation")?.is_true()? {
                    yes
                } else {
                    no
                },
            ),
        ],
    )?;
    for key in [c"effort", c"claudeWorkflow"] {
        let value = input.get(key)?;
        if !value.undefined()? {
            attempt_input.set(key, value)?;
        }
    }
    attempt_input.spread_from(
        ports
            .get(c"policy")?
            .call_plain(&[session, input.get(c"env")?])?,
    )?;
    let responses = cli_capability::protocol_family_of(
        &binding
            .get(c"cli")?
            .clean_text()?
            .coerce_string()?
            .to_string_lossy(),
        true,
    ) == Some("openai_responses");
    let spawn_revision = if responses {
        let value = object(
            input,
            &[
                (c"cli", binding.get(c"cli")?),
                (c"providerId", provider_id),
                (c"protocol", wire_protocol),
                (c"model", text(input, "_spawn_")?),
                (c"summary", summary),
            ],
        )?;
        ports.get(c"revision")?.call_plain(&[value])?
    } else {
        revision
    };
    let subagent = if session.get(c"subagent")?.truthy()? {
        let id = session.get(c"subagent")?.get(c"providerId")?.clean_text()?;
        let model = session.get(c"subagent")?.get(c"model")?.clean_text()?;
        let facts = object(
            input,
            &[
                (c"cli", binding.get(c"cli")?),
                (c"providerId", session.get(c"subagent")?.get(c"providerId")?),
                (c"protocol", wire_protocol),
                (
                    c"model",
                    or(session.get(c"subagent")?.get(c"model")?, || Ok(default))?,
                ),
                (
                    c"summary",
                    method(
                        router,
                        c"getProviderSummary",
                        &[undefined, session.get(c"subagent")?.get(c"providerId")?],
                    )?,
                ),
            ],
        )?;
        object(
            input,
            &[
                (c"providerId", id),
                (c"model", model),
                (c"revision", ports.get(c"revision")?.call_plain(&[facts])?),
            ],
        )?
    } else {
        null
    };
    let contract = input.from_value(&V::Array(vec![]))?;
    for (i, value) in [provider_id, wire_protocol, spawn_revision, subagent]
        .iter()
        .enumerate()
    {
        contract.set_element(i as u32, *value)?;
    }
    if !responses {
        let args = if invocation.truthy()? {
            or(invocation.get(c"sdkOptions")?, || {
                or(invocation.get(c"streamArgs")?, || invocation.get(c"args"))
            })?
        } else {
            invocation
        };
        contract.set_element(4, or(args, || Ok(null))?)?;
        contract.set_element(
            5,
            or(
                if invocation.truthy()? {
                    invocation.get(c"settings")?
                } else {
                    invocation
                },
                || Ok(null),
            )?,
        )?;
    }
    let json = input.global()?.get(c"JSON")?;
    let serialized = method(json, c"stringify", &[contract])?.coerce_string()?;
    attempt_input.set(
        c"spawnKey",
        text(input, &provider_invocation::spawn_key(&serialized))?,
    )?;
    let attempt = method(attempts, c"beginAttempt", &[attempt_input])?;
    let prepared = (|| {
        let proof = object(
            input,
            &[
                (c"resolved", yes),
                (c"binding", binding),
                (c"providerName", name),
                (c"protocol", wire_protocol),
                (c"runtimeEpoch", attempt.get(c"runtimeEpoch")?),
                (c"turnId", turn.get(c"turnId")?),
                (c"decisionId", attempt.get(c"decisionId")?),
                (c"routeAttemptId", attempt.get(c"routeAttemptId")?),
                (c"routeGeneration", attempt.get(c"routeGeneration")?),
                (c"attemptNo", attempt.get(c"attemptNo")?),
                (c"providerRevision", revision),
            ],
        )?;
        let proof = ports.get(c"proof")?.call_plain(&[request, proof])?;
        Ok((proof, method(attempts, c"proxySessionId", &[attempt])?))
    })();
    let (proof, proxy_session) = match prepared {
        Ok(value) => value,
        Err(error) => {
            let exception = input.exception_value()?;
            let failure = object(
                input,
                &[
                    (c"outcome", text(input, "failed")?),
                    (c"errorCategory", text(input, "route_proof")?),
                    (c"reasonCode", text(input, "route_proof_rejected")?),
                ],
            )?;
            method(attempts, c"finishAttempt", &[attempt, failure])?;
            if let Some(exception) = exception {
                return Err(exception.throw_error());
            }
            return Err(error);
        }
    };
    let usage = object(
        input,
        &[
            (c"providerId", provider_id),
            (c"providerName", name),
            (c"cli", binding.get(c"cli")?),
            (c"protocol", wire_protocol),
            (c"model", model),
            (c"roleKind", text(input, "main")?),
            (c"routeName", text(input, "main")?),
        ],
    )?
    .freeze()?;
    let attributed = copy(usage)?;
    for key in [
        c"runtimeEpoch",
        c"decisionId",
        c"routeAttemptId",
        c"routeGeneration",
        c"attemptNo",
        c"providerRevision",
    ] {
        attributed.set(key, attempt.get(key)?)?;
    }
    attributed.freeze()?;
    Ok(object(
        input,
        &[
            (c"routeOverrides", route_overrides),
            (c"routeBinding", route_binding),
            (c"binding", binding),
            (c"resolution", resolution),
            (c"invocationEnvelope", invocation_envelope),
            (c"invocation", invocation),
            (c"attempt", attempt),
            (c"routeProof", proof),
            (c"proxySessionId", proxy_session),
            (c"baseUsageAttribution", usage),
            (c"usageAttribution", attributed),
        ],
    )?
    .freeze()?
    .raw())
}
