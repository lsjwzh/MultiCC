//! N-API surface for per-session subagent routing (`src/session/subagent.js`)
//! and fork configuration (`src/session/fork-configuration.js`).
#![cfg_attr(test, allow(dead_code))]

use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as V, session_subagent as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Result,
};
use napi_derive::napi;
use std::ffi::CString;

fn new_object(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&V::Object(vec![]))
}

fn default_object<'a>(value: L<'a>, first_key: &str) -> Result<L<'a>> {
    if value.undefined()? {
        new_object(value)
    } else if value.kind()? == sys::ValueType::napi_null {
        Err(value.type_error(&format!(
            "Cannot read properties of null (reading '{first_key}')"
        )))
    } else {
        Ok(value)
    }
}

fn arity(function: L<'_>, length: f64) -> Result<L<'_>> {
    let value = function.from_value(&V::Number(length))?;
    let descriptor = sys::napi_property_descriptor {
        utf8name: c"length".as_ptr(),
        value: value.raw(),
        attributes: sys::PropertyAttributes::configurable,
        ..unsafe { std::mem::zeroed() }
    };
    check_status!(unsafe {
        sys::napi_define_properties(function.env(), function.raw(), 1, &descriptor)
    })?;
    Ok(function)
}

fn error_result<'a>(anchor: L<'a>, message: &str) -> Result<L<'a>> {
    let out = new_object(anchor)?;
    out.set(c"ok", anchor.from_value(&V::Bool(false))?)?;
    out.set(c"error", anchor.from_value(&V::string(message))?)?;
    Ok(out)
}

fn trim_or_empty<'a>(anchor: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let text = if value.truthy()? {
        value.get(c"toString")?.call(value, &[])?
    } else {
        anchor.from_value(&V::string(""))?
    };
    text.get(c"trim")?.call(text, &[])
}

fn is_empty_object(value: L<'_>) -> Result<bool> {
    if value.kind()? != sys::ValueType::napi_object {
        return Ok(false);
    }
    let object_ctor = value.global()?.get(c"Object")?;
    let keys = object_ctor.get(c"keys")?.call(object_ctor, &[value])?;
    Ok(keys.get(c"length")?.number()? == 0.0)
}

fn json_clone<'a>(anchor: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let json = anchor.global()?.get(c"JSON")?;
    let serialized = json.get(c"stringify")?.call(json, &[value])?;
    json.get(c"parse")?.call(json, &[serialized])
}

fn normalize_subagent_input_live<'a>(input: L<'a>) -> Result<L<'a>> {
    let input = default_object(input, "cli")?;
    let cli = input.get(c"cli")?;
    let raw_provider = input.get(c"provider")?;
    let provider = if raw_provider.undefined()? {
        input.from_value(&V::Null)?
    } else {
        raw_provider
    };
    let raw_subagent = input.get(c"subagent")?;
    let subagent = if raw_subagent.undefined()? {
        input.from_value(&V::Null)?
    } else {
        raw_subagent
    };
    let valid_provider_id = input.get(c"validProviderId")?;
    let providers = input.get(c"providers")?;

    let clearing = subagent.kind()? == sys::ValueType::napi_null
        || subagent.is_string("")?
        || is_empty_object(subagent)?;
    if clearing {
        let out = new_object(input)?;
        out.set(c"ok", input.from_value(&V::Bool(true))?)?;
        out.set(c"value", input.from_value(&V::Null)?)?;
        out.set(c"cleared", input.from_value(&V::Bool(true))?)?;
        return Ok(out);
    }

    let app_type_owned: Option<String> = if !cli.truthy()? {
        Some("claude".to_string())
    } else if let Some(s) = cli.string()? {
        let lossy = s.to_string_lossy();
        Some(core::normalize_app_type(Some(&lossy)).to_string())
    } else {
        None
    };

    let Some(app_type) = app_type_owned.as_deref() else {
        return error_result(input, core::ERR_UNSUPPORTED_CLI);
    };
    if !core::is_supported_app_type(app_type) {
        return error_result(input, core::ERR_UNSUPPORTED_CLI);
    }
    if subagent.kind()? != sys::ValueType::napi_object {
        return error_result(input, core::ERR_INVALID_SUBAGENT);
    }

    let pid_trimmed = trim_or_empty(input, subagent.get(c"providerId")?)?;
    let app_type_js = input.from_value(&V::string(app_type))?;
    let validated = valid_provider_id.call_plain(&[app_type_js, pid_trimmed])?;
    if !validated.get(c"ok")?.truthy()? {
        return error_result(input, core::ERR_INVALID_PROVIDER);
    }
    let model_trimmed = trim_or_empty(input, subagent.get(c"model")?)?;
    if !model_trimmed.truthy()? {
        return error_result(input, core::ERR_MODEL_REQUIRED);
    }

    let validated_value = validated.get(c"value")?;
    if app_type == "codex" {
        if !provider.truthy()? {
            return error_result(input, core::ERR_CODEX_MAIN_PROVIDER);
        }
        let proxyable = providers
            .get(c"codexProviderProxyable")?
            .call(providers, &[validated_value])?;
        if !proxyable.truthy()? {
            return error_result(input, core::ERR_CODEX_NO_ENDPOINT);
        }
    }

    let route = new_object(input)?;
    route.set(c"providerId", validated_value)?;
    route.set(c"model", model_trimmed)?;
    let out = new_object(input)?;
    out.set(c"ok", input.from_value(&V::Bool(true))?)?;
    out.set(c"value", route)?;
    out.set(c"cleared", input.from_value(&V::Bool(false))?)?;
    Ok(out)
}

