//! Live JavaScript bindings for staged session configuration.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, session_pending_configuration as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::ffi::{CStr, CString};

fn obj(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Object(vec![]))
}
fn null(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Null)
}
fn undefined(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Undefined)
}
fn call<'a>(o: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    o.get(key)?.call(o, args)
}
fn prop<'a>(o: L<'a>, key: &CStr) -> Result<L<'a>> {
    if o.nullish()? {
        let name = if o.undefined()? { "undefined" } else { "null" };
        return Err(o.type_error(&format!(
            "Cannot read properties of {name} (reading '{}')",
            key.to_string_lossy()
        )));
    }
    o.get(key)
}
fn clone_json<'a>(a: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let parse_receiver = a.global()?.get(c"JSON")?;
    let parse = parse_receiver.get(c"parse")?;
    let stringify_receiver = a.global()?.get(c"JSON")?;
    let stringify = stringify_receiver.get(c"stringify")?;
    let encoded = stringify.call(stringify_receiver, &[value])?;
    parse.call(parse_receiver, &[encoded])
}
fn read<'a>(session: L<'a>) -> Result<L<'a>> {
    let out = obj(session)?;
    for field in core::CONFIG_FIELDS {
        let key = CString::new(field).expect("static field");
        let value = prop(session, &key)?;
        if matches!(field, "claudeWorkflow" | "preferSubtasks") && value.nullish()? {
            continue;
        }
        let value = if value.nullish()? {
            null(session)?
        } else {
            value
        };
        out.set(&key, clone_json(session, value)?)?;
    }
    Ok(out)
}
// JS strict assignment is a host primitive: use the injected generic setter
// so V8 preserves Proxy traps, setter identity and engine exception text.
fn set_strict<'a>(target: L<'a>, key: &CStr, value: L<'a>, setter: L<'a>) -> Result<()> {
    let key = target.from_value(&J::string(key.to_string_lossy().as_ref()))?;
    setter.call_plain(&[target, key, value])?;
    Ok(())
}
fn desired<'a>(session: L<'a>, setter: L<'a>) -> Result<L<'a>> {
    let draft = clone_json(session, session)?;
    if prop(session, c"pendingConfiguration")?.truthy()? {
        let pending = prop(session, c"pendingConfiguration")?;
        set_strict(draft, c"cli", prop(pending, c"cli")?, setter)?;
        let object = session.global()?.get(c"Object")?;
        let assign = object.get(c"assign")?;
        let pending = prop(session, c"pendingConfiguration")?;
        assign.call(object, &[draft, prop(pending, c"profile")?])?;
    }
    Ok(draft)
}
fn destructure<'a>(deps: L<'a>, first: &str) -> Result<()> {
    if deps.nullish()? {
        let (value, tail) = if deps.undefined()? {
            ("undefined", "undefined")
        } else {
            ("object null", "null")
        };
        return Err(deps.type_error(&format!(
            "Cannot destructure property '{first}' of '{value}' as it is {tail}."
        )));
    }
    Ok(())
}
fn busy<'a>(env: &'a Env, id: L<'a>, deps: L<'a>) -> Result<bool> {
    destructure(deps, "getChatState")?;
    let get_chat = deps.get(c"getChatState")?;
    let get_stream = deps.get(c"getChatStream")?;
    let has_background = deps.get(c"hasLiveBackgroundTasks")?;
    let get_preparation = deps.get(c"getPreparation")?;
    let result = deps.catch(|| -> Result<bool> {
        let chat = get_chat.call_plain(&[id])?;
        let stream_owner = get_stream.call_plain(&[])?;
        let status = stream_owner.optional(c"status")?;
        let stream = if status.nullish()? {
            undefined(deps)?
        } else {
            status.call(stream_owner, &[id])?
        };
        let preparation = if get_preparation.nullish()? {
            undefined(deps)?
        } else {
            get_preparation.call_plain(&[id])?
        };
        let phase = preparation.optional(c"phase")?;
        let phase_text = phase.string()?.map(|value| value.to_string_lossy());
        if core::preparation_busy(phase_text.as_deref()) {
            return Ok(true);
        }
        let chat_unknown = unsafe { Unknown::from_raw_unchecked(env.raw(), chat.raw()) };
        if crate::session_records::session_runtime_is_chat_state_busy(*env, Some(chat_unknown))? {
            return Ok(true);
        }
        if stream.optional(c"busy")?.truthy()? {
            return Ok(true);
        }
        if stream.optional(c"queued")?.positive()? {
            return Ok(true);
        }
        has_background.call_plain(&[id])?.truthy()
    })?;
    Ok(result.unwrap_or(true))
}

#[napi]
pub fn session_pending_configuration_fields(env: Env) -> Result<sys::napi_value> {
    let a = L::new(&env, ().into_unknown(&env)?);
    let values = core::CONFIG_FIELDS.iter().map(|f| J::string(f)).collect();
    Ok(a.from_value(&J::Array(values))?.freeze()?.raw())
}
#[napi]
pub fn session_pending_read_configuration(
    env: Env,
    session: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(read(L::new(&env, session))?.raw())
}
#[napi]
pub fn session_pending_desired_session(
    env: Env,
    session: Unknown<'_>,
    setter: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(desired(L::new(&env, session), L::new(&env, setter))?.raw())
}
#[napi]
pub fn session_pending_configuration_busy(
    env: Env,
    id: Unknown<'_>,
    deps: Unknown<'_>,
) -> Result<bool> {
    busy(&env, L::new(&env, id), L::new(&env, deps))
}
#[napi]
pub fn session_pending_stage_configuration(
    env: Env,
    session: Unknown<'_>,
    draft: Unknown<'_>,
    options: Unknown<'_>,
    setter: Unknown<'_>,
) -> Result<sys::napi_value> {
    let session = L::new(&env, session);
    let draft = L::new(&env, draft);
    let options = L::new(&env, options);
    let setter = L::new(&env, setter);
    let fresh = if options.undefined()? {
        session.from_value(&J::Bool(false))?
    } else {
        let value = prop(options, c"fresh")?;
        if value.undefined()? {
            session.from_value(&J::Bool(false))?
        } else {
            value
        }
    };
    let stage = obj(session)?;
    let cli = prop(draft, c"cli")?;
    stage.set(
        c"cli",
        if cli.truthy()? {
            cli
        } else {
            session.from_value(&J::string("claude"))?
        },
    )?;
    stage.set(c"fresh", fresh)?;
    stage.set(c"profile", read(draft)?)?;
    let now = session.global()?.get(c"Date")?.construct(&[])?;
    stage.set(c"updatedAt", call(now, c"toISOString", &[])?)?;
    set_strict(session, c"pendingConfiguration", stage, setter)?;
    prop(session, c"pendingConfiguration").map(|value| value.raw())
}
