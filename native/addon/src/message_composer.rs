//! Synchronous, bounded prompt assembly over borrowed host values. No JSON copy,
//! retained references, file scans or generated JavaScript. Rust owns ordering,
//! gating, validation and delivery; callbacks remain the existing host ports.
use crate::js_live::LiveValue as L;
use multicc_core::{
    js::{JsString, JsValue as V},
    message_composer as policy,
};
use napi::bindgen_prelude::{ToNapiValue, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

mod managed_context;

fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&V::from(value))
}
fn object<'a>(a: L<'a>, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
    let out = a.from_value(&V::Object(vec![]))?;
    for (key, value) in fields {
        out.set(key, *value)?;
    }
    Ok(out)
}
fn array(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&V::Array(vec![]))
}
fn method<'a>(value: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    value.get(key)?.call(value, args)
}
fn function(value: L<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_function)
}
fn string(value: L<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_string)
}
fn or<'a>(value: L<'a>, fallback: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        fallback()
    }
}
fn default<'a>(value: L<'a>, fallback: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if value.undefined()? {
        fallback()
    } else {
        Ok(value)
    }
}
fn concat<'a>(a: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let mut out = JsString::new();
    for value in values {
        out.push(&value.coerce_string()?);
    }
    a.from_value(&V::String(out))
}
fn join_system<'a>(a: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let all = array(a)?;
    for (i, value) in values.iter().enumerate() {
        all.set_element(i as u32, *value)?;
    }
    let filtered = method(all, c"filter", &[a.global()?.get(c"Boolean")?])?;
    method(filtered, c"join", &[text(a, "\n\n")?])
}
fn sort<'a>(env: &'a Env, layers: L<'a>) -> Result<L<'a>> {
    let callback =
        env.create_function_from_closure::<Unknown<'_>, f64, _>("promptLayerOrder", |ctx| {
            let a = L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?).get(c"order")?;
            let b = L::new(ctx.env, ctx.get::<Unknown<'_>>(1)?).get(c"order")?;
            Ok(a.number()? - b.number()?)
        })?;
    method(layers, c"sort", &[L::new(env, callback.into_unknown(env)?)])
}
fn layer(layers: L<'_>, kind: &str, order: f64, value: L<'_>) -> Result<()> {
    let out = object(
        layers,
        &[
            (c"kind", text(layers, kind)?),
            (c"order", layers.from_value(&V::Number(order))?),
            (c"text", value),
        ],
    )?;
    method(layers, c"push", &[out])?;
    Ok(())
}
fn auto_commit(persisted: L<'_>) -> Result<L<'_>> {
    text(
        persisted,
        if persisted.get(c"autoCommit")?.is_false()? {
            policy::AUTO_OFF
        } else {
            policy::AUTO_ON
        },
    )
}

#[napi]
pub fn message_auto_commit_prompt(env: Env, persisted: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(auto_commit(L::new(&env, persisted))?.raw())
}

#[napi]
pub fn message_normalize_voice(env: Env, source: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(normalize_voice(L::new(&env, source))?.raw())
}

pub(crate) fn normalize_voice(source: L<'_>) -> Result<L<'_>> {
    if !source.truthy()? || !source.get(c"inputSource")?.is_string("voice")? {
        return source.from_value(&V::Null);
    }
    let raw = if string(source.get(c"voiceRaw")?)? {
        let trimmed = method(source.get(c"voiceRaw")?, c"trim", &[])?;
        method(
            trimmed,
            c"slice",
            &[
                source.from_value(&V::Number(0.0))?,
                source.from_value(&V::Number(4000.0))?,
            ],
        )?
    } else {
        text(source, "")?
    };
    object(source, &[(c"raw", raw)])
}

fn voice_prompt<'a>(voice: L<'a>, user_text: L<'a>) -> Result<L<'a>> {
    let raw = if voice.truthy()? && string(voice.get(c"raw")?)? {
        voice.get(c"raw")?
    } else {
        text(voice, "")?
    };
    let edited = if raw.truthy()? {
        let input = or(user_text, || text(voice, ""))?;
        let converted = voice.global()?.get(c"String")?.call_plain(&[input])?;
        !raw.equals(method(converted, c"trim", &[])?)?
    } else {
        false
    };
    // Template interpolation happens only for an edited transcript.
    let raw = if edited {
        raw.coerce_string()?
    } else {
        JsString::new()
    };
    voice.from_value(&V::String(policy::voice_prompt(&raw, edited)))
}

#[napi]
pub fn message_voice_prompt(
    env: Env,
    voice: Unknown<'_>,
    user_text: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(voice_prompt(L::new(&env, voice), L::new(&env, user_text))?.raw())
}

fn validate(envelope: L<'_>, environment: L<'_>, console: L<'_>) -> Result<()> {
    let production = environment.get(c"NODE_ENV")?.is_string("production")?;
    let mut violations = Vec::<JsString>::new();
    if !envelope.truthy()? || envelope.kind()? != sys::ValueType::napi_object {
        violations.push(JsString::from_rust_str("envelope must be an object"));
    } else {
        if !string(envelope.get(c"userText")?)? || !envelope.get(c"userText")?.truthy()? {
            violations.push(JsString::from_rust_str(
                "userText must be a non-empty string",
            ));
        }
        if !envelope.get(c"contextLayers")?.is_array()? {
            violations.push(JsString::from_rust_str("contextLayers must be an array"));
        } else {
            let seen = envelope.global()?.get(c"Set")?.construct(&[])?;
            let mut previous = envelope.from_value(&V::Number(f64::NEG_INFINITY))?;
            envelope.get(c"contextLayers")?.for_each(|item| {
                if !item.truthy()?
                    || !string(item.get(c"text")?)?
                    || !item.get(c"text")?.truthy()?
                {
                    let kind = if item.truthy()? {
                        item.get(c"kind")?
                    } else {
                        item
                    };
                    violations.push(
                        concat(
                            envelope,
                            &[
                                text(envelope, "empty layer text (kind: ")?,
                                kind,
                                text(envelope, ")")?,
                            ],
                        )?
                        .coerce_string()?,
                    );
                }
                if item.truthy()? && !item.get(c"kind")?.nullish()? {
                    if method(seen, c"has", &[item.get(c"kind")?])?.truthy()? {
                        violations.push(
                            concat(
                                envelope,
                                &[
                                    text(envelope, "duplicate layer kind: ")?,
                                    item.get(c"kind")?,
                                ],
                            )?
                            .coerce_string()?,
                        );
                    }
                    method(seen, c"add", &[item.get(c"kind")?])?;
                }
                if item.truthy()? && item.get(c"order")?.kind()? == sys::ValueType::napi_number {
                    let order = item.get(c"order")?;
                    if order.number()? < previous.number()? {
                        violations.push(
                            concat(
                                envelope,
                                &[
                                    text(envelope, "contextLayers not sorted by order asc (kind=")?,
                                    item.get(c"kind")?,
                                    text(envelope, " order=")?,
                                    item.get(c"order")?,
                                    text(envelope, " after ")?,
                                    previous,
                                    text(envelope, ")")?,
                                ],
                            )?
                            .coerce_string()?,
                        );
                    }
                    previous = item.get(c"order")?;
                }
                Ok(())
            })?;
        }
        let expected = join_system(
            envelope,
            &[
                envelope.get(c"imgHint")?,
                envelope.get(c"subagentHint")?,
                envelope.get(c"rolePrompt")?,
            ],
        )?;
        if !envelope.get(c"systemPrompt")?.equals(expected)? {
            violations.push(JsString::from_rust_str("systemPrompt derivation mismatch (expected [imgHint, subagentHint?, rolePrompt?].join(\\n\\n))"));
        }
    }
    if !violations.is_empty() {
        let mut message = JsString::from_rust_str("[message-composer] envelope validation: ");
        message.push(&JsString::join(&violations, &JsString::from_rust_str("; ")));
        let message = envelope.from_value(&V::String(message))?;
        if production {
            method(console, c"warn", &[message])?;
        } else {
            return Err(envelope
                .global()?
                .get(c"Error")?
                .construct(&[message])?
                .throw_error());
        }
    }
    Ok(())
}

#[napi]
pub fn message_validate_envelope(
    env: Env,
    envelope: Unknown<'_>,
    environment: Unknown<'_>,
    console: Unknown<'_>,
) -> Result<()> {
    validate(
        L::new(&env, envelope),
        L::new(&env, environment),
        L::new(&env, console),
    )
}

#[napi]
pub fn message_compose(
    env: Env,
    input: Unknown<'_>,
    environment: Unknown<'_>,
    console: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let user_text = input.get(c"text")?;
    let persisted = input.get(c"persisted")?;
    let session = input.get(c"sessionName")?;
    let opts = input.get(c"opts")?;
    let deps = input.get(c"deps")?;
    let opts = or(opts, || object(input, &[]))?;
    let first = opts.get(c"isFirstTurn")?;
    let seed = opts.get(c"taskContextSeed")?;
    let mode = default(opts.get(c"mode")?, || text(input, "per-turn"))?;
    let bare = default(opts.get(c"bare")?, || input.from_value(&V::Bool(false)))?;
    let provider_model = opts.get(c"providerModel")?;
    let provider_models = opts.get(c"providerModels")?;
    let skip_default = opts.get(c"skipDefaultModel")?;
    let disallowed = default(opts.get(c"disallowedTools")?, || array(input))?;
    let lang = opts.get(c"lang")?;
    let voice = opts.get(c"voice")?;
    let role = method(deps, c"resolveRolePrompt", &[persisted])?;
    let image = deps.get(c"multiccImgHint")?;
    let subagent = if function(deps.get(c"buildSubagentProviderHint")?)? {
        let build = deps.get(c"buildSubagentProviderHint")?;
        or(build.call(deps, &[persisted.get(c"subagent")?])?, || {
            text(input, "")
        })?
    } else {
        text(input, "")?
    };
    let system = join_system(input, &[image, subagent, role])?;
    let layers = array(input)?;
    if !bare.truthy()? {
        if string(seed)? && seed.truthy()? {
            layer(layers, "task-context", 12.0, seed)?;
        }
        if function(deps.get(c"buildCliHandoffPrompt")?)? {
            let handoff = method(deps, c"buildCliHandoffPrompt", &[persisted])?;
            if handoff.truthy()? {
                layer(layers, "cli-handoff", 15.0, handoff)?;
            }
        }
        if function(deps.get(c"buildPlanPrompt")?)?
            && !persisted.get(c"type")?.is_string("aux")?
            && !persisted.get(c"type")?.is_string("gateway")?
        {
            let plan = method(
                deps,
                c"buildPlanPrompt",
                &[
                    persisted,
                    session,
                    object(input, &[(c"isFirstTurn", first)])?,
                ],
            )?;
            if plan.truthy()? {
                layer(layers, "turn-plan", 18.0, plan)?;
            }
        }
        if !persisted.get(c"type")?.is_string("aux")?
            && !persisted.get(c"type")?.is_string("gateway")?
        {
            layer(layers, "autocommit-status", 19.0, auto_commit(persisted)?)?;
        }
        if persisted.get(c"type")?.is_string("gateway")? {
            layer(
                layers,
                "gateway",
                20.0,
                method(deps, c"buildGatewayPrompt", &[text(input, "")?, session])?,
            )?;
        } else if !persisted.get(c"type")?.is_string("aux")? {
            let dispatch = method(deps, c"buildDispatchContextPrompt", &[session])?;
            if dispatch.truthy()? {
                layer(layers, "dispatch-context", 20.0, dispatch)?;
            }
        }
        let stopped = if function(deps.get(c"takeBackgroundStopNote")?)? {
            method(deps, c"takeBackgroundStopNote", &[session])?
        } else {
            text(input, "")?
        };
        if stopped.truthy()? {
            layer(layers, "background-stopped", 25.0, stopped)?;
        }
        let pending = method(deps, c"pendingNotesFor", &[session])?;
        let pending = method(
            pending,
            c"slice",
            &[
                input.from_value(&V::Number(0.0))?,
                input.from_value(&V::Number(10.0))?,
            ],
        )?;
        if pending.get(c"length")?.truthy()? {
            let mut block = JsString::from_rust_str(policy::NOTES_PREFIX);
            pending.for_each(|note| {
                block.push_str("- From \"");
                block.push(&note.get(c"fromLabel")?.coerce_string()?);
                block.push_str("\": ");
                block.push(&note.get(c"body")?.coerce_string()?);
                block.push_str("\n");
                Ok(())
            })?;
            block.push_str(policy::NOTES_SUFFIX);
            layer(
                layers,
                "cross-agent-notes",
                30.0,
                input.from_value(&V::String(policy::clip_notes(block)))?,
            )?;
            let date = input.global()?.get(c"Date")?;
            let now = method(date, c"now", &[])?;
            pending.for_each(|note| {
                note.assign(c"delivered", input.from_value(&V::Bool(true))?)?;
                note.assign(c"deliveredAt", now)
            })?;
            method(deps, c"saveNotes", &[])?;
            let append = deps.get(c"appendEvent")?;
            let directory = persisted.get(c"dirId")?;
            let message = concat(
                input,
                &[pending.get(c"length")?, text(input, " 条留言已送达")?],
            )?;
            append.call(
                deps,
                &[directory, text(input, "note_delivered")?, message, session],
            )?;
            let broadcast = deps.get(c"workspaceBroadcast")?;
            let directory = persisted.get(c"dirId")?;
            let count = method(deps, c"pendingNotesFor", &[session])?.get(c"length")?;
            broadcast.call(
                deps,
                &[
                    directory,
                    object(
                        input,
                        &[
                            (c"type", text(input, "note_pending")?),
                            (c"sessionId", session),
                            (c"count", count),
                        ],
                    )?,
                ],
            )?;
            let broadcast = deps.get(c"chatBroadcast")?;
            let map = pending.get(c"map")?;
            let callback = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
                "deliveredNote",
                |ctx| {
                    let note = L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?);
                    Ok(object(
                        note,
                        &[
                            (c"from", note.get(c"fromLabel")?),
                            (c"body", note.get(c"body")?),
                        ],
                    )?
                    .raw())
                },
            )?;
            let notes = map.call(pending, &[L::new(&env, callback.into_unknown(&env)?)])?;
            broadcast.call(
                deps,
                &[
                    session,
                    object(
                        input,
                        &[
                            (c"type", text(input, "system")?),
                            (c"subtype", text(input, "agent_notes")?),
                            (c"notes", notes),
                        ],
                    )?,
                ],
            )?;
        }
        if voice.truthy()?
            && !persisted.get(c"type")?.is_string("aux")?
            && !persisted.get(c"type")?.is_string("gateway")?
        {
            layer(layers, "voice-input", 35.0, voice_prompt(voice, user_text)?)?;
        }
    }
    let normal_turn = !bare.truthy()? && !persisted.get(c"type")?.is_string("aux")?;
    let cli = persisted.get(c"cli")?;
    let workflow = (cli.nullish()? || cli.is_string("claude")? || cli.is_string("claude-exp")?)
        && (persisted.get(c"claudeWorkflow")?.is_true()?
            || persisted.get(c"effort")?.is_string("ultracode")?)
        && !persisted.get(c"type")?.is_string("aux")?;
    let mut suffix = JsString::from_rust_str(
        if normal_turn && persisted.get(c"preferSubtasks")?.is_true()? {
            policy::SUBTASK_HINT
        } else {
            ""
        },
    );
    if !bare.truthy()?
        && !persisted.get(c"type")?.is_string("aux")?
        && (lang.is_string("zh")? || lang.is_string("en")?)
    {
        suffix.push_str(if lang.is_string("en")? {
            policy::ENGLISH_SUFFIX
        } else {
            policy::CHINESE_SUFFIX
        });
    }
    let layers = sort(&env, layers)?;
    let history = object(
        input,
        &[
            (c"isFirstTurn", first),
            (
                c"cliSessionId",
                or(persisted.get(c"cliSessionId")?, || {
                    input.from_value(&V::Null)
                })?,
            ),
        ],
    )?;
    let raw_model = if !persisted.get(c"model")?.nullish()? {
        persisted.get(c"model")?
    } else {
        input.from_value(&V::Null)?
    };
    let raw_effort = if !persisted.get(c"effort")?.nullish()? {
        persisted.get(c"effort")?
    } else {
        input.from_value(&V::Null)?
    };
    let raw_agent = if !persisted.get(c"agent")?.nullish()? {
        persisted.get(c"agent")?
    } else {
        input.from_value(&V::Null)?
    };
    let spawn = object(
        input,
        &[
            (c"mode", mode),
            (c"rawModel", raw_model),
            (c"rawEffort", raw_effort),
            (c"rawAgent", raw_agent),
            (c"maxTurns", input.from_value(&V::Number(0.0))?),
            (c"ultracode", input.from_value(&V::Bool(workflow))?),
            (c"disallowedTools", disallowed),
            (c"providerModel", provider_model),
            (c"providerModels", provider_models),
            (c"skipDefaultModel", skip_default),
        ],
    )?;
    let envelope = object(
        input,
        &[
            (c"imgHint", image),
            (c"subagentHint", subagent),
            (c"rolePrompt", role),
            (c"systemPrompt", system),
            (c"contextLayers", layers),
            (c"userText", user_text),
            (c"suffix", input.from_value(&V::String(suffix))?),
            (c"historyHandle", history),
            (c"spawnOpts", spawn),
        ],
    )?;
    validate(envelope, L::new(&env, environment), L::new(&env, console))?;
    Ok(envelope.raw())
}