fn with_subagent_source_live<'a>(next: L<'a>, previous: L<'a>, inherited: L<'a>) -> Result<L<'a>> {
    if !next.truthy()? {
        return next.from_value(&V::Null);
    }
    let inherited_flag = if inherited.undefined()? {
        false
    } else {
        inherited.truthy()?
    };
    let same = previous.truthy()?
        && previous
            .get(c"providerId")?
            .equals(next.get(c"providerId")?)?
        && previous.get(c"model")?.equals(next.get(c"model")?)?;
    let prev_inherited = if same {
        previous.get(c"inherited")?.is_true()?
    } else {
        false
    };
    if core::should_mark_inherited(same, prev_inherited, inherited_flag) {
        let out = new_object(next)?;
        out.spread_from(next)?;
        out.set(c"inherited", next.from_value(&V::Bool(true))?)?;
        Ok(out)
    } else {
        Ok(next)
    }
}

fn family_default_subagent_live<'a>(input: L<'a>) -> Result<L<'a>> {
    let input = default_object(input, "cli")?;
    let cli = input.get(c"cli")?;
    let raw_provider = input.get(c"provider")?;
    let provider = if raw_provider.undefined()? {
        input.from_value(&V::Null)?
    } else {
        raw_provider
    };
    let provider_defaults = input.get(c"providerDefaults")?;
    let valid_provider_id = input.get(c"validProviderId")?;
    let providers = input.get(c"providers")?;

    let cli_str = cli.string()?.map(|s| s.to_string_lossy());
    let Some(family) = core::family_of_cli(cli_str.as_deref()) else {
        return input.from_value(&V::Null);
    };

    let subagent_map = provider_defaults.optional(c"subagent")?;
    let family_c = CString::new(family).expect("static family");
    let route = subagent_map.optional(&family_c)?;
    if route.nullish()? || !route.truthy()? {
        return input.from_value(&V::Null);
    }

    let check_input = new_object(input)?;
    check_input.set(c"cli", cli)?;
    check_input.set(c"provider", provider)?;
    check_input.set(c"subagent", route)?;
    check_input.set(c"validProviderId", valid_provider_id)?;
    check_input.set(c"providers", providers)?;
    let checked = normalize_subagent_input_live(check_input)?;
    let value = checked.get(c"value")?;
    if checked.get(c"ok")?.truthy()? && value.truthy()? {
        let out = new_object(input)?;
        out.spread_from(value)?;
        out.set(c"inherited", input.from_value(&V::Bool(true))?)?;
        Ok(out)
    } else {
        input.from_value(&V::Null)
    }
}

fn desired_session_live<'a>(record: L<'a>) -> Result<L<'a>> {
    let draft = json_clone(record, record)?;
    let pending = record.get(c"pendingConfiguration")?;
    if pending.truthy()? {
        draft.assign(c"cli", pending.get(c"cli")?)?;
        let object_ctor = record.global()?.get(c"Object")?;
        object_ctor
            .get(c"assign")?
            .call(object_ctor, &[draft, pending.get(c"profile")?])?;
    }
    Ok(draft)
}

fn read_configuration_live<'a>(session: L<'a>) -> Result<L<'a>> {
    let out = new_object(session)?;
    for field in core::CONFIG_FIELDS {
        let c_name = CString::new(field).expect("static config field");
        let raw = session.get(&c_name)?;
        let value = if raw.nullish()? {
            session.from_value(&V::Null)?
        } else {
            json_clone(session, raw)?
        };
        out.set(&c_name, value)?;
    }
    Ok(out)
}

