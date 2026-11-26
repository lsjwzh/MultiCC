//! Public session DTOs over borrowed V8 values. Rust owns the projection and
//! safety traversal; the host retains coercion, arrays, Dates and provider DTOs.
use crate::{host_methods::method, js_iteration::read, js_live::invoke, route_response::*};
use multicc_core::{js::JsString, session_admin::redact_session_text};
use napi_derive::napi;
use std::ffi::CStr;

#[napi]
pub fn session_dto_redact_text(env: Env, text: Unknown<'_>) -> Result<sys::napi_value> {
    let value = L::new(&env, text);
    let text = value
        .string()?
        .ok_or_else(|| value.type_error("expected session text"))?;
    Ok(value
        .from_value(&V::String(redact_session_text(&text)))?
        .raw())
}
fn default_object(v: L<'_>) -> Result<L<'_>> {
    if v.undefined()? {
        fields(v, &[])
    } else {
        Ok(v)
    }
}
fn empty(v: L<'_>) -> Result<bool> {
    Ok(v.nullish()? || v.equals(text(v, "")?)?)
}
fn object(v: L<'_>) -> Result<bool> {
    Ok(v.truthy()? && v.kind()? == sys::ValueType::napi_object)
}
fn nullable<'a>(v: L<'a>, max: L<'a>) -> Result<L<'a>> {
    if empty(v)? {
        return null(v);
    }
    call(string(v)?, c"slice", &[num(v, 0.0)?, max])
}
fn bounded(v: L<'_>, max: f64) -> Result<L<'_>> {
    nullable(v, num(v, max)?)
}
fn timestamp(v: L<'_>) -> Result<L<'_>> {
    if empty(v)? {
        return null(v);
    }
    let ctor = v.global()?.get(c"Date")?;
    let date = if v.instance_of(ctor)? {
        v
    } else {
        ctor.construct(&[v])?
    };
    if call(
        v.global()?.get(c"Number")?,
        c"isFinite",
        &[call(date, c"getTime", &[])?],
    )?
    .truthy()?
    {
        call(date, c"toISOString", &[])
    } else {
        null(v)
    }
}
fn sanitize<'a>(v: L<'a>, max: L<'a>) -> Result<L<'a>> {
    if empty(v)? {
        return null(v);
    }
    let value = string(v)?.coerce_string()?;
    call(
        v.from_value(&V::String(redact_session_text(&value)))?,
        c"slice",
        &[num(v, 0.0)?, max],
    )
}
fn count<'a>(v: L<'a>, min: f64, default: f64, floor: bool) -> Result<L<'a>> {
    let number = v.global()?.get(c"Number")?.call_plain(&[v])?;
    let number = fallback(number, V::Number(default))?;
    let math = v.global()?.get(c"Math")?;
    let number = if floor {
        call(math, c"floor", &[number])?
    } else {
        number
    };
    call(math, c"max", &[num(v, min)?, number])
}
fn has(state: L<'_>, key: &CStr, v: L<'_>) -> Result<bool> {
    call(state.get(key)?, c"has", &[v])?.truthy()
}
fn selected<'a>(
    state: L<'a>,
    set: &CStr,
    source: L<'a>,
    key: &CStr,
    default: &str,
) -> Result<L<'a>> {
    let table = state.get(set)?;
    let has = read(table, c"has")?;
    if has.call(table, &[read(source, key)?])?.truthy()? {
        read(source, key)
    } else {
        text(state, default)
    }
}
fn subagent(v: L<'_>) -> Result<L<'_>> {
    if !object(v)? {
        return null(v);
    }
    let provider = bounded(read(v, c"providerId")?, 160.0)?;
    let model = bounded(read(v, c"model")?, 160.0)?;
    if !provider.truthy()? || !model.truthy()? {
        return null(v);
    }
    let out = fields(
        v,
        &[
            ("providerId", provider),
            ("model", model),
            (
                "effectiveModel",
                bounded(read(v, c"effectiveModel")?, 160.0)?,
            ),
        ],
    )?;
    if read(v, c"inherited")?.equals(flag(v, true)?)? {
        out.assign(c"inherited", flag(v, true)?)?;
    }
    Ok(out)
}
fn merge_state(v: L<'_>) -> Result<L<'_>> {
    if !object(v)? {
        return null(v);
    }
    fields(
        v,
        &[
            ("ahead", count(read(v, c"ahead")?, 0.0, 0.0, false)?),
            ("behind", count(read(v, c"behind")?, 0.0, 0.0, false)?),
            ("dirty", flag(v, read(v, c"dirty")?.truthy()?)?),
            ("mergeReady", flag(v, read(v, c"mergeReady")?.truthy()?)?),
            (
                "rebaseInProgress",
                flag(v, read(v, c"rebaseInProgress")?.truthy()?)?,
            ),
        ],
    )
}
fn and_read<'a>(v: L<'a>, key: &CStr) -> Result<L<'a>> {
    if v.truthy()? {
        read(v, key)
    } else {
        Ok(v)
    }
}
fn last_read<'a>(v: L<'a>, key: &CStr) -> Result<L<'a>> {
    read(read(v, c"lastVerdict")?, key)
}
fn history<'a>(state: L<'a>, row: L<'a>) -> Result<L<'a>> {
    let at = count(and_read(row, c"at")?, 0.0, 0.0, false)?;
    let verdict = if has(state, c"verdicts", and_read(row, c"verdict")?)? {
        read(row, c"verdict")?
    } else {
        text(state, "continue")?
    };
    let reason = fallback(bounded(and_read(row, c"reason")?, 1000.0)?, "".into())?;
    fields(
        state,
        &[("at", at), ("verdict", verdict), ("reason", reason)],
    )
}
fn enum_field<'a>(v: L<'a>, key: &CStr, choices: &[&str]) -> Result<L<'a>> {
    for item in choices {
        if read(v, key)?.equals(text(v, item)?)? {
            return read(v, key);
        }
    }
    null(v)
}
fn unattended<'a>(state: L<'a>, v: L<'a>) -> Result<L<'a>> {
    if !object(v)? {
        return null(v);
    }
    let status = selected(state, c"statuses", v, c"status", "stopped")?;
    let criteria = if read(v, c"criteria")?.is_array()? {
        let values = call(
            read(v, c"criteria")?,
            c"slice",
            &[num(v, 0.0)?, num(v, 12.0)?],
        )?;
        let values = call(values, c"map", &[state.get(c"criterion")?])?;
        call(values, c"filter", &[v.global()?.get(c"Boolean")?])?
    } else {
        v.from_value(&V::Array(vec![]))?
    };
    let history = if read(v, c"history")?.is_array()? {
        let values = call(read(v, c"history")?, c"slice", &[num(v, -10.0)?])?;
        call(values, c"map", &[state.get(c"historyRow")?])?
    } else {
        v.from_value(&V::Array(vec![]))?
    };
    let last = if read(v, c"lastVerdict")?.truthy()?
        && matches!(
            read(v, c"lastVerdict")?.kind()?,
            sys::ValueType::napi_object | sys::ValueType::napi_null
        ) {
        let verdict = if has(state, c"verdicts", last_read(v, c"verdict")?)? {
            last_read(v, c"verdict")?
        } else {
            text(v, "continue")?
        };
        fields(
            v,
            &[
                ("verdict", verdict),
                (
                    "reason",
                    fallback(bounded(last_read(v, c"reason")?, 1000.0)?, "".into())?,
                ),
                (
                    "nextInstruction",
                    fallback(
                        bounded(last_read(v, c"nextInstruction")?, 4000.0)?,
                        "".into(),
                    )?,
                ),
                (
                    "humanReason",
                    fallback(bounded(last_read(v, c"humanReason")?, 1000.0)?, "".into())?,
                ),
                ("at", count(last_read(v, c"at")?, 0.0, 0.0, false)?),
            ],
        )?
    } else {
        null(v)?
    };
    let stall = fields(v, &[])?;
    let has_stall = read(v, c"stall")?.truthy()?
        && matches!(
            read(v, c"stall")?.kind()?,
            sys::ValueType::napi_object | sys::ValueType::napi_null
        );
    for (key, name) in [
        (c"sameInstruction", "sameInstruction"),
        (c"auxFailures", "auxFailures"),
        (c"consecutiveFaults", "consecutiveFaults"),
    ] {
        let value = if has_stall {
            count(read(read(v, c"stall")?, key)?, 0.0, 0.0, true)?
        } else {
            num(v, 0.0)?
        };
        stall.define_key(text(v, name)?, value)?;
    }
    let paused = enum_field(v, c"pausedBy", &["user", "input", "cancel"])?;
    let retry = count(read(v, c"retryAt")?, 0.0, 0.0, false)?;
    let retry = if retry.truthy()? { retry } else { null(v)? };
    let category = enum_field(v, c"retryCategory", &["capacity", "fault"])?;
    let out = fields(
        v,
        &[
            ("status", status),
            (
                "goal",
                fallback(bounded(read(v, c"goal")?, 2000.0)?, "".into())?,
            ),
            ("criteria", criteria),
        ],
    )?;
    out.assign(
        c"maxDurationMinutes",
        call(
            v.global()?.get(c"Math")?,
            c"min",
            &[
                num(v, 1440.0)?,
                count(read(v, c"maxDurationMinutes")?, 5.0, 120.0, true)?,
            ],
        )?,
    )?;
    for (key, floor) in [
        (c"rounds", true),
        (c"startedAt", false),
        (c"deadlineAt", false),
        (c"updatedAt", false),
    ] {
        out.assign(key, count(read(v, key)?, 0.0, 0.0, floor)?)?;
    }
    for (key, value) in [
        (c"lastVerdict", last),
        (c"history", history),
        (c"stall", stall),
        (c"retryAt", retry),
        (c"retryCategory", category),
        (
            c"evaluating",
            flag(v, read(v, c"evaluating")?.equals(flag(v, true)?)?)?,
        ),
        (c"pausedBy", paused),
    ] {
        out.assign(key, value)?;
    }
    Ok(out)
}
fn joined<'a>(anchor: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut units = vec![];
    for part in parts {
        units.extend_from_slice(part.coerce_string()?.as_units());
    }
    anchor.from_value(&V::String(JsString::from_units(units)))
}
fn assert_safe<'a>(state: L<'a>, value: L<'a>, location: L<'a>) -> Result<L<'a>> {
    if value.is_array()? {
        // Bind only the location. The host's actual forEach still controls
        // sparse arrays, mutations, injected indexes and callback invocation.
        let visit = state.get(c"arrayVisit")?;
        let callback = call(
            visit,
            c"bind",
            &[state.from_value(&V::Undefined)?, location],
        )?;
        call(
            state.global()?.get(c"Object")?,
            c"defineProperty",
            &[
                callback,
                text(state, "name")?,
                fields(state, &[("value", text(state, "")?)])?,
            ],
        )?;
        invoke(
            value,
            read(value, c"forEach")?,
            &[callback],
            "value.forEach",
        )?;
        return Ok(value);
    }
    if !object(value)? {
        return Ok(value);
    }
    let entries = call(value.global()?.get(c"Object")?, c"entries", &[value])?;
    entries.for_each(|entry| {
        let key = entry.element(0)?;
        let child = entry.element(1)?;
        let sensitive = call(state.get(c"sensitive")?, c"test", &[key])?.truthy()?;
        let path = joined(state, &[location, text(state, ".")?, key])?;
        if sensitive {
            let message = joined(state, &[text(state, "sensitive DTO key at ")?, path])?;
            return Err(state
                .global()?
                .get(c"Error")?
                .construct(&[message])?
                .throw_error());
        }
        state.get(c"assertDtoSafe")?.call_plain(&[child, path])?;
        Ok(())
    })?;
    Ok(value)
}
fn project<'a>(state: L<'a>, source: L<'a>) -> Result<L<'a>> {
    let cli = selected(state, c"SUPPORTED_CLIS", source, c"cli", "claude")?;
    let kind = selected(state, c"SUPPORTED_KINDS", source, c"kind", "terminal")?;
    let out = fields(
        state,
        &[
            ("id", string(fallback(read(source, c"id")?, "".into())?)?),
            ("dirId", bounded(read(source, c"dirId")?, 160.0)?),
            ("type", text(state, "session")?),
            ("cli", cli),
            ("kind", kind),
        ],
    )?;
    for key in [c"label", c"model", c"effectiveModel", c"effort"] {
        out.assign(
            key,
            bounded(
                read(source, key)?,
                if key == c"effort" { 80.0 } else { 160.0 },
            )?,
        )?;
    }
    for key in [c"claudeWorkflow", c"preferSubtasks"] {
        if read(source, key)?.kind()? == sys::ValueType::napi_boolean {
            out.assign(key, read(source, key)?)?;
        }
    }
    for (key, limit) in [
        (c"effectiveEffort", 80.0),
        (c"agent", 160.0),
        (c"provider", 160.0),
    ] {
        out.assign(key, bounded(read(source, key)?, limit)?)?;
    }
    out.assign(
        c"providerSelection",
        state
            .get(c"providerSelectionDto")?
            .call_plain(&[read(source, c"providerSelection")?])?,
    )?;
    out.assign(
        c"experimentalMode",
        bounded(read(source, c"experimentalMode")?, 80.0)?,
    )?;
    out.assign(c"subagent", subagent(read(source, c"subagent")?)?)?;
    out.assign(
        c"autoCommit",
        flag(
            state,
            !read(source, c"autoCommit")?.equals(flag(state, false)?)?,
        )?,
    )?;
    out.assign(c"createdAt", timestamp(read(source, c"createdAt")?)?)?;
    out.assign(c"lastActivity", timestamp(read(source, c"lastActivity")?)?)?;
    out.assign(
        c"clients",
        count(read(source, c"clients")?, 0.0, 0.0, true)?,
    )?;
    out.assign(c"active", flag(state, read(source, c"active")?.truthy()?)?)?;
    let workspace = read(source, c"workspaceState")?;
    let hidden = workspace.string()?.is_some_and(|v| {
        ["planned", "hibernated", "hibernating", "thawing"]
            .iter()
            .any(|item| v == *item)
    });
    out.assign(
        c"workspaceState",
        text(state, if hidden { "hibernated" } else { "awake" })?,
    )?;
    let work = read(source, c"lastWorkAt")?;
    out.assign(
        c"lastWorkAt",
        timestamp(if work.truthy()? {
            work
        } else {
            read(source, c"createdAt")?
        })?,
    )?;
    out.assign(c"hibernatedAt", timestamp(read(source, c"hibernatedAt")?)?)?;
    out.assign(c"mergeState", merge_state(read(source, c"mergeState")?)?)?;
    out.assign(
        c"unattended",
        unattended(state, read(source, c"unattended")?)?,
    )?;
    if !out.get(c"id")?.truthy()? {
        return Err(state.type_error("session DTO requires id"));
    }
    state.get(c"assertDtoSafe")?.call_plain(&[out])
}