/// Addition after a string LHS uses the default primitive hint, unlike template
/// interpolation (string hint). Keep custom valueOf and Date/Symbol behaviour.
pub(crate) fn default_primitive(value: L<'_>) -> Result<L<'_>> {
    if !matches!(
        value.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ) || value.nullish()?
    {
        return Ok(value);
    }
    let exotic = value.get_key(value.global()?.get(c"Symbol")?.get(c"toPrimitive")?)?;
    if !exotic.nullish()? {
        let result = exotic.call(value, &[text(value, "default")?])?;
        if !matches!(
            result.kind()?,
            sys::ValueType::napi_object | sys::ValueType::napi_function
        ) || result.nullish()?
        {
            return Ok(result);
        }
        return Err(value.type_error("Cannot convert object to primitive value"));
    }
    for key in [c"valueOf", c"toString"] {
        let method = value.get(key)?;
        if function(method)? {
            let result = method.call(value, &[])?;
            if !matches!(
                result.kind()?,
                sys::ValueType::napi_object | sys::ValueType::napi_function
            ) || result.nullish()?
            {
                return Ok(result);
            }
        }
    }
    Err(value.type_error("Cannot convert object to primitive value"))
}

#[napi]
pub fn message_render_prompt(env: Env, envelope: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(render_prompt(&env, L::new(&env, envelope))?.raw())
}

pub(crate) fn render_prompt<'a>(env: &'a Env, envelope: L<'a>) -> Result<L<'a>> {
    let layers = array(envelope)?;
    let mut index = 0;
    envelope.get(c"contextLayers")?.for_each(|item| {
        layers.set_element(index, item)?;
        index += 1;
        Ok(())
    })?;
    let layers = sort(env, layers)?;
    let map = layers.get(c"map")?;
    let callback = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "promptLayerText",
        |ctx| {
            Ok(L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
                .get(c"text")?
                .raw())
        },
    )?;
    let texts = map.call(layers, &[L::new(env, callback.into_unknown(env)?)])?;
    let joined = method(texts, c"join", &[text(envelope, "")?])?;
    let mut rendered = joined.coerce_string()?;
    rendered.push(&default_primitive(envelope.get(c"userText")?)?.coerce_string()?);
    rendered.push(&default_primitive(envelope.get(c"suffix")?)?.coerce_string()?);
    envelope.from_value(&V::String(rendered))
}