fn fork_configuration_live<'a>(record: L<'a>, deps: L<'a>) -> Result<L<'a>> {
    if deps.nullish()? {
        return Err(deps.type_error("Cannot destructure property 'validProviderId' of nullish"));
    }
    let valid_provider_id = deps.get(c"validProviderId")?;
    let validate_provider_selection = deps.get(c"validateProviderSelection")?;
    let providers = deps.get(c"providers")?;

    let desired = desired_session_live(record)?;
    let desired_cli = desired.get(c"cli")?;
    let configuration = new_object(record)?;
    configuration.set(c"cli", desired_cli)?;
    let config_fields = read_configuration_live(desired)?;
    configuration.spread_from(config_fields)?;

    let sel_opts = new_object(record)?;
    sel_opts.set(c"cli", desired_cli)?;
    sel_opts.set(c"providers", providers)?;
    let selection = validate_provider_selection
        .call_plain(&[configuration.get(c"providerSelection")?, sel_opts])?;
    let provider = valid_provider_id.call_plain(&[desired_cli, configuration.get(c"provider")?])?;

    let reset = if !provider.get(c"ok")?.truthy()? || !selection.get(c"ok")?.truthy()? {
        configuration.assign(c"provider", record.from_value(&V::Undefined)?)?;
        configuration.assign(c"providerSelection", record.from_value(&V::Null)?)?;
        configuration.assign(c"model", record.from_value(&V::Null)?)?;
        configuration.assign(c"subagent", record.from_value(&V::Null)?)?;
        true
    } else {
        configuration.assign(c"provider", provider.get(c"value")?)?;
        configuration.assign(c"providerSelection", selection.get(c"value")?)?;
        let sub_input = new_object(record)?;
        sub_input.spread_from(configuration)?;
        sub_input.set(c"validProviderId", valid_provider_id)?;
        sub_input.set(c"providers", providers)?;
        let subagent = normalize_subagent_input_live(sub_input)?;
        let sub_ok = subagent.get(c"ok")?.truthy()?;
        let sub_val = if sub_ok {
            subagent.get(c"value")?
        } else {
            record.from_value(&V::Null)?
        };
        configuration.assign(c"subagent", sub_val)?;
        !sub_ok
    };

    let out = new_object(record)?;
    out.set(c"configuration", configuration)?;
    out.set(c"reset", record.from_value(&V::Bool(reset))?)?;
    Ok(out)
}

#[napi]
pub fn session_subagent_normalize(env: Env, input: Option<Unknown<'_>>) -> Result<sys::napi_value> {
    let absent = L::new(&env, ().into_unknown(&env)?);
    let input_val = input.map_or(absent, |v| L::new(&env, v));
    Ok(normalize_subagent_input_live(input_val)?.raw())
}

#[napi]
pub fn session_subagent_with_source(
    env: Env,
    next: Unknown<'_>,
    previous: Option<Unknown<'_>>,
    inherited: Option<Unknown<'_>>,
) -> Result<sys::napi_value> {
    let absent = L::new(&env, ().into_unknown(&env)?);
    let next_val = L::new(&env, next);
    let prev_val = previous.map_or(absent, |v| L::new(&env, v));
    let inh_val = inherited.map_or(absent, |v| L::new(&env, v));
    Ok(with_subagent_source_live(next_val, prev_val, inh_val)?.raw())
}

#[napi]
pub fn session_subagent_family_default(
    env: Env,
    input: Option<Unknown<'_>>,
) -> Result<sys::napi_value> {
    let absent = L::new(&env, ().into_unknown(&env)?);
    let input_val = input.map_or(absent, |v| L::new(&env, v));
    Ok(family_default_subagent_live(input_val)?.raw())
}

#[napi]
pub fn session_fork_configuration(
    env: Env,
    record: Unknown<'_>,
    deps: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(fork_configuration_live(L::new(&env, record), L::new(&env, deps))?.raw())
}

#[napi]
pub fn session_subagent_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let api = new_object(anchor)?;

    let norm_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "normalizeSubagentInput",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let input = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            Ok(normalize_subagent_input_live(input)?.raw())
        },
    )?;
    let with_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "withSubagentSource",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let arg = |idx| -> Result<L<'_>> {
                if idx < ctx.length() {
                    Ok(L::new(ctx.env, ctx.get::<Unknown<'_>>(idx)?))
                } else {
                    Ok(absent)
                }
            };
            Ok(with_subagent_source_live(arg(0)?, arg(1)?, arg(2)?)?.raw())
        },
    )?;
    let default_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "familyDefaultSubagent",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let input = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            Ok(family_default_subagent_live(input)?.raw())
        },
    )?;

    api.set(
        c"normalizeSubagentInput",
        arity(L::new(&env, norm_fn.into_unknown(&env)?), 0.0)?,
    )?;
    api.set(
        c"withSubagentSource",
        arity(L::new(&env, with_fn.into_unknown(&env)?), 2.0)?,
    )?;
    api.set(
        c"familyDefaultSubagent",
        arity(L::new(&env, default_fn.into_unknown(&env)?), 0.0)?,
    )?;
    Ok(api.raw())
}

#[napi]
pub fn session_fork_configuration_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let api = new_object(anchor)?;
    let fork_fn = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "forkConfiguration",
        |ctx| {
            let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
            let record = if ctx.length() > 0 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
            } else {
                absent
            };
            let deps = if ctx.length() > 1 {
                L::new(ctx.env, ctx.get::<Unknown<'_>>(1)?)
            } else {
                absent
            };
            Ok(fork_configuration_live(record, deps)?.raw())
        },
    )?;
    api.set(
        c"forkConfiguration",
        arity(L::new(&env, fork_fn.into_unknown(&env)?), 2.0)?,
    )?;
    Ok(api.raw())
}