#[napi]
pub fn session_dto_api(
    env: Env,
    anchor: Unknown<'_>,
    provider_selection: Unknown<'_>,
) -> Result<sys::napi_value> {
    let anchor = L::new(&env, anchor);
    let state = fields(
        anchor,
        &[("providerSelectionDto", L::new(&env, provider_selection))],
    )?;
    for (key, items) in [
        (
            c"SUPPORTED_CLIS",
            &[
                "claude",
                "claude-exp",
                "codex",
                "codex-exp",
                "opencode",
                "zcode",
                "qoder",
                "kimi",
                "codebuddy",
                "dsh",
                "gemini",
                "grok",
                "agy",
                "commandcode",
                "pi",
            ][..],
        ),
        (c"SUPPORTED_KINDS", &["chat", "terminal"][..]),
        (
            c"statuses",
            &[
                "active",
                "achieved",
                "needs_human",
                "exhausted",
                "stopped",
                "error",
            ][..],
        ),
        (c"verdicts", &["achieved", "continue", "needs_human"][..]),
    ] {
        let array = anchor.from_value(&V::Array(items.iter().map(|s| V::from(*s)).collect()))?;
        state.set(key, anchor.global()?.get(c"Set")?.construct(&[array])?)?;
    }
    state.set(
        c"sensitive",
        anchor.global()?.get(c"RegExp")?.construct(&[
            text(
                anchor,
                "(?:token|secret|password|stack|(?:^|_)path|cwd|cliSessionId|worktree)",
            )?,
            text(anchor, "i")?,
        ])?,
    )?;
    state.set(
        c"criterion",
        method(&env, state, "", 1, 1, |_, a| bounded(a[0], 300.0))?,
    )?;
    state.set(
        c"historyRow",
        method(&env, state, "", 1, 1, |s, a| history(s, a[0]))?,
    )?;
    state.set(
        c"arrayVisit",
        method(&env, state, "", 3, 3, |s, a| {
            let path = joined(s, &[a[0], text(s, "[")?, a[2], text(s, "]")?])?;
            s.get(c"assertDtoSafe")?.call_plain(&[a[1], path])
        })?,
    )?;
    let assert = method(&env, state, "assertDtoSafe", 1, 2, |s, a| {
        let location = if a[1].undefined()? {
            text(s, "$")?
        } else {
            a[1]
        };
        assert_safe(s, a[0], location)
    })?;
    state.set(c"assertDtoSafe", assert)?;
    Ok(fields(
        state,
        &[
            ("SUPPORTED_CLIS", state.get(c"SUPPORTED_CLIS")?),
            ("SUPPORTED_KINDS", state.get(c"SUPPORTED_KINDS")?),
            ("assertDtoSafe", assert),
            (
                "sanitizePublicText",
                method(&env, state, "sanitizePublicText", 1, 2, |s, a| {
                    sanitize(
                        a[0],
                        if a[1].undefined()? {
                            num(s, 1000.0)?
                        } else {
                            a[1]
                        },
                    )
                })?,
            ),
            (
                "toSessionDto",
                method(&env, state, "toSessionDto", 0, 1, |s, a| {
                    project(s, default_object(a[0])?)
                })?,
            ),
            (
                "unattendedDto",
                method(&env, state, "unattendedDto", 1, 1, |s, a| {
                    unattended(s, a[0])
                })?,
            ),
        ],
    )?
    .raw())
}
