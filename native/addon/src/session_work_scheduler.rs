//! Scheduler policy and its asynchronous transaction boundary. Per-call frames
//! retain host values until the store settles. The store owns all durable state.
mod events;
pub(crate) use events::publish_withdrawals;
mod operations;
mod projection;
pub(crate) fn project_queue<'a>(draft: L<'a>, session: L<'a>) -> Result<L<'a>> {
    let schedule = draft.get(c"sessionSchedules")?.get_key(session)?;
    projection::project(draft, schedule, projection::queue(draft, session)?)
}
mod queue_text;
mod recovery;
use crate::host_methods::{arg, async_result, default_object, env, function, raw};
use crate::route_response::*;
use crate::session_work_selection::{classify_fallback, control, has, kind};
use multicc_core::classify_vocab;
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;
use operations::Op;
use std::ffi::CStr;

const ACTIVE: &[&str] = &["starting", "running", "assessing", "frozen"];
const CONTROL: &[&str] = &[
    "answer",
    "approval",
    "callback",
    "continuation",
    "retry",
    "resume",
];
const FREEZES: &[(&str, &str)] = &[
    ("awaiting_user_input", "W"),
    ("waiting", "W"),
    ("classify_waiting", "W"),
    ("awaiting_callback", "B"),
    ("classify_background", "B"),
    ("error", "E"),
    ("classification_error", "E"),
    ("unknown_interruption", "E"),
    ("classify_error", "E"),
    ("incomplete_requires_resume", "P"),
    ("classify_running", "P"),
];
const EXTRA: &[(&str, &str)] = &[
    ("legacy_unresolved", "error"),
    ("delivery_recovery", "running"),
    ("continuation_ready", "running"),
    ("prelaunch_deferred", "queued"),
    ("configuration_required", "waiting"),
];

fn display(letter: &str) -> &'static str {
    match letter {
        "W" => "waiting",
        "B" => "background",
        "P" => "running",
        _ => "error",
    }
}
pub(crate) fn freeze_state(reason: L<'_>) -> Result<L<'_>> {
    let key = describe(fallback(reason, V::string(""))?)?;
    let state = FREEZES
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, l)| display(l))
        .or_else(|| EXTRA.iter().find(|(k, _)| *k == key).map(|(_, v)| *v))
        .unwrap_or(if key.contains("error") {
            "error"
        } else {
            "waiting"
        });
    text(reason, state)
}
fn describe(v: L<'_>) -> Result<String> {
    Ok(string(v)?.coerce_string()?.to_string_lossy())
}
fn undef(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
fn empty_array(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Array(Vec::new()))
}
fn array<'a>(s: L<'a>, vals: &[L<'a>]) -> Result<L<'a>> {
    let out = empty_array(s)?;
    for (i, v) in vals.iter().enumerate() {
        out.set_element(i as u32, *v)?;
    }
    Ok(out)
}
fn default<'a>(v: L<'a>, otherwise: L<'a>) -> Result<L<'a>> {
    if v.undefined()? {
        Ok(otherwise)
    } else {
        Ok(v)
    }
}
fn or<'a>(v: L<'a>, otherwise: L<'a>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        Ok(otherwise)
    }
}
fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn then<'a>(
    frame: L<'a>,
    value: L<'a>,
    next: impl for<'b> Fn(L<'b>, L<'b>) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let f = function(frame, "", 1, 1, move |s, a| next(s, a[0]))?;
    let p = call(frame.global()?.get(c"Promise")?, c"resolve", &[value])?;
    call(p, c"then", &[f])
}
fn code<'a>(s: L<'a>, reason: &str) -> Result<L<'a>> {
    fields(s, &[("ok", flag(s, false)?), ("code", text(s, reason)?)])
}
fn json<'a>(v: L<'a>, key: &CStr) -> Result<L<'a>> {
    call(v.global()?.get(c"JSON")?, key, &[v])
}
fn clock(s: L<'_>) -> Result<L<'_>> {
    num(s, s.get(c"now")?.call_plain(&[])?.explicit_number()?)
}
fn optional_read<'a>(s: L<'a>, key: &CStr, id: L<'a>, label: &str) -> Result<L<'a>> {
    match s.get(key)?.call_plain(&[id]) {
        Ok(v) => Ok(v),
        Err(error) => {
            let Some(reason) = s.exception_value()? else {
                return Err(error);
            };
            if reason
                .optional(c"code")?
                .is_string("SESSION_WORK_OWNER_UNAVAILABLE")?
            {
                return Err(reason.throw_error());
            }
            s.get(c"log")?.call_plain(&[text(
                s,
                &format!(
                    "[session-work] {label} read failed for {}: {}",
                    describe(id)?,
                    describe(reason.get(c"message")?)?
                ),
            )?])?;
            null(s)
        }
    }
}
fn classify<'a>(s: L<'a>, id: L<'a>, schedule: L<'a>) -> Result<L<'a>> {
    if !callable(s.get(c"getClassifyState")?)? {
        return classify_fallback(schedule);
    }
    let cls = optional_read(s, c"getClassifyState", id, "classify")?;
    if has(cls, &classify_vocab::CLASSIFY_STATES)? {
        Ok(cls)
    } else {
        null(s)
    }
}
fn pending<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    if !callable(s.get(c"getPendingUserInput")?)? {
        return null(s);
    }
    let p = optional_read(s, c"getPendingUserInput", id, "pending user input")?;
    if !p.truthy()? || p.get(c"resolved")?.is_true()? || !p.get(c"requestId")?.truthy()? {
        return null(s);
    }
    let maybe = |v: L<'a>| if v.truthy()? { string(v) } else { null(s) };
    fields(
        s,
        &[
            ("requestId", string(p.get(c"requestId")?)?),
            ("taskId", maybe(p.get(c"taskId")?)?),
            ("turnId", maybe(p.get(c"turnId")?)?),
            (
                "createdAt",
                fallback(num(s, p.get(c"createdAt")?.explicit_number()?)?, V::Null)?,
            ),
        ],
    )
}
fn select<'a>(s: L<'a>, items: L<'a>, draft: L<'a>, at: L<'a>) -> Result<L<'a>> {
    if !items.get(c"length")?.truthy()? {
        return null(s);
    }
    let id = items.element(0)?.get(c"sessionId")?;
    let schedule = draft.get(c"sessionSchedules")?.get_key(id)?;
    let p = pending(s, id)?;
    let run = s.get(c"getRunActive")?;
    let active = if callable(run)? {
        run.call_plain(&[id])?
    } else {
        undef(s)?
    };
    let frame = fields(s, &[("owner", s), ("schedule", schedule)])?;
    let request = fields(
        s,
        &[
            ("items", items),
            ("schedule", schedule),
            (
                "priority",
                fallback(schedule.optional(c"priorityEntryId")?, V::Null)?,
            ),
            ("pending", p),
            ("now", at),
            (
                "runActive",
                if active.kind()? == sys::ValueType::napi_boolean {
                    active
                } else {
                    undef(s)?
                },
            ),
            (
                "classify",
                function(frame, "", 1, 1, |f, a| {
                    classify(f.get(c"owner")?, a[0], f.get(c"schedule")?)
                })?,
            ),
            ("unattended", s.get(c"getUnattendedState")?),
        ],
    )?;
    Ok(raw(
        s,
        crate::session_work_selection::session_work_select(env(s), arg(request)?)?,
    ))
}
pub(crate) fn create(options: L<'_>) -> Result<L<'_>> {
    let opts = default_object(options)?;
    let s = fields(opts, &[])?;
    let noop = function(s, "", 0, 0, |s, _| undef(s))?;
    let store = opts.get(c"store")?;
    if !store.truthy()? || !callable(store.get(c"mutate")?)? || !callable(store.get(c"read")?)? {
        return Err(s.type_error("[session-scheduler] orchestration store is required"));
    }
    s.set(c"store", store)?;
    s.set(
        c"now",
        default(opts.get(c"now")?, s.global()?.get(c"Date")?.get(c"now")?)?,
    )?;
    for k in [c"onEvent".as_ref(), c"log"] {
        s.set(k, default(opts.get(k)?, noop)?)?;
    }
    for k in [
        c"getClassifyState".as_ref(),
        c"getPendingUserInput",
        c"getUnattendedState",
        c"getRunActive",
        c"onWaitCancelled",
        c"ensureSessionWorkState",
    ] {
        s.set(k, opts.get(k)?)?;
    }
    let api = fields(s, &[])?;
    for &(name, n, len, op) in operations::METHODS {
        api.set_key(
            text(s, name)?,
            function(s, name, len, n, move |s, a| {
                async_result(s, || operations::run(s, op, a))
            })?,
        )?;
    }
    api.set(
        c"selectSessionItem",
        function(s, "selectSessionItem", 3, 3, |s, a| {
            select(s, a[0], a[1], a[2])
        })?,
    )?;
    api.set(
        c"projectItemLineage",
        function(s, "projectItemLineage", 1, 1, |_, a| Ok(a[0]))?,
    )?;
    api.set(
        c"isControlItem",
        function(s, "isControlItem", 1, 1, |s, a| flag(s, control(a[0])?))?,
    )?;
    api.freeze()
}
#[napi]
pub fn session_work_scheduler_api(environment: Env) -> Result<sys::napi_value> {
    let s = L::new(
        &environment,
        environment.get_global()?.into_unknown(&environment)?,
    );
    let set = |values: &[&str]| {
        s.get(c"Set")?
            .construct(&[s.from_value(&V::Array(values.iter().map(|v| V::from(*v)).collect()))?])
    };
    let reasons = fields(s, &[])?;
    let states = fields(s, &[])?;
    for &(key, l) in FREEZES {
        reasons.set_key(text(s, key)?, text(s, l)?)?;
        states.set_key(text(s, key)?, text(s, display(l))?)?;
    }
    for &(key, v) in EXTRA {
        states.set_key(text(s, key)?, text(s, v)?)?;
    }
    Ok(fields(
        s,
        &[
            ("ACTIVE_STATES", set(ACTIVE)?),
            ("CONTROL_KINDS", set(CONTROL)?),
            ("FREEZE_REASON_CLASSIFY", reasons.freeze()?),
            ("FREEZE_REASON_RUN_STATE", states.freeze()?),
            (
                "createSessionWorkScheduler",
                function(s, "createSessionWorkScheduler", 0, 1, |_, a| create(a[0]))?,
            ),
            (
                "isControlItem",
                function(s, "isControlItem", 1, 1, |s, a| flag(s, control(a[0])?))?,
            ),
            (
                "runStateForFreezeReason",
                function(s, "runStateForFreezeReason", 1, 1, |_, a| {
                    freeze_state(a[0])
                })?,
            ),
            (
                "workKind",
                function(s, "workKind", 1, 1, |_, a| kind(a[0]))?,
            ),
        ],
    )?
    .raw())
}
